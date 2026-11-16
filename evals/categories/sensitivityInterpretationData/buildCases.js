/**
 * Builds the sensitivity-analysis results and answer keys for the sensitivityInterpretation
 * category.
 *
 * For each case a one-at-a-time sweep is run through PySD on a model from the feedbackExplanation
 * fixtures (read, never changed). The engine is shown the sweep's results, sampled at
 * SAMPLE_POINTS times; the answer key is computed from exactly those samples, with deterministic
 * rules, and only questions whose answer is clear are kept:
 *   - "does this parameter change the shape of the behavior?" — by the shared shape classifier:
 *     "yes" when some run's shape label differs from the base run's; "no" only when every run keeps
 *     the base run's label and its number of turning points, and the base behavior is not an
 *     oscillation. For an oscillation, changes of damping, period or number of swings are fairly
 *     called either a change of shape or of size, so only a change of label is asked about
 *   - "which way does raising it move the measure?" — only where the measure is monotonic across
 *     low, base and high; a swing under NO_EFFECT counts as no clear effect, and a swing between
 *     NO_EFFECT and CLEAR_EFFECT gets no question at all, since "slight" and "none" are both fair
 *     readings of it
 *   - every run must stay bounded (under BLOWUP times the base measure): a ranking between two
 *     parameters that both send the model to infinity means nothing
 *   - "which parameter matters most / least?" — only when the leader beats the runner-up (or the
 *     least beats the next-least) by RANKING_MARGIN
 *
 * Besides the hand-picked fixtures, every scenario in the shared scenario library gets a case by
 * the general rule in scenarioSpec.
 *
 * Run `SDAI_TEST_MODE=true node evals/categories/sensitivityInterpretationData/buildCases.js` to
 * regenerate cases.json.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runSweep, summarizeSweep, sampleSeries } from '../../utilities/simulator/sensitivity.js';
import { shapeOf } from '../../utilities/shape.js';
import { scenarios } from '../../utilities/scenarios/library.js';
import { glossaryModel } from '../../utilities/scenarios/renameModel.js';
import { isNumericEquation } from '../../utilities/modelDiff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'feedbackExplanationData');

export const NO_EFFECT = 0.005;
export const CLEAR_EFFECT = 0.02;
export const BLOWUP = 1000;
export const RANKING_MARGIN = 2.5;
export const SAMPLE_POINTS = 21;

const final = (s) => s[s.length - 1];
const peak = (s) => Math.max(...s);

export const CASE_SPECS = {
    "Product Adoption": {
        group: 'simpleSensitivity',
        fixture: 'bassDiffusion',
        output: 'adopting',
        measure: { name: 'peak', label: 'the peak adoption rate', fn: peak },
        parameters: [['contact rate', [40, 160]], ['adoption fraction', [0.006, 0.024]], ['Market Size', [500000, 2000000]]]
    },
    "Arms Race": {
        group: 'simpleSensitivity',
        fixture: 'armsRace',
        output: 'Our Weapons',
        measure: { name: 'final', label: 'Our Weapons at the end of the run', fn: final },
        parameters: [['our desired safety margin', [-0.3, 0.5]], ['their desired safety margin', [-0.3, 0.5]], ['our time to change', [2, 10]]]
    },
    "Inventory and Workforce": {
        group: 'complexSensitivity',
        fixture: 'inventoryWorkforce',
        output: 'Inventory',
        measure: { name: 'peak', label: 'the peak inventory', fn: peak },
        parameters: [['time to hire or fire', [2, 12]], ['inventory adjustment time', [0.5, 4]], ['time to adjust expectations', [2, 12]], ['productivity per worker', [1, 4]]]
    },
    "Predator and Prey": {
        group: 'complexSensitivity',
        fixture: 'predatorPrey',
        output: 'Hares',
        measure: { name: 'peak', label: 'the peak hare population', fn: peak },
        parameters: [['hare birth fraction', [1.1, 1.35]], ['lynx birth fraction', [0.15, 0.4]], ['area', [800, 1200]]]
    }
};

/** A scenario's glossary model over its own run settings. */
export const scenarioModel = (s) => ({ ...glossaryModel(s), specs: s.model.specs });

export const SCENARIO_PARAMETERS = 4;
export const SCENARIO_RANGE = [0.5, 1.5];

/**
 * The general rule for a scenario from the library: its goal variable, measured as its goal is
 * (the peak, the value at the goal's time, or the overshoot), swept over the SCENARIO_PARAMETERS
 * constants that move that measure most, each tried at SCENARIO_RANGE times its value.
 * @param {Object} s A scenario
 * @returns {Promise<Object>} A case spec
 */
export const scenarioSpec = (s) => sweepSpec(s, SCENARIO_PARAMETERS, 'scenarioSensitivity');

/**
 * The hard group's rule for a scenario: the same sweep over the HARD_PARAMETERS constants that move
 * the measure most (a bigger table to read), graded in pairs of questions with different answers
 * (see sensitivityInterpretation.js), so a constant answer cannot score.
 */
export const HARD_PARAMETERS = 6;
export const hardScenarioSpec = (s) => sweepSpec(s, HARD_PARAMETERS, 'scenarioSensitivityHard');

/** A hard case is kept only when its questions give at least this many balanced pairs. */
export const MIN_HARD_PAIRS = 3;

/**
 * The hard group's tests: the questions of each kind (shape, direction) paired so the two in a pair
 * have different answers — repeatedly the next question of the commonest remaining answer with the
 * next of another answer — so no answer given to every parameter passes a pair. The ranking
 * questions (most and least influential), which have no constant answer, form one pair together
 * when both are asked, or stand alone.
 * @param {Array<Object>} questions A case's questions
 * @returns {Array<Array<Object>>} The pairs
 */
export const pairQuestions = function(questions) {
    const pairs = [];
    for (const kind of ['changesShape', 'direction']) {
        const byAnswer = {};
        for (const q of questions.filter((x) => x.kind === kind)) (byAnswer[q.answer] = byAnswer[q.answer] || []).push(q);
        const left = Object.values(byAnswer);
        for (;;) {
            const open = left.filter((g) => g.length).sort((a, b) => b.length - a.length);
            if (open.length < 2) break;
            pairs.push([open[0].shift(), open[1].shift()]);
        }
    }
    const ranking = questions.filter((q) => q.kind === 'mostInfluential' || q.kind === 'leastInfluential');
    if (ranking.length) pairs.push(ranking);
    return pairs;
};

const sweepSpec = async function(s, count, group) {
    const model = scenarioModel(s);
    const output = Object.entries(s.glossaryToModel).find(([, m]) => m === s.goal.variable)?.[0] ?? s.goal.variable;
    const unit = { months: 'month', weeks: 'week', years: 'year', days: 'day' }[s.timeUnits] ?? 'time';
    const measure = s.goal.measure === 'max' ? { name: 'peak', label: `the peak of ${output}`, fn: peak }
        : s.goal.measure === 'overshoot' ? { name: 'overshoot', label: `how far ${output} overshoots its final level`, fn: (x) => peak(x) - final(x) }
        : { name: 'atTime', label: `${output} at ${unit} ${s.goal.time}`, fn: (x, t) => x[Math.min(x.length - 1, Math.round((s.goal.time - model.specs.startTime) / (model.specs.stopTime - model.specs.startTime) * (x.length - 1)))] };
    const constants = model.variables.filter((v) => v.type !== 'stock' && isNumericEquation(v.equation) && Number(v.equation) !== 0);
    const sweep = await runSweep(model, [output], constants.map((c) => ({ name: c.name, values: SCENARIO_RANGE.map((f) => Number(c.equation) * f) })));
    const base = measure.fn(sweep.base.series[output]);
    const swing = (name) => Math.max(0, ...sweep.runs.filter((r) => r.parameter === name && r.ok).map((r) => Math.abs(measure.fn(r.series[output]) - base)));
    const ranked = constants.map((c) => c.name).sort((a, b) => swing(b) - swing(a) || a.localeCompare(b)).slice(0, count);
    return {
        group,
        scenario: s.id,
        output,
        measure,
        parameters: ranked.map((n) => [n, SCENARIO_RANGE.map((f) => Number(constants.find((c) => c.name === n).equation) * f)])
    };
};

/**
 * Build one case: the runs shown to the engine and the key.
 * @param {string} name Case name
 * @param {Object} spec Case spec from CASE_SPECS
 * @returns {Promise<Object>} The case
 */
export const buildCase = async function(name, spec) {
    const model = spec.scenario ? scenarioModel(scenarios[spec.scenario]) : JSON.parse(fs.readFileSync(path.join(FIXTURES, `${spec.fixture}.json`), 'utf8')).model;
    const sweep = await runSweep(model, [spec.output], spec.parameters.map(([n, values]) => ({ name: n, values })));
    if (!sweep.base.ok || sweep.runs.some((r) => !r.ok)) throw new Error(`${name}: a sweep run failed`);
    const baseScale = Math.abs(spec.measure.fn(sweep.base.series[spec.output]));
    for (const run of sweep.runs) {
        if (Math.abs(spec.measure.fn(run.series[spec.output])) > BLOWUP * baseScale) {
            throw new Error(`${name}: ${run.parameter} = ${run.value} sends ${spec.output} unbounded; narrow its range`);
        }
    }

    const runs = [{ parameter: null, value: null, ...sampleSeries(sweep.base.time, sweep.base.series[spec.output], SAMPLE_POINTS) }];
    for (const run of sweep.runs) runs.push({ parameter: run.parameter, value: run.value, ...sampleSeries(run.time, run.series[spec.output], SAMPLE_POINTS) });

    // The key is computed from exactly the samples the engine is shown. The full-resolution runs
    // can carry turns and peaks between samples that no reader of the table could see, and a key
    // built from them would fail an engine for reading the table correctly.
    const shown = {
        base: { series: { [spec.output]: runs[0].values } },
        runs: runs.slice(1).map((r) => ({ parameter: r.parameter, value: r.value, ok: true, series: { [spec.output]: r.values } }))
    };
    const summary = summarizeSweep(shown, spec.output, spec.measure.fn);
    const baseMeasure = spec.measure.fn(runs[0].values);
    const baseValues = Object.fromEntries(spec.parameters.map(([n]) => [n, Number(model.variables.find((v) => v.name === n).equation)]));

    const baseShape = shapeOf(runs[0].values);
    const questions = [];
    for (const [parameter, values] of spec.parameters) {
        const entry = summary.find((s) => s.parameter === parameter);
        if (entry.shapeChanges) questions.push({ id: `${parameter}|shape`, parameter, kind: 'changesShape', answer: 'yes' });
        else if (entry.sameTurns && baseShape !== 'oscillating') questions.push({ id: `${parameter}|shape`, parameter, kind: 'changesShape', answer: 'no' });

        const low = spec.measure.fn(shown.runs.find((r) => r.parameter === parameter && r.value === values[0]).series[spec.output]);
        const high = spec.measure.fn(shown.runs.find((r) => r.parameter === parameter && r.value === values[1]).series[spec.output]);
        const lowFirst = values[0] < baseValues[parameter];
        const [a, b, c] = lowFirst ? [low, baseMeasure, high] : [high, baseMeasure, low];
        if (entry.swing >= NO_EFFECT && entry.swing < CLEAR_EFFECT) {
            // Ambiguous: too small to call a clear effect, too large to call none. No question.
        } else if (entry.swing < NO_EFFECT) {
            questions.push({ id: `${parameter}|direction`, parameter, kind: 'direction', answer: 'no clear effect' });
        } else if (a <= b && b <= c) {
            questions.push({ id: `${parameter}|direction`, parameter, kind: 'direction', answer: 'increases' });
        } else if (a >= b && b >= c) {
            questions.push({ id: `${parameter}|direction`, parameter, kind: 'direction', answer: 'decreases' });
        }
    }
    const swings = summary.map((s) => s.swing);
    if (swings.length > 1 && swings[0] >= RANKING_MARGIN * Math.max(swings[1], 1e-12)) {
        questions.push({ id: 'most influential', kind: 'mostInfluential', answer: summary[0].parameter });
    }
    const last = swings.length - 1;
    if (swings.length > 1 && swings[last - 1] >= RANKING_MARGIN * Math.max(swings[last], 1e-12)) {
        questions.push({ id: 'least influential', kind: 'leastInfluential', answer: summary[last].parameter });
    }

    return {
        name,
        group: spec.group,
        ...(spec.scenario ? { scenario: spec.scenario } : { fixture: spec.fixture }),
        output: spec.output,
        measure: { name: spec.measure.name, label: spec.measure.label },
        timeUnits: model.specs.timeUnits,
        baseShape,
        parameters: spec.parameters.map(([n, values]) => ({ name: n, base: baseValues[n], values })),
        runs,
        questions
    };
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const cases = {};
    for (const [name, spec] of Object.entries(CASE_SPECS)) {
        cases[name] = await buildCase(name, spec);
        console.log(`${name}: ${cases[name].questions.map((q) => `${q.id}=${q.answer}`).join(', ')}`);
    }
    for (const s of Object.values(scenarios)) {
        const name = `${s.title} (sweep)`;
        try {
            cases[name] = await buildCase(name, await scenarioSpec(s));
        } catch (error) {
            console.log(`${name}: no case (${error.message})`);
            continue;
        }
        if (!cases[name].questions.length) { delete cases[name]; console.log(`${name}: no clear question`); continue; }
        console.log(`${name}: ${cases[name].questions.map((q) => `${q.id}=${q.answer}`).join(', ')}`);
    }
    for (const s of Object.values(scenarios)) {
        const name = `${s.title} (wide sweep)`;
        try {
            cases[name] = await buildCase(name, await hardScenarioSpec(s));
        } catch (error) {
            console.log(`${name}: no case (${error.message})`);
            continue;
        }
        if (pairQuestions(cases[name].questions).length < MIN_HARD_PAIRS) { delete cases[name]; console.log(`${name}: too few balanced pairs`); continue; }
        console.log(`${name}: ${pairQuestions(cases[name].questions).map((p) => p.map((q) => `${q.id}=${q.answer}`).join(' & ')).join(', ')}`);
    }
    fs.writeFileSync(path.join(__dirname, 'cases.json'), JSON.stringify(cases, null, 1) + '\n');
}
