/**
 * The general rule behind the reference modes category's hard group: numbers instead of shapes.
 *
 * For every scenario, "now" is the share NOW of the way through the hidden model's run. The agent is
 * told how the situation works (the scenario's mechanisms and the numbers behind them, but not its
 * narrative, which describes the whole run) and given the run up to now as a rough table — every key
 * quantity, and every other quantity of its glossary that changes, sampled at ROWS evenly spaced times with a fixed, deterministic wobble of up to NOISE
 * either way, rounded to three significant figures — and is asked where each key quantity will be
 * at the end of the run if nothing changes. The answer
 * is a number, graded within TOLERANCE of the hidden model's value (or within FLOOR of the
 * quantity's largest recorded value, for one that ends near zero).
 *
 * A quantity is graded only when no answer that ignores the system lands in its band: not the last
 * recorded value carried forward, not the first one ("it settles back where it started"), not the
 * column's lowest or highest value, not the straight line through the last TREND_ROWS rows, and not
 * the constants 0 or 1. Everything here is computed by simulation and frozen in forecasts.json by
 * buildForecasts.js; the unit tests re-derive it.
 *
 * @module categories/referenceModesData/forecast
 */

import { simulateModel } from '../../utilities/simulateModel.js';

export const NOW = 0.5;
export const ROWS = 13;
export const NOISE = 0.03;
export const TOLERANCE = 0.15;
export const FLOOR = 0.02;
export const TREND_ROWS = 4;
export const CONSTANTS = [0, 1];

/** A fixed wobble in [-1, 1] for the i-th data point (deterministic, so the table never changes). */
const wobble = (i) => {
    const x = Math.sin(12.9898 * (i + 1) + 78.233) * 43758.5453;
    return 2 * (x - Math.floor(x)) - 1;
};

const sig = (x) => Number(Number(x).toPrecision(3));

/** The straight line through some points, by least squares, read at time t. */
const lineAt = function(points, t) {
    const n = points.length;
    const mt = points.reduce((a, p) => a + p.time, 0) / n;
    const mv = points.reduce((a, p) => a + p.value, 0) / n;
    const sxx = points.reduce((a, p) => a + (p.time - mt) ** 2, 0);
    const slope = sxx ? points.reduce((a, p) => a + (p.time - mt) * (p.value - mv), 0) / sxx : 0;
    return mv + slope * (t - mt);
};

/** Whether a value is within a band around the truth. */
export const within = (value, f) => Number.isFinite(value) && Math.abs(value - f.truth) <= f.band + 1e-9;

/**
 * A scenario's forecast question.
 * @param {Object} s A scenario from the library
 * @returns {Promise<{scenario: string, now: number, at: number, timeUnits: string, columns: Array<string>, table: Array<Object>, quantities: Array<Object>}>}
 *   `table` rows {time, <glossary name>: value}, one column per quantity in `columns` (the key
 *   quantities, then every other glossary quantity of the model that changes before now);
 *   `quantities` per key quantity {glossary, truth, band, naive: {persistence, trend, first, min, max}, graded}
 */
export const forecastFor = async function(s) {
    const start = s.model.specs.startTime;
    const at = s.model.specs.stopTime;
    const now = start + (at - start) * NOW;
    const keys = s.keyVariables.map((k) => ({ glossary: k.glossary, model: k.model }));
    const others = Object.entries(s.glossaryToModel).filter(([g]) => !keys.some((k) => k.glossary === g)).map(([glossary, model]) => ({ glossary, model }));
    const run = await simulateModel(s.model, [...keys, ...others].map((c) => c.model), null);
    if (!run.ok) throw new Error(`${s.id}: the hidden model failed to simulate: ${run.error}`);
    const index = (t) => run.time.findIndex((x) => x >= t - 1e-9);
    const times = Array.from({ length: ROWS }, (_, i) => start + (i * (now - start)) / (ROWS - 1));
    const recordedOf = (c, j) => times.map((t, i) => ({ time: t, value: sig(run.series[c.model][index(t)] * (1 + NOISE * wobble(i + 100 * j))) }));
    const varies = (c) => { const x = run.series[c.model].slice(0, index(now) + 1); return Math.max(...x) - Math.min(...x) > 1e-9 * Math.max(1, ...x.map(Math.abs)); };
    const columns = [...keys, ...others.filter(varies)];
    const recorded = columns.map(recordedOf);
    const table = times.map((t, i) => Object.fromEntries([['time', sig(t)], ...columns.map((c, j) => [c.glossary, recorded[j][i].value])]));
    const quantities = keys.map((k, j) => {
        const series = run.series[k.model];
        const truth = series[series.length - 1];
        const band = Math.max(TOLERANCE * Math.abs(truth), FLOOR * Math.max(...series.slice(0, index(now) + 1).map(Math.abs)));
        const f = { glossary: k.glossary, truth: sig(truth), band: sig(band) };
        const column = recorded[j].map((r) => r.value);
        const naive = { persistence: recorded[j].at(-1).value, trend: sig(lineAt(recorded[j].slice(-TREND_ROWS), at)), first: column[0], min: Math.min(...column), max: Math.max(...column) };
        const graded = ![naive.persistence, naive.trend, naive.first, naive.min, naive.max, ...CONSTANTS].some((v) => within(v, f));
        return { ...f, naive, graded };
    });
    return { scenario: s.id, now, at, timeUnits: s.timeUnits, columns: columns.map((c) => c.glossary), table, quantities };
};

/**
 * The hard groups' tighter band. The hard prompts (here and in the stock-and-flow-within-boundary
 * category) give every number behind the hidden run — each mechanism and its parameters — so a
 * forecast worked out from them is limited by how the agent formulates the mechanisms, not by
 * guessing the numbers: the band is HARD_BAND_SHARE of the forecast band (7.5% of the value, or 1%
 * of the quantity's largest recorded value), still well over twice the table's 3% noise.
 */
export const HARD_BAND_SHARE = 0.5;

/**
 * Every number written in a text: "1,200" is 1200, "0.05%" is 0.05, and "$2.6 million" counts as
 * both 2.6 and 2,600,000.
 * @param {string} text
 * @returns {number[]}
 */
export const numbersIn = function(text) {
    const out = [];
    for (const m of String(text).matchAll(/(\d[\d,]*(?:\.\d+)?)(\s*million)?/gi)) {
        const x = Number(m[1].replace(/,/g, ''));
        if (!Number.isFinite(x)) continue;
        out.push(x);
        if (m[2]) out.push(x * 1e6);
    }
    return out;
};

/**
 * A forecast quantity under the hard groups' tighter band, graded only when no system-blind answer
 * lands in that band: not the naive answers of the forecast rule (the first, last, lowest and
 * highest recorded values and the straight-line trend), not the constants, and not any number
 * written in the prompt that asks for it.
 * @param {Object} q A quantity from forecastFor
 * @param {number[]} promptNumbers The numbers written in the prompt (numbersIn)
 * @returns {Object} The quantity with its tighter `band` and its `graded` under it
 */
export const tightened = function(q, promptNumbers) {
    const f = { truth: q.truth, band: sig(q.band * HARD_BAND_SHARE) };
    const blind = [q.naive.persistence, q.naive.trend, q.naive.first, q.naive.min, q.naive.max, ...CONSTANTS, ...promptNumbers];
    return { ...q, band: f.band, graded: !blind.some((v) => within(v, f)) };
};

/**
 * The second hard group's rule (referenceModesHard2), the lever of several answers graded together:
 * the same facts and the same rough table as the hard group's question, but the agent is asked for
 * every key quantity at several times through the rest of the run — at HORIZONS of the way through
 * it, every TRAJECTORY_STEP rows of the table carried on — not only at its end, and one test needs
 * every graded number within its band. Each point's band is the hard group's tighter one (HARD_BAND_SHARE of
 * the forecast band at that time: 7.5% of the hidden value there, or 1% of the quantity's largest
 * value up to now), and a point is graded only when no system-blind answer lands in it (pointGraded).
 * A scenario is asked only when its graded points fall at MIN_TRAJECTORY_TIMES different times or
 * more, so the answer is a path through time, not one number. Frozen in trajectories.json by
 * buildForecasts.js; the unit tests re-derive it.
 */
export const HORIZONS = [0.625, 0.75, 0.875, 1];
export const MIN_TRAJECTORY_TIMES = 2;

/**
 * A scenario's trajectory question, from its forecast question (forecastFor's result).
 * @param {Object} s A scenario from the library
 * @param {Object} f Its forecast question
 * @returns {Promise<{scenario: string, times: number[], points: Array<{glossary: string, at: number, truth: number, band: number, naive: Object}>}>}
 */
export const trajectoryFor = async function(s, f) {
    const start = s.model.specs.startTime;
    const stop = s.model.specs.stopTime;
    const run = await simulateModel(s.model, s.keyVariables.map((k) => k.model), null);
    if (!run.ok) throw new Error(`${s.id}: the hidden model failed to simulate: ${run.error}`);
    const index = (t) => run.time.findIndex((x) => x >= t - 1e-9);
    const times = HORIZONS.map((h) => sig(start + (stop - start) * h));
    const points = [];
    for (const k of s.keyVariables) {
        const series = run.series[k.model];
        const scale = Math.max(...series.slice(0, index(f.now) + 1).map(Math.abs));
        const rows = f.table.map((r) => ({ time: r.time, value: r[k.glossary] }));
        const column = rows.map((r) => r.value);
        for (const at of times) {
            const truth = series[index(at)];
            const band = HARD_BAND_SHARE * Math.max(TOLERANCE * Math.abs(truth), FLOOR * scale);
            const naive = { persistence: column.at(-1), trend: sig(lineAt(rows.slice(-TREND_ROWS), at)), first: column[0], min: Math.min(...column), max: Math.max(...column) };
            points.push({ glossary: k.glossary, at, truth: sig(truth), band: sig(band), naive });
        }
    }
    return { scenario: s.id, times, points };
};

/** Whether a trajectory point is graded: no naive answer, constant, or number written in the prompt lands in its band. */
export const pointGraded = (p, promptNumbers) => ![p.naive.persistence, p.naive.trend, p.naive.first, p.naive.min, p.naive.max, ...CONSTANTS, ...promptNumbers].some((v) => within(v, p));
