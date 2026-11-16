/**
 * Held-out scenario: a kitchen-fitting firm whose backlog stays high long after a sales surge,
 * because rushed fits come back as callbacks weeks later. See library.js for what every field means.
 *
 * @module utilities/scenarios/heldout/kitchenFitters
 */

const S = (name, equation, inflows, outflows, units) => ({ name, type: 'stock', equation: String(equation), inflows, outflows, units });
const F = (name, equation, units) => ({ name, type: 'flow', equation, units });
const A = (name, equation, units) => ({ name, type: 'variable', equation: String(equation), units });

export const kitchenFitters = {
    id: 'kitchenFitters',
    title: 'Kitchen fitting backlog',
    opening: 'Our backlog of kitchens waiting to be fitted shot up during last year\'s promotion and took months longer to come down than it should have, and I want to understand why.',
    history: 'A year and a half ago we had about 44 kitchens waiting to be fitted, about 11 fitting crews, and about 10 new orders a week. A showroom promotion lifted orders to about 17 a week from week 4 to week 24, then orders went straight back to about 10. The backlog climbed to about 115 jobs by the end of the promotion. Two months after the promotion ended it was still about 80, and it took months more to come down; it is back to about 45 now. We have about 17 or 18 crews now.',
    timeUnits: 'weeks',
    model: {
        variables: [
            S('Backlog', 44.05, ['new orders', 'faults reported'], ['fitting', 'cancelling'], 'jobs'),
            S('Hidden Faults', 13.22, ['faulty fitting'], ['faults reported'], 'jobs'),
            S('Crews', 11.02, ['hiring'], [], 'crews'),
            F('new orders', 'base_orders + STEP(surge_size, surge_start) - STEP(surge_size, surge_end)', 'jobs/week'),
            F('fitting', 'MIN(desired_fitting, capacity * work_intensity)', 'jobs/week'),
            F('cancelling', 'Backlog * cancel_fraction', 'jobs/week'),
            F('faulty fitting', 'fitting * error_fraction', 'jobs/week'),
            F('faults reported', 'Hidden_Faults / discovery_time', 'jobs/week'),
            F('hiring', 'MAX(0, (desired_crews - Crews) / hiring_time)', 'crews/week'),
            A('base orders', 10, 'jobs/week'),
            A('surge size', 7, 'jobs/week'),
            A('surge start', 4, 'weeks'),
            A('surge end', 24, 'weeks'),
            A('target lead time', 4, 'weeks'),
            A('desired fitting', 'Backlog / target_lead_time', 'jobs/week'),
            A('jobs per crew', 1, 'jobs/(crews*week)'),
            A('capacity', 'Crews * jobs_per_crew', 'jobs/week'),
            A('schedule pressure', 'desired_fitting / capacity', 'dimensionless'),
            A('maximum rush', 1.4, 'dimensionless'),
            A('work intensity', 'MIN(maximum_rush, MAX(1, schedule_pressure))', 'dimensionless'),
            A('normal error fraction', 0.1, 'dimensionless'),
            A('rush error effect', 10, 'dimensionless'),
            A('error fraction', 'normal_error_fraction * (1 + rush_error_effect * (work_intensity - 1))', 'dimensionless'),
            A('discovery time', 12, 'weeks'),
            A('cancel fraction', 0.002, '1/week'),
            A('desired crews', 'desired_fitting / jobs_per_crew', 'crews'),
            A('hiring time', 30, 'weeks')
        ],
        relationships: [],
        specs: { startTime: 0, stopTime: 78, dt: 0.125, timeUnits: 'weeks' }
    },
    narrative: `I run a kitchen-fitting firm and I'm trying to make sense of the last year and a half. At the start we had about 44 kitchens waiting to be fitted, about 11 fitting crews and about 10 new orders a week. A showroom promotion lifted orders to about 17 a week from week 4 to week 24, and then they went straight back to about 10. The backlog climbed to about 115 jobs by the end of the promotion. It came down far more slowly than I expected: two months after the promotion ended it was still about 80, and it took months more to get back to about 45, where it is now. While the backlog was long the crews were under pressure and worked faster, and we had a lot of callbacks — clients ringing weeks after a fit because something wasn't right. We recruited as the backlog grew, but finding and training a fitter takes months; we have about 17 or 18 crews now. Separately, the price of worktop sealant has gone up every quarter.`,
    keyVariables: [
        { model: 'Backlog', glossary: 'job backlog', narrativeShape: 'rises then falls' },
        { model: 'Crews', glossary: 'fitting crews', narrativeShape: 'rising' }
    ],
    distractorTrends: [{ glossary: 'worktop sealant price', narrativeShape: 'rising' }],
    glossary: ['job backlog', 'new orders', 'jobs fitted', 'fitting crews', 'hiring', 'schedule pressure', 'error rate', 'faulty fits', 'hidden faults', 'callbacks', 'cancellations'],
    glossaryToModel: { 'job backlog': 'Backlog', 'new orders': 'new orders', 'jobs fitted': 'fitting', 'fitting crews': 'Crews', 'hiring': 'hiring', 'schedule pressure': 'schedule pressure', 'error rate': 'error fraction', 'faulty fits': 'faulty fitting', 'hidden faults': 'Hidden Faults', 'callbacks': 'faults reported', 'cancellations': 'cancelling' },
    mechanisms: [
        { id: 'rushing', topic: 'what happens to the quality of the work when the crews are under pressure', verdict: 'matters', fact: 'When the backlog runs ahead of what the crews can fit, they rush, and rushed jobs have far more snags.', off: { 'rush error effect': '0' }, signature: { from: 'schedule pressure', to: 'error rate', polarity: '+' } },
        { id: 'callbacks', topic: 'what happens to jobs that turn out to have snags', verdict: 'matters', fact: 'Clients find snags weeks after we leave, and each one sends a crew back, so it goes back in the backlog.', off: { 'discovery time': '1e9' }, signature: { from: 'hidden faults', to: 'job backlog', polarity: '+' } },
        { id: 'hiring', topic: 'how the firm decides how many fitters to take on, and how long that takes', verdict: 'matters', fact: 'We recruit fitters when the backlog grows, but finding and training one takes months.', off: { 'hiring': '0' }, signature: { from: 'job backlog', to: 'fitting crews', polarity: '+' } },
        { id: 'cancellations', topic: 'whether clients cancel jobs while they wait', verdict: 'irrelevant', fact: 'Now and then a client who has waited a while cancels.', off: { 'cancel fraction': '0' } }
    ],
    goal: { variable: 'Backlog', measure: 'atTime', time: 40, threshold: 56, direction: 'below', label: 'get the backlog back under 56 jobs (within a dozen of the usual 44) by week 40, sixteen weeks after the promotion ends' },
    policies: [
        { id: 'final check', text: 'Add a final check before every sign-off, so a normal job has half as many snags.', overrides: { 'normal error fraction': '0.05' }, effective: true },
        { id: 'push the crews harder', text: 'Push the crews harder when the backlog is high, so they can fit up to 1.7 times their normal pace instead of 1.4.', overrides: { 'maximum rush': '1.7' }, effective: false },
        { id: 'stop rushing', text: 'Stop the crews rushing: keep every job at its normal pace however long the backlog gets.', overrides: { 'maximum rush': '1' }, effective: true },
        { id: 'quote longer lead times', text: 'Quote clients six weeks instead of four, so the crews feel less pressure.', overrides: { 'target lead time': '6' }, effective: false },
        { id: 'final check and stop rushing', text: 'Do both: the final check and stop the crews rushing.', overrides: { 'normal error fraction': '0.05', 'maximum rush': '1' }, effective: true, parts: ['final check', 'stop rushing'] }
    ],
    misconception: 'push the crews harder',
    protected: { variables: ['base orders', 'surge size', 'surge start', 'surge end', 'new orders', 'discovery time', 'callbacks', 'cancel fraction', 'cancellations'], label: 'clients\' orders (about 10 a week, and the promotion that lifted them to about 17) and how clients behave (when they find snags, and whether they cancel)' },
    levers: ['maximum rush', 'normal error fraction', 'hiring time', 'fitting crews', 'target lead time'],
    realistic: {
        text: 'What is realistic for us: we can let the crews rush to at most 1.7 times their normal pace, or not let them rush at all; a final check before sign-off could at best halve the snags on a normal job (about 1 in 10 now); we cannot find and train a fitter in under 20 weeks (about 30 now); we could have started with at most 13 crews instead of 11; and we cannot promise a fit sooner than 4 weeks after the order, because the units take that long to arrive, nor quote more than 8.',
        bounds: { 'maximum rush': { min: 1, max: 1.7 }, 'normal error fraction': { min: 0.05 }, 'hiring time': { min: 20 }, 'fitting crews': { max: 13 }, 'target lead time': { min: 4, max: 8 } }
    },
    parameterFacts: [
        { id: 'crew pace', topic: 'how many jobs a crew fits and how fast the firm aims to fit them', text: 'A crew fits about one kitchen a week at its normal pace. We aim to fit every job about four weeks after it comes in, and when the backlog is longer than that the crews speed up, to at most about 1.4 times their normal pace.' },
        { id: 'snag rates', topic: 'how many jobs have snags, and how that changes when crews rush', text: 'About 1 in 10 jobs has a snag at the normal pace. Every 10% the crews speed up adds about one more snag per 10 jobs — at 1.4 times the normal pace about half the jobs have one.' },
        { id: 'snag discovery', topic: 'how long it takes clients to find a snag', text: 'On average a client finds a snag about 12 weeks after the fit.' },
        { id: 'hiring rule', topic: 'how the firm decides how many fitters to take on', text: 'We aim for enough crews to fit the backlog in four weeks at the normal pace, and we close any shortfall over about 30 weeks, since finding and training a fitter is slow. We never let crews go.' },
        { id: 'cancellation rate', topic: 'how often clients cancel', text: 'About 0.2% of the jobs waiting are cancelled each week.' }
    ],
    perspectives: [
        { id: 'after-sales manager', who: 'Dana, our after-sales manager', account: 'The backlog stayed high because the crews rushed. Jobs fitted in a hurry during the promotion had far more snags, and they kept coming back to us as callbacks for weeks afterwards, every one back in the queue.', mechanism: 'rushing', signature: { from: 'schedule pressure', to: 'error rate', polarity: '+' }, variant: {} },
        { id: 'installations manager', who: 'Lee, our installations manager', account: "Rushing has nothing to do with it: about 1 in 10 jobs has a snag whatever the pace. We were simply short of crews. The backlog grew, we started recruiting, and it takes well over a year to close the gap.", mechanism: 'hiring', signature: { from: 'job backlog', to: 'fitting crews', polarity: '+' }, variant: { 'rush error effect': '0', 'jobs per crew': '0.9', 'maximum rush': '1.2', 'hiring time': '60' } }
    ],
    experiments: [
        { id: 'pace trial', text: 'Compare the snag rate on jobs fitted in a rush with jobs fitted at the normal pace — in the records, or by keeping the crews at their normal pace for a while and counting callbacks.', overrides: { 'maximum rush': '1' }, discriminates: true },
        { id: 'van livery', text: 'Repaint the vans with a new logo and see whether clients notice.', overrides: {}, discriminates: false }
    ],
    outsideFacts: [{ text: 'We moved the showroom to a bigger unit on the retail park last year.', topic: 'the showroom building' }, { text: 'Our main worktop supplier changed its delivery van company.', topic: 'the worktop supplier\'s logistics' }],
    loops: [
        { id: 'rushed work', polarity: '+', variables: ['job backlog', 'schedule pressure', 'error rate', 'faulty fits', 'hidden faults', 'callbacks'], core: ['job backlog', 'error rate', 'callbacks'], mechanism: 'rushing' },
        { id: 'hiring', polarity: '-', variables: ['job backlog', 'hiring', 'fitting crews', 'jobs fitted'], core: ['job backlog', 'fitting crews'], mechanism: 'hiring' }
    ]
};
