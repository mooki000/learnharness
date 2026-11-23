import type { AnyModel, Api, Model } from "@earendil-works/pi-ai";

/** Pi 1.6.0 OpenAI Responses metadata. Keep this backport out of provider discovery. */
export function withOpenAIModelBackports(models: readonly Model<Api>[]): readonly Model<Api>[];
export function withOpenAIModelBackports(models: readonly AnyModel[]): readonly AnyModel[];
export function withOpenAIModelBackports(models: readonly AnyModel[]): readonly AnyModel[] {
	const sol = models.find((model): model is Model<"openai-responses"> => model.id === "gpt-6.1-sol" && model.api === "openai-responses");
	const missingSol = !models.some((model) => model.id === "gpt-6.2-sol" && model.api === "openai-responses");
	const missingAstra = !models.some((model) => model.id === "gpt-6.2-astra" && model.api === "openai-responses");
	if (!sol || (!missingSol && !missingAstra)) return models;
	const result = [...models];
	if (missingSol) result.push({ ...sol, id: "gpt-6.2-sol", name: "GPT-6.2 Sol" });
	if (missingAstra) result.push({
		...sol, id: "gpt-6.2-astra", name: "GPT-6.2 Astra",
		cost: {
			input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10,
			tiers: [{ inputTokensAbove: 272_000, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 }],
		},
	});
	return result;
}
