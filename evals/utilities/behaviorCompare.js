/**
 * Compare an engine's model with a correct one by simulation.
 *
 * Categories that plant errors in a known-correct model need to know, for one error at a time,
 * whether the engine fixed it — whatever else it changed. hybridModel puts the engine's version of
 * only the part of a variable an error lives in back into the correct model; behaviorMismatch
 * simulates a model and the correct one and reports the first stock that differs.
 *
 * @module utilities/behaviorCompare
 */

import { findVariable } from './modelDiff.js';
import { simulateModel, allFinite } from './simulateModel.js';

/**
 * Put the engine's version of the fields of one variable that an error lives in into the correct
 * model, along with every variable the engine added that the correct model lacks (helpers the fix
 * may depend on).
 */
export const hybridModel = function(correct, generated, variableName, fields) {
    const hybrid = structuredClone(correct);
    const mine = findVariable(generated.variables || [], variableName);
    if (!mine) return null;
    const target = findVariable(hybrid.variables, variableName);
    // Only the fields the error lives in: an engine that reconnects a stock's flows and also
    // changes its initial value has fixed the connection; the other change is the behavior test's
    // business, not this error's.
    for (const field of fields) {
        if (mine[field] === undefined) delete target[field];
        else target[field] = structuredClone(mine[field]);
    }
    for (const extra of generated.variables || []) {
        if (!findVariable(hybrid.variables, extra.name)) {
            const copy = structuredClone(extra);
            // A helper keeps its equation; a stock the engine added must not drain or fill anything.
            if (copy.type === 'stock') { copy.inflows = []; copy.outflows = []; }
            hybrid.variables.push(copy);
        }
    }
    return hybrid;
};

/**
 * Compare a model's stock trajectories with the correct model's, run on the correct model's specs.
 * `tolerance` is the largest allowed gap at any time, as a share of the stock's largest value.
 * @returns {Promise<string|null>} A description of the first mismatch, or null when they match
 */
export const behaviorMismatch = async function(candidate, correct, tolerance) {
    const stocks = correct.variables.filter((v) => v.type === 'stock').map((v) => v.name);
    const runnable = { ...candidate, relationships: candidate.relationships || [], specs: correct.specs };
    const [mine, truth] = await Promise.all([simulateModel(runnable, stocks, null), simulateModel(correct, stocks, null)]);
    if (!truth.ok) throw new Error(`The correct model failed to simulate: ${truth.error}`);
    if (!mine.ok) return mine.error;
    for (const stock of stocks) {
        const a = mine.series[stock];
        const b = truth.series[stock];
        if (!allFinite(a)) return `Stock "${stock}" is missing or produced non-finite values.`;
        const scale = Math.max(...b.map(Math.abs), 1e-9);
        let worst = 0;
        let at = 0;
        for (let i = 0; i < b.length; i++) {
            const d = Math.abs(a[i] - b[i]);
            if (d > worst) { worst = d; at = i; }
        }
        if (worst > tolerance * scale) {
            return `Stock "${stock}" is ${a[at]} at time ${truth.time[at]} where the correct model has ${b[at]}.`;
        }
    }
    return null;
};

