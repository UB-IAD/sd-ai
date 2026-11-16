/**
 * Held-out scenario: a valley's shared groundwater, drawn on by a growing market town and by
 * irrigated fruit orchards. Written after the graders that score it were frozen; every field means
 * what library.js's header says.
 *
 * Rain recharges the aquifer at a steady rate. The town's pumping follows its growing population,
 * the orchards' pumping follows their acreage, and both fall as the water table drops, because a
 * well gives less when there is less water standing above the pump. Orchards are planted while
 * they pay and pulled out when they do not; a deeper water table makes every acre-foot dearer to
 * lift and leaves the trees short of water, so the orchards stop paying. The water table falls
 * until the orchards just break even, which pins it at a depth set by the orchards' economics:
 * water one user leaves in the ground is taken up by the other. Restricting the town, deepening
 * its wells or adding recharge leaves that depth where it is; only a limit on the combined draw
 * moves it.
 *
 * @module utilities/scenarios/heldout/valleyWater
 */

const S = (name, equation, inflows, outflows, units) => ({ name, type: 'stock', equation: String(equation), inflows, outflows, units });
const F = (name, equation, units) => ({ name, type: 'flow', equation, units });
const A = (name, equation, units) => ({ name, type: 'variable', equation: String(equation), units });
const L = (name, equation, points, units) => ({ name, type: 'variable', equation: String(equation), graphicalFunction: { points }, units });

/** A well gives everything asked of it with 160 feet of water above the pump, less in proportion below that. */
const WELL_YIELD = [{ x: 0, y: 0 }, { x: 160, y: 1 }, { x: 320, y: 1 }];

export const valleyWater = {
    id: 'valleyWater',
    title: 'Valley groundwater board',
    opening: 'The water table under our valley has been dropping for twenty years, the town keeps running short in summer, and the orchards that boomed are now being pulled out, and I want to understand why.',
    history: 'Twenty years ago the water table was about 50 feet below ground. The town had about 20,000 people and pumped about 3,750 acre-feet a year, about 250 short of what households wanted; the orchards covered about 8,000 acres and pumped about 22,500. The town has grown about 3% a year, to about 36,400 people. Orchard acreage grew to a peak of about 13,200 acres around eleven and a half years in and has been shrinking since, to about 11,400 acres now, and the trees give about a third less fruit per acre than they did. The water table has dropped the whole time and is now about 98 feet down. The town\'s wells now fall about 2,600 acre-feet a year short of what households want, about a third of it, and summer restrictions have gone from rare to the norm.',
    timeUnits: 'years',
    model: {
        variables: [
            S('Groundwater', 700000, ['recharge'], ['town pumping', 'farm pumping', 'golf course pumping'], 'acre-feet'),
            S('Town Population', 20000, ['population growth'], [], 'people'),
            S('Orchard Acreage', 8000, ['planting'], ['orchards pulled out'], 'acres'),
            F('recharge', 'rain_recharge + recharge_scheme', 'acre-feet/year'),
            F('town pumping', 'town_demand * town_well_yield * pumping_allowed_share', 'acre-feet/year'),
            F('farm pumping', 'farm_demand * farm_well_yield * pumping_allowed_share', 'acre-feet/year'),
            F('golf course pumping', 'golf_course_use', 'acre-feet/year'),
            F('population growth', 'Town_Population * town_growth_rate', 'people/year'),
            F('planting', 'Orchard_Acreage * planting_rate * MAX(0, orchard_profit_margin)', 'acres/year'),
            F('orchards pulled out', 'Orchard_Acreage * pull_out_rate * MAX(0, -orchard_profit_margin)', 'acres/year'),
            A('rain recharge', 26500, 'acre-feet/year'),
            A('recharge scheme', 0, 'acre-feet/year'),
            A('golf course use', 300, 'acre-feet/year'),
            A('aquifer base depth', 400, 'feet'),
            A('storage per foot', 2000, 'acre-feet/foot'),
            A('depth to water', 'aquifer_base_depth - Groundwater / storage_per_foot', 'feet'),
            A('town well depth', 200, 'feet'),
            A('farm well depth', 200, 'feet'),
            A('town water column', 'town_well_depth - depth_to_water', 'feet'),
            A('farm water column', 'farm_well_depth - depth_to_water', 'feet'),
            L('town well yield', 'town_water_column', WELL_YIELD, 'dimensionless'),
            L('farm well yield', 'farm_water_column', WELL_YIELD, 'dimensionless'),
            A('water use per person', 0.2, 'acre-feet/(person*year)'),
            A('town demand', 'Town_Population * water_use_per_person', 'acre-feet/year'),
            A('water per acre', 3, 'acre-feet/(acre*year)'),
            A('farm demand', 'Orchard_Acreage * water_per_acre', 'acre-feet/year'),
            A('pumping wanted', 'town_demand * town_well_yield + farm_demand * farm_well_yield', 'acre-feet/year'),
            A('basin pumping cap', 1e9, 'acre-feet/year'),
            A('pumping allowed share', 'MIN(1, basin_pumping_cap / MAX(pumping_wanted, 1))', 'dimensionless'),
            A('town shortfall', 'town_demand - town_pumping', 'acre-feet/year'),
            A('irrigation met', 'farm_well_yield * pumping_allowed_share', 'dimensionless'),
            A('full crop value', 3000, 'dollars/(acre*year)'),
            A('crop value per acre', 'full_crop_value * irrigation_met', 'dollars/(acre*year)'),
            A('growing cost', 1700, 'dollars/(acre*year)'),
            A('lift cost', 2.5, 'dollars/(acre-foot*foot)'),
            A('pumping cost per acre', 'lift_cost * depth_to_water * water_per_acre * irrigation_met', 'dollars/(acre*year)'),
            A('orchard profit', 'crop_value_per_acre - growing_cost - pumping_cost_per_acre', 'dollars/(acre*year)'),
            A('orchard profit margin', 'orchard_profit / full_crop_value', 'dimensionless'),
            A('planting rate', 0.3, '1/year'),
            A('pull out rate', 0.3, '1/year'),
            A('town growth rate', 0.03, '1/year')
        ],
        relationships: [],
        specs: { startTime: 0, stopTime: 20, dt: 0.0625, timeUnits: 'years' }
    },
    narrative: `I chair our valley's groundwater board, and I'm trying to make sense of the last twenty years. Everyone in the valley pumps from the same groundwater, and rain soaks back into it at a fairly steady rate. Twenty years ago the water table was about 50 feet below ground. The market town had about 20,000 people and pumped about 3,750 acre-feet a year, about 250 short of what households wanted; the fruit orchards covered about 8,000 acres and pumped about 22,500. The town has grown about 3% a year and now has about 36,400 people. While the orchards paid well, growers kept planting: acreage grew to a peak of about 13,200 acres around eleven and a half years in. Since then growers have been pulling trees out, and we are down to about 11,400 acres; the trees that are left give about a third less fruit per acre than they did. The water table has dropped the whole time and is now about 98 feet down. The town's wells now fall about 2,600 acre-feet a year short of what households want, about a third of it, and summer restrictions have gone from rare to the norm. Separately, the number of visitors to the valley's harvest festival has gone up every year.`,
    keyVariables: [
        { model: 'depth to water', glossary: 'depth to water', narrativeShape: 'rising' },
        { model: 'Orchard Acreage', glossary: 'orchard acreage', narrativeShape: 'rises then falls' },
        { model: 'town shortfall', glossary: 'town shortfall', narrativeShape: 'rising' }
    ],
    distractorTrends: [{ glossary: 'harvest festival visitors', narrativeShape: 'rising' }],
    glossary: ['groundwater', 'depth to water', 'recharge', 'town population', 'town demand', 'town pumping', 'town well yield', 'town shortfall', 'orchard acreage', 'planting', 'orchards pulled out', 'farm demand', 'farm pumping', 'farm well yield', 'pumping cost', 'orchard profit'],
    glossaryToModel: {
        'groundwater': 'Groundwater',
        'depth to water': 'depth to water',
        'recharge': 'recharge',
        'town population': 'Town Population',
        'town demand': 'town demand',
        'town pumping': 'town pumping',
        'town well yield': 'town well yield',
        'town shortfall': 'town shortfall',
        'orchard acreage': 'Orchard Acreage',
        'planting': 'planting',
        'orchards pulled out': 'orchards pulled out',
        'farm demand': 'farm demand',
        'farm pumping': 'farm pumping',
        'farm well yield': 'farm well yield',
        'pumping cost': 'pumping cost per acre',
        'orchard profit': 'orchard profit'
    },
    mechanisms: [
        { id: 'wells give less as the table drops', topic: 'what happens to the wells, the town\'s and the orchards\', as the water table drops', verdict: 'matters', fact: 'As the water table drops, every well in the valley, the town\'s and the orchards\' alike, gives less water, because there is less water standing above the pump; trees that get less water give less fruit.', off: { 'town well yield': '1', 'farm well yield': '1' }, signature: { from: 'depth to water', to: 'town pumping', polarity: '-' } },
        { id: 'deeper water costs more to pump', topic: 'what pumping costs the orchards and how that changes as the water table drops', verdict: 'matters', fact: 'The deeper the water table, the more it costs the orchards to lift every acre-foot they pump.', off: { 'lift cost': '0' }, signature: { from: 'depth to water', to: 'pumping cost', polarity: '+' } },
        { id: 'orchards planted while they pay', topic: 'what makes growers plant new orchards', verdict: 'matters', fact: 'Growers plant more orchards while the orchards they have are paying, and the better they pay the more they plant.', off: { 'planting rate': '0' }, signature: { from: 'orchard profit', to: 'planting', polarity: '+' } },
        { id: 'town keeps growing', topic: 'how the town\'s population and its water needs have changed', verdict: 'matters', fact: 'The town has grown about 3% a year, and every new household needs water.', off: { 'town growth rate': '0' } },
        { id: 'golf course well', topic: 'whether anyone else pumps from the valley\'s groundwater', verdict: 'irrelevant', fact: 'The golf course outside town has its own well and pumps about 300 acre-feet a year for its greens, and always has.', off: { 'golf course use': '0' } }
    ],
    goal: { variable: 'depth to water', measure: 'atTime', time: 20, threshold: 80, direction: 'below', label: 'have the water table no deeper than 80 feet below ground at the end of the twentieth year' },
    policies: [
        { id: 'cap combined pumping', text: 'Cap the combined pumping from the town\'s and the orchards\' wells at 26,500 acre-feet a year, about what rain puts back, cutting every well back by the same share whenever the total would go over.', overrides: { 'basin pumping cap': '26500' }, effective: true },
        { id: 'town restrictions', text: 'Put the town on permanent summer restrictions that cut what each household uses by a quarter.', overrides: { 'water use per person': '0.15' }, effective: false },
        { id: 'deeper town wells', text: 'Drill the town\'s wells to 300 feet instead of 200, so they keep giving water as the table drops.', overrides: { 'town well depth': '300' }, effective: false },
        { id: 'recharge ponds', text: 'Build recharge ponds that put an extra 3,000 acre-feet a year back into the ground.', overrides: { 'recharge scheme': '3000' }, effective: false },
        { id: 'small recharge ponds', text: 'Build a smaller set of recharge ponds that put an extra 1,500 acre-feet a year back into the ground.', overrides: { 'recharge scheme': '1500' }, effective: false },
        { id: 'cap combined pumping and recharge ponds', text: 'Do both: cap combined pumping at 26,500 acre-feet a year, and build recharge ponds that put an extra 3,000 acre-feet a year back into the ground.', overrides: { 'basin pumping cap': '26500', 'recharge scheme': '3000' }, effective: true, parts: ['cap combined pumping', 'recharge ponds'] }
    ],
    misconception: 'town restrictions',
    protected: {
        variables: ['rain recharge', 'golf course use', 'town population', 'population growth', 'town growth rate', 'storage per foot', 'aquifer base depth', 'farm well yield', 'farm well depth', 'water per acre', 'full crop value', 'growing cost', 'lift cost', 'planting rate', 'pull out rate', 'planting', 'orchards pulled out', 'orchard profit'],
        label: 'how much rain soaks into the ground (about 26,500 acre-feet a year) and what the golf course pumps, how fast the town grows, how the aquifer and the orchards\' wells behave, what it costs growers to grow fruit and lift water, and how growers decide to plant or pull out orchards'
    },
    levers: ['basin pumping cap', 'recharge scheme', 'water use per person', 'town well depth'],
    realistic: {
        text: 'What is realistic for us: the board could cap the combined pumping from the town\'s and the orchards\' wells at no less than 25,000 acre-feet a year (today nothing is capped and every well pumps what it can; the golf course well would stay outside the cap); recharge ponds could put at most 3,000 acre-feet a year extra into the ground; summer restrictions could cut what each town household uses by at most a quarter; and the town could drill its wells at most 300 feet deep instead of 200.',
        bounds: { 'basin pumping cap': { min: 25000 }, 'recharge scheme': { min: 0, max: 3000 }, 'water use per person': { min: 0.15 }, 'town well depth': { max: 300 } }
    },
    parameterFacts: [
        { id: 'aquifer', topic: 'how much water the valley\'s groundwater holds and how much rain puts back', text: 'Rain puts about 26,500 acre-feet a year back into the ground. Every 2,000 acre-feet taken out beyond that drops the water table about a foot; twenty years ago it was about 50 feet down.' },
        { id: 'wells', topic: 'how much water a well gives as the water table drops', text: 'Every well in the valley, the town\'s and the orchards\', reaches down to 200 feet. A well gives all the water it is asked for while at least 160 feet of water stands above its pump; with less, it gives less in proportion: twenty years ago, with 150 feet above the pumps, a well gave about 94% of what was asked, and with 80 feet above the pump it gives half.' },
        { id: 'town water', topic: 'how much water the town needs and how fast it grows', text: 'Each person in town uses about 0.2 acre-feet a year. Twenty years ago the town had about 20,000 people, and it grows about 3% a year.' },
        { id: 'orchard water and money', topic: 'how much water an orchard needs and what it earns and costs', text: 'An acre of orchard needs about 3 acre-feet a year. With all the water it needs, an acre brings in about $3,000 a year, and less in proportion to any water it goes short of. Growing costs about $1,700 an acre a year, and lifting water costs about $2.50 per acre-foot for every foot it is lifted.' },
        { id: 'planting and pulling out', topic: 'how fast growers plant or pull out orchards', text: 'When an acre of orchard clears 10% of its full-water value in profit, growers plant about 3 new acres a year for every 100 they have; when it loses 10%, they pull out about 3 acres in every 100.' },
        { id: 'golf course', topic: 'what the golf course pumps', text: 'The golf course pumps about 300 acre-feet a year, whatever the water table does.' }
    ],
    perspectives: [
        { id: 'board hydrologist', who: 'Lena, the board\'s hydrologist', account: 'The orchards rise and fall with the water. While the table was high, lifting water was cheap and growers planted; as it dropped, every acre-foot cost more to lift and the trees went short, so the orchards stopped paying and growers pulled them out.', mechanism: 'deeper water costs more to pump', signature: { from: 'depth to water', to: 'pumping cost', polarity: '+' }, variant: {} },
        { id: 'growers\' association chair', who: 'Tom, who chairs the growers\' association', account: 'Water has nothing to do with our orchards coming out. Our pumping bills are small change; fruit prices have been sliding for years, and that is why growers pull trees. The table dropped because the town keeps growing and pumping more.', mechanism: 'town keeps growing', signature: { from: 'town population', to: 'town pumping', polarity: '+' }, variant: { 'lift cost': '0', 'crop value per acre': 'full_crop_value * (0.82 - RAMP(0.022, 0))' } }
    ],
    experiments: [
        { id: 'pumping charge', text: 'Put a steep charge on every acre-foot the orchards pump for a while, or compare each grower\'s planting and pulling out with their pumping bills, and see whether growers plant less.', overrides: { 'lift cost': '*3' }, discriminates: true },
        { id: 'close the golf course well', text: 'Shut the golf course well for a season and see whether the water table comes back.', overrides: { 'golf course use': '*0' }, discriminates: false },
        { id: 'new meter covers', text: 'Fit new covers on the town\'s water meters and see whether households notice.', overrides: {}, discriminates: false }
    ],
    outsideFacts: [{ text: 'The county repaved the valley road two years ago.', topic: 'the roads in the valley' }, { text: 'The board moved its office into the old courthouse last year.', topic: 'where the water board has its office' }],
    loops: [
        { id: 'deeper water squeezes the orchards', polarity: '-', variables: ['orchard acreage', 'farm pumping', 'groundwater', 'depth to water', 'pumping cost', 'orchard profit', 'planting'], core: ['orchard acreage', 'depth to water', 'orchard profit'], mechanism: 'deeper water costs more to pump' },
        { id: 'wells give less as the table drops', polarity: '-', variables: ['depth to water', 'farm well yield', 'farm pumping', 'groundwater'], core: ['depth to water', 'farm well yield'], mechanism: 'wells give less as the table drops' },
        { id: 'orchards planted while they pay', polarity: '+', variables: ['orchard acreage', 'planting'], core: ['orchard acreage', 'planting'], mechanism: 'orchards planted while they pay' }
    ]
};
