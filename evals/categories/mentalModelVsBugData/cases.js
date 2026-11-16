/**
 * Cases for the mentalModelVsBug category.
 *
 * A modeler reports that the model does something they did not expect. In half the cases the
 * model has a planted bug and the modeler's expectation is right — the bug and its symptom are the
 * guidedCorrection category's. In the other half the model is correct and the expectation is
 * wrong: the report describes what the correct model really does and an expectation it refutes.
 * Every report is checked by simulation in the unit tests through `check`: for a bug, the
 * expectation holds in the correct model and fails in the planted one; for a wrong expectation,
 * what the report describes holds in the correct model.
 */

import { cases as equilibriumCases } from '../equilibriumData/models.js';
import { cases as correctionCases, plantErrors } from '../guidedCorrectionData/cases.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { correctModel as scenarioModel, plant } from '../guidedCorrectionData/generate.js';
import { holdsFor } from './generate.js';

const bugCase = (caseName, errorId, report, check) => {
    const c = correctionCases[caseName];
    const error = c.errors.find((e) => e.id === errorId);
    return {
        kind: 'bug',
        description: c.description,
        correct: c.correct,
        given: plantErrors(c.correct, [error]),
        plant: { variable: error.variable, fields: Object.keys(error.change) },
        report,
        check
    };
};

/** A bug planted by hand in an equilibrium-category model, rather than taken from guidedCorrection. */
const plantedCase = (caseName, description, correctChanges, plant, report, check) => {
    const correct = structuredClone(equilibriumCases[caseName].model);
    for (const [name, fields] of Object.entries(correctChanges)) Object.assign(correct.variables.find((v) => v.name === name), fields);
    const given = structuredClone(correct);
    Object.assign(given.variables.find((v) => v.name === plant.variable), plant.change);
    return { kind: 'bug', description, correct, given, plant: { variable: plant.variable, fields: Object.keys(plant.change) }, report, check };
};

const TOWN_REPORT = 'Every year the town has fewer births than deaths, yet the population keeps growing. I expected it to shrink.';

const expectationCase = (caseName, report, check) => ({
    kind: 'expectation',
    description: equilibriumCases[caseName].description,
    correct: structuredClone(equilibriumCases[caseName].model),
    given: structuredClone(equilibriumCases[caseName].model),
    report,
    check
});

export const handCases = {
    'Endemic Infection': bugCase('Endemic Infection', 'recovery formulation',
        "When I make the illness last longer, people recover faster, which can't be right. I expected a longer illness to mean people stay infected longer and recover more slowly.",
        { outputs: ['recovering'], overrides: { 'illness duration': '0.2' }, holds: (r, base) => r.at('recovering', 0) < base.at('recovering', 0) }),
    'Population Aging Chain': bugCase('Population Aging Chain', 'maturing flows into children',
        'The number of children explodes: by the end of the run there are far more children than adults, and the gap keeps widening. I expected the number of children to grow roughly in step with the number of adults who have them, staying smaller than the adult population.',
        { outputs: ['Children', 'Adults'], holds: (r) => r.series.Children.every((k, i) => k < r.series.Adults[i]) }),
    'Cooling Coffee': expectationCase('Cooling Coffee',
        'The coffee cools quickly at first and then more and more slowly, and after an hour it is still a little above room temperature. I expected it to cool at a steady rate until it reached room temperature.',
        { outputs: ['Coffee Temperature', 'cooling'], holds: (r) => r.last('Coffee Temperature') > 20.01 && r.at('cooling', 0) > 3 * r.at('cooling', 30) }),
    'Reservoir': expectationCase('Reservoir',
        'When I double the river inflow, the water rises and then levels off at about twice the level it settled at before. I expected it to keep rising without limit, since the river now brings in more water than before.',
        { outputs: ['Water in Reservoir'], overrides: { 'inflow rate': '100' }, holds: (r, base) => Math.abs(r.last('Water in Reservoir') / base.last('Water in Reservoir') - 2) < 0.05 && r.last('Water in Reservoir') - r.at('Water in Reservoir', 35) < 1 }),
    'Faster Reservoir': expectationCase('Reservoir',
        'When I make the water leave twice as fast, the reservoir settles at only half its old level. Since the river still brings in exactly as much water as before, I expected it to settle at the same level, just sooner.',
        { outputs: ['Water in Reservoir'], overrides: { 'residence time': '2' }, holds: (r, base) => Math.abs(r.last('Water in Reservoir') / base.last('Water in Reservoir') - 0.5) < 0.05 }),
    'Town Population': expectationCase('Town Population',
        TOWN_REPORT,
        { outputs: ['Population', 'births', 'deaths'], holds: (r) => r.series.births.every((b, i) => b < r.series.deaths[i]) && r.last('Population') > r.at('Population', 0) * 1.2 }),
    // The same report as the town's, about a town nobody moves into: here the expectation is right,
    // and the newcomers in the model are the bug. How plausible a report sounds says nothing about
    // which it is; only the model and its description do.
    'Closed Town': plantedCase('Town Population', 'a town population with births and deaths, which nobody moves into or out of',
        { 'newcomers per year': { equation: '0' } },
        { variable: 'newcomers per year', change: { equation: '10' } },
        TOWN_REPORT,
        { outputs: ['Population'], holds: (r) => r.last('Population') < r.at('Population', 0) }),
    // A sophisticated expectation that is right: the release is capped, so the water never levels off.
    'Capped Reservoir': plantedCase('Reservoir', 'a reservoir fed by a river and drained by releases proportional to the water stored',
        {},
        { variable: 'release', change: { equation: 'MIN(Water_in_Reservoir / residence_time, 40)' } },
        'The water in the reservoir rises and never levels off, even though releases are supposed to grow with the water stored. I expected it to level off once the releases had grown to match the river inflow.',
        { outputs: ['Water in Reservoir'], holds: (r) => r.last('Water in Reservoir') - r.at('Water in Reservoir', 35) < 1 })
};

const GENERATED = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'generated.json'), 'utf8'));
/**
 * Cases made by the general rule in generate.js for every scenario in the library (see
 * buildGenerated.js), on the scenario's glossary model; their checks are data, turned into
 * functions here. Entries for a scenario that is not registered (a stale file) are skipped.
 */
export const generatedCases = Object.fromEntries(Object.entries(GENERATED).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => {
    const correct = scenarioModel(scenarios[g.scenario]);
    const { error, ...rest } = g;
    return [name, { ...rest, correct, given: error ? plant(correct, [error]) : structuredClone(correct), check: { ...g.check, holds: holdsFor(g.check.test) } }];
}));

export const cases = { ...handCases, ...generatedCases };

const HARD = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'hard.json'), 'utf8'));
/**
 * The hard cases made by the rule in hard.js (see buildGenerated.js): one report of several
 * surprises, bugs and mistaken expectations together, about a scenario's full model with its bugs
 * planted.
 */
export const hardCases = Object.fromEntries(Object.entries(HARD).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => {
    const correct = scenarioModel(scenarios[g.scenario]);
    return [name, { ...g, correct, given: plant(correct, g.errors) }];
}));

const HARD2_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hard2.json');
const HARD2 = JSON.parse(fs.readFileSync(HARD2_FILE, 'utf8'));
/**
 * The second hard group's cases, made by the rule in hard2.js (see buildHard2.js): on held-out
 * scenarios, one report of every surprise of the scenario's pairs, bugs and mistaken expectations in
 * equal numbers, about its full model with those bugs planted.
 */
export const hard2Cases = Object.fromEntries(Object.entries(HARD2).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => {
    const correct = scenarioModel(scenarios[g.scenario]);
    return [name, { ...g, correct, given: plant(correct, g.errors) }];
}));
