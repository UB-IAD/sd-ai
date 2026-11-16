/**
 * This is the model-to-CLD test
 *
 * Summarizing an existing model as a causal loop diagram is how modelers communicate what a model
 * says: the diagram has to keep the feedback loops that drive the behavior, give every link the
 * right polarity, and be small enough to read. This category gives the engine a source model and
 * grades the CLD it builds, as its model, against that source.
 *
 * The source arrives one of two ways:
 *   - as the current model (group `inlineModel`), for the stock-and-flow models whose loop
 *     dominance has been analysed (the feedbackExplanation fixtures, read but not changed)
 *   - as an uploaded XMILE file the agent has to find and read through its document tools
 *     (groups `uploadedModel` and `uploadedCLD`): the same stock-and-flow models as Stella files,
 *     and causal loop diagrams built for this category, gibberish-named so nothing but the file
 *     can tell the agent what is in it
 *
 * Grading is deterministic and works on the built model's signed relationships:
 *   - each key loop of the source must appear in the CLD: a CLD loop of at least two variables,
 *     with the same polarity, whose variables all lie on that source loop. Which of the loop's
 *     variables the summary keeps is the engine's choice — collapsing a chain is what summarizing
 *     means — so any such loop counts
 *   - every CLD link must be backed by a causal path in the source with the same polarity, going
 *     only through variables the CLD left out
 *   - the CLD must be succinct: well under the source's variable count
 *
 * One criterion per test; sibling tests share one generation.
 *
 * The uploadedCLDHard group uploads bigger generated diagrams with a prompt that names no method,
 * grades every criterion in one test, and holds succinctness to a tighter limit: no more variables
 * than the diagram's loops have core variables, plus a little room (hardSuccinctLimit).
 *
 * @module categories/modelToCLD
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { sourceGraph, graphFromLinks, findCycles, pathPolarities, foldVariable, cldLinksFromResponse } from '../utilities/causalGraph.js';
import { readUpload } from '../utilities/toolLog.js';
import { withFloors } from '../floors/statement.js';
import { HELD_OUT_CLDS, HARD_CLDS, HELD_OUT_HARD_CLDS } from './modelToCLDData/buildClds.js';
import { splitHeldOut } from '../utilities/heldOut.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SFD_DIR = path.join(__dirname, 'feedbackExplanationData');
const CLD_DIR = path.join(__dirname, 'modelToCLDData');

/** The CLD may show at most this share of the source's variables (and never needs fewer than MIN). */
export const SUCCINCT_SHARE = 0.6;
export const SUCCINCT_MIN = 4;

/** How many of a stock-and-flow model's loops are key: the ones dominant for longest. */
export const KEY_LOOPS_PER_SFD = 3;

const CYCLE_CAP = 5000;

export const description = () => {
    return `The model-to-CLD test evaluates whether an engine can summarize an existing model as a correct, succinct causal loop diagram. The source is either the current model or an uploaded XMILE file the agent must read; the engine's CLD must keep the source's key feedback loops with the right polarity, back every link with a real causal path in the source, and stay well smaller than the source.`;
};

/**
 * The key loops of an analysed stock-and-flow model: the ones dominant for the longest share of
 * the run, by the fixture's loop-dominance analysis. Labels name each loop by the stocks on it.
 */
const sfdKeyLoops = function(fixture, names) {
    const durations = new Map();
    for (const period of fixture.feedback.dominantLoopsByPeriod) {
        for (const id of period.dominantLoops) {
            durations.set(id, (durations.get(id) || 0) + (period.endTime - period.startTime));
        }
    }
    const stocks = new Set(fixture.model.variables.filter((v) => v.type === 'stock').map((v) => foldVariable(v.name)));
    // A two-variable loop is a stock and its own flow (a first-order drain or adjustment). A
    // succinct CLD folds the flow into the stock, which leaves nothing that could show such a loop
    // without breaking succinctness, so those loops are never key.
    return [...durations.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([id]) => {
            const loop = fixture.feedback.feedbackLoops.find((l) => l.identifier === id);
            const nodes = [...new Set(loop.links.flatMap((l) => [foldVariable(l.from), foldVariable(l.to)]))];
            return { id, loop, nodes };
        })
        .filter(({ nodes }) => nodes.length > 2)
        .slice(0, KEY_LOOPS_PER_SFD)
        .map(({ id, loop, nodes }) => {
            return {
                id,
                polarity: loop.polarity,
                nodes,
                label: `${id} (${loop.polarity === '+' ? 'reinforcing' : 'balancing'}, through ${nodes.filter((n) => stocks.has(n)).map((n) => `"${names.get(n) ?? n}"`).join(', ')})`
            };
        });
};

/**
 * The key loops of a CLD fixture: every loop in the diagram. The label names the loop by its
 * designed core variables, which is only how a reader recognizes it; grading does not require them.
 */
const cldKeyLoops = function(fixture, names) {
    const cores = new Set(fixture.loops.flatMap((l) => l.core.map(foldVariable)));
    return findCycles(sourceGraph(fixture.model, null), CYCLE_CAP).map((cycle, i) => {
        const core = cycle.nodes.filter((n) => cores.has(n));
        return {
            id: `L${i + 1}`,
            polarity: cycle.polarity,
            nodes: cycle.nodes,
            label: `L${i + 1} (${cycle.polarity === '+' ? 'reinforcing' : 'balancing'}, through ${core.map((n) => `"${names.get(n) ?? n}"`).join(', ')})`
        };
    });
};

const SFD_FIXTURES = ['armsRace', 'bassDiffusion', 'inventoryWorkforce', 'predatorPrey', 'maibab', 'marketGrowth'];
const CLD_FIXTURES = ['gibberishSmall', 'gibberishMedium', 'gibberishLarge', 'softwareRework', 'trafficCongestion', ...HELD_OUT_CLDS];

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const INLINE_PROMPT = `Summarize my simulation model as a succinct causal loop diagram. Keep the feedback loops that drive its behavior, collapse chains of intermediate variables into single links where that keeps the meaning, and give every link its polarity. Use the model's own variable names for every variable you keep. Replace the current model with the causal loop diagram.`;

const uploadedPrompt = (fileName, kind) => `I've attached a file, "${fileName}", containing my ${kind}. Read it and build a succinct causal loop diagram that summarizes it: keep the feedback loops, collapse chains of intermediate variables into single links where that keeps the meaning, and give every link its polarity. Use the file's own variable names for every variable you keep. Build the causal loop diagram as the model.`;

/**
 * The tests for one source: one per key loop, one for link faithfulness, one for succinctness, and
 * (for uploads) one for having read the file. Siblings share the prompt, model and parameters, so
 * they share one generation.
 */
const testsForSource = function(name, source, keyLoops, prompt, currentModel, attachment) {
    const sourceVariableCount = source.graph.names.size;
    const base = {
        prompt,
        currentModel,
        additionalParameters: {
            mode: 'cld',
            problemStatement: `I want a causal loop diagram that communicates what drives the behavior of my ${source.kind}.`,
            ...(attachment ? { attachments: [{ path: attachment }] } : {})
        }
    };
    const shared = { sourceModel: source.model, analysedLoops: source.analysedLoops, sourceVariableCount };
    const tests = keyLoops.map((loop) => ({
        ...base,
        name: `${name} keeps loop ${loop.label}`,
        expectations: { ...shared, criterion: 'loop', loop }
    }));
    tests.push({ ...base, name: `${name} links are faithful to the source`, expectations: { ...shared, criterion: 'links' } });
    tests.push({ ...base, name: `${name} is succinct`, expectations: { ...shared, criterion: 'succinct' } });
    if (attachment) {
        tests.push({ ...base, name: `${name} read the uploaded file`, expectations: { ...shared, criterion: 'readFile', fileName: path.basename(attachment) } });
    }
    return tests;
};

/**
 * The hard prompt names no method: not loops, not collapsing chains, not polarity. The manager asks
 * for a diagram of the file their team can take in at a glance, and to keep the file's names (the
 * grader matches variables by name).
 */
export const hardPrompt = (fileName) => `I've attached a file, "${fileName}", with a causal loop diagram that has grown too big for my team to follow. Can you give me a version of it they can take in at a glance, saying the same thing? Keep the file's own names for anything you keep. Build it as the model.`;

/**
 * The hard group's succinctness limit for a generated diagram: the number of its loops' core
 * variables — what the diagram shows with every chain collapsed and nothing off its loops kept.
 * Tighter than the share the other groups allow, and still met by the design's own summary.
 * @param {Object} fixture A generated CLD fixture, with its designed loops
 * @returns {number} The most variables a hard summary may show
 */
/** The hard limit: the loops' core variables, plus a little room for a useful extra (at least two, or a fifth). */
export const hardSuccinctLimit = (fixture) => {
    const core = new Set(fixture.loops.flatMap((l) => l.core)).size;
    return core + Math.max(2, Math.ceil(0.2 * core));
};

/**
 * The hard test for a source: one test, every criterion at once — every key loop kept with its
 * polarity, every link faithful, succinct to the tighter hard limit, and the file read.
 */
const hardTestForSource = function(name, source, keyLoops, prompt, attachment) {
    return {
        prompt,
        currentModel: null,
        additionalParameters: { mode: 'cld', problemStatement: `I want a causal loop diagram that communicates what drives the behavior of my ${source.kind}.`, attachments: [{ path: attachment }] },
        name: `${name} keeps every loop, with faithful links, succinctly, read from the file`,
        expectations: { sourceModel: source.model, analysedLoops: source.analysedLoops, sourceVariableCount: source.graph.names.size, criterion: 'hard', loops: keyLoops, fileName: path.basename(attachment), succinctLimit: hardSuccinctLimit(source.fixture) }
    };
};

const sfdSource = function(key) {
    const fixture = readJson(path.join(SFD_DIR, `${key}.json`));
    return {
        fixture,
        model: fixture.model,
        analysedLoops: fixture.feedback.feedbackLoops.map((l) => ({ links: l.links })),
        graph: sourceGraph(fixture.model, fixture.feedback.feedbackLoops),
        kind: 'simulation model'
    };
};

const cldSource = function(key) {
    const fixture = readJson(path.join(CLD_DIR, `${key}.json`));
    return { fixture, model: fixture.model, analysedLoops: null, graph: sourceGraph(fixture.model, null), kind: 'causal loop diagram' };
};

const rawGroups = {
    inlineModel: SFD_FIXTURES.flatMap((key) => {
        const source = sfdSource(key);
        return testsForSource(`${key} (current model)`, source, sfdKeyLoops(source.fixture, source.graph.names), INLINE_PROMPT, source.model, null);
    }),
    uploadedModel: SFD_FIXTURES.flatMap((key) => {
        const source = sfdSource(key);
        const file = path.join(SFD_DIR, `${key}.stmx`);
        return testsForSource(`${key} (uploaded model)`, source, sfdKeyLoops(source.fixture, source.graph.names), uploadedPrompt(path.basename(file), 'simulation model, saved from Stella'), null, file);
    }),
    uploadedCLD: CLD_FIXTURES.flatMap((key) => {
        const source = cldSource(key);
        const file = path.join(CLD_DIR, `${key}.stmx`);
        return testsForSource(`${key} (uploaded CLD)`, source, cldKeyLoops(source.fixture, source.graph.names), uploadedPrompt(path.basename(file), 'causal loop diagram, saved from Stella'), null, file);
    }),
    uploadedCLDHard: HARD_CLDS.map((key) => {
        const source = cldSource(key);
        const file = path.join(CLD_DIR, `${key}.stmx`);
        return hardTestForSource(`${key} (hard, uploaded CLD)`, source, cldKeyLoops(source.fixture, source.graph.names), hardPrompt(path.basename(file)), file);
    })
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => [...HELD_OUT_CLDS, ...HELD_OUT_HARD_CLDS].some((k) => t.name.startsWith(`${k} `)));
/** Map each CLD variable to the source variable it names, by folded name. */
const unknownVariables = function(cldGraph, srcGraph) {
    return [...cldGraph.names.keys()].filter((n) => !srcGraph.names.has(n));
};

/**
 * Evaluates one criterion of the CLD the engine built.
 * @param {Object} generatedResponse The engine's response; its model holds the CLD
 * @param {Object} expectations The criterion and the source it is graded against
 * @returns {Array<Object>} A list of failures with type and details.
 */
export const evaluate = function(generatedResponse, expectations) {
    const failures = [];
    const links = cldLinksFromResponse(generatedResponse);
    if (links.length === 0) {
        failures.push({
            type: 'No causal loop diagram produced',
            details: `The engine's model holds no relationships with a polarity.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}`
        });
        return validateEvaluationResult(failures);
    }

    const cld = graphFromLinks(links);
    const src = sourceGraph(expectations.sourceModel, expectations.analysedLoops);

    switch (expectations.criterion) {
        case 'loop': {
            const { loop } = expectations;
            const onLoop = new Set(loop.nodes);
            // A CLD loop stands for a source loop only if each of its links is itself a faithful
            // summary of the source: two invented links that happen to close a cycle through the
            // loop's variables are not the loop.
            const kept = new Set(cld.names.keys());
            const faithful = (from, to) => {
                const polarity = cld.edges.get(from)?.get(to);
                const paths = pathPolarities(src, from, to, kept);
                return paths.size > 0 && (paths.has(polarity) || paths.has('?'));
            };
            const linksFaithful = (c) => c.nodes.every((n, i) => faithful(n, c.nodes[(i + 1) % c.nodes.length]));
            const candidates = findCycles(cld, CYCLE_CAP).filter((c) => c.nodes.length >= 2 && c.nodes.every((n) => onLoop.has(n)) && linksFaithful(c));
            const match = candidates.find((c) => c.polarity === loop.polarity);
            if (!match) {
                const near = candidates[0];
                failures.push({
                    type: 'Key loop missing',
                    details: near
                        ? `Loop ${loop.label} appears as ${near.nodes.join(' -> ')} but with ${near.polarity === '+' ? 'reinforcing' : near.polarity === '-' ? 'balancing' : 'unknown'} polarity; the source loop is ${loop.polarity === '+' ? 'reinforcing' : 'balancing'}.`
                        : `No loop in the CLD stands for source loop ${loop.label}. The source loop runs through: ${loop.nodes.join(' -> ')}.`
                });
            }
            break;
        }
        case 'links': {
            const kept = new Set(cld.names.keys());
            for (const name of unknownVariables(cld, src)) {
                failures.push({ type: 'Link not faithful to source', details: `"${cld.names.get(name)}" is not a variable in the source, so its links cannot be checked against it.` });
            }
            for (const [from, targets] of cld.edges) {
                for (const [to, polarity] of targets) {
                    if (!src.names.has(from) || !src.names.has(to)) continue;
                    const paths = pathPolarities(src, from, to, kept);
                    if (paths.size === 0) {
                        failures.push({ type: 'Link not faithful to source', details: `The CLD links "${cld.names.get(from)}" to "${cld.names.get(to)}", but in the source no causal path runs between them except through variables the CLD shows.` });
                    } else if (!paths.has(polarity) && !paths.has('?')) {
                        failures.push({ type: 'Link not faithful to source', details: `The CLD gives "${cld.names.get(from)}" -> "${cld.names.get(to)}" polarity ${polarity}, but every path between them in the source has polarity ${[...paths].join('/')}.` });
                    }
                }
            }
            break;
        }
        case 'succinct': {
            // The hard group carries its own, tighter limit (hardSuccinctLimit); the other groups use the share.
            const limit = expectations.succinctLimit ?? Math.max(SUCCINCT_MIN, Math.ceil(SUCCINCT_SHARE * expectations.sourceVariableCount));
            if (cld.names.size > limit) {
                failures.push({ type: 'CLD not succinct', details: expectations.succinctLimit ? `The CLD shows ${cld.names.size} variables; a summary with every chain collapsed shows the loops' core variables plus a little room, at most ${limit}.` : `The CLD shows ${cld.names.size} variables; the source has ${expectations.sourceVariableCount}, so a succinct summary shows at most ${limit}.` });
            }
            break;
        }
        case 'readFile': {
            // A document search reaches only uploaded files; a file read counts only when it read
            // the upload itself (uploads live under the session's rag/<fileId>/ directory).
            if (!readUpload(generatedResponse?.toolLog)) {
                failures.push({ type: 'Uploaded file not read', details: `The tool log shows no search_documents call and no read of the uploaded "${expectations.fileName}", so the CLD was not built from it.` });
            }
            break;
        }
        case 'hard': {
            // Every criterion of the hard group's source at once, each graded exactly as its own test.
            const { loops, ...shared } = expectations;
            const parts = [
                ...loops.map((loop) => ({ ...shared, criterion: 'loop', loop })),
                { ...shared, criterion: 'links' },
                { ...shared, criterion: 'succinct' },
                { ...shared, criterion: 'readFile' }
            ];
            for (const part of parts) failures.push(...evaluate(generatedResponse, part));
            break;
        }
        default:
            throw new Error(`Unknown criterion ${expectations.criterion}`);
    }
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('modelToCLD', {
    howItWorks: [
        `Each source model is summarized once by the engine, and that one causal loop diagram is graded by several tests, one criterion each. The engine builds the CLD as its model; the grader reads the model's signed relationships.`,
        `Stock-and-flow sources are the models whose loop dominance has been analysed for the feedback-explanation category. Their key loops are the ${KEY_LOOPS_PER_SFD} that dominate behavior for the longest share of the run, leaving out two-variable loops between a stock and its own flow, which a succinct diagram folds into the stock. They are given either as the current model or as an uploaded Stella file. CLD sources are built for this category and uploaded as Stella files: twenty gibberish-named diagrams generated from a seed, so only the file can say what is in them (seventeen of them held out: written after this grader was frozen and never used to tune it), and two real-domain diagrams. Every loop in a CLD source is key.`,
        `Hard group (uploadedCLDHard): five bigger generated diagrams of six loops each on two or three hubs (two dev, three held out by the same convention), uploaded with a prompt that names no method — no loops, chains or polarity, only a version the team can take in at a glance — and one test per diagram that needs every loop kept with its polarity, every link faithful, the diagram succinct and the file read, all at once. Succinct is held to a tighter tolerance by rule: the hard diagram may show no more variables than its loops' core variables (every chain collapsed) plus a little room for a useful extra (at least two, or a fifth more) — well under the ${100 * SUCCINCT_SHARE}% of the source the other groups allow.`,
        `A key loop is kept when some loop of the engine's CLD, of at least two variables, has the same polarity and runs only through variables on that source loop. Which of the loop's variables the summary keeps is the engine's choice: chains of intermediate variables may be collapsed — that is what summarizing means.`,
        `A CLD link is faithful when the source has a causal path between its two variables with the same polarity, going only through variables the CLD leaves out. Polarity in a stock-and-flow source comes from the analysed loop links, the model's relationships and its stock-flow structure; a source link of unknown polarity accepts either.`
    ],
    criteria: [
        { name: 'Key loop missing', description: 'No loop of the CLD stands for this key source loop, or the one that does has the wrong polarity. One test per key loop.' },
        { name: 'Link not faithful to source', description: 'A CLD link has no causal path behind it in the source, its polarity contradicts every such path, or it uses a variable the source does not have. Recorded once per offending link.' },
        { name: 'CLD not succinct', description: `The CLD shows more than ${100 * SUCCINCT_SHARE}% of the source's variables (at least ${SUCCINCT_MIN} are always allowed); in the hard group, more variables than the source's loops have core variables plus a little room.` },
        { name: 'Uploaded file not read', description: 'For uploaded sources: the tool log shows neither a document search nor a read of the uploaded file itself, so the diagram cannot have come from the file.' },
        { name: 'No causal loop diagram produced', description: 'The engine returned no model relationships with a polarity.' }
    ],
    scoring: `Each test checks one criterion of the same diagram, so a CLD that keeps two of three key loops passes two loop tests and fails one. Variables are matched to the source by name (case, spacing and underscores ignored), which is why the prompt asks the engine to keep the source's names. The hard group has one test per diagram, graded on every criterion together.`
});
