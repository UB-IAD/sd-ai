/**
 * Cases for the formulationCritique category.
 *
 * Each case is a clean model — every formulation passes the linter — with poor formulations planted
 * in it. Every plant is a pure matter of form: the planted equation computes exactly what the clean
 * one does (a number written in place of its named constant, an intermediate inlined, a guard-free
 * division, a hard-coded time switch in place of a STEP), so a fix can be checked two ways at once:
 * the linter no longer flags it, and the model still behaves exactly as before.
 *
 * Each case also lists distractors: plausible-sounding problems with formulations that are fine,
 * so the judge reading the agent's critique is never handed only true problems.
 */

import { cases as equilibrium } from '../equilibriumData/models.js';
import { scenarios } from '../../utilities/scenarios/library.js';
import { glossaryModel } from '../../utilities/scenarios/renameModel.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { cleanModel } from './generate.js';

export const handCases = {
    "Inventory and Workforce": {
        description: 'a factory that sets its workforce from expected demand and its inventory gap',
        clean: structuredClone(equilibrium['Inventory and Workforce'].model),
        plants: [
            { id: 'desired workers inlined', variable: 'desired workers', rule: 'too many inputs', equation: '(Expected_Demand + (desired_inventory - Inventory) / inventory_adjustment_time) / productivity', text: '"desired workers" packs five inputs into one equation instead of naming the desired production it is built on.' },
            { id: 'hiring time embedded', variable: 'net hiring', rule: 'embedded constant', equation: '(desired_workers - Workers) / 6', text: '"net hiring" has the six-month hiring time written into its equation as a number instead of using its named constant.' }
        ],
        distractors: ['"producing" should not depend on the number of workers.', '"Inventory" needs an initial value of zero.']
    },
    "Endemic Infection": {
        description: 'an infection that persists in a population with births and deaths',
        clean: structuredClone(equilibrium['Endemic Infection'].model),
        plants: [
            { id: 'unguarded division by population', variable: 'infecting', rule: 'unguarded division', equation: 'transmission_rate * Susceptible * Infected / (Susceptible + Infected + Recovered)', text: '"infecting" divides by the sum of the three population stocks with no guard against that sum reaching zero (and repeats a total the model already names).' }
        ],
        distractors: ['"recovering" should be a fixed number of people per year.', '"births" should not depend on the death rate.']
    },
    "Predators and Prey": {
        description: 'a prey population with limited food and a predator population that lives off it',
        clean: structuredClone(equilibrium['Predators and Prey'].model),
        plants: [
            { id: 'predator death rate embedded', variable: 'predator deaths', rule: 'embedded constant', equation: 'Predators * 0.2', text: '"predator deaths" has the death rate 0.2 written into its equation instead of using the named "predator death rate".' }
        ],
        distractors: ['"prey births" should not depend on the carrying capacity.', '"Predators" must start at zero.']
    },
    "Regional distributor inventory": {
        description: "a regional distributor's inventory and ordering",
        clean: glossaryModel(scenarios.distributor),
        plants: [
            { id: 'hard-coded demand step', variable: 'demand', rule: 'hard-coded time switch', rules: ['hard-coded time switch', 'embedded constant'], equation: 'IF TIME >= 4 THEN 120 ELSE 100', text: '"demand" switches on a hard-coded time with hard-coded levels instead of using STEP with named base demand, increase and step time.' }
        ],
        distractors: ['"deliveries" should not depend on the supply line.', '"orders" should never depend on expected demand.']
    }
};

const GENERATED = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'generated.json'), 'utf8'));
/**
 * Cases made by the general rule in generate.js for every scenario in the library whose model is
 * lint-clean (see buildGenerated.js). Entries for a scenario that is not registered (a stale file)
 * are skipped.
 */
export const generatedCases = Object.fromEntries(Object.entries(GENERATED).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => [name, { ...g, clean: cleanModel(scenarios[g.scenario]) }]));

export const cases = { ...handCases, ...generatedCases };

/**
 * The model with every plant applied.
 * @param {Object} c A case
 * @returns {Object} The planted model
 */
export const plantedModel = function(c) {
    const model = structuredClone(c.clean);
    for (const p of c.plants) model.variables.find((v) => v.name === p.variable).equation = p.equation;
    return model;
};

const HARD = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'hard.json'), 'utf8'));
/**
 * The hard cases made by the rule in hard.js (see buildGenerated.js): several plants of different
 * kinds at once in a scenario's full model.
 */
export const hardCases = Object.fromEntries(Object.entries(HARD).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => [name, { ...g, clean: cleanModel(scenarios[g.scenario]) }]));
