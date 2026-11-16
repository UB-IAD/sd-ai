import { checkUnits } from '../../../evals/utilities/units/unitChecker.js';
import { parseUnits, formatUnits, canonicalUnitName, unitVocabulary } from '../../../evals/utilities/units/unitAlgebra.js';
import { parseEquation } from '../../../evals/utilities/units/equationParser.js';
import { cases as equilibriumCases } from '../../../evals/categories/equilibriumData/models.js';

const fmt = (text) => { const u = parseUnits(text, unitVocabulary([text])); return u ? formatUnits(u) : null; };
/** Whether two unit words are the same unit in a model that uses both. */
const same = (a, b) => { const vocab = unitVocabulary([a, b]); return canonicalUnitName(a, vocab) === canonicalUnitName(b, vocab); };
const model = (variables, timeUnits) => ({ variables, relationships: [], specs: { startTime: 0, stopTime: 10, dt: 1, timeUnits } });
const v = (name, type, equation, units, extra) => ({ name, type, equation, units, ...(extra || {}) });
const kinds = (warnings) => warnings.map((w) => `${w.variable}:${w.kind}`);

describe('unit parsing', () => {
    test.each([
        ['widgets per person per month', 'widgets/(month*person)'],
        ['widgets/person/month', 'widgets/(month*person)'],
        ['per year', '1/year'],
        ['1/(animal*year)', '1/(animal*year)'],
        ['people/year', 'person/year'],
        ['Persons / Yr', 'person/year'],
        ['widgets/month/month', 'widgets/month^2'],
        ['degrees C/minute', 'degrees_c/minute'],
        ['person-months', 'month*person'],
        ['m²', 'm^2'],
        ['dimensionless', 'dimensionless'],
        ['1', 'dimensionless'],
        ['m^2/s', 'm^2/second'],
        ['species', 'species'],
        ['companies per year', 'companies/year']
    ])('%s reads as %s', (text, expected) => {
        expect(fmt(text)).toBe(expected);
    });

    test('empty and unreadable unit strings are null, not dimensionless', () => {
        expect(parseUnits('', new Set())).toBeNull();
        expect(parseUnits(undefined, new Set())).toBeNull();
        expect(parseUnits('widgets / / month', new Set())).toBeNull();
    });

    test.each([
        ['calories', 'calorie'], ['sizes', 'size'], ['movies', 'movie'], ['companies', 'company'],
        ['lenses', 'lens'], ['buses', 'bus'], ['houses', 'house'], ['degrees C', 'degree C'],
        ['lbs', 'lb'], ['glasses', 'glass'], ['degree C', 'degrees C'], ['widgets', 'widget'],
        ['leaves', 'leaf'], ['tomatoes', 'tomato'], ['analyses', 'analysis'], ['criteria', 'criterion']
    ])('%s and %s are the same unit in a model that uses both', (a, b) => {
        expect(same(a, b)).toBe(true);
    });

    test.each([['car', 'care'], ['rat', 'rate'], ['plan', 'plane'], ['ton', 'tone'], ['bit', 'bite'], ['note', 'not']])('%s and %s stay different units', (a, b) => {
        expect(same(a, b)).toBe(false);
    });

    test('a degree sign reads as "degree"', () => {
        const vocab = unitVocabulary(['°C', 'degree C']);
        expect(formatUnits(parseUnits('°C', vocab))).toBe(formatUnits(parseUnits('degree C', vocab)));
    });

    test('"units" is a unit, not dimensionless', () => {
        expect(fmt('units/week')).toBe('units/week');
        const m = model([v('total', 'variable', 'Inventory + coverage', 'units'), v('Inventory', 'variable', '3', 'units'), v('coverage', 'variable', '0.5', 'dimensionless')], 'weeks');
        expect(kinds(checkUnits(m))).toEqual(['total:mismatch']);
    });

    test('plurals and abbreviations fold together', () => {
        expect(same('months', 'month')).toBe(true);
        expect(same('mo', 'month')).toBe(true);
        expect(same('people', 'person')).toBe(true);
        expect(canonicalUnitName('gas', unitVocabulary(['gas']))).toBe('gas');
    });
});

describe('equation parsing', () => {
    test('precedence, functions, IF and quoted names', () => {
        expect(parseEquation('a + b * c ^ 2')).toEqual({ type: 'binary', op: '+', left: { type: 'name', name: 'a' }, right: { type: 'binary', op: '*', left: { type: 'name', name: 'b' }, right: { type: 'binary', op: '^', left: { type: 'name', name: 'c' }, right: { type: 'number', value: 2 } } } });
        expect(parseEquation('IF x > 0 THEN MIN(a, b) ELSE 0').type).toBe('if');
        expect(parseEquation('"my stock" // 2').left).toEqual({ type: 'name', name: 'my stock' });
        expect(parseEquation('-x + 1e3').left).toEqual({ type: 'unary', op: '-', arg: { type: 'name', name: 'x' } });
    });

    test('malformed equations throw rather than parse wrongly', () => {
        expect(() => parseEquation('a + * b')).toThrow();
        expect(() => parseEquation('(a + b')).toThrow();
        expect(() => parseEquation('a b')).toThrow();
    });
});

describe('unit checking', () => {
    test('every equilibrium model is unit-consistent (the checker raises no false alarms on them)', () => {
        for (const c of Object.values(equilibriumCases)) expect(checkUnits(c.model)).toEqual([]);
    });

    test('a flow multiplied by a time constant instead of divided is caught', () => {
        const m = model([
            v('Water', 'stock', '100', 'liters', { inflows: [], outflows: ['draining'] }),
            v('draining', 'flow', 'Water * drain_time', 'liters/day'),
            v('drain time', 'variable', '4', 'days')
        ], 'days');
        expect(kinds(checkUnits(m))).toEqual(['draining:equation']);
    });

    test('a flow in the wrong units for its stock is caught on the stock', () => {
        const m = model([
            v('Water', 'stock', '100', 'liters', { inflows: ['filling'], outflows: [] }),
            v('filling', 'flow', '5', 'liters')
        ], 'days');
        expect(kinds(checkUnits(m))).toEqual(['Water:stock']);
    });

    test('adding quantities in different units is caught', () => {
        const m = model([
            v('total', 'variable', 'apples + oranges', 'apples'),
            v('apples', 'variable', '3', 'apples'),
            v('oranges', 'variable', '4', 'oranges')
        ], 'days');
        expect(kinds(checkUnits(m))).toEqual(['total:mismatch']);
    });

    test('numbers adapt in sums and are plain in products', () => {
        const m = model([
            v('gap', 'variable', 'target - 5', 'widgets'),
            v('target', 'variable', '100', 'widgets'),
            v('double', 'variable', 'target * 2', 'widgets')
        ], 'months');
        expect(checkUnits(m)).toEqual([]);
    });

    test('a stock initial value in the wrong units is caught', () => {
        const m = model([
            v('Population', 'stock', 'birth_rate', 'people', { inflows: [], outflows: [] }),
            v('birth rate', 'variable', '0.03', '1/year')
        ], 'years');
        expect(kinds(checkUnits(m))).toEqual(['Population:initial']);
    });

    test('a smoothing delay with a non-time delay is caught; the smooth keeps its input units', () => {
        const ok = model([v('perceived', 'variable', 'SMTH1(actual, adjust_time)', 'widgets'), v('actual', 'variable', '3', 'widgets'), v('adjust time', 'variable', '2', 'months')], 'months');
        expect(checkUnits(ok)).toEqual([]);
        const bad = model([v('perceived', 'variable', 'SMTH1(actual, actual)', 'widgets'), v('actual', 'variable', '3', 'widgets')], 'months');
        expect(kinds(checkUnits(bad))).toEqual(['perceived:function']);
    });

    test('EXP of a quantity with units is caught', () => {
        const m = model([v('growth', 'variable', 'EXP(people)', 'dimensionless'), v('people', 'variable', '3', 'people')], 'years');
        expect(kinds(checkUnits(m))).toEqual(['growth:function']);
    });

    test('a lookup output takes its declared units whatever its input', () => {
        const m = model([
            v('effect', 'variable', 'density', 'dimensionless', { graphicalFunction: { points: [{ x: 0, y: 1 }, { x: 1, y: 0.5 }] } }),
            v('density', 'variable', '3', 'people/km^2')
        ], 'years');
        expect(checkUnits(m)).toEqual([]);
    });

    test('missing units are reported, and nothing is inferred through them', () => {
        const m = model([v('a', 'variable', 'b * 2', 'widgets'), v('b', 'variable', '3', '')], 'days');
        expect(kinds(checkUnits(m))).toEqual(['b:missing']);
    });

    test('a lookup stored as a bare array of points is still a lookup', () => {
        const m = model([
            v('effect', 'variable', 'density', 'dimensionless', { graphicalFunction: [{ x: 0, y: 1 }, { x: 1, y: 0.5 }] }),
            v('density', 'variable', '3', 'people/km^2')
        ], 'years');
        expect(checkUnits(m)).toEqual([]);
    });

    test('a negative whole-number power is a power, not a fractional one', () => {
        const m = model([v('rate', 'variable', 'delay^-1', '1/month'), v('delay', 'variable', '3', 'months')], 'months');
        expect(checkUnits(m)).toEqual([]);
    });

    test('TREND returns a fractional rate per time unit', () => {
        const m = model([v('growth', 'variable', 'TREND(sales, 3, 0)', '1/month'), v('sales', 'variable', '3', 'widgets/month')], 'months');
        expect(checkUnits(m)).toEqual([]);
    });

    test('null variables are skipped rather than crashing the check', () => {
        expect(checkUnits({ variables: [null, v('a', 'variable', '1', 'widgets')], specs: { timeUnits: 'days' } })).toEqual([]);
    });

    test('a stock in °C with a flow in degrees C per hour is consistent', () => {
        const m = model([
            v('Temperature', 'stock', '20', '°C', { inflows: ['heating'], outflows: [] }),
            v('heating', 'flow', '2', 'degrees C/hour')
        ], 'hours');
        expect(checkUnits(m)).toEqual([]);
    });

    test('TIME is in the model time unit', () => {
        const m = model([v('elapsed', 'variable', 'TIME - start_time', 'months'), v('start time', 'variable', '2', 'months')], 'Months');
        expect(checkUnits(m)).toEqual([]);
    });
});
