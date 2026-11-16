/**
 * Cases for the extremeConditions category.
 *
 * Each case is a robust model — every stock stays non-negative and every value finite under
 * extreme inputs — and a planted version of one formulation that is not: a flow that keeps draining
 * a stock that has run dry, a division by a quantity that can reach zero. Normally the two behave
 * nearly the same; under the case's `trigger` (an extreme input) the planted model goes impossible
 * and the robust one does not. The category's unit tests check all three claims by simulation.
 */

import { cases as equilibrium } from '../equilibriumData/models.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { robustModel } from './generate.js';
import { hardRobustModel } from './hard.js';

const withVariables = function(model, changes, additions) {
    const copy = structuredClone(model);
    for (const [name, equation] of Object.entries(changes)) copy.variables.find((v) => v.name === name).equation = equation;
    copy.variables.push(...additions);
    return copy;
};

export const handCases = {
    "Project Backlog and Staff": {
        description: 'a project office whose staffing follows its backlog',
        clean: withVariables(equilibrium['Project Backlog and Staff'].model,
            { completing: 'MIN(Staff * productivity, Backlog / minimum_completion_time)' },
            [{ name: 'minimum completion time', type: 'variable', equation: '0.5', units: 'months' }]),
        plant: { variable: 'completing', equation: 'Staff * productivity' },
        trigger: { 'project arrivals': '0' },
        failure: 'with no new projects, "completing" keeps finishing projects that do not exist and the Backlog goes negative'
    },
    "Inventory and Workforce": {
        description: 'a factory that sets its workforce from expected demand and its inventory gap',
        clean: withVariables(equilibrium['Inventory and Workforce'].model,
            { shipping: 'MIN(demand, Inventory / minimum_shipping_time)' },
            [{ name: 'minimum shipping time', type: 'variable', equation: '0.25', units: 'months' }]),
        plant: { variable: 'shipping', equation: 'demand' },
        trigger: { demand: '200' },
        failure: 'with demand ten times normal, "shipping" keeps shipping goods the factory does not have and Inventory goes negative'
    },
    "Endemic Infection": {
        description: 'an infection that persists in a population with births and deaths',
        clean: withVariables(equilibrium['Endemic Infection'].model,
            { infecting: 'transmission_rate * Susceptible * Infected / MAX(total_population, 1)' },
            []),
        plant: { variable: 'infecting', equation: 'transmission_rate * Susceptible * Infected / total_population' },
        trigger: { Susceptible: '0', Infected: '0', Recovered: '0' },
        failure: 'with nobody in the population, "infecting" divides zero by zero and the model breaks'
    }
};

const GENERATED = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'generated.json'), 'utf8'));
/**
 * Cases made by the general rule in generate.js for every scenario in the library (see
 * buildGenerated.js), on the scenario's glossary model. Entries for a scenario that is not
 * registered (a stale file) are skipped.
 */
export const generatedCases = Object.fromEntries(Object.entries(GENERATED).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => [name, { ...g, clean: robustModel(scenarios[g.scenario], g.added) }]));

export const cases = { ...handCases, ...generatedCases };

/** The model with the case's plant in place. */
export const plantedModel = function(c) {
    const model = structuredClone(c.clean);
    model.variables.find((v) => v.name === c.plant.variable).equation = c.plant.equation;
    return model;
};

const HARD = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'hard.json'), 'utf8'));
/**
 * The hard cases made by the rule in hard.js (see buildGenerated.js): several impossible
 * formulations at once in a scenario's full model, each with its own extreme.
 */
export const hardCases = Object.fromEntries(Object.entries(HARD).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => [name, { ...g, clean: hardRobustModel(scenarios[g.scenario], g.added) }]));
