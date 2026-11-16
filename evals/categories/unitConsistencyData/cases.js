/**
 * Cases for the unitConsistency category.
 *
 * buildWithUnits: a description that states every quantity with its units, precisely enough that
 * one model follows from it. The reference model is that model; the engine's stocks must follow its
 * trajectories, and the engine's model must be unit-consistent.
 *
 * fixUnits: correct, unit-consistent models (the equilibrium category's, read but never changed)
 * with unit errors planted in them. Each error lives in one variable: an equation whose units do
 * not work out, or units declared wrongly. The unit checker reports every planted error; the
 * category's tests prove that.
 */

import { cases as equilibriumCases } from '../equilibriumData/models.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { correctModel as scenarioModel } from './generate.js';

const stock = (name, equation, inflows, outflows, units) => ({ name, type: 'stock', equation: String(equation), inflows, outflows, units });
const flow = (name, equation, units) => ({ name, type: 'flow', equation, units });
const aux = (name, equation, units) => ({ name, type: 'variable', equation: String(equation), units });

export const handBuildCases = {
    "Savings Account": {
        group: 'buildWithUnits',
        description: `A savings account holds a Balance, measured in dollars, that starts at 1000 dollars. The Balance grows by interest, which is the Balance times an interest rate of 0.05 per year, and by deposits of 100 dollars per year. Account fees of 10 dollars per year are taken out of the Balance. Simulate from year 0 to year 30.`,
        reference: {
            variables: [
                stock('Balance', 1000, ['interest', 'deposits'], ['fees'], 'dollars'),
                flow('interest', 'Balance * interest_rate', 'dollars/year'),
                flow('deposits', 'deposit_amount', 'dollars/year'),
                flow('fees', 'fee_amount', 'dollars/year'),
                aux('interest rate', 0.05, '1/year'),
                aux('deposit amount', 100, 'dollars/year'),
                aux('fee amount', 10, 'dollars/year')
            ],
            relationships: [],
            specs: { startTime: 0, stopTime: 30, dt: 0.25, timeUnits: 'years' }
        },
        stocks: ['Balance']
    },
    "Water Tank": {
        group: 'buildWithUnits',
        description: `A tank holds Tank Water, measured in liters, starting at 100 liters. Water flows in at a constant 20 liters per minute. Water drains out at a rate equal to the Tank Water divided by a drain time of 25 minutes. Simulate from minute 0 to minute 120.`,
        reference: {
            variables: [
                stock('Tank Water', 100, ['filling'], ['draining'], 'liters'),
                flow('filling', 'fill_rate', 'liters/minute'),
                flow('draining', 'Tank_Water / drain_time', 'liters/minute'),
                aux('fill rate', 20, 'liters/minute'),
                aux('drain time', 25, 'minutes')
            ],
            relationships: [],
            specs: { startTime: 0, stopTime: 120, dt: 0.25, timeUnits: 'minutes' }
        },
        stocks: ['Tank Water']
    },
    "Trainees and Experienced Staff": {
        group: 'buildWithUnits',
        description: `A firm's workforce has two stocks, both measured in people: Trainees, starting at 50 people, and Experienced Staff, starting at 200 people. The firm hires 30 people per month into Trainees. Trainees finish training and move into Experienced Staff at a rate equal to Trainees divided by a training time of 6 months. Experienced Staff quit at a rate equal to Experienced Staff times a quit fraction of 0.02 per month. Simulate from month 0 to month 60.`,
        reference: {
            variables: [
                stock('Trainees', 50, ['hiring'], ['completing training'], 'people'),
                stock('Experienced Staff', 200, ['completing training'], ['quitting'], 'people'),
                flow('hiring', 'hiring_rate', 'people/month'),
                flow('completing training', 'Trainees / training_time', 'people/month'),
                flow('quitting', 'Experienced_Staff * quit_fraction', 'people/month'),
                aux('hiring rate', 30, 'people/month'),
                aux('training time', 6, 'months'),
                aux('quit fraction', 0.02, '1/month')
            ],
            relationships: [],
            specs: { startTime: 0, stopTime: 60, dt: 0.125, timeUnits: 'months' }
        },
        stocks: ['Trainees', 'Experienced Staff']
    }
};

export const handFixCases = {
    "Reservoir": {
        description: 'a reservoir fed by a river and drained by releases',
        correct: structuredClone(equilibriumCases['Reservoir'].model),
        errors: [
            { id: 'release multiplies by residence time', variable: 'release', change: { equation: 'Water_in_Reservoir * residence_time' } },
            { id: 'river inflow declared without per day', variable: 'river inflow', change: { units: 'megaliters' } }
        ]
    },
    "Project Backlog and Staff": {
        description: 'a project office whose staffing follows its backlog',
        correct: structuredClone(equilibriumCases['Project Backlog and Staff'].model),
        errors: [
            { id: 'staff change multiplies by adjustment time', variable: 'staff change', change: { equation: '(desired_staff - Staff) * time_to_adjust_staff' } },
            { id: 'completing declared as projects', variable: 'completing', change: { units: 'projects' } }
        ]
    },
    "Predators and Prey": {
        description: 'a prey population with limited food and a predator population that lives off it',
        correct: structuredClone(equilibriumCases['Predators and Prey'].model),
        errors: [
            { id: 'predator deaths adds rate to population', variable: 'predator deaths', change: { equation: 'predator_death_rate + Predators' } },
            { id: 'predation rate declared per year only', variable: 'predation rate', change: { units: '1/year' } }
        ]
    }
};

const GENERATED = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'generated.json'), 'utf8'));
/**
 * fixUnits cases made by the general rule in generate.js for every scenario in the library (see
 * buildGenerated.js), on the scenario's glossary model. Entries for a scenario that is not
 * registered (a stale file) are skipped.
 */
export const generatedFixCases = Object.fromEntries(Object.entries(GENERATED).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => [name, { ...g, correct: scenarioModel(scenarios[g.scenario]) }]));

export const fixCases = { ...handFixCases, ...generatedFixCases };

const GENERATED_BUILD = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'generatedBuild.json'), 'utf8'));
/** buildWithUnits cases made by the general rule in generate.js; the reference is the scenario's glossary model. */
export const generatedBuildCases = Object.fromEntries(Object.entries(GENERATED_BUILD).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => [name, { ...g, group: 'buildWithUnits', reference: scenarioModel(scenarios[g.scenario]) }]));

export const buildCases = { ...handBuildCases, ...generatedBuildCases };

const HARD = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'hard.json'), 'utf8'));
/** Hard fixUnits cases made by the rule in hard.js (see buildGenerated.js): three unit errors of different kinds at once. */
export const hardFixCases = Object.fromEntries(Object.entries(HARD).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => [name, { ...g, correct: scenarioModel(scenarios[g.scenario]) }]));

/**
 * Apply errors to a correct model.
 * @param {Object} model The correct model
 * @param {Array<{variable: string, change: Object}>} errors The errors to plant
 * @returns {Object} The broken model
 */
export const plantUnitErrors = function(model, errors) {
    const broken = structuredClone(model);
    for (const error of errors) Object.assign(broken.variables.find((v) => v.name === error.variable), error.change);
    return broken;
};
