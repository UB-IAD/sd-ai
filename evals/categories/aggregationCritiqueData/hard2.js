/**
 * The general rule behind the aggregation critique second hard group (aggregationCritiqueHard2):
 * a second answer that depends on the first. For every question the model as it stands cannot be
 * relied on for, the agent must also say which way it is wrong — whether the aggregate model puts
 * the number too high or too low — and every answer of the case must be right.
 *
 * Held-out scenarios only. A scenario with hand-written cases is asked the first hard group's
 * questions about them (aggregationCritique.js, handHardCase), each split question with its
 * direction from the hand-written split. Every other scenario the generated cases can split
 * (generate.js: a goal that is an amount, and a division of its amounts that reproduces the aggregate
 * when even) is split into North and South with its input divided STRONG (90/10) or MILD (55/45), as
 * in the first hard group, and the questions may be about the goal variable or any of its stocks
 * that is an amount, other than the divided input itself, wherever the even split reproduces it
 * (within REPRODUCES at every point, so its total means the same thing in both models): how high it
 * peaks, and where it ends. Each question's verdict comes from simulation as in the first hard
 * group (at least 25%: split; at most 5%: the aggregate is good enough; in between, or a measure
 * under a tenth of the stock's peak, no question), and a split question's direction from the same
 * runs: `high` when the aggregate's answer is above the split model's, `low` when below.
 *
 * The case takes, in a fixed order (divisions STRONG then MILD, the goal variable then the stocks in
 * model order, peak then end),
 * the first split question of each direction there is, and as many aggregate questions as split
 * ones, so it has answers of both kinds and, wherever the scenario allows, both directions. A
 * scenario without both a split and an aggregate question gives no case. The rule was changed from
 * the first hard group's questions (whose every direction was `low`, so answering "too low" to every
 * split question was always right) before the group's first run. Frozen in hard2Cases.json by
 * buildHard2.js; the unit tests re-derive it.
 *
 * @module categories/aggregationCritiqueData/hard2
 */

import { simulateModel } from '../../utilities/simulateModel.js';
import { MATTERS_CHANGE } from '../../utilities/scenarios/scenarioKit.js';
import { divisionOf, canBeAmount, SCALE_SHARE, AGGREGATE_MAX } from './generate.js';
import { splitModel } from './split.js';
import { STRONG, MILD } from './hard.js';

/** How closely the even split must reproduce a stock's run for questions about it: the division search's 1%. */
export const REPRODUCES = 0.01;
export const DIVISIONS = [STRONG, MILD];

/** The direction of a split question: whether the aggregate's answer is above or below the split model's. */
export const directionOf = (aggregate, split) => (aggregate > split ? 'high' : 'low');

const toGlossary = (s, modelName) => Object.entries(s.glossaryToModel).find(([, m]) => m === modelName)?.[0] ?? modelName.toLowerCase();
const sharesText = (shares) => shares.map((x) => `${Math.round(100 * x)}`).join('/');
const MEASURE = { peak: (x) => Math.max(...x), end: (x) => x[x.length - 1] };

/** The scenario split into North and South with the input divided by `shares`, totals for every given stock. */
const splitOf = function(s, input, amounts, shares, stocks) {
    const value = (n) => Number(s.model.variables.find((v) => v.name === n).equation);
    const overrides = Object.fromEntries(['North', 'South'].map((g, i) => [g, Object.fromEntries(amounts.map((n) => [n, value(n) * (n === input ? shares[i] : 0.5)]))]));
    return splitModel(s.model, ['North', 'South'], overrides, [], stocks);
};

const questionText = (s, stock, kind, input, shares) => `${kind === 'peak' ? `how high the ${toGlossary(s, stock)} (both parts together) will peak` : `the level the ${toGlossary(s, stock)} (both parts together) ends up at by the end of the run`}, if the ${toGlossary(s, input)} divides ${sharesText(shares)}`;

/**
 * A held-out scenario's second-hard-group case, or null.
 * @param {Object} s A scenario from the library
 * @returns {Promise<{scenario: string, input: string, amounts: string[], context: string, questions: Array<Object>}|null>}
 */
export const hard2CaseFor = async function(s) {
    if (!s.goal || !canBeAmount(s.model.variables.find((v) => v.name === s.goal.variable))) return null;
    const division = await divisionOf(s);
    if (!division) return null;
    const { input, amounts } = division;
    const stocks = s.model.variables.filter((v) => v.type === 'stock' && canBeAmount(v)).map((v) => v.name);
    // The goal variable first (whatever its type, as the first hard group asks about it), then the
    // stocks; never the divided input itself (its total is what was divided).
    const quantities = [...new Set([s.goal.variable, ...stocks])].filter((n) => n !== input);
    const base = await simulateModel(s.model, quantities, null);
    const even = await simulateModel(splitOf(s, input, amounts, [0.5, 0.5], quantities), quantities.map((n) => `${n} total`), null);
    if (!base.ok || !even.ok) return null;
    const faithful = quantities.filter((n) => base.series[n].every((x, i) => Math.abs(even.series[`${n} total`][i] - x) <= REPRODUCES * Math.max(1, Math.abs(x))));
    const candidates = [];
    for (const shares of DIVISIONS) {
        const run = await simulateModel(splitOf(s, input, amounts, shares, faithful), faithful.map((n) => `${n} total`), null);
        if (!run.ok) continue;
        for (const stock of faithful) {
            const peak = Math.max(...base.series[stock].map(Math.abs));
            for (const kind of ['peak', 'end']) {
                const a = MEASURE[kind](base.series[stock]);
                const b = MEASURE[kind](run.series[`${stock} total`]);
                if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) < SCALE_SHARE * peak) continue;
                const change = Math.abs(b - a) / Math.abs(a);
                const verdict = change >= MATTERS_CHANGE ? 'split' : change <= AGGREGATE_MAX ? 'aggregate' : null;
                if (!verdict) continue;
                candidates.push({ id: `${s.id}:${stock}:${kind}:${sharesText(shares)}`, stock, kind, shares, text: questionText(s, stock, kind, input, shares), verdict, direction: verdict === 'split' ? directionOf(a, b) : null, change: Number(change.toFixed(4)) });
            }
        }
    }
    const splits = ['high', 'low'].map((d) => candidates.find((q) => q.direction === d)).filter(Boolean);
    const aggregates = candidates.filter((q) => q.verdict === 'aggregate').slice(0, splits.length);
    if (!splits.length || !aggregates.length) return null;
    const questions = candidates.filter((q) => splits.includes(q) || aggregates.includes(q));
    const others = amounts.filter((n) => n !== input).map((n) => toGlossary(s, n));
    const context = `The ${s.title.toLowerCase()} is really two separate parts, North and South, that do not affect each other: each has its own ${stocks.map((n) => toGlossary(s, n)).join(', ')}. We are not sure how unevenly the ${toGlossary(s, input)} divides between North and South: it could be as lopsided as ${sharesText(STRONG)}, or close to even, ${sharesText(MILD)}.${others.length ? ` The ${others.join(', ')} divide${others.length > 1 ? '' : 's'} evenly, and` : ''} everything else is the same in both.`;
    return { scenario: s.id, input, amounts, context, questions };
};
