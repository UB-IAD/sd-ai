# Human Test Plan: simlin-agent

## Prerequisites

- Docker (or Podman with rootless mode) installed and running
- Docker image built: `cd third-party/simlin-agent && bash install.sh`
- `ANTHROPIC_API_KEY` environment variable set with a valid key
- Go 1.24+ installed
- Node.js and npm installed, project dependencies installed

## Phase 1: Docker Image and Tooling

| Step | Action | Expected |
|------|--------|----------|
| 1 | `docker image inspect sd-ai-simlin-agent` | Exits 0, outputs JSON metadata |
| 2 | `docker run --rm --entrypoint pip sd-ai-simlin-agent list` | Output contains `pysimlin` |
| 3 | `docker run --rm --entrypoint node sd-ai-simlin-agent --version` | Outputs Node.js v24.x |
| 4 | `docker run --rm --entrypoint npx sd-ai-simlin-agent @simlin/mcp@0.1.4 --help` | Exits 0 |
| 5 | `docker run --rm sd-ai-simlin-agent --version` | Outputs Claude Code version |

## Phase 2: Engine Discovery

| Step | Action | Expected |
|------|--------|----------|
| 1 | Start the sd-ai server | No errors |
| 2 | `curl http://localhost:3000/api/v1/engines` | JSON includes `simlin-agent` with `supports: ["sfd"]` |
| 3 | Stop server, `docker rmi sd-ai-simlin-agent`, restart server | No errors |
| 4 | `curl http://localhost:3000/api/v1/engines` | `simlin-agent` absent (graceful degradation) |
| 5 | Rebuild: `cd third-party/simlin-agent && bash install.sh` | Image rebuilt |

## Phase 3: Go E2E Test

| Step | Action | Expected |
|------|--------|----------|
| 1 | With `ANTHROPIC_API_KEY` set: `cd third-party/simlin-agent && go test -v -timeout 15m ./...` | `TestSimlinAgentSimpleSFD` passes |
| 2 | Without `ANTHROPIC_API_KEY`: same command | Test SKIPs with exit code 0 |

## Phase 4: Container Isolation

| Step | Action | Expected |
|------|--------|----------|
| 1 | `TMPDIR=$(mktemp -d) && echo '{}' > $TMPDIR/input.sd.json` | File created |
| 2 | `docker run --rm -v $TMPDIR:/workspace --entrypoint ls sd-ai-simlin-agent /workspace/` | Only `input.sd.json` visible |
| 3 | `docker run --rm --entrypoint ls sd-ai-simlin-agent /home/bpowers/` | Error: no such file or directory |

## Phase 5: Populated Model Iteration

| Step | Action | Expected |
|------|--------|----------|
| 1 | Create temp dir with a populated `input.sd.json` (population + births + birth_rate model) | File created |
| 2 | Run agent with prompt: "Add a deaths flow and death_rate auxiliary" | Container exits 0, `output.json` exists |
| 3 | Inspect `output.json` | Contains original variables plus deaths/death_rate. Population has both inflows and outflows. |

## Full Eval Harness Run

1. `npm run evals -- --experiment evals/experiments/simlinAgent.json`
2. Verify scored results for all 7 categories
3. Verify no harness-level errors

## Traceability

| AC | Automated Test | Manual Step |
|----|----------------|-------------|
| AC1.1 | Code inspection + route discovery | Phase 2 |
| AC1.2 | `agent_test.go` | Phase 3, Step 1 |
| AC1.3 | Code path + eval harness | Phase 5 |
| AC1.4 | Waived (code inspection) | Review `engine.js:146-166, 179-184` |
| AC2.1 | E2E implicit | Phase 1 |
| AC2.2 | Waived (code inspection) | Phase 4 |
| AC3.1 | `agent_test.go` | Phase 3, Step 1 |
| AC3.2 | `agent_test.go` (empty input) | Phase 3, Step 1 |
| AC3.3 | Eval harness | Phase 5 |
| AC3.4 | Waived (same as AC1.4) | Review `engine.js:158-166` |
| AC4.1 | `agent_test.go` | Phase 3, Step 1 |
| AC4.2 | `agent_test.go` (skip path) | Phase 3, Step 2 |
| AC4.3 | `simlinAgent.json` | Full Eval Harness Run |
