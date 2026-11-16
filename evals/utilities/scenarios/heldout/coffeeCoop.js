/**
 * Held-out hidden scenario: a coffee-growing cooperative whose harvest grows and then falls away.
 *
 * Harvest income pays for new planting, so planted area grows on its own earnings; cropping wears
 * the soil down faster the more hectares are cropped, and worn soil comes back only slowly; yield
 * per hectare falls with the soil, so the harvest climbs, peaks and falls well below where it
 * started while planted area keeps growing. The fields are documented in ../library.js.
 *
 * @module utilities/scenarios/heldout/coffeeCoop
 */

const S = (name, equation, inflows, outflows, units) => ({ name, type: 'stock', equation: String(equation), inflows, outflows, units });
const F = (name, equation, units) => ({ name, type: 'flow', equation, units });
const A = (name, equation, units) => ({ name, type: 'variable', equation: String(equation), units });

export const coffeeCoop = {
    id: 'coffeeCoop',
    title: 'Coffee-growing cooperative',
    opening: "Our coffee cooperative's harvest grew for years and then fell away, even though we kept planting, and I want to understand why.",
    history: 'Fifteen years ago we had about 300 hectares planted and harvested about 325 tonnes of coffee a year. Planted area has grown every year since, to about 2,000 hectares now. The harvest climbed for roughly the first five years, to a peak of a little over 600 tonnes, then turned down and has kept falling; this year it was about 250 tonnes. The soil test scores from the agronomy office have fallen every year, from about 95 out of 100 to about 32.',
    timeUnits: 'years',
    model: {
        variables: [
            S('Planted Area', 300, ['planting'], [], 'hectares'),
            S('Soil Fertility', 95, ['recovery'], ['depletion'], 'points'),
            F('planting', 'harvest * coffee_price * reinvestment_share / cost_per_new_hectare', 'hectares/year'),
            F('depletion', 'Planted_Area * Soil_Fertility * depletion_per_hectare', 'points/year'),
            F('recovery', '(healthy_soil_score - Soil_Fertility) / soil_recovery_time', 'points/year'),
            A('harvest', 'Planted_Area * yield_per_hectare', 'tonnes/year'),
            A('yield per hectare', 'best_yield * fertility_effect * labor_effect', 'tonnes/(hectare*year)'),
            A('fertility effect', '(Soil_Fertility / healthy_soil_score) ^ fertility_sensitivity', 'dimensionless'),
            A('hectares per family', 'Planted_Area / member_families', 'hectares/family'),
            A('labor effect', '1 / (1 + (hectares_per_family / hectares_a_family_can_tend) ^ labor_sensitivity)', 'dimensionless'),
            A('best yield', 1.2, 'tonnes/(hectare*year)'),
            A('coffee price', 3000, 'dollars/tonne'),
            A('reinvestment share', 0.5, 'dimensionless'),
            A('cost per new hectare', 6000, 'dollars/hectare'),
            A('depletion per hectare', 0.0001, '1/(hectare*year)'),
            A('healthy soil score', 100, 'points'),
            A('soil recovery time', 15, 'years'),
            A('fertility sensitivity', 2, 'dimensionless'),
            A('member families', 600, 'families'),
            A('hectares a family can tend', 10, 'hectares/family'),
            A('labor sensitivity', 4, 'dimensionless')
        ],
        relationships: [],
        specs: { startTime: 0, stopTime: 15, dt: 0.0625, timeUnits: 'years' }
    },
    narrative: `I manage a coffee-growing cooperative and I'm trying to make sense of the last fifteen years. When we started we had about 300 hectares planted and harvested about 325 tonnes of coffee a year. Every year we put part of what the harvest earns into planting new hectares, so planted area has grown every single year — we're at about 2,000 hectares now. For roughly the first five years the harvest climbed, to a peak of a little over 600 tonnes, but then it turned down and it has kept falling even though we kept planting; this year we harvested only about 250 tonnes, less than when we started. Yields per hectare have dropped the whole time, and the soil test scores from our agronomy office have fallen every year, from about 95 out of 100 at the start to about 32 now. Separately, the price of the jute sacks we ship in has gone up every year.`,
    keyVariables: [
        { model: 'harvest', glossary: 'harvest', narrativeShape: 'rises then falls' },
        { model: 'Soil Fertility', glossary: 'soil fertility', narrativeShape: 'falling' },
        { model: 'Planted Area', glossary: 'planted area', narrativeShape: 'rising' }
    ],
    distractorTrends: [{ glossary: 'jute sack price', narrativeShape: 'rising' }],
    glossary: ['planted area', 'planting', 'harvest', 'yield per hectare', 'soil fertility', 'soil depletion', 'soil recovery', 'hectares per family'],
    glossaryToModel: { 'planted area': 'Planted Area', 'planting': 'planting', 'harvest': 'harvest', 'yield per hectare': 'yield per hectare', 'soil fertility': 'Soil Fertility', 'soil depletion': 'depletion', 'soil recovery': 'recovery', 'hectares per family': 'hectares per family' },
    mechanisms: [
        { id: 'reinvestment', topic: 'how the cooperative pays for planting new hectares', verdict: 'matters', fact: 'We pay for new planting out of harvest income: the more we harvest, the more new hectares we plant the next year.', off: { 'reinvestment share': '0' }, signature: { from: 'harvest', to: 'planting', polarity: '+' } },
        { id: 'soil wear', topic: 'what cropping does to the soil', verdict: 'matters', fact: 'The way we crop — dense planting, no shade, a crop every year — wears the soil down, and the more hectares we crop the faster it goes.', off: { 'depletion per hectare': '0' }, signature: { from: 'planted area', to: 'soil depletion', polarity: '+' } },
        { id: 'yield and soil', topic: 'what decides how much coffee each hectare yields', verdict: 'matters', fact: 'Worn-out soil gives less coffee per hectare.', off: { 'fertility sensitivity': '0' }, signature: { from: 'soil fertility', to: 'yield per hectare', polarity: '+' } },
        { id: 'soil recovery', topic: 'whether worn-out soil comes back, and how fast', verdict: 'matters', fact: 'Worn soil does come back on its own, but slowly — over something like fifteen years.', off: { 'soil recovery time': '1e9' } },
        { id: 'stretched families', topic: 'how many hectares the member families can look after', verdict: 'irrelevant', fact: 'Each member family can only look after so many hectares well; spread too thin, they cannot prune and pick properly and yields suffer.', off: { 'hectares a family can tend': '1e9' } }
    ],
    goal: { variable: 'harvest', measure: 'atTime', time: 15, threshold: 300, direction: 'above', label: 'be harvesting at least 300 tonnes a year in year 15' },
    policies: [
        { id: 'plant faster', text: 'Put 70% of the harvest income into new planting instead of half.', overrides: { 'reinvestment share': '0.7' }, effective: false },
        { id: 'more pickers', text: 'Pay for extra pickers so each family can look after 20 hectares well instead of 10.', overrides: { 'hectares a family can tend': '20' }, effective: false },
        { id: 'rebuild the soil', text: 'Plant cover crops, compost the coffee pulp and rest worn plots, so worn soil comes back in about 5 years instead of 15.', overrides: { 'soil recovery time': '5' }, effective: true },
        { id: 'plant more slowly', text: 'Put only a quarter of the harvest income into new planting instead of half.', overrides: { 'reinvestment share': '0.25' }, effective: true },
        { id: 'rebuild the soil and plant faster', text: 'Do both: rebuild the soil with cover crops, compost and rest, and put 70% of the harvest income into new planting.', overrides: { 'soil recovery time': '5', 'reinvestment share': '0.7' }, effective: true, parts: ['rebuild the soil', 'plant faster'] }
    ],
    misconception: 'plant faster',
    protected: { variables: ['coffee price', 'member families'], label: 'the price buyers pay for our coffee (about $3,000 a tonne) and our 600 member families' },
    levers: ['reinvestment share', 'soil recovery time', 'depletion per hectare', 'hectares a family can tend'],
    realistic: {
        text: 'What is realistic for us: cover crops, composting and resting plots could bring worn soil back in as little as 5 years instead of 15; we could put anywhere from a quarter to 70% of the harvest income into new planting (half now); paying for extra pickers could at most double the hectares a family can look after well, from 10 to 20; and shade trees and wider spacing could cut how fast cropping wears the soil by at most a third.',
        bounds: { 'soil recovery time': { min: 5, max: 15 }, 'reinvestment share': { min: 0.25, max: 0.7 }, 'hectares a family can tend': { min: 10, max: 20 }, 'depletion per hectare': { min: 0.000067, max: 0.0001 } }
    },
    parameterFacts: [
        { id: 'planting money', topic: 'how much of the harvest income goes into new planting, and what planting costs', text: 'We put about half of the harvest income into planting new hectares. We get about $3,000 a tonne for our coffee, and planting a new hectare costs about $6,000.' },
        { id: 'yield on healthy and worn soil', topic: 'how much a hectare yields and how that depends on the soil', text: 'On healthy soil a hectare gives about 1.2 tonnes a year. Yield drops faster than the soil score: soil at half its healthy score gives only about a quarter of the healthy yield.' },
        { id: 'soil wear and recovery', topic: 'how fast cropping wears the soil and how fast it recovers', text: 'Our agronomist reckons each year, every 100 hectares we crop wears away about 1% of the soil fertility that is left, and worn soil recovers toward a healthy score of 100 over about fifteen years.' },
        { id: 'families', topic: 'how many member families there are and how many hectares each can look after', text: 'We have 600 member families. With the pickers they hire at harvest, a family can look after about 5 hectares with very little loss of yield; at 10 hectares per family yields would be down by about half.' }
    ],
    perspectives: [
        { id: 'agronomist', who: 'Ana, our agronomist', account: 'The harvest fell because we have worn out the soil. The more hectares we cropped, the faster the soil wore down, worn soil gives less coffee per hectare, and it takes years to come back.', mechanism: 'yield and soil', signature: { from: 'soil fertility', to: 'yield per hectare', polarity: '+' }, variant: { 'hectares a family can tend': '1e9' } },
        { id: 'field coordinator', who: 'Luis, our field coordinator', account: "The soil scores are down, sure, but coffee bears fine on tired soil. What cut the harvest is that we planted far more than our families can look after: each family now has more hectares than it can prune and pick properly, so the coffee is left on the bushes.", mechanism: 'stretched families', signature: { from: 'hectares per family', to: 'yield per hectare', polarity: '-' }, variant: { 'fertility sensitivity': '0', 'hectares a family can tend': '1.75', 'labor sensitivity': '3', 'best yield': '1.1' } }
    ],
    experiments: [
        { id: 'soil trial', text: "Test what the soil is doing to yields: compare yields on rested or composted plots with plots cropped as usual, or start cover crops and composting to rebuild the soil, and watch the yields.", overrides: { 'soil recovery time': '*0.33' }, discriminates: true },
        { id: 'picker trial', text: 'Find out or change how stretched the families are: compare yields of families with few and with many hectares each, or pay for extra pickers so each family can look after more, and watch the yields.', overrides: { 'hectares a family can tend': '*2' }, discriminates: true },
        { id: 'new sack labels', text: "Redesign the cooperative's sack labels and see whether buyers notice.", overrides: {}, discriminates: false }
    ],
    outsideFacts: [{ text: 'Our office switched to new accounting software two years ago.', topic: "the cooperative's office systems" }, { text: 'The regional coffee board redesigned its quality certificates last year.', topic: "the coffee board's paperwork" }],
    loops: [
        { id: 'reinvestment', polarity: '+', variables: ['planted area', 'harvest', 'planting'], core: ['planted area', 'harvest'], mechanism: 'reinvestment' },
        { id: 'soil wear', polarity: '-', variables: ['planted area', 'soil depletion', 'soil fertility', 'yield per hectare', 'harvest', 'planting'], core: ['planted area', 'soil fertility'], mechanism: 'soil wear' }
    ]
};
