export type CodexSpeed = "fast" | "ultrafast";

const TOP_SPEED: Readonly<Partial<Record<string, CodexSpeed>>> = {
	"gpt-6.2-astra": "ultrafast", "gpt-6.2-sol": "ultrafast",
	"gpt-6-astra": "ultrafast", "gpt-6.1-sol": "ultrafast",
	"gpt-6.1-terra": "fast", "gpt-6-sol": "fast", "gpt-6-luna": "fast",
};
const BOTH: readonly CodexSpeed[] = ["fast", "ultrafast"];
const FAST: readonly CodexSpeed[] = ["fast"];
const STANDARD_ONLY: readonly CodexSpeed[] = [];

/** Known model capabilities, not a claim about the signed-in plan's entitlements. */
export function codexSpeedsFor(model?: { provider: string; id: string }): readonly CodexSpeed[] {
	if (model?.provider !== "chatgpt") return STANDARD_ONLY;
	const top = Object.hasOwn(TOP_SPEED, model.id) ? TOP_SPEED[model.id] : undefined;
	return top === "ultrafast" ? BOTH : top === "fast" ? FAST : STANDARD_ONLY;
}

export function isCodexSpeed(value: unknown): value is CodexSpeed {
	return value === "fast" || value === "ultrafast";
}
