/**
 * Build-time data generator for the SD-AI documentation site.
 *
 * The site is a static, backend-free documentation site. Rather than fetch
 * engine / eval / agent / leaderboard data from a live sd-ai server at runtime,
 * this script discovers everything directly from the repository and calls the
 * same methods the backend routes use, emitting plain JSON into src/generated/
 * that the React app imports statically.
 *
 * Mirrors:
 *   - routes/v1/engines.js + routes/v1/engineParameters.js  -> engines.json
 *   - routes/v1/evalsList.js + routes/v1/evalsTestDetails.js -> evals.json
 *   - agent/WebSocket.js getAvailableAgents()                -> agents.json
 *   - routes/v1/leaderboard.js (+ Leaderboard page aggregation) -> leaderboards.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execSync } from 'child_process';
import {
  LEADERBOARD_MODES,
  LEADERBOARD_GENERATIONS,
  generationsIn,
  generationOf,
  findGeneration,
} from '../../evals/leaderboardGenerations.js';
import {
  leaderboardResultsPath,
  readLeaderboardFile,
} from '../../evals/leaderboardFile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// frontend/scripts -> frontend -> repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.resolve(__dirname, '..', 'src', 'generated');

// GitHub "view source" base, matching the backend routes.
const GH_BASE = 'https://github.com/UB-IAD/sd-ai/tree/main';

// Run from the repo root so engine/eval modules resolve relative paths and
// node_modules exactly like the server does.
process.chdir(REPO_ROOT);

const importRepoModule = (relPath) =>
  import(pathToFileURL(path.join(REPO_ROOT, relPath)).href);

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function writeJson(name, data) {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, JSON.stringify(data));
  const bytes = fs.statSync(file).size;
  console.log(`  wrote ${name} (${(bytes / 1024).toFixed(1)} KB)`);
}

/* ------------------------------------------------------------------ engines */

// Same two parameters routes/v1/engineParameters.js prepends to every engine.
const BASE_PARAMETERS = [
  {
    name: 'prompt',
    type: 'string',
    required: true,
    uiElement: 'textarea',
    label: 'Prompt',
    description: 'Description of desired model or changes to model.',
  },
  {
    name: 'currentModel',
    type: 'json',
    required: false,
    defaultValue: '{"variables": [], "relationships": []}',
    uiElement: 'hidden',
    description:
      'javascript object in sd-json format representing current model to anchor changes off of',
  },
];

const RECOMMENDED_DEFAULTS = {
  sfd: 'quantitative',
  cld: 'qualitative',
  'sfd-discuss': 'seldon',
  'cld-discuss': 'seldon',
  'ltm-discuss': 'ltm-narrative',
  documentation: 'generate-documentation',
};

async function generateEngines() {
  const enginesDir = path.join(REPO_ROOT, 'engines');
  const dirs = fs
    .readdirSync(enginesDir)
    .filter((f) => fs.lstatSync(path.join(enginesDir, f)).isDirectory());

  const engines = [];
  for (const dir of dirs) {
    const enginePath = path.join(enginesDir, dir, 'engine.js');
    const base = {
      name: dir,
      isTest: dir.startsWith('test-'),
      source: `${GH_BASE}/engines/${dir}`,
    };

    if (!fs.existsSync(enginePath)) continue;

    let mod;
    try {
      mod = await importRepoModule(`engines/${dir}/engine.js`);
    } catch (e) {
      // Document the engine even if it can't be imported in this environment
      // (e.g. missing native/optional dependencies).
      console.warn(`  ! engine "${dir}" failed to import: ${e.message}`);
      engines.push({
        ...base,
        supports: [],
        available: false,
        description: null,
        link: null,
        parameters: null,
        importError: e.message,
      });
      continue;
    }

    const EngineClass = mod.default;

    let supports = [];
    try {
      supports = EngineClass.supportedModes() || [];
    } catch {
      supports = [];
    }

    let description = null;
    try {
      description = EngineClass.description ? EngineClass.description() : null;
    } catch {
      description = null;
    }

    let link = null;
    try {
      link = EngineClass.link ? EngineClass.link() : null;
    } catch {
      link = null;
    }

    // Full parameter schema, exactly as routes/v1/engineParameters.js returns
    // it (base parameters + engine additionalParameters()). No fields dropped.
    let parameters = null;
    let paramsError = null;
    try {
      const instance = new EngineClass();
      parameters = [...BASE_PARAMETERS, ...instance.additionalParameters()];
    } catch (e) {
      paramsError = e.message;
    }

    engines.push({
      ...base,
      supports,
      available: supports.length > 0,
      description,
      link: link || null,
      parameters,
      ...(paramsError ? { paramsError } : {}),
    });
  }

  // Sort alphabetically, then force qualitative to the top (matches the route's
  // backward-compat behavior). No special treatment for experimental/mentor.
  engines.sort((a, b) => a.name.localeCompare(b.name));
  const qi = engines.findIndex((e) => e.name === 'qualitative');
  if (qi >= 0) engines.unshift(engines.splice(qi, 1)[0]);

  return { engines, recommendedDefaults: RECOMMENDED_DEFAULTS };
}

/* -------------------------------------------------------------------- evals */

async function generateEvals() {
  const catDir = path.join(REPO_ROOT, 'evals', 'categories');
  const names = fs
    .readdirSync(catDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.replace('.js', ''));

  const categories = [];
  for (const name of names) {
    let mod;
    try {
      mod = await importRepoModule(`evals/categories/${name}.js`);
    } catch (e) {
      console.warn(`  ! eval category "${name}" failed to import: ${e.message}`);
      continue;
    }

    const groups = Object.keys(mod.groups).map((groupName) => ({
      name: groupName,
      // Full test objects (name, prompt, expectations, additionalParameters, ...)
      // so the eval detail page works entirely offline.
      tests: mod.groups[groupName],
    }));

    let firstTestUrl = null;
    const firstGroup = Object.keys(mod.groups)[0];
    if (firstGroup && mod.groups[firstGroup].length > 0) {
      const firstTest = mod.groups[firstGroup][0].name;
      firstTestUrl = `/evals/${encodeURIComponent(name)}/${encodeURIComponent(
        firstGroup
      )}/${encodeURIComponent(firstTest)}`;
    }

    let description = '';
    try {
      description = mod.description ? mod.description() : '';
    } catch {
      description = '';
    }

    let link = null;
    try {
      link = mod.link ? mod.link() : null;
    } catch {
      link = null;
    }

    // How the category's tests are built and run, what its evaluator checks, and how those
    // checks combine into a verdict. Rendered on every test page, and read from the category
    // module rather than restated here so the explanation cannot drift from `evaluate`.
    let methodology = null;
    try {
      methodology = mod.methodology ? mod.methodology() : null;
    } catch (e) {
      console.warn(`  ! eval category "${name}" methodology() threw: ${e.message}`);
      methodology = null;
    }
    if (!methodology) {
      // Surfaced rather than passed over: a category with no methodology renders a test page
      // that cannot say how it is graded, which is the thing these pages exist to explain.
      console.warn(`  ! eval category "${name}" exports no methodology()`);
    }

    categories.push({
      name,
      groups,
      description,
      link,
      methodology,
      // Regression guard or discriminating, with its reason (evals/utilities/categoryRoles.js).
      role: methodology?.role ?? null,
      source: `${GH_BASE}/evals/categories/${name}.js`,
      firstTestUrl,
    });
  }

  return { categories };
}

/* ------------------------------------------------------------------- agents */

function agentSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Label a phase for multi-file agents (e.g. athena_CLD -> "CLD").
function phaseLabel(fileId, modes) {
  const suffix = fileId.includes('_') ? fileId.split('_').pop() : null;
  if (suffix && /^[A-Za-z]+$/.test(suffix)) return suffix.toUpperCase();
  if (modes && modes.length) return modes.join('/').toUpperCase();
  return fileId;
}

async function generateAgents() {
  const { AgentConfigurationManager } = await importRepoModule(
    'agent/utilities/AgentConfigurationManager.js'
  );

  // Only document agents that are checked into the repo (git-tracked). This
  // naturally excludes untracked/experimental configs and keeps local dev
  // consistent with the CI build.
  const tracked = execSync('git ls-files agent/config', { cwd: REPO_ROOT })
    .toString()
    .trim()
    .split('\n')
    .filter((f) => f.endsWith('.md'));

  // Group files that share a display name into a single agent (e.g. the two
  // Athena phase files collapse into one "Athena" entry).
  const byName = new Map();

  for (const rel of tracked) {
    const content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const { metadata, content: body } = AgentConfigurationManager.parseContent(content);
    if (!metadata.name) continue;

    const fileId = path.basename(rel, '.md');
    const modes = metadata.supported_modes || [];
    const phase = {
      id: fileId,
      label: phaseLabel(fileId, modes),
      supported_modes: modes,
      description: metadata.description || '',
      systemPrompt: body.trim(),
      source: `${GH_BASE}/${rel}`,
    };

    if (!byName.has(metadata.name)) {
      byName.set(metadata.name, {
        name: metadata.name,
        role: metadata.role || null,
        version: metadata.version || null,
        agent_mode: metadata.agent_mode || null,
        max_iterations: metadata.max_iterations || 20,
        _modes: new Set(),
        phases: [],
      });
    }
    const entry = byName.get(metadata.name);
    modes.forEach((m) => entry._modes.add(m));
    entry.phases.push(phase);
  }

  const agents = [...byName.values()]
    .map((a) => ({
      id: agentSlug(a.name),
      name: a.name,
      role: a.role,
      version: a.version,
      agent_mode: a.agent_mode,
      max_iterations: a.max_iterations,
      supported_modes: [...a._modes],
      description: a.phases[0]?.description || '',
      phases: a.phases,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { agents };
}

/* -------------------------------------------------------------- leaderboards */

// The model(s) a config ran with. Most engines name one in `underlyingModel`. The agent
// harness (`test-agent-build`) instead names a model per tool-and-difficulty slot under
// `toolModels`, so there is no single field to read — the distinct set across those slots
// is the honest answer. Usually that set has one member, but a config is free to mix (a
// larger model for hard builds, say) and collapsing that to one name would misattribute
// the score. An engine that drives no LLM at all yields an empty list.
function modelsForConfig(engineConfig) {
  const params = engineConfig.additionalParameters ?? {};
  if (params.underlyingModel) return [params.underlyingModel];
  if (params.toolModels) {
    const named = Object.values(params.toolModels)
      .flatMap((slot) => Object.values(slot ?? {}))
      .filter(Boolean);
    return [...new Set(named)];
  }
  return [];
}

// Agent runs go through a harness engine (`test-agent-build`, `test-agent-discuss`) whose
// id is the same for every agent and every board, so the engine name cannot say which
// agent produced a row. The config names the agent, so that is recorded here and the site
// is spared having to infer it from an id or a naming convention.
function agentForConfig(engineConfig) {
  return engineConfig.additionalParameters?.agentName ?? null;
}

/**
 * Whether a config was run against a locally-hosted model rather than a hosted API.
 *
 * Local runs are launched through LM Studio / llama.cpp, and the config name records the
 * knobs that only exist there: an explicit seed, a quantisation, a context size. No
 * hosted-API config carries any of them — `qualitative-qwen3.5-397b` is the same weights
 * served over an API, and stays on the board. The model id is checked too, for the runs
 * whose weights were loaded straight off a disk path.
 *
 * This is a property of the run, so it is settled here rather than re-derived by pattern
 * matching in the UI.
 */
function isLocallyHosted(configName, llmModels) {
  if (/-seed\d+/i.test(configName)) return true;
  if (/(^|[-_])(gguf|mlx|q4_k_m|q4ks|q6k|iq4nl)([-_]|$)/i.test(configName)) return true;
  return llmModels.some((model) => model.startsWith('/') || /(^|[-_])mlx([-_]|\d|$)/i.test(model));
}

// Port of the Leaderboard page's processLeaderboardData: reduce the (huge)
// full-results files to the small per-engine aggregate the UI actually renders.
function processLeaderboard(data) {
  const engineStats = {};
  // Cost and generation are tracked in their own maps rather than on engineStats: the
  // category list below is inferred from "every key that isn't a known non-category",
  // so an extra key there would be rendered as a benchmark column.
  const costStats = {};
  const generationStats = {};
  const categories = new Set();
  const categoryFirstTests = {};

  for (const test of data.results) {
    const engineConfigName = test.engineConfigName;
    const engineName = test.engineConfig.engine;
    const llmModels = modelsForConfig(test.engineConfig);
    const agentName = agentForConfig(test.engineConfig);

    if (!categoryFirstTests[test.category]) {
      categoryFirstTests[test.category] = {
        category: test.category,
        group: test.group,
        testName: test.testParams.name,
      };
    }

    if (!engineStats[engineConfigName]) {
      engineStats[engineConfigName] = { speeds: [], engineName, llmModels, agentName };
    }

    if (!(test.category in engineStats[engineConfigName])) {
      categories.add(test.category);
      engineStats[engineConfigName][test.category] = { passes: 0, count: 0 };
    }

    engineStats[engineConfigName][test.category].passes += test.pass ? 1 : 0;
    engineStats[engineConfigName][test.category].count += 1;
    engineStats[engineConfigName].speeds.push(test.duration);

    // A newer result overwrites an older one, so a config only partly re-run holds a
    // mix. Counting per generation is what lets the table say which rows are still on
    // older numbers instead of implying the whole config was measured at once.
    const gen = generationOf(test);
    const genCounts = (generationStats[engineConfigName] ??= {});
    genCounts[gen] = (genCounts[gen] ?? 0) + 1;

    const cost = (costStats[engineConfigName] ??= { total: 0, priced: 0, unpricedCalls: 0, tests: 0 });
    cost.tests += 1;
    if (test.cost) {
      cost.priced += 1;
      // Only originator rows are summed. A sibling test that reused a cached generation
      // carries that generation's full cost on its own row, so adding it would bill one
      // engine call once per sibling.
      if (!test.cost.reusedGeneration) cost.total += test.cost.total;
      cost.unpricedCalls += test.cost.unpricedCalls;
    }
  }

  const engines = Object.entries(engineStats).map(([configName, stats]) => {
    let totalPasses = 0;
    let totalCount = 0;
    const scores = Object.fromEntries(
      Object.keys(stats)
        .filter((e) => !['speeds', 'engineName', 'llmModels', 'agentName'].includes(e))
        .map((category) => {
          totalPasses += stats[category].passes;
          totalCount += stats[category].count;
          return [category, stats[category].passes / stats[category].count];
        })
    );

    const score = totalPasses / totalCount;
    const speed =
      stats.speeds.reduce((sum, a) => sum + a, 0) / stats.speeds.length / 1000;

    // Total spend spread over every test, so the figure is comparable between engines
    // that ran different numbers of tests. Null — not zero — for results produced before
    // evals captured cost, so the UI can say "unknown" rather than "free".
    const cost = costStats[configName];
    const hasCost = cost && cost.priced > 0;
    const costTotal = hasCost ? cost.total : null;
    const costPerTest = hasCost ? cost.total / cost.tests : null;

    const generationCounts = generationStats[configName] ?? {};
    const presentGenerations = generationsIn(
      Object.entries(generationCounts).flatMap(([id, n]) => Array(n).fill({ generation: id }))
    );

    return {
      configName, engineName: stats.engineName,
      // The agent this config ran, or null for a plain engine.
      agentName: stats.agentName,
      // Both shapes: `llmModels` for the UI to render one badge per model, `llmModel` as
      // the flattened string the charts and the engine pages already read.
      llmModels: stats.llmModels,
      llmModel: stats.llmModels.length ? stats.llmModels.join(' + ') : 'N/A',
      isLocal: isLocallyHosted(configName, stats.llmModels),
      speed, score,
      generationCounts,
      generations: presentGenerations,
      costTotal, costPerTest,
      // Non-zero means a model had no pricing.js entry, so the two figures above understate.
      costUnpricedCalls: hasCost ? cost.unpricedCalls : 0,
      ...scores,
    };
  });

  engines.sort((a, b) => b.score - a.score);

  return { engines, categories: Array.from(categories), categoryFirstTests };
}

// One file per leaderboard. A newer result overwrites the older one for the same test,
// so the file already holds exactly one current answer per test and needs no bucketing —
// it is aggregated whole. The generation tag rides along per engine so the table can
// flag which engines are still carrying older numbers.
//
// The published boards are gzipped and read through `evals/leaderboardFile.js`, the same
// way the API route reads them. Everything downstream of that — this aggregation, the
// generated `leaderboards.json`, the React pages — is unchanged: the site never sees the
// raw files, only the small pre-aggregated JSON written here.
function generateLeaderboards() {
  const out = {};
  for (const mode of LEADERBOARD_MODES) {
    const fp = leaderboardResultsPath(mode);
    if (!fs.existsSync(fp)) {
      console.warn(`  ! no leaderboard results for "${mode}"`);
      out[mode] = null;
      continue;
    }

    const data = readLeaderboardFile(fp);
    const processed = processLeaderboard(data);

    const counts = {};
    // Distinct categories and tests per generation. The benchmark grew between rounds, and
    // by different amounts on different boards — SFD went from 5 categories to 12 while CLD
    // stayed at 4 — so whether a later generation is scored over harder ground is a fact
    // about each board, not a blanket claim the UI can make for all of them.
    const catsPerGen = {};
    const testsPerGen = {};
    for (const row of data.results) {
      const id = generationOf(row);
      counts[id] = (counts[id] ?? 0) + 1;
      (catsPerGen[id] ??= new Set()).add(row.category);
      (testsPerGen[id] ??= new Set()).add(`${row.category}/${row.group}/${row.testParams.name}`);
    }

    const generations = generationsIn(data.results).map((id) => {
      const declared = findGeneration(id);
      if (!declared) {
        // Surfaced rather than dropped: an undeclared id is almost always a typo in a
        // collect command, and silently ignoring it would look like data loss.
        console.warn(`  ! "${mode}" has results tagged "${id}", which is not in LEADERBOARD_GENERATIONS`);
      }
      return {
        id,
        label: declared?.label ?? id,
        description: declared?.description ?? null,
        caveat: declared?.caveat ?? null,
        count: counts[id],
        categoryCount: catsPerGen[id]?.size ?? 0,
        testCount: testsPerGen[id]?.size ?? 0,
      };
    });

    console.log(
      `  ${mode}: ${processed.engines.length} engines, ` +
      `${generations.map((g) => `${g.id} (${g.count} results)`).join(', ')}`
    );
    out[mode] = {
      ...processed,
      generations,
      // generationsIn orders by the registry, so the last present one is the newest.
      currentGeneration: generations[generations.length - 1]?.id ?? null,
    };
  }
  return out;
}

/* --------------------------------------------------------------------- main */

async function main() {
  ensureOutDir();

  console.log('Generating engines.json ...');
  writeJson('engines.json', await generateEngines());

  console.log('Generating evals.json ...');
  writeJson('evals.json', await generateEvals());

  console.log('Generating agents.json ...');
  writeJson('agents.json', await generateAgents());

  console.log('Generating leaderboards.json ...');
  writeJson('leaderboards.json', generateLeaderboards());

  console.log('Done.');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
