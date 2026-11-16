/**
 * Held-out scenario: a parcel company's delivery van fleet, tracked together with the miles on it.
 * See library.js for what every field means. Written after the graders that score it were frozen;
 * never used to tune a grader.
 *
 * @module utilities/scenarios/heldout/deliveryVans
 */

const S = (name, equation, inflows, outflows, units) => ({ name, type: 'stock', equation: String(equation), inflows, outflows, units });
const F = (name, equation, units) => ({ name, type: 'flow', equation, units });
const A = (name, equation, units) => ({ name, type: 'variable', equation: String(equation), units });

export const deliveryVans = {
    id: 'deliveryVans',
    title: 'Parcel delivery van fleet',
    opening: 'Our delivery vans keep breaking down more and more, and the fleet seems to be getting worse every year. I want to understand why.',
    history: 'Ten years ago we ran about 200 vans averaging about 90,000 miles each, had about 400 breakdowns a year, and bought about 33 new vans a year. Two years in, head office cut the money we get for vans and repairs by 15%. Since then we have bought fewer new vans every year, down to about 17 a year now. We still run about 200 vans, but the average van now has about 111,000 miles on it, and breakdowns have climbed to about 610 a year.',
    timeUnits: 'years',
    model: {
        variables: [
            S('Vans', 200, ['buying vans'], ['retiring vans'], 'vans'),
            S('Fleet Miles', 18000000, ['miles driven'], ['miles retired'], 'miles'),
            F('buying vans', 'MAX(0, MIN(vans_wanted, vans_affordable))', 'vans/year'),
            F('retiring vans', 'MIN(vans_due_for_retirement, buying_vans + MAX(0, Vans - vans_needed) / fleet_adjustment_time)', 'vans/year'),
            F('miles driven', 'Vans * miles_per_van', 'miles/year'),
            F('miles retired', 'retiring_vans * average_mileage', 'miles/year'),
            A('average mileage', 'ZIDZ(Fleet_Miles, Vans)', 'miles/van'),
            A('miles per van', 15000, 'miles/(van*year)'),
            A('vans due for retirement', 'Vans / van_life', 'vans/year'),
            A('van life', 6, 'years'),
            A('vans wanted', 'vans_due_for_retirement + (vans_needed - Vans) / fleet_adjustment_time', 'vans/year'),
            A('fleet adjustment time', 1, 'years'),
            A('vans needed', 'parcel_demand / parcels_per_van', 'vans'),
            A('parcel demand', 2000000, 'parcels/year'),
            A('parcels per van', 10000, 'parcels/(van*year)'),
            A('vans affordable', 'money_for_vans / van_price', 'vans/year'),
            A('van price', 40000, 'dollars/van'),
            A('money for vans', 'MAX(0, van_budget - repair_share * repair_costs)', 'dollars/year'),
            A('van budget', 'base_van_budget * (1 - STEP(budget_cut, cut_year))', 'dollars/year'),
            A('base van budget', 2600000, 'dollars/year'),
            A('budget cut', 0.15, 'dimensionless'),
            A('cut year', 2, 'years'),
            A('repair share', 1, 'dimensionless'),
            A('repair costs', 'breakdowns * cost_per_breakdown', 'dollars/year'),
            A('cost per breakdown', 2500, 'dollars/breakdown'),
            A('breakdowns', 'Vans * breakdowns_per_van', 'breakdowns/year'),
            A('breakdowns per van', 'normal_breakdown_rate * (average_mileage / normal_mileage) ^ 2', 'breakdowns/(van*year)'),
            A('normal breakdown rate', 2, 'breakdowns/(van*year)'),
            A('normal mileage', 90000, 'miles/van')
        ],
        relationships: [],
        specs: { startTime: 0, stopTime: 10, dt: 0.0625, timeUnits: 'years' }
    },
    narrative: `I manage the delivery van fleet for a parcel company, and I'm trying to make sense of the last ten years. Ten years ago we ran about 200 vans; each covers about 15,000 miles a year, and the average van had about 90,000 miles on the clock. We had about 400 breakdowns a year and bought about 33 new vans a year, each one brand new with nothing on the clock. Two years in, head office cut the money we get for vans and repairs by 15%. Since then we have bought fewer new vans every year — about 17 last year. We only take an old van off the road when a new one arrives to replace it, so we still run about 200 vans, but they keep getting older: the average van now has about 111,000 miles on it. Breakdowns have climbed every year, to about 610 last year, and the repair bills with them. Separately, what we pay for drivers' uniforms has gone up every year.`,
    keyVariables: [
        { model: 'average mileage', glossary: 'average mileage', narrativeShape: 'rising' },
        { model: 'breakdowns', glossary: 'breakdowns', narrativeShape: 'rising' },
        { model: 'buying vans', glossary: 'buying vans', narrativeShape: 'falling' }
    ],
    distractorTrends: [{ glossary: 'driver uniform costs', narrativeShape: 'rising' }],
    glossary: ['vans', 'fleet miles', 'average mileage', 'buying vans', 'retiring vans', 'miles driven', 'miles retired', 'breakdowns', 'repair costs', 'van budget', 'parcel demand'],
    glossaryToModel: { 'vans': 'Vans', 'fleet miles': 'Fleet Miles', 'average mileage': 'average mileage', 'buying vans': 'buying vans', 'retiring vans': 'retiring vans', 'miles driven': 'miles driven', 'miles retired': 'miles retired', 'breakdowns': 'breakdowns', 'repair costs': 'repair costs', 'van budget': 'van budget', 'parcel demand': 'parcel demand' },
    mechanisms: [
        { id: 'mileage wear', topic: 'what makes vans break down', verdict: 'matters', fact: 'Vans with more miles on them break down a lot more often.', off: { 'breakdowns per van': 'normal_breakdown_rate' }, signature: { from: 'average mileage', to: 'breakdowns', polarity: '+' } },
        { id: 'repair squeeze', topic: 'where the money for repairs comes from, and how that affects buying new vans', verdict: 'matters', fact: 'Repairs are paid out of the same money as new vans, so every dollar spent on repairs is a dollar we cannot spend on vans.', off: { 'repair share': '0' }, signature: { from: 'repair costs', to: 'buying vans', polarity: '-' } },
        { id: 'budget cut', topic: 'how much money head office gives the fleet, and whether that has changed', verdict: 'matters', fact: 'Head office cut the money we get for vans and repairs by 15%, two years in.', off: { 'budget cut': '0' }, signature: { from: 'van budget', to: 'buying vans', polarity: '+' } },
        { id: 'replace before retiring', topic: 'when old vans are taken off the road', verdict: 'matters', fact: 'We only take an old van off the road when a new one arrives to replace it.', off: { 'retiring vans': 'vans_due_for_retirement' } },
        { id: 'early retirement of spare vans', topic: 'what happens when the fleet has more vans than the parcels need', verdict: 'irrelevant', fact: 'If we ever have more vans than the parcels need, we take the spare ones off the road straight away.', off: { 'retiring vans': 'MIN(vans_due_for_retirement, buying_vans)' } }
    ],
    goal: { variable: 'breakdowns', measure: 'max', threshold: 500, direction: 'below', label: 'keep breakdowns from ever going above 500 a year over the ten years' },
    policies: [
        { id: 'repairs off the van budget', text: 'Pay half of the repair bills out of the depots\' running budgets instead of the van budget.', overrides: { 'repair share': '0.5' }, effective: true },
        { id: 'keep vans longer', text: 'Keep vans for eight years instead of six before they are due to be replaced.', overrides: { 'van life': '8' }, effective: false },
        { id: 'plan the fleet twice a year', text: 'Revise the fleet plan every six months instead of once a year.', overrides: { 'fleet adjustment time': '0.5' }, effective: false },
        { id: 'cheaper vans', text: 'Buy a cheaper van model at $36,000 instead of $40,000.', overrides: { 'van price': '36000' }, effective: true },
        { id: 'plan the fleet every two years', text: 'Save planning effort by revising the fleet plan only every two years.', overrides: { 'fleet adjustment time': '2' }, effective: false },
        { id: 'repairs off the van budget and twice-yearly planning', text: 'Do both: pay half of the repair bills from the depots\' running budgets, and revise the fleet plan every six months.', overrides: { 'repair share': '0.5', 'fleet adjustment time': '0.5' }, effective: true, parts: ['repairs off the van budget', 'plan the fleet twice a year'] }
    ],
    misconception: 'keep vans longer',
    protected: {
        variables: ['parcel demand', 'parcels per van', 'miles per van', 'miles driven', 'miles retired', 'average mileage', 'normal breakdown rate', 'normal mileage', 'breakdowns per van', 'breakdowns', 'cost per breakdown', 'repair costs', 'base van budget', 'budget cut', 'cut year', 'van budget', 'money for vans', 'vans affordable'],
        label: 'how many parcels our customers send, how far each van drives and how many parcels it carries, how often vans break down at a given mileage and what a repair costs, and the money head office gives us for vans and repairs (including the 15% cut) — whatever of it repairs do not use is all there is for new vans'
    },
    limits: [{ flow: 'buying vans', uses: ['money for vans', 'van price'], ceiling: (v) => Math.max(0, v['money for vans']) / v['van price'], label: 'we cannot buy more vans than the money left for vans pays for (money for vans / van price)' }],
    levers: ['repair share', 'van price', 'van life', 'fleet adjustment time'],
    realistic: {
        text: 'What is realistic for us: finance would let us move at most half of the repair bills onto other budgets; the cheapest van that can do the job costs about $34,000 (we pay $40,000 now); we could keep vans anywhere from four to ten years; and we could revise the fleet plan as often as every six months.',
        bounds: { 'repair share': { min: 0.5, max: 1 }, 'van price': { min: 34000 }, 'van life': { min: 4, max: 10 }, 'fleet adjustment time': { min: 0.5 } }
    },
    parameterFacts: [
        { id: 'fleet and driving', topic: 'how many vans the parcels need and how far the vans drive', text: 'We deliver about 2 million parcels a year and a van carries about 10,000 parcels a year, so we need about 200 vans. Each van covers about 15,000 miles a year.' },
        { id: 'retirement rule', topic: 'when vans are due to be replaced and how the fleet is planned', text: 'A van is due to be replaced after about six years. Once a year we plan to buy enough vans to replace the ones that are due and close any gap between the vans the parcels need and the vans we have.' },
        { id: 'breakdown numbers', topic: 'how often vans break down and what a breakdown costs', text: 'A van with 90,000 miles on it breaks down about twice a year, and breakdowns go up with the square of mileage: a van with half as many miles again breaks down about two and a quarter times as often. A breakdown costs about $2,500 to fix.' },
        { id: 'money', topic: 'how much money there is for vans and what a van costs', text: 'Head office gave us $2.6 million a year for vans and repairs until the 15% cut. Repairs are paid first, and whatever is left buys new vans at $40,000 each.' }
    ],
    perspectives: [
        { id: 'fleet manager', who: 'Dana, our fleet manager', account: 'The cut started it, but the repair bills did the rest: older vans break down more, the repairs come out of the van money, so we buy even fewer vans and the fleet gets older still.', mechanism: 'repair squeeze', signature: { from: 'repair costs', to: 'buying vans', polarity: '-' }, variant: {} },
        { id: 'finance director', who: 'Marcus, our finance director', account: 'Repairs have nothing to do with how many vans we buy — they are paid out of the depots\' own budgets. We buy fewer vans because head office has trimmed the van budget a little more every year since the first cut.', mechanism: 'budget cut', signature: { from: 'van budget', to: 'buying vans', polarity: '+' }, variant: { 'repair share': '0', 'van budget': '1400000 - RAMP(90000, 2)' } }
    ],
    experiments: [
        { id: 'repair bills', text: 'Find out how much of the van money really goes on repairs, or move some repair bills onto another budget for a while, and watch what happens to van purchases.', overrides: { 'repair share': '*0.5' }, discriminates: true },
        { id: 'livery', text: 'Change the colour of the van livery and see whether drivers notice.', overrides: {}, discriminates: false }
    ],
    outsideFacts: [{ text: 'Our depots were repainted in the new company colours last year.', topic: 'the look of the depots' }, { text: 'The company switched payroll providers three years ago.', topic: 'payroll' }],
    loops: [
        { id: 'repair squeeze', polarity: '+', variables: ['average mileage', 'breakdowns', 'repair costs', 'buying vans', 'vans'], core: ['average mileage', 'repair costs', 'buying vans'], mechanism: 'repair squeeze' }
    ]
};
