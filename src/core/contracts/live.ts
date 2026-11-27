/**
 * Browser-safe contracts for Codex-backed realtime voice mode (`gpt-live-1-codex`).
 */

export const LIVE_MODEL = "gpt-live-1-codex";

export const LIVE_VOICES = [
	{ value: "arbor", label: "Arbor" },
	{ value: "breeze", label: "Breeze" },
	{ value: "cove", label: "Cove" },
	{ value: "ember", label: "Ember" },
	{ value: "juniper", label: "Juniper" },
	{ value: "maple", label: "Maple" },
	{ value: "sol", label: "Sol" },
	{ value: "spruce", label: "Spruce" },
	{ value: "vale", label: "Vale" },
] as const;

export type LiveVoiceId = (typeof LIVE_VOICES)[number]["value"];

export const DEFAULT_LIVE_VOICE: LiveVoiceId = "sol";

export function isLiveVoice(value: unknown): value is LiveVoiceId {
	return typeof value === "string" && LIVE_VOICES.some((voice) => voice.value === value);
}

export type LivePhase = "idle" | "connecting" | "listening" | "working" | "speaking" | "muted" | "error";

export interface LiveTranscriptEntry {
	role: "user" | "assistant";
	turn: number;
	text: string;
	final: boolean;
}

export const MAX_LIVE_TRANSCRIPT_ENTRIES = 200;

/** Upsert one spoken transcript entry keyed by `(role, turn)` so streaming
 *  deltas update the active bubble in place instead of duplicating rows. */
export function upsertLiveTranscript(
	history: readonly LiveTranscriptEntry[],
	entry: LiveTranscriptEntry,
	maxEntries: number = MAX_LIVE_TRANSCRIPT_ENTRIES,
): LiveTranscriptEntry[] {
	const idx = history.findIndex((item) => item.role === entry.role && item.turn === entry.turn);
	if (idx >= 0) {
		const existing = history[idx]!;
		if (existing.text === entry.text && existing.final === entry.final) {
			return [...history];
		}
		const next = [...history];
		next[idx] = entry;
		return next;
	}
	const next = [...history, entry];
	return next.length > maxEntries ? next.slice(next.length - maxEntries) : next;
}
export interface LiveAvailability {
	available: boolean;
	mode: "codex" | "endpoint";
	reason?: "not_connected";
	voices: readonly { value: LiveVoiceId; label: string }[];
	defaultVoice: LiveVoiceId;
}

export type LiveClientEvent =
	| { type: "phase"; phase: LivePhase }
	| { type: "transcript"; entry: LiveTranscriptEntry }
	| { type: "delegated"; text: string }
	| { type: "error"; message: string }
	| { type: "ended"; error?: string };
