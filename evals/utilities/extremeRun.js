/**
 * Whether a model behaves possibly under a given run: every stock stays at or above zero (within a
 * small tolerance) and every value is finite.
 *
 * @module utilities/extremeRun
 */

import { simulateModel, allFinite } from './simulateModel.js';

/**
 * @param {Object} model An sd-json model
 * @param {Object<string, string>|null} overrides The run's overrides
 * @returns {Promise<string|null>} What went impossible, or null when the run is sensible
 */
export const impossibleUnder = async function(model, overrides) {
    const stocks = (model.variables || []).filter((v) => v.type === 'stock').map((v) => v.name);
    const run = await simulateModel(model, null, overrides);
    if (!run.ok) return `the model failed to simulate: ${run.error}`;
    for (const [name, values] of Object.entries(run.series)) {
        if (!allFinite(values)) return `"${name}" became non-finite`;
    }
    for (const name of stocks) {
        const values = run.series[name] || [];
        const scale = Math.max(1, ...values.map(Math.abs));
        const low = Math.min(...values);
        if (low < -1e-6 * scale) return `stock "${name}" went negative (${low.toPrecision(4)})`;
    }
    return null;
};
