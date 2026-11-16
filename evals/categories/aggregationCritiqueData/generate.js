/**
 * The general rule that gives aggregation cases for any scenario without hand-written ones, so a new
 * scenario needs no case of its own. The scenario is split into two parts, North and South, that do
 * not affect each other: a protected quantity is split 90/10 between them and every other amount is
 * split evenly; every rate and score is the same in both. Which quantities are amounts is found by
 * requiring an even split to reproduce the aggregate (see divisionOf); a scenario where no division
 * does so gives no case. Two questions are asked of the split: the scenario's goal
 * measure, and where the goal variable ends up. Each question's verdict comes from simulating the
 * split against the aggregate (at least 25%: split; at most 5%: the aggregate is good enough);
 * an ambiguous question gives no case.
 */

import { scenarios } from '../../utilities/scenarios/library.js';
import { simulateModel } from '../../utilities/simulateModel.js';
import { isNumericEquation } from '../../utilities/modelDiff.js';
import { MATTERS_CHANGE } from '../../utilities/scenarios/scenarioKit.js';
import { splitModel } from './split.js';

export const SHARES = [0.9, 0.1];
/**
 * The splits asked about. Only the strongly uneven one: a mild 60/40 split gave every scenario
 * "the aggregate is good enough" on both questions, tests a constant answer passes.
 */
export const SHARE_LEVELS = [SHARES];
const toGlossary = (s, modelName) => Object.entries(s.glossaryToModel).find(([, m]) => m === modelName)?.[0] ?? modelName;

/**
 * Units that can never be an amount to divide between two parts: a time (a delay, a response time,
 * a lifetime) or a pure number (a fraction, a ratio). Dividing them is not splitting an organization.
 */
const NOT_AN_AMOUNT = /^(\s*(dimensionless|1|fraction|ratio|percent|%|minutes?|hours?|days?|weeks?|months?|years?|seconds?)\s*)$/i;
export const canBeAmount = (v) => !NOT_AN_AMOUNT.test(String(v?.units ?? '').trim()) && String(v?.units ?? '').trim() !== '';
const numericVars = (s) => s.model.variables.filter((v) => isNumericEquation(v.equation) && Number(v.equation) !== 0 && canBeAmount(v));

/** The split model: `amounts` (constants and stock starts that are quantities, not rates) divided between the groups, the input by `shares` and the rest evenly. */
export const splitFor = function(s, input, amounts, shares) {
    const value = (n) => Number(s.model.variables.find((v) => v.name === n).equation);
    const overrides = Object.fromEntries(['North', 'South'].map((g, i) => [g, Object.fromEntries(amounts.map((n) => [n, value(n) * (n === input ? shares[i] : 0.5)]))]));
    return splitModel(s.model, ['North', 'South'], overrides, [], [s.goal.variable]);
};

/** How far an even split's run of the goal variable is from the aggregate's: the largest relative gap. */
const evenGap = async function(s, input, amounts) {
    const agg = await simulateModel(s.model, [s.goal.variable], null);
    const even = await simulateModel(splitFor(s, input, amounts, [0.5, 0.5]), [`${s.goal.variable} total`], null);
    if (!agg.ok || !even.ok) return Infinity;
    const [a, b] = [agg.series[s.goal.variable], even.series[`${s.goal.variable} total`]];
    return Math.max(...a.map((x, i) => Math.abs(b[i] - x) / Math.max(1, Math.abs(x))));
};
const REPRODUCES = 0.01;
const MAX_AMOUNTS = 8;

/**
 * The input the split divides, and the amounts split with it. An amount is a quantity, not a rate or
 * a score: dividing a city's demand or a fleet's vans between two parts halves it, but dividing them
 * leaves a rate or a soil score as it is. Which variables are amounts is found by requiring an even
 * split to reproduce the aggregate: starting from the input alone, the variable (a constant or a
 * stock's start) whose division leaves the smallest gap is added, one at a time — even when that
 * step does not narrow the gap, since some amounts only reproduce the aggregate together — until
 * the even split reproduces the aggregate or MAX_AMOUNTS are divided. The input is the first
 * protected quantity for which this succeeds.
 * @returns {Promise<{input: string, amounts: string[]}|null>}
 */
export const divisionOf = async function(s) {
    const candidates = (s.protected?.variables || []).map((g) => s.glossaryToModel[g] ?? s.model.variables.find((v) => v.name.toLowerCase() === g.toLowerCase())?.name).filter((n) => n && numericVars(s).some((v) => v.name === n));
    for (const input of candidates) {
        let amounts = [input];
        let gap = await evenGap(s, input, amounts);
        while (gap > REPRODUCES && amounts.length < MAX_AMOUNTS) {
            let best = null;
            for (const v of numericVars(s).filter((x) => !amounts.includes(x.name))) {
                const g = await evenGap(s, input, [...amounts, v.name]);
                // The best addition is taken even if it does not narrow the gap yet: some amounts
                // only reproduce the aggregate together (foodBank's families and volunteers).
                if (g < (best?.gap ?? Infinity)) best = { name: v.name, gap: g };
            }
            if (!best) break;
            amounts = [...amounts, best.name];
            gap = best.gap;
        }
        if (gap <= REPRODUCES) return { input, amounts };
    }
    return null;
};

export const MEASURES = {
    goal: (s) => {
        const { measure, time } = s.goal;
        if (measure === 'max') return (x) => Math.max(...x);
        if (measure === 'overshoot') return (x) => Math.max(...x) - x[x.length - 1];
        return (x, t) => x[t.findIndex((u) => u >= time - 1e-9)];
    },
    final: () => (x) => x[x.length - 1]
};

const questionText = (s, kind) => {
    const g = toGlossary(s, s.goal.variable);
    if (kind === 'final') return `the level the ${g} (both parts together) ends up at by the end of the run`;
    if (s.goal.measure === 'max') return `how high the ${g} (both parts together) will peak`;
    if (s.goal.measure === 'overshoot') return `how far the ${g} (both parts together) overshoots the level it finally settles at`;
    return `the ${g} (both parts together) at ${s.timeUnits === 'months' ? 'month' : s.timeUnits === 'weeks' ? 'week' : 'time'} ${s.goal.time}`;
};

const measureOn = async function(model, name, of) {
    const run = await simulateModel(model, [name], null);
    return run.ok ? of(run.series[name], run.time) : NaN;
};

/** How much of the aggregate run's largest value the change is measured against, at the least. */
export const SCALE_SHARE = 0.1;
/**
 * A generated "the aggregate is good enough" verdict needs the split to move the answer by at most
 * this much: well clear of the line, as the hand-written cases are, so a key never sits next to it.
 */
export const AGGREGATE_MAX = 0.05;
const peakOf = async function(s) {
    const run = await simulateModel(s.model, [s.goal.variable], null);
    return run.ok ? Math.max(...run.series[s.goal.variable].map(Math.abs)) : 0;
};

/** @returns {Promise<Array<Object>>} The scenario's cases ({name, scenario, kind, verdict, heterogeneity, question}) */
export const generateCases = async function(s) {
    if (!s.goal) return [];
    // The two parts' answers are added together, so the goal must be an amount: a total of two
    // average response times means nothing.
    if (!canBeAmount(s.model.variables.find((v) => v.name === s.goal.variable))) return [];
    const division = await divisionOf(s);
    if (!division) return [];
    const { input, amounts } = division;
    const total = `${s.goal.variable} total`;
    const stocks = s.model.variables.filter((v) => v.type === 'stock').map((v) => toGlossary(s, v.name));
    const out = [];
    for (const shares of SHARE_LEVELS) {
        const split = splitFor(s, input, amounts, shares);
        const heterogeneity = `The ${s.title.toLowerCase()} is really two separate parts, North and South, that do not affect each other: each has its own ${stocks.join(', ')}. Between North and South, the ${toGlossary(s, input)} divides about ${shares.map((x) => `${100 * x}`).join('/')}; the ${amounts.filter((n) => n !== input).map((n) => toGlossary(s, n)).join(', ')} divide${amounts.length > 2 ? '' : 's'} evenly; and everything else is the same in both.`;
        const suffix = shares === SHARES ? '' : ` (${shares.map((x) => `${100 * x}`).join('/')})`;
        for (const kind of ['goal', 'final']) {
            const of = MEASURES[kind](s);
            const [a, b] = [await measureOn(s.model, s.goal.variable, of), await measureOn(split, total, of)];
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            // Against the run's own scale as well as the value: a measure that ends at zero (losses that
            // stop) would otherwise turn any small difference into an enormous relative change.
            const scale = Math.max(Math.abs(a), SCALE_SHARE * (await peakOf(s)), 1e-9);
            const change = Math.abs(b - a) / scale;
            const verdict = change >= MATTERS_CHANGE ? 'split' : change <= AGGREGATE_MAX ? 'aggregate' : null;
            // The key the category re-derives is the plain relative change; a case is kept only when
            // that gives the same verdict; a measure that ends near zero (under SCALE_SHARE of the
            // run's peak) has no meaningful relative change and gives no case.
            if (Math.abs(a) < SCALE_SHARE * (await peakOf(s))) continue;
            const plain = Math.abs(b - a) / Math.abs(a);
            if (verdict !== (plain >= MATTERS_CHANGE ? 'split' : plain <= AGGREGATE_MAX ? 'aggregate' : null)) continue;
            if (verdict) out.push({ name: `${s.title}, ${kind === 'goal' ? 'goal measure' : 'end level'}${suffix}`, scenario: s.id, kind, verdict, heterogeneity, question: questionText(s, kind), input, amounts, shares, change: Number(change.toFixed(4)) });
        }
    }
    return out;
};

export { scenarios };
