/**
 * Held-out scenario: a community food bank whose volunteers bring in their friends, while the
 * families it serves grow by word of mouth. Each volunteer's share of the families is the workload;
 * a heavy workload wears people down over a few months, and worn-down volunteers quit. The volunteer
 * team grows, then shrinks as the families outrun it. See library.js for what every field means.
 *
 * @module utilities/scenarios/heldout/foodBank
 */

const S = (name, equation, inflows, outflows, units) => ({ name, type: 'stock', equation: String(equation), inflows, outflows, units });
const F = (name, equation, units) => ({ name, type: 'flow', equation, units });
const A = (name, equation, units) => ({ name, type: 'variable', equation: String(equation), units });

export const foodBank = {
    id: 'foodBank',
    title: 'Community food bank volunteers',
    opening: 'Our food bank\'s volunteer team grew for a while and has been shrinking ever since, even though we are busier than ever, and I want to understand why.',
    history: 'Three years ago we had about 40 regular volunteers looking after about 200 families, roughly 5 families each. The number of families we serve has grown the whole time and is now about 800. The volunteer team grew to a high of about 62 around a year and a half in, and has been shrinking since; we are down to about 31, each looking after about 26 families.',
    timeUnits: 'months',
    model: {
        variables: [
            S('Volunteers', 40, ['recruiting'], ['quitting'], 'volunteers'),
            S('Fatigue', 1, ['tiring'], [], 'dimensionless'),
            S('Potential Volunteers', 210, ['quitting'], ['recruiting'], 'volunteers'),
            S('Families Served', 200, ['new families'], ['families moving on'], 'families'),
            S('Families Not Yet Reached', 1000, ['families moving on'], ['new families'], 'families'),
            F('recruiting', 'friends_joining + recruitment_fairs', 'volunteers/month'),
            F('quitting', 'Volunteers * normal_quit_fraction * Fatigue', 'volunteers/month'),
            F('tiring', '(stress - Fatigue) / fatigue_time', '1/month'),
            F('new families', 'agency_referrals + family_word_of_mouth', 'families/month'),
            F('families moving on', 'Families_Served / time_on_rolls', 'families/month'),
            A('friends joining', 'Volunteers * friend_recruiting_rate * untapped_share', 'volunteers/month'),
            A('untapped share', 'Potential_Volunteers / willing_people', 'dimensionless'),
            A('willing people', 'Potential_Volunteers + Volunteers', 'volunteers'),
            A('friend recruiting rate', 0.12, '1/month'),
            A('recruitment fairs', 0.25, 'volunteers/month'),
            A('normal quit fraction', 0.06, '1/month'),
            A('workload', 'Families_Served / MAX(Volunteers, 1)', 'families/volunteer'),
            A('manageable load', 5, 'families/volunteer'),
            A('stress', 'workload / manageable_load', 'dimensionless'),
            A('fatigue time', 6, 'months'),
            A('agency referrals', 4, 'families/month'),
            A('family word of mouth', 'Families_Served * word_of_mouth_fraction * unreached_share', 'families/month'),
            A('unreached share', 'Families_Not_Yet_Reached / families_in_need', 'dimensionless'),
            A('word of mouth fraction', 0.15, '1/month'),
            A('families in need', 'Families_Not_Yet_Reached + Families_Served', 'families'),
            A('time on rolls', 20, 'months')
        ],
        relationships: [],
        specs: { startTime: 0, stopTime: 36, dt: 0.0625, timeUnits: 'months' }
    },
    narrative: `I coordinate the volunteers at a community food bank and I'm trying to make sense of the last three years. When I started we had about 40 regular volunteers looking after about 200 families, roughly 5 families each, which felt about right. Most new volunteers come because a friend who already helps out brings them along, and we also run a stall at community fairs that brings in one now and then. Most new families hear about us from other families we already help, and the social-service agencies send us a few each month; families tend to stay with us for a year or two. The number of families we serve has grown the whole time and is now about 800. The volunteer team grew too, to a high of about 62 around a year and a half in, but it has been shrinking ever since: we are down to about 31, each looking after about 26 families. Separately, the diesel for our delivery van has cost more every year.`,
    keyVariables: [
        { model: 'Volunteers', glossary: 'volunteers', narrativeShape: 'rises then falls' },
        { model: 'Families Served', glossary: 'families served', narrativeShape: 'rising' }
    ],
    distractorTrends: [{ glossary: 'delivery van diesel cost', narrativeShape: 'rising' }],
    glossary: ['volunteers', 'recruiting', 'quitting', 'workload', 'fatigue', 'families served', 'new families', 'families moving on', 'recruitment fairs'],
    glossaryToModel: { 'volunteers': 'Volunteers', 'recruiting': 'recruiting', 'quitting': 'quitting', 'workload': 'workload', 'fatigue': 'Fatigue', 'families served': 'Families Served', 'new families': 'new families', 'families moving on': 'families moving on', 'recruitment fairs': 'recruitment fairs' },
    mechanisms: [
        { id: 'friends bringing friends', topic: 'how new volunteers come to the food bank', verdict: 'matters', fact: 'Most new volunteers join because a friend who already volunteers brings them along.', off: { 'friend recruiting rate': '0' }, signature: { from: 'volunteers', to: 'recruiting', polarity: '+' } },
        { id: 'worn-out volunteers quit', topic: 'why volunteers stop coming', verdict: 'matters', fact: 'When each volunteer has a lot of families to look after, they get worn out over a few months, and the more worn out they are, the more likely they are to quit.', off: { 'quitting': 'Volunteers * normal_quit_fraction' }, signature: { from: 'fatigue', to: 'quitting', polarity: '+' } },
        { id: 'families telling families', topic: 'how new families find the food bank', verdict: 'matters', fact: 'Most new families come because a family we already help told them about us.', off: { 'word of mouth fraction': '0' }, signature: { from: 'families served', to: 'new families', polarity: '+' } },
        { id: 'agency referrals', topic: 'whether social-service agencies send families to the food bank', verdict: 'matters', fact: 'The social-service agencies send us a few families every month.', off: { 'agency referrals': '0' } }
    ],
    goal: { variable: 'Volunteers', measure: 'atTime', time: 36, threshold: 80, direction: 'above', label: 'have at least 80 volunteers at the end of the third year' },
    policies: [
        { id: 'double the fair stalls', text: 'Run twice as many recruitment stalls at community fairs.', overrides: { 'recruitment fairs': '0.5' }, effective: false },
        { id: 'triple the fair stalls', text: 'Run three times as many recruitment stalls at community fairs.', overrides: { 'recruitment fairs': '0.75' }, effective: false },
        { id: 'pre-packed boxes', text: 'Pre-pack the food boxes and book families into appointment slots, so each volunteer can comfortably look after 7.5 families instead of 5.', overrides: { 'manageable load': '7.5' }, effective: true },
        { id: 'pre-packed boxes and double the fair stalls', text: 'Do both: pre-pack the boxes with appointment slots, and run twice as many fair stalls.', overrides: { 'manageable load': '7.5', 'recruitment fairs': '0.5' }, effective: true, parts: ['pre-packed boxes', 'double the fair stalls'] }
    ],
    misconception: 'double the fair stalls',
    protected: {
        variables: ['agency referrals', 'families in need', 'families not yet reached', 'families served', 'new families', 'families moving on', 'family word of mouth', 'word of mouth fraction', 'unreached share', 'time on rolls', 'friend recruiting rate', 'friends joining', 'untapped share', 'potential volunteers', 'willing people', 'recruiting', 'normal quit fraction', 'quitting', 'fatigue', 'fatigue time', 'tiring', 'stress', 'workload'],
        label: 'the families who need us and how they find us (about 1,200 families in our area), how many people in town would ever volunteer, and how volunteers feel, bring friends and quit'
    },
    levers: ['recruitment fairs', 'manageable load'],
    realistic: {
        text: 'What is realistic for us: we could run at most three times as many recruitment stalls at fairs as we do now, and better ways of working (pre-packing, appointment slots) could at most get each volunteer comfortably looking after 7.5 families instead of 5.',
        bounds: { 'recruitment fairs': { max: 0.75 }, 'manageable load': { max: 7.5 } }
    },
    parameterFacts: [
        { id: 'friend recruiting', topic: 'how many new volunteers friends bring in', text: 'Each month about 12 in every 100 volunteers bring a friend who joins, though that slows as more of the roughly 250 people in town who would ever volunteer are already with us.' },
        { id: 'fair stalls', topic: 'how many volunteers the fair stalls bring in', text: 'Our stall at community fairs brings in about one new volunteer every four months.' },
        { id: 'quitting', topic: 'how many volunteers quit', text: 'When the work feels manageable, about 6 in every 100 volunteers quit each month; a volunteer who is twice as worn out as usual is twice as likely to quit.' },
        { id: 'workload and wear', topic: 'how much work feels manageable and how quickly volunteers get worn out', text: 'About 5 families per volunteer feels manageable. When the workload changes, how worn out people feel catches up with it over about six months.' },
        { id: 'families', topic: 'how families come to the food bank and how long they stay', text: 'Each month the agencies send us about 4 families, and about 15 in every 100 families we help bring in another family, though that slows as we reach more of the roughly 1,200 families in our area who need us. Families stay with us for about 20 months on average.' }
    ],
    perspectives: [
        { id: 'volunteer lead', who: 'Maria, our longest-serving volunteer lead', account: 'People are worn out. As more families came to us, each volunteer had more to carry, the tiredness built up, and the most tired ones quit — which leaves even more for the rest.', mechanism: 'worn-out volunteers quit', signature: { from: 'fatigue', to: 'quitting', polarity: '+' }, variant: {} },
        { id: 'board treasurer', who: 'Dev, our board treasurer', account: "It isn't the workload — people leave at the same rate they always have. In the first year everyone brought their friends along; after that people simply stopped asking their friends, so new volunteers dried up.", mechanism: 'friends bringing friends', signature: { from: 'volunteers', to: 'recruiting', polarity: '+' }, variant: { 'quitting': 'Volunteers * normal_quit_fraction', 'friend recruiting rate': 'MAX(0, 0.12 - RAMP(0.006, 8))' } }
    ],
    experiments: [
        { id: 'lighten the load', text: 'Change how many families each volunteer has to look after — pre-pack boxes, book appointment slots, or cap each volunteer\'s families for a while — and watch whether fewer volunteers quit.', overrides: { 'manageable load': '*1.5' }, discriminates: true },
        { id: 'new aprons', text: 'Give every volunteer a new branded apron and see whether anyone stays longer.', overrides: {}, discriminates: false }
    ],
    outsideFacts: [{ text: 'The church hall we use was repainted last spring.', topic: 'the building the food bank uses' }, { text: 'Our main supermarket donor changed its logo this year.', topic: 'the supermarket that donates food' }],
    loops: [
        { id: 'friends bringing friends', polarity: '+', variables: ['volunteers', 'recruiting'], core: ['volunteers', 'recruiting'], mechanism: 'friends bringing friends' },
        { id: 'worn-out volunteers quit', polarity: '+', variables: ['volunteers', 'workload', 'fatigue', 'quitting'], core: ['volunteers', 'workload', 'fatigue'], mechanism: 'worn-out volunteers quit' },
        { id: 'families telling families', polarity: '+', variables: ['families served', 'new families'], core: ['families served', 'new families'], mechanism: 'families telling families' }
    ]
};
