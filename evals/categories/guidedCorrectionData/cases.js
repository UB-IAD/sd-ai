/**
 * The models, planted errors and follow-up requests for the guidedCorrection category.
 *
 * Each case starts from a correct model (the equilibrium category's models, as they start — out of
 * balance, so they have dynamics an error can disturb) and plants errors in it. An error is a
 * change to one variable: its equation, or the inflows and outflows of a stock. That is what makes
 * each error separately gradable: the engine's version of that one variable is put back into the
 * correct model, and if the result simulates like the correct model, that error is fixed.
 *
 * Every error comes with a plain description, which the judge uses to tell whether the engine
 * identified it, and a symptom — what a novice sees when running the model, with the topic a
 * question must be about to draw it out — and each case lists distractor descriptions of problems the model does not have,
 * so the judge is never handed only true problems to tick off.
 */

import { cases as equilibriumCases } from '../equilibriumData/models.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { correctModel as scenarioModel } from './generate.js';

const correctModel = (name) => structuredClone(equilibriumCases[name].model);

/**
 * Apply a case's errors to its correct model.
 * @param {Object} model The correct model
 * @param {Array<Object>} errors The errors, each `{variable, change}`
 * @returns {Object} The broken model
 */
export const plantErrors = function(model, errors) {
    const broken = structuredClone(model);
    for (const error of errors) {
        const variable = broken.variables.find((v) => v.name === error.variable);
        Object.assign(variable, error.change);
    }
    return broken;
};

export const handCases = {
    "Endemic Infection": {
        description: 'an infection that persists in a population with births and deaths',
        correct: correctModel('Endemic Infection'),
        errors: [
            {
                id: 'recovery formulation',
                symptomTopic: 'what happens to recoveries when the illness lasts longer',
                symptom: "When I make the illness last longer, people recover faster, which can't be right.",
                variable: 'recovering',
                change: { equation: 'Infected * illness_duration' },
                text: 'Recovery multiplies the number infected by the illness duration instead of dividing by it, so a longer illness makes people recover faster (and the units do not work out).'
            },
            {
                id: 'infecting not connected',
                symptomTopic: 'what happens to the infected count when people catch the infection',
                symptom: "When people catch the infection, the susceptible count drops but the infected count never goes up.",
                variable: 'Infected',
                change: { inflows: [] },
                text: 'The "infecting" flow drains the Susceptible stock but is not connected to the Infected stock, so people who catch the infection vanish instead of becoming infected.'
            }
        ],
        distractors: [
            'Births should depend on the number of susceptible people only, not the total population.',
            'The transmission rate should change over time.'
        ],
        extension: {
            request: 'Please add vaccination to the model: a flow called "vaccinating" that moves susceptible people straight to the Recovered stock at a constant "vaccination fraction" of 0.05 per year of the susceptible population.',
            variables: [{ name: 'vaccinating', type: 'flow', references: ['Susceptible'] }, { name: 'vaccination fraction' }],
            stockFlows: [{ stock: 'Susceptible', outflow: 'vaccinating' }, { stock: 'Recovered', inflow: 'vaccinating' }]
        },
        plantedForExtension: 'recovery formulation'
    },
    "Inventory and Workforce": {
        description: 'a factory that sets its workforce from expected demand and its inventory gap',
        correct: correctModel('Inventory and Workforce'),
        errors: [
            {
                id: 'reversed hiring gap',
                symptomTopic: 'what the factory does with its workforce when it is short of workers',
                symptom: "When the factory needs more workers, the model fires people instead of hiring them.",
                variable: 'net hiring',
                change: { equation: '(Workers - desired_workers) / time_to_hire' },
                text: 'Net hiring uses the workforce gap backwards (current workers minus desired workers), so the factory fires people when it needs more and hires when it has too many.'
            },
            {
                id: 'expectation adjustment multiplies by time',
                symptomTopic: 'how expected demand behaves when expectations adjust more slowly',
                symptom: "When I make expectations adjust more slowly, expected demand jumps around even more wildly.",
                variable: 'changing expectations',
                change: { equation: '(demand - Expected_Demand) * time_to_adjust_expectations' },
                text: 'Expected demand adjusts by multiplying the gap by the adjustment time instead of dividing by it, so a longer adjustment time makes expectations change faster.'
            }
        ],
        distractors: [
            'Inventory should not have an outflow for shipping.',
            'Productivity should depend on the size of the workforce.'
        ],
        extension: {
            request: 'Please add a promotion to the model: a constant called "promotional demand" of 5 widgets/month that adds to the demand the factory sees, so demand becomes the base demand plus promotional demand.',
            variables: [{ name: 'promotional demand' }],
            references: [{ variable: 'demand', references: 'promotional demand' }]
        },
        plantedForExtension: 'reversed hiring gap'
    },
    "Population Aging Chain": {
        description: 'a population moving through childhood, adulthood and old age',
        correct: correctModel('Population Aging Chain'),
        errors: [
            {
                id: 'maturing flows into children',
                symptomTopic: 'how the number of children behaves over time',
                symptom: "The number of children keeps growing and growing, even though births are steady.",
                variable: 'Children',
                change: { inflows: ['births', 'maturing'], outflows: [] },
                text: 'The "maturing" flow is attached to the Children stock as an inflow instead of an outflow, so children who grow up are added to the children instead of leaving.'
            },
            {
                id: 'elder deaths multiply by duration',
                symptomTopic: 'how long elders live in the model',
                symptom: "Elders die off almost immediately, and if I make old age last longer they die even faster.",
                variable: 'deaths',
                change: { equation: 'Elders * years_as_elder' },
                text: 'Deaths multiply the number of elders by the years spent as an elder instead of dividing by it, so elders die far too fast and a longer old age makes them die faster.'
            }
        ],
        distractors: [
            'Births should come from Children rather than Adults.',
            'The model needs a separate stock for teenagers.'
        ],
        extension: {
            request: 'Please add immigration of adults to the model: a flow called "adult immigration" into the Adults stock at a constant "immigrants per year" of 200 people/year.',
            variables: [{ name: 'adult immigration', type: 'flow' }, { name: 'immigrants per year' }],
            stockFlows: [{ stock: 'Adults', inflow: 'adult immigration' }]
        },
        plantedForExtension: 'maturing flows into children'
    }
};

const GENERATED = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'generated.json'), 'utf8'));
/**
 * Cases made by the general rule in generate.js for every scenario in the library (see
 * buildGenerated.js), on the scenario's glossary model. Entries for a scenario that is not
 * registered (a stale file) are skipped.
 */
export const generatedCases = Object.fromEntries(Object.entries(GENERATED).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => [name, { ...g, correct: scenarioModel(scenarios[g.scenario]) }]));

export const cases = { ...handCases, ...generatedCases };

const HARD = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'hard.json'), 'utf8'));
/**
 * The hard cases made by the rule in hard.js for every scenario that can give one (see
 * buildGenerated.js): three errors of different kinds at once in the scenario's full model.
 */
export const hardCases = Object.fromEntries(Object.entries(HARD).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => [name, { ...g, correct: scenarioModel(scenarios[g.scenario]) }]));
