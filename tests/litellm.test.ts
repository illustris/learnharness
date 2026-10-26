import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { liteLLMBaseUrl, liteLLMModels, type LiteLLMModelInfo } from "../src/agent/litellm.ts";
import { APP_PROVIDER_KEYS, AUTH_PROVIDER_KEYS, isProviderEnvVar, MODEL_PROVIDER_KEYS } from "../src/core/auth-keys.ts";

const BASE = "https://litellm.example/v1";

describe("liteLLMBaseUrl", () => {
	it("is undefined when LITELLM_BASE_URL is unset or blank", () => {
		assert.equal(liteLLMBaseUrl({}), undefined);
		assert.equal(liteLLMBaseUrl({ LITELLM_BASE_URL: "  " }), undefined);
	});

	it("normalizes to a single /v1 suffix", () => {
		assert.equal(liteLLMBaseUrl({ LITELLM_BASE_URL: "https://litellm.example/" }), BASE);
		assert.equal(liteLLMBaseUrl({ LITELLM_BASE_URL: "https://litellm.example" }), BASE);
		assert.equal(liteLLMBaseUrl({ LITELLM_BASE_URL: "https://litellm.example/v1/" }), BASE);
	});
});

describe("liteLLMModels", () => {
	const entries: LiteLLMModelInfo[] = [
		{
			model_name: "glm-5.3-flash",
			model_info: {
				mode: "chat",
				input_cost_per_token: 1.5e-7,
				output_cost_per_token: 5e-7,
				cache_read_input_token_cost: 3e-8,
				cache_creation_input_token_cost: 0,
				max_input_tokens: 1_048_576,
				max_output_tokens: 128_000,
				supports_reasoning: true,
				supports_vision: true,
			},
		},
		{ model_name: "glm-5.3-flash", model_info: { mode: "chat", input_cost_per_token: 9 } },
		{ model_name: "gpt-x", model_info: { mode: "responses", input_cost_per_token: 1e-7, max_input_tokens: 8_000, max_output_tokens: 128_000 } },
		{ model_name: "custom-deploy", model_info: { input_cost_per_token: null } },
		{ model_name: "bge-m3", model_info: { mode: "embedding" } },
		{ model_name: "judge", model_info: { mode: "evaluation" } },
	];
	const models = liteLLMModels(entries, BASE);

	it("keeps chat, responses and mode-less entries, first deployment wins", () => {
		assert.deepEqual(models.map((m) => m.id), ["glm-5.3-flash", "gpt-x", "custom-deploy"]);
	});

	it("converts per-token prices to pi's per-million rates", () => {
		assert.deepEqual(models[0]!.cost, { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 });
		assert.deepEqual(models[2]!.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("maps limits and capabilities, with fallbacks for bare entries", () => {
		const [glm, gpt, bare] = models;
		assert.equal(glm!.contextWindow, 1_048_576);
		assert.equal(glm!.maxTokens, 128_000);
		assert.equal(glm!.reasoning, true);
		assert.deepEqual(glm!.input, ["text", "image"]);
		assert.equal(gpt!.maxTokens, 8_000, "max output is clamped to the context window");
		assert.equal(bare!.contextWindow, 128_000);
		assert.equal(bare!.maxTokens, 32_000);
		assert.equal(bare!.reasoning, false);
		assert.deepEqual(bare!.input, ["text"]);
	});

	it("routes every model through chat completions on the proxy", () => {
		for (const m of models) {
			assert.equal(m.provider, "litellm");
			assert.equal(m.api, "openai-completions");
			assert.equal(m.baseUrl, BASE);
			assert.equal(m.compat?.supportsReasoningEffort, m.reasoning);
		}
	});
});

describe("LiteLLM key row", () => {
	it("is an app provider key, outside pi-ai's pinned table", () => {
		assert.ok(APP_PROVIDER_KEYS.some((p) => p.id === "litellm" && p.envVar === "LITELLM_API_KEY"));
		assert.ok(!AUTH_PROVIDER_KEYS.some((p) => p.id === "litellm"));
		assert.ok(MODEL_PROVIDER_KEYS.some((p) => p.id === "litellm"));
		assert.ok(isProviderEnvVar("LITELLM_API_KEY"));
	});
});
