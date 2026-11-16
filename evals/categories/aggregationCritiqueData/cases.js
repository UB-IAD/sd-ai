/**
 * Cases for the aggregationCritique category.
 *
 * Each case is a hidden scenario's aggregate model, a difference between groups that the aggregate
 * averages away (two neighbourhoods, two regions, two product lines), and a question the model is
 * for. The key comes from simulating a split version — the same structure copied per group, with
 * the groups' own values, which average to the aggregate's — against the aggregate: the split is
 * needed when it moves the answer to the question by at least 25%, and the aggregate is good
 * enough when it moves it by at most 10% (checked in the unit tests). The same split appears with
 * two questions, or two splits with the same question, so whether to split depends on what the
 * model is for and on which difference it is, never on the setting alone.
 */

import { caseHeldOut, laterBatch } from '../../utilities/heldOut.js';
import { scenarios } from '../../utilities/scenarios/library.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { splitModel } from './split.js';
import { splitFor, MEASURES } from './generate.js';

const at = (time) => (series, times) => series[times.findIndex((t) => t >= time - 1e-9)];
const peak = (series) => Math.max(...series);
const final = (series) => series[series.length - 1];
const overshoot = (series) => Math.max(...series) - series[series.length - 1];

const bike = scenarios.bikeShare.model;
const dialysis = scenarios.dialysisClinic.model;
const distributor = scenarios.distributor.model;

const bikeSplit = (contactNorth, contactSouth, membersNorth, membersSouth) => splitModel(bike, ['North', 'South'],
    { North: { 'Potential Members': 40000 - membersNorth, 'Members': membersNorth, 'contact rate': contactNorth }, South: { 'Potential Members': 10000 - membersSouth, 'Members': membersSouth, 'contact rate': contactSouth } },
    ['advertising effect', 'persuasion'], ['Members']);

const dialysisSplit = splitModel(dialysis, ['East', 'West'],
    { East: { 'base referrals': 33, 'Chairs': 10, 'Waiting List': 20 }, West: { 'base referrals': 3, 'Chairs': 10, 'Waiting List': 20 } },
    ['minimum wait', 'patients per chair', 'give up fraction', 'time to return', 'target wait', 'order adjustment time', 'build delay'], ['Waiting List']);

const line = (delay) => ({ 'delivery delay': delay, 'base demand': 50, 'demand increase': 10, 'Inventory': 200, 'Supply Line': 50 * delay, 'Expected Demand': 50 });
const distributorSplit = splitModel(distributor, ['Fast', 'Slow'], { Fast: line(1), Slow: line(11) },
    ['coverage', 'adjustment time', 'supply line weight', 'expectation time', 'step time'], ['Inventory']);

// Held-out hand cases: both scenarios are held out, so their cases are too (caseHeldOut).
const foodBank = scenarios.foodBank.model;
const foodBranch = (load) => ({ 'Volunteers': 20, 'Potential Volunteers': 105, 'Families Served': 100, 'Families Not Yet Reached': 500, 'agency referrals': 2, 'recruitment fairs': 0.125, 'manageable load': load });
const foodBankSplit = splitModel(foodBank, ['Riverside', 'Hilltop'], { Riverside: foodBranch(8), Hilltop: foodBranch(2) }, [], ['Volunteers']);

const vans = scenarios.deliveryVans.model;
const depot = (miles) => ({ 'Vans': 100, 'Fleet Miles': 9000000, 'parcel demand': 1000000, 'base van budget': 1300000, 'miles per van': miles });
const vansSplit = splitModel(vans, ['Town', 'Country'], { Town: depot(10000), Country: depot(20000) }, [], ['breakdowns', 'Vans']);

const BIKE_TWO_PLACES = 'The city is really two neighbourhoods: North, with about 40,000 people who could join, and South, with about 10,000. People only talk about the scheme with others in their own neighbourhood.';
const DIALYSIS_REGIONS = 'Our network is really two regions, East and West, 300 km apart, each with its own clinic of 10 chairs, and patients cannot travel between them. East gets about 33 of the 36 referrals a month and West about 3; the 40 patients waiting at the start were split evenly. Each clinic orders its own chairs, from its own waiting list, by the same rule.';
const DISTRIBUTOR_LINES = 'We actually stock two product lines, each half of our demand (50 cases a week, stepping up to 60), ordered by the same rules. One line\'s supplier delivers in about a week; the other\'s takes about eleven weeks — six on average, as in the model.';
const FOOD_BANK_BRANCHES = 'We actually run two branches, Riverside and Hilltop. Each started with about 20 of the volunteers and 100 of the families, gets half of the agency referrals and half of the fair stalls, and draws on its own half of the town for new volunteers and new families. At Riverside families collect pre-packed boxes from the hall, so a volunteer can comfortably look after about 8 families; Hilltop delivers to people who cannot leave home, so a volunteer there can only manage about 2 — 5 on average, as in the model. Volunteers stay with their own branch.';
const VAN_DEPOTS = 'Our fleet is really two depots of 100 vans each, Town and Country, each with half the parcels and half the money for vans and repairs, and each buying and retiring its own vans by the same rules. Town vans do short rounds of about 10,000 miles a year; Country vans cover about 20,000 — 15,000 on average, as in the model. Ten years ago the vans at both depots had about 90,000 miles on them on average.';

export const handCases = {
    'Bike share, chatty and quiet neighbourhoods': {
        scenario: 'bikeShare', aggregate: bike, split: bikeSplit(12, 2, 100, 0), stock: 'Members', groups: 'North and South',
        heterogeneity: `${BIKE_TWO_PLACES} All 100 of our launch members live in North. North's riders talk about it with about 12 people a month, South's with about 2 — about the 10 in the model, on average.`,
        question: 'how many members we will have at month 18', measure: at(18)
    },
    'Bike share, two neighbourhoods alike': {
        scenario: 'bikeShare', aggregate: bike, split: bikeSplit(10, 10, 80, 20), stock: 'Members', groups: 'North and South',
        heterogeneity: `${BIKE_TWO_PLACES} Our 100 launch members were spread across the two in proportion — about 80 in North and 20 in South — and riders in both talk about it with about 10 people a month, as in the model.`,
        question: 'how many members we will have at month 18', measure: at(18)
    },
    'Dialysis regions, peak': {
        scenario: 'dialysisClinic', aggregate: dialysis, split: dialysisSplit, stock: 'Waiting List', groups: 'East and West',
        heterogeneity: DIALYSIS_REGIONS,
        question: 'how high the waiting list (both regions together) will peak', measure: peak
    },
    'Dialysis regions, long run': {
        scenario: 'dialysisClinic', aggregate: dialysis, split: dialysisSplit, stock: 'Waiting List', groups: 'East and West',
        heterogeneity: DIALYSIS_REGIONS,
        question: 'how long the waiting list (both regions together) will be at the end of the four years, once things have settled', measure: final
    },
    'Distributor lines, overshoot': {
        scenario: 'distributor', aggregate: distributor, split: distributorSplit, stock: 'Inventory', groups: 'the two product lines',
        heterogeneity: DISTRIBUTOR_LINES,
        question: 'how far our total inventory overshoots the level it finally settles at after the step up in demand', measure: overshoot
    },
    'Distributor lines, settled level': {
        scenario: 'distributor', aggregate: distributor, split: distributorSplit, stock: 'Inventory', groups: 'the two product lines',
        heterogeneity: DISTRIBUTOR_LINES,
        question: 'the level our total inventory finally settles at after the step up in demand', measure: final
    },
    'Food bank branches, volunteers at the end': {
        scenario: 'foodBank', aggregate: foodBank, split: foodBankSplit, stock: 'Volunteers', groups: 'the two branches',
        heterogeneity: FOOD_BANK_BRANCHES,
        question: 'how many volunteers we will have (both branches together) at the end of the third year', measure: at(36)
    },
    'Food bank branches, volunteer peak': {
        scenario: 'foodBank', aggregate: foodBank, split: foodBankSplit, stock: 'Volunteers', groups: 'the two branches',
        heterogeneity: FOOD_BANK_BRANCHES,
        question: 'how high the volunteer team (both branches together) will peak over the three years', measure: peak
    },
    'Delivery depots, breakdown peak': {
        scenario: 'deliveryVans', aggregate: vans, split: vansSplit, stock: 'breakdowns', groups: 'the two depots',
        heterogeneity: VAN_DEPOTS,
        question: 'how high breakdowns a year (both depots together) will climb over the ten years', measure: peak
    },
    'Delivery depots, fleet size': {
        scenario: 'deliveryVans', aggregate: vans, split: vansSplit, stock: 'Vans', groups: 'the two depots',
        heterogeneity: VAN_DEPOTS,
        question: 'how many vans we will be running (both depots together) at the end of the ten years', measure: final
    }
};

/**
 * Every case: the hand-written ones for the dev scenarios, and those the general rule in generate.js
 * gives every other scenario (frozen in generated.json), with their split models rebuilt here.
 */
const GENERATED = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'generated.json'), 'utf8'));
// Entries for a scenario that is not registered (a stale file) are skipped rather than crashing.
export const generatedCases = Object.fromEntries(Object.entries(GENERATED).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => {
    const s = scenarios[g.scenario];
    return [name, { ...g, aggregate: s.model, split: splitFor(s, g.input, g.amounts, g.shares ?? [0.9, 0.1]), stock: s.goal.variable, groups: 'North and South', measure: MEASURES[g.kind](s) }];
}));
/**
 * The cases the category takes: every first-batch one; a later-batch case only while no verdict
 * makes up more than half of the held-out cases with it added, so a constant verdict cannot pass
 * most of them (the contract test "no null agent does better on the held-out tests than the dev
 * ones, nor passes half of them").
 */
const admitted = function(all) {
    const out = Object.fromEntries(Object.entries(all).filter(([, c]) => !laterBatch(c)));
    for (const [name, c] of Object.entries(all).filter(([, x]) => laterBatch(x))) {
        const held = [...Object.values(out).filter(caseHeldOut), c];
        if (held.filter((x) => x.verdict === c.verdict).length * 2 <= held.length) out[name] = c;
    }
    return out;
};

export const cases = admitted({ ...handCases, ...generatedCases });
