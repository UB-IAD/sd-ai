import fs from 'fs';
import { CATEGORIES } from '../../evals/floors/nullAgents.js';
import { HELD_OUT_SUFFIX, isHeldOutScenario, laterBatch } from '../../evals/utilities/heldOut.js';
import { pickHard, HARD_PICK } from '../../evals/categories/guidedCorrectionData/hardShared.js';
import { scenarios } from '../../evals/utilities/scenarios/library.js';

// Every agent category splits its groups into dev and held-out tests; the runner selects by group,
// so this is what lets a run take dev and held-out tests separately.
describe('held-out split', () => {
    test.each(CATEGORIES)('%s: every test is marked, held-out groups hold only held-out tests, dev groups none', async (name) => {
        const { groups } = await import(`../../evals/categories/${name}.js`);
        for (const [g, tests] of Object.entries(groups)) {
            for (const t of tests) expect([g, t.name, typeof t.heldOut]).toEqual([g, t.name, 'boolean']);
            const held = g.endsWith(HELD_OUT_SUFFIX);
            for (const t of tests) expect([g, t.name, t.heldOut]).toEqual([g, t.name, held]);
            // A test about a library scenario is held out exactly when the scenario is.
            for (const t of tests) if (t.expectations?.scenario) expect([g, t.name, isHeldOutScenario(t.expectations.scenario)]).toEqual([g, t.name, held]);
        }
    }, 600000);

    test('every category has held-out tests', async () => {
        for (const name of CATEGORIES) {
            const { groups } = await import(`../../evals/categories/${name}.js`);
            expect([name, Object.keys(groups).some((g) => g.endsWith(HELD_OUT_SUFFIX))]).toEqual([name, true]);
        }
    }, 600000);

    test('no grader reads its own split groups by name (a held-out test would find no sibling)', () => {
        for (const name of CATEGORIES) {
            const src = fs.readFileSync(`evals/categories/${name}.js`, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
            expect([name, src.match(/(?<![A-Za-z])groups(\.[A-Za-z]+|\[)/)?.[0] ?? null]).toEqual([name, null]);
        }
    });

    // A later batch of held-out scenarios adds hard cases without displacing any picked before it.
    test('pickHard: two first-batch held-out cases, then every later-batch one; dev and clean picks unchanged', () => {
        const later = Object.keys(scenarios).filter((id) => scenarios[id].batch === 2);
        const first = Object.keys(scenarios).filter((id) => isHeldOutScenario(id) && !scenarios[id].batch);
        const dev = Object.keys(scenarios).find((id) => !isHeldOutScenario(id));
        expect(later.length).toBe(3);
        expect(later.every((id) => isHeldOutScenario(id) && laterBatch({ scenario: id }))).toBe(true);
        // A later-batch case listed before first-batch ones, as a generated case can be before hand cases.
        const cases = { d: { scenario: dev }, n1: { scenario: later[0] }, a: { scenario: first[0] }, b: { scenario: first[1] }, c: { scenario: first[2] }, n2: { scenario: later[1] } };
        const picked = pickHard(cases, null);
        expect(HARD_PICK.heldOut).toBe(2);
        expect(picked.faulty).toEqual(['d', 'a', 'b', 'n1', 'n2']);
        expect(picked.clean).toEqual(['d', 'a']);
        // An admission rule turns away a later-batch case, never a first-batch one.
        expect(pickHard({ ...cases, n2: { ...cases.n2, bad: true }, b: { ...cases.b, bad: true } }, (c) => !c.bad).faulty).toEqual(['d', 'a', 'b', 'n1']);
        // Without the later batch the pick is what it was.
        expect(pickHard({ d: cases.d, a: cases.a, b: cases.b, c: cases.c }, null)).toEqual({ faulty: ['d', 'a', 'b'], clean: ['d', 'a'] });
    });
});
