import assert from "node:assert/strict";
import test from "node:test";
import { newAnswerResult, newPlanBlockMessage, newThinkingMessage, type LhMessage } from "../src/core/native-messages.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import { upsertLiveTranscript, type LiveClientEvent, type LiveTranscriptEntry } from "../src/core/contracts/live.ts";
import { sideChatLessonDocument } from "../src/core/side-chat.ts";
import { questionDisplayOptions } from "../src/core/question-core.ts";
import {
	CODEX_LIVE_SIGNALING_URL,
	DELEGATION_CHUNK_MAX_BYTES,
	buildCodexSidebandUrl,
	buildFallbackAttestation,
	buildTutorLiveInstructions,
	chunkUtf8,
	extractAccountIdFromJwt,
	extractCallIdFromLocation,
	parseLiveWireEvent,
	type LiveWireEvent,
} from "../src/server/live/protocol.ts";
import {
	extractAssistantCommentary,
	extractLiveSessionContext,
	extractTurnSpokenSummary,
	resolveSpokenInput,
} from "../src/server/live/speech-extract.ts";
import {
	LiveTransport,
	resolveLiveEndpointConfig,
	type LiveSidebandSocket,
} from "../src/server/live/transport.ts";
import { createLiveSessionManager, LiveSessionError } from "../src/server/live/session-manager.ts";
const FAKE_JWT = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({
	"https://api.openai.com/auth": { chatgpt_account_id: "acct_live_123" },
})).toString("base64url")}.sig`;

function assistantMessage(content: Extract<LhMessage, { role: "assistant" }>["content"], stopReason: "stop" | "toolUse" | "error" = "stop", errorMessage?: string): LhMessage {
	return {
		id: "msg_a1",
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic-subscription",
		model: "claude-opus-4-6",
		content,
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

class FakeSocket implements LiveSidebandSocket {
	readyState = 0;
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onclose: ((event: { code: number; reason?: string }) => void) | null = null;
	sent: string[] = [];
	closed = false;

	open() {
		this.readyState = 1;
		this.onopen?.({});
	}
	receive(payload: object | string) {
		this.onmessage?.({ data: typeof payload === "string" ? payload : JSON.stringify(payload) });
	}
	send(data: string) {
		this.sent.push(data);
	}
	close(code = 1000, reason = "") {
		if (this.closed) return;
		this.closed = true;
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}
}

test("chunkUtf8 respects 500-byte UTF-8 boundaries for Japanese text and surrogate pairs", () => {
	const japanese = "日本語のて形の活用を練習しましょう。食べますは食べてになります。".repeat(25) + "🇯🇵✨";
	const chunks = chunkUtf8(japanese, DELEGATION_CHUNK_MAX_BYTES);
	assert(chunks.length > 1);
	for (const chunk of chunks) {
		assert(Buffer.byteLength(chunk, "utf8") <= DELEGATION_CHUNK_MAX_BYTES);
	}
	assert.equal(chunks.join(""), japanese);
});

test("protocol parses wire events, extracts JWT accountId and rtc call IDs, and builds CBOR attestation", () => {
	assert.equal(extractAccountIdFromJwt(FAKE_JWT), "acct_live_123");
	assert.equal(extractAccountIdFromJwt("not-a-jwt"), undefined);
	assert.equal(extractCallIdFromLocation("https://chatgpt.com/backend-api/codex/realtime/calls/rtc_abc123?x=1"), "rtc_abc123");
	assert.equal(buildCodexSidebandUrl("rtc_abc123"), "wss://api.openai.com/v1/live/rtc_abc123");

	const att = JSON.parse(buildFallbackAttestation("00000000-0000-4000-8000-000000000001")) as { v: number; s: number; t: string };
	assert.equal(att.v, 1);
	assert.equal(att.s, 0);
	assert(att.t.startsWith("v1."));

	const delegation = parseLiveWireEvent(JSON.stringify({
		type: "delegation.created",
		item: { type: "delegation", target: "client", id: "del_1", content: [{ type: "input_text", text: "こんにちは" }] },
	}));
	assert.deepEqual(delegation, {
		type: "delegation.created",
		item: { type: "delegation", target: "client", id: "del_1", content: [{ type: "input_text", text: "こんにちは" }] },
	});
	assert.deepEqual(parseLiveWireEvent('{"type":"turn.done","turn":{"role":"user","transcript":"ありがとう"}}'), {
		type: "turn.done",
		turn: { role: "user", transcript: "ありがとう" },
	});
	assert.equal(parseLiveWireEvent("{bad json"), null);
});

test("speech extraction reads send_to_user and posed quizzes in display order without leaking answers", () => {
	const options = [
		{ label: "食べて", value: "tabete" },
		{ label: "食べって", value: "tabette" },
		{ label: "食べんで", value: "tabende" },
	];
	const msg = assistantMessage([
		{ type: "toolCall", id: "call_send", name: "send_to_user", arguments: { message: "Ichidan verbs drop る and add て." } },
		{
			type: "toolCall",
			id: "call_quiz_1",
			name: "quiz",
			arguments: {
				type: "check",
				nodeId: "te-form",
				question: "What is the て-form of 食べる?",
				options,
				correctAnswer: "tabete",
				explanation: "食べる is an ichidan verb, so drop る and add て.",
			},
		},
	], "toolUse");

	assert.equal(extractAssistantCommentary(msg), "Ichidan verbs drop る and add て.");

	const summary = extractTurnSpokenSummary([msg]);
	assert(summary.includes("Ichidan verbs drop る and add て."));
	assert(summary.includes("What is the て-form of 食べる?"));
	assert(!summary.includes("食べる is an ichidan verb"), "must never leak quiz explanation");

	const displayed = questionDisplayOptions(options, "quiz", false, "call_quiz_1");
	const firstLetter = Object.keys(displayed.optionOrder!)[0]!;
	assert(summary.includes(`${firstLetter}. ${displayed.options[0]!.label}`), "option order must match client seeded shuffle");
});

test("resolveSpokenInput grades spoken quiz picks, free-recall explain answers, and Japanese don't-know", () => {
	const options = [
		{ label: "食べて", value: "tabete" },
		{ label: "食べって", value: "tabette" },
	];
	const quizCall = assistantMessage([
		{
			type: "toolCall",
			id: "call_quiz_2",
			name: "quiz",
			arguments: {
				type: "check",
				nodeId: "te-form",
				question: "Choose the て-form of 食べる",
				options,
				correctAnswer: "tabete",
				explanation: "Ichidan rule.",
			},
		},
	], "toolUse");

	const displayed = questionDisplayOptions(options, "quiz", false, "call_quiz_2");
	const correctIdx = displayed.options.findIndex((o) => o.value === "tabete");
	const correctLetter = Object.keys(displayed.optionOrder!)[correctIdx]!;

	const picked = resolveSpokenInput([quizCall], `Option ${correctLetter}`);
	assert.equal(picked.kind, "answer");
	if (picked.kind === "answer") {
		assert.equal(picked.toolCallId, "call_quiz_2");
		assert.equal(picked.answer.correct, true);
		assert.equal(picked.answer.answers[0]?.value, "tabete");
	}

	const idk = resolveSpokenInput([quizCall], "わかりません");
	assert.equal(idk.kind, "answer");
	if (idk.kind === "answer") {
		assert.equal(idk.answer.dontKnow, true);
		assert.equal(idk.answer.correct, false);
	}

	const clarification = resolveSpokenInput([quizCall], "Wait, is 食べる ichidan or godan?");
	assert.equal(clarification.kind, "quiz-unmatched");
	if (clarification.kind === "quiz-unmatched") {
		assert(!clarification.promptHint.includes("Ichidan rule"));
	}

	const explainCall = assistantMessage([
		{
			type: "toolCall",
			id: "call_explain_1",
			name: "explain",
			arguments: {
				type: "check",
				nodeId: "te-form",
				question: "Explain how to form the て-form of 飲む.",
				correctAnswer: "Change む to んで: 飲んで.",
			},
		},
	], "toolUse");
	const explainAns = resolveSpokenInput([explainCall], "む becomes んで so it is 飲んで");
	assert.equal(explainAns.kind, "answer");
	if (explainAns.kind === "answer") {
		assert.equal(explainAns.answer.kind, "explain");
		assert.equal(explainAns.answer.text, "む becomes んで so it is 飲んで");
		assert.equal(explainAns.answer.committed, "Change む to んで: 飲んで.");
	}
});

test("LiveTransport signals Codex with quicksilver headers, connects sideband WS, and closes cleanly", async () => {
	let fetchUrl = "";
	let fetchHeaders = new Headers();
	let fetchBody: Record<string, unknown> = {};
	let wsUrl = "";
	let wsHeaders: Record<string, string> = {};
	const fakeSocket = new FakeSocket();
	const received: LiveWireEvent[] = [];

	const transport = new LiveTransport({
		sessionId: "chat_jp_1",
		sdpOffer: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n",
		instructions: "Teach Japanese naturally.",
		voice: "sol",
		getCodexAuth: async () => ({ accessToken: FAKE_JWT, accountId: "acct_live_123" }),
		fetch: async (input, init) => {
			fetchUrl = String(input);
			fetchHeaders = new Headers(init?.headers);
			fetchBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response("v=0\r\ns=answer\r\n", {
				status: 201,
				headers: { location: "https://chatgpt.com/backend-api/codex/realtime/calls/rtc_jp999" },
			});
		},
		createWebSocket: (url, headers) => {
			wsUrl = url;
			wsHeaders = headers;
			queueMicrotask(() => fakeSocket.open());
			return fakeSocket;
		},
		onEvent: (event) => received.push(event),
	});

	await transport.connect();
	assert.equal(fetchUrl, CODEX_LIVE_SIGNALING_URL);
	assert.equal(fetchHeaders.get("authorization"), `Bearer ${FAKE_JWT}`);
	assert.equal(fetchHeaders.get("openai-alpha"), "quicksilver=v2");
	assert.equal(fetchHeaders.get("originator"), "Codex Desktop");
	assert.equal(fetchHeaders.get("chatgpt-account-id"), "acct_live_123");
	assert(fetchHeaders.get("x-oai-attestation")?.includes('"v":1'));
	assert.equal((fetchBody.session as { model: string }).model, "gpt-live-1-codex");
	assert.equal(transport.sdpAnswer, "v=0\r\ns=answer\r\n");
	assert.equal(wsUrl, "wss://api.openai.com/v1/live/rtc_jp999");
	assert.equal(wsHeaders["OpenAI-Alpha"], "quicksilver=v2");

	fakeSocket.receive({ type: "session.started", session: { id: "sess_1" } });
	assert.deepEqual(received[0], { type: "session.started", session: { id: "sess_1" } });

	await transport.close();
	assert(fakeSocket.sent.some((line) => line.includes('"session.close"')));
	assert(fakeSocket.closed);
});

test("resolveLiveEndpointConfig validates custom endpoint and LiveTransport uses application/sdp + session.update", async () => {
	assert.equal(resolveLiveEndpointConfig({}), undefined);
	assert.throws(() => resolveLiveEndpointConfig({ LH_LIVE_ENDPOINT: "ftp://bad.example" }));
	const endpoint = resolveLiveEndpointConfig({ LH_LIVE_ENDPOINT: "https://voice.example/v1", LH_LIVE_API_KEY: "secret_k" })!;
	assert.equal(endpoint.baseUrl, "https://voice.example/v1");

	let contentType = "";
	let wsUrl = "";
	const fakeSocket = new FakeSocket();
	const transport = new LiveTransport({
		sessionId: "chat_2",
		sdpOffer: "v=0\r\n",
		instructions: "Tutor instructions",
		voice: "breeze",
		endpoint,
		fetch: async (_input, init) => {
			contentType = new Headers(init?.headers).get("content-type") ?? "";
			return new Response("v=0\r\ns=custom\r\n", { status: 201, headers: { location: "/v1/realtime/calls/call_custom_1" } });
		},
		createWebSocket: (url) => {
			wsUrl = url;
			queueMicrotask(() => fakeSocket.open());
			return fakeSocket;
		},
		onEvent: () => {},
	});
	await transport.connect();
	assert.equal(contentType, "application/sdp");
	assert.equal(wsUrl, "wss://voice.example/v1/realtime?call_id=call_custom_1");
	assert(fakeSocket.sent.some((line) => line.includes('"session.update"') && line.includes('"breeze"')));
	await transport.close();
});

test("createLiveSessionManager bridges delegation.created into tutor turns and streams commentary + final reply back", async () => {
	let codexConnected = false;
	const chatMessages: LhMessage[] = [];
	const sentFrames: object[] = [];
	const twoFramesSent = Promise.withResolvers<void>();
	let emitWire!: (event: LiveWireEvent) => void;
	const abortController = new AbortController();

	const manager = createLiveSessionManager({
		getChat: (id) => id === "chat_jp" ? { id, title: "Japanese て-form", kind: "teach", messages: [...chatMessages] } : null,
		runChatInput: async (_chatId, input) => {
			assert.equal(input.type, "text");
			const commentaryMsg = assistantMessage([{ type: "text", text: "Looking at your Japanese notes…" }], "toolUse");
			const finalReply = assistantMessage([{ type: "toolCall", id: "c1", name: "send_to_user", arguments: { message: "「食べて」は正しいです！よくできました。" } }], "stop");
			chatMessages.push(finalReply);
			const encoder = new TextEncoder();
			return new Response(new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "message_end", message: commentaryMsg })}\n\n`));
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				},
			}), { status: 200, headers: { "content-type": "text/event-stream" } });
		},
		steerChat: async () => "settled",
		isRunning: () => false,
		getRunningTurn: () => undefined,
		getEndpoint: () => undefined,
		refreshCodex: async () => {},
		isCodexConnected: () => codexConnected,
		leaseCodexAuth: async () => ({ accessToken: FAKE_JWT, accountId: "acct_live_123" }),
		watchCodexAbort: () => ({ controller: abortController, release: () => {} }),
		createTransport: (options) => {
			emitWire = options.onEvent;
			return {
				sdpAnswer: "v=0\r\ns=ok\r\n",
				connect: async () => {},
				send: async (payload) => {
					sentFrames.push(payload);
					if (sentFrames.length === 2) twoFramesSent.resolve();
				},
				close: async () => {},
			};
		},
		detachGraceMs: 50,
	});

	assert.equal((await manager.availability()).available, false);
	await assert.rejects(
		manager.start({ chatId: "chat_jp", sdpOffer: "v=0\r\n" }),
		(err: unknown) => err instanceof LiveSessionError && err.status === 503 && err.code === "not_connected",
	);

	codexConnected = true;
	assert.equal((await manager.availability()).available, true);

	const started = await manager.start({ chatId: "chat_jp", sdpOffer: "v=0\r\n", voice: "juniper" });
	assert.equal(started.sdpAnswer, "v=0\r\ns=ok\r\n");
	assert.equal(started.voice, "juniper");

	const sseStream = manager.subscribe("chat_jp", started.liveId);
	assert(sseStream);
	const reader = sseStream.getReader();
	const decoder = new TextDecoder();

	emitWire({
		type: "delegation.created",
		item: { type: "delegation", target: "client", id: "del_jp_1", content: [{ type: "input_text", text: "食べるのて形は食べてですか？" }] },
	});

	await twoFramesSent.promise;

	assert.equal(sentFrames.length, 2);
	assert.deepEqual(sentFrames[0], {
		type: "delegation.context.append",
		delegation_item_id: "del_jp_1",
		channel: "commentary",
		content: [{ type: "input_text", text: "Looking at your Japanese notes…" }],
	});
	assert.deepEqual(sentFrames[1], {
		type: "delegation.context.append",
		delegation_item_id: "del_jp_1",
		content: [{ type: "input_text", text: '"Agent Final Message":\n\n「食べて」は正しいです！よくできました。' }],
	});

	abortController.abort();
	let sseText = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		sseText += decoder.decode(value, { stream: true });
	}
	assert(sseText.includes('"type":"ended"'));
	assert.equal(manager.activeLiveId("chat_jp"), undefined);
});

test("extractLiveSessionContext captures plan progress, recent turns, and active prompt without leaking answers", () => {
	const tree: PlanTree = {
		version: 1,
		nodes: [
			{ id: "particles", title: "Particles は vs が", summary: "Topic marker versus grammatical subject." },
			{ id: "te-form", title: "Te-form conjugation", summary: "Linking actions and making polite requests." },
			{ id: "potential", title: "Potential form" },
		],
		edges: [
			{ from: "particles", to: "te-form" },
			{ from: "te-form", to: "potential" },
		],
	};

	const messages: LhMessage[] = [
		{ id: "u1", role: "user", content: "Let's practice Japanese particles and te-form.", timestamp: 1 },
		assistantMessage([
			{ type: "toolCall", id: "send_1", name: "send_to_user", arguments: { message: "Let's start with は vs が." } },
			{
				type: "toolCall",
				id: "quiz_1",
				name: "quiz",
				arguments: {
					nodeId: "particles",
					question: "Which marks the topic?",
					options: [{ label: "は", value: "wa" }, { label: "が", value: "ga" }],
					correctAnswer: "wa",
					explanation: "は marks the topic.",
				},
			},
		], "toolUse"),
		newAnswerResult("quiz_1", "quiz", {
			kind: "quiz",
			questionText: "Which marks the topic?",
			dontKnow: false,
			answers: [{ index: 0, label: "は", value: "wa" }],
			correct: true,
			answeredAt: "2026-11-26T00:00:00.000Z",
		}),
		assistantMessage([
			{ type: "toolCall", id: "send_2", name: "send_to_user", arguments: { message: "Nice! Now let's move to te-form." } },
		], "toolUse"),
		assistantMessage([
			{
				type: "toolCall",
				id: "quiz_2",
				name: "quiz",
				arguments: {
					nodeId: "te-form",
					question: "What is the te-form of 食べる?",
					options: [{ label: "食べて", value: "tabete" }, { label: "食べって", value: "tabette" }],
					correctAnswer: "tabete",
					explanation: "SECRET_EXPLANATION_DO_NOT_LEAK",
				},
			},
		], "toolUse"),
	];

	const snapshot = extractLiveSessionContext({ tree, messages });
	assert.equal(snapshot.hasPendingQuestion, true);
	assert(snapshot.planSummary?.includes("- [visited] Particles は vs が — Topic marker versus grammatical subject."));
	assert(snapshot.planSummary?.includes("- [current] Te-form conjugation — Linking actions and making polite requests."));
	assert(snapshot.planSummary?.includes("- [upcoming] Potential form"));
	assert(snapshot.planSummary?.includes("Particles は vs が -> Te-form conjugation"));
	assert(snapshot.planSummary?.includes("Te-form conjugation -> Potential form"));
	assert(snapshot.recentTurns?.includes("Learner: Let's practice Japanese particles and te-form."));
	assert(snapshot.recentTurns?.includes("Tutor: Let's start with は vs が."));
	assert(snapshot.recentTurns?.includes("Learner: [answered question] は (correct)"));
	assert(snapshot.recentTurns?.includes("Tutor: Nice! Now let's move to te-form."));
	assert(snapshot.activePrompt?.includes("Question: What is the te-form of 食べる?"));
	assert(snapshot.activePrompt?.includes("食べて"));
	assert(!snapshot.activePrompt?.includes("SECRET_EXPLANATION_DO_NOT_LEAK"));
	assert(!snapshot.recentTurns?.includes("SECRET_EXPLANATION_DO_NOT_LEAK"));

	const instructions = buildTutorLiveInstructions({
		sessionTitle: "Japanese N4",
		sessionKind: "teach",
		...snapshot,
	});
	assert(instructions.includes("Lesson plan overview:"));
	assert(instructions.includes("Currently open on screen:"));
	assert(instructions.includes("Recent conversation"));
	assert(!instructions.includes("SECRET_EXPLANATION_DO_NOT_LEAK"));
});

test("extractLiveSessionContext falls back to plan-block markers and includes practice thinking without modelSolution", () => {
	const messages: LhMessage[] = [
		newPlanBlockMessage("plan_1", {
			kind: "full",
			at: "2026-11-26T00:00:00.000Z",
			current: "n1",
			nodes: [
				{ id: "n1", title: "Kanji readings", status: "current" },
				{ id: "n2", title: "Compounds", status: "upcoming" },
			],
			edges: [{ from: "n1", to: "n2" }],
		}),
		assistantMessage([
			{
				type: "toolCall",
				id: "prob_1",
				name: "problem",
				arguments: {
					statement: "Translate: I want to eat ramen.",
					modelSolution: "SECRET_MODEL_SOLUTION",
				},
			},
		], "toolUse"),
		{
			id: "tr_prob_1",
			role: "toolResult",
			toolCallId: "prob_1",
			toolName: "problem",
			content: [{ type: "text", text: "ok" }],
			details: null,
			isError: false,
			timestamp: 2,
		},
		newThinkingMessage("prob_1", "ラーメンを食べたいです？"),
	];

	const snapshot = extractLiveSessionContext({ messages });
	assert(snapshot.planSummary?.includes("- [current] Kanji readings"));
	assert(snapshot.planSummary?.includes("- [upcoming] Compounds"));
	assert(snapshot.planSummary?.includes("Kanji readings -> Compounds"));
	assert(snapshot.recentTurns?.includes("Tutor: Practice problem: Translate: I want to eat ramen."));
	assert(snapshot.recentTurns?.includes("Learner: [thinking] ラーメンを食べたいです？"));
	assert(snapshot.activePrompt?.includes("Active practice problem: Translate: I want to eat ramen."));
	assert(!snapshot.activePrompt?.includes("SECRET_MODEL_SOLUTION"));
	assert(!snapshot.recentTurns?.includes("SECRET_MODEL_SOLUTION"));
	const turnSummary = extractTurnSpokenSummary(messages);
	assert(turnSummary.includes("Practice problem: Translate: I want to eat ramen."));
	assert(!turnSummary.includes("SECRET_MODEL_SOLUTION"));
});

test("resolveSpokenInput submits multi-select quiz picks spoken together", () => {
	const callId = "call_multi_1";
	const rawOptions = [
		{ label: "は", value: "wa" },
		{ label: "が", value: "ga" },
		{ label: "を", value: "wo" },
	];
	const messages: LhMessage[] = [
		assistantMessage([
			{
				type: "toolCall",
				id: callId,
				name: "quiz",
				arguments: {
					type: "check",
					nodeId: "particles",
					question: "Which are subject or topic markers?",
					multiSelect: true,
					options: rawOptions,
					correctAnswer: ["wa", "ga"],
					explanation: "は marks the topic and が marks the subject.",
				},
			},
		], "toolUse"),
	];
	const displayed = questionDisplayOptions(rawOptions, "quiz", true, callId);
	const waIdx = displayed.options.findIndex((opt) => opt.value === "wa");
	const gaIdx = displayed.options.findIndex((opt) => opt.value === "ga");
	const res = resolveSpokenInput(messages, `${waIdx + 1} and ${gaIdx + 1}`);
	assert.equal(res.kind, "answer");
	assert.equal(res.answer.correct, true);
	assert.deepEqual(res.answer.answers.map((a) => a.value).sort(), ["ga", "wa"]);

	const jpRes = resolveSpokenInput(messages, "は、が");
	assert.equal(jpRes.kind, "answer");
	assert.equal(jpRes.answer.correct, true);

	const unmatched = resolveSpokenInput(messages, "は and something else");
	assert.equal(unmatched.kind, "quiz-unmatched");
});

test("createLiveSessionManager seeds Live transport instructions with plan and recent conversation", async () => {
	let capturedInstructions = "";
	const manager = createLiveSessionManager({
		getChat: () => ({
			id: "chat_ctx",
			title: "Japanese Grammar",
			kind: "teach",
			tree: {
				version: 1,
				nodes: [{ id: "n1", title: "Te-form basics" }],
				edges: [],
			},
			messages: [
				{ id: "u1", role: "user", content: "Explain て-form please", timestamp: 1 },
				assistantMessage([{ type: "text", text: "For ichidan verbs, drop る and add て." }]),
			],
		}),
		runChatInput: async () => new Response("", { status: 200 }),
		steerChat: async () => "stale",
		isRunning: () => false,
		getRunningTurn: () => undefined,
		getEndpoint: () => undefined,
		refreshCodex: async () => {},
		isCodexConnected: () => true,
		leaseCodexAuth: async () => ({ accessToken: "tok", accountId: "acct" }),
		watchCodexAbort: () => ({ controller: new AbortController(), release: () => {} }),
		createTransport: (options) => {
			capturedInstructions = options.instructions;
			return {
				sdpAnswer: "v=0\r\n",
				connect: async () => {},
				send: async () => {},
				close: async () => {},
			};
		},
	});

	await manager.start({ chatId: "chat_ctx", sdpOffer: "v=0\r\n" });
	assert(capturedInstructions.includes("Lesson plan overview:"));
	assert(capturedInstructions.includes("Te-form basics"));
	assert(capturedInstructions.includes("Learner: Explain て-form please"));
	assert(capturedInstructions.includes("Tutor: For ichidan verbs, drop る and add て."));
	await manager.stop("chat_ctx");
});

test("sideChatLessonDocument includes lesson plan progress and dependencies when tree is provided without spoiling open quiz", () => {
	const tree: PlanTree = {
		version: 1,
		nodes: [
			{ id: "roles", title: "Particles and grammatical roles" },
			{ id: "verbs", title: "Verb basics and inflection", summary: "Polite, negative, and past endings." },
		],
		edges: [{ from: "roles", to: "verbs" }],
	};
	const messages: LhMessage[] = [
		assistantMessage([
			{ type: "toolCall", id: "send_1", name: "send_to_user", arguments: { message: "Let's check verb endings." } },
			{
				type: "toolCall",
				id: "quiz_open",
				name: "quiz",
				arguments: {
					type: "check",
					nodeId: "verbs",
					question: "Match the verb forms.",
					options: [{ label: "A", value: "a" }, { label: "B", value: "b" }],
					correctAnswer: "a",
					explanation: "SECRET_QUIZ_EXPLANATION",
				},
			},
		], "toolUse"),
	];
	const doc = sideChatLessonDocument(messages, tree);
	assert(doc.includes("### Lesson plan"));
	assert(doc.includes("- [upcoming] Particles and grammatical roles"));
	assert(doc.includes("- [current] Verb basics and inflection — Polite, negative, and past endings."));
	assert(doc.includes("Particles and grammatical roles -> Verb basics and inflection"));
	assert(!doc.includes("SECRET_QUIZ_EXPLANATION"));
});

test("createLiveSessionManager routes non-answer spoken questions during an open quiz to sideChats without disturbing the quiz", async () => {
	let emitWire: (event: LiveWireEvent) => void = () => {};
	const sentFrames: object[] = [];
	const frameSent = Promise.withResolvers<void>();
	const sideCalls: { chatId: string; text: string; anchorId: string }[] = [];
	let mainTurnCalled = false;

	const messages: LhMessage[] = [
		{
			...assistantMessage([
				{ type: "toolCall", id: "send_v", name: "send_to_user", arguments: { message: "Here is a verb quiz." } },
				{
					type: "toolCall",
					id: "quiz_v",
					name: "quiz",
					arguments: {
						type: "check",
						nodeId: "verbs",
						question: "Match each line to its reading.",
						options: [{ label: "doesn't watch / didn't watch", value: "a" }, { label: "didn't watch / doesn't watch", value: "b" }],
						correctAnswer: "a",
						explanation: "SECRET_ANSWER",
					},
				},
			], "toolUse"),
			id: "msg_seg_1",
		},
	];

	const manager = createLiveSessionManager({
		getChat: () => ({
			id: "chat_quiz_side",
			title: "日本語",
			tree: { version: 1, nodes: [{ id: "verbs", title: "Verb basics" }], edges: [] },
			messages,
		}),
		runChatInput: async () => {
			mainTurnCalled = true;
			return new Response("", { status: 200 });
		},
		askSideQuestion: async (chatId, text, anchorId) => {
			sideCalls.push({ chatId, text, anchorId });
			const ndjson = [
				JSON.stringify({ type: "text", text: "We have 15 topics in the plan; you're currently on Verb basics." }),
				JSON.stringify({
					type: "done",
					thread: {
						messages: [{ role: "assistant", text: "We have 15 topics in the plan; you're currently on Verb basics." }],
					},
				}),
			].join("\n") + "\n";
			return new Response(ndjson, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
		},
		steerChat: async () => "stale",
		isRunning: () => false,
		getRunningTurn: () => undefined,
		getEndpoint: () => undefined,
		refreshCodex: async () => {},
		isCodexConnected: () => true,
		leaseCodexAuth: async () => ({ accessToken: "tok", accountId: "acct" }),
		watchCodexAbort: () => ({ controller: new AbortController(), release: () => {} }),
		createTransport: (options) => {
			emitWire = options.onEvent;
			return {
				sdpAnswer: "v=0\r\n",
				connect: async () => {},
				send: async (payload) => {
					sentFrames.push(payload);
					frameSent.resolve();
				},
				close: async () => {},
			};
		},
	});

	await manager.start({ chatId: "chat_quiz_side", sdpOffer: "v=0\r\n" });
	emitWire({
		type: "delegation.created",
		item: { type: "delegation", target: "client", id: "del_side_1", content: [{ type: "input_text", text: "What's in our overall lesson plan?" }] },
	});
	await frameSent.promise;

	assert.equal(mainTurnCalled, false);
	assert.deepEqual(sideCalls, [{ chatId: "chat_quiz_side", text: "What's in our overall lesson plan?", anchorId: "msg_seg_1" }]);
	assert.deepEqual(sentFrames[0], {
		type: "delegation.context.append",
		delegation_item_id: "del_side_1",
		content: [{ type: "input_text", text: '"Agent Final Message":\n\nWe have 15 topics in the plan; you\'re currently on Verb basics.' }],
	});
	await manager.stop("chat_quiz_side");
});

test("createLiveSessionManager includes plan and recent turns in quiz fallback when sideChats is unavailable", async () => {
	let emitWire: (event: LiveWireEvent) => void = () => {};
	const sentFrames: { content?: { text?: string }[] }[] = [];
	const frameSent = Promise.withResolvers<void>();

	const manager = createLiveSessionManager({
		getChat: () => ({
			id: "chat_quiz_fb",
			title: "日本語",
			tree: { version: 1, nodes: [{ id: "verbs", title: "Verb basics" }], edges: [] },
			messages: [
				{ id: "u1", role: "user", content: "Let's study verb negation.", timestamp: 1 },
				assistantMessage([
					{ type: "toolCall", id: "send_v", name: "send_to_user", arguments: { message: "ない marks negation." } },
					{
						type: "toolCall",
						id: "quiz_v",
						name: "quiz",
						arguments: {
							type: "check",
							nodeId: "verbs",
							question: "Match the readings.",
							options: [{ label: "A", value: "a" }, { label: "B", value: "b" }],
							correctAnswer: "a",
							explanation: "SECRET",
						},
					},
				], "toolUse"),
			],
		}),
		runChatInput: async () => new Response("", { status: 200 }),
		steerChat: async () => "stale",
		isRunning: () => false,
		getRunningTurn: () => undefined,
		getEndpoint: () => undefined,
		refreshCodex: async () => {},
		isCodexConnected: () => true,
		leaseCodexAuth: async () => ({ accessToken: "tok", accountId: "acct" }),
		watchCodexAbort: () => ({ controller: new AbortController(), release: () => {} }),
		createTransport: (options) => {
			emitWire = options.onEvent;
			return {
				sdpAnswer: "v=0\r\n",
				connect: async () => {},
				send: async (payload) => {
					sentFrames.push(payload as { content?: { text?: string }[] });
					frameSent.resolve();
				},
				close: async () => {},
			};
		},
	});

	await manager.start({ chatId: "chat_quiz_fb", sdpOffer: "v=0\r\n" });
	emitWire({
		type: "delegation.created",
		item: { type: "delegation", target: "client", id: "del_fb_1", content: [{ type: "input_text", text: "What's in our plan?" }] },
	});
	await frameSent.promise;
	const text = sentFrames[0]?.content?.[0]?.text ?? "";
	assert(text.includes("Lesson plan overview:"));
	assert(text.includes("Verb basics"));
	assert(text.includes("Recent conversation:"));
	assert(text.includes("ない marks negation."));
	assert(!text.includes("SECRET"));
	await manager.stop("chat_quiz_fb");
});

test("createLiveSessionManager injects custom Live Voice instructions from settings", async () => {
	let capturedInstructions = "";
	const manager = createLiveSessionManager({
		getChat: () => ({ id: "chat_custom_prompt", title: "日本語", kind: "teach", messages: [] }),
		runChatInput: async () => new Response("", { status: 200 }),
		getLivePrompt: () => "Mainly used for Japanese learning. Read the plan and mix Japanese and English naturally.",
		steerChat: async () => "stale",
		isRunning: () => false,
		getRunningTurn: () => undefined,
		getEndpoint: () => undefined,
		refreshCodex: async () => {},
		isCodexConnected: () => true,
		leaseCodexAuth: async () => ({ accessToken: "tok", accountId: "acct" }),
		watchCodexAbort: () => ({ controller: new AbortController(), release: () => {} }),
		createTransport: (options) => {
			capturedInstructions = options.instructions;
			return {
				sdpAnswer: "v=0\r\n",
				connect: async () => {},
				send: async () => {},
				close: async () => {},
			};
		},
	});

	await manager.start({ chatId: "chat_custom_prompt", sdpOffer: "v=0\r\n" });
	assert(capturedInstructions.includes("Custom Live Voice instructions from the user"));
	assert(capturedInstructions.includes("Mainly used for Japanese learning. Read the plan and mix Japanese and English naturally."));
	await manager.stop("chat_custom_prompt");
});

test("extractLiveSessionContext keeps opening learner goal when history exceeds recent window", () => {
	const messages: LhMessage[] = [
		{ id: "u0", role: "user", content: "Teach me Japanese grammar from scratch for reading manga.", timestamp: 1 },
	];
	for (let i = 1; i <= 15; i++) {
		messages.push(
			assistantMessage([{ type: "text", text: `Lesson step ${i} explanation.` }]),
			{ id: `u${i}`, role: "user", content: `Follow-up question ${i}.`, timestamp: i + 1 },
		);
	}
	const snapshot = extractLiveSessionContext({ messages });
	assert(snapshot.recentTurns?.includes("Session start ("));
	assert(snapshot.recentTurns?.includes("Teach me Japanese grammar from scratch for reading manga."));
	assert(snapshot.recentTurns?.includes("Follow-up question 15."));
});

test("createLiveSessionManager surfaces side-chat provider errors in quiz fallback context", async () => {
	let emitWire: (event: LiveWireEvent) => void = () => {};
	const sentFrames: { content?: { text?: string }[] }[] = [];
	const frameSent = Promise.withResolvers<void>();

	const messages: LhMessage[] = [
		{
			...assistantMessage([
				{ type: "toolCall", id: "send_e", name: "send_to_user", arguments: { message: "Check verb past negative." } },
				{
					type: "toolCall",
					id: "quiz_e",
					name: "quiz",
					arguments: {
						type: "check",
						nodeId: "verbs",
						question: "Pick the reading.",
						options: [{ label: "A", value: "a" }, { label: "B", value: "b" }],
						correctAnswer: "a",
						explanation: "SECRET_EXPLANATION",
					},
				},
			], "toolUse"),
			id: "msg_err_seg",
		},
	];

	const manager = createLiveSessionManager({
		getChat: () => ({ id: "chat_side_err", title: "日本語", messages }),
		runChatInput: async () => new Response("", { status: 200 }),
		askSideQuestion: async () => {
			const ndjson = JSON.stringify({
				type: "done",
				thread: {
					messages: [{ role: "assistant", text: "", error: "Claude usage limit reached." }],
				},
			}) + "\n";
			return new Response(ndjson, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
		},
		steerChat: async () => "stale",
		isRunning: () => false,
		getRunningTurn: () => undefined,
		getEndpoint: () => undefined,
		refreshCodex: async () => {},
		isCodexConnected: () => true,
		leaseCodexAuth: async () => ({ accessToken: "tok", accountId: "acct" }),
		watchCodexAbort: () => ({ controller: new AbortController(), release: () => {} }),
		createTransport: (options) => {
			emitWire = options.onEvent;
			return {
				sdpAnswer: "v=0\r\n",
				connect: async () => {},
				send: async (payload) => {
					sentFrames.push(payload as { content?: { text?: string }[] });
					frameSent.resolve();
				},
				close: async () => {},
			};
		},
	});

	await manager.start({ chatId: "chat_side_err", sdpOffer: "v=0\r\n" });
	emitWire({
		type: "delegation.created",
		item: { type: "delegation", target: "client", id: "del_err_1", content: [{ type: "input_text", text: "How far back can you see?" }] },
	});
	await frameSent.promise;
	const text = sentFrames[0]?.content?.[0]?.text ?? "";
	assert(text.includes("Claude usage limit reached."));
	assert(!text.includes("SECRET_EXPLANATION"));
	await manager.stop("chat_side_err");
});

test("upsertLiveTranscript updates active turn in place and caps history length", () => {
	let history: LiveTranscriptEntry[] = [];
	history = upsertLiveTranscript(history, { role: "user", turn: 1, text: "食べ", final: false });
	history = upsertLiveTranscript(history, { role: "user", turn: 1, text: "食べなかった", final: true });
	history = upsertLiveTranscript(history, { role: "assistant", turn: 1, text: "That means didn't eat.", final: true });
	assert.equal(history.length, 2);
	assert.deepEqual(history[0], { role: "user", turn: 1, text: "食べなかった", final: true });
	assert.deepEqual(history[1], { role: "assistant", turn: 1, text: "That means didn't eat.", final: true });

	let capped: LiveTranscriptEntry[] = [];
	for (let i = 1; i <= 5; i++) {
		capped = upsertLiveTranscript(capped, { role: "user", turn: i, text: `Turn ${i}`, final: true }, 3);
	}
	assert.deepEqual(capped.map((entry) => entry.turn), [3, 4, 5]);
});

test("createLiveSessionManager accumulates transcript history and replays all turns on subscribe", async () => {
	let emitWire: (event: LiveWireEvent) => void = () => {};
	const manager = createLiveSessionManager({
		getChat: () => ({ id: "chat_tr_hist", title: "日本語", messages: [] }),
		runChatInput: async () => new Response("", { status: 200 }),
		steerChat: async () => "stale",
		isRunning: () => false,
		getRunningTurn: () => undefined,
		getEndpoint: () => undefined,
		refreshCodex: async () => {},
		isCodexConnected: () => true,
		leaseCodexAuth: async () => ({ accessToken: "tok", accountId: "acct" }),
		watchCodexAbort: () => ({ controller: new AbortController(), release: () => {} }),
		createTransport: (options) => {
			emitWire = options.onEvent;
			return {
				sdpAnswer: "v=0\r\n",
				connect: async () => {},
				send: async () => {},
				close: async () => {},
			};
		},
	});

	const started = await manager.start({ chatId: "chat_tr_hist", sdpOffer: "v=0\r\n" });
	emitWire({ type: "input_transcript.added", item: { text: "すみま" } });
	emitWire({ type: "input_transcript.added", item: { text: "せん" } });
	emitWire({ type: "turn.done", turn: { role: "user", transcript: "すみません" } });
	emitWire({ type: "output_transcript.added", item: { text: "はい、" } });
	emitWire({ type: "turn.done", turn: { role: "assistant", transcript: "はい、どうぞ！" } });

	const stream = manager.subscribe("chat_tr_hist", started.liveId);
	assert(stream);
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let raw = "";
	const events: LiveClientEvent[] = [];
	while (events.length < 3) {
		const { value, done } = await reader.read();
		if (done) break;
		raw += decoder.decode(value, { stream: true });
		let idx = raw.indexOf("\n\n");
		while (idx !== -1) {
			const frame = raw.slice(0, idx);
			raw = raw.slice(idx + 2);
			const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
			if (dataLine) events.push(JSON.parse(dataLine.slice(6)) as LiveClientEvent);
			idx = raw.indexOf("\n\n");
		}
	}
	await reader.cancel();
	const replayed = events.filter((e): e is Extract<LiveClientEvent, { type: "transcript" }> => e.type === "transcript").map((e) => e.entry);
	assert.deepEqual(replayed, [
		{ role: "user", turn: 1, text: "すみません", final: true },
		{ role: "assistant", turn: 1, text: "はい、どうぞ！", final: true },
	]);
	await manager.stop("chat_tr_hist");
});
