/**
 * Run an sd-json model through PySD and hand back its series keyed by the model's own names.
 *
 * Every simulation-graded category needs the same few steps: convert to XMILE, ask PySD for the
 * variables by their XMILE names, and map the results back. This is that sequence once, plus
 * two things the new categories need on top of it:
 *   - parameter overrides, applied to the sd-json before conversion, so a sweep or an extreme
 *     run never has to touch PySD itself (PySD is third-party and is never modified here)
 *   - a structured result rather than a throw, so a grader can turn a failed run into a failure
 *     entry with the simulator's reason attached
 *
 * @module utilities/simulateModel
 */

import SDJsonToXMILE from '../../utilities/SDJsonToXMILE.js';
import PySDSimulator from './simulator/PySDSimulator.js';
import { cacheEnabled, keyFor, readCached, writeCached } from './simulator/simCache.js';
import utils from '../../utilities/utils.js';
import { findVariable } from './modelDiff.js';

/**
 * Return a deep copy of a model with some variables' equations replaced.
 *
 * @param {Object} model An sd-json model (the bare model, not a response wrapper)
 * @param {Object<string, (number|string)>} overrides Variable name to replacement equation
 * @returns {Object} The modified copy
 * @throws {Error} When an override names a variable the model does not have
 */
export const applyOverrides = function(model, overrides) {
    const copy = structuredClone(model);
    for (const [name, value] of Object.entries(overrides)) {
        const variable = findVariable(copy.variables || [], name);
        if (!variable) throw new Error(`Override names "${name}", which is not a variable in this model.`);
        variable.equation = String(value);
        // A constant replaced by a number must not keep a lookup that would reinterpret it.
        if (variable.graphicalFunction && variable.type !== 'stock') delete variable.graphicalFunction;
    }
    return copy;
};

/**
 * Unwrap an engine response or a fixture to its bare model.
 * @param {Object} modelOrResponse A bare sd-json model, or an object carrying one under `model`
 * @returns {Object|null} The bare model, or null when there is none
 */
export const bareModel = function(modelOrResponse) {
    if (!modelOrResponse) return null;
    if (Array.isArray(modelOrResponse.variables)) return modelOrResponse;
    if (modelOrResponse.model && Array.isArray(modelOrResponse.model.variables)) return modelOrResponse.model;
    return null;
};

/**
 * Simulate a model.
 *
 * @param {Object} modelOrResponse A bare sd-json model or a response carrying one under `model`
 * @param {Array<string>|null} variableNames Variables to record, by their model names; null records every
 *   stock, flow and auxiliary in the model
 * @param {Object<string, (number|string)>|null} overrides Equations to substitute before running, or null
 * @returns {Promise<{ok: true, time: Array<number>, series: Object<string, Array<number>>} | {ok: false, error: string}>}
 *   On success, `series` is keyed by the model's own variable names, not their XMILE spellings.
 */
export const simulateModel = async function(modelOrResponse, variableNames, overrides) {
    const base = bareModel(modelOrResponse);
    if (!base) return { ok: false, error: 'There is no model with a variables array to simulate.' };

    let model;
    try {
        model = overrides && Object.keys(overrides).length ? applyOverrides(base, overrides) : base;
    } catch (error) {
        return { ok: false, error: error.message };
    }
    if (!Array.isArray(model.relationships)) model = { ...model, relationships: [] };

    const wanted = variableNames || (model.variables || []).map((v) => v.name).filter((n) => typeof n === 'string');
    if (wanted.length === 0) return { ok: false, error: 'The model has no variables to record.' };

    let xmile;
    try {
        xmile = SDJsonToXMILE(model, { modelName: 'eval-model', vendor: 'sd-ai-evals', product: 'sd-ai-evals', version: '1.0' });
    } catch (error) {
        return { ok: false, error: `The model could not be converted to XMILE: ${error.message}` };
    }

    const asked = wanted.map((name) => utils.xmileName(name));
    const key = cacheEnabled() ? keyFor(xmile, asked) : null;
    let raw = key ? readCached(key) : null;
    if (!raw) {
        try {
            raw = await new PySDSimulator(xmile).simulate(asked);
        } catch (error) {
            return { ok: false, error: `The model failed to simulate: ${String(error.message).slice(0, 1500)}` };
        }
        if (key && Array.isArray(raw?.time) && raw.time.length) writeCached(key, raw);
    }

    const time = raw?.time;
    if (!Array.isArray(time) || time.length === 0) return { ok: false, error: 'The simulator returned no time steps.' };

    const series = {};
    for (const name of wanted) {
        const values = raw[utils.xmileName(name)];
        if (Array.isArray(values)) series[name] = values;
    }
    return { ok: true, time, series };
};

/**
 * Whether every value in a series is a finite number.
 * @param {Array<number>} values A simulated series
 * @returns {boolean} True when the series exists and holds only finite numbers
 */
export const allFinite = function(values) {
    return Array.isArray(values) && values.length > 0 && values.every((v) => Number.isFinite(v));
};
