import logger from './logger.js';
import { Provider } from './TokenUsageReporter.js';

// LLM pricing — USD per 1 million tokens
// Each provider section has a 'default' fallback for unknown models.
// Models with tiered pricing use an array of tiers; the first matching tier wins.
// A tier matches when inputTokens <= maxInputTokens, or when maxInputTokens is absent (catch-all).

// ─── Anthropic ───────────────────────────────────────────────────────────────
// Source: https://platform.claude.com/docs/en/about-claude/pricing
export const anthropic = {
  'claude-mythos-5': {
    inputTokens: 10.00,
    cacheCreation5mInputTokens: 12.50,
    cacheCreation1hInputTokens: 20.00,
    cacheReadInputTokens: 1.0,
    outputTokens: 50.00,
  },
  'claude-fable-5': {
    inputTokens: 10.00,
    cacheCreation5mInputTokens: 12.50,
    cacheCreation1hInputTokens: 20.00,
    cacheReadInputTokens: 1.0,
    outputTokens: 50.00,
  },
  'claude-opus-5': {
    inputTokens: 5.00,
    cacheCreation5mInputTokens: 6.25,
    cacheCreation1hInputTokens: 10.00,
    cacheReadInputTokens: 0.50,
    outputTokens: 25.00,
  },
  'claude-opus-4-8': {
    inputTokens: 5.00,
    cacheCreation5mInputTokens: 6.25,
    cacheCreation1hInputTokens: 10.00,
    cacheReadInputTokens: 0.50,
    outputTokens: 25.00,
  },
  'claude-opus-4-7': {
    inputTokens: 5.00,
    cacheCreation5mInputTokens: 6.25,
    cacheCreation1hInputTokens: 10.00,
    cacheReadInputTokens: 0.50,
    outputTokens: 25.00,
  },
  'claude-opus-4-6': {
    inputTokens: 5.00,
    cacheCreation5mInputTokens: 6.25,
    cacheCreation1hInputTokens: 10.00,
    cacheReadInputTokens: 0.50,
    outputTokens: 25.00,
  },
  'claude-sonnet-5': {
    inputTokens: 2.00,
    cacheCreation5mInputTokens: 2.50,
    cacheCreation1hInputTokens: 4.00,
    cacheReadInputTokens: 0.20,
    outputTokens: 10.00,
  },
  'claude-sonnet-4-6': {
    inputTokens: 3.00,
    cacheCreation5mInputTokens: 3.75,
    cacheCreation1hInputTokens: 6.00,
    cacheReadInputTokens: 0.30,
    outputTokens: 15.00,
  },
  'claude-sonnet-4-5': {
    inputTokens: 3.00,
    cacheCreation5mInputTokens: 3.75,
    cacheCreation1hInputTokens: 6.00,
    cacheReadInputTokens: 0.30,
    outputTokens: 15.00,
  },
  'claude-haiku-4-5': {
    inputTokens: 1.00,
    cacheCreation5mInputTokens: 1.25,
    cacheCreation1hInputTokens: 2.00,
    cacheReadInputTokens: 0.10,
    outputTokens: 5.00,
  },
  default: {
    inputTokens: 5.00,
    cacheCreation5mInputTokens: 6.25,
    cacheCreation1hInputTokens: 10.00,
    cacheReadInputTokens: 0.50,
    outputTokens: 25.00,
  },
};

// ─── Gemini ──────────────────────────────────────────────────────────────────
// Source: https://ai.google.dev/gemini-api/docs/pricing
// Thinking/reasoning tokens are billed at the output token rate.
// cachedTokens are a subset of inputTokens and billed at the cached rate instead.
// outputImageTokens, where present, is the rate for generated image output — a
// separate and much higher rate than text output. Absent for a text-only model,
// where it costs nothing because no image tokens are ever reported.
export const gemini = {
  'gemini-3.1-pro-preview': [
    { maxInputTokens: 200000, inputTokens: 2.00, cachedTokens: 0.20, outputTokens: 12.00 },
    {                         inputTokens: 4.00, cachedTokens: 0.40, outputTokens: 18.00 },
  ],
  'gemini-2.5-pro': [
    { maxInputTokens: 200000, inputTokens: 1.25, cachedTokens: 0.13, outputTokens: 10.00 },
    {                         inputTokens: 2.50, cachedTokens: 0.25, outputTokens: 15.00 },
  ],
  'gemini-2.5-flash': {
    inputTokens: 0.30,
    cachedTokens: 0.03,
    outputTokens: 2.50,
  },
  'gemini-3-flash-preview': {
    inputTokens: 0.50,
    cachedTokens: 0.05,
    outputTokens: 3.00,
  },
  'gemini-3.1-flash-lite' : {
    inputTokens: 0.25,
    cachedTokens: 0.025,
    outputTokens: 1.50,
  },
  'gemini-3.5-flash-lite' : {
    inputTokens: 0.3,
    cachedTokens: 0.03,
    outputTokens: 2.50,
  },
  'gemini-3.5-flash': {
    inputTokens: 1.50,
    cachedTokens: 0.15,
    outputTokens: 9.00,
  },
  'gemini-3.6-flash': {
    inputTokens: 1.50,
    cachedTokens: 0.15,
    outputTokens: 7.00,
  },
  // Embedding model used for RAG. Embeddings bill input (prompt) tokens only;
  // there are no output/cached tokens, so those rates are 0.
  'gemini-embedding-2': {
    inputTokens: 0.15,
    cachedTokens: 0.00,
    outputTokens: 0.00,
  },
  // ── Image generation ──────────────────────────────────────────────────────
  // These are the only models here that bill output at two different rates:
  // text and thinking at outputTokens, and the generated image itself at
  // outputImageTokens — ten times higher for gemini-3-pro-image. Billing an
  // image at the text rate would under-report a generation by ~10x, which is why
  // TokenUsageReporter splits candidatesTokenCount by modality rather than
  // charging it all at one rate.
  //
  // The per-image figures below are Google's own and are a useful sanity check on
  // the arithmetic: an image is a fixed token count by resolution, so
  // 1120 tokens x $120/1M = $0.134 and 2000 x $120/1M = $0.24.
  'gemini-3-pro-image': {
    inputTokens: 2.00,
    cachedTokens: 0.20,
    outputTokens: 12.00,       // text and thinking
    outputImageTokens: 120.00, // 1120 tokens => $0.134/image at 1K-2K; 2000 => $0.24 at 4K
  },
  'gemini-3.1-flash-image': {
    inputTokens: 0.50,
    cachedTokens: 0.05,
    outputTokens: 3.00,
    outputImageTokens: 60.00,  // $0.045-$0.151 per image depending on resolution
  },
  'gemini-2.5-flash-image': {
    inputTokens: 0.30,
    cachedTokens: 0.03,
    outputTokens: 2.50,
    outputImageTokens: 30.00,  // ~$0.039 per image
  },
  default: {
    inputTokens: 4.00,
    cachedTokens: 0.40,
    outputTokens: 18.00,
  },
};

// ─── OpenAI ──────────────────────────────────────────────────────────────────
// Source: https://developers.openai.com/api/docs/pricing
// Reasoning tokens are billed at the output token rate and are already included
// in completion_tokens, so they must not be double-counted.
// cachedTokens (cache reads) and cacheWriteTokens (cache writes, GPT-5.6+) are
// disjoint subsets of inputTokens, each billed at its own rate instead of input.
// Aliases resolve before the pricing lookup.
export const openaiAliases = {
  'gpt-5': 'gpt-5.6-sol',        // bare alias → newest gpt-5.X flagship tier
  'gpt-5-mini': 'gpt-5.4-mini',  // bare alias → newest gpt-5.X mini model
};

export const openai = {
  // GPT-5.6 family (GA 2026-07-09): three flagship tiers — Sol/Terra/Luna.
  // Repriced 2026-07-30: Terra cut ~20% and Luna ~80%; Sol unchanged.
  // Like gpt-5.5, prompts over 272K input tokens are billed at the higher
  // "long context" rate for the ENTIRE request (not just the overflow tokens),
  // so the tier is selected on total inputTokens. Cached (read) input bills at
  // 10% of input; cacheWriteTokens (tokens written to cache) bills at 1.25x input.
  'gpt-5.6-sol': [
    { maxInputTokens: 272000, inputTokens: 5.00, cachedTokens: 0.50, cacheWriteTokens: 6.25, outputTokens: 30.00 },
    {                         inputTokens: 10.00, cachedTokens: 1.00, cacheWriteTokens: 12.50, outputTokens: 45.00 },
  ],
  'gpt-5.6-terra': [
    { maxInputTokens: 272000, inputTokens: 2.00, cachedTokens: 0.20, cacheWriteTokens: 2.50, outputTokens: 12.00 },
    {                         inputTokens: 4.00, cachedTokens: 0.40, cacheWriteTokens: 5.00, outputTokens: 18.00 },
  ],
  'gpt-5.6-luna': [
    { maxInputTokens: 272000, inputTokens: 0.20, cachedTokens: 0.02, cacheWriteTokens: 0.25, outputTokens: 1.20 },
    {                         inputTokens: 0.40, cachedTokens: 0.04, cacheWriteTokens: 0.50, outputTokens: 1.80 },
  ],
  'gpt-5.5': [
    { maxInputTokens: 272000, inputTokens: 5.00, cachedTokens: 0.50, outputTokens: 30.00 },
    {                         inputTokens: 10.00, cachedTokens: 1.00, outputTokens: 45.00 },
  ],
  'gpt-5.4-mini': {
    inputTokens: 0.75,
    cachedTokens: 0.075,
    outputTokens: 4.50,
  },
  default: {
    inputTokens: 10.00,
    cachedTokens: 1.00,
    outputTokens: 45.00,
  },
};

// ─── DeepSeek ────────────────────────────────────────────────────────────────
// Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// Native API rates (USD per 1M tokens). Cache hits are reported top-level as
// prompt_cache_hit_tokens and bill at the reduced cachedTokens rate.
export const deepseek = {
  'deepseek-v4-pro': {
    inputTokens: 0.435,
    cachedTokens: 0.003625,
    outputTokens: 0.87,
  },
  'deepseek-v4-flash': {
    inputTokens: 0.14,
    cachedTokens: 0.0028,
    outputTokens: 0.28,
  },
  default: {
    inputTokens: 0.14,
    cachedTokens: 0.0028,
    outputTokens: 0.28,
  },
};

// NOTE: No `openrouter` pricing table here. OpenRouter responses include an
// authoritative `usage.cost` field that is the source of truth for billed USD;
// TokenUsageReporter trusts that value directly for Provider.OPENROUTER and
// never calls getPricing() for it.

// ─── Lookup helper ───────────────────────────────────────────────────────────

/**
 * Returns the pricing tier for a given provider/model/inputTokenCount.
 * Unknown providers fall back to the OpenAI pricing table.
 * Unknown models fall back to the provider's "default" entry, then to openai's default.
 * @param {string} provider - use Provider enum from TokenUsageReporter.js (others fall back to openai)
 * @param {string} model
 * @param {number} inputTokens - used to select the correct tier for tiered models
 * @returns {Object} pricing object with per-token-type rates
 */
export function getPricing(provider, model, inputTokens = 0) {
  let table, aliases, resolvedProvider;
  if (provider === Provider.ANTHROPIC) {
    table = anthropic; aliases = {}; resolvedProvider = Provider.ANTHROPIC;
  } else if (provider === Provider.OPENAI) {
    table = openai; aliases = openaiAliases; resolvedProvider = Provider.OPENAI;
  } else if (provider === Provider.GOOGLE) {
    table = gemini; aliases = {}; resolvedProvider = Provider.GOOGLE;
  } else if (provider === Provider.DEEPSEEK) {
    table = deepseek; aliases = {}; resolvedProvider = Provider.DEEPSEEK;
  } else {
    logger.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
    logger.error(`[pricing] !!! UNKNOWN PROVIDER "${provider}" !!! falling back to openai pricing — UPDATE pricing.js`);
    logger.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
    table = openai; aliases = openaiAliases; resolvedProvider = 'openai';
  }

  const resolvedModel = aliases[model] ?? model;
  let entry = table[resolvedModel];
  if (!entry) {
    logger.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
    logger.error(`[pricing] !!! UNKNOWN MODEL "${model}" for provider "${resolvedProvider}" !!! falling back to "${resolvedProvider}" default rates — UPDATE pricing.js`);
    logger.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
    entry = table['default'];
    if (!entry) {
      logger.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
      logger.error(`[pricing] !!! NO DEFAULT for provider "${resolvedProvider}" !!! falling back to openai default rates — UPDATE pricing.js`);
      logger.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
      entry = openai['default'];
    }
  }

  if (Array.isArray(entry)) {
    for (const tier of entry) {
      if (tier.maxInputTokens === undefined || inputTokens <= tier.maxInputTokens) {
        return tier;
      }
    }
    return entry[entry.length - 1];
  }

  return entry;
}
