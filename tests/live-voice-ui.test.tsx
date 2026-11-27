import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { LiveCaptionStrip, LiveVoiceBar, formatLiveTranscriptText, type LiveVoiceController } from "../components/live-voice.tsx";
import { StatsBar } from "../components/stats-bar.tsx";
function mockLive(overrides: Partial<LiveVoiceController> = {}): LiveVoiceController {
	return {
		available: true,
		phase: "listening",
		active: true,
		paused: false,
		muted: false,
		voice: "sol",
		transcript: null,
		transcriptHistory: [],
		error: null,
		setVoice: () => {},
		start: async () => {},
		stop: async () => {},
		togglePause: async () => {},
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

test("LiveVoiceBar and LiveCaptionStrip render Pause/Resume states and Resume idle label when transcript persists", () => {
	const history = [
		{ role: "user" as const, turn: 1, text: "Let's practice ordering ramen.", final: true },
		{ role: "assistant" as const, turn: 1, text: "Sure! Say ラーメンをください.", final: true },
	];

	const idleFreshHtml = renderToStaticMarkup(
		<InteractionLayersProvider>
			<LiveVoiceBar live={mockLive({ active: false, phase: "idle" })} />
		</InteractionLayersProvider>,
	);
	assert.ok(idleFreshHtml.includes('aria-label="Start live voice"'));
	assert.ok(idleFreshHtml.includes(">Live<"));

	const idleResumeHtml = renderToStaticMarkup(
		<InteractionLayersProvider>
			<LiveVoiceBar live={mockLive({ active: false, phase: "idle", transcriptHistory: history })} />
		</InteractionLayersProvider>,
	);
	assert.ok(idleResumeHtml.includes('aria-label="Resume live voice"'));
	assert.ok(idleResumeHtml.includes(">Resume<"));

	const activeListeningHtml = renderToStaticMarkup(
		<InteractionLayersProvider>
			<LiveVoiceBar live={mockLive({ active: true, phase: "listening", paused: false })} />
		</InteractionLayersProvider>,
	);
	assert.ok(activeListeningHtml.includes('data-testid="live-voice-pause"'));
	assert.ok(activeListeningHtml.includes('aria-label="Pause live voice"'));
	assert.ok(activeListeningHtml.includes(">Pause<"));

	const activePausedHtml = renderToStaticMarkup(
		<InteractionLayersProvider>
			<LiveVoiceBar live={mockLive({ active: true, phase: "paused", paused: true })} />
		</InteractionLayersProvider>,
	);
	assert.ok(activePausedHtml.includes(">Paused<"));
	assert.ok(activePausedHtml.includes('aria-label="Resume live voice"'));
	assert.ok(activePausedHtml.includes(">Resume<"));

	const pausedStripEmptyHtml = renderToStaticMarkup(
		<LiveCaptionStrip live={mockLive({ active: true, phase: "paused", paused: true })} />,
	);
	assert.ok(pausedStripEmptyHtml.includes("Live voice paused — click Resume to continue."));

	const pausedStripHistoryHtml = renderToStaticMarkup(
		<LiveCaptionStrip live={mockLive({ active: true, phase: "paused", paused: true, transcriptHistory: history, transcript: history[1]! })} />,
	);
	assert.ok(pausedStripHistoryHtml.includes("Live transcript (2) · Paused"));
});

test("LiveVoiceBar uses container-scoped overflow-hidden layout so controls never wrap or bleed into StatsBar neighbors", () => {
	const html = renderToStaticMarkup(
		<InteractionLayersProvider>
			<LiveVoiceBar live={mockLive({ active: true, phase: "listening", voice: "sol" })} />
		</InteractionLayersProvider>,
	);
	const barTag = html.match(/<div[^>]*data-testid="live-voice-bar"[^>]*>/)?.[0] ?? "";
	assert.ok(barTag.includes("@container"), "expected @container on live-voice-bar");
	assert.ok(barTag.includes("overflow-hidden"), "expected overflow-hidden on live-voice-bar");
	assert.ok(barTag.includes("justify-between"), "expected justify-between on live-voice-bar");
	assert.ok(!barTag.includes("justify-center"), "justify-center overflows symmetrically when narrow");
	assert.ok(html.includes("whitespace-nowrap"));
	assert.ok(html.includes("@[250px]:inline"));
	assert.ok(html.includes("@[168px]:inline"));
	assert.ok(html.includes("@[322px]:inline"));

	const statsHtml = renderToStaticMarkup(
		<InteractionLayersProvider>
			<StatsBar
				turns={[]}
				chatId="chat_narrow"
				dictationSlot={<LiveVoiceBar live={mockLive({ active: true, phase: "listening", voice: "sol" })} />}
			/>
		</InteractionLayersProvider>,
	);
	const statsTag = statsHtml.match(/<div[^>]*data-testid="stats-bar"[^>]*>/)?.[0] ?? "";
	assert.ok(statsTag.includes("flex-wrap"), "StatsBar must wrap on narrow viewports so End never clips");
	assert.ok(statsHtml.includes("min-w-[7.5rem]"), "StatsBar dictationSlot must reserve minimum usable width before wrapping");
});
