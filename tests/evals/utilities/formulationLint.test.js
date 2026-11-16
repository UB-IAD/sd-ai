import { lintFormulations } from '../../../evals/utilities/formulationLint.js';

const model = (variables) => ({ variables, relationships: [] });
const v = (name, type, equation, extra) => ({ name, type, equation, ...(extra || {}) });
const rules = (m) => lintFormulations(m).map((f) => `${f.variable}:${f.rule}`);

describe('formulation linter', () => {
    test('a clean model has no findings', () => {
        expect(rules(model([v('S', 'stock', '100'), v('out', 'flow', 'S / tau'), v('tau', 'variable', '4')]))).toEqual(['out:unguarded division'].filter(() => false));
    });

    test('more than four inputs are flagged', () => {
        expect(rules(model([v('a', 'variable', '1'), v('b', 'variable', '1'), v('c', 'variable', '1'), v('d', 'variable', '1'), v('e', 'variable', '1'), v('x', 'variable', 'a + b + c + d + e')]))).toEqual(['x:too many inputs']);
    });

    test('numbers written into equations are flagged, including STEP arguments; 0 and 1 are not', () => {
        expect(rules(model([v('d', 'variable', '100 + STEP(20, 4)')]))).toEqual(['d:embedded constant']);
        expect(rules(model([v('S', 'stock', '5'), v('f', 'flow', 'MAX(0, 1 - S)')]))).toEqual([]);
    });

    test('a constant defined as a negative number is a definition, not an embedded constant', () => {
        expect(rules(model([v('margin', 'variable', '-0.3')]))).toEqual([]);
    });

    test('dividing by a stock is flagged unless guarded by MAX, safe division or an IF on that stock', () => {
        const S = v('S', 'stock', '10');
        expect(rules(model([S, v('k', 'variable', '2'), v('f', 'flow', 'k / S')]))).toEqual(['f:unguarded division']);
        expect(rules(model([S, v('k', 'variable', '2'), v('f', 'flow', 'k / MAX(S, k)')]))).toEqual([]);
        expect(rules(model([S, v('k', 'variable', '2'), v('f', 'flow', 'k // S')]))).toEqual([]);
        expect(rules(model([S, v('k', 'variable', '2'), v('f', 'flow', 'IF S > 0 THEN k / S ELSE 0')]))).toEqual([]);
        expect(rules(model([S, v('h', 'variable', '10'), v('f', 'flow', 'S / (S + h)')]))).toEqual([]);
        expect(rules(model([S, v('T', 'stock', '3'), v('f', 'flow', 'S / (S - T)')]))).toEqual(['f:unguarded division']);
        expect(rules(model([S, v('T', 'stock', '3'), v('f', 'flow', 'S / (S + T)')]))).toEqual(['f:unguarded division']);
    });

    test('comparing TIME to a number is a hard-coded time switch', () => {
        expect(rules(model([v('k', 'variable', '2'), v('p', 'variable', 'IF TIME > 10 THEN k ELSE 0')]))).toEqual(['p:embedded constant', 'p:hard-coded time switch']);
    });

    test('lookup variables may hold numbers', () => {
        expect(rules(model([v('x', 'variable', '3'), v('effect', 'variable', 'x', { graphicalFunction: { points: [{ x: 0, y: 1 }] } })]))).toEqual([]);
    });
});
