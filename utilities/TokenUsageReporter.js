import logger from './logger.js';
import { getPricing } from './pricing.js';
import config from '../config.js';

export const Provider = Object.freeze({
  ANTHROPIC: 'anthropic',
  OPENAI: 'openai',
  GOOGLE: 'google',
  OPENROUTER: 'openrouter',
  DEEPSEEK: 'deepseek',
});

// Maps both internal usage-reporter Provider enum values (anthropic/openai/google/openrouter)
// AND external orchestrator brand IDs to human-readable display names. The brand IDs are
// not in the Provider enum — they identify the upstream LLM family the user picked — but
// the UI needs friendly names for them too. The OpenRouter-routed brands are derived from
// the shared config registry so adding/removing a brand is a single config.js edit.
export const ProviderDisplayNames = Object.freeze({
  [Provider.ANTHROPIC]: 'Claude',
  [Provider.GOOGLE]: 'Gemini',
  [Provider.OPENAI]: 'OpenAI',
  [Provider.OPENROUTER]: 'OpenRouter',
  [Provider.DEEPSEEK]: 'DeepSeek',
  ...Object.fromEntries(
    Object.entries(config.openRouterAgentProviders).map(([id, { displayName }]) => [id, displayName])
  ),
});

class TokenUsageReporter {
  /**
   * @param {string|null} url - Optional URL to POST token usage to. If null, reporting is disabled.
   * @param {string|null} clientId - The clientId from the InitializeSessionMessage.
   */
  constructor(url = null, clientId = null) {
    this.url = url;
    this.clientId = clientId;
  }

  /**
   * Reports token usage for an agent LLM call.
   * @param {Object} params
   * @param {string} params.provider - LLM provider: use Provider.ANTHROPIC | Provider.OPENAI | Provider.GOOGLE
   * @param {string} params.model - Specific model name, e.g. 'claude-sonnet-4-6' or 'gemini-3-flash-preview'
   * @param {Object} params.usage - Raw usage object from the LLM provider
   * @param {boolean} params.clientKey - True when the API key in use was supplied by the end user; false when it came from the server's .env.
   */
  async report({ provider, model, usage, clientKey }) {
    if (!usage) return;

    const isAnthropic = provider === Provider.ANTHROPIC;
    const isOpenAI = provider === Provider.OPENAI;
    const isGemini = provider === Provider.GOOGLE;
    const isOpenRouter = provider === Provider.OPENROUTER;
    const isDeepSeek = provider === Provider.DEEPSEEK;

    let tokens;
    if (isAnthropic) {
      tokens = {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheCreation5mInputTokens: usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
        cacheCreation1hInputTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      };
    } else if (isOpenAI) {
      tokens = {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        // GPT-5.6+ report tokens written to cache and bill them separately (1.25x input);
        // older models omit this field, so it defaults to 0 and costs nothing.
        cacheWriteTokens: usage.prompt_tokens_details?.cache_write_tokens ?? 0,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
      };
    } else if (isDeepSeek) {
      // DeepSeek's OpenAI-compatible API reports cache hits at the TOP level
      // (prompt_cache_hit_tokens), unlike OpenAI's nested prompt_tokens_details.
      tokens = {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        cachedTokens: usage.prompt_cache_hit_tokens ?? 0,
        cacheWriteTokens: 0,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
      };
    } else if (isGemini) {
      // candidatesTokenCount is the whole output, text and generated image alike,
      // and the two bill at very different rates ($12 vs $120 per 1M for
      // gemini-3-pro-image). candidatesTokensDetails breaks it down by modality, so
      // the image share is pulled out and the remainder billed as text. A text-only
      // response has no IMAGE entry and reduces to exactly the previous behaviour.
      const outputTotal = usage.candidatesTokenCount ?? 0;
      const imageDetail = (usage.candidatesTokensDetails ?? [])
        .filter(detail => detail?.modality === 'IMAGE')
        .reduce((sum, detail) => sum + (detail.tokenCount ?? 0), 0);
      const outputImageTokens = Math.min(imageDetail, outputTotal);

      tokens = {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: outputTotal - outputImageTokens,
        outputImageTokens,
        cachedTokens: usage.cachedContentTokenCount ?? 0,
        thoughtsTokens: usage.thoughtsTokenCount ?? 0,
      };
    } else if (isOpenRouter) {
      // @openrouter/sdk normalizes provider responses to camelCase. The chat
      // completions API uses promptTokens/completionTokens + promptTokensDetails;
      // the responses API used by @openrouter/agent uses inputTokens/outputTokens +
      // inputTokensDetails. Accept whichever shape was passed in.
      // `cost` is the authoritative billed USD from OpenRouter — we trust it.
      const inputDetails = usage.promptTokensDetails ?? usage.inputTokensDetails;
      tokens = {
        inputTokens: usage.promptTokens ?? usage.inputTokens ?? 0,
        outputTokens: usage.completionTokens ?? usage.outputTokens ?? 0,
        cachedTokens: inputDetails?.cachedTokens ?? 0,
        cacheWriteTokens: inputDetails?.cacheWriteTokens ?? 0,
        providerCost: typeof usage.cost === 'number' ? usage.cost : null,
      };
    } else {
      throw new Error('Unknown provider: "' + provider + '"');
    }

    const costs = this.#calculateCost(provider, model, tokens);
    const fmt = (n, cost) => cost != null ? `${n}($${cost.toFixed(6)})` : `${n}`;
    
    const clientTag = this.clientId ? ` client=${this.clientId}` : '';
    const clientKeyTag = clientKey ? ' [clientKey]' : '';

    if (isAnthropic) {
      logger.log(
        `[usage:${provider}]` +
        clientTag +
        clientKeyTag +
        ` input=${fmt(tokens.inputTokens, costs?.inputTokens)}` +
        ` output=${fmt(tokens.outputTokens, costs?.outputTokens)}` +
        ` cache_write_5m=${fmt(tokens.cacheCreation5mInputTokens, costs?.cacheCreation5mInputTokens)}` +
        ` cache_write_1h=${fmt(tokens.cacheCreation1hInputTokens, costs?.cacheCreation1hInputTokens)}` +
        ` cache_read=${fmt(tokens.cacheReadInputTokens, costs?.cacheReadInputTokens)}` +
        (costs ? ` total=$${costs.total.toFixed(6)}` : '')
      );
    } else if (isOpenAI || isDeepSeek) {
      // DeepSeek's usage shape maps onto the OpenAI log line (input/output/
      // cached/reasoning), so both providers share it.
      logger.log(
        `[usage:${provider}]` +
        clientTag +
        clientKeyTag +
        ` input=${fmt(tokens.inputTokens, costs?.inputTokens)}` +
        ` output=${fmt(tokens.outputTokens, costs?.outputTokens)}` +
        ` cached=${fmt(tokens.cachedTokens, costs?.cachedTokens)}` +
        ` cache_write=${fmt(tokens.cacheWriteTokens, costs?.cacheWriteTokens)}` +
        ` reasoning=${tokens.reasoningTokens}` +
        (costs ? ` total=$${costs.total.toFixed(6)}` : '')
      );
    } else if (isOpenRouter) {
      // OpenRouter returns an authoritative usage.cost, so we don't compute per-component
      // costs locally — just log raw token counts plus the provider-reported total.
      logger.log(
        `[usage:${provider}]` +
        clientTag +
        clientKeyTag +
        ` input=${tokens.inputTokens}` +
        ` output=${tokens.outputTokens}` +
        ` cached=${tokens.cachedTokens}` +
        ` cache_write=${tokens.cacheWriteTokens}` +
        (costs ? ` total=$${costs.total.toFixed(6)}` : '')
      );
    } else {
      logger.log(
        `[usage:${provider}]` +
        clientTag +
        clientKeyTag +
        ` input=${fmt(tokens.inputTokens, costs?.inputTokens)}` +
        ` output=${fmt(tokens.outputTokens, costs?.outputTokens)}` +
        ` cached=${fmt(tokens.cachedTokens, costs?.cachedTokens)}` +
        ` thoughts=${fmt(tokens.thoughtsTokens, costs?.thoughtsTokens)}` +
        // Only for a generation that actually produced a picture, so an ordinary
        // text turn's log line is unchanged.
        (tokens.outputImageTokens
          ? ` output_image=${fmt(tokens.outputImageTokens, costs?.outputImageTokens)}`
          : '') +
        (costs ? ` total=$${costs.total.toFixed(6)}` : '')
      );
    }

    if (!this.url) return;

    const reportData = {
      clientId: this.clientId,
      provider,
      model,
      tokens,
      cost: costs?.total ?? null,
      timestamp: new Date().toISOString(),
      clientKey
    };

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reportData),
      });

      if (!response.ok) {
        console.error(`TokenUsageReporter: Failed to POST to ${this.url}. Status: ${response.status}`);
      }
    } catch (error) {
      console.error(`TokenUsageReporter: Error posting to ${this.url}:`, error.message);
    }
  }

  /**
   * @param {string} provider - use Provider enum
   * @param {string} model
   * @param {Object} tokens
   * @returns {{ total: number, [key: string]: number }|null}
   */
  #calculateCost(provider, model, tokens) {
    // OpenRouter publishes the authoritative billed USD on the response itself,
    // so we skip the local pricing table entirely and trust that value.
    if (provider === Provider.OPENROUTER) {
      return typeof tokens.providerCost === 'number' ? { total: tokens.providerCost } : null;
    }

    const pricing = getPricing(provider, model, tokens.inputTokens);
    if (!pricing) return null;

    const per = (count, rate) => (count / 1_000_000) * rate;

    if (provider === Provider.ANTHROPIC) {
      const inputTokens = per(tokens.inputTokens, pricing.inputTokens);
      const outputTokens = per(tokens.outputTokens, pricing.outputTokens);
      const cacheCreation5mInputTokens = per(tokens.cacheCreation5mInputTokens, pricing.cacheCreation5mInputTokens);
      const cacheCreation1hInputTokens = per(tokens.cacheCreation1hInputTokens, pricing.cacheCreation1hInputTokens);
      const cacheReadInputTokens = per(tokens.cacheReadInputTokens, pricing.cacheReadInputTokens);
      return {
        inputTokens,
        outputTokens,
        cacheCreation5mInputTokens,
        cacheCreation1hInputTokens,
        cacheReadInputTokens,
        total: inputTokens + outputTokens + cacheCreation5mInputTokens + cacheCreation1hInputTokens + cacheReadInputTokens,
      };
    }

    if (provider === Provider.GOOGLE) {
      // cachedTokens are a subset of inputTokens; bill non-cached at full rate, cached at reduced rate
      // thoughtsTokens are separate from outputTokens and billed at the output rate
      const nonCached = tokens.inputTokens - tokens.cachedTokens;
      const inputTokens = per(nonCached, pricing.inputTokens);
      const cachedTokens = per(tokens.cachedTokens, pricing.cachedTokens);
      const outputTokens = per(tokens.outputTokens, pricing.outputTokens);
      const thoughtsTokens = per(tokens.thoughtsTokens, pricing.outputTokens);
      // Generated image output, at its own much higher rate. A text-only model has
      // no outputImageTokens rate and reports no image tokens, so this is 0 and the
      // arithmetic is unchanged.
      const outputImageTokens = per(tokens.outputImageTokens ?? 0, pricing.outputImageTokens ?? 0);
      return {
        inputTokens,
        cachedTokens,
        outputTokens,
        thoughtsTokens,
        outputImageTokens,
        total: inputTokens + cachedTokens + outputTokens + thoughtsTokens + outputImageTokens,
      };
    }

    // openai (and unknown providers, which fall back to openai pricing)
    // cachedTokens (read from cache) and cacheWriteTokens (written to cache, GPT-5.6+)
    // are disjoint subsets of inputTokens: cache writes bill at 1.25x input IN PLACE OF
    // the normal input charge, so they're subtracted from the full-rate bucket too.
    // Models without cache-write pricing report 0 write tokens (rate defaults to 0), so
    // this reduces to the prior behavior. reasoningTokens are already in completion_tokens.
    const cacheWriteTokenCount = tokens.cacheWriteTokens ?? 0;
    const cacheWriteRate = pricing.cacheWriteTokens ?? 0;
    const nonCached = tokens.inputTokens - tokens.cachedTokens - cacheWriteTokenCount;
    const inputTokens = per(nonCached, pricing.inputTokens);
    const cachedTokens = per(tokens.cachedTokens, pricing.cachedTokens);
    const cacheWriteTokens = per(cacheWriteTokenCount, cacheWriteRate);
    const outputTokens = per(tokens.outputTokens, pricing.outputTokens);
    return {
      inputTokens,
      cachedTokens,
      cacheWriteTokens,
      outputTokens,
      total: inputTokens + cachedTokens + cacheWriteTokens + outputTokens,
    };
  }
}

export default TokenUsageReporter;
