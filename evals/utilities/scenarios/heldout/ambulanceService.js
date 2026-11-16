/**
 * Held-out scenario: a regional ambulance service whose response-time target slowly drifts toward
 * what it actually achieves. Written after the graders that score it were frozen; every field
 * means what library.js's header says.
 *
 * When response times fall short of the target the service asks for more crews, which take about a
 * year to get through the budget; meanwhile management moves the target toward recent performance,
 * which shrinks the shortfall the crew requests are sized from. As calls grow, the target and the
 * response time drift up together.
 *
 * @module utilities/scenarios/heldout/ambulanceService
 */

const S = (name, equation, inflows, outflows, units) => ({ name, type: 'stock', equation: String(equation), inflows, outflows, units });
const F = (name, equation, units) => ({ name, type: 'flow', equation, units });
const A = (name, equation, units) => ({ name, type: 'variable', equation: String(equation), units });

export const ambulanceService = {
    id: 'ambulanceService',
    title: 'Regional ambulance service',
    opening: 'Our ambulance response times have been getting slowly worse for ten years, even though we keep adding crews, and I want to understand why.',
    history: 'Ten years ago we answered about 2,000 calls a month with 20 crews, and we reached calls in about 10 minutes on average, which was also our target. Calls have grown steadily, by about 7% a year, and are now about 4,100 a month. We have added crews every year and now have about 27. Even so, average response times have crept up the whole time, to about 15 minutes now, and the official target has crept up alongside them, to about 14 and a half minutes.',
    timeUnits: 'months',
    model: {
        variables: [
            S('Population', 400000, ['population growth'], [], 'people'),
            S('Crews', 'calls_handled / calls_per_crew', ['crews starting'], [], 'crews'),
            S('Crews Awaiting Budget', 0, ['requesting crews'], ['crews starting'], 'crews'),
            S('Response Time Target', 'normal_response_time', ['relaxing the target'], [], 'minutes'),
            F('population growth', 'Population * growth_rate', 'people/month'),
            F('requesting crews', 'MAX(0, crews_needed - Crews - Crews_Awaiting_Budget) / review_time', 'crews/month'),
            F('crews starting', 'Crews_Awaiting_Budget / budget_delay', 'crews/month'),
            F('relaxing the target', 'MAX(0, performance_gap) / target_adjustment_time', 'minutes/month'),
            A('calls', 'Population * calls_per_resident', 'calls/month'),
            A('calls handled', 'calls * (1 - neighbor_share)', 'calls/month'),
            A('crew capacity', 'Crews * calls_per_crew', 'calls/month'),
            A('workload', 'calls_handled / crew_capacity', 'dimensionless'),
            A('response time', 'normal_response_time * workload', 'minutes'),
            A('performance gap', 'response_time - Response_Time_Target', 'minutes'),
            A('crews needed', 'IF Response_Time_Target > 0 THEN Crews * (1 + performance_gap / Response_Time_Target) ELSE Crews', 'crews'),
            A('growth rate', 0.006, '1/month'),
            A('calls per resident', 0.005, 'calls/(person*month)'),
            A('neighbor share', 0.05, 'dimensionless'),
            A('calls per crew', 95, 'calls/(crew*month)'),
            A('normal response time', 10, 'minutes'),
            A('review time', 3, 'months'),
            A('budget delay', 12, 'months'),
            A('target adjustment time', 12, 'months')
        ],
        relationships: [],
        specs: { startTime: 0, stopTime: 120, dt: 0.125, timeUnits: 'months' }
    },
    narrative: `I run a regional ambulance service and I'm trying to understand the last ten years. Back then we answered about 2,000 calls a month with 20 crews, and we reached calls in about 10 minutes on average, which was also our target. The region has grown and calls have grown with it, steadily, by about 7% a year; we now get about 4,100 a month. When our response times fall short of the target we ask for more crews, but a new crew takes about a year to get through the budget and onto the road. We have added crews every year and now have about 27. Even so, average response times have crept up the whole time and are now about 15 minutes. The official target has crept up too: whenever we kept missing it, management would quietly move it toward what we had actually been achieving, and it now stands at about 14 and a half minutes. Separately, our fuel bill has gone up every year.`,
    keyVariables: [
        { model: 'response time', glossary: 'response time', narrativeShape: 'rising' },
        { model: 'Response Time Target', glossary: 'response time target', narrativeShape: 'rising' }
    ],
    distractorTrends: [{ glossary: 'fuel bill', narrativeShape: 'rising' }],
    glossary: ['response time', 'response time target', 'performance gap', 'relaxing the target', 'crews needed', 'crews requested', 'crews awaiting budget', 'crews starting', 'crews', 'crew capacity', 'workload', 'calls', 'population'],
    glossaryToModel: {
        'response time': 'response time',
        'response time target': 'Response Time Target',
        'performance gap': 'performance gap',
        'relaxing the target': 'relaxing the target',
        'crews needed': 'crews needed',
        'crews requested': 'requesting crews',
        'crews awaiting budget': 'Crews Awaiting Budget',
        'crews starting': 'crews starting',
        'crews': 'Crews',
        'crew capacity': 'crew capacity',
        'workload': 'workload',
        'calls': 'calls',
        'population': 'Population'
    },
    mechanisms: [
        { id: 'adding crews', topic: 'how the service adds crews when it misses its response-time target (asking for crews, and how long they take)', verdict: 'matters', fact: 'When our response times fall short of the target we ask for more crews, but a new crew takes about a year to get through the budget and onto the road.', off: { 'requesting crews': '0' }, signature: { from: 'response time', to: 'crews', polarity: '+', throughStocks: true } },
        { id: 'relaxing the target', topic: 'how the response-time target is set and whether it changes', verdict: 'matters', fact: 'Whenever we keep missing the target, management quietly moves it toward the response times we have actually been achieving.', off: { 'target adjustment time': '1e9' }, signature: { from: 'response time', to: 'response time target', polarity: '+' } },
        { id: 'neighbor cover', topic: 'whether a neighbouring service takes any of the calls', verdict: 'irrelevant', fact: 'The neighbouring ambulance service covers about one call in twenty near our border, and always has.', off: { 'neighbor share': '0' } }
    ],
    goal: { variable: 'response time', measure: 'max', threshold: 12.5, direction: 'below', label: 'keep the average response time from ever going above 12 and a half minutes over the ten years' },
    policies: [
        { id: 'hold the target', text: 'Hold the response-time target at 10 minutes and stop moving it when we miss.', overrides: { 'target adjustment time': '1e9' }, effective: true },
        { id: 'fast-track budget', text: 'Fast-track the budget so a new crew is on the road in 6 months instead of 12.', overrides: { 'budget delay': '6' }, effective: false },
        { id: 'shorter budget', text: 'Shorten the budget process so a new crew is on the road in 9 months instead of 12.', overrides: { 'budget delay': '9' }, effective: false },
        { id: 'review monthly', text: 'Review how many crews we need every month instead of every three months.', overrides: { 'review time': '1' }, effective: false },
        { id: 'hold the target and fast-track budget', text: 'Do both: hold the target at 10 minutes and fast-track the budget so a new crew is on the road in 6 months.', overrides: { 'target adjustment time': '1e9', 'budget delay': '6' }, effective: true, parts: ['hold the target', 'fast-track budget'] }
    ],
    misconception: 'shorter budget',
    protected: {
        variables: ['growth rate', 'population', 'population growth', 'calls', 'calls per resident', 'neighbor share', 'calls handled', 'calls per crew', 'crew capacity', 'workload', 'response time', 'normal response time'],
        label: 'how many people live in the region and how often they call (about 2,000 calls a month ten years ago, growing about 7% a year), the calls the neighbouring service covers, how many calls a crew can handle, and how response times follow from how busy the crews are'
    },
    levers: ['target adjustment time', 'budget delay', 'review time'],
    realistic: {
        text: 'What is realistic for us: the budget process could be fast-tracked so a new crew is on the road in as little as 6 months instead of 12; we could review how many crews we need as often as every month instead of every three months; and the response-time target is ours to keep: we can stop moving it, or move it more slowly than now (we close a miss over about a year), but there is no sense in moving it faster.',
        bounds: { 'budget delay': { min: 6 }, 'review time': { min: 1 }, 'target adjustment time': { min: 12 } }
    },
    parameterFacts: [
        { id: 'response time rule', topic: 'how response times depend on how busy the crews are', text: 'When each crew is as busy as it was ten years ago we reach calls in about 10 minutes on average, and response times go up in proportion to how busy the crews are: a fifth more calls per crew means a fifth longer to reach a call.' },
        { id: 'crew capacity', topic: 'how many calls a crew can handle', text: 'At that pace a crew handles about 95 calls a month, and ten years ago we had just enough crews for that.' },
        { id: 'crew request rule', topic: 'how the service decides how many crews to ask for', text: 'We ask for enough crews to bring response times back to the target, counting the crews already waiting for budget, and we close any shortfall over about three months.' },
        { id: 'budget time', topic: 'how long a new crew takes to get through the budget', text: 'Once we ask for a crew it takes about twelve months on average to get through the budget and onto the road.' },
        { id: 'target rule', topic: 'how quickly the target moves toward actual performance', text: 'Whenever we are slower than the target, the target is moved toward our actual response time, closing the gap over about a year; it is never tightened again.' },
        { id: 'call volume', topic: 'how many calls the region makes and how fast that grows', text: 'Ten years ago about 400,000 people lived in the region, each making about one call every 200 months; the population grows about 0.6% a month.' },
        { id: 'neighbor share', topic: 'how many calls the neighbouring service covers', text: 'The neighbouring service covers about 5% of our calls.' }
    ],
    perspectives: [
        { id: 'operations director', who: 'Marcus, our operations director', account: "The target is just a number on a report; it doesn't drive anything. Response times slipped because getting a new crew approved and on the road takes forever, and calls grew faster than we could add crews.", mechanism: 'adding crews', signature: { from: 'response time', to: 'crews', polarity: '+', throughStocks: true }, variant: { 'crews needed': 'Crews * response_time / normal_response_time', 'budget delay': '42', 'review time': '42' } },
        { id: 'dispatch supervisor', who: 'Aisha, our dispatch supervisor', account: "The budget isn't the real problem — crews come through in about six months. Every time we miss, the target gets moved, and then we ask for fewer crews because on paper we're nearly on target.", mechanism: 'relaxing the target', signature: { from: 'response time target', to: 'crews requested', polarity: '-' }, variant: { 'budget delay': '6', 'target adjustment time': '7' } }
    ],
    experiments: [
        { id: 'hold the target for a while', text: 'Hold the target fixed for a while, or check whether crew requests track the target or the original 10-minute standard, and see whether more crews get asked for.', overrides: { 'target adjustment time': '1e9' }, discriminates: true },
        { id: 'speed up the budget', text: 'Push a batch of crew requests through the budget twice as fast and watch what happens to response times.', overrides: { 'budget delay': '*0.5' }, discriminates: false },
        { id: 'repaint the ambulances', text: 'Repaint the ambulances in a brighter livery and see whether response times change.', overrides: {}, discriminates: false }
    ],
    outsideFacts: [{ text: 'Our headquarters moved to a new building three years ago.', topic: 'where the service\'s headquarters is' }, { text: 'The regional health authority changed its logo last year.', topic: 'the health authority\'s branding' }],
    loops: [
        { id: 'adding crews', polarity: '-', variables: ['performance gap', 'crews needed', 'crews requested', 'crews awaiting budget', 'crews starting', 'crews', 'crew capacity', 'workload', 'response time'], core: ['response time', 'crews'], mechanism: 'adding crews' },
        { id: 'relaxing the target', polarity: '-', variables: ['performance gap', 'relaxing the target', 'response time target'], core: ['performance gap', 'response time target'], mechanism: 'relaxing the target' }
    ]
};
