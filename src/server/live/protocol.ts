import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LIVE_MODEL, type LiveVoiceId } from "../../core/contracts/live.ts";

export const CODEX_LIVE_BASE_URL = "https://chatgpt.com/backend-api";
export const CODEX_LIVE_SIGNALING_URL = `${CODEX_LIVE_BASE_URL}/codex/realtime/calls?intent=quicksilver&architecture=avas`;
export const CODEX_LIVE_ORIGINATOR = "Codex Desktop";
export const DEFAULT_CODEX_CLIENT_VERSION = "0.169.0";
export const DELEGATION_CHUNK_MAX_BYTES = 500;
export const CODEX_CALL_ID_PATTERN = /^rtc_[\w-]+$/;

const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const ATTESTATION_BUNDLE_ID = "com.openai.codex";
const attestationSessionId = randomUUID();

export type LiveWireEvent =
	| { type: "session.started" | "session.updated"; session: { id: string; instructions?: string } }
	| { type: "output_audio.delta"; audio: string }
	| { type: "input_transcript.added" | "output_transcript.added"; item: { text: string } }
	| { type: "turn.done"; turn: { role: "user" | "assistant"; transcript: string } }
	| { type: "delegation.created"; item: { type: "delegation"; target: "client"; id: string; content: { type: "input_text"; text: string }[] } }
	| { type: "error"; message: string }
	| { type: "unknown"; wireType: string };

const SessionEventSchema = z.object({
	type: z.enum(["session.started", "session.updated"]),
	session: z.object({ id: z.string(), instructions: z.string().optional() }),
});
const AudioDeltaSchema = z.object({ type: z.literal("output_audio.delta"), audio: z.string() });
const TranscriptAddedSchema = z.object({
	type: z.enum(["input_transcript.added", "output_transcript.added"]),
	item: z.object({ text: z.string() }),
});
const TurnDoneSchema = z.object({
	type: z.literal("turn.done"),
	turn: z.object({ role: z.enum(["user", "assistant"]), transcript: z.string() }),
});
const DelegationCreatedSchema = z.object({
	type: z.literal("delegation.created"),
	item: z.object({
		type: z.literal("delegation"),
		target: z.literal("client"),
		id: z.string(),
		content: z.array(z.unknown()),
	}),
});
const DelegationInputTextSchema = z.object({ type: z.literal("input_text"), text: z.string() });
const ErrorPayloadSchema = z.object({
	type: z.literal("error"),
	message: z.string().optional(),
	error: z.unknown().optional(),
});
const JwtPayloadSchema = z.object({
	[JWT_AUTH_CLAIM]: z.object({ chatgpt_account_id: z.string().min(1) }).optional(),
});

function stringifyError(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value === undefined) return null;
	try {
		return JSON.stringify(value) ?? null;
	} catch {
		return String(value);
	}
}

export function parseLiveWireEvent(raw: unknown): LiveWireEvent | null {
	let parsed = raw;
	if (typeof raw === "string") {
		try {
			parsed = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("type" in parsed) || typeof parsed.type !== "string") {
		return null;
	}

	switch (parsed.type) {
		case "session.started":
		case "session.updated": {
			const res = SessionEventSchema.safeParse(parsed);
			if (!res.success) return null;
			return {
				type: res.data.type,
				session: res.data.session.instructions !== undefined
					? { id: res.data.session.id, instructions: res.data.session.instructions }
					: { id: res.data.session.id },
			};
		}
		case "output_audio.delta": {
			const res = AudioDeltaSchema.safeParse(parsed);
			return res.success ? res.data : null;
		}
		case "input_transcript.added":
		case "output_transcript.added": {
			const res = TranscriptAddedSchema.safeParse(parsed);
			return res.success ? res.data : null;
		}
		case "turn.done": {
			const res = TurnDoneSchema.safeParse(parsed);
			return res.success ? res.data : null;
		}
		case "delegation.created": {
			const res = DelegationCreatedSchema.safeParse(parsed);
			if (!res.success) return null;
			const content: { type: "input_text"; text: string }[] = [];
			for (const part of res.data.item.content) {
				const textPart = DelegationInputTextSchema.safeParse(part);
				if (textPart.success) content.push(textPart.data);
			}
			return {
				type: "delegation.created",
				item: { type: "delegation", target: "client", id: res.data.item.id, content },
			};
		}
		case "error": {
			const res = ErrorPayloadSchema.safeParse(parsed);
			if (!res.success) return null;
			if (res.data.message !== undefined) return { type: "error", message: res.data.message };
			const inner = res.data.error;
			if (typeof inner === "object" && inner !== null && "message" in inner && typeof inner.message === "string") {
				return { type: "error", message: inner.message };
			}
			const serialized = stringifyError(inner);
			return serialized === null ? null : { type: "error", message: serialized };
		}
		default:
			return { type: "unknown", wireType: parsed.type };
	}
}

export function buildCreateSessionConfig(instructions: string, voice: LiveVoiceId) {
	return {
		model: LIVE_MODEL,
		instructions,
		audio: { output: { voice } },
		delegation: { type: "client" as const },
	};
}

export function buildSessionUpdate(instructions: string, voice: LiveVoiceId) {
	return {
		type: "session.update" as const,
		session: {
			type: "realtime" as const,
			instructions,
			audio: { output: { voice } },
			delegation: { type: "client" as const },
		},
	};
}

export function buildDelegationContextAppend(delegationItemId: string, text: string, channel?: "commentary") {
	return {
		type: "delegation.context.append" as const,
		delegation_item_id: delegationItemId,
		...(channel === undefined ? {} : { channel }),
		content: [{ type: "input_text" as const, text }],
	};
}

export function buildSessionClose() {
	return { type: "session.close" as const };
}

/** Codepoint-safe UTF-8 byte chunker (essential for Japanese and other multibyte scripts). */
export function chunkUtf8(text: string, maxBytes: number = DELEGATION_CHUNK_MAX_BYTES): string[] {
	if (text.length === 0) return [""];
	const chunks: string[] = [];
	let start = 0;
	let byteCount = 0;
	let index = 0;
	while (index < text.length) {
		const cp = text.codePointAt(index);
		if (cp === undefined) break;
		const charLen = cp > 0xffff ? 2 : 1;
		const cpBytes = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
		if (byteCount + cpBytes > maxBytes && index > start) {
			chunks.push(text.slice(start, index));
			start = index;
			byteCount = 0;
		}
		byteCount += cpBytes;
		index += charLen;
	}
	chunks.push(text.slice(start));
	return chunks;
}

export function extractCallIdFromLocation(location: string | null): string | undefined {
	if (!location) return undefined;
	return location.split("?", 1)[0]?.split("/").find((segment) => CODEX_CALL_ID_PATTERN.test(segment));
}

export function extractEndpointCallIdFromLocation(location: string | null): string | undefined {
	const segment = location?.split(/[?#]/, 1)[0]?.split("/").filter((part) => part.length > 0).at(-1);
	if (!segment) return undefined;
	try {
		return decodeURIComponent(segment) || undefined;
	} catch {
		return undefined;
	}
}

export function buildCodexSidebandUrl(callId: string): string {
	const url = new URL(`https://api.openai.com/v1/live/${encodeURIComponent(callId)}`);
	url.protocol = "wss:";
	return url.toString();
}

export function buildEndpointSignalingUrl(baseUrl: string): string {
	const url = new URL(baseUrl);
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/realtime/calls`;
	return url.toString();
}

export function buildEndpointSidebandUrl(baseUrl: string, callId: string): string {
	const url = new URL(baseUrl);
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/realtime`;
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("call_id", callId);
	return url.toString();
}

export function extractAccountIdFromJwt(accessToken: string): string | undefined {
	const parts = accessToken.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const decoded: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
		const parsed = JwtPayloadSchema.safeParse(decoded);
		return parsed.success ? parsed.data[JWT_AUTH_CLAIM]?.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
}

function cborHead(majorBase: number, length: number): Buffer {
	if (!Number.isSafeInteger(length) || length < 0) throw new Error(`Invalid CBOR length: ${length}`);
	if (length < 24) return Buffer.from([majorBase + length]);
	if (length <= 0xff) return Buffer.from([majorBase + 24, length]);
	if (length <= 0xffff) {
		const buf = Buffer.allocUnsafe(3);
		buf[0] = majorBase + 25;
		buf.writeUInt16BE(length, 1);
		return buf;
	}
	if (length <= 0xffffffff) {
		const buf = Buffer.allocUnsafe(5);
		buf[0] = majorBase + 26;
		buf.writeUInt32BE(length, 1);
		return buf;
	}
	throw new Error(`CBOR length too large: ${length}`);
}

function encodeCborText(s: string): Buffer {
	const b = Buffer.from(s, "utf8");
	return Buffer.concat([cborHead(0x60, b.length), b]);
}

function encodeCborMap(entries: [Buffer, Buffer][]): Buffer {
	const parts = [cborHead(0xa0, entries.length)];
	for (const [k, v] of entries) parts.push(k, v);
	return Buffer.concat(parts);
}

/** Pure-Node fallback DeviceCheck attestation envelope matching Codex Desktop's unsupported-platform CBOR shape. */
export function buildFallbackAttestation(sessionId: string = attestationSessionId): string {
	const resolved = Intl.DateTimeFormat().resolvedOptions();
	const locale = (resolved.locale || "unknown").slice(0, 64);
	const timeZone = (resolved.timeZone || "unknown").slice(0, 64);
	const localeText = encodeCborText(locale);
	const fingerprint = encodeCborMap([
		[cborHead(0x00, 0), cborHead(0x00, 1)],
		[cborHead(0x00, 1), Buffer.concat([cborHead(0x80, 1), localeText])],
		[cborHead(0x00, 2), localeText],
		[cborHead(0x00, 3), encodeCborText(timeZone)],
		[cborHead(0x00, 4), cborHead(0x00, 0)],
		[cborHead(0x00, 5), cborHead(0x00, 1)],
		[cborHead(0x00, 6), encodeCborText(sessionId.slice(0, 128))],
	]);
	const token = encodeCborMap([
		[encodeCborText("error_code"), cborHead(0x00, 3)],
		[encodeCborText("bundle_id"), encodeCborText(ATTESTATION_BUNDLE_ID)],
		[encodeCborText("f"), Buffer.concat([cborHead(0x40, fingerprint.length), fingerprint])],
	]);
	return JSON.stringify({ v: 1, s: 0, t: `v1.${token.toString("base64url")}` });
}

export function codexClientVersion(): string {
	return process.env.LH_CODEX_CLIENT_VERSION?.trim() || process.env.PI_AI_CODEX_CLIENT_VERSION?.trim() || DEFAULT_CODEX_CLIENT_VERSION;
}

export function buildCodexLiveHeaders(params: {
	accessToken: string;
	sessionId: string;
	callSessionId: string;
	accountId?: string;
	attestation?: string;
	clientVersion?: string;
}): Record<string, string> {
	const version = params.clientVersion ?? codexClientVersion();
	const headers: Record<string, string> = {
		Authorization: `Bearer ${params.accessToken}`,
		"OpenAI-Alpha": "quicksilver=v2",
		"User-Agent": `${CODEX_LIVE_ORIGINATOR}/${version}`,
		"x-session-id": params.callSessionId,
		originator: CODEX_LIVE_ORIGINATOR,
		version,
		"session-id": params.sessionId,
		"thread-id": params.sessionId,
	};
	const accountId = params.accountId ?? extractAccountIdFromJwt(params.accessToken);
	if (accountId) headers["chatgpt-account-id"] = accountId;
	if (params.attestation) headers["x-oai-attestation"] = params.attestation;
	return headers;
}

export function formatAgentFinalMessage(message: string): string {
	return `"Agent Final Message":\n\n${message}`;
}

export function buildTutorLiveInstructions(context: {
	sessionTitle?: string;
	sessionKind?: string;
	hasPendingQuestion?: boolean;
	customInstructions?: string;
	planSummary?: string;
	recentTurns?: string;
	activePrompt?: string;
}): string {
	const topicLine = context.sessionTitle?.trim()
		? `Current LearnHarness session (${context.sessionKind === "practice" ? "practice" : "teaching"}): ${context.sessionTitle.trim()}.`
		: `Current LearnHarness session (${context.sessionKind === "practice" ? "practice" : "teaching"}).`;
	const pendingLine = context.hasPendingQuestion
		? "There is currently an unanswered question card waiting on screen in this session."
		: "";
	const sections: string[] = [
		"You and the LearnHarness tutor backend are ONE single tutor, not two separate assistants.",
		topicLine,
		pendingLine,
		"Always delegate every substantive learner message, lesson request, question, practice prompt, or answer to the client backend so the lesson transcript, knowledge graph, plan, and quiz cards stay accurate.",
		"If the learner is only greeting you, asking to repeat something just said or shown on screen, or asking what earlier context or lesson-plan topics you can see, you may answer directly from the session context below; otherwise create a client delegation immediately.",
		"If the learner speaks a new request while a turn is already running, create a new delegation to steer the same lesson.",
		"Keep your spoken responses natural, concise, warm, and speech-friendly. Never read raw markdown syntax, URLs, backticks, or code fences aloud unless explicitly asked.",
		"Match the language of the lesson naturally: when speaking Japanese (or any target language), pronounce words, example sentences, and phrases clearly and naturally in that language rather than spelling them out in romaji unless asked.",
		"Treat delegation context as your own internal progress and lesson output. Never refer to a backend, client delegation, tool protocol, or separate assistant.",
		"Commentary context is quiet progress while you think or prepare a response; you may acknowledge active work briefly without claiming results before they arrive.",
		'Context beginning with `"Agent Final Message":` is your finished tutor reply for the learner. Present its substance and any posed question naturally in speech as your own words, without mentioning the label.',
	].filter(Boolean);
	if (context.customInstructions?.trim()) {
		sections.push(
			"",
			"Custom Live Voice instructions from the user (apply these preferences for language, pacing, and how to use the lesson plan, while still delegating substantive turns and never revealing unanswered quiz answers):",
			context.customInstructions.trim(),
		);
	}
	if (context.planSummary?.trim()) {
		sections.push("", "Lesson plan overview:", context.planSummary.trim());
	}
	if (context.activePrompt?.trim()) {
		sections.push("", "Currently open on screen:", context.activePrompt.trim());
	}
	if (context.recentTurns?.trim()) {
		sections.push(
			"",
			"Recent conversation (context only — still delegate new substantive turns and answers to the backend):",
			context.recentTurns.trim(),
		);
	}
	return sections.join("\n");
}
