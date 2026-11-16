/**
 * Held-out scenario: specialty mushroom growers in one region (see library.js for every field).
 *
 * When the price is above the cost of growing, growers start new growing rooms; a room takes
 * months to build and a first crop to get going, so new rooms keep arriving after the price has
 * fallen. The flood of mushrooms drives the price below cost, rooms are closed, rooms that are
 * worn out are stripped out, and the shortage that follows pushes the price back up. Price and
 * rooms in production swing for years.
 *
 * @module utilities/scenarios/heldout/mushroomGrowers
 */

const S = (name, equation, inflows, outflows, units) => ({ name, type: 'stock', equation: String(equation), inflows, outflows, units });
const F = (name, equation, units) => ({ name, type: 'flow', equation, units });
const A = (name, equation, units) => ({ name, type: 'variable', equation: String(equation), units });

export const mushroomGrowers = {
    id: 'mushroomGrowers',
    title: 'Regional specialty mushroom growers',
    opening: 'The price we get for our mushrooms, and the number of growing rooms in our region, have been swinging up and down for six years, and our growers want to understand why.',
    history: 'Six years ago the region had about 100 growing rooms in production and our mushrooms were fetching about $8.60 a kilo, well above the roughly $5 a kilo it costs to grow them. By the end of that first year there were about 170 rooms in production and the price had crashed to under $3 a kilo. Since then it has gone round and round: two and a half years in we were down to about 123 rooms with the price back near $5.70; a few months after the three-year mark we were up to about 138 rooms with the price near $4.50; in the middle of year five we were down to about 124 rooms and $5.70 again; at the five-year mark we were back up to about 137 rooms and $4.60; and today we have about 124 rooms and the price is about $5.65. The swings have been smaller since that first crash, but they have not stopped.',
    timeUnits: 'months',
    model: {
        variables: [
            S('Growing Rooms', 100, ['rooms coming into production'], ['rooms closed', 'rooms worn out'], 'rooms'),
            S('Rooms Under Construction', 0, ['new rooms started', 'rooms reopened'], ['rooms built'], 'rooms'),
            S('Rooms Starting Up', 0, ['rooms built'], ['rooms coming into production'], 'rooms'),
            S('Idle Rooms', 0, ['rooms closed'], ['rooms reopened', 'idle rooms scrapped'], 'rooms'),
            F('new rooms started', 'Growing_Rooms * building_response * profit_per_kilo / growing_cost', 'rooms/month'),
            F('rooms built', 'Rooms_Under_Construction / construction_time', 'rooms/month'),
            F('rooms coming into production', 'Rooms_Starting_Up / start_up_time', 'rooms/month'),
            F('rooms closed', 'Growing_Rooms * closing_response * loss_per_kilo / growing_cost', 'rooms/month'),
            F('rooms worn out', 'Growing_Rooms / room_lifetime', 'rooms/month'),
            F('rooms reopened', 'Idle_Rooms * reopening_response * profit_per_kilo / growing_cost', 'rooms/month'),
            F('idle rooms scrapped', 'Idle_Rooms / time_to_scrap', 'rooms/month'),
            A('production', 'Growing_Rooms * yield_per_room', 'kg/month'),
            A('price', 'reference_price * (reference_demand / production) ^ price_sensitivity', 'dollars/kg'),
            A('profit per kilo', 'MAX(0, price - growing_cost)', 'dollars/kg'),
            A('loss per kilo', 'MAX(0, growing_cost - price)', 'dollars/kg'),
            A('monthly losses', 'production * loss_per_kilo', 'dollars/month'),
            A('reference demand', 240000, 'kg/month'),
            A('reference price', 6, 'dollars/kg'),
            A('price sensitivity', 2, 'dimensionless'),
            A('yield per room', 2000, 'kg/(room*month)'),
            A('growing cost', 5, 'dollars/kg'),
            A('building response', 0.8, '1/month'),
            A('construction time', 6, 'months'),
            A('start up time', 3, 'months'),
            A('closing response', 0.15, '1/month'),
            A('room lifetime', 36, 'months'),
            A('reopening response', 0.1, '1/month'),
            A('time to scrap', 4, 'months')
        ],
        relationships: [],
        specs: { startTime: 0, stopTime: 72, dt: 0.125, timeUnits: 'months' }
    },
    narrative: `I manage the growers' association for specialty mushroom farms in our region, and our members want to understand the last six years. Six years ago the region had about 100 growing rooms in production and mushrooms were fetching about $8.60 a kilo, well above the roughly $5 a kilo it costs to grow them. With prices like that, growers started new rooms all over the region — within months there were more rooms being built than in production. A new room takes about six months to build and another three to get its first crop going, so for most of that first year the extra rooms were still on their way. By the end of the year about 170 rooms were producing and the price had crashed to under $3 a kilo. Growers closed rooms while they were losing money, rooms that had worn out were stripped out, nobody started new ones, and over the next year and a half the region shrank to about 123 rooms and the price came back to near $5.70. Then the building started again, and it has gone round and round ever since: up to about 138 rooms with the price near $4.50, down to about 124 and $5.70, up to about 137 and $4.60, and today about 124 rooms with the price around $5.65. The swings have been smaller since that first crash, but they have not stopped. Separately, the price of diesel for our delivery vans has gone up every year.`,
    keyVariables: [
        { model: 'Growing Rooms', glossary: 'growing rooms', narrativeShape: 'oscillating' },
        { model: 'price', glossary: 'price', narrativeShape: 'oscillating' }
    ],
    distractorTrends: [{ glossary: 'diesel price', narrativeShape: 'rising' }],
    glossary: ['growing rooms', 'rooms under construction', 'rooms starting up', 'idle rooms', 'new rooms started', 'rooms coming into production', 'rooms closed', 'rooms reopened', 'rooms worn out', 'production', 'price', 'monthly losses'],
    glossaryToModel: { 'growing rooms': 'Growing Rooms', 'rooms under construction': 'Rooms Under Construction', 'rooms starting up': 'Rooms Starting Up', 'idle rooms': 'Idle Rooms', 'new rooms started': 'new rooms started', 'rooms coming into production': 'rooms coming into production', 'rooms closed': 'rooms closed', 'rooms reopened': 'rooms reopened', 'rooms worn out': 'rooms worn out', 'production': 'production', 'price': 'price', 'monthly losses': 'monthly losses' },
    mechanisms: [
        { id: 'building when prices are high', topic: 'how growers decide to add growing rooms (starting new rooms, and how long they take to produce)', verdict: 'matters', fact: 'When the price is above what it costs us to grow, growers start new rooms, and the higher the price the more they start; a new room takes about six months to build and another three to get its first crop going.', off: { 'building response': '0' }, signature: { from: 'price', to: 'new rooms started', polarity: '+' } },
        { id: 'closing rooms when prices are low', topic: 'what growers do when the price falls below their costs', verdict: 'matters', fact: 'When the price drops below what it costs us to grow, growers close rooms and leave them standing idle, and the deeper the loss the more they close.', off: { 'closing response': '0' }, signature: { from: 'price', to: 'rooms closed', polarity: '-' } },
        { id: 'rooms wearing out', topic: 'how long a growing room lasts', verdict: 'matters', fact: 'A growing room wears out after about three years of cropping and has to be stripped out.', off: { 'room lifetime': '1e9' }, signature: { from: 'growing rooms', to: 'rooms worn out', polarity: '+' } },
        { id: 'reopening idle rooms', topic: 'whether rooms that were closed ever come back into use', verdict: 'irrelevant', fact: 'When prices are good, a few growers refit idle rooms and bring them back, though most idle rooms are stripped out within a few months.', off: { 'reopening response': '0' } }
    ],
    goal: { variable: 'monthly losses', measure: 'max', threshold: 500000, direction: 'below', label: 'keep the region\'s growers from ever losing more than $500,000 a month between them' },
    policies: [
        { id: 'build at half the pace', text: 'Agree as an association that, when prices are high, members start new rooms at half the pace they do now.', overrides: { 'building response': '0.4' }, effective: true },
        { id: 'faster building', text: 'Get new rooms built in 3 months instead of 6.', overrides: { 'construction time': '3' }, effective: false },
        { id: 'somewhat faster building', text: 'Get new rooms built in 4 months instead of 6.', overrides: { 'construction time': '4' }, effective: false },
        { id: 'longer-lasting rooms', text: 'Refurbish rooms so they last five years instead of three.', overrides: { 'room lifetime': '60' }, effective: false },
        { id: 'half the pace and faster building', text: 'Do both: start new rooms at half the pace and get them built in 3 months instead of 6.', overrides: { 'building response': '0.4', 'construction time': '3' }, effective: true, parts: ['build at half the pace', 'faster building'] }
    ],
    misconception: 'faster building',
    protected: { variables: ['reference demand', 'reference price', 'price sensitivity', 'price'], label: 'how our buyers behave: how much they take at a given price, and how the price moves with how much we pick' },
    levers: ['building response', 'construction time', 'start up time', 'closing response', 'room lifetime', 'reopening response', 'time to scrap'],
    realistic: {
        text: 'What is realistic for us: members might agree to start new rooms at no less than half the pace they do now; a room cannot be built in less than 3 months or get its first crop going in less than 2; growers could close loss-making rooms at most half again as fast as they do; and refurbishing could make a room last at most five years instead of three; refitting idle rooms could go at most half again as fast as it does; and an idle room is stripped out after no less than 2 months and no more than 8 (about 4 now).',
        bounds: { 'building response': { min: 0.4 }, 'construction time': { min: 3 }, 'start up time': { min: 2 }, 'closing response': { max: 0.225 }, 'room lifetime': { max: 60 }, 'reopening response': { max: 0.15 }, 'time to scrap': { min: 2, max: 8 } }
    },
    parameterFacts: [
        { id: 'market', topic: 'how much the buyers take and how the price moves with supply', text: 'At $6 a kilo our buyers take about 240 tonnes a month. The price moves with the square of the shortage or glut: pick 10% more than they want at $6 and the price falls to about $4.96; pick 10% less and it rises to about $7.41.' },
        { id: 'rooms and costs', topic: 'how much a room produces and what it costs to grow', text: 'A growing room produces about 2 tonnes a month, and it costs about $5 a kilo to grow.' },
        { id: 'building pace', topic: 'how many new rooms growers start when prices are good', text: 'When the price is 20% above our cost, growers start new rooms equal to about 16% of the rooms already in production each month; at 10% above, about 8%. A new room takes about six months to build and three more to get its first crop going.' },
        { id: 'closing pace', topic: 'how many rooms growers close when they are losing money', text: 'When the price is 20% below our cost, growers close about 3% of the rooms in production each month. A room wears out after about three years and is stripped out.' },
        { id: 'idle rooms', topic: 'what happens to rooms that have been closed', text: 'Most idle rooms are stripped out within about four months. When the price is 20% above our cost, about 2% of the idle rooms a month are refitted, which takes as long as building a new room.' }
    ],
    perspectives: [
        { id: 'grower', who: 'Ines, who runs the biggest farm in the region', account: 'It is the building. Whenever prices are good everyone starts new rooms, and by the time they are producing, nine months later, there are far too many of them.', mechanism: 'building when prices are high', signature: { from: 'price', to: 'new rooms started', polarity: '+' }, variant: { 'reopening response': '0' } },
        { id: 'compost supplier', who: 'Marco, who supplies compost to every farm', account: 'Hardly anyone built new rooms. What flooded the market were the empty rooms left over from the last bust: when prices were good, growers refitted their idle rooms and brought them back.', mechanism: 'reopening idle rooms', signature: { from: 'price', to: 'rooms reopened', polarity: '+' }, variant: { 'Idle Rooms': '220', 'reopening response': '1', 'building response': '0.2', 'time to scrap': '1e9' } }
    ],
    experiments: [
        { id: 'track idle rooms', text: 'Count the idle rooms in the region and track how many are refitted and brought back, check the compost and equipment orders for refits, or hold off refits for a season.', overrides: { 'reopening response': '*0' }, discriminates: true },
        { id: 'new labels', text: 'Put a new regional label on our punnets and see whether buyers notice.', overrides: {}, discriminates: false }
    ],
    outsideFacts: [{ text: 'The farmers market moved from Fridays to Saturdays last year.', topic: 'the farmers market schedule' }, { text: 'A new bypass road opened near the packing shed.', topic: 'local roads' }],
    loops: [
        { id: 'building when prices are high', polarity: '-', variables: ['growing rooms', 'production', 'price', 'new rooms started', 'rooms under construction', 'rooms starting up'], core: ['growing rooms', 'new rooms started'], mechanism: 'building when prices are high' }
    ]
};
