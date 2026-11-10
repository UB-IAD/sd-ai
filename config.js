import { ThinkingLevel } from "@google/genai";


const config = {
    "port": process.env.PORT || 3000,
    "websocketPort": process.env.WEBSOCKET_PORT || 3000,
    // Maximum size (bytes) of a single WebSocket frame. Caps client uploads
    // (add_file content is sent inline). Without this the `ws` library defaults
    // to ~100 MiB silently; set it explicitly so the ceiling is tunable here.
    "websocketMaxPayloadBytes": Number(process.env.WEBSOCKET_MAX_PAYLOAD_BYTES) || 100 * 1024 * 1024,

    /*
    * Reporting URLs
    */
    "metricsReporterURL": process.env.METRICS_REPORTER_URL || null, // Optional URL to POST engine usage metrics
    "tokenReporterURL": process.env.TOKEN_REPORTER_URL || null, // Optional URL to POST agent LLM token usage

    /*
    * Engine exposure
    */
    "includeTestEngines": false, // When true, engines whose directory starts with `test-` are returned by GET /v1/engines
    
    /*
    * Defaults for the engines that use LLMWrapper and the agent tools that use those engines
    */
    "buildDefaultModel": 'gemini-3.8-flash', //LLMWrapper underlyingModel default for building model tools
    "nonBuildDefaultModel": 'gemini-3.8-flash', //LLMWrapper underlyingModel default for non-building model tools
    "evalModel": "gemini-3.8-flash", //LLMWrapper underlyingModel default used for judging LLM repsonses during eval runs

    /*
    * Every model the engines expose in the `underlyingModel` combobox, in display
    * order. `label` is the UI text, `value` is the id LLMWrapper routes on — and that
    * routing is by shape, not by an explicit provider field (see ModelCapabilities.kind):
    * a namespaced `<provider>/<model>` slug goes to OpenRouter, while a bare id is
    * matched by substring to its vendor's own API. So 'deepseek/deepseek-v4-pro' and
    * 'deepseek-v4-pro' are the same model reached two different ways, and both are
    * listed deliberately.
    */
    "models": [
        {label: "GPT-6 Astra", value: 'gpt-6-astra'},
        {label: "GPT-6.1 Sol", value: 'gpt-6.1-sol'},
        {label: "GPT-6 Luna", value: 'gpt-6-luna'},
        {label: "Gemini 4 Argon", value: 'gemini-4-argon'},
        {label: "Gemini 4 Argon high", value: 'gemini-4-argon high'},
        {label: "Gemini 4 Argon medium", value: 'gemini-4-argon medium'},
        {label: "Gemini 4 Argon low", value: 'gemini-4-argon low'},
        {label: "Gemini 3.1-pro-preview", value: 'gemini-3.1-pro-preview'},
        {label: "Gemini 3.8-flash", value: 'gemini-3.8-flash'},
        {label: "Gemini 3.8-flash high", value: 'gemini-3.8-flash high'},
        {label: "Gemini 3.8-flash medium", value: 'gemini-3.8-flash medium'},
        {label: "Gemini 3.8-flash low", value: 'gemini-3.8-flash low'},
        {label: "Gemini 3.7-flash", value: 'gemini-3.7-flash'},
        {label: "Claude Fable 5.2", value: 'claude-fable-5-2'},
        {label: "Claude Fable 5.1", value: 'claude-fable-5-1'},
        {label: "Claude Opus 5.5", value: 'claude-opus-5-5'},
        {label: "Claude Sonnet 5.5", value: 'claude-sonnet-5-5'},
        {label: "Claude Haiku 5.5", value: 'claude-haiku-5-5'},
        {label: "Qwen3.8 Max", value: 'qwen/qwen3.8-max'},
        {label: "Qwen3.7 Plus", value: 'qwen/qwen3.7-plus'},
        {label: "Deepseek v4 Pro", value: 'deepseek/deepseek-v4-pro'},
        {label: "Deepseek v4.1 Flash", value: 'deepseek/deepseek-v4.1-flash'},
        // Native DeepSeek API models (routed directly to DEEPSEEK_API_KEY, not OpenRouter)
        /*{label: "Deepseek v4 Pro (API)", value: 'deepseek-v4-pro'},
        {label: "Deepseek v4 Flash (API)", value: 'deepseek-v4-flash'},*/
        {label: "Kimi K3.1 Pro", value: 'moonshotai/kimi-k3.1-pro'},
        {label: "GLM 5.3", value: 'z-ai/glm-5.3'},
    ],

    /*
    * These settings control the operation of the agents
    */
    "agentSessionTempDir": process.env.AGENT_SESSION_TEMP_DIR || null, // Optional custom temp directory for session files (defaults to OS tmpdir/sd-agent)
    "agentMaxTokensForEngines": 32_000, // Maximum tokens before force switching to file-based editing
    "agentMaxContextTokens": 128_000, // Maximum tokens for conversation history sent to Claude API
    "agentDefaultProvider": 'anthropic', // Default LLM provider when client does not specify one — any id in agentProviders below

    /*
    * Native-API agent providers — the single source of truth for every provider
    * that reaches its vendor's API directly rather than via OpenRouter. Same
    * derivation contract as openRouterAgentProviders: keys are the provider IDs
    * clients send in `select_agent`, `displayName` is the UI label, and
    * `model`/`summaryModel` are the vendor's own model ids (`model` for agent
    * conversations, `summaryModel` for conversation-history summarization).
    *
    * 'anthropic' and 'google' each drive their own vendor SDK and are dispatched by
    * provider id; every other entry here is assumed to speak the OpenAI-compatible
    * chat-completions API and shares one manual loop — so adding another such vendor
    * needs no new code path. Those entries also carry `baseURL`, the host their
    * compatible endpoint lives at: vendors do not follow one naming convention
    * (api.deepseek.com, but api.moonshot.cn / api.z.ai / api.x.ai), and several want
    * an explicit /v1 suffix, so the host is stated here rather than guessed from the
    * provider id — a wrong guess would surface as a DNS failure or 404 on first use
    * instead of a clear config error. null means "the OpenAI SDK's own default host".
    * <PROVIDER>_BASE_URL in the environment overrides whatever is set here, which is
    * what lets a deployment point one at a gateway, proxy or self-hosted endpoint.
    */
    "nativeAgentProviders": {
        anthropic: {
            displayName: 'Claude',
            model: 'claude-sonnet-5-5',
            summaryModel: 'claude-haiku-5-5'
        },
        google: {
            displayName: 'Gemini',
            model: 'gemini-3.8-flash',
            summaryModel: 'gemini-3.5-flash-lite'
        }/*,
        openai: {
            displayName: 'ChatGPT',
            model: 'gpt-5.6-terra',
            summaryModel: 'gpt-5.6-luna',
            baseURL: null
        },
        deepseek: {
            displayName: 'DeepSeek',
            model: 'deepseek-v4-pro',
            summaryModel: 'deepseek-v4-flash',
            baseURL: 'https://api.deepseek.com'
        }
        */
    },
    // OpenRouter-backed agent providers — the single source of truth for every
    // OpenRouter-routed brand. Add or remove an entry here and the whole agent stack
    // picks it up: the orchestrator's model/summary-model resolution, the context
    // summarizer, provider display names, the select_agent provider enum, and the
    // per-agent supported_providers defaults all derive from these keys. Keys are the
    // provider IDs clients send in `select_agent`; `displayName` is the UI label;
    // `model`/`summaryModel` MUST be OpenRouter slugs (provider/model form).
    "openRouterAgentProviders": {
        qwen: {
            displayName: 'Qwen',
            model: 'qwen/qwen3.8-max',
            summaryModel: 'qwen/qwen3.8-max'
        },
        deepseek: {
            displayName: 'Deepseek',
            model: 'deepseek/deepseek-v4-pro',
            summaryModel: 'deepseek/deepseek-v4.1-flash'
        },
        moonshotai: {
            displayName: 'Kimi',
            model: 'moonshotai/kimi-k3.1-pro',
            summaryModel: 'moonshotai/kimi-k3.1-pro'
        },
        zai: {
            displayName: 'GLM',
            model: 'z-ai/glm-5.3',
            summaryModel: 'z-ai/glm-5.3'
        }
    },
    /*
    * Intelligence levels — the client-facing lever that trades money for capability.
    *
    * This block is the single source of truth: the levels that exist, what they are
    * called, and every model behind them. Nothing about levels is hard-coded in code,
    * so adding a rung — or renaming one, or giving a provider its own vocabulary — is
    * a config edit and a restart, with no code change and no client release.
    *
    * Ladders are PER PROVIDER and ordered low -> high. A provider absent from
    * `providers` ignores the lever entirely and keeps its nativeAgentProviders model:
    * that absence IS the "providers that support it" gate, which is why the OpenRouter
    * brands need no entry and no special case. Levels are matched by `id`, never by
    * position, so two providers may name their rungs differently; a client asking for
    * an id the selected provider does not offer gets that provider's default rather
    * than an error.
    *
    * Per level:
    *   id            required — the value the client sends back on select_agent /
    *                 set_intelligence.
    *   label         optional — UI text. Defaults to a title-cased id.
    *   description   optional — client tooltip.
    *   model         required — the conversation model.
    *   effort        OPTIONAL — omit to send NO effort/thinking parameter at all and
    *                 let the provider apply its own default. Omitting is not the same
    *                 as sending a low value, which is why it is expressible here.
    *   thinking      optional — provider-shaped override of agentAnthropicThinking.
    *   relativeCost  optional — overrides the multiplier derived from pricing.js.
    *   toolModels    optional — engine-tool lanes for this rung, same shape as an
    *                 agentToolModels lane; falls back to agentToolModels below.
    *
    * The floor is the default: the first level of each ladder reproduces today's
    * behaviour exactly, and there is deliberately no rung below it. Haiku stays
    * unreachable from here — it remains the server-internal summaryModel.
    */
    "agentIntelligence": {
        // Level id used when a client sends nothing. A provider whose ladder lacks
        // this id falls back to the first level it does define.
        defaultLevel: 'standard',
        providers: {
            anthropic: [
                { id: 'standard', label: 'Standard',
                  description: 'Balanced quality and cost. Recommended for most work.',
                  model: 'claude-sonnet-5-5' },
                { id: 'high', label: 'High',
                  description: 'A more capable model with deeper reasoning.',
                  model: 'claude-opus-5-5', effort: 'high' },
                // No effort on standard or maximum: use each model's own default depth.
                { id: 'maximum', label: 'Maximum',
                  description: 'The most capable model available. Use it for the hardest problems.',
                  model: 'claude-fable-5-2' }
            ],
            google: [
                { id: 'standard', label: 'Standard',
                  description: 'Balanced quality and cost. Recommended for most work.',
                  model: 'gemini-3.8-flash', effort: ThinkingLevel.MEDIUM },
                // Same model as `standard`, so the price-derived multiplier would be
                // 1.0 — but it thinks longer and therefore bills more tokens. State the
                // cost explicitly; an effort-only step is exactly what derivation misses.
                { id: 'high', label: 'High',
                  description: 'The same model thinking harder before it answers.',
                  model: 'gemini-3.8-flash', effort: ThinkingLevel.HIGH, relativeCost: 1.5 },
                // No effort: let the pro model pick its own thinking level.
                // Priced-derived would be ~1.65x on the pro model's first input tier,
                // which both collides with `high` above and ignores that it thinks more
                // and bills the higher tier on long conversations. State it explicitly.
                { id: 'maximum', label: 'Maximum',
                  description: 'The most capable model available. Use it for the hardest problems.',
                  model: 'gemini-3.1-pro-preview', relativeCost: 2.5 }
            ],
            // nativeAgentProviders.openai is commented out today; this ladder is here
            // so re-enabling that provider is a one-line change rather than two. It is
            // not advertised while the provider is disabled — buildIntelligenceDiscovery
            // filters byProvider to agentProviders, so a parked ladder never offers the
            // client a control for a provider select_agent would reject.
            //
            // NOTE: no `effort` on any rung, and that is not an oversight. This provider
            // runs through the shared OpenAI-compatible chat-completions loop, which
            // pins reasoning_effort to 'none' because GPT-5.6 refuses function tools
            // while reasoning is on (see reasoningParams in agent/utilities/nativeProviders.js)
            // and every agent request carries tools. So the lever moves the model only,
            // which is why there are two rungs here rather than three — a third would
            // have to repeat a model and would be indistinguishable from the second.
            openai: [
                { id: 'standard', label: 'Standard',
                  description: 'Balanced quality and cost. Recommended for most work.',
                  model: 'gpt-5.6-terra' },
                { id: 'high', label: 'High',
                  description: 'The most capable model available. Use it for the hardest problems.',
                  model: 'gpt-5.6-sol' }
            ]
        }
    },

    // Underlying model the engine tools use, by provider then by intelligence level.
    // `default` is the fallback for every provider (including the OpenRouter brands in
    // openRouterAgentProviders), so a newly added provider works with no extra config.
    // Within a provider, lanes are keyed by intelligence level id; a level that names
    // its own `toolModels` in agentIntelligence wins over anything here, and a level id
    // with no lane falls back to the `defaultLevel` lane — which is what lets a provider
    // use its own rung vocabulary without duplicating this whole table.
    // To override the models for a specific provider, add a key matching that provider
    // id alongside `default`, e.g.:
    //   anthropic: {
    //       standard: {
    //           build:    { normal: 'claude-sonnet-4-6', hard: 'claude-opus-4-8' },
    //           nonBuild: { normal: 'claude-haiku-4-5', hard: 'claude-sonnet-4-6' }
    //       }
    //   },
    "agentToolModels": {
        default: {
            standard: {
                build:    { normal: 'gemini-3.8-flash low', hard: 'gemini-3.8-flash high' },
                nonBuild: { normal: 'gemini-3.8-flash low', hard: 'gemini-3.8-flash high' }
            },
            high: {
                build:    { normal: 'gemini-3.8-flash high', hard: 'gemini-3.1-pro-preview high' },
                nonBuild: { normal: 'gemini-3.8-flash high', hard: 'gemini-3.8-flash high' }
            },
            maximum: {
                build:    { normal: 'gemini-3.1-pro-preview high', hard: 'gemini-3.1-pro-preview high' },
                nonBuild: { normal: 'gemini-3.1-pro-preview high', hard: 'gemini-3.1-pro-preview high' }
            }
        }
    },
    // Full ordered list of valid agent provider IDs: every native-API brand plus every
    // OpenRouter-backed brand above. A getter so it always tracks the registries —
    // adding/removing a brand above is the only edit needed. Drives the select_agent
    // provider enum and the per-agent supported_providers defaults.
    get agentProviders() {
        return [...Object.keys(this.nativeAgentProviders), ...Object.keys(this.openRouterAgentProviders)];
    },
    // Thinking fallbacks for a provider with NO agentIntelligence ladder. Effort has
    // no fallback: a provider without a ladder, or a level that omits effort, sends
    // none and gets the provider's own default.
    "agentAnthropicThinking": { type: "adaptive" }, // Opus 4.7+/Sonnet 4.6 use adaptive thinking; depth is controlled by effort (budget_tokens is removed and 400s)
    "agentGeminiThinking": { thinkingLevel: ThinkingLevel.MEDIUM },
    /*
    * Retrieval-Augmented Generation (RAG). Clients attach files over the
    * WebSocket; the worker extracts text, reads small files in full and
    * chunks+embeds large ones for semantic search via the search_documents tool.
    * Embeddings use a Gemini model (decoupled from the chat provider) so
    * retrieval is identical across every agent route.
    */
    "ragMaxFileBytes": Number(process.env.RAG_MAX_FILE_BYTES) || 50 * 1024 * 1024, // Per-file upload cap (decoded bytes)
    "ragMaxFilesPerSession": Number(process.env.RAG_MAX_FILES_PER_SESSION) || 25, // Max attached files per session
    "ragEmbeddingModel": 'gemini-embedding-2', // Gemini embedding model (reuses GEMINI_API_KEY; no extra key needed)
    "ragEmbeddingDimensions": 768, // outputDimensionality for embeddings (smaller vectors → lighter storage)
    "ragManifestMaxTokens": 4000, // Files at/under this token count are read in full; larger files are chunked + embedded
    "ragChunkTokens": 600, // Target tokens per chunk for vector-tier files
    "ragChunkOverlap": 80, // Token overlap between adjacent chunks
    "ragSearchTopK": 8, // Default number of chunks returned by search_documents
    /*
    * Binary media (images) exchanged with client tools and produced by generate_image.
    * Bytes live under <sessionTempDir>/media/<mediaId>/; the model, the IPC channel and
    * conversation history all carry only the opaque handle, never base64.
    *
    * mediaAllowedMimeTypes is the intersection of what every provider route can render
    * AND what the desktop client can decode, so a handle that exists is renderable
    * everywhere rather than only on the route that produced it.
    */
    "mediaMaxItemBytes": Number(process.env.MEDIA_MAX_ITEM_BYTES) || 20 * 1024 * 1024, // Per-image cap (decoded bytes)
    "mediaMaxItemsPerCall": 4, // Max images attached to one tool call or result
    "mediaMaxItemsPerSession": Number(process.env.MEDIA_MAX_ITEMS_PER_SESSION) || 50, // Oldest are pruned past this
    "mediaAllowedMimeTypes": ['image/png', 'image/jpeg', 'image/gif'],
    "mediaMaxImagesInContext": 4, // Images hydrated into any one provider call (newest first)
    "mediaMaxHydratedBytes": 8 * 1024 * 1024, // Total image bytes hydrated into any one provider call
    "mediaImageModels": { default: 'gemini-3.1-flash-image' }, // Per-provider override lane, like selectEngineModel's
    "mediaImageMaxCount": 1 // Images returned by one generate_image call

};

export default config
