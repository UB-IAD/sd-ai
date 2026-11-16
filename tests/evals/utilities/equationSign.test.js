import { dependenceSigns, lookupDirection, variableValueSigns } from '../../../evals/utilities/units/equationSign.js';

const fold = (n) => n.toLowerCase().replace(/[\s_]+/g, '_');
const signs = (eq, names) => Object.fromEntries(dependenceSigns(eq, names, fold, new Map()));

describe('equation dependence signs', () => {
    test.each([
        ['a + b', ['a', 'b'], { a: '+', b: '+' }],
        ['a - b', ['a', 'b'], { a: '+', b: '-' }],
        ['a * b', ['a', 'b'], { a: '+', b: '+' }],
        ['a / b', ['a', 'b'], { a: '+', b: '-' }],
        ['(desired - Inventory) / adjust', ['desired', 'Inventory', 'adjust'], { desired: '+', inventory: '-', adjust: '?' }],
        ['MAX(0, (Inventory - desired) / adjust)', ['Inventory', 'desired'], { inventory: '+', desired: '-' }],
        ['-a', ['a'], { a: '-' }],
        ['a / b - a', ['a', 'b'], { a: '?', b: '-' }],
        ['IF c > 0 THEN a ELSE b', ['a', 'b', 'c'], { a: '+', b: '+', c: '?' }],
        ['SMTH1(x, t)', ['x', 't'], { x: '+', t: '?' }],
        ['a ^ 2', ['a'], { a: '+' }],
        ['a ^ -1', ['a'], { a: '-' }],
        ['-0.5 * x', ['x'], { x: '-' }],
        ['x * (0 - 0.5)', ['x'], { x: '?' }],
        ['x * -0.5', ['x'], { x: '-' }],
        ['EXP(-x / t)', ['x', 't'], { x: '-', t: '+' }],
        ['(desired - X) / t', ['desired', 'X', 't'], { desired: '+', x: '-', t: '?' }],
        ['X / t', ['X', 't'], { x: '+', t: '-' }]
    ])('%s', (eq, names, expected) => {
        expect(signs(eq, names)).toEqual(expected);
    });

    test('an unparseable equation gives null', () => {
        expect(dependenceSigns('a +* b', ['a'], fold, new Map())).toBeNull();
    });
});

describe('lookup direction', () => {
    test('rising, falling and turning lookups', () => {
        expect(lookupDirection({ points: [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 2 }] })).toBe('+');
        expect(lookupDirection([{ x: 0, y: 3 }, { x: 1, y: 1 }])).toBe('-');
        expect(lookupDirection({ points: [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 1 }] })).toBe('?');
    });
});

describe('named gaps', () => {
    test('a time constant dividing a named gap has no fixed sign, as it does for an inline gap', () => {
        const named = variableValueSigns([{ name: 'workers gap', type: 'variable', equation: 'desired - Workers' }, { name: 'rate', type: 'variable', equation: 'k * 2' }]);
        expect(named.get('workers_gap')).toBe('?');
        expect(named.get('rate')).toBe('+');
        expect(Object.fromEntries(dependenceSigns('workers_gap / t', ['workers gap', 't'], fold, named))).toEqual({ workers_gap: '+', t: '?' });
    });
});
