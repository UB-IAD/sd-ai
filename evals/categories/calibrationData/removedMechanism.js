/**
 * The general rule behind the calibration category's second hard group (calibrationHard2): a
 * structure case built from a held-out scenario's own feedback, not from a generic exogenous
 * pattern. One of the scenario's mechanisms is removed from the model the agent is given; the data
 * come from the full hidden model. The missing piece is a causal mechanism of the situation (worn-out
 * volunteers quitting, crews hired to match the work), which no parameter values can stand in for.
 *
 * For each held-out scenario, its mechanisms that matter are tried in order. A mechanism is taken
 * when:
 *   - its off switch is structural: every variable it overrides has a formula, and each override is
 *     a formula too, or a flow set to zero that no formula uses (the flow is then removed). A switch
 *     that sets a constant, or leaves a constant in place of a formula, is skipped: calibration could
 *     tune it back.
 *   - with it removed, everything the goal variable depended on only through it is removed too (no
 *     dangling stock or constant gives the answer away)
 *   - the full model fits its own data (wobble included) above TRUTH_FIT; the given model, as it is,
 *     fits below MISFIT; and calibrating its CALIBRATED most influential parameters still fits below
 *     MISFIT
 *   - two of the three generic mechanisms of generate.js (growth, seasonal, leak), added to the
 *     given model and calibrated with their own strength, still fit below MISFIT; the first two that
 *     do are the distractors
 * The data are the full model's run of the goal variable, sampled with the fixed ±2% wobble.
 *
 * @module categories/calibrationData/removedMechanism
 */

import { glossaryModel } from '../../utilities/scenarios/renameModel.js';
import { applyOverrides } from '../../utilities/simulateModel.js';
import { isNumericEquation } from '../../utilities/modelDiff.js';
import { baseModel, seriesFor, sampledData, plainFit, calibratedFit, rankedParameters, mechanismsFor, applyChanges, CALIBRATED, MISFIT, TRUTH_FIT } from './generate.js';

const under = (n) => n.replace(/\s+/g, '_').toLowerCase();

/** Each variable's direct dependencies: the names in its equation, and a stock's flows. */
const dependencies = function(model) {
    const byName = new Map(model.variables.map((v) => [under(v.name), v.name]));
    return Object.fromEntries(model.variables.map((v) => {
        const refs = new Set();
        for (const token of String(v.equation ?? '').match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) if (byName.has(token.toLowerCase())) refs.add(byName.get(token.toLowerCase()));
        for (const f of [...(v.inflows || []), ...(v.outflows || [])]) refs.add(f);
        return [v.name, refs];
    }));
};

/** Every variable a root depends on, itself included. */
const upstream = function(model, root) {
    const deps = dependencies(model);
    const seen = new Set([root]);
    const stack = [root];
    while (stack.length) for (const x of deps[stack.pop()] || []) if (!seen.has(x)) { seen.add(x); stack.push(x); }
    return seen;
};

const usedInFormula = (model, name) => model.variables.some((v) => v.name !== name && (String(v.equation ?? '').match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).some((t) => t.toLowerCase() === under(name)));

/**
 * The hidden model with a mechanism removed, or a reason it cannot be removed structurally.
 * @param {Object} s A scenario
 * @param {Object} mechanism One of its mechanisms
 * @returns {{model: Object, dropped: Array<string>}|{skip: string}}
 */
export const withoutMechanism = function(s, mechanism) {
    const vars = (name) => s.model.variables.find((v) => v.name === name);
    for (const [name, eq] of Object.entries(mechanism.off)) {
        const v = vars(name);
        if (!v || isNumericEquation(v.equation)) return { skip: 'its off switch sets a constant' };
        if (isNumericEquation(eq) && !(v.type === 'flow' && Number(eq) === 0 && !usedInFormula(s.model, name))) return { skip: 'its off switch leaves a constant in place of a formula' };
    }
    let model = applyOverrides(s.model, mechanism.off);
    const zeroed = Object.entries(mechanism.off).filter(([, eq]) => isNumericEquation(eq)).map(([n]) => n);
    const strip = (m, gone) => ({
        ...m,
        variables: m.variables.filter((v) => !gone.includes(v.name)).map((v) => ({ ...v, ...(v.inflows ? { inflows: v.inflows.filter((f) => !gone.includes(f)) } : {}), ...(v.outflows ? { outflows: v.outflows.filter((f) => !gone.includes(f)) } : {}) }))
    });
    model = strip(model, zeroed);
    const before = upstream(s.model, s.goal.variable);
    const after = upstream(model, s.goal.variable);
    const dropped = [...before].filter((n) => !after.has(n) && !zeroed.includes(n));
    model = strip(model, dropped);
    return { model, dropped: [...zeroed, ...dropped] };
};

/** The model the agent is given for a removed mechanism: in glossary names, over the scenario's run settings. */
export const removedGivenModel = (s, mechanismId) => ({ ...glossaryModel({ ...s, model: withoutMechanism(s, s.mechanisms.find((m) => m.id === mechanismId)).model }), specs: s.model.specs });

/**
 * The second hard group's structure case for one scenario, or the reason it has none.
 * @param {Object} s A held-out scenario
 * @returns {Promise<Object>} `{name, scenario, kind: 'structure', series, removed, mechanism, distractors, distractorModels, calibrated, dropped, data}` or `{skip}`
 */
export const removedMechanismCase = async function(s) {
    const truth = baseModel(s);
    const series = seriesFor(s);
    const data = await sampledData(truth, series);
    if (!data || (await plainFit(truth, series, data)) <= TRUTH_FIT) return { skip: 'the full model does not fit its own data' };
    const reasons = [];
    for (const mechanism of s.mechanisms.filter((m) => m.verdict === 'matters')) {
        const removed = withoutMechanism(s, mechanism);
        if (removed.skip) { reasons.push(`${mechanism.id}: ${removed.skip}`); continue; }
        const given = removedGivenModel(s, mechanism.id);
        if ((await plainFit(given, series, data)) >= MISFIT) { reasons.push(`${mechanism.id}: the model without it still fits`); continue; }
        const ranked = await rankedParameters(given, series);
        const calibrated = ranked.slice(0, CALIBRATED);
        if ((await calibratedFit(given, series, data, calibrated)) >= MISFIT) { reasons.push(`${mechanism.id}: calibrating the model without it makes it fit`); continue; }
        const distractorModels = [];
        for (const d of Object.values(mechanismsFor(given, series, ranked))) {
            if (distractorModels.length === 2) break;
            const dm = applyChanges(given, d.changes);
            if ((await calibratedFit(dm, series, data, [...calibrated, d.strength], [d.strength])) < MISFIT) distractorModels.push({ mechanism: d.mechanism, strength: d.strength, changes: d.changes });
        }
        if (distractorModels.length < 2) { reasons.push(`${mechanism.id}: fewer than two generic mechanisms the data rule out`); continue; }
        return {
            name: `${s.title}, without "${mechanism.id}"`, scenario: s.id, kind: 'structure', series, removed: mechanism.id,
            mechanism: mechanism.fact, distractors: distractorModels.map((d) => d.mechanism), distractorModels, calibrated, dropped: removed.dropped, data
        };
    }
    return { skip: reasons.join('; ') || 'no mechanism that matters' };
};
