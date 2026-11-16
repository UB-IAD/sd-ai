/**
 * This is the policy analysis methods test
 *
 * A model answers different questions with different analyses: "what happens if" is a scenario
 * run, "what matters most" a sensitivity analysis, "what values match our history" a calibration,
 * "what setting is best" an optimization. An assistant should pick the analysis that fits the
 * question, carry it out with the tools it has, and get the answer right. This category asks four
 * such questions of the hidden scenarios' models, with the analysis tools available, and never
 * names the method.
 *
 * Grading, two tests per question, both deterministic except where noted:
 *   - method: the agent's tool log shows the analysis that fits — an optimization or a search over
 *     the lever, a sensitivity run over the parameters in question, a calibration to the data, a
 *     what-if run with the change in question
 *   - result: the answer is right against the hidden model — the chosen lever value comes within 3%
 *     of the lowest cost a brute-force search finds; the parameter named as mattering more is the
 *     one the sweep says (read by a judge from closed options); the calibrated model fits the data;
 *     the predicted peak is within 10% of the simulated one (read by a judge as a number)
 *
 * The policyAnalysisMethodsHard group asks, for a lever and its realistic limit, whether the goal
 * can be met within the limit, how far the lever must go and the goal measure at the limit; goals
 * within reach are balanced by goals out of reach, so answering every question with a value, or
 * every one with "it cannot be done", fails part of the group.
 *
 * @module categories/policyAnalysisMethods
 */

import { z } from 'zod';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { extract } from '../utilities/judge.js';
import { callsTo } from '../utilities/toolLog.js';
import { bareModel, simulateModel } from '../utilities/simulateModel.js';
import { findVariable, foldName } from '../utilities/modelDiff.js';
import { glossaryModel } from '../utilities/scenarios/renameModel.js';
import { scenarios } from '../utilities/scenarios/library.js';
import { cases as calibrationCases, givenModel as calibrationModel } from './calibrationData/cases.js';
import { dataOf, rSquared, structureChanges, FIT_R_SQUARED } from './calibration.js';
import { withFloors } from '../floors/statement.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SAMPLE_POINTS } from '../utilities/analysisTools.js';
import { scenarioModel, SCENARIO_FACTOR, MIN_SCENARIO_CHANGE, MIN_TRUTH_SHARE, SENSITIVITY_MARGIN, HARD_CROSSING, HARD_LEVER_TOLERANCE, HARD_MEASURE_TOLERANCE, REACH_MOVE, ROBUST_SHARE, ROBUST_MAX_SHARE } from './policyAnalysisMethodsData/generate.js';
import { splitHeldOut, caseHeldOut } from '../utilities/heldOut.js';

export const COST_TOLERANCE = 0.03;
export const PEAK_TOLERANCE = 0.10;
/** The hard group's closed reading of whether the goal is within the lever's reach. */
export const REACH = { yes: 'says the goal can be met within that limit', no: 'says the goal cannot be met even at the limit', unsaid: 'does not say' };
/** How many distinct values of the lever a search by hand must try to count as a search. */
export const SEARCH_POINTS = 4;

/** The dialysis model with what chairs and waiting cost, and a running total of both. */
export const costModel = function() {
    const m = glossaryModel(scenarios.dialysisClinic);
    m.variables.push(
        { name: 'total cost', type: 'stock', equation: '0', inflows: ['costs'], outflows: [], units: 'thousand dollars' },
        { name: 'costs', type: 'flow', equation: 'chairs * chair_cost + waiting_list * waiting_cost', units: 'thousand dollars/month' },
        { name: 'chair cost', type: 'variable', equation: '1', units: 'thousand dollars/(chair*month)' },
        { name: 'waiting cost', type: 'variable', equation: '4', units: 'thousand dollars/(patient*month)' }
    );
    return { ...m, specs: scenarios.dialysisClinic.model.specs };
};

/** Total cost over the run with the target wait at a value. */
export const costAt = async function(targetWait) {
    const run = await simulateModel(costModel(), ['total cost'], { 'target wait': String(targetWait) });
    if (!run.ok) throw new Error(`The cost run failed: ${run.error}`);
    return run.series['total cost'][run.series['total cost'].length - 1];
};

let bestCostRun = null;

/**
 * The brute-force optimum over target waits from a week to six months. It is the same every time,
 * so it is computed once per process (over a hundred runs) and shared by every grade.
 */
export const bestCost = function() {
    if (!bestCostRun) {
        bestCostRun = (async () => {
            let best = { targetWait: null, cost: Infinity };
            for (let tw = 0.25; tw <= 6 + 1e-9; tw += 0.05) {
                const cost = await costAt(tw);
                if (cost < best.cost) best = { targetWait: Number(tw.toFixed(2)), cost };
            }
            return best;
        })();
        bestCostRun.catch(() => { bestCostRun = null; });
    }
    return bestCostRun;
};

const CALIBRATION_CASE = 'Distributor, parameters';
const REFERRAL_JUMP = 45;

export const handCases = {
    'Dialysis cost optimum': {
        kind: 'optimization',
        model: costModel,
        prompt: 'Here is my model of our dialysis network. Each chair costs us about $1,000 a month to run, and each patient left waiting costs about $4,000 a month in emergency care; the model adds both up in "total cost". We order chairs to bring the wait down to a target. What target wait should we order for, to keep the total cost over the four years as low as possible? Work it out with the model, and set "target wait" in the model to your answer.',
        lever: 'target wait'
    },
    'Bike share drivers': {
        kind: 'sensitivity',
        model: () => glossaryModel(scenarios.bikeShare),
        prompt: 'Here is my model of our bike-share scheme. Neither our advertising effect nor how persuasive riders are when they talk about the scheme is known well — either could easily be 20% off. Which of the two matters more for how many members we will have at month 18? Please base your answer on the model, and don\'t change it.',
        parameters: ['advertising effect', 'persuasion'],
        baseValues: { 'advertising effect': 0.0005, 'persuasion': 0.025 },
        answer: 'persuasion',
        options: ['advertising effect', 'persuasion']
    },
    'Distributor history': {
        kind: 'calibration',
        model: () => calibrationModel(calibrationCases[CALIBRATION_CASE]),
        prompt: 'Here is my model of our distributor\'s inventory, and we have the history of our inventory, which you can load. The model doesn\'t match it yet. Please find the values of the model\'s parameters that make it match our history, and return the model with them in place.',
        calibrationCase: CALIBRATION_CASE
    },
    'Dialysis referral jump': {
        kind: 'scenario',
        model: () => glossaryModel(scenarios.dialysisClinic),
        prompt: `Here is my model of our dialysis network. If referrals had been ${REFERRAL_JUMP} a month instead of 36 from the start, how high would the waiting list have peaked? Please work it out with the model and give me the number; don't change the model itself.`,
        // The jump can be made on the constant or on the flow it feeds; both give the same run.
        overrideNames: ['base referrals', 'referrals'],
        overrideValue: REFERRAL_JUMP
    }
};

const GENERATED = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'policyAnalysisMethodsData', 'generated.json'), 'utf8'));
/**
 * Cases made by the general rule in policyAnalysisMethodsData/generate.js for every scenario the
 * hand-written cases do not use (see buildGenerated.js). Entries for a scenario that is not
 * registered (a stale file) are skipped.
 */
export const generatedCases = Object.fromEntries(Object.entries(GENERATED).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => [name, {
    ...g,
    model: g.kind === 'calibration' ? () => calibrationModel(calibrationCases[g.calibrationCase]) : () => scenarioModel(scenarios[g.scenario])
}]));

export const cases = { ...handCases, ...generatedCases };

const HARD = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'policyAnalysisMethodsData', 'hardGenerated.json'), 'utf8'));
/**
 * The hard group's cases, by the rules in policyAnalysisMethodsData/generate.js: for a lever
 * management controls, whether the goal can be met within the lever's realistic limit, the value
 * that just meets it and the goal measure at the limit, with no method named — for a goal within
 * reach (generateHardCase) and, balancing them, one out of reach (generateUnreachableCase).
 */
export const hardCases = Object.fromEntries(Object.entries(HARD).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => [name, { ...g, model: () => scenarioModel(scenarios[g.scenario]) }]));
const ROBUST = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'policyAnalysisMethodsData', 'robustGenerated.json'), 'utf8'));
/**
 * The second hard group's cases (policyAnalysisMethodsHard2), held-out scenarios only, by the rule
 * in policyAnalysisMethodsData/generate.js (generateRobustCase): how far a lever must go to just
 * meet the goal, and then how far to be sure of meeting it however an uncertain quantity turns out
 * within ±ROBUST_SHARE — the direction in which it hurts not told.
 */
export const robustCases = Object.fromEntries(Object.entries(ROBUST.cases).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => [name, { ...g, model: () => scenarioModel(scenarios[g.scenario]) }]));
/** The held-out scenarios the second hard group's rule gives no case. */
export const robustSkipped = ROBUST.skipped;
const caseOf = (name) => cases[name] ?? hardCases[name] ?? robustCases[name];

/** The simulated peak for the referral question. */
export const truePeak = async function() {
    const m = glossaryModel(scenarios.dialysisClinic);
    const run = await simulateModel({ ...m, specs: scenarios.dialysisClinic.model.specs }, ['waiting list'], { 'base referrals': String(REFERRAL_JUMP) });
    if (!run.ok) throw new Error(run.error);
    return Math.max(...run.series['waiting list']);
};

export const description = () => {
    return `The policy analysis methods test evaluates whether an agent picks the analysis that fits a question — a what-if run, a sensitivity analysis, a calibration or an optimization — carries it out with the model's analysis tools, and gets the answer right against the hidden model.`;
};

const generateTests = function(name) {
    const c = caseOf(name);
    const series = c.kind === 'calibration' ? calibrationCases[c.calibrationCase].series : null;
    const calibrationData = c.kind === 'calibration' ? { description: `Historical observations of ${series}.`, series: { [series]: dataOf(c.calibrationCase) } } : undefined;
    const base = {
        prompt: c.prompt,
        currentModel: c.model(),
        additionalParameters: { mode: 'sfd', analysisTools: true, ...(calibrationData ? { calibrationData } : {}), problemStatement: 'I want to use my model to answer a question.' }
    };
    return [
        { ...base, name: `${name}: uses the analysis that fits the question (${c.kind})`, expectations: { caseName: name, criterion: 'method' } },
        { ...base, name: `${name}: gets the answer right`, expectations: { caseName: name, criterion: 'result' } }
    ];
};

const rawGroups = {
    policyAnalysisMethods: Object.keys(cases).flatMap(generateTests),
    policyAnalysisMethodsHard: Object.keys(hardCases).flatMap(generateTests),
    policyAnalysisMethodsHard2: Object.keys(robustCases).map((name) => {
        const c = robustCases[name];
        return {
            prompt: c.prompt,
            currentModel: c.model(),
            additionalParameters: { mode: 'sfd', analysisTools: true, problemStatement: 'I want to use my model to answer a question.' },
            name: `${name}: both settings right — the one that just meets the goal, and the one that meets it however "${c.uncertain}" turns out`,
            expectations: { caseName: name, criterion: 'robustResult' }
        };
    })
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => caseHeldOut(caseOf(t.expectations.caseName)));
const textOf = (r) => r?.supportingInfo?.explanation || r?.output?.textContent || '';
const named = (args, name) => foldName(args?.name) === foldName(name);

/** Whether the tool log shows the analysis that fits the case. */
export const usedMethod = function(c, log) {
    switch (c.kind) {
        case 'threshold':
        case 'optimization': {
            if (callsTo(log, 'run_optimization').some((call) => named(call.arguments?.lever, c.lever))) return true;
            const tried = new Set();
            for (const call of callsTo(log, 'run_scenario')) for (const [k, v] of Object.entries(call.arguments?.overrides || {})) if (foldName(k) === foldName(c.lever)) tried.add(Number(v));
            for (const call of callsTo(log, 'run_sensitivity')) for (const p of call.arguments?.parameters || []) if (named(p, c.lever)) for (const v of p.values || []) tried.add(Number(v));
            // A goal out of reach is shown by one run with the lever at its limit; no search needed.
            if (c.reachable === false && [...tried].some((v) => Math.abs(v - c.limit) <= 1e-9 * Math.max(1, Math.abs(c.limit)))) return true;
            return tried.size >= SEARCH_POINTS;
        }
        case 'sensitivity': {
            // A sensitivity run over the parameter, or what-if runs that move it by 10% or more.
            const swept = new Set();
            for (const call of callsTo(log, 'run_sensitivity')) for (const p of call.arguments?.parameters || []) swept.add(foldName(p?.name));
            for (const call of callsTo(log, 'run_scenario')) {
                for (const [k, v] of Object.entries(call.arguments?.overrides || {})) {
                    const p = c.parameters.find((x) => foldName(x) === foldName(k));
                    if (p && Number.isFinite(Number(v)) && Math.abs(Number(v) - c.baseValues[p]) >= 0.1 * c.baseValues[p]) swept.add(foldName(p));
                }
            }
            return c.parameters.every((p) => swept.has(foldName(p)));
        }
        case 'calibration':
            return callsTo(log, 'run_calibration').length > 0;
        case 'scenario':
            return callsTo(log, 'run_scenario').some((call) => Object.entries(call.arguments?.overrides || {}).some(([k, v]) => c.overrideNames.some((n) => foldName(k) === foldName(n)) && Number(v) === c.overrideValue));
        default:
            throw new Error(`Unknown kind ${c.kind}`);
    }
};

const METHOD_WORDS = { threshold: 'a search over the lever (run_optimization, or what-if runs at several values; for a goal out of reach, a run at the limit will do)', optimization: 'a search over the lever (run_optimization, or what-if runs at several values)', sensitivity: 'a sensitivity analysis over both parameters', calibration: 'a calibration to the data', scenario: 'a what-if run with the change in question' };

/**
 * Evaluates one criterion.
 * @param {Object} generatedResponse The engine's response: model, text and tool log
 * @param {Object} expectations The criterion
 * @returns {Promise<Array<Object>>} Failures
 */
/**
 * Whether a predicted measure at the limit is within HARD_MEASURE_TOLERANCE of the simulated one —
 * either at full resolution or on the grid the run_scenario tool returns, since an agent reading
 * that output sees only the grid.
 */
export const nearLimitMeasure = (x, c) => typeof x === 'number' && [c.truth, c.sampledTruth ?? c.truth].some((t) => Math.abs(x - t) <= HARD_MEASURE_TOLERANCE * Math.abs(t));

/** The second hard group: both lever settings, read as numbers, each within the first hard group's lever tolerance. */
const evaluateRobust = async function(generatedResponse, expectations) {
    const c = caseOf(expectations.caseName);
    const text = textOf(generatedResponse);
    if (!text.trim()) return validateEvaluationResult([{ type: 'No answer given', details: 'The engine gave no answer.' }]);
    let reading;
    try {
        reading = await extract(`policyAnalysisMethods|robust|${expectations.caseName}|${text}`, [
            { role: 'system', content: `You read an answer and report two values it gives for "${c.lever}": the value it says would just meet the goal, and the value it says would be needed to be sure of meeting the goal however "${c.uncertain}" turns out within ${100 * ROBUST_SHARE}% either way. Report only what the answer says.` },
            { role: 'user', content: `Answer:\n"""\n${text}\n"""` }
        ], z.object({
            needed_value: z.number().nullable().describe(`The value of "${c.lever}" the answer says would just meet the goal, with "${c.uncertain}" as it is; null if it gives none.`),
            sure_value: z.number().nullable().describe(`The value of "${c.lever}" the answer says would meet the goal however "${c.uncertain}" turns out within ${100 * ROBUST_SHARE}%; null if it gives none.`)
        }));
    } catch (error) {
        return validateEvaluationResult([{ type: 'Evaluation error', details: `Error reading the answer: ${error.message}` }]);
    }
    const band = HARD_LEVER_TOLERANCE * Math.abs(c.limit - c.current);
    const near = (x, t) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x - t) <= band;
    const failures = [];
    if (!near(reading.needed_value, c.crossing)) failures.push({ type: 'Wrong answer', details: `The answer says "${c.lever}" must reach ${reading.needed_value ?? 'nothing'}; in the model the goal is just met at ${c.crossing}.` });
    if (!near(reading.sure_value, c.robustCrossing)) failures.push({ type: 'Uncertainty not allowed for', details: `The answer says ${reading.sure_value ?? 'nothing'} would make sure of the goal; with "${c.uncertain}" ${100 * ROBUST_SHARE}% ${c.adverseFactor < 1 ? 'lower' : 'higher'} the goal is only met at ${c.robustCrossing} (at the other end of the range, ${c.otherCrossing}).` });
    return validateEvaluationResult(failures);
};

export const evaluate = async function(generatedResponse, expectations) {
    if (expectations.criterion === 'robustResult') return evaluateRobust(generatedResponse, expectations);
    const c = caseOf(expectations.caseName);
    const failures = [];
    if (expectations.criterion === 'method') {
        if (!usedMethod(c, generatedResponse?.toolLog)) failures.push({ type: 'Wrong method', details: `The question calls for ${METHOD_WORDS[c.kind]}; the agent's tool log shows none.` });
        return validateEvaluationResult(failures);
    }
    if (expectations.criterion !== 'result') throw new Error(`Unknown criterion ${expectations.criterion}`);
    switch (c.kind) {
        case 'optimization': {
            const model = bareModel(generatedResponse);
            const v = Number(findVariable(model?.variables || [], c.lever)?.equation);
            if (!Number.isFinite(v)) { failures.push({ type: 'Wrong answer', details: `The returned model has no numeric "${c.lever}".` }); break; }
            const [cost, best] = [await costAt(v), await bestCost()];
            if (cost > best.cost * (1 + COST_TOLERANCE)) failures.push({ type: 'Wrong answer', details: `A target wait of ${v} gives a total cost of ${Math.round(cost)}; the lowest, at about ${best.targetWait}, is ${Math.round(best.cost)} — more than ${100 * COST_TOLERANCE}% better.` });
            break;
        }
        case 'calibration': {
            const model = bareModel(generatedResponse);
            const cal = calibrationCases[c.calibrationCase];
            const structural = model ? structureChanges(c.model(), model) : [];
            if (structural.length) failures.push({ type: 'Wrong answer', details: `Calibration should only change parameter values, but ${structural.slice(0, 3).join('; ')}.` });
            const r2 = model ? await rSquared(model, cal, dataOf(c.calibrationCase)) : null;
            if (r2 === null || r2 < FIT_R_SQUARED) failures.push({ type: 'Wrong answer', details: r2 === null ? `The returned model has no "${cal.series}", or does not run.` : `The returned model fits the history with R² ${r2.toFixed(3)}; a calibrated model reaches ${FIT_R_SQUARED}.` });
            break;
        }
        case 'threshold': {
            const text = textOf(generatedResponse);
            if (!text.trim()) { failures.push({ type: 'No answer given', details: 'The engine gave no answer.' }); break; }
            let reading;
            try {
                reading = await extract(`policyAnalysisMethods|${expectations.caseName}|${text}`, [
                    { role: 'system', content: `You read an answer and report whether it says the goal can be met by taking "${c.lever}" no further than ${c.limit}, and two numbers it gives: the value "${c.lever}" would have to reach to just meet the goal, and the value it predicts for ${c.quantity} with "${c.lever}" at ${c.limit}. Report only what the answer says.` },
                    { role: 'user', content: `Answer:\n"""\n${text}\n"""` }
                ], z.object({
                    reach: z.enum([REACH.yes, REACH.no, REACH.unsaid]).describe(`Whether the answer says the goal can be met with "${c.lever}" taken no further than ${c.limit}.`),
                    needed_value: z.number().nullable().describe(`The value of "${c.lever}" the answer says is needed to just meet the goal; null if it gives none.`),
                    at_limit: z.number().nullable().describe(`The value the answer predicts for ${c.quantity} with "${c.lever}" at ${c.limit}; null if it gives none.`)
                }));
            } catch (error) {
                failures.push({ type: 'Evaluation error', details: `Error reading the answer: ${error.message}` });
                break;
            }
            if (c.reachable === false) {
                if (reading.reach !== REACH.no) failures.push({ type: 'Wrong answer', details: `The goal cannot be met with "${c.lever}" taken no further than ${c.limit}, but the reading of the answer is "${reading.reach}".` });
                if (!nearLimitMeasure(reading.at_limit, c)) failures.push({ type: 'Wrong answer', details: `The answer predicts ${reading.at_limit ?? 'nothing'} for ${c.quantity} at the limit; the model gives ${Number(c.truth.toPrecision(4))}.` });
                break;
            }
            if (reading.reach !== REACH.yes) failures.push({ type: 'Wrong answer', details: `The goal can be met with "${c.lever}" taken no further than ${c.limit}, but the reading of the answer is "${reading.reach}".` });
            const band = HARD_LEVER_TOLERANCE * Math.abs(c.limit - c.current);
            if (typeof reading.needed_value !== 'number' || Math.abs(reading.needed_value - c.crossing) > band) failures.push({ type: 'Wrong answer', details: `The answer says "${c.lever}" must reach ${reading.needed_value ?? 'nothing'}; in the model the goal is just met at ${Number(c.crossing.toPrecision(4))}.` });
            if (!nearLimitMeasure(reading.at_limit, c)) failures.push({ type: 'Wrong answer', details: `The answer predicts ${reading.at_limit ?? 'nothing'} for ${c.quantity} at the limit; the model gives ${Number(c.truth.toPrecision(4))}.` });
            break;
        }
        case 'sensitivity':
        case 'scenario': {
            const text = textOf(generatedResponse);
            if (!text.trim()) { failures.push({ type: 'No answer given', details: 'The engine gave no answer.' }); break; }
            // A choice between two parameters is a coin toss without the analysis: the answer counts
            // only when the tool log shows both were varied.
            if (c.kind === 'sensitivity' && !usedMethod(c, generatedResponse?.toolLog)) { failures.push({ type: 'Wrong method', details: 'The answer picks one of the two parameters without the model having been run with either varied.' }); break; }
            try {
                if (c.kind === 'sensitivity') {
                    const reading = await extract(`policyAnalysisMethods|${expectations.caseName}|${text}`, [
                        { role: 'system', content: 'You read an answer and report which of two parameters it says matters more. Report only what the answer says.' },
                        { role: 'user', content: `Parameters: ${c.options.join('; ')}\n\nAnswer:\n"""\n${text}\n"""` }
                    ], z.object({ matters_more: z.enum([...c.options, 'neither or unclear']) }));
                    if (reading.matters_more !== c.answer) failures.push({ type: 'Wrong answer', details: `The answer says "${reading.matters_more}" matters more; in the model, "${c.answer}" moves ${c.measureLabel ?? 'members at month 18'} several times as much.` });
                } else {
                    const reading = await extract(`policyAnalysisMethods|${expectations.caseName}|${text}`, [
                        { role: 'system', content: `You read an answer and report the number it gives for ${c.quantity ?? 'the peak of the waiting list'}. Report only what the answer says.` },
                        { role: 'user', content: `Answer:\n"""\n${text}\n"""` }
                    ], z.object({ peak: z.number().nullable().describe(c.quantity ? `The value the answer predicts for ${c.quantity}; null if it gives none.` : 'The peak waiting list the answer predicts, in patients; null if it gives none.') }));
                    const truth = c.truth ?? await truePeak();
                    if (typeof reading.peak !== 'number' || Math.abs(reading.peak - truth) > PEAK_TOLERANCE * truth) failures.push({ type: 'Wrong answer', details: `The answer predicts a peak of ${reading.peak ?? 'nothing'}; the model gives ${Number(truth.toPrecision(4))}.` });
                }
            } catch (error) {
                failures.push({ type: 'Evaluation error', details: `Error reading the answer: ${error.message}` });
            }
            break;
        }
        default:
            throw new Error(`Unknown kind ${c.kind}`);
    }
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('policyAnalysisMethods', {
    howItWorks: [
        `Four questions are asked of the hidden scenarios' models, with the analysis tools available and no method named: which target wait keeps a dialysis network's total cost lowest (an optimization), which of two uncertain parameters matters more for a bike-share scheme (a sensitivity analysis), what parameter values make a distributor's model match its history (a calibration), and how high a waiting list would peak with more referrals (a what-if run).`,
        `Besides those four, every scenario in the shared scenario library that they do not use gets questions by a general rule (policyAnalysisMethodsData/generate.js), all about its goal measure: what it would be had a constant been ${SCENARIO_FACTOR} times its value from the start (the most influential one after the which-matters question's answer that moves it enough) (only if that moves it by at least ${100 * MIN_SCENARIO_CHANGE}% and leaves it at least ${100 * MIN_TRUTH_SHARE}% of its base value, so the answer can be graded within a relative tolerance; the truth simulated); which of two constants, each possibly 20% off, matters more (the most influential one and one with at most 1/${SENSITIVITY_MARGIN} of its swing); and a calibration to the scenario's generated calibration history.`,
        `The hard group (policyAnalysisMethodsHard) asks, for every scenario whose working policy sets one lever to its realistic limit and whose goal is crossed once, ${100 * HARD_CROSSING[0]}–${100 * HARD_CROSSING[1]}% of the way there, with no method named, whether the goal can be met within the limit and two numbers from one search: the lever value that just meets the goal (within ${100 * HARD_LEVER_TOLERANCE}% of the move to the limit) and the goal measure at the limit (within ${100 * HARD_MEASURE_TOLERANCE}% of its simulated value, or of its value on the ${SAMPLE_POINTS}-point grid the run_scenario tool returns, which is all an agent can see), both simulated, all needed to pass. Its answers are balanced by rule: every scenario also gets, in the same words, the first other lever in its realistic bounds that, taken all the way to its limit, closes at least ${100 * REACH_MOVE}% of the gap to the goal yet never meets it — where the right answer is that the goal cannot be met that way, with the measure at the limit (within ${100 * HARD_MEASURE_TOLERANCE}%), and one run at the limit counts as the method — so answering every question with a value, or every one with "it cannot be done", fails part of the group.`,
        `The second hard group (policyAnalysisMethodsHard2, held-out scenarios only) asks for a second answer that depends on the first, with no method and no direction named: how far a lever must go to just meet the goal, and then how far to be sure of meeting it however a quantity management does not control, said to be up to ${100 * ROBUST_SHARE}% off either way, turns out. The rule (policyAnalysisMethodsData/generate.js, generateRobustCase) takes the first lever in a scenario's realistic bounds whose goal is crossed once, ${100 * HARD_CROSSING[0]}–${100 * HARD_CROSSING[1]}% of the way to its limit, and the most influential of its protected constants for which the goal is still crossed once (or met with no move at all) with that quantity anywhere in the ±${100 * ROBUST_SHARE}% range, the furthest crossing lies at one end of the range, at most ${100 * ROBUST_MAX_SHARE}% of the way to the limit, and more than twice the tolerance beyond both the first answer and the crossing at the range's other end — so repeating the first answer, or taking the uncertainty the wrong way, fails. Both settings are simulated by bisection and read as numbers, each within ${100 * HARD_LEVER_TOLERANCE}% of the move to the limit, all needed to pass in one test.`,
        `The method test reads the agent's tool log: an optimization over the lever or what-if runs at ${SEARCH_POINTS} or more of its values; a sensitivity run over both parameters, or what-if runs moving each by 10% or more; a calibration call; a what-if run with the change asked about, made on the referral constant or the referral flow.`,
        `The result test checks the answer against the hidden model: the target wait the agent sets must give a total cost within ${100 * COST_TOLERANCE}% of the lowest a brute-force search finds; the parameter it says matters more must be the one the sweep says (read by a fixed judge model from closed options); the calibrated model must fit the history with R² of at least ${FIT_R_SQUARED}, changing only parameter values; the peak it predicts (read by the judge as a number) must be within ${100 * PEAK_TOLERANCE}% of the simulated one.`
    ],
    criteria: [
        { name: 'Wrong method', description: 'The tool log shows no analysis of the kind the question calls for; for a sensitivity question this also fails the answer, since a choice between two parameters is a coin toss without the analysis.' },
        { name: 'Wrong answer', description: 'The answer is wrong against the hidden model: a costlier lever value, the wrong parameter, a poor fit, a peak more than 10% off, or (hard group) the wrong verdict on whether the goal is within reach.' },
        { name: 'Uncertainty not allowed for', description: `Second hard group: the lever setting the answer gives for meeting the goal however the uncertain quantity turns out (within ${100 * ROBUST_SHARE}% either way) is not within ${100 * HARD_LEVER_TOLERANCE}% of the move to the limit of the simulated one, or is not given.` },
        { name: 'No answer given', description: 'The engine gave no answer.' },
        { name: 'Evaluation error', description: 'The judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `Two tests per question, graded from one session.`
});
