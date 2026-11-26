import assert from "node:assert/strict";
import test from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";
import { questionDisplayOptions } from "../src/core/question-core.ts";
import {
	CODEX_LIVE_SIGNALING_URL,
	DELEGATION_CHUNK_MAX_BYTES,
	buildCodexSidebandUrl,
	buildFallbackAttestation,
	chunkUtf8,
	extractAccountIdFromJwt,
	extractCallIdFromLocation,
	parseLiveWireEvent,
	type LiveWireEvent,
} from "../src/server/live/protocol.ts";
import {
	extractAssistantCommentary,
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
