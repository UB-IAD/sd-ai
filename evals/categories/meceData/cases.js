/**
 * Cases for the mece category.
 *
 * Each case is a correct model and a version with a MECE (mutually exclusive, collectively
 * exhaustive) error planted in one variable: two quantities that overlap counted as if they did not
 * (double counting), or a total that leaves a part out (a gap). Unlike a style problem these change
 * what the model computes, which is how a fix is checked: the agent's version of the planted
 * variable, put back into the correct model, must make it behave like the correct model again.
 */

import { cases as equilibrium } from '../equilibriumData/models.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scenarios } from '../../utilities/scenarios/library.js';
import { correctModel } from '../guidedCorrectionData/generate.js';
import { plantAll } from './hard.js';

const add = (model, variables) => { const m = structuredClone(model); m.variables.push(...variables); return m; };
const set = (model, name, fields) => { const m = structuredClone(model); Object.assign(m.variables.find((v) => v.name === name), fields); return m; };

const projectBase = add(set(equilibrium['Project Backlog and Staff'].model, 'completing', { equation: 'Staff * productivity' }), [
    { name: 'nurses', type: 'variable', equation: 'Staff * nurse_share', units: 'people', documentation: 'The part of the staff who are nurses.' },
    { name: 'nurse share', type: 'variable', equation: '0.6', units: 'dimensionless' }
]);

const inventoryBase = equilibrium['Inventory and Workforce'].model;

// Held-out cases, each on one of the held-out equilibrium models, extended where the error needs a
// total or a breakdown to live in.
const libraryBase = add(set(equilibrium['Library Book Loans'].model, 'Books on Shelves', { inflows: ['returning', 'buying books'] }), [
    { name: 'buying books', type: 'flow', equation: '(target_collection - collection_size) / purchasing_time', units: 'books/week', documentation: 'New books bought to keep the collection at its target size.' },
    { name: 'collection size', type: 'variable', equation: 'Books_on_Shelves + Books_on_Loan', units: 'books', documentation: 'Every book the library owns.' },
    { name: 'target collection', type: 'variable', equation: '12000', units: 'books' },
    { name: 'purchasing time', type: 'variable', equation: '4', units: 'weeks' }
]);

const gymBase = add(equilibrium['Gym Members and Trainers'].model, [
    { name: 'personal training clients', type: 'variable', equation: 'Members * personal_training_share', units: 'members', documentation: 'The members who also pay for personal training sessions.' },
    { name: 'personal training share', type: 'variable', equation: '0.3', units: 'dimensionless' }
]);

const roadsBase = add(set(equilibrium['City Road Repairs'].model, 'wearing out', { equation: 'Good_Roads / road_surface_life * traffic_load' }), [
    { name: 'network length', type: 'variable', equation: 'Good_Roads + Worn_Roads', units: 'km', documentation: 'The length of every road in the city.' },
    { name: 'city traffic', type: 'variable', equation: '600000', units: 'vehicle_km/day' },
    { name: 'traffic per km', type: 'variable', equation: 'city_traffic / network_length', units: 'vehicle_km/km/day' },
    { name: 'design traffic per km', type: 'variable', equation: '1000', units: 'vehicle_km/km/day' },
    { name: 'traffic load', type: 'variable', equation: 'traffic_per_km / design_traffic_per_km', units: 'dimensionless', documentation: 'How hard the roads are used relative to what they are built for; heavier use wears them out faster.' }
]);

const waterBase = add(set(equilibrium['Water Utility'].model, 'customer demand', { equation: 'household_demand + business_demand' }), [
    { name: 'household demand', type: 'variable', equation: '20', units: 'megaliters/day' },
    { name: 'business demand', type: 'variable', equation: '10', units: 'megaliters/day', documentation: 'Water used by every business customer: shops, offices, restaurants and factories.' },
    { name: 'restaurant demand', type: 'variable', equation: 'business_demand * restaurant_share', units: 'megaliters/day', documentation: 'The part of business demand that comes from restaurants, reported separately for the health department.' },
    { name: 'restaurant share', type: 'variable', equation: '0.3', units: 'dimensionless' }
]);

const hotelBase = add(set(set(equilibrium['Hotel Bookings'].model, 'booking', { equation: 'booking_requests * ready_rooms / total_rooms' }), 'cleaning time', { equation: '1' }), [
    { name: 'total rooms', type: 'variable', equation: '200', units: 'rooms' },
    { name: 'rooms out of service', type: 'variable', equation: 'Occupied_Rooms + Rooms_Awaiting_Cleaning', units: 'rooms', documentation: 'Rooms that cannot be offered right now.' },
    { name: 'ready rooms', type: 'variable', equation: 'total_rooms - rooms_out_of_service', units: 'rooms', documentation: 'Clean, empty rooms; the more of them there are, the more booking requests the hotel accepts.' }
]);

const recyclingBase = equilibrium['Packaging Recycling'].model;

export const handCases = {
    "Project Backlog and Staff": {
        description: 'a project office whose staffing follows its backlog; some of the staff are nurses',
        correct: projectBase,
        plant: { variable: 'completing', change: { equation: '(Staff + nurses) * productivity' } },
        kind: 'overlap',
        text: 'Projects are completed by "Staff" plus "nurses", but the nurses are already part of the staff, so they are counted twice.',
        distractors: ['"Backlog" and "Completed Projects" overlap and one should be removed.', '"productivity" should be split into separate rates for every kind of project.']
    },
    "Endemic Infection": {
        description: 'an infection that persists in a population with births and deaths',
        correct: equilibrium['Endemic Infection'].model,
        plant: { variable: 'total population', change: { equation: 'Susceptible + Infected' } },
        kind: 'gap',
        text: '"total population" adds up only the susceptible and infected people and leaves out the recovered, so it is not the whole population.',
        distractors: ['"Susceptible" and "Infected" overlap, since infected people are also susceptible.', '"death rate" should be split into separate rates for each stock.']
    },
    "Inventory and Workforce": {
        description: 'a factory that sets its workforce from expected demand and its inventory gap',
        correct: inventoryBase,
        plant: { variable: 'Inventory', change: { outflows: ['shipping', 'customer deliveries'] }, adds: [{ name: 'customer deliveries', type: 'flow', equation: 'demand', units: 'widgets/month', documentation: 'Goods delivered to customers.' }] },
        kind: 'overlap',
        text: 'Inventory is drained twice for the same customer demand: by "shipping" and again by "customer deliveries".',
        distractors: ['"Workers" and "desired workers" overlap and one should be removed.', '"Expected Demand" should not be a stock.']
    },
    "Library Collection": {
        heldOut: true,
        description: 'a lending library that buys new books to keep its collection at a target size',
        correct: libraryBase,
        plant: { variable: 'collection size', change: { equation: 'Books_on_Shelves' } },
        kind: 'gap',
        text: '"collection size" counts only the books on the shelves and leaves out the books on loan, so the library keeps buying books to replace ones that are only borrowed.',
        distractors: ['"Books on Shelves" and "Books on Loan" overlap, because a book on loan is still counted on the shelves.', '"lending" and "returning" both move the same books, so one of the two flows is counted twice.']
    },
    "Gym Crowding": {
        heldOut: true,
        description: 'a gym whose members drift away when the floor gets crowded and which hires trainers to match its membership; some members also take personal training',
        correct: gymBase,
        plant: { variable: 'members per trainer', change: { equation: '(Members + personal_training_clients) / Trainers' } },
        kind: 'overlap',
        text: '"members per trainer" adds "personal training clients" to "Members", but personal training clients are already members, so they are counted twice and the gym looks more crowded than it is.',
        distractors: ['"desired trainers" leaves out the personal training clients, so the gym hires too few trainers.', '"joining" and "sign ups" overlap, so new members are counted twice.']
    },
    "Road Network Traffic": {
        heldOut: true,
        description: "a city's roads wearing out faster under heavier traffic and being resurfaced by crews it sizes to the repair backlog",
        correct: roadsBase,
        plant: { variable: 'network length', change: { equation: 'Good_Roads' } },
        kind: 'gap',
        text: '"network length" counts only the good roads and leaves out the worn roads, so the traffic is spread over too few kilometres and the roads seem to wear out faster as more of them wear.',
        distractors: ['"Good Roads" and "Worn Roads" overlap, because a worn road is still counted as a good road until it is resurfaced.', '"desired crews" leaves out the good roads, which also need crews.']
    },
    "Water Customers": {
        heldOut: true,
        description: 'a water utility that pumps and treats river water and supplies households and businesses, with restaurant use reported separately',
        correct: waterBase,
        plant: { variable: 'customer demand', change: { equation: 'household_demand + business_demand + restaurant_demand' } },
        kind: 'overlap',
        text: '"customer demand" adds "restaurant demand" to "business demand", but restaurants are businesses and their water is already in business demand, so it is counted twice.',
        distractors: ['"customer demand" leaves out the water lost to "leakage", which customers also pay for.', '"Raw Water Storage" and "Treated Water Storage" overlap, since treated water is still raw water.']
    },
    "Hotel Ready Rooms": {
        heldOut: true,
        description: 'a hotel whose rooms pass from reservations to guests to housekeeping, and which accepts fewer bookings when few rooms are ready',
        correct: hotelBase,
        plant: { variable: 'rooms out of service', change: { equation: 'Occupied_Rooms' } },
        kind: 'gap',
        text: '"rooms out of service" counts only occupied rooms and leaves out the rooms awaiting cleaning, so the hotel thinks it has more ready rooms than it does.',
        distractors: ['"Occupied Rooms" and "Rooms Awaiting Cleaning" overlap, because a room awaiting cleaning is still counted as occupied.', '"cancelling" and "checking in" both drain "Reservations", so the same reservation leaves twice.']
    },
    "Packaging Landfill": {
        heldOut: true,
        description: "a town's packaging that is used, thrown into bins, and either landfilled or recycled into new packaging, topped up with new material",
        correct: recyclingBase,
        plant: { variable: 'landfilling', change: { equation: 'Waste_in_Bins / collection_interval' } },
        kind: 'overlap',
        text: '"landfilling" takes all the waste in the bins, including the share that "recycling collection" already takes, so the recycled share leaves the bins twice.',
        distractors: ['"making from new material" and "making from recycled material" overlap, so packaging is made twice.', '"Packaging in Use" leaves out the packaging sitting in the bins, which is still in use.']
    }
};

const GENERATED = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'generated.json'), 'utf8'));
/**
 * Cases made by the general rule in generate.js for every scenario in the library (see
 * buildGenerated.js), on the scenario's glossary model. Entries for a scenario that is not
 * registered (a stale file) are skipped.
 */
export const generatedCases = Object.fromEntries(Object.entries(GENERATED).filter(([, g]) => scenarios[g.scenario]).map(([name, g]) => [name, { ...g, correct: correctModel(scenarios[g.scenario]) }]));

export const cases = { ...handCases, ...generatedCases };

/** The model with the case's MECE error planted. */
export const plantedModel = function(c) {
    const m = structuredClone(c.correct);
    Object.assign(m.variables.find((v) => v.name === c.plant.variable), structuredClone(c.plant.change));
    if (c.plant.adds) m.variables.push(...structuredClone(c.plant.adds));
    return m;
};

const HARD = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'hard.json'), 'utf8'));
/**
 * The hard cases made by the rule in hard.js (see buildGenerated.js): several MECE errors of
 * different kinds at once, in a scenario's full model or a hand case's correct model.
 */
export const hardCases = Object.fromEntries(Object.entries(HARD).filter(([, g]) => (g.scenario ? scenarios[g.scenario] : handCases[g.handCase])).map(([name, g]) => [name, { ...g, correct: g.scenario ? correctModel(scenarios[g.scenario]) : structuredClone(handCases[g.handCase].correct) }]));

/** The model with every plant of a hard case applied. */
export const plantedHardModel = (c) => plantAll(c.correct, c.plants);
