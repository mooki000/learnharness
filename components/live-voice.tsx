"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLinesIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon, Loader2Icon, MicIcon, MicOffIcon, PauseIcon, PlayIcon, SquareIcon, XIcon } from "lucide-react";
import {
	DEFAULT_LIVE_VOICE,
	LIVE_VOICES,
	isLiveVoice,
	sanitizeLiveTranscript,
	upsertLiveTranscript,
	type LiveAvailability,
	type LiveClientEvent,
	type LivePhase,
	type LiveTranscriptEntry,
	type LiveVoiceId,
} from "@/src/core";
import { Hint } from "@/components/ui/hint";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { INTERACTION_LAYER_Z_BASE } from "@/components/host-dialog";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { useServerEvent } from "@/components/server-events";

const VOICE_STORAGE_KEY = "lh-live-voice";
const ICE_GATHER_TIMEOUT_MS = 2_000;
const OUTPUT_ACTIVE_THRESHOLD = 0.015;
const OUTPUT_HOLD_MS = 400;

export const LIVE_VOICE_NOT_CONNECTED = "Live voice needs OpenAI Codex";

export interface LiveVoiceController {
	available: boolean;
	phase: LivePhase;
	active: boolean;
	paused: boolean;
	muted: boolean;
	voice: LiveVoiceId;
	transcript: LiveTranscriptEntry | null;
	transcriptHistory: readonly LiveTranscriptEntry[];
	error: string | null;
	setVoice: (voice: LiveVoiceId) => void;
	start: () => Promise<void>;
	stop: () => Promise<void>;
	togglePause: () => Promise<void>;
	toggleMute: () => void;
	clearError: () => void;
	clearTranscript: () => void;
}

function readStoredVoice(): LiveVoiceId {
	if (typeof window === "undefined") return DEFAULT_LIVE_VOICE;
	try {
		const saved = window.localStorage.getItem(VOICE_STORAGE_KEY);
		return isLiveVoice(saved) ? saved : DEFAULT_LIVE_VOICE;
	} catch {
		return DEFAULT_LIVE_VOICE;
	}
}

function writeStoredVoice(voice: LiveVoiceId): void {
	try {
		window.localStorage.setItem(VOICE_STORAGE_KEY, voice);
	} catch { /* ignore storage restrictions */ }
}

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number = ICE_GATHER_TIMEOUT_MS): Promise<void> {
	if (pc.iceGatheringState === "complete") return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	let done = false;
	const finish = () => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		pc.removeEventListener("icegatheringstatechange", onState);
		resolve();
	};
	const onState = () => {
		if (pc.iceGatheringState === "complete") finish();
	};
	const timer = setTimeout(finish, timeoutMs);
	pc.addEventListener("icegatheringstatechange", onState);
	return promise;
}

async function acquireMicrophone(): Promise<MediaStream> {
	try {
		return await navigator.mediaDevices.getUserMedia({
			audio: {
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
			},
		});
	} catch (err) {
		const name = err instanceof Error ? err.name : "";
		if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
			return navigator.mediaDevices.getUserMedia({ audio: true });
		}
		throw err;
	}
}

function formatLiveStartError(err: unknown): string {
	const name = err instanceof Error ? err.name : "";
	if (name === "NotAllowedError" || name === "SecurityError") return "Microphone permission denied.";
	if (name === "NotFoundError" || name === "DevicesNotFoundError") return "No microphone found.";
	if (name === "NotReadableError" || name === "TrackStartError") return "Microphone is busy or unavailable.";
	if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") return "Microphone settings unsupported.";
	const msg = err instanceof Error ? err.message : "Could not start Live voice.";
	if (/permission|notallowed/i.test(msg)) return "Microphone permission denied.";
	if (/requested device not found/i.test(msg)) return "No microphone found.";
	return msg;
}
export function useLiveVoice({
	chatId,
	onBeforeStart,
}: {
	chatId: string;
	onBeforeStart?: () => void;
}): LiveVoiceController {
	const [available, setAvailable] = useState(false);
	const [serverPhase, setServerPhase] = useState<LivePhase>("idle");
	const [speaking, setSpeaking] = useState(false);
	const [paused, setPaused] = useState(false);
	const [muted, setMuted] = useState(false);
	const [voice, setVoiceState] = useState<LiveVoiceId>(DEFAULT_LIVE_VOICE);
	const [historyState, setHistoryState] = useState<{ chatId: string; entries: LiveTranscriptEntry[] }>(() => ({
		chatId,
		entries: [],
	}));
	const [error, setError] = useState<string | null>(null);
	const pcRef = useRef<RTCPeerConnection | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const audioCtxRef = useRef<AudioContext | null>(null);
	const levelTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
	const speakHoldRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const eventSourceRef = useRef<EventSource | null>(null);
	const liveIdRef = useRef<string | null>(null);
	const pausedRef = useRef(false);
	const mutedRef = useRef(false);
	const transcriptGenRef = useRef(0);
	const generationRef = useRef(0);
	const startingRef = useRef(false);

	useEffect(() => {
		setVoiceState(readStoredVoice());
	}, []);

	useEffect(() => {
		let cancelled = false;
		const gen = ++transcriptGenRef.current;
		void (async () => {
			try {
				const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/live`, { cache: "no-store" });
				if (!res.ok || cancelled || transcriptGenRef.current !== gen) return;
				const data = (await res.json()) as { transcript?: unknown };
				if (cancelled || transcriptGenRef.current !== gen) return;
				const persisted = sanitizeLiveTranscript(data.transcript, { markFinal: true });
				setHistoryState((prev) => {
					if (prev.chatId === chatId && prev.entries.length > 0) {
						let merged = persisted;
						for (const item of prev.entries) {
							merged = upsertLiveTranscript(merged, item);
						}
						return { chatId, entries: merged };
					}
					return { chatId, entries: persisted };
				});
			} catch { /* ignore transient hydration failure */ }
		})();
		return () => { cancelled = true; };
	}, [chatId]);

	const refreshAvailability = useCallback(async () => {
		try {
			const res = await fetch("/api/live/status", { cache: "no-store" });
			if (!res.ok) return;
			const data = (await res.json()) as LiveAvailability;
			setAvailable(data.available === true);
		} catch { /* keep previous availability */ }
	}, []);

	useEffect(() => {
		void refreshAvailability();
	}, [refreshAvailability]);

	useServerEvent("subscriptions-changed", () => {
		void refreshAvailability();
	});

	const setVoice = useCallback((next: LiveVoiceId) => {
		setVoiceState(next);
		writeStoredVoice(next);
	}, []);

	const teardownLocal = useCallback(() => {
		clearInterval(levelTimerRef.current);
		levelTimerRef.current = undefined;
		clearTimeout(speakHoldRef.current);
		speakHoldRef.current = undefined;
		setSpeaking(false);

		const es = eventSourceRef.current;
		eventSourceRef.current = null;
		es?.close();

		const pc = pcRef.current;
		pcRef.current = null;
		if (pc) {
			pc.ontrack = null;
			pc.onconnectionstatechange = null;
			try { pc.close(); } catch { /* ignore */ }
		}

		const mic = streamRef.current;
		streamRef.current = null;
		if (mic) {
			for (const track of mic.getTracks()) {
				try { track.stop(); } catch { /* ignore */ }
			}
		}

		const audio = audioRef.current;
		audioRef.current = null;
		if (audio) {
			try { audio.pause(); audio.srcObject = null; } catch { /* ignore */ }
		}

		const ctx = audioCtxRef.current;
		audioCtxRef.current = null;
		if (ctx) {
			void ctx.close().catch(() => {});
		}
	}, []);

	const stop = useCallback(async () => {
		generationRef.current += 1;
		startingRef.current = false;
		pausedRef.current = false;
		mutedRef.current = false;
		const activeId = liveIdRef.current;
		liveIdRef.current = null;
		teardownLocal();
		setServerPhase("idle");
		setPaused(false);
		setMuted(false);
		if (activeId) {
			try {
				await fetch(`/api/chats/${encodeURIComponent(chatId)}/live?liveId=${encodeURIComponent(activeId)}`, {
					method: "DELETE",
					keepalive: true,
				});
			} catch { /* best-effort remote close */ }
		}
	}, [chatId, teardownLocal]);

	// Clean up on chat change, unmount, or page unload.
	useEffect(() => {
		const onUnload = () => {
			const activeId = liveIdRef.current;
			if (!activeId) return;
			void fetch(`/api/chats/${encodeURIComponent(chatId)}/live?liveId=${encodeURIComponent(activeId)}`, {
				method: "DELETE",
				keepalive: true,
			});
		};
		window.addEventListener("beforeunload", onUnload);
		return () => {
			window.removeEventListener("beforeunload", onUnload);
			void stop();
		};
	}, [chatId, stop]);

	const monitorRemoteAudio = useCallback((remoteStream: MediaStream) => {
		try {
			const ctx = new AudioContext();
			audioCtxRef.current = ctx;
			const source = ctx.createMediaStreamSource(remoteStream);
			const analyser = ctx.createAnalyser();
			analyser.fftSize = 256;
			source.connect(analyser);
			const buffer = new Float32Array(analyser.fftSize);
			levelTimerRef.current = setInterval(() => {
				analyser.getFloatTimeDomainData(buffer);
				let sum = 0;
				for (let i = 0; i < buffer.length; i++) sum += buffer[i]! * buffer[i]!;
				const rms = Math.sqrt(sum / buffer.length);
				if (!pausedRef.current && rms > OUTPUT_ACTIVE_THRESHOLD) {
					setSpeaking(true);
					clearTimeout(speakHoldRef.current);
					speakHoldRef.current = setTimeout(() => setSpeaking(false), OUTPUT_HOLD_MS);
				}
			}, 100);
		} catch { /* audio metering is optional */ }
	}, []);

	const start = useCallback(async () => {
		if (startingRef.current || pcRef.current) return;
		if (typeof window === "undefined" || typeof RTCPeerConnection === "undefined" || !navigator.mediaDevices?.getUserMedia) {
			setError("Live voice requires browser microphone and WebRTC support.");
			return;
		}
		onBeforeStart?.();
		startingRef.current = true;
		const gen = ++generationRef.current;
		pausedRef.current = false;
		mutedRef.current = false;
		setError(null);
		setHistoryState((prev) => (prev.chatId === chatId ? prev : { chatId, entries: [] }));
		setPaused(false);
		setMuted(false);
		setServerPhase("connecting");
		try {
			const micStream = await acquireMicrophone();
			if (generationRef.current !== gen) {
				for (const track of micStream.getTracks()) track.stop();
				return;
			}
			streamRef.current = micStream;

			const pc = new RTCPeerConnection();
			pcRef.current = pc;
			for (const track of micStream.getAudioTracks()) {
				pc.addTrack(track, micStream);
			}
			pc.createDataChannel("oai-events");

			const audio = new Audio();
			audio.autoplay = true;
			audioRef.current = audio;

			pc.ontrack = (event) => {
				if (generationRef.current !== gen) return;
				const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
				audio.srcObject = remoteStream;
				audio.muted = pausedRef.current;
				if (!pausedRef.current) {
					void audio.play().catch(() => {});
				}
				monitorRemoteAudio(remoteStream);
			};
			pc.onconnectionstatechange = () => {
				if (generationRef.current !== gen) return;
				if (pc.connectionState === "failed") {
					setError("Live voice connection dropped.");
					void stop();
				}
			};

			const offer = await pc.createOffer();
			await pc.setLocalDescription(offer);
			await waitForIceGathering(pc);
			if (generationRef.current !== gen) return;

			const sdpOffer = pc.localDescription?.sdp ?? offer.sdp ?? "";
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/live`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sdpOffer, voice }),
			});
			if (generationRef.current !== gen) return;

			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
				if (res.status === 503 && body.code === "not_connected") {
					setAvailable(false);
					setError(LIVE_VOICE_NOT_CONNECTED);
				} else {
					setError(body.error || `Live voice failed (${res.status}).`);
				}
				teardownLocal();
				setServerPhase("idle");
				startingRef.current = false;
				return;
			}

			const { liveId, sdpAnswer } = (await res.json()) as { liveId: string; sdpAnswer: string };
			if (generationRef.current !== gen) {
				void fetch(`/api/chats/${encodeURIComponent(chatId)}/live?liveId=${encodeURIComponent(liveId)}`, { method: "DELETE", keepalive: true });
				return;
			}
			liveIdRef.current = liveId;
			setAvailable(true);

			await pc.setRemoteDescription({ type: "answer", sdp: sdpAnswer });
			if (generationRef.current !== gen) return;

			const es = new EventSource(`/api/chats/${encodeURIComponent(chatId)}/live?liveId=${encodeURIComponent(liveId)}`);
			eventSourceRef.current = es;
			es.onmessage = (msg) => {
				if (generationRef.current !== gen) return;
				try {
					const event = JSON.parse(msg.data) as LiveClientEvent;
					if (event.type === "phase") {
						setServerPhase(event.phase);
					} else if (event.type === "transcript") {
						setHistoryState((prev) => ({
							chatId,
							entries: upsertLiveTranscript(prev.chatId === chatId ? prev.entries : [], event.entry),
						}));
					} else if (event.type === "error") {
						setError(event.message);
					} else if (event.type === "ended") {
						if (event.error) setError(event.error);
						liveIdRef.current = null;
						pausedRef.current = false;
						mutedRef.current = false;
						teardownLocal();
						setServerPhase("idle");
						setPaused(false);
						setMuted(false);
					}
				} catch { /* ignore malformed frame */ }
			};
			es.onerror = () => {
				if (generationRef.current !== gen) return;
				if (es.readyState === EventSource.CLOSED) {
					void stop();
				}
			};
			setServerPhase("listening");
			startingRef.current = false;
		} catch (err) {
			if (generationRef.current !== gen) return;
			setError(formatLiveStartError(err));
			teardownLocal();
			setServerPhase("idle");
			startingRef.current = false;
		}
	}, [chatId, monitorRemoteAudio, onBeforeStart, stop, teardownLocal, voice]);

	const togglePause = useCallback(async () => {
		if (startingRef.current) return;
		const nextPaused = !pausedRef.current;
		const activeId = liveIdRef.current;
		if (nextPaused) {
			if (!activeId) return;
			pausedRef.current = true;
			setPaused(true);
			setSpeaking(false);
			setServerPhase("paused");
			for (const track of streamRef.current?.getAudioTracks() ?? []) {
				track.enabled = false;
			}
			if (audioRef.current) {
				audioRef.current.muted = true;
				try { audioRef.current.pause(); } catch { /* ignore */ }
			}
			try {
				await fetch(`/api/chats/${encodeURIComponent(chatId)}/live`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ liveId: activeId, paused: true }),
				});
			} catch { /* best-effort remote pause; local mic/audio stay paused */ }
			return;
		}

		const pc = pcRef.current;
		const canResumeLive = Boolean(activeId && pc && pc.connectionState !== "failed" && pc.connectionState !== "closed");
		if (canResumeLive && activeId) {
			try {
				const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/live`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ liveId: activeId, paused: false }),
				});
				if (res.ok) {
					pausedRef.current = false;
					setPaused(false);
					for (const track of streamRef.current?.getAudioTracks() ?? []) {
						track.enabled = !mutedRef.current;
					}
					if (audioRef.current) {
						audioRef.current.muted = false;
						void audioRef.current.play().catch(() => {});
					}
					setServerPhase("listening");
					return;
				}
			} catch { /* fall through to reconnect */ }
		}

		await stop();
		await start();
	}, [chatId, start, stop]);

	const toggleMute = useCallback(() => {
		const stream = streamRef.current;
		if (!stream) return;
		setMuted((prev) => {
			const next = !prev;
			mutedRef.current = next;
			for (const track of stream.getAudioTracks()) {
				track.enabled = !next && !pausedRef.current;
			}
			return next;
		});
	}, []);

	const clearError = useCallback(() => setError(null), []);
	const clearTranscript = useCallback(() => {
		transcriptGenRef.current += 1;
		setHistoryState({ chatId, entries: [] });
		void fetch(`/api/chats/${encodeURIComponent(chatId)}/live?clearTranscript=1`, {
			method: "DELETE",
		}).catch(() => {});
	}, [chatId]);

	const transcriptHistory = historyState.chatId === chatId ? historyState.entries : [];
	const transcript = transcriptHistory.at(-1) ?? null;

	const active = serverPhase !== "idle";
	const effectivePhase: LivePhase = !active
		? "idle"
		: serverPhase === "connecting"
			? "connecting"
			: paused || serverPhase === "paused"
				? "paused"
				: muted
					? "muted"
					: serverPhase === "working"
						? "working"
						: speaking
							? "speaking"
							: serverPhase;

	return {
		available,
		phase: effectivePhase,
		active,
		paused,
		muted,
		voice,
		transcript,
		transcriptHistory,
		error,
		setVoice,
		start,
		stop,
		togglePause,
		toggleMute,
		clearError,
		clearTranscript,
	};
}

function phaseLabel(phase: LivePhase): string {
	switch (phase) {
		case "connecting": return "Connecting…";
		case "paused": return "Paused";
		case "working": return "Thinking…";
		case "speaking": return "Speaking";
		case "muted": return "Muted";
		case "listening": return "Listening";
		case "error": return "Error";
		default: return "Live";
	}
}

export function LiveVoiceBar({ live, disabled = false }: { live: LiveVoiceController; disabled?: boolean }) {
	const { phase, active, paused, muted, voice, transcriptHistory, error, setVoice, start, stop, togglePause, toggleMute, clearError } = live;
	const { open: openSettings } = useSettingsDialog();
	const [menuOpen, setMenuOpen] = useState(false);
	const anchorRef = useRef<HTMLDivElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const popupLayer = usePopoverDismiss(anchorRef, menuOpen && !active, () => setMenuOpen(false), { layerRootRef: panelRef });
	const needsCodex = error === LIVE_VOICE_NOT_CONNECTED;
	const voiceLabel = LIVE_VOICES.find((v) => v.value === voice)?.label ?? voice;
	const hasHistory = transcriptHistory.length > 0;

	if (!active) {
		const idleHint = error ?? (hasHistory ? `Resume Live Voice (${voiceLabel}) — continues transcript` : `Start Live Voice (${voiceLabel})`);
		return (
			<div ref={anchorRef} className="relative flex shrink-0 items-center" data-testid="live-voice-idle">
				<Hint label={idleHint} side="top">
					<button
						type="button"
						disabled={disabled}
						onClick={() => {
							if (needsCodex) {
								clearError();
								openSettings("keys");
							} else {
								void start();
							}
						}}
						aria-label={error ? `Live voice unavailable: ${error}` : hasHistory ? "Resume live voice" : "Start live voice"}
						data-testid="live-voice-toggle"
						className="flex h-7 items-center justify-center gap-1.5 rounded-l-md border border-border/50 bg-card/50 px-2.5 text-xs text-muted-foreground/70 shadow-lg backdrop-blur transition-colors hover:border-border hover:text-muted-foreground disabled:opacity-50"
					>
						<AudioLinesIcon className="size-3.5 shrink-0" />
						<span className="max-w-[11rem] truncate">{error ?? (hasHistory ? "Resume" : "Live")}</span>
					</button>
				</Hint>
				<Hint label={`Voice: ${voiceLabel}`} side="top">
					<button
						type="button"
						disabled={disabled}
						aria-label={`Choose live voice (${voiceLabel})`}
						aria-expanded={menuOpen}
						data-testid="live-voice-picker"
						onClick={() => setMenuOpen((o) => !o)}
						className="flex h-7 items-center justify-center rounded-r-md border border-l-0 border-border/50 bg-card/50 px-1.5 text-xs text-muted-foreground/70 shadow-lg backdrop-blur transition-colors hover:border-border hover:text-muted-foreground disabled:opacity-50"
					>
						<ChevronDownIcon className="size-3" />
					</button>
				</Hint>
				{menuOpen && (
					<div
						ref={panelRef}
						data-testid="live-voice-menu"
						style={{ zIndex: INTERACTION_LAYER_Z_BASE + popupLayer.order }}
						className="absolute bottom-full right-0 mb-1.5 w-36 rounded-xl border bg-card p-1 text-xs shadow-xl"
					>
						<div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
							Live voice
						</div>
						{LIVE_VOICES.map((option) => (
							<button
								key={option.value}
								type="button"
								onClick={() => {
									setVoice(option.value);
									setMenuOpen(false);
								}}
								className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-foreground transition-colors hover:bg-accent"
							>
								<span>{option.label}</span>
								{option.value === voice && <CheckIcon className="size-3 text-muted-foreground" />}
							</button>
						))}
					</div>
				)}
			</div>
		);
	}

	return (
		<div
			data-testid="live-voice-bar"
			className="flex w-full min-w-0 items-center justify-center gap-2 rounded-md border border-border/60 bg-card/80 px-2.5 h-7 text-xs shadow-lg backdrop-blur"
		>
			<span
				aria-hidden
				className={`size-1.5 shrink-0 rounded-full ${
					phase === "connecting" || phase === "working"
						? "animate-pulse bg-amber-500"
						: phase === "paused"
							? "bg-amber-500/80"
							: phase === "speaking"
								? "animate-pulse bg-emerald-500"
								: phase === "muted"
									? "bg-muted-foreground/50"
									: "animate-pulse bg-sky-500"
				}`}
			/>
			<span className="truncate font-medium text-foreground" data-testid="live-voice-phase">
				{phaseLabel(phase)}
			</span>
			<span className="hidden text-muted-foreground/70 sm:inline">· {voiceLabel}</span>
			<div className="ml-auto flex items-center gap-1">
				<Hint label={paused ? "Resume live voice" : "Pause live voice"} side="top">
					<button
						type="button"
						disabled={phase === "connecting"}
						onClick={() => void togglePause()}
						aria-label={paused ? "Resume live voice" : "Pause live voice"}
						data-testid="live-voice-pause"
						className={`flex h-5 items-center gap-1 rounded px-1.5 transition-colors disabled:opacity-50 ${
							paused
								? "bg-amber-500/15 font-medium text-amber-600 hover:bg-amber-500/25 dark:text-amber-400"
								: "text-muted-foreground hover:bg-accent hover:text-foreground"
						}`}
					>
						{paused ? <PlayIcon className="size-2.5 fill-current" /> : <PauseIcon className="size-3" />}
						<span>{paused ? "Resume" : "Pause"}</span>
					</button>
				</Hint>
				<Hint label={muted ? "Unmute microphone" : "Mute microphone"} side="top">
					<button
						type="button"
						disabled={phase === "connecting"}
						onClick={toggleMute}
						aria-label={muted ? "Unmute microphone" : "Mute microphone"}
						data-testid="live-voice-mute"
						className="flex h-5 items-center gap-1 rounded px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
					>
						{phase === "connecting" ? (
							<Loader2Icon className="size-3 animate-spin" />
						) : muted ? (
							<MicOffIcon className="size-3 text-destructive" />
						) : (
							<MicIcon className="size-3" />
						)}
						<span>{muted ? "Unmute" : "Mute"}</span>
					</button>
				</Hint>
				<Hint label="End live voice" side="top">
					<button
						type="button"
						onClick={() => void stop()}
						aria-label="End live voice"
						data-testid="live-voice-stop"
						className="flex h-5 items-center gap-1 rounded bg-destructive/10 px-1.5 font-medium text-destructive transition-colors hover:bg-destructive/20"
					>
						<SquareIcon className="size-2.5 fill-current" />
						<span>End</span>
					</button>
				</Hint>
			</div>
		</div>
	);
}

export function formatLiveTranscriptText(entries: readonly LiveTranscriptEntry[]): string {
	return entries
		.map((entry) => `${entry.role === "user" ? "You" : "Tutor"}: ${entry.text}`)
		.join("\n\n");
}

export function LiveCaptionStrip({ live }: { live: LiveVoiceController }) {
	const [collapsed, setCollapsed] = useState(false);
	const [copied, setCopied] = useState(false);
	const listRef = useRef<HTMLDivElement>(null);
	const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const { transcript, transcriptHistory, phase, active, paused, error } = live;
	const hasHistory = transcriptHistory.length > 0;
	const showTranscriptBody = hasHistory && !collapsed;
	useEffect(() => {
		return () => {
			if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
		};
	}, []);

	useEffect(() => {
		if (!showTranscriptBody) return;
		const el = listRef.current;
		if (!el) return;
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		if (distanceFromBottom < 80) {
			el.scrollTop = el.scrollHeight;
		}
	}, [showTranscriptBody, transcriptHistory]);

	const handleCopy = () => {
		if (!hasHistory || typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
		void navigator.clipboard.writeText(formatLiveTranscriptText(transcriptHistory)).then(() => {
			setCopied(true);
			if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
			copyTimerRef.current = setTimeout(() => setCopied(false), 1_500);
		}).catch(() => {});
	};

	if (!active && !error && !hasHistory) return null;

	return (
		<div className="pointer-events-auto mb-2 flex flex-col gap-1.5">
			{!active && error && (
				<div
					role="alert"
					data-testid="live-error-strip"
					className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-card/90 px-3 py-1.5 text-xs text-destructive shadow-sm backdrop-blur"
				>
					<AudioLinesIcon className="size-3.5 shrink-0" />
					<p className="min-w-0 flex-1 break-words">{error}</p>
					<button
						type="button"
						onClick={live.clearError}
						aria-label="Dismiss live voice error"
						className="flex size-5 shrink-0 items-center justify-center rounded text-destructive/80 transition-colors hover:bg-destructive/10 hover:text-destructive"
					>
						<XIcon className="size-3" />
					</button>
				</div>
			)}
			{(active || hasHistory) && (
				<div
					data-testid="live-caption-strip"
					className="overflow-hidden rounded-xl border border-border/60 bg-card/90 text-xs text-muted-foreground shadow-sm backdrop-blur"
				>
					<div className="flex items-center gap-2 px-3 py-1.5">
						<AudioLinesIcon className="size-3.5 shrink-0 text-foreground/70" />
						<p className="min-w-0 flex-1 truncate">
							{!active ? (
								<span className="font-medium text-foreground">
									Voice transcript ({transcriptHistory.length} {transcriptHistory.length === 1 ? "turn" : "turns"})
								</span>
							) : showTranscriptBody ? (
								<span className="font-medium text-foreground">
									Live transcript ({transcriptHistory.length}){paused ? " · Paused" : ""}
								</span>
							) : transcript ? (
								<>
									<span className="mr-1.5 font-medium text-foreground">
										{transcript.role === "user" ? "You:" : "Tutor:"}
									</span>
									<span className="text-foreground/90">{transcript.text}</span>
								</>
							) : (
								<span>
									{phase === "connecting"
										? "Connecting to Codex Live Voice…"
										: phase === "paused"
											? "Live voice paused — click Resume to continue."
											: phase === "working"
												? "Tutor is preparing a reply…"
												: phase === "muted"
													? "Microphone muted."
													: "Live voice active — speak naturally in English or Japanese."}
								</span>
							)}
						</p>
						{hasHistory && (
							<div className="flex shrink-0 items-center gap-1">
								<button
									type="button"
									onClick={handleCopy}
									data-testid="live-transcript-copy"
									aria-label="Copy voice transcript"
									className="flex h-5 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
								>
									{copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
									<span>{copied ? "Copied" : "Copy"}</span>
								</button>
								<button
									type="button"
									onClick={() => setCollapsed((prev) => !prev)}
									data-testid="live-transcript-toggle"
									aria-expanded={!collapsed}
									aria-label={collapsed ? "Expand voice transcript" : "Collapse voice transcript"}
									className="flex h-5 items-center gap-0.5 rounded px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
								>
									<span>{collapsed ? "Show" : "Hide"}</span>
									{collapsed ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
								</button>
								{!active && (
									<button
										type="button"
										onClick={live.clearTranscript}
										data-testid="live-transcript-dismiss"
										aria-label="Dismiss voice transcript"
										className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
									>
										<XIcon className="size-3" />
									</button>
								)}
							</div>
						)}
					</div>
					{showTranscriptBody && (
						<div
							ref={listRef}
							data-testid="live-transcript-list"
							className="max-h-48 space-y-1.5 overflow-y-auto border-t border-border/50 px-3 py-2 select-text"
						>
							{transcriptHistory.map((entry) => (
								<div
									key={`${entry.role}:${entry.turn}`}
									data-testid={`live-transcript-entry-${entry.role}-${entry.turn}`}
									className="flex items-baseline gap-2 leading-relaxed"
								>
									<span className={`shrink-0 font-ui text-[11px] font-medium ${entry.role === "user" ? "text-foreground" : "text-muted-foreground"}`}>
										{entry.role === "user" ? "You" : "Tutor"}
									</span>
									<p className={`min-w-0 flex-1 whitespace-pre-wrap break-words font-prose text-xs ${entry.final ? "text-foreground/90" : "italic text-muted-foreground"}`}>
										{entry.text}
									</p>
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
