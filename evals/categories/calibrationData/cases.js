/**
 * Cases for the calibration category.
 *
 * Each case is a hidden scenario's model (in its glossary names), historical data for one of its
 * stocks, and a hidden truth the data came from:
 *   - `kind: 'parameters'`: the same structure with two parameters at other values. Calibrating
 *     those parameters makes the model fit; nothing is missing.
 *   - `kind: 'structure'`: a model with a mechanism the given model lacks — members who leave,
 *     referrals that keep growing, demand that rises and falls with the seasons. No parameter
 *     values of the given model reproduce the data's shape (checked in the unit tests by
 *     calibrating it as hard as the agent's tool can); the right answer is to say what is missing.
 *     Each also lists distractor mechanisms the data rule out (a seasonal swing cannot make a list
 *     keep growing; a single step cannot keep an oscillation going), so naming the real one is a
 *     matter of reading the data, not of guessing among causes that would all fit.
 * The data are the truth's run, sampled and given a fixed ±2% wobble so they look measured.
 */

import { scenarios } from '../../utilities/scenarios/library.js';
import { glossaryModel } from '../../utilities/scenarios/renameModel.js';
import { simulateModel, applyOverrides } from '../../utilities/simulateModel.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { applyChanges } from './generate.js';

/** The glossary model with some variables' equations, inflows or outflows changed, and new variables added. */
const variant = (id, changes, added) => {
    const m = glossaryModel(scenarios[id]);
    for (const [name, fields] of Object.entries(changes)) Object.assign(m.variables.find((v) => v.name === name), typeof fields === 'string' ? { equation: fields } : fields);
    m.variables.push(...(added || []));
    return m;
};

export const handCases = {
    'Bike share, parameters': {
        scenario: 'bikeShare', kind: 'parameters', series: 'members',
        truth: variant('bikeShare', { 'persuasion': '0.032', 'advertising effect': '0.001' }),
        parameters: ['persuasion', 'advertising effect']
    },
    'Bike share, members leaving': {
        // Six years of history: over three, members who leave only look like slower growth.
        scenario: 'bikeShare', kind: 'structure', series: 'members', stopTime: 72,
        truth: variant('bikeShare', { 'members': { outflows: ['leaving'] } }, [{ name: 'leaving', type: 'flow', equation: 'members * leaving_fraction', units: 'people/month' }, { name: 'leaving fraction', type: 'variable', equation: '0.1', units: '1/month' }]),
        mechanism: 'Members leave the scheme after a while (members drop out over time).',
        distractors: ['Advertising has stopped working.', 'The number of people who could join is shrinking as people move away.']
    },
    'Dialysis, parameters': {
        scenario: 'dialysisClinic', kind: 'parameters', series: 'waiting list',
        truth: variant('dialysisClinic', { 'build delay': '13', 'patients per chair': '1.05' }),
        parameters: ['build delay', 'patients per chair']
    },
    'Dialysis, growing referrals': {
        scenario: 'dialysisClinic', kind: 'structure', series: 'waiting list',
        truth: variant('dialysisClinic', { 'referrals': 'base_referrals * EXP(referral_growth * TIME)' }, [{ name: 'referral growth', type: 'variable', equation: '0.03', units: '1/month' }]),
        mechanism: 'Referrals keep growing over time instead of staying steady.',
        distractors: ['Patients who give up never come back.', 'Referrals rise and fall with the seasons.']
    },
    'Distributor, parameters': {
        scenario: 'distributor', kind: 'parameters', series: 'inventory',
        truth: variant('distributor', { 'adjustment time': '3.5', 'delivery delay': '8', 'supply line': '800' }),
        parameters: ['adjustment time', 'delivery delay']
    },
    'Distributor, seasonal demand': {
        scenario: 'distributor', kind: 'structure', series: 'inventory',
        truth: variant('distributor', { 'demand': 'base_demand + STEP(demand_increase, step_time) + seasonal_swing * SIN(2 * 3.14159 * TIME / 26)' }, [{ name: 'seasonal swing', type: 'variable', equation: '25', units: 'cases/week' }]),
        mechanism: 'Customer demand rises and falls with the seasons, again and again.',
        distractors: ['Customer demand stepped up a second time.', 'Inventory is lost to damage or theft.']
    }
};

const GENERATED = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'generated.json'), 'utf8'));
/**
 * Cases made by the general rule in generate.js for every scenario with no hand-written ones (see
 * buildGenerated.js). Each carries the parameters the rule calibrates. Entries for a scenario that
 * is not registered (a stale file) are skipped.
 */
export const generatedCases = Object.fromEntries(Object.entries(GENERATED).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => [name, { ...g, truth: applyChanges(glossaryModel(scenarios[g.scenario]), g.changes) }]));

export const cases = { ...handCases, ...generatedCases };

/** A fixed wobble in [-1, 1] for the i-th data point (deterministic, so the data never change). */
const wobble = (i) => {
    const x = Math.sin(12.9898 * (i + 1) + 78.233) * 43758.5453;
    return 2 * (x - Math.floor(x)) - 1;
};

export const NOISE = 0.02;
export const DATA_POINTS = 25;

/** The case's data: the truth's run of the series, sampled, with the fixed wobble. */
export const dataFor = async function(c) {
    const run = await simulateModel({ ...c.truth, specs: specsFor(c) }, [c.series], null);
    if (!run.ok) throw new Error(`The truth for ${c.series} failed to simulate: ${run.error}`);
    const out = [];
    for (let i = 0; i < DATA_POINTS; i++) {
        const k = Math.round((i * (run.time.length - 1)) / (DATA_POINTS - 1));
        const v = run.series[c.series][k];
        out.push({ time: run.time[k], value: Number((v * (1 + NOISE * wobble(i))).toPrecision(4)) });
    }
    return out;
};

/** The case's run settings: the scenario's, over the case's own span of history where it has one. */
export const specsFor = (c) => ({ ...scenarios[c.scenario].model.specs, ...(c.stopTime ? { stopTime: c.stopTime } : {}) });

/** The model the agent is given: the scenario's glossary model, over the case's span of history. */
export const givenModel = (c) => ({ ...glossaryModel(scenarios[c.scenario]), specs: specsFor(c) });

export { applyOverrides };
