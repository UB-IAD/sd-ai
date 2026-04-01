# Simlin Agent Engine Design

## Summary

This design adds a new evaluation engine called "simlin-agent" that replaces the current single-shot LLM prompting approach to stock-and-flow diagram (SFD) generation with an agentic, closed-loop workflow. Today, SFD engines send one prompt to an LLM and parse whatever comes back, which tops out at 52-63% on the eval benchmarks. The simlin-agent instead runs Claude Code inside a Docker container equipped with domain-specific tools -- simlin-mcp for iterative model building with compilation checks, and pysimlin for running simulations and verifying model behavior. This lets the agent build a model incrementally: create variables, check for compilation errors, fix them, simulate, inspect results, and refine until the model is correct before producing final output.

The implementation follows the existing causal-chains engine pattern -- a thin JS wrapper (`engine.js`) that the eval harness auto-discovers, which delegates actual work to an external process (Docker container instead of a Go binary). The Docker image bundles all dependencies (Python, Node, simlin-mcp, pysimlin, Claude Code) into a sandboxed environment that has no access to the eval repo's test definitions or expected answers. The engine writes a prompt and any existing model state into a temp directory, mounts it into the container, and reads back an `output.json` file containing the agent's final SD-JSON model. The work is structured in four phases: Docker image infrastructure, agent instructions (CLAUDE.md), JS engine class, and end-to-end testing.

## Definition of Done

A new SFD engine ("agent") that runs Claude Code inside a Docker container with simlin tools (simlin-mcp for iterative model building, pysimlin for simulation verification), breaking through the 52-63% SFD evaluation ceiling by replacing single-shot generation with a closed-loop agent that can compile-check, simulate, and iterate. Success means:

1. A new `engines/simlin-agent/engine.js` class that the eval harness auto-discovers and runs against all SFD evaluation categories, producing valid SD-JSON output (variables, relationships, specs).
2. A Docker image (built once, reused per test) providing a sandboxed environment with simlin-mcp, pysimlin, and Claude Code -- isolating the agent from the eval repo filesystem.
3. A CLAUDE.md / system prompt inside the container instructing the agent on available tools, SD-JSON format, the iterative build-verify workflow, and output expectations.
4. End-to-end JS validation: the engine can be included in an experiment JSON config, run against at least one SFD eval category, and produce scored results.
5. End-to-end Go validation: a `go test` that skips without `ANTHROPIC_API_KEY`, otherwise runs the simplest SFD eval through the Docker pipeline and checks results, with test data self-contained in `testdata/`.

## Acceptance Criteria

### simlin-agent.AC1: Engine harness integration
- **simlin-agent.AC1.1 Success:** Eval harness auto-discovers simlin-agent and lists it with `supportedModes: ["sfd"]`
- **simlin-agent.AC1.2 Success:** Engine returns valid SD-JSON with variables, relationships, and specs for a fresh model prompt
- **simlin-agent.AC1.3 Success:** Engine passes currentModel through to the agent for iteration/error-fixing tasks
- **simlin-agent.AC1.4 Failure:** Engine returns `{err: ...}` when Docker exits non-zero or output.json is missing/malformed

### simlin-agent.AC2: Docker sandboxing
- **simlin-agent.AC2.1 Success:** Agent inside container can use simlin-mcp tools (CreateModel, EditModel, ReadModel) and run Python with pysimlin
- **simlin-agent.AC2.2 Success:** Container has no access to sd-ai repo files (eval definitions, other engine outputs, results/)

### simlin-agent.AC3: Agent instructions and output
- **simlin-agent.AC3.1 Success:** Agent writes /workspace/output.json containing valid SD-JSON (variables array with types and equations, relationships array with polarity, specs object)
- **simlin-agent.AC3.2 Success:** Agent handles empty currentModel (fresh model building from prompt)
- **simlin-agent.AC3.3 Success:** Agent handles populated currentModel (iteration/modification of existing model)
- **simlin-agent.AC3.4 Failure:** output.json missing required fields (variables, relationships, specs) is caught by engine.js and returned as error

### simlin-agent.AC4: End-to-end validation
- **simlin-agent.AC4.1 Success:** Go test passes with ANTHROPIC_API_KEY set, producing output with at least one stock variable
- **simlin-agent.AC4.2 Success:** Go test skips cleanly without ANTHROPIC_API_KEY
- **simlin-agent.AC4.3 Success:** JS eval harness produces scored results when running simlin-agent experiment config

## Glossary

- **SFD (Stock-and-Flow Diagram)**: A system dynamics diagram using stocks (accumulations), flows (rates of change), auxiliaries (intermediate calculations), and causal relationships. The diagram type the simlin-agent produces, as opposed to CLD (Causal Loop Diagram) which captures only qualitative relationships.
- **SD-JSON**: The JSON format used by sd-ai to represent system dynamics models. Contains `variables` (stocks, flows, auxiliaries with equations), `relationships` (causal links with polarity), and `specs` (simulation parameters).
- **simlin-mcp**: An MCP server exposing `CreateModel`, `EditModel` (with compilation error gating), and `ReadModel` (with loop dominance analysis). Installed globally in the Docker image.
- **pysimlin**: Python library for loading, simulating, and analyzing system dynamics models. Provides `model.run()` for simulation and link extraction for populating the relationships array.
- **MCP (Model Context Protocol)**: Protocol allowing an AI agent to discover and call tools exposed by external servers. Claude Code uses MCP to communicate with simlin-mcp.
- **Claude Code**: Anthropic's CLI agent. Invoked with `claude -p --bare --dangerously-skip-permissions` as the agent runtime inside the Docker container.
- **Eval harness**: The sd-ai testing framework (`npm run evals`) that discovers engines, runs them against categorized test suites, and produces scored results.
- **Engine**: A pluggable sd-ai module implementing `supportedModes()`, `additionalParameters()`, and `generate()`. Each engine represents a different strategy for producing diagrams from prompts.
- **CLAUDE.md**: Markdown file containing system-level instructions for a Claude Code session. Baked into the Docker image with tool descriptions, format specs, and workflow guidance.
- **causal-chains engine**: Existing sd-ai engine that serves as the architectural template. Demonstrates the thin JS wrapper + external process pattern via `install.sh` in `third-party/`.
- **TARGETARCH**: Docker build argument resolving to the target platform architecture (`amd64`, `arm64`). Used to install the correct Node.js binary.
- **testify**: Go testing toolkit for assertions, used in the end-to-end Go test following causal-chains conventions.
- **`go:embed`**: Go compiler directive embedding file contents into a binary at compile time. Used for test fixtures from `testdata/`.
- **ENTRYPOINT**: Docker instruction defining the default executable. Set to `claude -p --bare --dangerously-skip-permissions` so `--model` can be appended at `docker run` time.

## Architecture

### Overview

The simlin-agent engine follows the same pattern as the causal-chains engine: a thin JS engine class (`engines/simlin-agent/engine.js`) that shells out to an external tool. Instead of a Go binary, it runs a Docker container with Claude Code + simlin tools.

```
eval harness
  -> engines/simlin-agent/engine.js
       -> writes input.sd.json + prompt.md to tmpdir
       -> docker run --rm -i -v tmpdir:/workspace -e ANTHROPIC_API_KEY=... sd-ai-simlin-agent --model <model>
            -> claude -p --bare --dangerously-skip-permissions (ENTRYPOINT)
                 -> uses simlin-mcp (CreateModel, EditModel, ReadModel) for iterative model building
                 -> uses pysimlin (via Python scripts) for simulation verification
                 -> writes /workspace/output.json
       -> reads output.json from tmpdir
       -> returns SD-JSON to eval harness
```

### Components

**`engines/simlin-agent/engine.js`** -- Thin JS wrapper implementing the Engine interface. `supportedModes()` checks if the Docker image exists. `generate()` creates a temp dir, writes input files, spawns Docker, reads output, cleans up.

**`third-party/simlin-agent/Dockerfile`** -- Builds the sandboxed image. Base `python:3.14-slim-bookworm`, adds Node 24 LTS (arch-aware via TARGETARCH), installs simlin-mcp, pysimlin, Claude Code. ENTRYPOINT runs `claude -p --bare --dangerously-skip-permissions` with baked-in MCP config and system prompt.

**`third-party/simlin-agent/CLAUDE.md`** -- Agent system prompt baked into the Docker image. Advisory (not prescriptive) guidance: describes available tools, SD-JSON format, recommended workflow, output contract. The agent decides its own approach per task.

**`third-party/simlin-agent/mcp.json`** -- MCP server config pointing to the globally-installed `simlin-mcp` binary. Baked into the image.

**`third-party/simlin-agent/install.sh`** -- Builds the Docker image. Called by `third-party/install.sh` during `npm install` (same pattern as causal-chains).

**`third-party/simlin-agent/agent_test.go`** -- Go end-to-end test with its own `go.mod`. Skips without `ANTHROPIC_API_KEY`. Validates the full Docker pipeline independently of the JS harness.

### Data Flow

**Input (engine.js -> container):**
- `input.sd.json`: The `currentModel` parameter (SD-JSON format). Empty model `{"variables":[],"relationships":[],"specs":{}}` for fresh tasks; populated for iteration/error-fixing tests.
- `prompt.md`: Composed from `prompt` + `parameters.problemStatement` + `parameters.backgroundKnowledge`. Piped to Docker's stdin, which forwards to Claude Code's stdin.

**Output (container -> engine.js):**
- `/workspace/output.json`: SD-JSON model with `variables`, `relationships`, and `specs`. Written by the agent when it considers the model complete.

**Agent tool access inside container:**
- simlin-mcp (MCP): `CreateModel`, `EditModel` (with compilation error gating), `ReadModel` (with loop dominance analysis)
- pysimlin (Python): `simlin.load()`, `model.run()`, `run.results` (pandas DataFrame), `run.loops` (link extraction for relationships)
- Bash: for writing and running Python scripts

### Sandboxing

The Docker container provides structural isolation:
- No access to the sd-ai repo filesystem (only `/workspace` via volume mount)
- No access to eval definitions, expected answers, or other engine outputs
- Outbound HTTPS for Anthropic API (required for Claude Code)
- No other host access

### Model Selection

The `underlyingModel` parameter (default `claude-opus-4-6`, configurable to `claude-sonnet-4-6` etc.) is passed as `--model <value>` appended to the Docker run command, which extends the ENTRYPOINT.

## Existing Patterns

Investigation found the causal-chains engine as the closest precedent:

- **Engine that shells out**: `engines/causal-chains/engine.js` writes input to a temp file, execs `third-party/causal-chains/causal-chains <inputPath>`, reads stdout. The simlin-agent follows this pattern with Docker instead of a Go binary.
- **Build via install.sh**: `third-party/causal-chains/install.sh` runs `go build`. Called by `third-party/install.sh` during `npm install`. Simlin-agent uses the same hook for `docker build`.
- **supportedModes() availability check**: Causal-chains checks if the Go binary exists via `statSync`. Simlin-agent checks if the Docker image exists via `docker image inspect`.
- **Go test structure**: Tests in `third-party/causal-chains/` use testify, `go:embed` for fixtures, `t.Skip()` for missing dependencies.
- **Engine directory structure**: Most engines contain only `engine.js`. No precedent for an engine directory containing config files -- all auxiliary tooling lives in `third-party/`.
- **Experiment config**: Standard JSON with engine name matching directory name, limits for rate control.

No existing Docker patterns in the repo. This design introduces Docker as a new execution substrate.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Docker Image Infrastructure

**Goal:** A buildable Docker image with all tooling installed and working.

**Components:**
- `third-party/simlin-agent/Dockerfile` -- multi-arch image with Python 3.14, Node 24 LTS (TARGETARCH-aware), simlin-mcp, pysimlin, numpy, pandas, Claude Code
- `third-party/simlin-agent/mcp.json` -- MCP server configuration for simlin-mcp
- `third-party/simlin-agent/install.sh` -- builds the Docker image, callable by `third-party/install.sh`

**Dependencies:** None (first phase)

**Done when:** `docker build` succeeds, `docker run sd-ai-simlin-agent --version` prints Claude Code version, `docker run sd-ai-simlin-agent --help` shows Claude Code help, `pip list` inside the container shows pysimlin/numpy/pandas installed, `simlin-mcp --help` or equivalent confirms the MCP binary is present.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Agent Instructions (CLAUDE.md)

**Goal:** Agent system prompt that enables Claude Code to build, verify, and output SD models.

**Components:**
- `third-party/simlin-agent/CLAUDE.md` -- advisory agent instructions covering:
  - Available tools (simlin-mcp MCP tools, pysimlin via Python, Bash)
  - SD-JSON format specification (variables, relationships, specs)
  - Input files: `/workspace/input.sd.json` (current model), stdin (task prompt)
  - Output contract: write `/workspace/output.json` in SD-JSON format
  - Recommended workflow: read input, build model iteratively, verify compilation, simulate if appropriate, extract relationships, write output
- Dockerfile update to `COPY CLAUDE.md` and set `--system-prompt-file` in ENTRYPOINT

**Dependencies:** Phase 1 (Docker image must build)

**Done when:** Rebuilt image includes CLAUDE.md. Manual test: pipe a simple prompt ("Create a model with one stock called population with initial value 100 and an inflow called births with equation population * 0.05") to the container, agent produces output.json with valid SD-JSON.

**Covers:** simlin-agent.AC3.1, simlin-agent.AC3.2, simlin-agent.AC3.3, simlin-agent.AC3.4
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Engine JS Class

**Goal:** A working engine that the eval harness can discover and invoke.

**Components:**
- `engines/simlin-agent/engine.js` -- Engine class implementing:
  - `supportedModes()` checking Docker image existence
  - `additionalParameters()` exposing anthropicKey, underlyingModel, problemStatement, backgroundKnowledge
  - `generate(prompt, currentModel, parameters)` orchestrating the Docker lifecycle

**Dependencies:** Phase 2 (Docker image with agent instructions)

**Done when:** Eval harness lists simlin-agent at `GET /api/v1/engines`. Engine can execute a generate request end-to-end and return SD-JSON.

**Covers:** simlin-agent.AC1.1, simlin-agent.AC1.2, simlin-agent.AC1.3, simlin-agent.AC1.4, simlin-agent.AC2.1, simlin-agent.AC2.2
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: End-to-End Testing and Validation

**Goal:** Automated and manual validation of the full pipeline.

**Components:**
- `third-party/simlin-agent/go.mod` -- Go module for the e2e test
- `third-party/simlin-agent/agent_test.go` -- Go test that skips without `ANTHROPIC_API_KEY`, runs a simple SFD eval through Docker, validates output structure
- `third-party/simlin-agent/testdata/simple_sfd.json` -- minimal SFD test fixture (prompt + expectations from simplest quantitativeTranslation test)
- `evals/experiments/simlinAgent.json` -- experiment config for running the engine against SFD categories

**Dependencies:** Phase 3 (engine must be functional)

**Done when:** `go test ./third-party/simlin-agent/...` passes (with API key). `npm run evals -- -e evals/experiments/simlinAgent.json` runs and produces scored results (pass/fail per category).

**Covers:** simlin-agent.AC4.1, simlin-agent.AC4.2, simlin-agent.AC4.3
<!-- END_PHASE_4 -->

## Additional Considerations

**Dependency: simlin relationships generation.** This design assumes simlin will generate the `relationships` array (with polarity) on serialization to SD-AI JSON format by implementation time. Without this, the agent's output.json would lack relationships, causing failures in quantitativeTranslation, quantitativeCausalReasoning, conformance, and behavioralPattern evaluations. If this dependency isn't met, the CLAUDE.md could instruct the agent to construct the relationships array manually as part of writing output.json (fallback approach).

**Rate limiting for concurrent runs.** The eval harness rate-limits by `requestsPerMinute` per engine config. Since each agent invocation makes multiple internal API calls, set `requestsPerMinute: 2` in the experiment config to avoid overwhelming the Anthropic API. The harness's rate limiter doesn't account for internal calls, but low concurrency keeps total load manageable.

**Docker image rebuild.** Changing CLAUDE.md or mcp.json requires rebuilding the Docker image (they're baked in via COPY). Run `third-party/simlin-agent/install.sh` to rebuild. The install.sh should be idempotent and use `docker build` caching for unchanged layers.
