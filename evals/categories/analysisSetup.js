/**
 * This is the analysis setup test
 *
 * Before a modeler trusts a policy conclusion, they need to know which parameters it depends on.
 * Setting up that analysis is a skill of its own: picking the parameters worth sweeping, giving
 * them sensible ranges, recording the output the question is about, and reading off which
 * parameters matter. This category gives the agent a working model, a run_sensitivity tool and a
 * question about one measure of its behavior, and asks it to set up and run a sensitivity analysis
 * and report which parameters matter most and which hardly matter.
 *
 * The key comes from sweeping every constant of the model ±50% (verified in the unit tests, which
 * also check the same parameters stand out at ±20%). Grading, per scenario:
 *   - one test per influential parameter: the agent's run_sensitivity calls vary it (by at least
 *     10% from its value) while recording the measured output, and its answer reports it as one of
 *     the parameters that matter most (read by a judge from closed options)
 *   - no parameter that hardly moves the measure is reported as one that matters most
 *   - every swept value is plausible: the same sign as the parameter's value and within a factor of
 *     ten of it
 *
 * The analysisSetupHard group names neither the method nor the tool, grades every influential and
 * every negligible parameter together, and asks for a second answer from the same analysis: how low
 * and how high the measure could go with the parameters that matter off by up to half.
 *
 * @module categories/analysisSetup
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { measureFor, STANDOUT } from './analysisSetupData/deriveKey.js';
import { endWithin, RANGE_SHARE, RANGE_TOLERANCE } from './analysisSetupData/hardRange.js';
import { JOINT_SHARE, JOINT_CLEAR, JOINT_MIN_SHARE, jointEndWithin, bandOf } from './analysisSetupData/jointRange.js';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { extract } from '../utilities/judge.js';
import { callsTo } from '../utilities/toolLog.js';
import { findVariable, isNumericEquation, foldName } from '../utilities/modelDiff.js';
import { glossaryModel } from '../utilities/scenarios/renameModel.js';
import { scenarios } from '../utilities/scenarios/library.js';
import { withFloors } from '../floors/statement.js';
import { splitHeldOut, isHeldOutScenario, laterBatch } from '../utilities/heldOut.js';

export { STANDOUT };

/** How far from its value a parameter must be moved for a sweep of it to count. */
export const MIN_VARIATION = 0.10;
/** How far from its value a swept value may go: a factor of this either way. */
export const MAX_FACTOR = 10;

/**
 * Per scenario: the measured output, the measure in words and as a function of the output's series
 * and the run's times, and which parameters move it most, which hardly at all, and which are left
 * ungraded. Every key comes from the general rule in analysisSetupData/deriveKey.js, applied to
 * each scenario alike and frozen in keys.json (the unit tests re-derive it): no scenario has an entry
 * of its own.
 */
const KEYS = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'analysisSetupData', 'keys.json'), 'utf8'));
export const KEY = Object.fromEntries(Object.entries(KEYS).map(([id, k]) => [id, { ...k, measure: { label: k.label, of: measureFor(scenarios[id]).of } }]));

/**
 * Per hard scenario: the range of the measure with each influential parameter off by up to
 * RANGE_SHARE either way, one at a time — its lowest and highest, from the full run and as the
 * analysis tools show it (analysisSetupData/hardRange.js, frozen in hardRanges.json; the unit tests
 * re-derive it).
 */
export const HARD_RANGES = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'analysisSetupData', 'hardRanges.json'), 'utf8'));

/** The model's constants: the parameters an analysis can sweep. */
export const constantsOf = (model) => model.variables.filter((v) => v.type !== 'stock' && isNumericEquation(v.equation)).map((v) => ({ name: v.name, value: Number(v.equation) }));

export const description = () => {
    return `The analysis setup test evaluates whether an agent can set up a sensitivity analysis on a working model — sweeping the parameters that matter over sensible ranges while recording the measure in question — and report which parameters the measure depends on and which hardly matter. The key comes from sweeping every parameter of the model.`;
};

const prompt = (s, k) => `Here is my model of the ${s.title.toLowerCase()}. What I care about is ${k.measure.label}. Before I rely on the model, please set up and run a sensitivity analysis with the run_sensitivity tool to find out which parameters that depends on: choose the parameters and the ranges to test, run it, and then tell me which parameters matter most for it and which hardly matter. Please don't change the model itself.`;

const generateTests = function(id) {
    const s = scenarios[id];
    const k = KEY[id];
    const base = { prompt: prompt(s, k), currentModel: glossaryModel(s), additionalParameters: { mode: 'sfd', analysisTools: true, problemStatement: `I want to know what ${k.measure.label} depends on.` } };
    return [
        ...k.influential.map((p) => ({ ...base, name: `${s.title}: sweeps "${p}" and reports it as one that matters`, expectations: { scenario: id, criterion: 'influential', parameter: p } })),
        ...(k.negligible.length ? [{ ...base, name: `${s.title}: does not report a parameter that hardly matters as one that matters most`, expectations: { scenario: id, criterion: 'negligible' } }] : []),
        { ...base, name: `${s.title}: tests plausible values`, expectations: { scenario: id, criterion: 'ranges' } }
    ];
};

/**
 * The hard group's prompt names neither the method nor the tool: the user asks how far to trust the
 * model on the measure, which numbers matter and which could be left rough.
 */
const hardPrompt = (s, k) => `Here is my model of the ${s.title.toLowerCase()}. What I care about is ${k.measure.label}. How far can I trust what the model says about that? Which of its numbers would I most need to get right, and which could I safely leave rough? And if each of the numbers I would most need to get right were off by up to ${100 * RANGE_SHARE}% either way, one at a time, how low and how high could ${k.measure.label} go? Please don't change the model itself.`;

/**
 * The hard group: every scenario whose key has both influential and negligible parameters. Three
 * tests, each answering a whole sub-question at once: every influential parameter tested and said
 * to matter; every negligible one tested and said to hardly matter (counted only once the first
 * passes); and the range the measure could take with each parameter that matters off by up to
 * half, one at a time — a second answer that depends on the first, from the same analysis. The
 * answers split both ways, so calling everything important, or nothing, scores nothing.
 */
/**
 * Whether a scenario's range test is taken: every first-batch one; a later-batch one only when
 * neither end is zero, since an end off by a fifth must fail (the test "range: the simulated ends
 * pass, read either way; the status quo, constants, one end, or ends off by a fifth fail") and a
 * fifth of zero is zero.
 */
export const rangeTaken = (id) => !laterBatch({ scenario: id }) || (HARD_RANGES[id] && HARD_RANGES[id].low.exact !== 0 && HARD_RANGES[id].high.exact !== 0);

const generateHardTests = function(id) {
    const s = scenarios[id];
    const k = KEY[id];
    if (!k.negligible.length) return [];
    const base = { prompt: hardPrompt(s, k), currentModel: glossaryModel(s), additionalParameters: { mode: 'sfd', analysisTools: true, problemStatement: `I want to know how far to trust the model on ${k.measure.label}.` } };
    return [
        { ...base, name: `${s.title}: tests every parameter that matters (${k.influential.join(', ')}) and says each matters`, expectations: { scenario: id, criterion: 'allInfluential' } },
        { ...base, name: `${s.title}: tests every parameter that hardly matters (${k.negligible.join(', ')}) and says each hardly matters`, expectations: { scenario: id, criterion: 'allNegligible' } },
        ...(rangeTaken(id) ? [{ ...base, name: `${s.title}: gives how low and how high the measure could go with the parameters that matter off by up to half`, expectations: { scenario: id, criterion: 'range' } }] : [])
    ];
};

/**
 * The second hard group (analysisSetupHard2), held-out scenarios only: the range of the measure if
 * every constant of the model were off by up to JOINT_SHARE, all at once, in the worst combination
 * each way (analysisSetupData/jointRange.js, frozen in jointRanges.json with the reason for every
 * held-out scenario it does not take; the unit tests re-derive it). It needs no key of parameters
 * that matter, so it also takes scenarios whose influence is a continuum.
 */
export const JOINT_RANGES = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'analysisSetupData', 'jointRanges.json'), 'utf8'));
export const jointIds = Object.keys(JOINT_RANGES).filter((id) => scenarios[id] && isHeldOutScenario(id) && !JOINT_RANGES[id].skip);

const jointPrompt = (s, label) => `Here is my model of the ${s.title.toLowerCase()}. What I care about is ${label}. None of the model's constants — the fixed numbers it takes as given, not the levels it starts from — is known exactly: suppose every one of them could be off by up to ${100 * JOINT_SHARE}% either way, all at the same time. How low and how high could ${label} go, in the worst combination each way? Please don't change the model itself.`;

const generateJointTests = function(id) {
    const s = scenarios[id];
    const label = measureFor(s).label;
    return [{
        prompt: jointPrompt(s, label),
        currentModel: glossaryModel(s),
        additionalParameters: { mode: 'sfd', analysisTools: true, problemStatement: `I want to know how far ${label} could go with every number in the model a little off at once.` },
        name: `${s.title}: gives how low and how high the measure could go with every constant off by up to ${100 * JOINT_SHARE}% at once`,
        expectations: { scenario: id, criterion: 'jointRange' }
    }];
};

const rawGroups = {
    analysisSetup: Object.keys(KEY).flatMap(generateTests),
    analysisSetupHard: Object.keys(KEY).flatMap(generateHardTests),
    analysisSetupHard2: jointIds.flatMap(generateJointTests)
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => isHeldOutScenario(t.expectations.scenario));
const MATTERS = 'has a substantial effect';

const readingSchemaFor = (names) => z.object(Object.fromEntries(names.map((n, i) => [
    `q${i + 1}`,
    z.enum([MATTERS, 'hardly matters', 'not mentioned']).describe(`"${n}": what the answer says about this parameter's effect on the measure. '${MATTERS}' for any effect the answer presents as real and worth attention, large or moderate; 'hardly matters' if it says the effect is negligible or small enough to ignore.`)
])));

/**
 * The parameter values the agent tried, as {name (the model's), values, recordsOutput}: from its
 * run_sensitivity sweeps, and from what-if runs (run_scenario) that override a parameter with a
 * number.
 */
const sweepsOf = function(generatedResponse, model, outputName) {
    const out = [];
    for (const call of callsTo(generatedResponse?.toolLog, 'run_scenario')) {
        const recordsOutput = (call.arguments?.outputs || []).map(foldName).includes(foldName(outputName));
        for (const [name, value] of Object.entries(call.arguments?.overrides || {})) {
            const v = findVariable(model.variables, name);
            if (v && Number.isFinite(Number(value)) && String(value).trim() !== '') out.push({ name: v.name, values: [Number(value)], recordsOutput });
        }
    }
    for (const call of callsTo(generatedResponse?.toolLog, 'run_sensitivity')) {
        const outputs = (call.arguments?.outputs || []).map(foldName);
        const recordsOutput = outputs.includes(foldName(outputName));
        for (const p of call.arguments?.parameters || []) {
            const v = findVariable(model.variables, p?.name);
            if (v) out.push({ name: v.name, values: (p.values || []).map(Number), recordsOutput });
        }
    }
    return out;
};

/**
 * Evaluates one criterion.
 * @param {Object} generatedResponse The engine's response: text and tool log
 * @param {Object} expectations The criterion
 * @returns {Promise<Array<Object>>} Failures
 */
export const evaluate = async function(generatedResponse, expectations) {
    // Not over-reporting a negligible parameter counts only once some influential parameter is
    // tested and reported: an answer that reports nothing would otherwise pass.
    const own = await evaluateOne(generatedResponse, expectations);
    if (expectations.criterion === 'allNegligible') {
        const first = await evaluateOne(generatedResponse, { scenario: expectations.scenario, criterion: 'allInfluential' });
        return first.length ? validateEvaluationResult([...own, { type: 'Influential parameter not reported', details: 'This test counts only once every influential parameter is tested and reported; not all are.' }]) : own;
    }
    if (expectations.criterion !== 'negligible') return own;
    let any = false;
    for (const p of KEY[expectations.scenario].influential) if (!(await evaluateOne(generatedResponse, { scenario: expectations.scenario, criterion: 'influential', parameter: p })).length) { any = true; break; }
    return any ? own : validateEvaluationResult([...own, { type: 'Influential parameter not reported', details: 'This test counts only once at least one influential parameter is tested and reported; none is.' }]);
};

const rangeSchema = (label) => z.object({
    lowest: z.number().nullable().describe(`The lowest value the answer says ${label} could go to with the numbers that matter most off by up to half; null if it gives none.`),
    highest: z.number().nullable().describe(`The highest value the answer says ${label} could go to with the numbers that matter most off by up to half; null if it gives none.`)
});

/** The hard group's range: both ends within tolerance, read by the judge as numbers. */
const evaluateRange = async function(generatedResponse, id) {
    const k = KEY[id];
    const r = HARD_RANGES[id];
    const text = generatedResponse?.supportingInfo?.explanation || generatedResponse?.output?.textContent || '';
    if (!text.trim()) return validateEvaluationResult([{ type: 'Range wrong', details: 'The engine gave no answer.' }]);
    let reading;
    try {
        reading = await extract(`analysisSetup|range|${id}|${text}`, [
            { role: 'system', content: `You read an answer about a model and report the range it gives for ${k.measure.label} if each of the numbers that matter most were off by up to half either way: the lowest and the highest value it says the measure could take. Report only what the answer says.` },
            { role: 'user', content: `Answer:\n"""\n${text}\n"""` }
        ], rangeSchema(k.measure.label));
    } catch (error) {
        return validateEvaluationResult([{ type: 'Evaluation error', details: `Error reading the answer: ${error.message}` }]);
    }
    const failures = [];
    const show = (e) => (e.exact === e.shown ? `${e.exact}` : `${e.exact} (${e.shown} as the tools show it)`);
    if (!endWithin(reading?.lowest, r.low)) failures.push({ type: 'Range wrong', details: `The answer gives ${reading?.lowest ?? 'no'} as the lowest ${k.measure.label} could go; the model gives ${show(r.low)}.` });
    if (!endWithin(reading?.highest, r.high)) failures.push({ type: 'Range wrong', details: `The answer gives ${reading?.highest ?? 'no'} as the highest ${k.measure.label} could go; the model gives ${show(r.high)}.` });
    return validateEvaluationResult(failures);
};

/** The second hard group's joint range: both ends within tolerance, read by the judge as numbers. */
const evaluateJointRange = async function(generatedResponse, id) {
    const label = measureFor(scenarios[id]).label;
    const r = JOINT_RANGES[id];
    const text = generatedResponse?.supportingInfo?.explanation || generatedResponse?.output?.textContent || '';
    if (!text.trim()) return validateEvaluationResult([{ type: 'Joint range wrong', details: 'The engine gave no answer.' }]);
    let reading;
    try {
        reading = await extract(`analysisSetup|jointRange|${id}|${text}`, [
            { role: 'system', content: `You read an answer about a model and report the range it gives for ${label} if every constant of the model were off by up to ${100 * JOINT_SHARE}% either way, all at the same time, in the worst combination each way: the lowest and the highest value it says the measure could take. Report only what the answer says.` },
            { role: 'user', content: `Answer:\n"""\n${text}\n"""` }
        ], z.object({
            lowest: z.number().nullable().describe(`The lowest value the answer says ${label} could go to with every constant off by up to ${100 * JOINT_SHARE}% at once; null if it gives none.`),
            highest: z.number().nullable().describe(`The highest value the answer says ${label} could go to with every constant off by up to ${100 * JOINT_SHARE}% at once; null if it gives none.`)
        }));
    } catch (error) {
        return validateEvaluationResult([{ type: 'Evaluation error', details: `Error reading the answer: ${error.message}` }]);
    }
    const failures = [];
    const show = (e) => `${Math.min(...bandOf(e))} to ${Math.max(...bandOf(e))} (the worst-case corner ${e.corner}, searched further ${e.exact})`;
    if (!jointEndWithin(reading?.lowest, r.low)) failures.push({ type: 'Joint range wrong', details: `The answer gives ${reading?.lowest ?? 'no'} as the lowest ${label} could go; with every constant off at once the model gives ${show(r.low)} (one at a time, ${r.oneAtATime.low}).` });
    if (!jointEndWithin(reading?.highest, r.high)) failures.push({ type: 'Joint range wrong', details: `The answer gives ${reading?.highest ?? 'no'} as the highest ${label} could go; with every constant off at once the model gives ${show(r.high)} (one at a time, ${r.oneAtATime.high}).` });
    return validateEvaluationResult(failures);
};

const evaluateOne = async function(generatedResponse, expectations) {
    const id = expectations.scenario;
    if (expectations.criterion === 'range') return evaluateRange(generatedResponse, id);
    if (expectations.criterion === 'jointRange') return evaluateJointRange(generatedResponse, id);
    const s = scenarios[id];
    const k = KEY[id];
    const model = glossaryModel(s);
    const constants = constantsOf(model);
    const valueOf = (name) => constants.find((c) => c.name === name)?.value;
    const sweeps = sweepsOf(generatedResponse, model, k.output);
    const failures = [];

    if (expectations.criterion === 'ranges') {
        if (!sweeps.length) return validateEvaluationResult([{ type: 'Implausible ranges', details: 'The agent ran no sensitivity analysis on the model\'s parameters.' }]);
        for (const sweep of sweeps) {
            const base = valueOf(sweep.name);
            if (base === undefined || base === 0) continue;
            // Zero is plausible too: switching a parameter off is a standard sensitivity test.
            const bad = sweep.values.filter((x) => !Number.isFinite(x) || (x !== 0 && (Math.sign(x) !== Math.sign(base) || Math.abs(x / base) > MAX_FACTOR || Math.abs(x / base) < 1 / MAX_FACTOR)));
            if (bad.length) failures.push({ type: 'Implausible ranges', details: `"${sweep.name}" (${base}) was tested at ${bad.join(', ')}: a different sign, or more than a factor of ${MAX_FACTOR} away.` });
        }
        return validateEvaluationResult(failures);
    }

    const text = generatedResponse?.supportingInfo?.explanation || generatedResponse?.output?.textContent || '';
    const names = constants.map((c) => c.name);
    let reading = {};
    if (text.trim()) {
        try {
            reading = await extract(`analysisSetup|${id}|${text}`, [
                { role: 'system', content: 'You read the results of a sensitivity analysis and report, for each listed parameter, whether the answer says it has a substantial effect on the measure in question or hardly matters. Report only what the answer says.' },
                { role: 'user', content: `Measure: ${k.measure.label}\n\nParameters:\n${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n\nAnswer:\n"""\n${text}\n"""` }
            ], readingSchemaFor(names));
        } catch (error) {
            return validateEvaluationResult([{ type: 'Evaluation error', details: `Error reading the answer: ${error.message}` }]);
        }
    }
    const reportedAsKey = (name) => reading[`q${names.indexOf(name) + 1}`] === MATTERS;
    const sweptEnough = (name) => sweeps.some((x) => x.name === name && x.recordsOutput && x.values.some((v) => Math.abs(v - valueOf(name)) >= MIN_VARIATION * Math.abs(valueOf(name))));

    if (expectations.criterion === 'allInfluential' || expectations.criterion === 'allNegligible') {
        const wantMatters = expectations.criterion === 'allInfluential';
        for (const p of wantMatters ? k.influential : k.negligible) {
            const name = findVariable(model.variables, p).name;
            if (!sweptEnough(name)) failures.push({ type: wantMatters ? 'Influential parameter not tested' : 'Negligible parameter not tested', details: `No sensitivity or what-if run varied "${name}" by ${100 * MIN_VARIATION}% or more while recording "${k.output}".` });
            const said = reading[`q${names.indexOf(name) + 1}`];
            if (wantMatters && said !== MATTERS) failures.push({ type: 'Influential parameter not reported', details: `"${name}" moves ${k.measure.label} strongly, but the answer does not say it has a substantial effect.` });
            if (!wantMatters && said !== 'hardly matters') failures.push({ type: said === MATTERS ? 'Negligible parameter reported' : 'Negligible parameter not called minor', details: `"${name}" hardly moves ${k.measure.label}, but the answer ${said === MATTERS ? 'says it has a substantial effect' : 'does not say it hardly matters'}.` });
        }
        return validateEvaluationResult(failures);
    }

    if (expectations.criterion === 'influential') {
        const name = findVariable(model.variables, expectations.parameter).name;
        const base = valueOf(name);
        const swept = sweeps.some((x) => x.name === name && x.recordsOutput && x.values.some((v) => Math.abs(v - base) >= MIN_VARIATION * Math.abs(base)));
        if (!swept) failures.push({ type: 'Influential parameter not tested', details: `"${name}" moves ${k.measure.label} strongly, but no sensitivity or what-if run varied it by ${100 * MIN_VARIATION}% or more while recording "${k.output}".` });
        if (!reportedAsKey(name)) failures.push({ type: 'Influential parameter not reported', details: `"${name}" moves ${k.measure.label} strongly, but the answer does not say it has a substantial effect.` });
    } else if (expectations.criterion === 'negligible') {
        const wrong = k.negligible.map((p) => findVariable(model.variables, p).name).filter(reportedAsKey);
        if (wrong.length) failures.push({ type: 'Negligible parameter reported', details: `${wrong.map((n) => `"${n}"`).join(', ')} hardly ${wrong.length > 1 ? 'move' : 'moves'} ${k.measure.label}, but the answer says ${wrong.length > 1 ? 'they have' : 'it has'} a substantial effect.` });
    } else {
        throw new Error(`Unknown criterion ${expectations.criterion}`);
    }
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('analysisSetup', {
    howItWorks: [
        `Each test gives the agent a working model of a hidden scenario — a dialysis waiting list, a bike-share scheme, a distributor's inventory — a run_sensitivity tool, and one measure of its behavior to analyse (the waiting list's peak, members at month 18, the inventory overshoot). The agent is asked to choose parameters and ranges, run a sensitivity analysis, and report which parameters matter most and which hardly matter.`,
        `The key comes from sweeping every constant of the model ±50%: the influential parameters each move the measure at least ${STANDOUT} times as much as any other, and the negligible ones barely at all (under 10%). The same rule gives every scenario's key. A parameter whose change throws a model that starts in balance out of balance at the first step is left ungraded (its stocks start at typed-in values, so changing it mostly moves the start). Influential parameters must also move the measure by at least 20% at ±50%. The unit tests re-derive both, and check that the same parameters stand out by the same margin at ±20%, so the key does not hang on the ranges the agent picks.`,
        `The hard group (analysisSetupHard) takes every scenario whose key has both influential and negligible parameters, asks without naming the method or the tool how far the model can be trusted on the measure and which numbers matter or could be left rough, and has two tests that each answer a whole sub-question at once — every influential parameter tested and said to matter, and every negligible one tested and said to hardly matter (counted only once the first passes) — so the answers split both ways and calling everything, or nothing, important scores nothing — and a third that needs a second answer from the same analysis, depending on the first: how low and how high the measure could go with each parameter that matters off by up to ${100 * RANGE_SHARE}% either way, one at a time (both ends simulated over tenths of that range, each within ${100 * RANGE_TOLERANCE}% of its own size, read from the full run or as the analysis tools show it).`,
        `The second hard group (analysisSetupHard2, held-out scenarios only) asks, again without naming the method or the tool, how low and how high the measure could go if every constant of the model were off by up to ${100 * JOINT_SHARE}% either way, all at the same time, in the worst combination each way: the agent must itself decide which numbers to move and which way, and combine them, where the first hard group moved the parameters that matter one at a time. It needs no key of parameters that matter, so it takes scenarios whose influence is a continuum too. Each end is simulated (analysisSetupData/jointRange.js): every constant at the end of its range that pushes the measure that way on its own (the worst-case corner), then improved one constant at a time over half-steps of its range until nothing moves it further; an answer counts within ${100 * RANGE_TOLERANCE}% of the band between the corner and the improved end (each from the full run or as the analysis tools show it), so combining the worst cases counts and so does searching further. A scenario is taken only when neither end is near zero (under ${100 * JOINT_MIN_SHARE}% of the status quo), both ends stand more than ${100 * JOINT_CLEAR}% from the status quo, and at least one more than ${100 * JOINT_CLEAR}% beyond the one-at-a-time range (each constant moved alone by the same amount) — so the status quo, or the first hard group's level of answer, fails. One test needs both ends.`,
        `Each influential parameter is a test: some run_sensitivity or run_scenario call (read from the tool log) must vary it by at least ${100 * MIN_VARIATION}% while recording the measured output, and the answer — read by a fixed judge model from closed options — must say it has a substantial effect (a moderate effect presented as real counts; only "hardly matters" does not). One test checks that no negligible parameter is said to have a substantial effect, and one that every swept value is plausible: zero (switching the parameter off), or the parameter's sign and within a factor of ${MAX_FACTOR} of its value.`
    ],
    criteria: [
        { name: 'Influential parameter not tested', description: 'No sensitivity or what-if run varied a parameter the measure depends on strongly, while recording the measured output.' },
        { name: 'Influential parameter not reported', description: 'The answer does not say that a parameter the measure depends on strongly has a substantial effect.' },
        { name: 'Negligible parameter reported', description: 'A parameter that barely moves the measure is said to have a substantial effect.' },
        { name: 'Negligible parameter not tested', description: 'Hard group: no sensitivity or what-if run varied a parameter that barely moves the measure, so the answer cannot know it hardly matters.' },
        { name: 'Negligible parameter not called minor', description: 'Hard group: the answer does not say that a parameter that barely moves the measure hardly matters.' },
        { name: 'Range wrong', description: `Hard group: the lowest or highest value the answer gives for the measure, with the parameters that matter off by up to ${100 * RANGE_SHARE}% one at a time, is not within ${100 * RANGE_TOLERANCE}% of the simulated one, or is not given.` },
        { name: 'Joint range wrong', description: `Second hard group: the lowest or highest value the answer gives for the measure, with every constant off by up to ${100 * JOINT_SHARE}% at once in the worst combination, is not within ${100 * RANGE_TOLERANCE}% of the simulated band (the worst-case corner to the end searched further), or is not given.` },
        { name: 'Implausible ranges', description: 'A parameter was tested at a non-zero value of the wrong sign or more than a factor of ten from its value, or no sensitivity analysis was run.' },
        { name: 'Evaluation error', description: 'The judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `One test per influential parameter, one against reporting negligible ones (where a scenario has any) and one for plausible ranges, all graded from one session. The hard group has three tests per scenario: two each needing every parameter of its kind right, and the measure's range. The second hard group has one test per scenario: both ends of the joint range.`
});
