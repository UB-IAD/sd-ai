/**
 * Analysis tools an agent can use in eval runs: scenario runs, sensitivity sweeps, calibration to
 * data, and single-lever optimization.
 *
 * In the product these come from the Stella client. Evals have no Stella, so these are the evals'
 * own versions, with their own schemas — they are not meant to match Stella's, since Stella is not
 * what is being tested. They are offered to an agent as client tools when a test sets the
 * `analysisTools` engine parameter (see AgentEvalRunner), and run on the agent's current model
 * through PySD (overrides are applied to the sd-json; PySD itself is never touched).
 *
 * Every call lands in the agent's tool log with its arguments, so a category can check exactly what
 * the agent ran — which parameters it swept, which extreme values it tried — rather than what it
 * says it ran.
 *
 * @module utilities/analysisTools
 */

import { simulateModel } from './simulateModel.js';
import { runSweep, sampleSeries } from './simulator/sensitivity.js';
import { findVariable } from './modelDiff.js';

export const SAMPLE_POINTS = 21;
const LONG = 15 * 60 * 1000;

/** The client tool definitions, in the shape the session's DynamicToolProvider expects. */
export const ANALYSIS_TOOL_DEFINITIONS = [
    {
        name: 'run_scenario',
        description: 'Run the current model with some parameters changed (the model itself is not changed) and return the chosen outputs over time. Use it for what-if runs and extreme-conditions tests.',
        inputSchema: {
            type: 'object',
            properties: {
                overrides: { type: 'object', description: 'Variable name to the number (or equation) to use instead of its equation in this run', additionalProperties: { type: ['number', 'string'] } },
                outputs: { type: 'array', items: { type: 'string' }, description: 'Variables to report' }
            },
            required: ['overrides', 'outputs']
        },
        timeout: LONG
    },
    {
        name: 'run_sensitivity',
        description: 'One-at-a-time sensitivity analysis on the current model: each parameter is set to each of its values in turn, everything else at base. Returns each output over time for the base run and every varied run.',
        inputSchema: {
            type: 'object',
            properties: {
                parameters: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } }, required: ['name', 'values'] } },
                outputs: { type: 'array', items: { type: 'string' } }
            },
            required: ['parameters', 'outputs']
        },
        timeout: LONG
    },
    {
        name: 'load_calibration_data',
        description: 'Load the historical data the user has for this problem: one or more series over time.',
        inputSchema: { type: 'object', properties: {} },
        timeout: 60000
    },
    {
        name: 'run_calibration',
        description: 'Fit chosen parameters of the current model to the historical data, minimizing the squared error between a model variable and a data series. Returns the best values found and how well they fit.',
        inputSchema: {
            type: 'object',
            properties: {
                parameters: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, min: { type: 'number' }, max: { type: 'number' } }, required: ['name', 'min', 'max'] } },
                variable: { type: 'string', description: 'The model variable to fit' },
                series: { type: 'string', description: 'The data series to fit it to' }
            },
            required: ['parameters', 'variable', 'series']
        },
        timeout: LONG
    },
    {
        name: 'run_optimization',
        description: 'Search one policy lever over a range for the value that best meets an objective on a model variable (minimize or maximize its peak, its final value, or its value at a time).',
        inputSchema: {
            type: 'object',
            properties: {
                lever: { type: 'object', properties: { name: { type: 'string' }, min: { type: 'number' }, max: { type: 'number' } }, required: ['name', 'min', 'max'] },
                variable: { type: 'string' },
                measure: { type: 'string', enum: ['peak', 'final', 'atTime'] },
                time: { type: 'number' },
                goal: { type: 'string', enum: ['minimize', 'maximize'] }
            },
            required: ['lever', 'variable', 'measure', 'goal']
        },
        timeout: LONG
    }
];

const sample = (time, series) => sampleSeries(time, series, Math.min(SAMPLE_POINTS, time.length));

const runOutputs = async function(model, outputs, overrides) {
    const run = await simulateModel(model, outputs, overrides);
    if (!run.ok) return { error: run.error };
    return { time: sample(run.time, run.time).values, outputs: Object.fromEntries(Object.entries(run.series).map(([n, v]) => [n, sample(run.time, v).values])) };
};

/** Sum of squared errors between a run and data points ({time, value}), interpolating the run. */
export const fitError = function(time, values, data) {
    let total = 0;
    for (const point of data) {
        const i = time.findIndex((t) => t >= point.time - 1e-9);
        if (i === -1) continue;
        const v = i === 0 ? values[0] : values[i - 1] + ((values[i] - values[i - 1]) * (point.time - time[i - 1])) / Math.max(time[i] - time[i - 1], 1e-12);
        total += (v - point.value) ** 2;
    }
    return total;
};

/**
 * Nelder–Mead over a box, with values clamped to their bounds.
 * @param {function(Array<number>): Promise<number>} objective What to minimize
 * @param {Array<{min: number, max: number}>} bounds The box
 * @param {number} maxEvaluations The budget
 * @param {Array<number>|null} initial Where to start (clamped into the box), or null for the box's middle
 * @returns {Promise<{best: Array<number>, value: number, evaluations: number}>}
 */
export const nelderMead = async function(objective, bounds, maxEvaluations, initial) {
    const n = bounds.length;
    const clamp = (x) => x.map((v, i) => Math.min(bounds[i].max, Math.max(bounds[i].min, v)));
    const start = clamp(initial || bounds.map((b) => (b.min + b.max) / 2));
    // Each other vertex steps a quarter of the box from the start, toward whichever side has room.
    const step = (b, v) => (v + 0.25 * (b.max - b.min) <= b.max ? v + 0.25 * (b.max - b.min) : v - 0.25 * (b.max - b.min));
    let simplex = [start, ...bounds.map((b, i) => { const p = [...start]; p[i] = step(b, start[i]); return p; })].map(clamp);
    let values = [];
    let evaluations = 0;
    const f = async (x) => { evaluations++; return objective(x); };
    for (const p of simplex) values.push(await f(p));
    while (evaluations < maxEvaluations) {
        const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
        simplex = order.map((i) => simplex[i]);
        values = order.map((i) => values[i]);
        const centroid = start.map((_, d) => simplex.slice(0, n).reduce((s, p) => s + p[d], 0) / n);
        const worst = simplex[n];
        const reflected = clamp(centroid.map((c, d) => c + (c - worst[d])));
        const fr = await f(reflected);
        if (fr < values[0]) {
            const expanded = clamp(centroid.map((c, d) => c + 2 * (c - worst[d])));
            const fe = await f(expanded);
            if (fe < fr) { simplex[n] = expanded; values[n] = fe; } else { simplex[n] = reflected; values[n] = fr; }
        } else if (fr < values[n - 1]) {
            simplex[n] = reflected; values[n] = fr;
        } else {
            const contracted = clamp(centroid.map((c, d) => c + 0.5 * (worst[d] - c)));
            const fc = await f(contracted);
            if (fc < values[n]) { simplex[n] = contracted; values[n] = fc; } else {
                for (let i = 1; i <= n; i++) { simplex[i] = clamp(simplex[i].map((v, d) => simplex[0][d] + 0.5 * (v - simplex[0][d]))); values[i] = await f(simplex[i]); }
            }
        }
        if (Math.max(...values) - Math.min(...values) < 1e-9 * Math.max(1, Math.abs(values[0]))) break;
    }
    const bestIndex = values.indexOf(Math.min(...values));
    return { best: simplex[bestIndex], value: values[bestIndex], evaluations };
};

const measureOf = (time, series, measure, at) => {
    if (measure === 'peak') return Math.max(...series);
    if (measure === 'final') return series[series.length - 1];
    const i = time.findIndex((t) => t >= at - 1e-9);
    return series[i === -1 ? series.length - 1 : i];
};

/**
 * Run one analysis tool on a model.
 *
 * @param {string} toolName The tool's name
 * @param {Object} args Its arguments
 * @param {Object} model The agent's current model
 * @param {Object|null} calibrationData The test's data, `{series: {name: [{time, value}]}}`, or null
 * @returns {Promise<Object>} The result, or `{error}`
 */
export const runAnalysisTool = async function(toolName, args, model, calibrationData) {
    if (!model || !(model.variables || []).length) return { error: 'There is no model to analyse yet.' };
    const unknown = (names) => names.filter((n) => !findVariable(model.variables, n));
    switch (toolName) {
        case 'run_scenario': {
            const missing = unknown([...Object.keys(args.overrides || {}), ...(args.outputs || [])]);
            if (missing.length) return { error: `Not in the model: ${missing.join(', ')}` };
            return runOutputs(model, args.outputs, Object.fromEntries(Object.entries(args.overrides).map(([k, v]) => [k, String(v)])));
        }
        case 'run_sensitivity': {
            const missing = unknown([...(args.parameters || []).map((p) => p.name), ...(args.outputs || [])]);
            if (missing.length) return { error: `Not in the model: ${missing.join(', ')}` };
            const sweep = await runSweep(model, args.outputs, args.parameters);
            if (!sweep.base.ok) return { error: sweep.base.error };
            const show = (run) => Object.fromEntries(Object.entries(run.series).map(([n, v]) => [n, sample(run.time, v).values]));
            return {
                time: sample(sweep.base.time, sweep.base.time).values,
                base: show(sweep.base),
                runs: sweep.runs.map((r) => (r.ok ? { parameter: r.parameter, value: r.value, outputs: show(r) } : { parameter: r.parameter, value: r.value, error: r.error }))
            };
        }
        case 'load_calibration_data': {
            if (!calibrationData) return { error: 'No historical data is available for this problem.' };
            return calibrationData;
        }
        case 'run_calibration': {
            if (!calibrationData) return { error: 'No historical data is available for this problem.' };
            if (!Array.isArray(args.parameters) || args.parameters.length === 0) return { error: 'Name at least one parameter to calibrate, with its range.' };
            const data = calibrationData.series?.[args.series];
            if (!data) return { error: `No data series "${args.series}". Series: ${Object.keys(calibrationData.series || {}).join(', ')}` };
            const missing = unknown([...(args.parameters || []).map((p) => p.name), args.variable]);
            if (missing.length) return { error: `Not in the model: ${missing.join(', ')}` };
            const variable = findVariable(model.variables, args.variable).name;
            const objective = async (x) => {
                const run = await simulateModel(model, [variable], Object.fromEntries(args.parameters.map((p, i) => [p.name, String(x[i])])));
                return run.ok ? fitError(run.time, run.series[variable], data) : Number.MAX_VALUE;
            };
            // Start from the model's own values, where they lie inside the ranges asked for: a wide
            // range should widen the search, not throw away a good starting point.
            const initial = args.parameters.map((p) => {
                const v = Number(findVariable(model.variables, p.name).equation);
                return Number.isFinite(v) ? v : (p.min + p.max) / 2;
            });
            const result = await nelderMead(objective, args.parameters, 20 + 25 * args.parameters.length, initial);
            const mean = data.reduce((s, p) => s + p.value, 0) / data.length;
            const total = data.reduce((s, p) => s + (p.value - mean) ** 2, 0);
            return {
                best: Object.fromEntries(args.parameters.map((p, i) => [p.name, result.best[i]])),
                sumOfSquaredErrors: result.value,
                rSquared: total > 0 ? 1 - result.value / total : null,
                runs: result.evaluations
            };
        }
        case 'run_optimization': {
            const missing = unknown([args.lever?.name, args.variable]);
            if (missing.length) return { error: `Not in the model: ${missing.join(', ')}` };
            const variable = findVariable(model.variables, args.variable).name;
            const steps = 20;
            const tried = [];
            for (let i = 0; i <= steps; i++) {
                const value = args.lever.min + ((args.lever.max - args.lever.min) * i) / steps;
                const run = await simulateModel(model, [variable], { [args.lever.name]: String(value) });
                if (run.ok) tried.push({ value, result: measureOf(run.time, run.series[variable], args.measure, args.time) });
            }
            if (!tried.length) return { error: 'Every run failed.' };
            const best = tried.reduce((a, b) => ((args.goal === 'minimize' ? b.result < a.result : b.result > a.result) ? b : a));
            return { best: { [args.lever.name]: best.value, [args.variable]: best.result }, tried };
        }
        default:
            return { error: `Unknown analysis tool ${toolName}` };
    }
};
