# SD-AI
Open source repository for the [SD-AI Project](https://ub-iad.github.io/sd-ai/). 

Contains the engines used by [Stella](https://www.iseesystems.com/store/products/stella-architect.aspx) & [CoModel](https://comodel.io), evaluations used to test those engines and a frontend used to explore those evaluations and engines.

# Architecture and Data Structures 
- sd-ai is a NodeJS Express app with simple JSON-encoded HTTP API
- all AI functionality in sd-ai is implemented as an "engine"
- an engine is a javascript class that can implement ai functionality using any libraries/apis supported by javascript
    - `/engines` folder contains examples including the simplest possible engine: `predprey` and engines like `qualitative`, `quantitative`, and `seldon`
- sd-ai wraps engines to provides endpoints to:
    - list all engines
    - list parameters required/supported by each specific engine
    - generating a model using a specific engine
- all engines can be automatically tested for quality using `evals`

## Engine
- an engine only needs to do 2 things:
    - provide a function to generate a model based on a prompt
    - tell us what additional parameters users can pass to it

### Additional Parameters
- defined via `additionalParameters()` function on each engine class
- format specifically crafted to allow your engine to be automatically incorporated into the Stella GUI and the sd-ai website

#### API Example
- `GET` `/api/v1/engines/:engine/parameters`
- Returns 
```
{ 
    success: <bool>, 
    parameters:[{
        name: <string, unique name for the parmater that is passed to generate call>,
        type: <string, string|number|boolean>,
        required: <boolean, whether or not this parameter must be passed to the generate call>,
        uiElement: <string, type of UI element the client should use so that the user can enter this value.  Valid values are textarea|lineedit|password|combobox|hidden|checkbox>,
        label: <string, name to put next to the UI element in the client>,
        description: <string, description of what this parameter does, used as a tooltip or placeholder text in the client>,
        defaultValue: <string, default value for this parameter if there is one, otherwise skipped>,
        options: <array, of objects with two attributes 'label' and 'value' only used if 'uiElement' is combobox>,
        saveForUser: <string, whether or not this field should be saved for the user by the client, valid values are local|global leave unspecified if not saved>,
        minHeight: <int, NOT REQUIRED, default 100 only relevant if 'uiElement' is textarea -- this is the minimum height of that text area>,
        maxHeight: <int, NOT REQUIRED, default intmax, only relevant if 'uiElement' is textarea -- this is the maximum height of that text area>
    }] 
}
```

### Generate
- does the job of diagram generation, it's the workhorse of the engine
- defined via `generate(prompt, currentModel, parameters)` function on each engine class
- a complete diagram should be returned by each request, even if that just means returning an empty diagram or the same diagram the user passed in via `currentModel`
  
#### API Example
- `POST` `/api/v1/:engine/generate`
- JSON data
```
{
    "prompt": "", # Requested model or changes to model to be provided to the AI
    "currentModel": { "relationships": [], "variables": []} # Optional sd-json representation of the current model
    ....
    # additionalParameters given by `/api/v1/:engine/parameters`
}
```
- Returns
```
{
    success: <bool>,
    model: {variables: [], relationships: [], specs?: {} },
    supportingInfo?: {} # only provided if supported by engine
}
```

## SD-JSON
```
{
    variables: [{
        name: <string>,
        type: <string>, # stock|flow|variable
        equation?: <string>,
        documentation?: <string>,
        units?: <string>,
        uniflow?: <boolean>, # For flows only: true if flow should never be negative
        inflows?: Array<string>,
        outflows?: Array<string>,
        dimensions?: Array<string>, # Array of dimension names for arrayed variables
        arrayEquations?: [{ # Used for arrayed variables with element-specific equations
            equation: <string>,
            forElements: Array<string> # Array element names matching dimensions
        }],
        crossLevelGhostOf?: <string>, # For modular models: references source variable
        graphicalFunction?: {
            points: [
                {x: <number>, y: <number>}
                ...
            ]
        },
        subType?: <string>, # Discrete-entity sub-type (see below)
        additionalProperties?: { # Sub-type-specific settings (see below) }
    }],
    relationships: [{
        reasoning?: <string>, # Explanation for why this relationship is here
        from: <string>, # The variable the connection starts with
        to: <string>, # The variable the connection ends with
        polarity: <string>, # "+" or "-" or ""
        polarityReasoning?: <string> # Explanation for why this polarity was chosen
    }],
    modules?: [{ # Module definitions for hierarchical model organization
        name: <string>, # Simple module name (alphanumeric + underscores only)
        parentModule: <string> # Parent module name (empty string if top-level)
    }],
    specs?: {
        startTime: <number>,
        stopTime: <number>,
        dt?: <number>,
        timeUnits?: <string>,
        integrationMethod?: <string>, # "Euler" or "RK4"
        arrayDimensions?: [{ # Array dimension definitions (all four fields required)
            type: <string>, # "numeric" or "labels" - numeric auto-generates element names as strings ('1','2','3'), labels use user-defined meaningful names
            name: <string>, # Singular, alphanumeric dimension name (e.g., "region" not "regions")
            size: <number>, # Positive integer - number of elements in dimension
            elements: Array<string> # Element names - for numeric: auto-generated ['1','2','3'], for labels: user-defined ['North','South','East','West']
        }]
    },
    errors?: Array<string>, # Client-populated diagnostics: validation/simulation errors on the current model state
    unitWarnings?: Array<string> # Client-populated diagnostics: results of the engine's unit-consistency check
}
```
? denotes an optional attribute

### Model diagnostics: `errors` and `unitWarnings`
`errors` and `unitWarnings` are **client-populated** fields returned on the model (e.g. by `get_current_model`). They are set by the client's simulation engine — the server never computes them — and are the **authoritative** source of truth for a model's validation state:

- **`errors`** — an array of validation/simulation error strings for the current model state.
- **`unitWarnings`** — an array of the engine's unit- (dimensional-) consistency warnings.

For both fields, distinguish two "clean" cases:

| Value | Meaning |
| --- | --- |
| Present, non-empty (`["…"]`) | The engine ran the check and found these problems. Report/fix them. |
| Present, empty (`[]`) | The engine ran the check and found **no** problems. The model is clean on that dimension. |
| Absent (field omitted) | The client did not report a check — status unknown. Do not assume a result either way. |

Because these fields are authoritative, the AI agents must **never** infer or fabricate errors or unit warnings from a model's `units` strings, variable names, or equations — a warning is reported to the user only if it appears in these fields. An empty or absent `unitWarnings` array means there are no unit warnings to report, however the human-readable `units` may read.

### Arrays in SD-JSON
Variables can be arrayed over one or more dimensions to create multi-dimensional arrays:
- **Dimensions**: Defined in `specs.arrayDimensions` with all four required fields:
  - `type`: Either "numeric" (auto-generates elements as '1','2','3') or "labels" (user-defined element names)
  - `name`: Singular, alphanumeric dimension name (e.g., "region" not "regions")
  - `size`: Positive integer count of elements
  - `elements`: Array of element names matching the size
- **Arrayed Variables**: Reference dimensions by name in their `dimensions` array (order matters)
- **Array Equations**:
  - If all elements use the SAME formula: uses `equation` field only
  - If elements have DIFFERENT formulas OR for arrayed STOCKS: uses `arrayEquations` array with element-specific equations
  - Each `arrayEquations` entry has `equation` and `forElements` (ordered to match the variable's dimensions list)

### Modules in SD-JSON
Models can be organized into modules for better structure and encapsulation:
- **Module Definition**: Modules are defined in the top-level `modules` array:
  - `name`: Simple module name (alphanumeric + underscores, no spaces, never module-qualified)
  - `parentModule`: Name of containing module (empty string for top-level modules)
  - Modules can be nested to create hierarchical structures
- **Module Naming in Variables**: Use dot notation: `ModuleName.variableName` (e.g., `Hares.population`, `Lynx.births`)
- **Ghost Variables**: For inter-module references, create cross-level ghost variables:
  - Set `crossLevelGhostOf` to the fully qualified source variable name
  - Leave `equation` field empty (empty string)
  - Ghost variable has same local name as source but exists in consuming module
  - All equations in consuming module reference the ghost, not the original source

### Discrete-Entity Sub-Types in SD-JSON
Variables can have a `subType` field that further classifies them. Sub-types are a refinement of `type` — the top-level `type` field remains `"stock"`, `"flow"`, or `"variable"`.

**Stock sub-types** — also set `additionalProperties` with the relevant configuration:

| `subType` | Description |
|-----------|-------------|
| `"queue"` | A waiting line that holds discrete items until they are dispatched. |
| `"oven"` | A batch processor where items are held for a fixed cook time then released together. |
| `"conveyor"` | A pipeline delay where items travel a fixed transit time before exiting from the other end. |

**Flow sub-types** — automatically managed flows. Set `subType` only; leave `equation` as an empty string:

| `subType` | Description |
|-----------|-------------|
| `"discreteOutflow"` | The output flow from a conveyor or oven. |
| `"conveyorLeakage"` | The leakage flow from a conveyor. Set `additionalProperties` to configure leakage behavior. |
| `"queueOutflow"` | The output flow from a queue. |
| `"queueOverflow"` | The overflow flow emitted when a full queue cannot accept new items (requires `overflow: true` on the queue). |

**Variable sub-types** — set `subType` on plain `"variable"` type entities:

| `subType` | Description |
|-----------|-------------|
| `"delayVariable"` | A plain variable whose equation contains a `DELAY` or `SMTH` builtin function (e.g. `DELAY1`, `DELAY3`, `DELAY N`, `SMTH1`, `SMTH3`). Set this whenever any DELAY or SMTH variant appears in the equation. |

**`additionalProperties`** fields for conveyor and oven stocks:

| Field | Type | Applies to | Description |
|-------|------|------------|-------------|
| `processTime` | string (equation) | conveyor, oven | Transit time (conveyor) or cook time (oven). Required. |
| `capacity` | string (equation) | conveyor, oven | Maximum number of items the element can hold. |
| `inflowLimit` | string (equation) | conveyor, oven | Maximum inflow rate per time step. |
| `fillTime` | string (equation) | oven only | Time to fill the element before processing begins. |
| `cleanTime` | string (equation) | oven only | Clean-up time after emptying before accepting new items. |
| `sample` | string (equation) | conveyor, oven | Re-samples transit/cook time when this expression is non-zero. |
| `arrest` | string (equation) | conveyor, oven | Halts movement when this expression is non-zero. |
| `oneAtATime` | boolean | If true, accepts only one batch per time step. |
| `splitBatches` | boolean | If true, incoming batches can be split when entering. |

**`additionalProperties`** fields for regular flows (inflows to a conveyor):

| Field | Type | Description |
|-------|------|-------------|
| `spreadFlow` | string enum | How this flow distributes along the conveyor when it enters: `"none"` (default, front-entry), `"even"`, `"destination"`, `"distribution"` (requires `distribEq`), `"source"`. |
| `distribEq` | string (equation) | Distribution table equation. Required when `spreadFlow` is `"distribution"`. |

**`additionalProperties`** fields for `conveyorLeakage` flows:

| Field | Type | Description |
|-------|------|-------------|
| `leakFraction` | string (equation) | Fraction of conveyor contents that leak out per time step. |
| `exponential` | boolean | If true, leakage is exponential (constant fraction); if false (default), linear. |
| `leakZoneStart` | string (equation) | Start position (0–100%) along the conveyor where leakage begins. Leave empty for leakage across the entire length. |
| `leakZoneEnd` | string (equation) | End position (0–100%) along the conveyor where leakage ends. Leave empty for leakage across the entire length. |
| `leakIntegers` | boolean | If true, leakage amounts are rounded to whole integers. |
| `ignorePrevZones` | boolean | If true, each leak zone operates independently of losses from earlier zones. |
| `forceLeakFraction` | boolean | If true, the same leak fraction is applied regardless of transit duration. |

**`additionalProperties`** fields for queue stocks:

| Field | Type | Description |
|-------|------|-------------|
| `fifoEnabled` | boolean | If true, dispatches in FIFO order; if false (default), LIFO. |
| `discrete` | boolean | If true, operates on integer quantities only (discrete mode). |
| `roundRobin` | boolean | If true, competing outflows are served in round-robin order. |
| `queueOutflowPriority` | string (equation) | Dispatch priority for the queue outflow. |
| `purgeEq` | string (equation) | Items older than this age (in time units) are automatically removed. |
| `overflow` | boolean | If true, a `queueOverflow` flow is automatically created for excess items. |

## Discussion Engine JSON response
```
{
    output: {
        textContent: <string, the response to the query from the user>
    }
}
```  

## Discussion Engine Feedback JSON input
```
{
    feedbackLoops: [{
        identifier: <string>,
        name: <string>,
        links: [
            { from: <string>, to: <string>, polarity: <string - +|-|? > }
            ...
        ],
        polarity: <string +|-|?>,
        loopset?: <number> 
        “Percent of Model Behavior Explained By Loop”?: [
            { time: <number>, value: <number> }
            ...
        ]
    }],
    dominantLoopsByPeriod?: [{
        dominantLoops: Array<string>,
        startTime: <number>,
        endTime: <number>
    }]   
}
```

# WebSocket AI Agent

The `agent/` directory contains a WebSocket server that wraps the SD-AI engines in a conversational AI agent for building and modifying System Dynamics models interactively.

**Key characteristics:**
- Stateless — all model state, run data, and conversation history live on the client
- All core tools are built-in (get/update model, run simulation, fetch variable data, feedback loops, visualizations)
- Clients can optionally register custom tools for application-specific behavior
- Agent personalities are configured via Markdown files in `agent/config/`
- Visualizations are returned as raw SVG strings

**WebSocket endpoint:** `ws://localhost:3000/api/v1/agent`

**Protocol summary:** client connects → `initialize_session` (model type + initial model) → `session_ready` (agent list) → `select_agent` → `chat` messages → agent responds with `agent_text`, `visualization`, and `tool_call_request` messages that the client must answer.

## File Attachments (RAG)

Clients can attach reference documents (text, Markdown, CSV, JSON, source code, and binary docs — PDF/DOCX/XLSX) to a session and the agent will use them on **every** provider/route:

- **`add_file` / `remove_file`** messages send file content inline (UTF-8 or base64). The server replies with `file_added` / `file_removed` messages carrying a full snapshot of the currently attached files.
- **Hybrid retrieval:** small files are read in full by the agent; large files are chunked, embedded, and reached via the universal `search_documents` tool. Embeddings use a **Gemini** embedding model (`config.ragEmbeddingModel`, default `gemini-embedding-2`) — this reuses the existing `GEMINI_API_KEY`, so **no additional API key is required** — and is decoupled from the chat provider.
- **Relevant config keys** (`config.js`): `websocketMaxPayloadBytes`, `ragMaxFileBytes`, `ragMaxFilesPerSession`, `ragEmbeddingModel`, `ragEmbeddingDimensions`, `ragManifestMaxTokens`, `ragChunkTokens`, `ragChunkOverlap`, `ragSearchTopK`.
- **Extraction dependencies:** `pdfjs-dist` (PDF), `mammoth` (DOCX), `xlsx` (XLSX).

## Images

The agent can generate a picture, hand it to a client tool, and look at one a client tool returns.

- **`generate_image`** draws an image with an image-generation model (`config.mediaImageModels`) and returns an opaque **handle**, never bytes. **`view_media`** shows a handle to the model again — which is how a picture survives an agent switch, a summarised conversation, or the per-call hydration budget.
- **Client tools** declare a `media` contract beside their `inputSchema`: `inputs` names the arguments that take a handle, `returnsMedia` says the tool may answer with a picture. The server swaps handles for bytes on the way out and captures returned bytes into handles on the way back, so **the model never sees base64** — and neither does conversation history, the token count, the summariser, the worker IPC channel or the client's tool log.
- **Both built-ins are opt-in, twice over.** The client sets `supportsMedia: true` on `initialize_session` (it can display a picture) *and* registers at least one tool with a `media` contract (there is somewhere for a picture to go). `generate_image` needs a tool with `media.inputs`; `view_media` needs that or a `returnsMedia` tool. Neither condition mentions an agent, which is the point: Stella registers its media tools only for interface authoring, so a modeling session with Merlin or Socrates is never offered an image generator whose handle has no destination. The predicate is `isToolAvailable` in `agent/tools/toolAvailability.js`, shared by every provider route.
- **Every provider route renders it natively**: Anthropic image blocks, Gemini `inlineData`, OpenAI-style `image_url` data URIs, MCP image content, and the ADK route via `beforeModelCallback`. Bytes are attached to a transient copy at the moment a request is built and thrown away with it.
- **Relevant config keys** (`config.js`): `mediaMaxItemBytes`, `mediaMaxItemsPerCall`, `mediaMaxItemsPerSession`, `mediaAllowedMimeTypes`, `mediaMaxImagesInContext`, `mediaMaxHydratedBytes`, `mediaImageModels`, `mediaImageMaxCount`.
- **Cost:** an image model bills output at two rates — text/thinking, and the generated image at up to 10× that. `TokenUsageReporter` splits `candidatesTokenCount` by modality so a generation is not under-reported tenfold; the image rate is `outputImageTokens` in `utilities/pricing.js`.

See [agent/README.md](agent/README.md) for the full WebSocket protocol, all message types, tool call request/response formats, and example client implementation.

# Setup
1. fork this repo and git clone your fork locally
2. create an `.env` file at the top level which has the following keys:
```
OPENAI_API_KEY="sk-asdjkshd" # if you're doing work with engines that use the LLMWrapper class in utils.js (quantitative, qualitative, seldon, etc.)
GEMINI_API_KEY="asdjkshd" # if you're doing work with engines using Gemini models (causal-chains, seldon, quantitative, qualitative)
ANTHROPIC_API_KEY="sk-ant-asdjkshd" # if you're using Claude models for engines or the agent
OPEN_ROUTER_API_KEY="sk-or-asdjkshd" # if you're using OpenRouter-routed models (Qwen, Deepseek, Kimi) for engines or the agent
DEEPSEEK_API_KEY="sk-asdjkshd" # if you're using DeepSeek's native API for engines (qualitative, quantitative, seldon, etc.) with the bare 'deepseek-v4-pro' / 'deepseek-v4-flash' models
DEEPSEEK_BASE_URL="https://api.deepseek.com" # optional override for the native DeepSeek API base URL (e.g. an OpenAI-compatible gateway)
AUTHENTICATION_KEY="my_secret_key" # only needed for securing publically accessible deployments. Requires client pass an Authentication header matching this value. e.g. `curl -H "Authentication: my_super_secret_value_in_env_file"` to the engine generate request only
REPORTER_URL="https://your-metrics-server.com/api/metrics" # optional URL to POST engine usage metrics to. If not set, metrics reporting is disabled.
TOKEN_REPORTER_URL="https://your-metrics-server.com/api/token-usage" # optional URL to POST agent LLM token usage and cost to. If not set, token reporting is disabled.
```
3. npm install
4. npm start
5. (optional) npm run evals -- -e evals/experiments/careful.json
6. (optional) npm test
7. (optional) npm test:coverage

We recommend VSCode using a launch.json for the Node type applications (you get a debugger, and hot-reloading)

## Optional Third-Party Requirements
Some engines require additional dependencies to be installed on your system:

- **Go 1.24.0 or later** - Required for the causal-chains engine ([installation guide](https://go.dev/doc/install))
- **Python 3.x** - Required for the causal-decoder engine and the and the agentic tools
- **Docker** (or Podman aliased as `docker`) - Required for the test-simlin-agent engine ([Docker installation guide](https://docs.docker.com/get-docker/)). The Docker daemon must be running when `npm install` runs the postinstall hook; if Docker is missing or the daemon is unreachable, the image build is skipped and the engine is disabled.

These dependencies are automatically built/installed when you run `npm install` via postinstall hooks, but only if the respective toolchains are available on your PATH.

To skip specific components during installation, set the `SKIP_THIRD_PARTY_COMPONENTS` environment variable to a comma-separated list of component names before running `npm install`:

**Mac/Linux:**
```bash
SKIP_THIRD_PARTY_COMPONENTS=causal-decoder,PySD-simulator,time-series-behavior-analysis npm install
```

**Windows:**
```bat
set SKIP_THIRD_PARTY_COMPONENTS=causal-decoder,PySD-simulator,time-series-behavior-analysis && npm install
```

To install only the core app with the most frequently used engines, without the ability to run the all of the evals run:

```bash
npm run install:core
```

This is a shortcut that sets `SKIP_THIRD_PARTY_COMPONENTS` to every component except `visualization-engine`. It works on all platforms (Mac/Linux/Windows).

Available component names and what they affect:

| Component | Effect of skipping |
|---|---|
| `causal-chains` | Disables the causal-chains engine |
| `causal-decoder` | Disables the causal-decoder engine |
| `PySD-simulator` | Breaks evals |
| `time-series-behavior-analysis` | Breaks evals |
| `visualization-engine` | Breaks agentic tools |
| `simlin-agent` | Disables the test-simlin-agent engine |

## Agent Sandbox (Production Linux Only)

The agentic assistant runs each session's agent in an isolated worker process. On **Linux**, worker processes are sandboxed using [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`), which uses Linux kernel namespaces to confine the agent to its session-specific temp directory. The agent cannot read or write anywhere else on the server filesystem — including other sessions, application source code, or environment variables on disk.

### Installing bubblewrap

Install `bubblewrap` via your system package manager (`bubblewrap` on most distros). See the [bubblewrap releases page](https://github.com/containers/bubblewrap/releases) for more options.

### What bwrap provides

| Isolation | Guarantee |
|---|---|
| Filesystem writes | Agent can only write to its session temp dir |
| Filesystem reads | Only app code, system libs, and TLS certs are visible |
| Cross-session access | Other sessions' temp dirs are not mounted |
| Process isolation | Separate PID namespace; agent cannot signal other processes |
| Hostname isolation | Separate UTS namespace |

The Python subprocess spawned for visualizations inherits the same bwrap namespace automatically — no separate Python-level sandbox is needed.

### Development (macOS / Windows)

`bwrap` is a Linux kernel feature and is not available on macOS or Windows. On those platforms the agent worker runs **unsandboxed** with full filesystem access. A prominent warning is logged at startup. This is acceptable for local development but **must not be used for any publicly hosted deployment**.

### What bwrap does NOT restrict

- **Network access** — the agent worker must reach the upstream LLM APIs (Anthropic, Google, and/or OpenRouter depending on the configured providers). The agent can make arbitrary outbound HTTP requests if prompted to do so. Restrict this at the network/firewall level if needed.

## Metrics Reporting
SD-AI includes optional metrics reporting via the `GenerateMetricsReporter` class. When enabled, it automatically tracks and reports usage data for every engine generation request.

### Configuration
Set the `REPORTER_URL` environment variable in your `.env` file to enable metrics reporting:
```
REPORTER_URL="https://your-metrics-server.com/api/metrics"
```

If `REPORTER_URL` is not set or is empty, metrics reporting is disabled and no HTTP requests are made.

### Reported Metrics
For each call to `/api/v1/:engine/generate`, the following JSON data is posted to the configured URL:
```json
{
  "engine": "quantitative",
  "underlyingModel": "gpt-4o-mini",
  "duration": 1234,
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

**Fields:**
- `engine` (string): The name of the engine used (e.g., "quantitative", "qualitative", "seldon")
- `underlyingModel` (string|null): The underlying LLM model specified in the request body, or null if not provided
- `duration` (number): Time in milliseconds for the generate call to complete
- `timestamp` (string): ISO 8601 timestamp of when the report was generated

The reporter sends metrics asynchronously and will not block or affect the engine response, even if the reporting endpoint is unavailable.

## Token Usage Reporting

The agent uses `TokenUsageReporter` to track token usage and cost for every LLM call made using this service. This is separate from the engine metrics above — it covers the agent's internal Anthropic, Gemini, OpenAI, and OpenRouter calls rather than top-level HTTP engine requests.

### Configuration

Set `TOKEN_REPORTER_URL` in your `.env` file to enable reporting:
```
TOKEN_REPORTER_URL="https://your-metrics-server.com/api/token-usage"
```

Reporting is only active when **both** `TOKEN_REPORTER_URL` is set **and** the client provided a `clientId` in the `initialize_session` WebSocket message or as an additional parameter to an engine call. If either is missing, usage is still logged to the server console but not POSTed anywhere.

### Console Logging

Regardless of whether remote reporting is enabled, every LLM call logs a line to the server console:
```
[usage:anthropic]  input=1234($0.003702) output=256($0.003840) cache_write_5m=0($0.000000) cache_write_1h=0($0.000000) cache_read=512($0.000461) total=$0.008003
[usage:gemini]     input=800($0.000160) output=120($0.000072) cached=200($0.000010) thoughts=40($0.000024) total=$0.000266
[usage:openai]     input=600($0.000300) output=150($0.000225) cached=100($0.000025) reasoning=0 total=$0.000550
[usage:openrouter] input=820 output=140 cached=0 cache_write=0 total=$0.001425
```

Per-token costs are shown in parentheses when pricing data is available for the model. If pricing is unknown the token counts are shown without a cost. The `openrouter` line omits per-component dollar amounts because OpenRouter returns the authoritative total `cost` on the response itself — we don't recompute per-token breakdowns locally.

### Reported Payload

When remote reporting is active, the following JSON is POSTed to `TOKEN_REPORTER_URL` for each LLM call:

```json
{
  "clientId": "client-provided-id",
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "tokens": {
    "inputTokens": 1234,
    "outputTokens": 256,
    "cacheCreation5mInputTokens": 0,
    "cacheCreation1hInputTokens": 0,
    "cacheReadInputTokens": 512
  },
  "cost": 0.008003,
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

The `tokens` shape varies by provider:

| Provider | Token fields |
|---|---|
| `anthropic` | `inputTokens`, `outputTokens`, `cacheCreation5mInputTokens`, `cacheCreation1hInputTokens`, `cacheReadInputTokens` |
| `gemini` | `inputTokens`, `outputTokens`, `cachedTokens`, `thoughtsTokens` |
| `openai` | `inputTokens`, `outputTokens`, `cachedTokens`, `reasoningTokens` |
| `openrouter` | `inputTokens`, `outputTokens`, `cachedTokens`, `cacheWriteTokens`, `providerCost` |

`cost` is the total dollar cost of the call, or `null` if pricing data is unavailable for the model. For `openrouter`, `cost` is taken directly from the provider's authoritative `usage.cost` (no local pricing table is consulted), and `providerCost` in the token block carries that same value for transparency.

The reporter fires asynchronously and never blocks or fails the agent response if the reporting endpoint is unavailable.

## Testing
### Unit Tests
Unit tests are provided for:
- **HTTP API routes** in `/routes/v1` folder:
  - `engineParameters.test.js` - Validates that all engines return correct parameters
  - `engineGenerate.test.js` - Tests model generation endpoints with authentication, parameter validation, and response structure
  - `engines.test.js` - Tests engine listing and metadata endpoints
- **Engine implementations** in `/engines` folder:
  - `QuantitativeEngineBrain.test.js` - Tests quantitative model generation and LLM setup
  - `QualitativeEngineBrain.test.js` - Tests qualitative diagram generation
  - `SeldonBrain.test.js` - Tests discussion engine functionality
- **Evaluation methods** in `/evals/categories` - Tests cover causal relationship evaluation, conformance validation, and quantitative model assessment
- **Model output evaluation** in `/evals/model_output_evaluation` - Standalone tools for classifying System Dynamics model output (time series) into behavioral patterns like exponential growth, oscillation, or S-shaped growth

Run tests with:
```bash
npm test
```

Generate code coverage report with:
```bash
npm run test:coverage
```

Tests are built using Jest and Supertest, and use the actual engine implementations (no mocking) to ensure real-world functionality.

## Evals
- checkout the [Evals README](evals/README.md)
- for model output behavior classification, see [Model Output Evaluation](evals/model_output_evaluation/behavioral_evaluation_using_ists/README.md)

  
# Inspiration and Related Work
- https://github.com/bear96/System-Dynamics-Bot served as departure point for engine prompt development
- [CoModel](https://comodel.io) created by the team at [Skip Designed](https://skipdesigned.com/) to use Generative AI in their CBSD work
