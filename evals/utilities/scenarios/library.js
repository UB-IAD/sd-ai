/**
 * Hidden scenarios for the conversation evals.
 *
 * A scenario is a small working simulation of an ordinary situation that the agent never sees,
 * together with what a user would say about it:
 *   - `model`: the hidden sd-json model. Its run is the truth every answer key comes from.
 *   - `narrative`: what the user has observed, in plain words with no modeling vocabulary.
 *   - `keyVariables`: the quantities whose behavior over time the problem is about, each with the
 *     glossary name the agent is asked to use and the shape the narrative describes
 *     (`narrativeShape`); the scenario kit checks that shape against the hidden run.
 *   - `distractorTrends`: things the user mentions that change over time but have nothing to do
 *     with the problem.
 *   - `mechanisms`: the causal facts of the situation, each a sentence a manager would say and an
 *     `off` switch (equation overrides) that removes it from the hidden model. Ablation — running
 *     with one mechanism off — says whether it matters to the behavior; its `verdict` ('matters',
 *     'irrelevant' or 'ambiguous') is written here so tests can be generated without simulating,
 *     and the unit tests re-derive every verdict with scenarioKit.computeKey.
 *   - `loops`: the feedback loops that produce the problem behavior, in glossary names, with the
 *     mechanism whose removal breaks them and the `core` variables a diagram's version of the loop
 *     must keep (without them a stock's own drain loop would pass for the mechanism). A dynamic
 *     hypothesis has to contain these.
 *   - `glossary`: the names the agent is asked to use, so its diagrams can be read without guessing.
 *   - `glossaryToModel`: for each glossary name that is a variable of the hidden model, that
 *     variable's name there (used to build reference answers in the unit tests).
 *   - `outsideFacts`: true statements a user might offer that lie outside the system altogether
 *     (not in the hidden model at all), so they are irrelevant by construction; each `{text, topic}`.
 *   - `opening`: the user's one-line complaint, for conversations that start from almost nothing.
 *   - `history`: what the user has observed over time, without any mechanism — what a scripted user
 *     says when asked what has happened.
 *   - a mechanism's `topic`: what a question has to be about for a scripted user to give its fact.
 *   - `goal`: a target for the key behavior ({variable, measure: 'max' | 'atTime' | 'overshoot',
 *     time?, threshold, direction: 'below' | 'above', label}; 'overshoot' is the peak's height above
 *     the level the run ends at, so changing the target moves the reference with it), and `policies`
 *     that might meet it, each with
 *     the equation overrides that enact it and `effective` (whether it meets the goal in the hidden
 *     simulation — written here, re-derived in the unit tests); a combination lists its `parts`.
 *     Effective single policies never set the same lever to different values (the coaching tests
 *     apply every working policy together), and where a combination exists, some ineffective policy
 *     sets one of its levers differently and stays ineffective at its realistic limit (so
 *     recommending every option is contradictory advice).
 *     `misconception` names the policy a
 *     novice wrongly believes will work.
 *   - `parameterFacts`: the numbers behind the mechanisms, in a manager's words ({id, topic, text}),
 *     so a scripted user can give an agent everything it needs to rebuild the hidden system.
 *   - `protected`: the quantities outside management's control ({variables in glossary names, label}),
 *     which a policy may not change — including the behavior of the people the organization serves
 *     (patients giving up, riders' contact rate, what customers are shipped); `limits` (optional):
 *     physical limits on a flow that hold however a policy is formulated ({flow, uses, ceiling,
 *     label}); `levers`: the glossary-named variables management does
 *     control, the only original variables a policy may change directly; `realistic`: what the
 *     organization could actually do, in a manager's words (`text`), and the same limits as
 *     `bounds` on those levers ({min?, max?}, in glossary names), so a goal is never met by pushing
 *     a lever further than the organization could go.
 *   - `perspectives`: two stakeholders' conflicting accounts, each backing one mechanism, each with
 *     a `variant` (equation overrides) under which the hidden model works only the way that
 *     stakeholder says — re-tuned so that it still reproduces the narrated history, since a view the
 *     history already refutes is not a live alternative — and a `signature` (the causal path any diagram including that account must
 *     contain). `experiments` are things the organization could try, each with overrides
 *     (a value written '*k' multiplies that parameter's value in the variant, so an experiment acts
 *     on the lever as it stands in each account). An experiment `discriminates` when its effect on
 *     the goal measure differs between the two variants by at least 25 points — written here,
 *     re-derived in the unit tests.
 *   - a mechanism's `signature`, where it has one: a causal path, in glossary names, that any model
 *     including the mechanism must contain ({from, to, polarity}). The path may not pass through a
 *     stock unless `throughStocks` says so — an effect that only arrives by way of an accumulation
 *     (potential members → sign-ups → members → word of mouth) is not the mechanism itself.
 *
 * Scenarios are written out by hand rather than generated: few enough to read and check, each
 * built on a structure system dynamics practitioners would recognize.
 *
 * @module utilities/scenarios/library
 */

import { coffeeCoop } from './heldout/coffeeCoop.js';
import { kitchenFitters } from './heldout/kitchenFitters.js';
import { mushroomGrowers } from './heldout/mushroomGrowers.js';
import { ambulanceService } from './heldout/ambulanceService.js';
import { deliveryVans } from './heldout/deliveryVans.js';
import { foodBank } from './heldout/foodBank.js';
import { electricianTraining } from './heldout/electricianTraining.js';
import { cleaningStandards } from './heldout/cleaningStandards.js';
import { valleyWater } from './heldout/valleyWater.js';

const S = (name, equation, inflows, outflows, units) => ({ name, type: 'stock', equation: String(equation), inflows, outflows, units });
const F = (name, equation, units) => ({ name, type: 'flow', equation, units });
const A = (name, equation, units) => ({ name, type: 'variable', equation: String(equation), units });

export const scenarios = {
    dialysisClinic: {
        id: 'dialysisClinic',
        title: 'Rural dialysis network',
        opening: 'The waiting list for dialysis in our rural network has been on a rollercoaster for the last four years, and I want to understand why.',
        history: 'Four years ago about 40 patients were waiting and we had 20 chairs. Referrals come in at a steady rate, about 36 a month. Over the first year the waiting list climbed to around 100; by the end of the second year it had come back down, and it has sat at about 35 since. We have about 42 chairs now.',
        timeUnits: 'months',
        model: {
            variables: [
                S('Waiting List', 40, ['referrals', 'returning'], ['starting treatment', 'giving up'], 'patients'),
                S('Chairs', 20, ['chairs arriving'], [], 'chairs'),
                S('Chairs on Order', 0, ['ordering chairs'], ['chairs arriving'], 'chairs'),
                S('Discouraged Patients', 0, ['giving up'], ['returning'], 'patients'),
                F('referrals', 'base_referrals', 'patients/month'),
                F('starting treatment', 'MIN(Waiting_List / minimum_wait, Chairs * patients_per_chair)', 'patients/month'),
                F('giving up', 'Waiting_List * give_up_fraction', 'patients/month'),
                F('returning', 'Discouraged_Patients / time_to_return', 'patients/month'),
                F('ordering chairs', 'MAX(0, (desired_chairs - Chairs - Chairs_on_Order) / order_adjustment_time)', 'chairs/month'),
                F('chairs arriving', 'Chairs_on_Order / build_delay', 'chairs/month'),
                A('base referrals', 36, 'patients/month'),
                A('minimum wait', 1, 'months'),
                A('patients per chair', 1.2, 'patients/(chair*month)'),
                A('give up fraction', 0.05, '1/month'),
                A('time to return', 14, 'months'),
                A('target wait', 2, 'months'),
                A('desired chairs', 'Waiting_List / target_wait / patients_per_chair', 'chairs'),
                A('order adjustment time', 3, 'months'),
                A('build delay', 9, 'months')
            ],
            relationships: [],
            specs: { startTime: 0, stopTime: 48, dt: 0.125, timeUnits: 'months' }
        },
        narrative: `I run a rural dialysis network and I'm trying to make sense of the last four years. When I started, about 40 patients were waiting for a dialysis chair and we had 20 chairs. Referrals come in at a pretty steady rate. Over the first year the waiting list climbed hard, to around 100 patients. We put in orders for more chairs as the list grew — we order based on how long the list is — and chairs kept arriving over the following couple of years; we're at about 42 now. By the end of the second year the waiting list had come back down, and it has sat at about 35 ever since. Treatments per month have gone up the whole time as chairs arrived and then levelled off. Separately, complaints about staff parking have gone up every single year.`,
        keyVariables: [
            { model: 'Waiting List', glossary: 'waiting list', narrativeShape: 'rises then falls' },
            { model: 'Chairs', glossary: 'chairs', narrativeShape: 'rising' }
        ],
        distractorTrends: [{ glossary: 'staff parking complaints', narrativeShape: 'rising' }],
        glossary: ['waiting list', 'referrals', 'treatments started', 'chairs', 'chairs on order', 'patients giving up', 'discouraged patients'],
        glossaryToModel: { 'waiting list': 'Waiting List', 'referrals': 'referrals', 'treatments started': 'starting treatment', 'chairs': 'Chairs', 'chairs on order': 'Chairs on Order', 'patients giving up': 'giving up', 'discouraged patients': 'Discouraged Patients' },
        mechanisms: [
            { id: 'capacity expansion', topic: 'how the network adds dialysis capacity (ordering chairs, and how long they take)', verdict: 'matters', fact: 'When the waiting list grows we order more chairs, but new chairs take about nine months to arrive.', off: { 'ordering chairs': '0' }, signature: { from: 'waiting list', to: 'chairs', polarity: '+', throughStocks: true } },
            { id: 'giving up', topic: 'whether people on the waiting list leave it', verdict: 'ambiguous', fact: 'Some people on the waiting list give up and go elsewhere.', off: { 'give up fraction': '0' } },
            { id: 'returning', topic: 'whether people who left the waiting list come back', verdict: 'irrelevant', fact: 'Most people who give up come back to us about a year later.', off: { 'time to return': '1e9' } }
        ],
        goal: { variable: 'Waiting List', measure: 'max', threshold: 80, direction: 'below', label: 'keep the waiting list from ever going above 80 patients' },
        policies: [
            { id: 'more chairs from the start', text: 'Start with 30 chairs instead of 20.', overrides: { 'Chairs': '30' }, effective: true },
            { id: 'faster building', text: 'Get new chairs built and installed in 3 months instead of 9.', overrides: { 'build delay': '3' }, effective: false },
            { id: 'order more aggressively', text: 'Order enough chairs to bring the wait down to three weeks instead of two months.', overrides: { 'target wait': '0.75' }, effective: true },
            { id: 'review orders monthly', text: 'Review chair orders every month instead of every three months.', overrides: { 'order adjustment time': '1' }, effective: false }
        ],
        misconception: 'faster building',
        protected: { variables: ['referrals', 'base referrals', 'patients giving up', 'give up fraction', 'time to return', 'returning'], label: 'the referral rate (about 36 patients a month) and how patients behave on the list' },
        limits: [{ flow: 'treatments started', uses: ['waiting list', 'minimum wait'], ceiling: (v) => v['waiting list'] / v['minimum wait'], label: 'no patient may start treatment sooner than the minimum wait (waiting list / minimum wait)' }],
        levers: ['chairs', 'target wait', 'order adjustment time', 'build delay', 'patients per chair'],
        realistic: {
            text: 'What is realistic for us: we could have started with up to 30 chairs instead of 20; new chairs cannot be built and installed in less than 3 months; we could review chair orders as often as monthly; we could order chairs for a target wait as short as three weeks instead of two months; and longer opening hours could get each chair to start at most 1.5 patients a month instead of 1.2.',
            bounds: { 'chairs': { max: 30 }, 'build delay': { min: 3 }, 'order adjustment time': { min: 1 }, 'target wait': { min: 0.75 }, 'patients per chair': { max: 1.5 } }
        },
        parameterFacts: [
            { id: 'treatment capacity', topic: 'how many patients a chair can treat', text: 'Each chair can start about 1.2 patients a month, and nobody waits less than about a month.' },
            { id: 'ordering rule', topic: 'how the network decides how many chairs to order', text: 'We order enough chairs to bring the wait down to about two months, and we close any shortfall in chairs, counting the ones already on order, over about three months.' },
            { id: 'giving up rate', topic: 'how many people on the waiting list give up', text: 'About 5% of the people on the list give up each month.' }
        ],
        perspectives: [
            { id: 'clinical director', who: 'Dr. Okafor, our clinical director', account: 'The list swung because new chairs take nine months to arrive after we order them, so capacity always arrives long after the need.', mechanism: 'capacity expansion', signature: { from: 'waiting list', to: 'chairs', polarity: '+', throughStocks: true }, variant: { 'time to return': '1e9' } },
            { id: 'patient coordinator', who: 'Sam, our patient coordinator', account: "Chairs are part of it, but that's not what made the big swing. Lots of patients had given up before we started, and they came back in a wave over the first year.", mechanism: 'returning', signature: { from: 'discouraged patients', to: 'waiting list', polarity: '+', throughStocks: true }, variant: { 'give up fraction': '0.12', 'Discouraged Patients': '100', 'time to return': '10' } }
        ],
        experiments: [
            { id: 'follow up leavers', text: 'Track the patients who give up and leave the list — count them, follow them up, check records for whether and when they come back — or change what happens to them.', overrides: { 'time to return': '1e9' }, discriminates: true },
            { id: 'reception hours', text: 'Change the reception desk opening hours and see whether patients notice.', overrides: {}, discriminates: false }
        ],
        outsideFacts: [{ text: 'Our nurses swap their holiday rota every summer.', topic: 'staff holidays' }, { text: 'The regional health board changed its logo last year.', topic: 'the health board\'s branding' }],
        loops: [
            { id: 'capacity expansion', polarity: '-', variables: ['waiting list', 'chairs on order', 'chairs', 'treatments started'], core: ['waiting list', 'chairs'], mechanism: 'capacity expansion' }
        ]
    },
    bikeShare: {
        id: 'bikeShare',
        title: 'City bike-share membership',
        opening: 'Our city bike-share scheme took off and then stalled, and the board wants to understand what happened.',
        history: 'We launched three years ago with about 100 members. Sign-ups were slow for the first year, then took off, peaked partway through the second year and have dropped off sharply since. Membership is now close to 50,000 and has more or less stopped growing.',
        timeUnits: 'months',
        model: {
            variables: [
                S('Potential Members', 49900, [], ['signing up'], 'people'),
                S('Members', 100, ['signing up'], [], 'people'),
                F('signing up', 'Potential_Members * advertising_effect + word_of_mouth', 'people/month'),
                A('advertising effect', 0.0005, '1/month'),
                A('word of mouth', 'contact_rate * Members * Potential_Members / total_population * persuasion', 'people/month'),
                A('total population', 'Potential_Members + Members', 'people'),
                A('contact rate', 10, '1/month'),
                A('persuasion', 0.025, 'dimensionless')
            ],
            relationships: [],
            specs: { startTime: 0, stopTime: 36, dt: 0.0625, timeUnits: 'months' }
        },
        narrative: `I manage our city's bike-share scheme and the board wants an explanation of the first three years. We launched with about 100 members in a city where roughly 50,000 people could realistically sign up. For the first year sign-ups were slow, then they took off — most people say they joined because a friend or colleague who rides talked them into it. New sign-ups per month peaked partway through the second year and have dropped off sharply since; membership has climbed to almost everyone who could join and has more or less stopped growing. We have run the same modest advertising the whole time. Meanwhile, the price of a replacement bike tyre has gone up every year.`,
        keyVariables: [
            { model: 'Members', glossary: 'members', narrativeShape: 'rising' },
            { model: 'signing up', glossary: 'signing up', narrativeShape: 'rises then falls' }
        ],
        distractorTrends: [{ glossary: 'replacement tyre price', narrativeShape: 'rising' }],
        glossary: ['members', 'potential members', 'signing up', 'word of mouth', 'advertising'],
        glossaryToModel: { 'members': 'Members', 'potential members': 'Potential Members', 'signing up': 'signing up', 'word of mouth': 'word of mouth' },
        mechanisms: [
            { id: 'word of mouth', topic: 'why people decide to join (how they hear about the scheme)', verdict: 'matters', fact: 'Most new members join because someone who already rides talks them into it.', off: { 'persuasion': '0' }, signature: { from: 'members', to: 'signing up', polarity: '+' } },
            { id: 'market saturation', topic: 'how many people in the city could ever join', verdict: 'matters', fact: 'There are only so many people in the city who could ever join.', off: { 'signing up': '49900 * advertising_effect + contact_rate * Members * persuasion' }, signature: { from: 'potential members', to: 'word of mouth', polarity: '+' } },
            { id: 'advertising', topic: 'what advertising or promotion the scheme does', verdict: 'matters', fact: 'We run a small, steady advertising campaign.', off: { 'advertising effect': '0' } }
        ],
        goal: { variable: 'Members', measure: 'atTime', time: 18, threshold: 30000, direction: 'above', label: 'reach 30,000 members by month 18' },
        policies: [
            { id: 'double advertising', text: 'Double the advertising budget.', overrides: { 'advertising effect': '0.001' }, effective: false },
            { id: 'triple advertising', text: 'Triple the advertising budget.', overrides: { 'advertising effect': '0.0015' }, effective: false },
            { id: 'referral bonus', text: 'Give members a bonus for every friend who joins, so riders persuade half as many again of the people they talk to.', overrides: { 'persuasion': '0.0375' }, effective: true },
            { id: 'referral bonus and double advertising', text: 'Do both: the referral bonus and double the advertising.', overrides: { 'persuasion': '0.0375', 'advertising effect': '0.001' }, effective: true, parts: ['referral bonus', 'double advertising'] }
        ],
        misconception: 'double advertising',
        levers: ['advertising effect', 'persuasion'],
        realistic: {
            text: 'What is realistic for us: we could at most triple the advertising budget, and a referral bonus might get riders to persuade up to half as many again of the people they talk to.',
            bounds: { 'advertising effect': { max: 0.0015 }, 'persuasion': { max: 0.0375 } }
        },
        protected: { variables: ['potential members', 'members', 'contact rate'], label: 'how many people in the city could join (about 50,000), the 100 members we started with, and how often riders talk to people' },
        parameterFacts: [
            { id: 'word of mouth numbers', topic: 'how often members talk to people who have not joined, and how many of them join', text: 'Each member talks about the scheme with about 10 people a month, and about 1 in 40 of the non-members they talk to signs up.' },
            { id: 'advertising numbers', topic: 'how many people the advertising brings in', text: 'Each month our advertising brings in about 0.05% of the people who have not joined yet.' },
            { id: 'market size', topic: 'how many people in the city could ever join', text: 'About 50,000 people in the city could realistically ever join.' }
        ],
        perspectives: [
            { id: 'marketing manager', who: 'Priya, our marketing manager', account: 'Our growth came from our advertising. Every campaign brought people in.', mechanism: 'advertising', signature: { from: 'advertising', to: 'signing up', polarity: '+' }, variant: { 'persuasion': '0', 'advertising effect': '0.0005 + RAMP(0.004, 6)' } },
            { id: 'operations lead', who: 'Tom, our operations lead', account: "No — advertising barely mattered. People joined because their friends who ride talked them into it.", mechanism: 'word of mouth', signature: { from: 'members', to: 'signing up', polarity: '+' }, variant: { 'advertising effect': '0.0001' } }
        ],
        experiments: [
            { id: 'change advertising', text: 'Pause or change the advertising for a while and watch what sign-ups do, or compare sign-ups in periods with and without campaigns.', overrides: { 'advertising effect': '*0' }, discriminates: true },
            { id: 'referral incentive', text: 'Find out or change how much members bring in friends: survey new members on how they heard about the scheme, track referrals, or give members an incentive to bring friends.', overrides: { 'persuasion': '*1.5' }, discriminates: true },
            { id: 'repaint bikes', text: 'Repaint the bikes in a new colour and see whether anyone joins because of it.', overrides: {}, discriminates: false }
        ],
        outsideFacts: [{ text: 'The bikes were repainted in the city colours in the second year.', topic: 'the look of the bikes' }, { text: 'Our office moved to a new building last spring.', topic: 'where the scheme\'s office is' }],
        loops: [
            { id: 'word of mouth', polarity: '+', variables: ['members', 'word of mouth', 'signing up'], core: ['members', 'signing up'], mechanism: 'word of mouth' },
            { id: 'market saturation', polarity: '-', variables: ['potential members', 'word of mouth', 'signing up'], core: ['potential members', 'signing up'], mechanism: 'market saturation' }
        ]
    },
    distributor: {
        id: 'distributor',
        title: 'Regional distributor inventory',
        opening: 'Our warehouse inventory has been swinging up and down for over a year and I want to understand why.',
        history: "A little over a year ago customer demand stepped up from about 100 cases a week to about 120 and has stayed there. Since then inventory dropped, then shot well above where we wanted it, then dipped again, and the swings are slowly dying down. Our orders to the supplier have swung the same way before settling at about 120 a week. Orders take about six weeks to arrive.",
        timeUnits: 'weeks',
        model: {
            variables: [
                S('Inventory', 400, ['receiving'], ['shipping'], 'cases'),
                S('Supply Line', 600, ['ordering'], ['receiving'], 'cases'),
                S('Expected Demand', 100, ['updating expectations'], [], 'cases/week'),
                F('shipping', 'demand', 'cases/week'),
                F('receiving', 'Supply_Line / delivery_delay', 'cases/week'),
                F('ordering', 'MAX(0, Expected_Demand + (desired_inventory - Inventory) / adjustment_time + supply_line_weight * (desired_supply_line - Supply_Line) / adjustment_time)', 'cases/week'),
                F('updating expectations', '(demand - Expected_Demand) / expectation_time', 'cases/week/week'),
                A('demand', 'base_demand + STEP(demand_increase, step_time)', 'cases/week'),
                A('base demand', 100, 'cases/week'),
                A('demand increase', 20, 'cases/week'),
                A('step time', 4, 'weeks'),
                A('delivery delay', 6, 'weeks'),
                A('desired inventory', 'Expected_Demand * coverage', 'cases'),
                A('coverage', 4, 'weeks'),
                A('adjustment time', 2, 'weeks'),
                A('desired supply line', 'Expected_Demand * delivery_delay', 'cases'),
                A('supply line weight', 0, 'dimensionless'),
                A('expectation time', 4, 'weeks')
            ],
            relationships: [],
            specs: { startTime: 0, stopTime: 60, dt: 0.0625, timeUnits: 'weeks' }
        },
        narrative: `I run a regional distributor and our inventory levels have been all over the place. A little over a year ago our customers' demand stepped up from about 100 cases a week to about 120 and has stayed there. Since then our warehouse inventory has swung: it dropped first, then shot well above where we wanted it, then dipped again, and the swings have been dying down slowly. Our orders to the supplier have swung the same way, overshooting and undershooting before settling at about 120 a week. Orders take about six weeks to arrive. Our buyers order to cover expected demand and to close the gap between the inventory we want and what we have; they don't really keep track of what's already on order. Separately, our fuel bill has gone up every quarter.`,
        keyVariables: [
            { model: 'Inventory', glossary: 'inventory', narrativeShape: 'oscillating' },
            { model: 'ordering', glossary: 'orders', narrativeShape: 'oscillating' }
        ],
        distractorTrends: [{ glossary: 'fuel bill', narrativeShape: 'rising' }],
        glossary: ['inventory', 'orders', 'supply line', 'deliveries', 'shipments', 'desired inventory', 'expected demand', 'demand'],
        glossaryToModel: { 'inventory': 'Inventory', 'orders': 'ordering', 'supply line': 'Supply Line', 'deliveries': 'receiving', 'shipments': 'shipping', 'desired inventory': 'desired inventory', 'expected demand': 'Expected Demand', 'demand': 'demand' },
        mechanisms: [
            { id: 'stock adjustment', topic: 'how the buyers decide how much to order', verdict: 'matters', fact: 'Our buyers order extra when inventory is below what we want, and less when it is above.', off: { 'adjustment time': '1e9' }, signature: { from: 'inventory', to: 'orders', polarity: '-' } },
            { id: 'supply line neglect', topic: 'whether the buyers account for stock already on order', verdict: 'matters', fact: 'Our buyers order based only on expected demand and the gap between the inventory we want and what we have.', off: { 'supply line weight': '1' } }
        ],
        goal: { variable: 'Inventory', measure: 'overshoot', threshold: 15, direction: 'below', label: 'keep inventory from ever overshooting more than 15 cases above the level it settles at' },
        policies: [
            { id: 'react faster', text: 'Have the buyers close inventory gaps within one week instead of two.', overrides: { 'adjustment time': '1' }, effective: false },
            { id: 'track orders in the pipeline', text: 'Have the buyers count what is already on order when deciding how much to order.', overrides: { 'supply line weight': '1' }, effective: true },
            { id: 'react more slowly', text: 'Have the buyers close inventory gaps over six weeks instead of two.', overrides: { 'adjustment time': '6' }, effective: false },
            { id: 'faster deliveries', text: 'Get the supplier to deliver in three weeks instead of six.', overrides: { 'delivery delay': '3' }, effective: false }
        ],
        misconception: 'react faster',
        levers: ['adjustment time', 'supply line weight', 'delivery delay', 'expectation time', 'coverage'],
        realistic: {
            text: 'What is realistic for us: the buyers could close inventory gaps over anything from one to six weeks (two now), they could start counting what is already on order when they order, the supplier cannot deliver in under three weeks (six now), the buyers\' target can be anything from two to six weeks of cover (four now), and our forecasts cannot catch up with a change in demand in under two weeks (four now).',
            bounds: { 'adjustment time': { min: 1, max: 6 }, 'supply line weight': { min: 0, max: 1 }, 'delivery delay': { min: 3 }, 'coverage': { min: 2, max: 6 }, 'expectation time': { min: 2 } }
        },
        protected: { variables: ['base demand', 'demand increase', 'step time', 'demand', 'shipments'], label: "customers' demand (the step from 100 to 120 cases a week) and what we ship to them" },
        parameterFacts: [
            { id: 'desired inventory', topic: 'how much inventory the buyers want to hold', text: 'Our buyers aim to hold four weeks of expected demand.' },
            { id: 'gap closing time', topic: 'how quickly the buyers close the gap between the inventory they want and what they have', text: 'They try to close any inventory gap over about two weeks.' },
            { id: 'expectation updating', topic: 'how quickly the buyers update their expectation of demand', text: 'Their expectation of demand catches up with actual demand over about four weeks.' }
        ],
        outsideFacts: [{ text: 'Our warehouse switched to LED lighting last year.', topic: 'the warehouse building and its running costs' }, { text: 'The supplier changed the design of its cardboard cases.', topic: 'packaging' }],
        loops: [
            { id: 'stock adjustment', polarity: '-', variables: ['inventory', 'orders', 'supply line', 'deliveries'], core: ['inventory', 'orders'], mechanism: 'stock adjustment' }
        ]
    },
    coffeeCoop: { ...coffeeCoop, split: 'heldout' },
    kitchenFitters: { ...kitchenFitters, split: 'heldout' },
    mushroomGrowers: { ...mushroomGrowers, split: 'heldout' },
    ambulanceService: { ...ambulanceService, split: 'heldout' },
    deliveryVans: { ...deliveryVans, split: 'heldout' },
    foodBank: { ...foodBank, split: 'heldout' },
    electricianTraining: { ...electricianTraining, split: 'heldout', batch: 2 },
    cleaningStandards: { ...cleaningStandards, split: 'heldout', batch: 2 },
    valleyWater: { ...valleyWater, split: 'heldout', batch: 2 }
};
