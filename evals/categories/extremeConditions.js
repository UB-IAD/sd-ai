/**
 * This is the extreme conditions test
 *
 * A model has to behave sensibly when its inputs are pushed to extremes — no demand, ten times the
 * demand, an empty population — or it cannot be trusted for policy analysis. This category gives
 * the agent a model with one formulation that behaves impossibly under such conditions (a stock goes
 * negative, a division by zero breaks the run), and a run_scenario tool for what-if runs, and asks
 * it to test the model under extreme conditions and fix what it finds without changing the model's
 * normal behavior.
 *
 * Grading is deterministic:
 *   - the agent found the problem by testing: some run_scenario call in its tool log, replayed on
 *     the planted model, exposes the failure (whatever extreme it chose)
 *   - the agent fixed it: its version of the planted variable, with any helpers it added, survives
 *     the case's extreme run in the robust model, and normal behavior stays within tolerance
 *   - the revised model as a whole survives the extreme run
 *
 * The extremeConditionsHard group (see extremeConditionsData/hard.js) plants several impossible
 * formulations at once in a scenario's full model, each graded on its own, asks only whether the
 * model is ready ("fix anything that needs it") without mentioning extreme conditions, withholds the
 * tool suggestion (the run_scenario tool is available but the request never mentions it or what-if
 * runs), and adds a clean control: the same request on the robust model.
 *
 * @module categories/extremeConditions
 */

import { validateEvaluationResult } from '../evaluationSchema.js';
import { bareModel } from '../utilities/simulateModel.js';
import { hybridModel, behaviorMismatch } from '../utilities/behaviorCompare.js';
import { impossibleUnder } from '../utilities/extremeRun.js';
import { callsTo } from '../utilities/toolLog.js';
import { findVariable } from '../utilities/modelDiff.js';
import { cases, plantedModel, hardCases } from './extremeConditionsData/cases.js';
import { plantAll, HARD_PLANTS } from './extremeConditionsData/hard.js';
import { readyPrompt, pickHard, cleanVerdictFailure, CLEAN_CRITERIA, responseText } from './guidedCorrectionData/hardShared.js';
import { withFloors } from '../floors/statement.js';
import { BASE_TOLERANCE, TRIGGER_FACTOR, GUARD_STEPS, SMALLEST } from './extremeConditionsData/generate.js';
import { splitHeldOut, caseHeldOut } from '../utilities/heldOut.js';

export const BEHAVIOR_TOLERANCE = 0.05;

export const description = () => {
    return `The extreme conditions test evaluates whether an agent tests a model under extreme inputs, finds the formulation that behaves impossibly there (a stock driven negative, a division by zero), and fixes it without changing the model's normal behavior. Finding is read from the agent's own what-if runs, replayed on the original model; fixing is checked by simulating the agent's version under an extreme run.`;
};

const prompt = (c) => `Before I trust my model of ${c.description} for policy analysis, please test it under extreme conditions — for example turning inputs off or making them very large — using the run_scenario tool. Find any formulation that behaves impossibly under such conditions, explain it, and fix it so the model stays sensible without changing its normal behavior. Keep the existing variable names and return the complete model.`;

const generateTests = function(name) {
    const c = cases[name];
    const base = {
        prompt: prompt(c),
        currentModel: plantedModel(c),
        additionalParameters: { mode: 'sfd', analysisTools: true, problemStatement: `I need my model of ${c.description} to be robust before I use it.` }
    };
    const shared = { caseName: name };
    return [
        { ...base, name: `${name}: finds the problem with an extreme-conditions run`, expectations: { ...shared, criterion: 'found' } },
        { ...base, name: `${name}: fixes the formulation without changing normal behavior`, expectations: { ...shared, criterion: 'fixed' } },
        { ...base, name: `${name}: the revised model survives the extreme run`, expectations: { ...shared, criterion: 'robust' } }
    ];
};

/** The hard cases the hard group takes (see guidedCorrectionData/hardShared.js). */
export const HARD = pickHard(hardCases, null);

// Withheld feedback: the run_scenario tool is on, but the hard request never suggests it.
const hardBase = (c, model) => ({
    prompt: readyPrompt(c.description),
    currentModel: model,
    additionalParameters: { mode: 'sfd', analysisTools: true, problemStatement: `I need my model of ${c.description} to be right before I use it.` }
});

const generateHard = function(name) {
    const c = hardCases[name];
    const base = hardBase(c, plantAll(c.clean, c.plants));
    const shared = { caseName: name, hard: true };
    return [
        ...c.plants.flatMap((p) => [
            { ...base, name: `${name}: finds "${p.id}" with a what-if run, unprompted`, expectations: { ...shared, criterion: 'found', plantId: p.id } },
            { ...base, name: `${name}: fixes "${p.id}" without changing normal behavior`, expectations: { ...shared, criterion: 'fixed', plantId: p.id } }
        ]),
        { ...base, name: `${name}: the revised model survives every extreme run`, expectations: { ...shared, criterion: 'robust' } }
    ];
};

const generateClean = (name) => [{
    ...hardBase(hardCases[name], structuredClone(hardCases[name].clean)),
    name: `${name} (clean control): finds nothing to fix and leaves the robust model as it is`,
    expectations: { caseName: name, hard: true, criterion: 'clean' }
}];

const rawGroups = {
    extremeConditions: Object.keys(cases).flatMap(generateTests),
    extremeConditionsHard: [...HARD.faulty.flatMap(generateHard), ...HARD.clean.flatMap(generateClean)]
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => caseHeldOut((t.expectations.hard ? hardCases : cases)[t.expectations.caseName]));
/**
 * Evaluates one criterion.
 * @param {Object} generatedResponse The agent's response: model and tool log
 * @param {Object} expectations The criterion
 * @returns {Promise<Array<Object>>} Failures
 */
export const evaluate = async function(generatedResponse, expectations) {
    if (expectations.hard) return evaluateHard(generatedResponse, expectations);
    const c = cases[expectations.caseName];
    const generated = bareModel(generatedResponse);
    const failures = [];
    switch (expectations.criterion) {
        case 'found': {
            const runs = callsTo(generatedResponse?.toolLog, 'run_scenario');
            const planted = plantedModel(c);
            let exposed = false;
            for (const call of runs) {
                const overrides = Object.fromEntries(Object.entries(call.arguments?.overrides || {}).map(([k, v]) => [k, String(v)]));
                // A run exposes the planted problem only when it is the planted formulation that
                // breaks: every override names a real variable, the planted model goes impossible,
                // and the robust model, run the same way, does not. An extreme that breaks any model
                // (a negative demand, a zero illness duration) or a typo is not finding the bug.
                if (!Object.keys(overrides).length || Object.keys(overrides).some((k) => !findVariable(planted.variables, k))) continue;
                if (await impossibleUnder(planted, overrides) && !(await impossibleUnder(c.clean, overrides))) { exposed = true; break; }
            }
            if (!exposed) failures.push({ type: 'Problem not found by testing', details: runs.length ? `None of the agent's ${runs.length} what-if run(s), replayed on the original model, exposes the problem (${c.failure}).` : 'The agent made no what-if runs.' });
            break;
        }
        case 'fixed': {
            if (!generated) { failures.push({ type: 'No model produced', details: 'The agent returned no model.' }); break; }
            const hybrid = hybridModel(c.clean, generated, c.plant.variable, ['equation', 'graphicalFunction']);
            if (!hybrid) { failures.push({ type: 'Formulation not fixed', details: `The revised model no longer has "${c.plant.variable}".` }); break; }
            const impossible = await impossibleUnder(hybrid, c.trigger);
            if (impossible) failures.push({ type: 'Formulation not fixed', details: `With the revised "${c.plant.variable}", the extreme run still fails: ${impossible}.` });
            const mismatch = await behaviorMismatch(hybrid, c.clean, BEHAVIOR_TOLERANCE);
            if (mismatch) failures.push({ type: 'Normal behavior changed', details: `The revised "${c.plant.variable}" changes the model's normal behavior: ${mismatch}` });
            break;
        }
        case 'robust': {
            if (!generated) { failures.push({ type: 'No model produced', details: 'The agent returned no model.' }); break; }
            const runnable = { ...generated, relationships: generated.relationships || [], specs: c.clean.specs };
            let impossible;
            try {
                impossible = await impossibleUnder(runnable, c.trigger);
            } catch (error) {
                impossible = error.message;
            }
            if (impossible) failures.push({ type: 'Model not robust', details: `Under the extreme run, the revised model still behaves impossibly: ${impossible}.` });
            break;
        }
        default:
            throw new Error(`Unknown criterion ${expectations.criterion}`);
    }
    return validateEvaluationResult(failures);
};

/** Whether a run, replayed, exposes one plant: the model with only that plant goes impossible, the robust one does not. */
const exposes = async function(c, p, call) {
    const overrides = Object.fromEntries(Object.entries(call.arguments?.overrides || {}).map(([k, v]) => [k, String(v)]));
    if (!Object.keys(overrides).length || Object.keys(overrides).some((k) => !findVariable(c.clean.variables, k))) return false;
    return Boolean(await impossibleUnder(plantAll(c.clean, [p]), overrides)) && !(await impossibleUnder(c.clean, overrides));
};

/** Why a model behaves impossibly under one of the case's extremes, or null. */
const firstImpossible = async function(c, model) {
    const runnable = { ...model, relationships: model.relationships || [], specs: c.clean.specs };
    for (const p of c.plants) {
        let why;
        try {
            why = await impossibleUnder(runnable, p.trigger);
        } catch (error) {
            why = error.message;
        }
        if (why) return `with ${Object.entries(p.trigger).map(([k, v]) => `"${k}" at ${v}`).join(', ')}, ${why}`;
    }
    return null;
};

/** One criterion of a hard-group test. */
const evaluateHard = async function(generatedResponse, expectations) {
    const c = hardCases[expectations.caseName];
    const p = c.plants.find((x) => x.id === expectations.plantId);
    const generated = bareModel(generatedResponse);
    const failures = [];
    if (expectations.criterion === 'found') {
        const runs = callsTo(generatedResponse?.toolLog, 'run_scenario');
        let exposed = false;
        for (const call of runs) if (await exposes(c, p, call)) { exposed = true; break; }
        if (!exposed) failures.push({ type: 'Problem not found by testing', details: runs.length ? `None of the agent's ${runs.length} what-if run(s), replayed, exposes this problem (${p.failure}).` : 'The agent made no what-if runs.' });
        return validateEvaluationResult(failures);
    }
    if (!generated || !(generated.variables || []).length) return validateEvaluationResult([{ type: 'No model produced', details: 'The agent returned no model.' }]);
    if (expectations.criterion === 'fixed') {
        const hybrid = hybridModel(c.clean, generated, p.variable, ['equation', 'graphicalFunction']);
        if (!hybrid) return validateEvaluationResult([{ type: 'Formulation not fixed', details: `The revised model no longer has "${p.variable}".` }]);
        const impossible = await impossibleUnder(hybrid, p.trigger);
        if (impossible) failures.push({ type: 'Formulation not fixed', details: `With the revised "${p.variable}", the extreme run still fails: ${impossible}.` });
        const mismatch = await behaviorMismatch(hybrid, c.clean, BEHAVIOR_TOLERANCE);
        if (mismatch) failures.push({ type: 'Normal behavior changed', details: `The revised "${p.variable}" changes the model's normal behavior: ${mismatch}` });
    } else if (expectations.criterion === 'robust') {
        const impossible = await firstImpossible(c, generated);
        if (impossible) failures.push({ type: 'Model not robust', details: `Under an extreme run, the revised model still behaves impossibly: ${impossible}.` });
    } else if (expectations.criterion === 'clean') {
        // The robust model needs nothing: it must come back still surviving every extreme, behaving
        // as it did, and the response must say it needed no fixing.
        const impossible = await firstImpossible(c, generated);
        if (impossible) failures.push({ type: 'Correct model changed', details: `The model was robust, but the returned one is not: ${impossible}.` });
        const mismatch = await behaviorMismatch(generated, c.clean, BEHAVIOR_TOLERANCE);
        if (mismatch) failures.push({ type: 'Correct model changed', details: `The model needed no fixing, but the returned model behaves differently: ${mismatch}` });
        const text = responseText(generatedResponse);
        const said = await cleanVerdictFailure(`extremeConditions|clean|${expectations.caseName}|${text}`, c.description, text);
        if (said) failures.push(said);
    } else {
        throw new Error(`Unknown criterion ${expectations.criterion}`);
    }
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('extremeConditions', {
    howItWorks: [
        `Each case is a robust model with one formulation replaced by a version that behaves impossibly under an extreme input: a flow that keeps draining a stock that has run dry, a division by a quantity that can reach zero. In normal runs the two agree within ${100 * BEHAVIOR_TOLERANCE}%; under the case's extreme run (no new projects, ten times the demand, an empty population) the planted one goes negative or breaks and the robust one does not. The unit tests check all of this by simulation.`,
        `Besides the hand-written cases, every scenario in the shared scenario library gets a case by a general rule (extremeConditionsData/generate.js) where it has a site for one. The robust model is the scenario's model, and the plant removes one of its MIN or MAX guards; or the robust model gets a guard added and the plant is the original formulation — an outflow that ignores the stock it drains limited to that stock over ${GUARD_STEPS} time steps, or a division by a quantity that can reach zero kept at or above ${SMALLEST}. A plant is kept only if it normally behaves like the robust model (every stock within ${100 * BASE_TOLERANCE}%) and some extreme — a constant set to zero or to ${TRIGGER_FACTOR} times its value, or a stock started at zero, tried in that order — makes the planted model impossible and leaves the robust one possible; the first such extreme is the case's.`,
        `The agent is given the planted model, a run_scenario tool for what-if runs, and a request to test the model under extreme conditions and fix what it finds without changing normal behavior.`,
        `The extremeConditionsHard group is built by difficulty levers applied by rule (extremeConditionsData/hard.js), never by picking cases an agent failed: up to ${HARD_PLANTS} impossible formulations at once in a scenario's full model — one of each kind it has a site for first; most scenario models have a site for only one — each with its own extreme and graded on its own (found by a what-if run that exposes it, fixed in place), a request that does not mention extreme conditions ("is it ready for policy analysis? fix anything that needs it"), withheld feedback — the run_scenario tool is available but the request never suggests it or what-if runs, so the agent must decide on its own to test — and a clean control — the same request on the robust model, which passes only when the model comes back surviving every extreme, behaving as it did, and the response says it needed no fixing.`,
        `Finding is checked from the agent's tool log: some run_scenario call, replayed on the planted model, must expose the failure — any extreme that does counts, as long as it is the planted formulation that breaks: every override names a real variable, and the same run on the robust model stays sensible. Fixing is checked by putting the agent's version of the planted variable, with its helpers, into the robust model: it must survive the case's extreme run and keep normal behavior within tolerance. The revised model as a whole must also survive the extreme run.`
    ],
    criteria: [
        { name: 'Problem not found by testing', description: 'None of the agent\'s what-if runs, replayed on the original model, exposes the impossible behavior.' },
        { name: 'Formulation not fixed', description: 'With the agent\'s version of the planted formulation, the extreme run still goes impossible.' },
        { name: 'Normal behavior changed', description: `The fix moves the model's normal behavior more than ${100 * BEHAVIOR_TOLERANCE}%.` },
        { name: 'Model not robust', description: 'The revised model as a whole still behaves impossibly under the extreme run.' },
        ...CLEAN_CRITERIA,
        { name: 'No model produced', description: 'The agent returned no model.' },
        { name: 'Evaluation error', description: 'In a clean control, the judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `Three tests per case, graded from one session.`
});
