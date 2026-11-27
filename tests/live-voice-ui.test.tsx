import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveCaptionStrip, formatLiveTranscriptText, type LiveVoiceController } from "../components/live-voice.tsx";

function mockLive(overrides: Partial<LiveVoiceController> = {}): LiveVoiceController {
	return {
		available: true,
		phase: "listening",
		active: true,
		muted: false,
		voice: "sol",
		transcript: null,
		transcriptHistory: [],
		error: null,
		setVoice: () => {},
		start: async () => {},
		stop: async () => {},
		toggleMute: () => {},
		clearError: () => {},
		clearTranscript: () => {},
		...overrides,
	};
}

test("LiveCaptionStrip renders scrollable voice transcript history during and after a call", () => {
	const history = [
		{ role: "user" as const, turn: 1, text: "食べなかったはどういう意味？", final: true },
		{ role: "assistant" as const, turn: 1, text: "It means didn't eat — negative plus past.", final: false },
	];
	const activeHtml = renderToStaticMarkup(
		<LiveCaptionStrip live={mockLive({ active: true, transcript: history[1]!, transcriptHistory: history })} />,
	);
	assert.ok(activeHtml.includes('data-testid="live-transcript-list"'));
	assert.ok(activeHtml.includes('data-testid="live-transcript-entry-user-1"'));
	assert.ok(activeHtml.includes('data-testid="live-transcript-entry-assistant-1"'));
	assert.ok(activeHtml.includes("食べなかったはどういう意味？"));
	assert.ok(activeHtml.includes("It means didn&#x27;t eat — negative plus past."));
	assert.ok(activeHtml.includes('data-testid="live-transcript-copy"'));
	assert.ok(activeHtml.includes('data-testid="live-transcript-toggle"'));
	assert.ok(!activeHtml.includes('data-testid="live-transcript-dismiss"'));

	const endedHtml = renderToStaticMarkup(
		<LiveCaptionStrip live={mockLive({ active: false, phase: "idle", transcript: history[1]!, transcriptHistory: history })} />,
	);
	assert.ok(endedHtml.includes("Voice transcript (2 turns)"));
	assert.ok(endedHtml.includes('data-testid="live-transcript-dismiss"'));
	assert.equal(
		formatLiveTranscriptText(history),
		"You: 食べなかったはどういう意味？\n\nTutor: It means didn't eat — negative plus past.",
	);
});
