import { createProvider, envApiKeyAuth, type Model, type Models, type Provider, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/**
 * LiteLLM proxy as a model provider. pi-ai ships no LiteLLM provider and
 * pins every builtin provider's base URL, so the app registers this one
 * itself (piModels in ./models.ts). Configuration is env-only:
 *
 *   LITELLM_BASE_URL  proxy address, e.g. https://litellm.example.com
 *                     (a trailing /v1 is optional)
 *   LITELLM_API_KEY   proxy key — also settable in Settings → Keys
 *
 * The catalog is the proxy's own GET /v1/model/info: every chat model the
 * key can reach, with the context limits and per-token prices configured
 * in LiteLLM, so the cost meter reports what the proxy charges. All models
 * go through /v1/chat/completions; LiteLLM translates to each backend.
 */

export const LITELLM_PROVIDER_ID = "litellm";

/** How long a fetched catalog is trusted before the next refresh refetches. */
const CATALOG_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
/** Fallbacks for models whose LiteLLM entry carries no limits. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 32_000;

/** LiteLLM modes that serve /chat/completions. Entries without a mode are
 *  custom deployments LiteLLM has no metadata for; they are chat models in
 *  practice, and embedding/rerank/etc. entries always carry their mode. */
const CHAT_MODES = new Set(["chat", "responses"]);

/** The configured proxy's OpenAI-compatible base (".../v1"), or undefined
 *  when LITELLM_BASE_URL is unset — the provider is then not registered. */
export function liteLLMBaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
	const raw = env.LITELLM_BASE_URL?.trim();
	if (!raw) return undefined;
	const base = raw.replace(/\/+$/, "");
	return base.endsWith("/v1") ? base : `${base}/v1`;
}

/** The subset of a LiteLLM /model/info entry this module reads. */
export interface LiteLLMModelInfo {
	model_name: string;
	model_info?: {
		mode?: string | null;
		input_cost_per_token?: number | null;
		output_cost_per_token?: number | null;
		cache_read_input_token_cost?: number | null;
		cache_creation_input_token_cost?: number | null;
		max_input_tokens?: number | null;
		max_output_tokens?: number | null;
		max_tokens?: number | null;
		supports_reasoning?: boolean | null;
		supports_vision?: boolean | null;
	} | null;
}

const perMillion = (perToken: number | null | undefined) => (typeof perToken === "number" && Number.isFinite(perToken) ? Number((perToken * 1_000_000).toPrecision(12)) : 0);
const positive = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined);

/** Project /model/info entries to pi chat models (pure). The first entry
 *  per model_name wins — LiteLLM lists one entry per deployment. */
export function liteLLMModels(entries: readonly LiteLLMModelInfo[], baseUrl: string): Model<"openai-completions">[] {
	const seen = new Set<string>();
	const models: Model<"openai-completions">[] = [];
	for (const entry of entries) {
		const id = entry.model_name;
		const info = entry.model_info ?? {};
		if (!id || seen.has(id)) continue;
		if (info.mode && !CHAT_MODES.has(info.mode)) continue;
		seen.add(id);
		const contextWindow = positive(info.max_input_tokens) ?? positive(info.max_tokens) ?? DEFAULT_CONTEXT_WINDOW;
		const reasoning = info.supports_reasoning === true;
		models.push({
			id,
			name: id,
			api: "openai-completions",
			provider: LITELLM_PROVIDER_ID,
			baseUrl,
			reasoning,
			input: info.supports_vision === true ? ["text", "image"] : ["text"],
			cost: {
				input: perMillion(info.input_cost_per_token),
				output: perMillion(info.output_cost_per_token),
				cacheRead: perMillion(info.cache_read_input_token_cost),
				cacheWrite: perMillion(info.cache_creation_input_token_cost),
			},
			contextWindow,
			maxTokens: Math.min(positive(info.max_output_tokens) ?? DEFAULT_MAX_TOKENS, contextWindow),
			// Lowest common denominator across LiteLLM backends: no `store`,
			// system (not developer) role, max_tokens. reasoning_effort is
			// sent only to reasoning models; LiteLLM maps it per backend.
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				maxTokensField: "max_tokens",
				supportsReasoningEffort: reasoning,
				supportsUsageInStreaming: true,
			},
		});
	}
	return models;
}

async function fetchLiteLLMModels(context: RefreshModelsContext): Promise<Model<"openai-completions">[]> {
	const baseUrl = context.baseUrl ?? liteLLMBaseUrl();
	if (!baseUrl) return [];
	const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
	const response = await fetch(`${baseUrl}/model/info`, {
		headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
		signal: AbortSignal.any([context.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
	});
	if (!response.ok) throw new Error(`LiteLLM ${baseUrl}/model/info answered ${response.status}`);
	const body = (await response.json()) as { data?: LiteLLMModelInfo[] };
	return liteLLMModels(body.data ?? [], baseUrl);
}

/** The provider, or undefined when LITELLM_BASE_URL is unset. Its catalog
 *  starts empty and fills on refreshLiteLLMModels. */
export function liteLLMProvider(): Provider | undefined {
	const baseUrl = liteLLMBaseUrl();
	if (!baseUrl) return undefined;
	return createProvider({
		id: LITELLM_PROVIDER_ID,
		name: "LiteLLM",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("LiteLLM API key", ["LITELLM_API_KEY"]) },
		models: [],
		fetchModels: fetchLiteLLMModels,
		api: openAICompletionsApi(),
	});
}

let fetchedAt = 0;
let inflight: Promise<void> | undefined;

/** Refetch the proxy catalog when it is older than CATALOG_TTL_MS (or
 *  empty). Concurrent callers share one request; a failed fetch keeps the
 *  previous catalog and is retried on the next call. */
export function refreshLiteLLMModels(models: Models): Promise<void> {
	if (!models.getProvider(LITELLM_PROVIDER_ID)) return Promise.resolve();
	if (Date.now() - fetchedAt < CATALOG_TTL_MS && models.getModels(LITELLM_PROVIDER_ID).length > 0) return Promise.resolve();
	inflight ??= models
		.refresh({ providers: [LITELLM_PROVIDER_ID] })
		.then((result) => {
			const error = result.errors.get(LITELLM_PROVIDER_ID);
			if (error) console.warn(`[litellm] catalog refresh failed: ${error.message}`);
			else if (models.getModels(LITELLM_PROVIDER_ID).length > 0) fetchedAt = Date.now();
		})
		.finally(() => {
			inflight = undefined;
		});
	return inflight;
}
