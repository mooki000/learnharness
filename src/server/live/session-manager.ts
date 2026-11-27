import { randomUUID } from "node:crypto";
import {
	DEFAULT_LIVE_VOICE,
	LIVE_VOICES,
	isLiveVoice,
	upsertLiveTranscript,
	type LiveAvailability,
	type LiveClientEvent,
	type LivePhase,
	type LiveTranscriptEntry,
	type LiveVoiceId,
} from "../../core/contracts/live.ts";
import type { PlanTree } from "../../core/contracts/plan.ts";
import {
	pendingPluginQuestionOf,
	type LhMessage,
} from "../../core/native-messages.ts";
import { sideSegmentId } from "../../core/side-chat.ts";
import type { ChatInput } from "../../core/input-events.ts";
import {
	nativeSubscriptionConnected,
	nativeSubscriptionModels,
	refreshSubscriptionModels,
	subscriptionAbortController,
	subscriptionLease,
	subscriptionScope,
} from "../../agent/subscription-bridge.ts";
import { handleChatInput } from "../chat-handler.ts";
import { prepareAndSteerChat } from "../jobs.ts";
import { sideChats } from "../side-chat.ts";
import { effectiveSettings, stores } from "../stores.ts";
import { isTurnRunning } from "../turn-liveness.ts";
import { runningTurn } from "../turn-runs.ts";
import {
	buildDelegationContextAppend,
	buildSessionContextAppend,
	buildTutorLiveInstructions,
	buildTutorLiveSessionSeed,
	chunkUtf8,
	estimateLiveContextTokens,
	extractAccountIdFromJwt,
	formatAgentFinalMessage,
	type LiveWireEvent,
} from "./protocol.ts";
import {
	buildCompactLiveMemorySummary,
	extractAssistantCommentary,
	extractLiveSessionContext,
	extractTurnSpokenSummary,
	resolveSpokenInput,
} from "./speech-extract.ts";
import {
	LiveSignalingError,
	LiveTransport,
	resolveLiveEndpointConfig,
	type CodexLiveAuth,
	type LiveEndpointConfig,
	type LiveTransportOptions,
} from "./transport.ts";

const DETACH_GRACE_MS = 3_500;
const HEARTBEAT_MS = 15_000;

export class LiveSessionError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "LiveSessionError";
		this.status = status;
		this.code = code;
	}
}

export interface LiveSessionDeps {
	getChat: (chatId: string) => { id: string; title?: string; kind?: string; tree?: PlanTree; messages: LhMessage[] } | null;
	runChatInput: (chatId: string, input: ChatInput) => Promise<Response>;
	askSideQuestion?: (chatId: string, text: string, anchorMessageId: string) => Promise<Response>;
	getLivePrompt?: () => string | undefined;
	steerChat: (chatId: string, text: string) => Promise<"accepted" | "settled" | "stale">;
	isRunning: (chatId: string) => boolean;
	getRunningTurn: (chatId: string) => { subscribe(): ReadableStream<Uint8Array> } | undefined;
	getEndpoint: () => LiveEndpointConfig | undefined;
	refreshCodex: () => Promise<void>;
	isCodexConnected: () => boolean;
	leaseCodexAuth: () => Promise<CodexLiveAuth>;
	watchCodexAbort: () => { controller: AbortController; release: () => void };
	createTransport: (options: LiveTransportOptions) => Pick<LiveTransport, "connect" | "send" | "close" | "sdpAnswer">;
	detachGraceMs?: number;
}

export interface LiveSessionManager {
	availability(): Promise<LiveAvailability>;
	start(params: { chatId: string; sdpOffer: string; voice?: string }): Promise<{ liveId: string; sdpAnswer: string; voice: LiveVoiceId }>;
	subscribe(chatId: string, liveId: string): ReadableStream<Uint8Array> | null;
	stop(chatId: string, liveId?: string): Promise<boolean>;
	activeLiveId(chatId: string): string | undefined;
}

interface ManagedLiveSession {
	liveId: string;
	chatId: string;
	voice: LiveVoiceId;
	phase: LivePhase;
	ended: boolean;
	endError?: string;
	activeDelegationId?: string;
	delegationQueue: Promise<void>;
	userText: string;
	userFinal: boolean;
	userTurn: number;
	assistantText: string;
	assistantFinal: boolean;
	assistantTurn: number;
	turnRoles: Map<string, "user" | "assistant">;
	started: boolean;
	connected: boolean;
	contextSeeded: boolean;
	lastTranscript?: LiveTranscriptEntry;
	transcriptHistory: LiveTranscriptEntry[];
	subscribers: Set<(event: LiveClientEvent) => void>;
	detachTimer?: ReturnType<typeof setTimeout>;
	releaseAbort?: () => void;
	transport?: Pick<LiveTransport, "connect" | "send" | "close" | "sdpAnswer">;
	stop: (error?: string) => Promise<void>;
}

async function consumeTurnSse(
	stream: ReadableStream<Uint8Array>,
	onCommentary: (text: string) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const frame = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				for (const line of frame.split("\n")) {
					if (!line.startsWith("data: ")) continue;
					const payload = line.slice(6).trim();
					if (!payload || payload === "[DONE]") continue;
					try {
						const event = JSON.parse(payload) as { type?: string; message?: LhMessage };
						if (
							event.type === "message_end" &&
							event.message?.role === "assistant" &&
							event.message.stopReason === "toolUse"
						) {
							const commentary = extractAssistantCommentary(event.message);
							if (commentary) onCommentary(commentary);
						}
					} catch { /* ignore malformed SSE line */ }
				}
				idx = buffer.indexOf("\n\n");
			}
		}
	} finally {
		reader.releaseLock();
	}
}

async function consumeSideNdjson(stream: ReadableStream<Uint8Array>): Promise<{ text?: string; error?: string }> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let latestText = "";
	let errorText: string | undefined;
	const handleLine = (rawLine: string) => {
		const trimmed = rawLine.trim();
		if (!trimmed) return;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (typeof parsed !== "object" || parsed === null) return;
			const event = parsed as {
				type?: unknown;
				text?: unknown;
				error?: unknown;
				thread?: { messages?: { role?: unknown; text?: unknown; error?: unknown }[] };
			};
			if (event.type === "text" && typeof event.text === "string") {
				latestText = event.text;
			} else if (event.type === "done" && Array.isArray(event.thread?.messages)) {
				const last = event.thread.messages.at(-1);
				if (last?.role === "assistant") {
					if (typeof last.text === "string" && last.text.trim()) latestText = last.text;
					if (typeof last.error === "string" && last.error.trim()) errorText = last.error;
				}
			} else if (event.type === "error" && typeof event.error === "string") {
				errorText = event.error;
			}
		} catch { /* ignore malformed NDJSON frame */ }
	};
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let idx = buffer.indexOf("\n");
			while (idx !== -1) {
				handleLine(buffer.slice(0, idx));
				buffer = buffer.slice(idx + 1);
				idx = buffer.indexOf("\n");
			}
		}
		buffer += decoder.decode();
		if (buffer.trim()) handleLine(buffer);
	} finally {
		reader.releaseLock();
	}
	return {
		...(latestText.trim() ? { text: latestText.trim() } : {}),
		...(errorText ? { error: errorText } : {}),
	};
}

function truncateUtf8Bytes(text: string, maxBytes: number): string {
	const trimmed = text.trim();
	if (Buffer.byteLength(trimmed, "utf8") <= maxBytes) return trimmed;
	const chunk = chunkUtf8(trimmed, Math.max(4, maxBytes - 3))[0] ?? "";
	return `${chunk.trimEnd()}…`;
}

function buildPendingFallbackPayload(
	record: { messages: readonly LhMessage[]; tree?: PlanTree },
	baseHint: string,
	sideError?: string,
): { commentary?: string; finalMessage: string } {
	const ctx = extractLiveSessionContext(record);
	const commentaryParts: string[] = [];
	if (ctx.planSummary) commentaryParts.push(`Lesson plan overview:\n${ctx.planSummary}`);
	if (ctx.recentTurns) commentaryParts.push(`Recent conversation:\n${ctx.recentTurns}`);
	commentaryParts.push(baseHint);

	const shortError = sideError?.trim()
		? truncateUtf8Bytes(sideError.trim().split(/\r?\n/, 1)[0] ?? "", 85)
		: "";
	const errorPart = shortError ? `Tutor model error: ${shortError} (switch models in this chat).` : "";
	const instructionPart = "Answer directly from your session memory without spoiling any open quiz; only ask for a quiz pick if they are answering it.";
	const fixedParts = [errorPart, instructionPart].filter(Boolean);
	const fixedBytes = Buffer.byteLength(fixedParts.join(" "), "utf8");
	const memoryPrefix = " Your session memory: ";
	const memoryBudget = Math.max(0, 470 - fixedBytes - Buffer.byteLength(memoryPrefix, "utf8") - 1);
	const rawMemory = buildCompactLiveMemorySummary(record);
	const compactMemory = rawMemory && memoryBudget >= 24 ? truncateUtf8Bytes(rawMemory, memoryBudget) : "";
	const finalMessage = compactMemory
		? `${fixedParts.join(" ")}${memoryPrefix}${compactMemory}.`
		: truncateUtf8Bytes(fixedParts.join(" "), 470);

	return {
		...(commentaryParts.length > 0 ? { commentary: commentaryParts.join("\n\n") } : {}),
		finalMessage,
	};
}

function logLiveDiagnostic(message: string): void {
	if (process.env.NODE_ENV !== "test") {
		console.info(message);
	}
}

async function extractErrorFromResponse(res: Response): Promise<string> {
	try {
		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			const data = (await res.json()) as { error?: string; message?: string };
			if (typeof data.error === "string" && data.error.trim()) return data.error.trim();
			if (typeof data.message === "string" && data.message.trim()) return data.message.trim();
		} else {
			const text = (await res.text()).trim();
			if (text) return text.slice(0, 300);
		}
	} catch { /* ignore parse failure */ }
	return `The tutor request failed (${res.status}).`;
}

export function createLiveSessionManager(deps: LiveSessionDeps): LiveSessionManager {
	const sessions = new Map<string, ManagedLiveSession>();
	const detachGraceMs = deps.detachGraceMs ?? DETACH_GRACE_MS;

	function emitEvent(session: ManagedLiveSession, event: LiveClientEvent) {
		for (const listener of session.subscribers) {
			try { listener(event); } catch { /* observer isolation */ }
		}
	}

	function setPhase(session: ManagedLiveSession, phase: LivePhase) {
		if (session.phase === phase) return;
		session.phase = phase;
		emitEvent(session, { type: "phase", phase });
	}

	function emitTranscript(session: ManagedLiveSession, role: "user" | "assistant", text: string, final: boolean) {
		const trimmed = text.trim();
		if (!trimmed) return;
		const turn = role === "user" ? session.userTurn : session.assistantTurn;
		if (role === "user") {
			session.userText = trimmed;
			session.userFinal = final;
		} else {
			session.assistantText = trimmed;
			session.assistantFinal = final;
		}
		const existing = session.transcriptHistory.find((item) => item.role === role && item.turn === turn);
		if (existing && existing.text === trimmed && existing.final === final) return;
		const entry: LiveTranscriptEntry = { role, turn, text: trimmed, final };
		session.lastTranscript = entry;
		session.transcriptHistory = upsertLiveTranscript(session.transcriptHistory, entry);
		emitEvent(session, { type: "transcript", entry });
	}

	function applyTranscriptDelta(session: ManagedLiveSession, role: "user" | "assistant", delta: string) {
		if (!delta) return;
		const current = role === "user" ? session.userText : session.assistantText;
		const isFinal = role === "user" ? session.userFinal : session.assistantFinal;
		let next: string;
		if (!current) {
			if (role === "user") session.userTurn += 1;
			else session.assistantTurn += 1;
			next = delta;
		} else if (isFinal) {
			if (delta === current || current.endsWith(delta)) return;
			if (role === "user") session.userTurn += 1;
			else session.assistantTurn += 1;
			next = delta;
		} else if (delta.startsWith(current)) {
			next = delta;
		} else if (current.endsWith(delta)) {
			next = current;
		} else {
			next = current + delta;
		}
		emitTranscript(session, role, next, false);
	}

	function applyTranscriptFinal(session: ManagedLiveSession, role: "user" | "assistant", transcript: string) {
		if (!transcript) return;
		const current = role === "user" ? session.userText : session.assistantText;
		const isFinal = role === "user" ? session.userFinal : session.assistantFinal;
		if (!current) {
			if (role === "user") session.userTurn += 1;
			else session.assistantTurn += 1;
		} else if (isFinal) {
			if (transcript === current) return;
			if (role === "user") session.userTurn += 1;
			else session.assistantTurn += 1;
		}
		const merged = !isFinal && current.startsWith(transcript) && current.length > transcript.length ? current : transcript;
		emitTranscript(session, role, merged, true);
	}

	async function sendDelegationText(session: ManagedLiveSession, delegationItemId: string, text: string, channel?: "commentary") {
		if (session.ended || !session.transport) return;
		const chunks = chunkUtf8(text);
		if (channel === undefined) {
			logLiveDiagnostic(`[live] delegation-final (${session.chatId}): bytes=${Buffer.byteLength(text, "utf8")} chunks=${chunks.length}`);
		}
		for (const chunk of chunks) {
			if (session.ended || !session.transport) return;
			await session.transport.send(buildDelegationContextAppend(delegationItemId, chunk, channel));
		}
	}
	async function answerViaSideChat(
		chatId: string,
		record: { messages: readonly LhMessage[]; tree?: PlanTree },
		text: string,
	): Promise<{ text?: string; error?: string }> {
		if (!deps.askSideQuestion) return {};
		const anchorId = sideSegmentId(record.messages);
		if (!anchorId) {
			logLiveDiagnostic(`[live] side-question skipped (${chatId}): no-segment`);
			return {};
		}
		try {
			const response = await deps.askSideQuestion(chatId, text, anchorId);
			if (!response.ok || !response.body) {
				const error = await extractErrorFromResponse(response);
				logLiveDiagnostic(`[live] side-question failed (${chatId}): status=${response.status} error=${error.slice(0, 120)}`);
				return { error };
			}
			const result = await consumeSideNdjson(response.body);
			if (!result.text?.trim()) {
				logLiveDiagnostic(
					`[live] side-question empty (${chatId}): hasError=${Boolean(result.error)}${result.error ? ` error=${result.error.slice(0, 120)}` : ""}`,
				);
				return result.error ? { error: result.error } : {};
			}
			return { text: result.text.trim() };
		} catch {
			logLiveDiagnostic(`[live] side-question threw (${chatId})`);
			return {};
		}
	}

	async function handleDelegation(session: ManagedLiveSession, delegationItemId: string, text: string) {
		if (session.ended) return;
		session.activeDelegationId = delegationItemId;
		setPhase(session, "working");
		emitEvent(session, { type: "delegated", text });

		const sendCommentary = (commentary: string) => {
			if (session.activeDelegationId !== delegationItemId || session.ended) return;
			void sendDelegationText(session, delegationItemId, commentary, "commentary").catch(() => {});
		};

		try {
			const recordBefore = deps.getChat(session.chatId);
			if (!recordBefore) {
				await sendDelegationText(session, delegationItemId, formatAgentFinalMessage("This session could not be found."));
				return;
			}
			const beforeCount = recordBefore.messages.length;

			if (deps.isRunning(session.chatId)) {
				const steered = await deps.steerChat(session.chatId, text);
				if (steered === "accepted") {
					logLiveDiagnostic(`[live] delegation (${session.chatId}): route=steer`);
					const handle = deps.getRunningTurn(session.chatId);
					if (handle) {
						await consumeTurnSse(handle.subscribe(), sendCommentary);
					}
					const after = deps.getChat(session.chatId);
					const newMessages = after ? after.messages.slice(beforeCount) : [];
					const summary = extractTurnSpokenSummary(newMessages);
					if (summary) {
						await sendDelegationText(session, delegationItemId, formatAgentFinalMessage(summary));
					}
					return;
				}
			}

			if (pendingPluginQuestionOf(recordBefore.messages)) {
				const sideResult = await answerViaSideChat(session.chatId, recordBefore, text);
				if (sideResult.text) {
					logLiveDiagnostic(`[live] delegation (${session.chatId}): route=side-question (plugin-pending)`);
					await sendDelegationText(session, delegationItemId, formatAgentFinalMessage(sideResult.text));
					return;
				}
				logLiveDiagnostic(`[live] delegation (${session.chatId}): route=plugin-fallback`);
				const fallback = buildPendingFallbackPayload(
					recordBefore,
					"There is an interactive question card waiting on screen. Answer any clarifying or lesson-plan question using the session context without revealing answers, and remind the learner to complete or dismiss the card on screen.",
					sideResult.error,
				);
				if (fallback.commentary) {
					await sendDelegationText(session, delegationItemId, fallback.commentary, "commentary");
				}
				await sendDelegationText(session, delegationItemId, formatAgentFinalMessage(fallback.finalMessage));
				return;
			}

			const resolution = resolveSpokenInput(recordBefore.messages, text);
			if (resolution.kind === "quiz-unmatched") {
				const sideResult = await answerViaSideChat(session.chatId, recordBefore, text);
				if (sideResult.text) {
					logLiveDiagnostic(`[live] delegation (${session.chatId}): route=side-question (quiz-open)`);
					await sendDelegationText(session, delegationItemId, formatAgentFinalMessage(sideResult.text));
					return;
				}
				logLiveDiagnostic(`[live] delegation (${session.chatId}): route=quiz-fallback`);
				const fallback = buildPendingFallbackPayload(recordBefore, resolution.promptHint, sideResult.error);
				if (fallback.commentary) {
					await sendDelegationText(session, delegationItemId, fallback.commentary, "commentary");
				}
				await sendDelegationText(session, delegationItemId, formatAgentFinalMessage(fallback.finalMessage));
				return;
			}

			const input: ChatInput = resolution.kind === "answer"
				? { type: "answer", toolCallId: resolution.toolCallId, answer: resolution.answer }
				: { type: "text", text };
			logLiveDiagnostic(`[live] delegation (${session.chatId}): route=${resolution.kind === "answer" ? "quiz-answer" : "main-turn"}`);

			const response = await deps.runChatInput(session.chatId, input);
			if (!response.ok) {
				const message = await extractErrorFromResponse(response);
				await sendDelegationText(session, delegationItemId, formatAgentFinalMessage(message));
				return;
			}
			if (response.body) {
				await consumeTurnSse(response.body, sendCommentary);
			}

			const after = deps.getChat(session.chatId);
			const newMessages = after ? after.messages.slice(beforeCount) : [];
			const summary = extractTurnSpokenSummary(newMessages) || "Done.";
			await sendDelegationText(session, delegationItemId, formatAgentFinalMessage(summary));
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to run the tutor turn.";
			await sendDelegationText(session, delegationItemId, formatAgentFinalMessage(message)).catch(() => {});
		} finally {
			if (session.activeDelegationId === delegationItemId) {
				session.activeDelegationId = undefined;
				if (!session.ended) setPhase(session, "listening");
			}
		}
	}

	async function availability(): Promise<LiveAvailability> {
		let endpoint: LiveEndpointConfig | undefined;
		try {
			endpoint = deps.getEndpoint();
		} catch {
			endpoint = undefined;
		}
		if (endpoint) {
			return { available: true, mode: "endpoint", voices: LIVE_VOICES, defaultVoice: DEFAULT_LIVE_VOICE };
		}
		await deps.refreshCodex().catch(() => {});
		const connected = deps.isCodexConnected();
		return {
			available: connected,
			mode: "codex",
			...(connected ? {} : { reason: "not_connected" as const }),
			voices: LIVE_VOICES,
			defaultVoice: DEFAULT_LIVE_VOICE,
		};
	}

	async function start(params: { chatId: string; sdpOffer: string; voice?: string }): Promise<{ liveId: string; sdpAnswer: string; voice: LiveVoiceId }> {
		const record = deps.getChat(params.chatId);
		if (!record) throw new LiveSessionError(404, "not_found", "Unknown chat");
		if (typeof params.sdpOffer !== "string" || !params.sdpOffer.trim()) {
			throw new LiveSessionError(400, "invalid_offer", "A non-empty WebRTC SDP offer is required.");
		}
		const voice: LiveVoiceId = isLiveVoice(params.voice) ? params.voice : DEFAULT_LIVE_VOICE;

		let endpoint: LiveEndpointConfig | undefined;
		try {
			endpoint = deps.getEndpoint();
		} catch (error) {
			throw new LiveSessionError(500, "invalid_endpoint", error instanceof Error ? error.message : "Invalid live endpoint configuration.");
		}

		if (!endpoint) {
			await deps.refreshCodex().catch(() => {});
			if (!deps.isCodexConnected()) {
				throw new LiveSessionError(503, "not_connected", "Live Voice requires an active OpenAI Codex connection in Providers.");
			}
		}

		const previous = sessions.get(params.chatId);
		if (previous) await previous.stop();

		const freshRecord = deps.getChat(params.chatId) ?? record;
		const liveId = randomUUID();
		const sessionContext = extractLiveSessionContext(freshRecord);
		const customInstructions = deps.getLivePrompt?.()?.trim() || undefined;
		const instructions = buildTutorLiveInstructions({
			sessionTitle: freshRecord.title,
			sessionKind: freshRecord.kind,
			customInstructions,
			...sessionContext,
		});
		const sessionSeed = endpoint
			? undefined
			: buildTutorLiveSessionSeed({
				sessionTitle: freshRecord.title,
				sessionKind: freshRecord.kind,
				customInstructions,
				...sessionContext,
			});
		const sessionAbort = new AbortController();
		const codexWatcher = endpoint ? undefined : deps.watchCodexAbort();
		const onCodexAbort = () => { void session.stop("OpenAI Codex connection changed or disconnected."); };
		codexWatcher?.controller.signal.addEventListener("abort", onCodexAbort, { once: true });

		const session: ManagedLiveSession = {
			liveId,
			chatId: params.chatId,
			voice,
			phase: "connecting",
			ended: false,
			delegationQueue: Promise.resolve(),
			userText: "",
			userFinal: false,
			userTurn: 0,
			assistantText: "",
			assistantFinal: false,
			assistantTurn: 0,
			turnRoles: new Map(),
			started: false,
			connected: false,
			contextSeeded: false,
			transcriptHistory: [],
			subscribers: new Set(),
			releaseAbort: () => {
				codexWatcher?.controller.signal.removeEventListener("abort", onCodexAbort);
				codexWatcher?.release();
			},
			stop: async (error?: string) => {
				if (session.ended) return;
				session.ended = true;
				session.endError = error;
				if (session.detachTimer) { clearTimeout(session.detachTimer); session.detachTimer = undefined; }
				sessionAbort.abort();
				session.releaseAbort?.();
				if (sessions.get(params.chatId) === session) {
					sessions.delete(params.chatId);
				}
				if (error) {
					session.phase = "error";
					emitEvent(session, { type: "error", message: error });
				}
				emitEvent(session, { type: "ended", ...(error ? { error } : {}) });
				session.subscribers.clear();
				await session.transport?.close().catch(() => {});
			},
		};

		const maybeSeedSessionContext = () => {
			if (session.contextSeeded || !sessionSeed || !session.started || !session.connected || session.ended || !session.transport) return;
			session.contextSeeded = true;
			void session.transport.send(buildSessionContextAppend(sessionSeed, "commentary")).catch(() => {});
		};

		const onWireEvent = (event: LiveWireEvent) => {
			if (session.ended) return;
			switch (event.type) {
				case "session.started":
					session.started = true;
					logLiveDiagnostic(
						`[live] started (${params.chatId}, remote=${event.session.id}, seedChars=${sessionSeed?.length ?? 0}, seedEstTok=${sessionSeed ? estimateLiveContextTokens(sessionSeed) : 0}, customInstr=${customInstructions?.length ?? 0}, plan=${sessionContext.planSummary?.length ?? 0}, recent=${sessionContext.recentTurns?.length ?? 0}, active=${sessionContext.activePrompt?.length ?? 0})`,
					);
					maybeSeedSessionContext();
					if (!session.activeDelegationId) setPhase(session, "listening");
					break;
				case "session.context.appended":
					logLiveDiagnostic(`[live] context-seeded (${params.chatId})`);
					break;
				case "input_transcript.added":
					applyTranscriptDelta(session, "user", event.item.text);
					break;
				case "output_transcript.added":
					applyTranscriptDelta(session, "assistant", event.item.text);
					break;
				case "turn.created":
					session.turnRoles.set(event.turn.id, event.turn.role);
					if (event.turn.transcript) {
						applyTranscriptDelta(session, event.turn.role, event.turn.transcript);
					}
					break;
				case "turn.delta": {
					const role = session.turnRoles.get(event.turnId);
					if (role) applyTranscriptDelta(session, role, event.delta);
					break;
				}
				case "turn.done":
					if (event.turn.id) session.turnRoles.delete(event.turn.id);
					applyTranscriptFinal(session, event.turn.role, event.turn.transcript);
					break;
				case "delegation.created": {
					const text = event.item.content
						.filter((part) => part.type === "input_text")
						.map((part) => part.text)
						.join("\n")
						.trim();
					if (!text) break;
					session.delegationQueue = session.delegationQueue
						.then(() => handleDelegation(session, event.item.id, text))
						.catch(() => {});
					break;
				}
				case "error":
					void session.stop(event.message);
					break;
				case "session.updated":
				case "output_audio.delta":
				case "unknown":
					break;
			}
		};

		const transport = deps.createTransport({
			sessionId: params.chatId,
			sdpOffer: params.sdpOffer,
			instructions,
			voice,
			endpoint,
			getCodexAuth: endpoint ? undefined : () => deps.leaseCodexAuth(),
			signal: sessionAbort.signal,
			onEvent: onWireEvent,
		});
		session.transport = transport;
		sessions.set(params.chatId, session);

		try {
			await transport.connect();
		} catch (error) {
			await session.stop();
			if (error instanceof LiveSignalingError) {
				throw new LiveSessionError(error.status >= 400 && error.status < 600 ? 502 : 500, "signaling_failed", error.message);
			}
			throw new LiveSessionError(502, "connect_failed", error instanceof Error ? error.message : "Failed to connect Live Voice.");
		}
		session.connected = true;
		maybeSeedSessionContext();
		const sdpAnswer = transport.sdpAnswer;
		if (!sdpAnswer) {
			await session.stop();
			throw new LiveSessionError(502, "missing_answer", "Live Voice signaling did not return an SDP answer.");
		}

		session.detachTimer = setTimeout(() => {
			if (session.subscribers.size === 0) void session.stop();
		}, Math.max(detachGraceMs, 10_000));
		session.detachTimer.unref?.();

		if (session.phase === "connecting") setPhase(session, "listening");
		return { liveId, sdpAnswer, voice };
	}

	function subscribe(chatId: string, liveId: string): ReadableStream<Uint8Array> | null {
		const session = sessions.get(chatId);
		if (!session || session.liveId !== liveId) return null;

		const encoder = new TextEncoder();
		let listener: ((event: LiveClientEvent) => void) | undefined;
		let heartbeat: ReturnType<typeof setInterval> | undefined;

		return new ReadableStream<Uint8Array>({
			start(controller) {
				if (session.detachTimer) {
					clearTimeout(session.detachTimer);
					session.detachTimer = undefined;
				}
				const send = (event: LiveClientEvent) => {
					try {
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
						if (event.type === "ended") {
							clearInterval(heartbeat);
							controller.close();
						}
					} catch { /* stream already closed */ }
				};
				listener = send;
				session.subscribers.add(send);
				send({ type: "phase", phase: session.phase });
				for (const entry of session.transcriptHistory) {
					send({ type: "transcript", entry });
				}
				if (session.ended) {
					send({ type: "ended", ...(session.endError ? { error: session.endError } : {}) });
					return;
				}
				heartbeat = setInterval(() => {
					try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* closed */ }
				}, HEARTBEAT_MS);
				heartbeat.unref?.();
			},
			cancel() {
				clearInterval(heartbeat);
				if (listener) session.subscribers.delete(listener);
				if (session.subscribers.size === 0 && !session.ended) {
					session.detachTimer = setTimeout(() => {
						if (session.subscribers.size === 0 && !session.ended) {
							void session.stop();
						}
					}, detachGraceMs);
					session.detachTimer.unref?.();
				}
			},
		});
	}

	async function stop(chatId: string, liveId?: string): Promise<boolean> {
		const session = sessions.get(chatId);
		if (!session) return false;
		if (liveId && session.liveId !== liveId) return false;
		await session.stop();
		return true;
	}

	function activeLiveId(chatId: string): string | undefined {
		return sessions.get(chatId)?.liveId;
	}

	return { availability, start, subscribe, stop, activeLiveId };
}

const REGISTRY_KEY = Symbol.for("lh.live.sessionManager");

function defaultDeps(): LiveSessionDeps {
	return {
		getChat: (chatId) => stores.chatStore.getChat(chatId),
		runChatInput: (chatId, input) => handleChatInput(chatId, input),
		askSideQuestion: (chatId, text, anchorMessageId) => {
			const livePrompt = effectiveSettings().agent.livePrompt?.trim();
			const extraInstructions = [
				"## Live Voice delivery",
				"This question was spoken in Live Voice. Reply concisely in 2-4 natural spoken sentences without markdown tables, code fences, or long lists so it reads cleanly aloud.",
				...(livePrompt ? [`User Live Voice preferences:\n${livePrompt}`] : []),
			].join("\n\n");
			return sideChats.ask(chatId, {
				anchor: { messageId: anchorMessageId, partId: `${anchorMessageId}-t0`, blockIndex: 0, blockText: "" },
				text,
				quotes: [],
			}, { extraInstructions });
		},
		getLivePrompt: () => effectiveSettings().agent.livePrompt ?? undefined,
		steerChat: (chatId, text) => prepareAndSteerChat(chatId, { type: "steer", id: `steer_${randomUUID()}`, text }),
		isRunning: (chatId) => isTurnRunning(chatId),
		getRunningTurn: (chatId) => runningTurn(chatId),
		getEndpoint: () => resolveLiveEndpointConfig(),
		refreshCodex: () => refreshSubscriptionModels(),
		isCodexConnected: () => nativeSubscriptionConnected("openai-codex"),
		leaseCodexAuth: async () => {
			await refreshSubscriptionModels();
			const model = nativeSubscriptionModels().find((m) => m.provider === "openai-codex-subscription");
			if (!model) throw new LiveSessionError(503, "not_connected", "OpenAI Codex connection is unavailable. Reconnect in Providers.");
			const scope = subscriptionScope("openai-codex", model.id);
			const auth = await subscriptionLease(scope, false);
			if (!auth.apiKey) throw new LiveSessionError(503, "not_connected", "OpenAI Codex authorization could not be leased. Reconnect in Providers.");
			return {
				accessToken: auth.apiKey,
				accountId: extractAccountIdFromJwt(auth.apiKey),
			};
		},
		watchCodexAbort: () => subscriptionAbortController("openai-codex", false),
		createTransport: (options) => new LiveTransport(options),
	};
}

export function liveSessionManager(): LiveSessionManager {
	const g = globalThis as typeof globalThis & { [REGISTRY_KEY]?: LiveSessionManager };
	return (g[REGISTRY_KEY] ??= createLiveSessionManager(defaultDeps()));
}

export async function liveAvailabilityResponse(): Promise<Response> {
	return Response.json(await liveSessionManager().availability());
}

export async function handleLiveStartRequest(chatId: string, request: Request): Promise<Response> {
	let body: { sdpOffer?: unknown; voice?: unknown };
	try {
		body = (await request.json()) as { sdpOffer?: unknown; voice?: unknown };
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	try {
		const result = await liveSessionManager().start({
			chatId,
			sdpOffer: typeof body.sdpOffer === "string" ? body.sdpOffer : "",
			voice: typeof body.voice === "string" ? body.voice : undefined,
		});
		return Response.json(result);
	} catch (error) {
		if (error instanceof LiveSessionError) {
			if (error.status >= 500) {
				console.error(`[live] start failed (${chatId}, ${error.status}, ${error.code}): ${error.message}`);
			}
			return Response.json({ error: error.message, code: error.code }, { status: error.status });
		}
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[live] start failed (${chatId}, 500, unexpected): ${message}`);
		return Response.json({ error: "Live Voice failed to start." }, { status: 500 });
	}
}

export function handleLiveEventsRequest(chatId: string, request: Request): Response {
	const liveId = new URL(request.url).searchParams.get("liveId")?.trim() ?? "";
	if (!liveId) return Response.json({ error: "liveId is required" }, { status: 400 });
	const stream = liveSessionManager().subscribe(chatId, liveId);
	if (!stream) return Response.json({ error: "Live session not found" }, { status: 404 });
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}

export async function handleLiveStopRequest(chatId: string, request: Request): Promise<Response> {
	const liveId = new URL(request.url).searchParams.get("liveId")?.trim() || undefined;
	await liveSessionManager().stop(chatId, liveId);
	return Response.json({ ok: true });
}
