/**
 * Held-out scenario: a hospital's contract cleaning team whose spot-check standard slides toward
 * what the team actually achieves. Written after the graders that score it were frozen; every
 * field means what library.js's header says.
 *
 * The pass rate depends on cleaning hours per room. When it falls short of the standard the
 * contractor asks for more cleaners, who take months to recruit and vet; meanwhile the facilities
 * committee moves the standard toward the pass rate it keeps seeing, which shrinks the shortfall
 * the staffing requests are sized from. When a new wing opens, the pass rate drops, the standard
 * slides down after it, and the pass rate only climbs back as far as the lowered standard.
 *
 * @module utilities/scenarios/heldout/cleaningStandards
 */

const S = (name, equation, inflows, outflows, units) => ({ name, type: 'stock', equation: String(equation), inflows, outflows, units });
const F = (name, equation, units) => ({ name, type: 'flow', equation, units });
const A = (name, equation, units) => ({ name, type: 'variable', equation: String(equation), units });

export const cleaningStandards = {
    id: 'cleaningStandards',
    title: 'Hospital contract cleaning standard',
    opening: 'Our hospital\'s cleaning quality dropped when the new wing opened and never came back, even though the contractor has added cleaners, and I want to understand why.',
    history: 'Eight years ago the contract cleaners looked after about 400 rooms with about 49 cleaners, and about 90% of rooms passed the spot check, which was also the standard in the contract; about 1 room in 10 failed. At the end of the second year a new wing opened and we had about 600 rooms. Within a month or so the share of rooms failing jumped to about 21%, a pass rate of about 79%. The contractor has added cleaners since and now has about 56, and the share failing came back down, but only to about 17%: the pass rate is about 83%. Over the same years the committee lowered the standard bit by bit, from 90% to about 83%, and the pass rate and the standard have both sat there for the last few years.',
    timeUnits: 'months',
    model: {
        variables: [
            S('Cleaning Staff', 49, ['starting work'], ['leaving'], 'cleaners'),
            S('Open Positions', 'Cleaning_Staff / average_stay * hiring_time', ['requesting staff'], ['starting work'], 'cleaners'),
            S('Inspection Standard', 0.9, [], ['lowering the standard'], 'dimensionless'),
            F('requesting staff', 'MAX(0, leaving + (staff_needed + leaving * hiring_time - Cleaning_Staff - Open_Positions) / review_time)', 'cleaners/month'),
            F('starting work', 'Open_Positions / hiring_time', 'cleaners/month'),
            F('leaving', 'Cleaning_Staff / average_stay', 'cleaners/month'),
            F('lowering the standard', 'MAX(0, shortfall) / revision_time', '1/month'),
            A('shortfall', 'Inspection_Standard - pass_rate', 'dimensionless'),
            A('staff needed', 'Cleaning_Staff * (1 + ZIDZ(shortfall, pass_rate))', 'cleaners'),
            A('cleaning hours', 'Cleaning_Staff * hours_per_cleaner + porter_hours', 'hours/month'),
            A('hours per room', 'ZIDZ(cleaning_hours, rooms)', 'hours/(room*month)'),
            A('share of rooms failing', 'reference_failing_share ^ (hours_per_room / reference_hours_per_room)', 'dimensionless'),
            A('pass rate', '1 - share_of_rooms_failing', 'dimensionless'),
            A('rooms', 'original_rooms + STEP(new_wing_rooms, wing_opening)', 'rooms'),
            A('original rooms', 400, 'rooms'),
            A('new wing rooms', 200, 'rooms'),
            A('wing opening', 24, 'months'),
            A('hours per cleaner', 160, 'hours/(cleaner*month)'),
            A('porter hours', 160, 'hours/month'),
            A('reference failing share', 0.1, 'dimensionless'),
            A('reference hours per room', 20, 'hours/(room*month)'),
            A('average stay', 24, 'months'),
            A('hiring time', 4, 'months'),
            A('review time', 3, 'months'),
            A('revision time', 12, 'months')
        ],
        relationships: [],
        specs: { startTime: 0, stopTime: 96, dt: 0.125, timeUnits: 'months' }
    },
    narrative: `I'm the facilities manager at a hospital and I'm trying to understand what has happened to our cleaning over the last eight years. The cleaning is done by a contractor, and the contract sets an inspection standard: the share of rooms that must pass our spot check. Eight years ago the contractor looked after about 400 rooms with about 49 cleaners, about 90% of rooms passed, and the standard was 90%; about 1 room in 10 failed. How clean a room gets depends on how many cleaner-hours it gets. When the pass rate falls short of the standard, the contractor's manager asks for more cleaners to close the gap, but recruiting and vetting a new cleaner takes about four months, and cleaners come and go all the time. At the end of the second year a new wing opened and we had about 600 rooms. Within a month or so the share of rooms failing jumped to about 21%, a pass rate of about 79%. The contractor has added cleaners since, up to about 56, and the share failing came back down, but only to about 17%: the pass rate is about 83%. Meanwhile our facilities committee, seeing the contractor miss the standard month after month, quietly lowered it toward what the team was actually achieving; it is now about 83%, and the pass rate and the standard have both sat there for the last few years. Separately, our laundry bill has gone up every year.`,
    keyVariables: [
        { model: 'share of rooms failing', glossary: 'share of rooms failing', narrativeShape: 'rises then falls' },
        { model: 'Inspection Standard', glossary: 'inspection standard', narrativeShape: 'falling' }
    ],
    distractorTrends: [{ glossary: 'laundry bill', narrativeShape: 'rising' }],
    glossary: ['pass rate', 'share of rooms failing', 'inspection standard', 'shortfall', 'lowering the standard', 'cleaners needed', 'cleaners requested', 'open positions', 'cleaners starting', 'cleaners leaving', 'cleaning staff', 'cleaning hours', 'hours per room', 'rooms', 'porter hours'],
    glossaryToModel: {
        'pass rate': 'pass rate',
        'share of rooms failing': 'share of rooms failing',
        'inspection standard': 'Inspection Standard',
        'shortfall': 'shortfall',
        'lowering the standard': 'lowering the standard',
        'cleaners needed': 'staff needed',
        'cleaners requested': 'requesting staff',
        'open positions': 'Open Positions',
        'cleaners starting': 'starting work',
        'cleaners leaving': 'leaving',
        'cleaning staff': 'Cleaning Staff',
        'cleaning hours': 'cleaning hours',
        'hours per room': 'hours per room',
        'rooms': 'rooms',
        'porter hours': 'porter hours'
    },
    mechanisms: [
        { id: 'adding cleaners', topic: 'how the contractor adds cleaners when rooms fail the spot check (asking for cleaners, and how long recruiting takes)', verdict: 'matters', fact: 'When the pass rate falls short of the standard, the contractor\'s manager asks for more cleaners to close the gap, but recruiting and vetting a new cleaner takes about four months.', off: { 'requesting staff': 'leaving' }, signature: { from: 'pass rate', to: 'cleaning staff', polarity: '-', throughStocks: true } },
        { id: 'lowering the standard', topic: 'how the inspection standard is set and whether it changes', verdict: 'matters', fact: 'When the contractor keeps missing the standard, the facilities committee quietly lowers it toward the pass rate the team is actually achieving.', off: { 'revision time': '1e9' }, signature: { from: 'pass rate', to: 'inspection standard', polarity: '+' } },
        { id: 'new wing', topic: 'how many rooms the cleaners look after and when new wings opened', verdict: 'matters', fact: 'At the end of the second year a new wing opened, taking us from about 400 rooms to about 600.', off: { 'new wing rooms': '0' } },
        { id: 'porters', topic: 'whether anyone besides the cleaners does any cleaning', verdict: 'irrelevant', fact: 'The hospital porters empty the corridor bins on their rounds, which saves the cleaners about one cleaner\'s worth of hours a month, and they always have.', off: { 'porter hours': '0' } }
    ],
    goal: { variable: 'share of rooms failing', measure: 'atTime', time: 96, threshold: 0.13, direction: 'below', label: 'get the share of rooms failing the spot check below 13% by the end of the eighth year' },
    policies: [
        { id: 'hold the standard', text: 'Hold the inspection standard at 90% and have the committee stop lowering it when the contractor misses.', overrides: { 'revision time': '1e9' }, effective: true },
        { id: 'overtime', text: 'Pay the cleaners for 10% overtime, so each works about 176 hours a month instead of 160.', overrides: { 'hours per cleaner': '176' }, effective: false },
        { id: 'more overtime', text: 'Pay the cleaners for 20% overtime, so each works about 192 hours a month instead of 160.', overrides: { 'hours per cleaner': '192' }, effective: false },
        { id: 'faster vetting', text: 'Speed up recruiting and vetting so a new cleaner starts in 2 months instead of 4.', overrides: { 'hiring time': '2' }, effective: false },
        { id: 'review monthly', text: 'Have the contractor review how many cleaners it needs every month instead of every three months.', overrides: { 'review time': '1' }, effective: false },
        { id: 'hold the standard and more overtime', text: 'Do both: hold the standard at 90% and pay for 20% overtime.', overrides: { 'revision time': '1e9', 'hours per cleaner': '192' }, effective: true, parts: ['hold the standard', 'more overtime'] }
    ],
    misconception: 'overtime',
    protected: {
        variables: ['rooms', 'original rooms', 'new wing rooms', 'wing opening', 'pass rate', 'share of rooms failing', 'hours per room', 'reference failing share', 'reference hours per room', 'cleaning hours', 'porter hours', 'cleaners leaving', 'average stay'],
        label: 'how many rooms the hospital has and when wings open (400 rooms, then 600 from the end of the second year), the porters\' help, how long cleaners stay before moving on, and how the pass rate follows from the cleaner-hours each room gets'
    },
    levers: ['revision time', 'hours per cleaner', 'hiring time', 'review time'],
    realistic: {
        text: 'What is realistic for us: we could pay for overtime of up to 20%, so a cleaner works at most 192 hours a month instead of 160; recruiting and vetting could be sped up so a new cleaner starts in as little as 2 months instead of 4; the contractor could review how many cleaners it needs as often as every month instead of every three months; and the standard is the committee\'s to keep: it can stop lowering it, or lower it more slowly than now (it closes a miss over about a year), but there is no sense in lowering it faster.',
        bounds: { 'hours per cleaner': { max: 192 }, 'hiring time': { min: 2 }, 'review time': { min: 1 }, 'revision time': { min: 12 } }
    },
    parameterFacts: [
        { id: 'pass rate rule', topic: 'how the pass rate depends on the cleaning time each room gets', text: 'With about 20 cleaner-hours per room each month, about 1 room in 10 fails the spot check. Fewer hours make failures climb steeply and more hours make them fall: the share failing is 1 in 10 raised to the power of the hours per room divided by 20, so at two-thirds of those hours about 1 room in 5 fails, and at 40 hours only about 1 in 100.' },
        { id: 'cleaner hours', topic: 'how many hours a cleaner works and what help they get', text: 'Each cleaner works about 160 hours a month. The porters add about 160 hours a month of their own by emptying the corridor bins.' },
        { id: 'staffing rule', topic: 'how the contractor decides how many cleaners to ask for', text: 'The contractor replaces everyone who leaves, and on top of that asks for extra cleaners in proportion to the shortfall: if the pass rate is a tenth below the standard, it wants a tenth more cleaners. It counts the cleaners already being recruited and closes any shortfall over about three months.' },
        { id: 'recruiting and turnover', topic: 'how long recruiting takes and how long cleaners stay', text: 'Recruiting and vetting a new cleaner takes about four months on average, and a cleaner stays about two years before moving on.' },
        { id: 'standard rule', topic: 'how quickly the committee lowers the standard', text: 'Whenever the pass rate is below the standard, the committee moves the standard toward the pass rate, closing the gap over about a year; it never raises it again.' },
        { id: 'rooms', topic: 'how many rooms the cleaners look after', text: 'We had about 400 rooms until the end of the second year, when the new wing added about 200 more.' }
    ],
    perspectives: [
        { id: 'contract manager', who: 'Gary, the contractor\'s area manager', account: 'The standard is just a figure in the contract; we staff to do the job properly. Quality dropped because vetting new cleaners takes forever and people leave as fast as we can hire them, so we have been short-handed ever since the wing opened.', mechanism: 'adding cleaners', signature: { from: 'pass rate', to: 'cleaning staff', polarity: '-', throughStocks: true }, variant: { 'staff needed': 'Cleaning_Staff * (1 + (0.9 - pass_rate) / pass_rate)', 'hiring time': '8', 'review time': '36', 'revision time': '24' } },
        { id: 'infection control nurse', who: 'Nadia, our infection control lead nurse', account: 'Recruiting isn\'t the problem; new cleaners start within a couple of months. Every time the committee lowers the standard, the contractor asks for fewer cleaners, because on paper they are nearly meeting it.', mechanism: 'lowering the standard', signature: { from: 'inspection standard', to: 'cleaners requested', polarity: '+' }, variant: { 'hiring time': '2', 'revision time': '8' } }
    ],
    experiments: [
        { id: 'hold the standard for a while', text: 'Hold the standard fixed for a while, or check whether the contractor\'s staffing requests follow the current standard or the original 90%, and see whether more cleaners get asked for.', overrides: { 'revision time': '1e9' }, discriminates: true },
        { id: 'new uniforms', text: 'Give the cleaners new uniforms and see whether the pass rate changes.', overrides: {}, discriminates: false }
    ],
    outsideFacts: [{ text: 'The hospital car park was resurfaced last summer.', topic: 'the hospital car park' }, { text: 'The cleaning contractor changed its logo two years ago.', topic: 'the contractor\'s branding' }],
    loops: [
        { id: 'adding cleaners', polarity: '-', variables: ['shortfall', 'cleaners needed', 'cleaners requested', 'open positions', 'cleaners starting', 'cleaning staff', 'cleaning hours', 'hours per room', 'pass rate'], core: ['pass rate', 'cleaning staff'], mechanism: 'adding cleaners' },
        { id: 'lowering the standard', polarity: '-', variables: ['shortfall', 'lowering the standard', 'inspection standard'], core: ['shortfall', 'inspection standard'], mechanism: 'lowering the standard' }
    ]
};
