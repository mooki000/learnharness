import { randomUUID } from "node:crypto";
import { WebSocket as UndiciWebSocket } from "undici";
import type { LiveVoiceId } from "../../core/contracts/live.ts";
import {
	CODEX_LIVE_SIGNALING_URL,
	buildCodexLiveHeaders,
	buildCodexSidebandUrl,
	buildCreateSessionConfig,
	buildEndpointSidebandUrl,
	buildEndpointSignalingUrl,
	buildFallbackAttestation,
	buildSessionClose,
	buildSessionUpdate,
	extractCallIdFromLocation,
	extractEndpointCallIdFromLocation,
	parseLiveWireEvent,
	type LiveWireEvent,
} from "./protocol.ts";

const MAX_ERROR_BODY = 2048;
const SIDEBAND_RETRIES = 5;
const SIDEBAND_CONNECT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const WS_CONNECTING = 0;
const WS_OPEN = 1;

export interface LiveEndpointConfig {
	baseUrl: string;
	apiKey?: string;
}

export interface LiveSidebandSocket {
	readonly readyState: number;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	onclose: ((event: { code: number; reason?: string }) => void) | null;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export type LiveWebSocketFactory = (url: string, headers: Record<string, string>) => LiveSidebandSocket;

export interface CodexLiveAuth {
	accessToken: string;
	accountId?: string;
}

export class LiveSignalingError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "LiveSignalingError";
		this.status = status;
	}
}

export function resolveLiveEndpointConfig(env: Readonly<Record<string, string | undefined>> = process.env): LiveEndpointConfig | undefined {
	const raw = env.LH_LIVE_ENDPOINT?.trim();
	if (!raw) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("LH_LIVE_ENDPOINT must be a valid http(s) URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("LH_LIVE_ENDPOINT must use http or https");
	}
	const apiKey = env.LH_LIVE_API_KEY?.trim() || undefined;
	return { baseUrl: parsed.toString(), ...(apiKey ? { apiKey } : {}) };
}

function defaultWebSocketFactory(url: string, headers: Record<string, string>): LiveSidebandSocket {
	const socket: unknown = new UndiciWebSocket(url, { headers });
	return socket as LiveSidebandSocket;
}

function cleanBody(body: string, fallback: string): string {
	const normalized = body.trim().replaceAll(/\s+/g, " ");
	if (!normalized) return fallback || "empty response body";
	return normalized.length <= MAX_ERROR_BODY ? normalized : `${normalized.slice(0, MAX_ERROR_BODY)}…`;
}

function abortError(signal?: AbortSignal): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	return new DOMException("Live connection aborted", "AbortError");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	if (signal?.aborted) { reject(abortError(signal)); return promise; }
	const onAbort = () => { clearTimeout(timer); reject(abortError(signal)); };
	const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
	timer.unref?.();
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

export interface LiveTransportOptions {
	sessionId: string;
	sdpOffer: string;
	instructions: string;
	voice: LiveVoiceId;
	endpoint?: LiveEndpointConfig;
	getCodexAuth?: () => Promise<CodexLiveAuth>;
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
	createWebSocket?: LiveWebSocketFactory;
	attestation?: () => string | undefined;
	onEvent: (event: LiveWireEvent) => void;
}

interface SidebandTarget {
	url: string;
	headers: Record<string, string>;
}

export class LiveTransport {
	private readonly options: LiveTransportOptions;
	private readonly label: string;
	private readonly callSessionId = randomUUID();
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly createSocket: LiveWebSocketFactory;
	private socket: LiveSidebandSocket | undefined;
	private answer: string | undefined;
	private state: "idle" | "connecting" | "connected" | "closing" | "closed" = "idle";
	private connectPromise: Promise<void> | undefined;
	private closePromise: Promise<void> | undefined;
	private sendTail = Promise.resolve();
	private errorReported = false;
	private readonly onAbort: () => void;

	constructor(options: LiveTransportOptions) {
		this.options = options;
		this.label = options.endpoint ? "Live endpoint" : "Codex live";
		this.fetchFn = options.fetch ?? globalThis.fetch;
		this.createSocket = options.createWebSocket ?? defaultWebSocketFactory;
		this.onAbort = () => { void this.close(); };
		if (!options.signal?.aborted) {
			options.signal?.addEventListener("abort", this.onAbort, { once: true });
		}
	}

	get sdpAnswer(): string | undefined {
		return this.answer;
	}

	connect(): Promise<void> {
		if (this.state === "connected") return Promise.resolve();
		if (this.connectPromise) return this.connectPromise;
		if (this.state === "closing" || this.state === "closed") {
			return Promise.reject(new Error("Live transport is closed"));
		}
		if (this.options.signal?.aborted) {
			return Promise.reject(abortError(this.options.signal));
		}
		this.state = "connecting";
		this.connectPromise = this.connectInternal().catch(async (error) => {
			await this.close();
			throw error;
		});
		return this.connectPromise;
	}

	private async connectInternal(): Promise<void> {
		const { answer, sideband } = this.options.endpoint
			? await this.signalEndpoint(this.options.sdpOffer, this.options.endpoint)
			: await this.signalCodex(this.options.sdpOffer);
		if (this.state !== "connecting") throw abortError(this.options.signal);
		this.answer = answer;
		await this.connectSidebandWithRetry(sideband);
		if (this.state !== "connecting") throw abortError(this.options.signal);
		if (this.options.endpoint) {
			this.socket?.send(JSON.stringify(buildSessionUpdate(this.options.instructions, this.options.voice)));
		}
		this.state = "connected";
	}

	private async signalCodex(sdpOffer: string): Promise<{ answer: string; sideband: SidebandTarget }> {
		if (!this.options.getCodexAuth) {
			throw new Error("No OpenAI Codex OAuth connection is available for Live Voice.");
		}
		const auth = await this.options.getCodexAuth();
		const attestation = this.options.attestation ? this.options.attestation() : buildFallbackAttestation(this.callSessionId);
		const headers = buildCodexLiveHeaders({
			accessToken: auth.accessToken,
			accountId: auth.accountId,
			sessionId: this.options.sessionId,
			callSessionId: this.callSessionId,
			attestation,
		});
		this.options.signal?.throwIfAborted();
		const response = await this.fetchFn(CODEX_LIVE_SIGNALING_URL, {
			method: "POST",
			headers: {
				...headers,
				Accept: "*/*",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				sdp: sdpOffer,
				session: buildCreateSessionConfig(this.options.instructions, this.options.voice),
			}),
			signal: this.options.signal,
		});
		const body = await response.text();
		if (!response.ok) {
			throw new LiveSignalingError(response.status, `Codex live signaling failed (${response.status}): ${cleanBody(body, response.statusText)}`);
		}
		if (!body.trim()) {
			throw new LiveSignalingError(response.status, "Codex live signaling returned an empty SDP answer");
		}
		const callId = extractCallIdFromLocation(response.headers.get("location"));
		if (!callId) {
			throw new LiveSignalingError(response.status, "Codex live signaling returned no valid call ID");
		}
		return {
			answer: body,
			sideband: { url: buildCodexSidebandUrl(callId), headers },
		};
	}

	private async signalEndpoint(sdpOffer: string, endpoint: LiveEndpointConfig): Promise<{ answer: string; sideband: SidebandTarget }> {
		const authHeaders: Record<string, string> = endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {};
		let target = new URL(buildEndpointSignalingUrl(endpoint.baseUrl));
		const initialOrigin = target.origin;
		for (let redirects = 0; ; redirects++) {
			this.options.signal?.throwIfAborted();
			const response = await this.fetchFn(target, {
				method: "POST",
				headers: { ...authHeaders, "Content-Type": "application/sdp" },
				body: sdpOffer,
				redirect: "manual",
				signal: this.options.signal,
			});
			const location = response.headers.get("location");
			if (response.status >= 300 && response.status < 400) {
				await response.body?.cancel();
				const next = location ? new URL(location, target) : undefined;
				const allowed = response.status === 307 || response.status === 308;
				if (!next || !allowed || next.origin !== initialOrigin || redirects >= MAX_REDIRECTS) {
					throw new LiveSignalingError(
						response.status,
						`Live endpoint signaling redirected (${response.status}) to ${location ?? "nowhere"}; only same-origin 307/308 redirects are followed`,
					);
				}
				target = next;
				continue;
			}
			const body = await response.text();
			if (!response.ok) {
				throw new LiveSignalingError(response.status, `Live endpoint signaling failed (${response.status}): ${cleanBody(body, response.statusText)}`);
			}
			if (!body.trim()) {
				throw new LiveSignalingError(response.status, "Live endpoint signaling returned an empty SDP answer");
			}
			const callId = extractEndpointCallIdFromLocation(location);
			if (!callId) {
				throw new LiveSignalingError(response.status, "Live endpoint signaling returned no call ID in Location");
			}
			return {
				answer: body,
				sideband: { url: buildEndpointSidebandUrl(endpoint.baseUrl, callId), headers: authHeaders },
			};
		}
	}

	private async connectSidebandWithRetry(target: SidebandTarget): Promise<void> {
		let lastError = new Error(`${this.label} sideband connection failed`);
		for (let attempt = 0; attempt < SIDEBAND_RETRIES; attempt++) {
			this.options.signal?.throwIfAborted();
			try {
				await this.connectSidebandOnce(target);
				return;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				if (this.options.signal?.aborted) throw abortError(this.options.signal);
				if (attempt + 1 < SIDEBAND_RETRIES) {
					await sleep(200 * 2 ** attempt, this.options.signal);
				}
			}
		}
		throw lastError;
	}

	private connectSidebandOnce(target: SidebandTarget): Promise<void> {
		const socket = this.createSocket(target.url, target.headers);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let opened = false;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			clearTimeout(timer);
			timer = undefined;
			this.options.signal?.removeEventListener("abort", onAbort);
		};
		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};
		const onAbort = () => {
			try { socket.close(1000, "aborted"); } catch { /* ignore */ }
			fail(abortError(this.options.signal));
		};

		socket.onopen = () => {
			if (settled) {
				try { socket.close(1000, "stale"); } catch { /* ignore */ }
				return;
			}
			opened = true;
			settled = true;
			cleanup();
			this.socket = socket;
			resolve();
		};
		socket.onmessage = (event) => {
			if (typeof event.data !== "string") {
				this.reportError(`${this.label} sideband returned an unexpected binary frame.`);
				return;
			}
			if (this.state === "closing" || this.state === "closed") return;
			const parsed = parseLiveWireEvent(event.data);
			if (!parsed) return;
			try {
				this.options.onEvent(parsed);
			} catch { /* observer isolation */ }
		};
		socket.onerror = (event) => {
			const message = typeof event === "object" && event !== null && "message" in event && typeof event.message === "string" ? event.message : "";
			const detail = message ? `: ${message}` : "";
			if (!opened) {
				fail(new Error(`${this.label} sideband connection failed${detail}`));
				try { socket.close(1011, "connection failed"); } catch { /* ignore */ }
				return;
			}
			this.reportError(`${this.label} sideband failed${detail}`);
		};
		socket.onclose = (event) => {
			if (!opened) {
				fail(new Error(`${this.label} sideband closed before connecting (${event.code})`));
				return;
			}
			if (this.socket !== socket) return;
			this.socket = undefined;
			if (this.state === "connecting" || this.state === "connected") {
				const reason = event.reason ? `: ${event.reason}` : "";
				this.reportError(`${this.label} sideband closed (${event.code})${reason}`);
			}
		};

		if (this.options.signal?.aborted) {
			onAbort();
		} else {
			this.options.signal?.addEventListener("abort", onAbort, { once: true });
			timer = setTimeout(() => {
				try { socket.close(1000, "connect timeout"); } catch { /* ignore */ }
				fail(new Error(`${this.label} sideband connection timed out`));
			}, SIDEBAND_CONNECT_TIMEOUT_MS);
			timer.unref?.();
		}
		return promise;
	}

	private reportError(message: string): void {
		if ((this.state !== "connecting" && this.state !== "connected") || this.errorReported) return;
		this.errorReported = true;
		try {
			this.options.onEvent({ type: "error", message });
		} catch { /* observer isolation */ }
	}

	send(payload: object): Promise<void> {
		const next = this.sendTail.then(() => {
			if (this.state !== "connected") throw new Error("Live transport is not connected");
			const socket = this.socket;
			if (!socket || socket.readyState !== WS_OPEN) {
				throw new Error(`${this.label} sideband is not connected`);
			}
			socket.send(JSON.stringify(payload));
		});
		this.sendTail = next.catch(() => {});
		return next;
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		const wasConnected = this.state === "connected";
		this.state = "closing";
		this.closePromise = (async () => {
			this.options.signal?.removeEventListener("abort", this.onAbort);
			const socket = this.socket;
			this.socket = undefined;
			if (socket) {
				try {
					if (wasConnected && socket.readyState === WS_OPEN) {
						socket.send(JSON.stringify(buildSessionClose()));
					}
				} catch { /* best-effort graceful close */ }
				if (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING) {
					try { socket.close(1000, "done"); } catch { /* ignore */ }
				}
			}
			this.state = "closed";
		})();
		return this.closePromise;
	}
}
