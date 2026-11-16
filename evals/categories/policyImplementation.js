/**
 * This is the policy implementation test
 *
 * A model earns its keep when it is used to design a policy: the agent should be able to suggest a
 * change the organization could actually make, put it into the model, and show that it works. This
 * category hands the agent a working model of a hidden scenario (in the scenario's glossary names)
 * and a goal the current behavior misses, and asks for a policy that meets it, implemented in the
 * model.
 *
 * Grading is by simulating the model the agent returns:
 *   - the policy meets the goal: the goal measure, computed on the agent's model, is on the right
 *     side of the threshold
 *   - the problem is left intact: the quantities outside management's control (demand, the market,
 *     the referral rate) are unchanged, and no original variable was removed — a policy cannot meet
 *     the goal by deleting the problem
 *   - the model still behaves sensibly: no stock goes negative, every value is finite
 *
 * @module categories/policyImplementation
 */

import { validateEvaluationResult } from '../evaluationSchema.js';
import { bareModel, simulateModel } from '../utilities/simulateModel.js';
import { diffModels, findVariable, foldName, isNumericEquation, referencedNames } from '../utilities/modelDiff.js';
import { behaviorMismatch } from '../utilities/behaviorCompare.js';
import { impossibleUnder } from '../utilities/extremeRun.js';
import { glossaryModel } from '../utilities/scenarios/renameModel.js';
import { scenarios } from '../utilities/scenarios/library.js';
import { withFloors } from '../floors/statement.js';
import { splitHeldOut, isHeldOutScenario } from '../utilities/heldOut.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const description = () => {
    return `The policy implementation test evaluates whether an agent can design a policy with a model: given a working model and a goal its behavior misses, it must suggest a policy the organization could adopt, implement it in the model, and have the model meet the goal — without changing the things outside management's control, removing any of the model, or producing impossible behavior.`;
};

const ids = Object.keys(scenarios).filter((id) => scenarios[id].goal && scenarios[id].protected);

/** The goal variable's name in the glossary model. */
const goalVariable = (s) => Object.entries(s.glossaryToModel).find(([, m]) => m === s.goal.variable)?.[0] ?? s.goal.variable;

/**
 * The goal measure on a model.
 * @returns {Promise<{ok: boolean, value?: number, meets?: boolean, error?: string}>}
 */
export const goalOn = async function(model, s) {
    return goalMeasure(model, s, s.goal);
};

/**
 * The measure of a given goal (the scenario's own, or the hard group's tighter one) on a model.
 * @returns {Promise<{ok: boolean, value?: number, meets?: boolean, error?: string}>}
 */
export const goalMeasure = async function(model, s, goal) {
    const name = findVariable(model.variables, goalVariable(s))?.name;
    if (!name) return { ok: false, error: `The model has no "${goalVariable(s)}".` };
    const run = await simulateModel({ ...model, relationships: model.relationships || [], specs: s.model.specs }, [name], null);
    if (!run.ok) return { ok: false, error: run.error };
    const series = run.series[name];
    const { measure, time, threshold, direction } = goal;
    const value = measure === 'max' ? Math.max(...series) : measure === 'overshoot' ? Math.max(...series) - series[series.length - 1] : series[run.time.findIndex((t) => t >= time - 1e-9)];
    return { ok: true, value, meets: direction === 'below' ? value < threshold : value > threshold };
};

/**
 * Whether a changed equation layers a new policy on top of the original rather than rewriting it.
 * A behavioral constant (a bare number such as the share of patients who give up) and an
 * accounting identity (an equation of stocks alone, such as a total population) may not be
 * changed this way at all; any other equation must keep the original intact as a sub-expression
 * bring in a new policy variable and, with that variable switched off (set to 1 or 0), run exactly
 * like the original — `capacity * shift_multiplier`, not a new formula that merely mentions one.
 * @param {Object} original The glossary model
 * @param {string} variableName The changed variable's name
 * @param {string} before The original equation
 * @param {string} after The agent's equation
 * @param {Set<string>} added Folded names of the variables the agent added
 * @returns {Promise<boolean>}
 */
export const layersPolicy = async function(original, variableName, before, after, added) {
    const refs = [...referencedNames(before)];
    if (isNumericEquation(before) || !refs.some((n) => findVariable(original.variables, n))) return false;
    const stockNames = new Set(original.variables.filter((v) => v.type === 'stock').map((v) => foldName(v.name)));
    const known = refs.filter((n) => findVariable(original.variables, n));
    if (known.length && known.every((n) => stockNames.has(foldName(findVariable(original.variables, n).name)))) return false;
    if (![...referencedNames(after)].some((n) => added.has(n))) return false;
    // Switched off — every new policy variable set to a neutral 1 or 0 — the new equation must
    // run exactly like the original one. The neutral values that do so are returned, so the size of
    // the policy is measured against them and nothing else.
    const neutrals = [];
    for (const neutral of ['1', '0']) {
        const switchedOff = String(after).replace(/[A-Za-z_][A-Za-z0-9_.]*/g, (token) => added.has(foldName(token)) ? `(${neutral})` : token);
        const model = structuredClone(original);
        findVariable(model.variables, variableName).equation = switchedOff;
        try {
            if (!(await behaviorMismatch(model, original, NEUTRAL_TOLERANCE))) neutrals.push(neutral);
        } catch {
            // an equation that does not run switched off is not a layered policy
        }
    }
    return neutrals.length ? neutrals : false;
};

/** How far a flow may exceed its limit: a smoothed or lagged formulation can overrun it by a hair. */
export const LIMIT_TOLERANCE = 0.01;

/**
 * The first limit the model breaks, if any.
 * @returns {Promise<string|null>}
 */
export const brokenLimit = async function(model, s) {
    for (const limit of s.limits || []) {
        const names = [limit.flow, ...limit.uses].map((n) => findVariable(model.variables, n)?.name);
        if (names.some((n) => !n)) continue;
        const run = await simulateModel({ ...model, relationships: model.relationships || [], specs: s.model.specs }, names, null);
        if (!run.ok) continue;
        for (let i = 0; i < run.time.length; i++) {
            const values = Object.fromEntries(limit.uses.map((u, k) => [u, run.series[names[k + 1]][i]]));
            const flow = run.series[names[0]][i];
            const ceiling = limit.ceiling(values);
            if (flow > ceiling * (1 + LIMIT_TOLERANCE) + 1e-9) return `"${limit.flow}" reaches ${Number(flow.toPrecision(4))} at time ${run.time[i]}, above ${Number(ceiling.toPrecision(4))}: ${limit.label}.`;
        }
    }
    return null;
};

/**
 * How far a layered policy may move the variable it is layered onto: at most this factor either way
 * at every point of the run, against the same model with the policy switched off. It matches the
 * largest change the scenarios' realistic limits allow (riders persuading half as many again), so a
 * policy variable cannot carry a lever past its limit by the back door (word of mouth tripled, three
 * shifts a day).
 */
export const MAX_POLICY_FACTOR = 1.5;

/**
 * How far a layered variable moves: the largest ratio, either way, between its run in the agent's
 * model and in the same model with its new policy variables switched off — to each of the values
 * (1 or 0) that reproduce the original equation, taking the largest factor.
 * @returns {Promise<number>} The factor (1 when it does not move); Infinity if it cannot be compared
 */
export const layeredFactor = async function(model, s, variableName, added, neutrals) {
    const v = findVariable(model.variables, variableName);
    if (!v) return Infinity;
    // The switched-off equation is added to the agent's own model as a probe, so both are read from
    // the same run: the ratio is the policy's own effect, not the difference between two runs that
    // drift apart once the policy changes the system.
    // Against the switched-off values that reproduce the original equation only, and the largest
    // factor among them: a policy written as x * (1 + boost) is measured with boost at 0.
    let worst = 0;
    for (const neutral of neutrals) {
        const probed = structuredClone(model);
        const probe = '__switched_off_probe';
        probed.variables.push({ name: probe, type: 'variable', equation: String(v.equation).replace(/[A-Za-z_][A-Za-z0-9_.]*/g, (token) => added.has(foldName(token)) ? `(${neutral})` : token), units: v.units });
        const run = await simulateModel({ ...probed, relationships: probed.relationships || [], specs: s.model.specs }, [v.name, probe], null);
        if (!run.ok) continue;
        let factor = 1;
        for (let i = 0; i < run.series[probe].length; i++) {
            const [a, b] = [Math.abs(run.series[v.name][i]), Math.abs(run.series[probe][i])];
            if (a < 1e-9 && b < 1e-9) continue;
            factor = Math.max(factor, (Math.max(a, b) + 1e-12) / (Math.min(a, b) + 1e-12));
        }
        worst = Math.max(worst, factor);
    }
    return worst || Infinity;
};

/** How closely the switched-off equation must reproduce the original run. */
export const NEUTRAL_TOLERANCE = 1e-6;

const prompt = (s) => `Here is my model of the ${s.title.toLowerCase()}. Our goal is to ${s.goal.label}, and as things stand we miss it. Please suggest a policy we could actually adopt that would achieve the goal, explain why it should work, and implement it in the model so I can see its effect. Don't change things we don't control — ${s.protected.label}. ${s.realistic.text} Return the complete model with the policy in place.`;

const generateTests = function(id) {
    const s = scenarios[id];
    const base = { prompt: prompt(s), currentModel: glossaryModel(s), additionalParameters: { mode: 'sfd', problemStatement: `I want to ${s.goal.label}.` } };
    const shared = { scenario: id };
    return [
        { ...base, name: `${s.title}: the implemented policy meets the goal`, expectations: { ...shared, criterion: 'meetsGoal' } },
        { ...base, name: `${s.title}: the problem is left intact`, expectations: { ...shared, criterion: 'intact' } },
        { ...base, name: `${s.title}: the model still behaves sensibly`, expectations: { ...shared, criterion: 'sensible' } }
    ];
};

/**
 * The hard group's goals: for each scenario the rule in policyImplementationData/hardGoals.js
 * qualifies, a threshold that no change on the scenario's list meets — single or combined — but the
 * best realistic setting of its levers does (frozen in hardGoals.json, re-derived by simulation in
 * the unit tests).
 */
export const HARD_GOALS = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'policyImplementationData/hardGoals.json'), 'utf8'));

const fmtNumber = (x) => Number(x).toLocaleString('en-US');

/** A goal stated from its parts alone, for a threshold the scenario's own wording does not carry. */
export const hardGoalLabel = function(s, threshold) {
    const name = goalVariable(s);
    const units = s.model.variables.find((v) => v.name === s.goal.variable)?.units;
    const amount = `${fmtNumber(threshold)}${units ? ` (${units})` : ''}`;
    const { measure, time, direction } = s.goal;
    if (measure === 'max') return `keep ${name} ${direction} ${amount} for the whole run`;
    if (measure === 'overshoot') return `keep ${name} from overshooting by more than ${amount} above the level it settles at`;
    return `have ${name} ${direction} ${amount} at ${String(s.model.specs.timeUnits).replace(/s$/, '')} ${time}`;
};

/**
 * The hard prompt does not say the goal is missed, nor ask for a policy: whether anything is worth
 * changing is the agent's question to answer.
 */
const hardPrompt = (s, threshold) => `Here is my model of the ${s.title.toLowerCase()}. We want to ${hardGoalLabel(s, threshold)}. Is it worth changing anything here, and if so what? Don't change things we don't control — ${s.protected.label}. ${s.realistic.text} Return the complete model as you would have us run it.`;

const generateHardTests = function(id) {
    const s = scenarios[id];
    const threshold = HARD_GOALS[id].tighterThreshold;
    return [{
        prompt: hardPrompt(s, threshold),
        currentModel: glossaryModel(s),
        additionalParameters: { mode: 'sfd', problemStatement: `I want to ${hardGoalLabel(s, threshold)}.` },
        name: `${s.title}: (hard) the model meets the tighter goal, with the problem intact and sensible behavior`,
        expectations: { scenario: id, criterion: 'hard', threshold }
    }];
};

/**
 * The second hard group's goals (policyImplementationData/hardGoals.js, hard2Goal; frozen in
 * hard2Goals.json and re-derived by simulation in the unit tests): for held-out scenarios only, the
 * goal set a clear margin short of the best realistic setting rather than midway to it.
 */
export const HARD2_GOALS = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'policyImplementationData/hard2Goals.json'), 'utf8'));

const generateHard2Tests = function(id) {
    const s = scenarios[id];
    const threshold = HARD2_GOALS[id].threshold;
    return [{
        prompt: hardPrompt(s, threshold),
        currentModel: glossaryModel(s),
        additionalParameters: { mode: 'sfd', problemStatement: `I want to ${hardGoalLabel(s, threshold)}.` },
        name: `${s.title}: (hard 2) the model meets the goal set near the best realistic setting, with the problem intact and sensible behavior`,
        expectations: { scenario: id, criterion: 'hard', threshold }
    }];
};

const rawGroups = {
    policyImplementation: ids.flatMap(generateTests),
    policyImplementationHard: ids.filter((id) => HARD_GOALS[id]).flatMap(generateHardTests),
    policyImplementationHard2: ids.filter((id) => HARD2_GOALS[id] && isHeldOutScenario(id)).flatMap(generateHard2Tests)
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => isHeldOutScenario(t.expectations.scenario));
/**
 * Evaluates one criterion.
 * @param {Object} generatedResponse The agent's response, carrying its model
 * @param {Object} expectations The criterion
 * @returns {Promise<Array<Object>>} Failures
 */
export const evaluate = async function(generatedResponse, expectations) {
    const s = scenarios[expectations.scenario];
    const model = bareModel(generatedResponse);
    if (!model || (model.variables || []).length === 0) {
        return validateEvaluationResult([{ type: 'No model produced', details: `The agent did not return a model.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    }
    const failures = [];
    // The model being intact and sensible only counts for a policy that works: an unchanged model is
    // intact and sensible, and earns nothing.
    if (expectations.criterion !== 'meetsGoal' && expectations.criterion !== 'hard') {
        const outcome = await goalOn(model, s);
        if (!outcome.ok || !outcome.meets) failures.push({ type: 'Goal not met', details: `This test counts only for a policy that meets the goal; with the returned model the goal is not met${outcome.ok ? ` (the measure is ${Number(outcome.value.toPrecision(4))})` : `: ${outcome.error}`}.` });
    }
    switch (expectations.criterion) {
        case 'meetsGoal': {
            const outcome = await goalOn(model, s);
            if (!outcome.ok) failures.push({ type: 'Goal not met', details: outcome.error });
            else if (!outcome.meets) failures.push({ type: 'Goal not met', details: `With the policy in place the measure is ${Number(outcome.value.toPrecision(4))}; the goal (${s.goal.label}) needs it ${s.goal.direction} ${s.goal.threshold}.` });
            break;
        }
        case 'intact': {
            const original = glossaryModel(s);
            const diff = diffModels(original, model);
            for (const removed of diff.removed) failures.push({ type: 'Problem changed', details: `"${removed.name}" was removed from the model.` });
            // An allow-list: a policy may change the levers management controls, add new variables,
            // and rewire an existing equation to use a new policy variable. Anything else — how
            // patients behave, the size of the market, where the target is set when the target is
            // not a lever — changes the problem rather than solving it.
            const levers = new Set(s.levers.map(foldName));
            const added = new Set(diff.added.map((v) => foldName(v.name)));
            const protectedNames = new Set(s.protected.variables.map(foldName));
            // A stock's starting value rewritten as a formula that gives the same start (600 written
            // as base demand times delivery delay) changes nothing about the problem.
            const startOf = async (m, n) => {
                const run = await simulateModel({ ...m, relationships: m.relationships || [], specs: s.model.specs }, [n], null);
                return run.ok ? run.series[n][0] : NaN;
            };
            for (const change of diff.changed.filter((c) => c.field !== 'units')) {
                const name = foldName(change.name);
                if (change.field === 'equation' && change.variable?.type === 'stock') {
                    // The agent's starting formula, evaluated with the original parameters: a start
                    // written as a balanced formula only moves because a lever moved.
                    const name0 = findVariable(original.variables, change.name).name;
                    const before = await startOf(original, name0);
                    const probe = structuredClone(original);
                    findVariable(probe.variables, name0).equation = change.after;
                    const theirs = await startOf(probe, name0);
                    if (Number.isFinite(before) && Math.abs(theirs - before) <= 1e-6 * Math.max(1, Math.abs(before))) continue;
                }
                if (protectedNames.has(name)) {
                    failures.push({ type: 'Problem changed', details: `"${change.name}" is outside management's control, but its ${change.field} changed from ${JSON.stringify(change.before)} to ${JSON.stringify(change.after)}.` });
                    continue;
                }
                if (levers.has(name)) continue;
                // Any other variable may have a new policy layered onto it — what is outside
                // management's control is listed in the scenario's protected quantities, which are
                // never touched.
                const usesNewPolicy = change.field === 'equation' && await layersPolicy(original, change.name, change.before, change.after, added);
                if (usesNewPolicy) {
                    const factor = await layeredFactor(model, s, change.name, added, usesNewPolicy);
                    if (factor > MAX_POLICY_FACTOR * (1 + 1e-6)) failures.push({ type: 'Unrealistic lever', details: `The policy layered onto "${change.name}" moves it by a factor of ${Number(factor.toPrecision(3))} at its largest; a realistic policy moves it by at most ${MAX_POLICY_FACTOR}.` });
                    continue;
                }
                const addsFlow = (change.field === 'inflows' || change.field === 'outflows') && (change.after || []).some((f) => added.has(foldName(f)));
                if (!usesNewPolicy && !addsFlow) {
                    failures.push({ type: 'Problem changed', details: `"${change.name}" is not something management sets, but its ${change.field} changed from ${JSON.stringify(change.before)} to ${JSON.stringify(change.after)} without layering a new policy variable onto it.` });
                }
            }
            const broken = await brokenLimit(model, s);
            if (broken) failures.push({ type: 'Problem changed', details: broken });
            // A lever pushed past what the organization could do meets the goal on paper only.
            for (const [name, { min, max }] of Object.entries(s.realistic.bounds)) {
                const v = findVariable(model.variables, name);
                const value = v ? Number(v.equation) : NaN;
                if (!Number.isFinite(value)) continue;
                if ((min !== undefined && value < min - 1e-9) || (max !== undefined && value > max + 1e-9)) {
                    failures.push({ type: 'Unrealistic lever', details: `"${v.name}" is set to ${value}; what the organization could do puts it ${min !== undefined && max !== undefined ? `between ${min} and ${max}` : min !== undefined ? `at ${min} or more` : `at ${max} or less`}.` });
                }
            }
            break;
        }
        case 'sensible': {
            const impossible = await impossibleUnder({ ...model, relationships: model.relationships || [], specs: s.model.specs }, null);
            if (impossible) failures.push({ type: 'Impossible behavior', details: `With the policy in place, ${impossible}.` });
            break;
        }
        case 'hard': {
            // All three together, against the tighter goal: met, the problem intact, the behavior
            // sensible. Intact and sensible are graded exactly as in their own tests.
            const outcome = await goalMeasure(model, s, { ...s.goal, threshold: expectations.threshold });
            if (!outcome.ok) failures.push({ type: 'Goal not met', details: outcome.error });
            else if (!outcome.meets) failures.push({ type: 'Goal not met', details: `With the policy in place the measure is ${Number(outcome.value.toPrecision(4))}; the goal (${hardGoalLabel(s, expectations.threshold)}) needs it ${s.goal.direction} ${expectations.threshold}.` });
            for (const criterion of ['intact', 'sensible']) {
                const more = await evaluate(generatedResponse, { scenario: expectations.scenario, criterion });
                failures.push(...more.filter((f) => f.type !== 'Goal not met'));
            }
            break;
        }
        default:
            throw new Error(`Unknown criterion ${expectations.criterion}`);
    }
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('policyImplementation', {
    howItWorks: [
        `Each test hands the agent a working model of a hidden scenario — a dialysis waiting list, a bike-share scheme, a distributor's inventory — in plain names, with a goal its current behavior misses (keep the waiting list under 80; reach 30,000 members by month 18; keep inventory from overshooting more than 15 cases), and asks for a policy the organization could adopt, implemented in the model.`,
        `The returned model is simulated on the scenario's own run settings. The policy meets the goal when the goal measure is on the right side of the threshold (an overshoot is measured from where the run settles, so moving the target does not count). The problem must be left intact: the quantities outside management's control — named in the prompt — must be unchanged, no original variable removed, levers must stay within what the organization could do (stated in the prompt: no more than 30 chairs, no faster than a three-month build), and every other original variable may change only if it is one of the scenario's management levers, or it is one of the decisions management runs (how treatments are delivered, how chairs or stock are ordered) and its new equation brings in a new policy variable the agent added and, with that variable switched off (set to 1 or 0), runs exactly like the original — and a layered flow must stay within the scenario's physical limits (no patient starts treatment sooner than the minimum wait). What patients, riders and customers do is never a place to layer a policy, nor are behavioral constants (a number, such as the share of patients who give up) and accounting identities (a total made of stocks alone), so a do-nothing policy variable cannot be used to rewrite them. The model must not produce a negative stock or a non-finite value.`,
        `Hard group (policyImplementationHard): for every scenario that lists a combined policy beating each of its single policies by at least 2% of the threshold, the goal is tightened past every change on the list: to the midpoint between the best combination and the best realistic setting of the scenario's levers (each at its current value, a realistic limit or the combination's value, every mix simulated), so neither the combination nor any single change meets it, and the best realistic setting does — where that leaves the best realistic setting a margin of at least 2% of the threshold; otherwise the goal stays midway between the best single change and the best combination; the prompt neither says the goal is missed nor asks for a policy ("Is it worth changing anything here, and if so what?"), and one test needs the tighter goal met, the problem intact and the behavior sensible all at once.`,
        `Second hard group (policyImplementationHard2, held-out scenarios only; the tighter-tolerance lever): the same request and the same all-at-once grading, but the goal is set only 2% of the scenario's own threshold short of the best realistic setting (rounded outward to three significant figures), rather than midway between it and the best combination — for every held-out scenario whose first hard goal is the tighter one, where the new goal is tighter still and some realistic setting meets the first hard goal but misses the new one; so the agent must take the levers nearly as far as the organization realistically could, and going as far as the first hard group asks fails.`
    ],
    criteria: [
        { name: 'Goal not met', description: 'With the policy in place, the model still misses the goal, or the goal variable is gone.' },
        { name: 'Problem changed', description: 'A quantity outside management\'s control was changed; an original variable was removed; or a variable management does not set was changed without using a new policy variable.' },
        { name: 'Unrealistic lever', description: 'A lever is set beyond what the organization could do (the limits stated in the prompt), such as 1000 chairs.' },
        { name: 'Impossible behavior', description: 'With the policy in place, a stock goes negative or a value becomes non-finite.' },
        { name: 'No model produced', description: 'The agent returned no model.' }
    ],
    scoring: `Three tests per scenario, graded from one model. The problem-intact and behaves-sensibly tests count only when the policy meets the goal, so an unchanged model scores nothing. The hard group has one test per qualifying scenario, all three conditions graded together against the tighter goal; the second hard group likewise, against its goal.`
});
