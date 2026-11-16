/**
 * Held-out scenario: a regional electricians' guild whose members move from apprentice to
 * journeyman to master over many years. The guild sizes its intake of apprentices from the work in
 * hand, so a slow spell cuts the intake to nothing; the missing apprentices become missing
 * journeymen years later, after work has recovered and kept growing, and jobs are turned away. Each
 * apprentice needs a master to supervise them, which caps how fast the guild can catch up. See
 * library.js for what every field means.
 *
 * @module utilities/scenarios/heldout/electricianTraining
 */

const S = (name, equation, inflows, outflows, units) => ({ name, type: 'stock', equation: String(equation), inflows, outflows, units });
const F = (name, equation, units) => ({ name, type: 'flow', equation, units });
const A = (name, equation, units) => ({ name, type: 'variable', equation: String(equation), units });

export const electricianTraining = {
    id: 'electricianTraining',
    title: 'Regional electricians\' guild',
    opening: 'Our electricians\' guild has been turning jobs away for years, even though we are taking on more apprentices than ever, and I want to understand why.',
    history: 'Twelve years ago we had about 96 apprentices, 192 journeymen and 360 master electricians, and about 3,300 jobs a month came to our members, which we could handle. Two years in, work slumped by about a fifth for two years, and in those two years we took on no new apprentices at all; by the end of the slump we were down to about 64. Work came back at the end of the fourth year and has grown steadily since, by about 2.4% a year, to about 4,400 jobs a month now. Since then we have taken on more apprentices than ever, four and a half to five a month, and we now have about 200 apprentices, 272 journeymen and 382 masters. We started turning jobs away as soon as work came back; it got worse for three or four years, to a peak of about 230 jobs a month seven and a half years in, and it is down to about 85 a month now.',
    timeUnits: 'months',
    model: {
        variables: [
            S('Normal Work', 3300, ['work growth'], [], 'jobs/month'),
            S('Apprentices', 96, ['taking on apprentices'], ['qualifying'], 'people'),
            S('Journeymen', 192, ['qualifying'], ['becoming masters'], 'people'),
            S('Masters', 360, ['becoming masters'], ['retiring'], 'people'),
            F('work growth', 'Normal_Work * work_growth_rate', 'jobs/month/month'),
            F('taking on apprentices', 'MIN(intake_wanted, MIN(places_opening_up, college_places))', 'people/month'),
            F('qualifying', 'Apprentices / apprenticeship_time', 'people/month'),
            F('becoming masters', 'Journeymen / time_as_journeyman', 'people/month'),
            F('retiring', 'Masters / time_as_master', 'people/month'),
            A('work growth rate', 0.002, '1/month'),
            A('slow spell', 'STEP(slump_depth, slump_start) - STEP(slump_depth, slump_end)', 'dimensionless'),
            A('slump depth', 0.2, 'dimensionless'),
            A('slump start', 24, 'months'),
            A('slump end', 48, 'months'),
            A('jobs requested', 'Normal_Work * (1 - slow_spell)', 'jobs/month'),
            A('qualified electricians', 'Journeymen + Masters', 'people'),
            A('work capacity', 'qualified_electricians * most_jobs_per_electrician', 'jobs/month'),
            A('most jobs per electrician', 6.6, 'jobs/(person*month)'),
            A('jobs turned away', 'MAX(0, jobs_requested - work_capacity)', 'jobs/month'),
            A('normal jobs per electrician', 6, 'jobs/(person*month)'),
            A('electricians wanted', 'jobs_requested / normal_jobs_per_electrician', 'people'),
            A('workforce gap', 'electricians_wanted - qualified_electricians', 'people'),
            A('intake wanted', 'MAX(minimum_intake, retiring + workforce_gap / intake_adjustment_time)', 'people/month'),
            A('minimum intake', 0, 'people/month'),
            A('intake adjustment time', 24, 'months'),
            A('apprentice places', 'Masters * apprentices_per_master', 'people'),
            A('apprentices per master', 0.6, 'dimensionless'),
            A('places opening up', 'apprentice_places / apprenticeship_time', 'people/month'),
            A('college places', 30, 'people/month'),
            A('apprenticeship time', 48, 'months'),
            A('time as journeyman', 96, 'months'),
            A('time as master', 180, 'months')
        ],
        relationships: [],
        specs: { startTime: 0, stopTime: 144, dt: 0.125, timeUnits: 'months' }
    },
    narrative: `I'm the secretary of our regional electricians' guild and I'm trying to make sense of the last twelve years. Our people start as apprentices, qualify as journeymen after about four years, and become master electricians after about eight more; masters retire after fifteen years or so. Twelve years ago we had about 96 apprentices, 192 journeymen and 360 masters, and about 3,300 jobs a month came to our members, which we could handle. Two years in, work slumped by about a fifth for two years. We decide how many apprentices to take on from the work in hand, and in those two slow years we took on no new apprentices at all; by the end of the slump we were down to about 64. Work came back at the end of the fourth year and has grown steadily since, by about 2.4% a year, to about 4,400 jobs a month now. Every apprentice has to be supervised by a master, so the masters we have limit how many apprentices we can take on. Since work came back we have taken on more apprentices than ever, four and a half to five a month, and we now have about 200 apprentices, 272 journeymen and 382 masters. Even so, we started turning jobs away as soon as work came back; it got worse for three or four years, to a peak of about 230 jobs a month seven and a half years in, and it is down to about 85 a month now. Separately, the price of copper cable has gone up every year.`,
    keyVariables: [
        { model: 'jobs turned away', glossary: 'jobs turned away', narrativeShape: 'rises then falls' },
        { model: 'Apprentices', glossary: 'apprentices', narrativeShape: 'falls then rises' }
    ],
    distractorTrends: [{ glossary: 'copper cable price', narrativeShape: 'rising' }],
    glossary: ['apprentices', 'journeymen', 'masters', 'taking on apprentices', 'qualifying', 'becoming masters', 'retiring', 'qualified electricians', 'work capacity', 'jobs requested', 'jobs turned away', 'electricians wanted', 'workforce gap', 'intake wanted', 'apprentice places', 'places opening up', 'college places'],
    glossaryToModel: {
        'apprentices': 'Apprentices',
        'journeymen': 'Journeymen',
        'masters': 'Masters',
        'taking on apprentices': 'taking on apprentices',
        'qualifying': 'qualifying',
        'becoming masters': 'becoming masters',
        'retiring': 'retiring',
        'qualified electricians': 'qualified electricians',
        'work capacity': 'work capacity',
        'jobs requested': 'jobs requested',
        'jobs turned away': 'jobs turned away',
        'electricians wanted': 'electricians wanted',
        'workforce gap': 'workforce gap',
        'intake wanted': 'intake wanted',
        'apprentice places': 'apprentice places',
        'places opening up': 'places opening up',
        'college places': 'college places'
    },
    mechanisms: [
        { id: 'intake follows the work in hand', topic: 'how the guild decides how many apprentices to take on', verdict: 'matters', fact: 'We decide how many apprentices to take on from the work in hand: enough to replace the masters who retire, plus enough to close any gap between the electricians today\'s work needs and the qualified electricians we have, so when work is slow we take on fewer or none.', off: { 'intake adjustment time': '1e9' }, signature: { from: 'jobs requested', to: 'taking on apprentices', polarity: '+' } },
        { id: 'masters supervise apprentices', topic: 'what limits how many apprentices the guild can take on', verdict: 'matters', fact: 'Every apprentice has to be supervised by a master, so the number of masters limits how many apprentices we can take on.', off: { 'apprentices per master': '1e9' }, signature: { from: 'masters', to: 'taking on apprentices', polarity: '+' } },
        { id: 'masters retiring', topic: 'when and how master electricians leave the trade', verdict: 'matters', fact: 'Master electricians retire after about fifteen years as masters.', off: { 'retiring': '0' }, signature: { from: 'masters', to: 'retiring', polarity: '+' } },
        { id: 'college places', topic: 'how many apprentices the college course can take', verdict: 'irrelevant', fact: 'The college\'s evening course for apprentices has room for about 30 new starters a month.', off: { 'college places': '1e9' } }
    ],
    goal: { variable: 'jobs turned away', measure: 'max', threshold: 100, direction: 'below', label: 'never turn away more than 100 jobs a month over the twelve years' },
    policies: [
        { id: 'take on faster', text: 'When work outgrows the guild, take on enough extra apprentices to close the gap within eighteen months instead of two years.', overrides: { 'intake adjustment time': '18' }, effective: false },
        { id: 'take on much faster', text: 'When work outgrows the guild, take on enough extra apprentices to close the gap within a year instead of two years.', overrides: { 'intake adjustment time': '12' }, effective: false },
        { id: 'keep the intake going', text: 'Keep taking on at least two apprentices a month, as we did before the slump, however slow work gets.', overrides: { 'minimum intake': '2' }, effective: true },
        { id: 'more masters supervising', text: 'Get four masters in five to supervise an apprentice instead of three in five.', overrides: { 'apprentices per master': '0.8' }, effective: false },
        { id: 'keep the intake going and take on faster', text: 'Do both: keep taking on at least two apprentices a month however slow work gets, and close any gap within eighteen months.', overrides: { 'minimum intake': '2', 'intake adjustment time': '18' }, effective: true, parts: ['keep the intake going', 'take on faster'] }
    ],
    misconception: 'take on faster',
    protected: {
        variables: ['jobs requested', 'Normal Work', 'work growth', 'work growth rate', 'slow spell', 'slump depth', 'slump start', 'slump end', 'retiring', 'time as master', 'apprenticeship time', 'time as journeyman', 'most jobs per electrician', 'normal jobs per electrician', 'work capacity', 'qualified electricians', 'jobs turned away', 'college places'],
        label: 'the work that comes to our members (about 3,300 jobs a month twelve years ago, the two-year slump of about a fifth, and growth of about 2.4% a year), how long it takes to qualify and to become a master, when masters retire, how many jobs an electrician can do in a month, and the college course'
    },
    levers: ['minimum intake', 'intake adjustment time', 'apprentices per master'],
    realistic: {
        text: 'What is realistic for us: we could promise to keep taking on up to three apprentices a month however slow work gets (we have never set a minimum); we could close a gap between the electricians the work needs and those we have within as little as a year instead of two; and with encouragement up to four masters in five could supervise an apprentice instead of three in five.',
        bounds: { 'minimum intake': { min: 0, max: 3 }, 'intake adjustment time': { min: 12 }, 'apprentices per master': { max: 0.8 } }
    },
    parameterFacts: [
        { id: 'stages', topic: 'how long apprentices, journeymen and masters spend at each stage', text: 'An apprenticeship takes about four years; a journeyman becomes a master after about eight more years; a master retires after about fifteen years as a master.' },
        { id: 'work per electrician', topic: 'how much work an electrician can do', text: 'We plan on each journeyman or master doing about 6 jobs a month; at a push they can do about 6.6, and anything beyond that we turn away. Apprentices do not count toward that.' },
        { id: 'intake rule', topic: 'how the guild decides how many apprentices to take on', text: 'Each month we aim to take on enough apprentices to replace the masters retiring, plus enough to close the gap between the electricians the current work needs (at 6 jobs each) and the journeymen and masters we have over about two years. We have never set a minimum: when work is slow enough we take on none.' },
        { id: 'supervision', topic: 'how many apprentices the masters can supervise', text: 'A master can supervise only one apprentice at a time and only about three masters in five have the time to, so we can have about 0.6 apprentices per master; a place frees up when its apprentice qualifies four years later.' },
        { id: 'work', topic: 'how much work comes to the guild and how it has changed', text: 'Twelve years ago about 3,300 jobs a month came to us; underlying work grows about 0.2% a month, and from the end of the second year to the end of the fourth it was about a fifth below that.' }
    ],
    perspectives: [
        { id: 'training officer', who: 'Grace, our training officer', account: 'We did this to ourselves. When work slumped we stopped taking on apprentices, because we size the intake from the work in hand. Four years later those missing apprentices were missing journeymen, just when work had come back and kept growing.', mechanism: 'intake follows the work in hand', signature: { from: 'jobs requested', to: 'taking on apprentices', polarity: '+' }, variant: {} },
        { id: 'guild president', who: 'Tom, the guild president', account: 'Our intake decisions had nothing to do with it. The college suspended its evening course for those two slow years, so nobody could have started an apprenticeship whatever we decided.', mechanism: 'college places', signature: { from: 'college places', to: 'taking on apprentices', polarity: '+' }, variant: { 'college places': '30 * (1 - STEP(1, 24) + STEP(1, 48))' } }
    ],
    experiments: [
        { id: 'hold the intake', text: 'Commit to taking on at least two apprentices a month for a while whatever the work, or check the college\'s records for whether new apprentices could start during the slump, and see whether jobs stop being turned away.', overrides: { 'minimum intake': '2' }, discriminates: true },
        { id: 'react faster', text: 'Close the gap between the electricians the work needs and those we have twice as fast for a while, and watch how many jobs are turned away.', overrides: { 'intake adjustment time': '*0.5' }, discriminates: false },
        { id: 'new van livery', text: 'Paint the guild\'s vans in a new livery and see whether fewer jobs are turned away.', overrides: {}, discriminates: false }
    ],
    outsideFacts: [{ text: 'The guild hall had its roof replaced three years ago.', topic: 'the guild hall building' }, { text: 'The national wiring regulations were reissued last year with a new cover design.', topic: 'the look of the wiring regulations book' }],
    loops: [
        { id: 'intake follows the work in hand', polarity: '-', variables: ['workforce gap', 'intake wanted', 'taking on apprentices', 'apprentices', 'qualifying', 'journeymen', 'qualified electricians'], core: ['workforce gap', 'apprentices'], mechanism: 'intake follows the work in hand' },
        { id: 'masters supervise apprentices', polarity: '+', variables: ['masters', 'apprentice places', 'places opening up', 'taking on apprentices', 'apprentices', 'qualifying', 'journeymen', 'becoming masters'], core: ['masters', 'apprentices'], mechanism: 'masters supervise apprentices' }
    ]
};
