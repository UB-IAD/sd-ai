/**
 * The general rule behind the aggregation critique hard group: both measures and two divisions of a
 * scenario, asked together, with answers of both kinds.
 *
 * A scenario with hand-written cases is asked about those: all of them together, its different
 * accounts of the groups (two neighbourhoods that talk at different rates, or alike) offered as
 * alternatives. Every other scenario the generated cases can split (generate.js: a goal that is an amount, and a
 * division of its amounts that reproduces the aggregate when even) is split into North and South
 * twice: with the input divided STRONG (90/10, as the generated cases) and MILD (55/45). Each
 * division is asked about both measures — the scenario's goal measure and where the goal variable
 * ends up — and each question's verdict comes from simulation exactly as a generated case's does
 * (at least 25%: split; at most 5%: the aggregate is good enough; in between, or a measure ending
 * near zero, the question is dropped). A scenario is used only when its questions have both
 * verdicts, so any constant answer fails. Frozen in hardCases.json by buildHard.js; the unit tests
 * re-derive it.
 *
 * @module categories/aggregationCritiqueData/hard
 */

import { simulateModel } from '../../utilities/simulateModel.js';
import { MATTERS_CHANGE } from '../../utilities/scenarios/scenarioKit.js';
import { splitFor, divisionOf, canBeAmount, MEASURES, SCALE_SHARE, AGGREGATE_MAX } from './generate.js';

export const STRONG = [0.9, 0.1];
export const MILD = [0.55, 0.45];
export const DIVISIONS = [STRONG, MILD];

const toGlossary = (s, modelName) => Object.entries(s.glossaryToModel).find(([, m]) => m === modelName)?.[0] ?? modelName;

const measureOn = async function(model, name, of) {
    const run = await simulateModel(model, [name], null);
    return run.ok ? of(run.series[name], run.time) : NaN;
};

/** The question about one measure, in the scenario's words. */
export const measureText = function(s, kind) {
    const g = toGlossary(s, s.goal.variable);
    if (kind === 'final') return `the level the ${g} (both parts together) ends up at by the end of the run`;
    if (s.goal.measure === 'max') return `how high the ${g} (both parts together) will peak`;
    if (s.goal.measure === 'overshoot') return `how far the ${g} (both parts together) overshoots the level it finally settles at`;
    return `the ${g} (both parts together) at ${s.timeUnits === 'months' ? 'month' : s.timeUnits === 'weeks' ? 'week' : 'time'} ${s.goal.time}`;
};

const sharesText = (shares) => shares.map((x) => `${Math.round(100 * x)}`).join('/');

/**
 * A scenario's hard case, or null.
 * @param {Object} s A scenario from the library
 * @returns {Promise<{scenario: string, input: string, amounts: string[], context: string, questions: Array<{id: string, kind: string, shares: number[], text: string, verdict: string, change: number}>}|null>}
 */
export const hardCaseFor = async function(s) {
    if (!s.goal || !canBeAmount(s.model.variables.find((v) => v.name === s.goal.variable))) return null;
    const division = await divisionOf(s);
    if (!division) return null;
    const { input, amounts } = division;
    const run = await simulateModel(s.model, [s.goal.variable], null);
    if (!run.ok) return null;
    const peak = Math.max(...run.series[s.goal.variable].map(Math.abs));
    const questions = [];
    for (const shares of DIVISIONS) {
        const split = splitFor(s, input, amounts, shares);
        for (const kind of ['goal', 'final']) {
            const of = MEASURES[kind](s);
            const [a, b] = [await measureOn(s.model, s.goal.variable, of), await measureOn(split, `${s.goal.variable} total`, of)];
            if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) < SCALE_SHARE * peak) continue;
            const change = Math.abs(b - a) / Math.abs(a);
            const verdict = change >= MATTERS_CHANGE ? 'split' : change <= AGGREGATE_MAX ? 'aggregate' : null;
            if (!verdict) continue;
            questions.push({ id: `${s.id}:${kind}:${sharesText(shares)}`, kind, shares, text: `${measureText(s, kind)}, if the ${toGlossary(s, input)} divides ${sharesText(shares)}`, verdict, change: Number(change.toFixed(4)) });
        }
    }
    if (new Set(questions.map((q) => q.verdict)).size < 2) return null;
    const stocks = s.model.variables.filter((v) => v.type === 'stock').map((v) => toGlossary(s, v.name));
    const others = amounts.filter((n) => n !== input).map((n) => toGlossary(s, n));
    const context = `The ${s.title.toLowerCase()} is really two separate parts, North and South, that do not affect each other: each has its own ${stocks.join(', ')}. We are not sure how unevenly the ${toGlossary(s, input)} divides between North and South: it could be as lopsided as ${sharesText(STRONG)}, or close to even, ${sharesText(MILD)}.${others.length ? ` The ${others.join(', ')} divide${others.length > 1 ? '' : 's'} evenly, and` : ''} everything else is the same in both.`;
    return { scenario: s.id, input, amounts, context, questions };
};
