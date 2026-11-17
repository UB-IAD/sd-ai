import { groupTests } from '../../../evals/utilities/heldOut.js';
import { simTest } from '../simTest.js';
import { jest } from '@jest/globals';

let decisions = null;
const judgeCalls = [];
jest.unstable_mockModule('../../../evals/utilities/judge.js', () => ({
    extract: async (key, messages) => { judgeCalls.push({ key, messages }); return decisions; },
    clearJudgeCache: () => {}
}));

const { evaluate, groups, methodology, pointsFor, LINT_RULES, FORECASTS, hardIds, gradedQuantities } = await import('../../../evals/categories/sfdFromBoundary.js');
const { numbersIn, HARD_BAND_SHARE } = await import('../../../evals/categories/referenceModesData/forecast.js');
const { within } = await import('../../../evals/categories/referenceModesData/forecast.js');
const { simulateModel } = await import('../../../evals/utilities/simulateModel.js');
const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
const { glossaryModel } = await import('../../../evals/utilities/scenarios/renameModel.js');
const { computeKey } = await import('../../../evals/utilities/scenarios/scenarioKit.js');
const { lintFormulations } = await import('../../../evals/utilities/formulationLint.js');
const { findVariable } = await import('../../../evals/utilities/modelDiff.js');

const testsFor = (id) => groupTests(groups, 'sfdFromBoundary').filter((t) => t.expectations.scenario === id);
const run = async (tests, response) => {
    const out = {};
    for (const t of tests) out[t.name] = (await evaluate(response, t.expectations)).map((f) => f.type);
    return out;
};
const rightDecisions = (s) => ({ decisions: pointsFor(s).map((p, i) => ({ number: i + 1, decision: p.include ? 'include' : 'exclude' })) });

/**
 * The hidden model in glossary names, cleaned up the way a careful modeler would write it: every
 * number a named constant. This is what a perfect agent builds.
 */
const referenceAnswer = function(s) {
    return glossaryModel(s);
};

describe('sfdFromBoundary category', () => {
    jest.setTimeout(600000);

    simTest('every mechanism verdict written in the library is what ablation of the hidden model says', async () => {
        for (const s of Object.values(scenarios)) {
            const key = await computeKey(s);
            for (const m of s.mechanisms) expect([s.id, m.id, key.mechanisms[m.id].verdict]).toEqual([s.id, m.id, m.verdict]);
        }
    });

    test('no ambiguous mechanism is ever asked about, and every point appears exactly once', () => {
        for (const s of Object.values(scenarios)) {
            const points = pointsFor(s);
            expect(points.some((p) => p.mechanism?.verdict === 'ambiguous')).toBe(false);
            expect(points.length).toBe(s.mechanisms.filter((m) => m.verdict !== 'ambiguous').length + s.outsideFacts.length);
        }
    });

    test('the linter rules graded here are real rule names', () => {
        const all = new Set(['too many inputs', 'embedded constant', 'unguarded division', 'hard-coded time switch']);
        for (const r of LINT_RULES) expect(all.has(r)).toBe(true);
    });

    test('every failure type is documented', () => {
        expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['Boundary decision wrong', 'Mechanism not in model', 'Behavior not reproduced', 'Model does not simulate', 'Unit inconsistency', 'Formulation not best practice', 'No model produced', 'Evaluation error']));
    });

    describe.each(Object.keys(scenarios))('%s', (id) => {
        const s = scenarios[id];

        simTest('the reference answer with the right decisions passes everything', async () => {
            decisions = rightDecisions(s);
            const results = await run(testsFor(id), { model: referenceAnswer(s), supportingInfo: { explanation: 'my decisions' } });
            expect(Object.entries(results).filter(([, t]) => t.length)).toEqual([]);
        });

        simTest('wrong decisions fail every decision test and nothing else', async () => {
            decisions = { decisions: pointsFor(s).map((p, i) => ({ number: i + 1, decision: p.include ? 'exclude' : 'include' })) };
            const results = await run(testsFor(id), { model: referenceAnswer(s), supportingInfo: { explanation: 'my decisions' } });
            for (const t of testsFor(id)) {
                expect([t.name, results[t.name].length > 0]).toEqual([t.name, t.expectations.criterion === 'decision']);
            }
        });

        test('switching off each mechanism that matters fails its signature test', async () => {
            decisions = rightDecisions(s);
            for (const m of s.mechanisms.filter((x) => x.verdict === 'matters' && x.signature)) {
                // Removing the mechanism's causal path: cut everything into the signature's target —
                // a flow or auxiliary loses its equation, a stock its flows.
                const model = referenceAnswer(s);
                const target = findVariable(model.variables, m.signature.to);
                if (target.type === 'stock') { target.inflows = []; target.outflows = []; } else target.equation = '0';
                const sig = testsFor(id).find((t) => t.expectations.mechanism === m.id);
                expect((await evaluate({ model, supportingInfo: { explanation: 'x' } }, sig.expectations)).map((f) => f.type)).toEqual(['Mechanism not in model']);
            }
        });
    });

    test('an embedded constant is caught by the lint test', async () => {
        const model = glossaryModel(scenarios.distributor);
        findVariable(model.variables, 'demand').equation = '100 + STEP(20, 4)';
        const lint = testsFor('distributor').find((t) => t.expectations.criterion === 'lint');
        expect(lintFormulations(model).some((f) => f.rule === 'embedded constant')).toBe(true);
        expect((await evaluate({ model }, lint.expectations)).map((f) => f.type)).toEqual(['Formulation not best practice']);
    });

    test('a mechanism built with the wrong sign fails its signature test', async () => {
        const dialysis = glossaryModel(scenarios.dialysisClinic);
        findVariable(dialysis.variables, 'ordering chairs').equation = 'MAX(0, (Chairs + chairs_on_order - desired_chairs) / order_adjustment_time)';
        const sig1 = testsFor('dialysisClinic').find((t) => t.expectations.criterion === 'signature');
        expect((await evaluate({ model: dialysis }, sig1.expectations)).map((f) => f.type)).toEqual(['Mechanism not in model']);
        const distributor = glossaryModel(scenarios.distributor);
        findVariable(distributor.variables, 'orders').equation = 'MAX(0, expected_demand + (inventory - desired_inventory) / adjustment_time)';
        const sig2 = testsFor('distributor').find((t) => t.expectations.criterion === 'signature');
        expect((await evaluate({ model: distributor }, sig2.expectations)).map((f) => f.type)).toEqual(['Mechanism not in model']);
    });

    test('a mechanism built with a rising lookup or an IF on the input still counts', async () => {
        const sig = testsFor('dialysisClinic').find((t) => t.expectations.criterion === 'signature');
        const lookup = glossaryModel(scenarios.dialysisClinic);
        Object.assign(findVariable(lookup.variables, 'ordering chairs'), { equation: 'waiting_list', graphicalFunction: { points: [{ x: 0, y: 0 }, { x: 100, y: 3 }, { x: 200, y: 6 }] } });
        expect(await evaluate({ model: lookup }, sig.expectations)).toEqual([]);
        const ifModel = glossaryModel(scenarios.dialysisClinic);
        findVariable(ifModel.variables, 'ordering chairs').equation = 'IF waiting_list > order_threshold THEN order_size ELSE 0';
        ifModel.variables.push({ name: 'order threshold', type: 'variable', equation: '60' }, { name: 'order size', type: 'variable', equation: '2' });
        expect(await evaluate({ model: ifModel }, sig.expectations)).toEqual([]);
    });

    test('word of mouth without saturation does not pass for market saturation', async () => {
        const model = glossaryModel(scenarios.bikeShare);
        findVariable(model.variables, 'word of mouth').equation = 'contact_rate * members * persuasion';
        const sig = testsFor('bikeShare').find((t) => t.expectations.mechanism === 'market saturation');
        expect((await evaluate({ model }, sig.expectations)).map((f) => f.type)).toEqual(['Mechanism not in model']);
    });

    test('a model with no units fails the units test', async () => {
        const s = scenarios.dialysisClinic;
        const model = referenceAnswer(s);
        for (const v of model.variables) delete v.units;
        const units = testsFor('dialysisClinic').find((t) => t.expectations.criterion === 'units');
        expect((await evaluate({ model }, units.expectations)).length).toBeGreaterThan(0);
    });

    simTest('a model that does not reproduce the behavior fails the shape test', async () => {
        const s = scenarios.dialysisClinic;
        const model = referenceAnswer(s);
        findVariable(model.variables, 'chairs on order').inflows = [];
        const shape = testsFor('dialysisClinic').find((t) => t.expectations.criterion === 'shape' && t.expectations.variable === 'waiting list');
        expect((await evaluate({ model }, shape.expectations)).map((f) => f.type)).toEqual(['Behavior not reproduced']);
    });

    test('no model is reported, not thrown', async () => {
        const results = await run(testsFor('bikeShare'), { err: 'boom' });
        expect(Object.values(results).every((t) => t.join() === 'No model produced')).toBe(true);
    });

    describe('hard group: numbers instead of shapes', () => {
        const hard = groupTests(groups, 'sfdFromBoundaryHard');
        const hardTest = (id) => hard.find((t) => t.expectations.scenario === id);
        const grade = async (id, response) => (await evaluate(response, hardTest(id).expectations)).map((f) => f.type);

        test('one test per scenario with a graded forecast quantity, dev and held out; it grades exactly those quantities', () => {
            // The scenarios asked are the same as under the forecast band; the quantities graded are the tighter band's.
            const before = Object.keys(scenarios).filter((id) => FORECASTS[id]?.quantities.some((q) => q.graded));
            // A later-batch scenario may have nothing left to grade under the tighter band.
            expect(hardIds).toEqual(before.filter((id) => hardIds.includes(id)));
            expect(before.filter((id) => !hardIds.includes(id)).every((id) => scenarios[id].batch === 2)).toBe(true);
            for (const id of Object.keys(scenarios)) for (const g of scenarios[id].glossary) expect([id, g, /\d/.test(g)]).toEqual([id, g, false]);
            expect(hard.map((t) => t.expectations.scenario)).toEqual(hardIds);
            expect(groups.sfdFromBoundaryHard.length).toBeGreaterThan(0);
            expect(groups.sfdFromBoundaryHardHeldOut.length).toBeGreaterThan(0);
            for (const id of hardIds) {
                expect(hardTest(id).expectations.quantities.map((q) => q.variable)).toEqual(gradedQuantities(id).map((q) => q.glossary));
                // The account of the whole period tells how the run ends: neither the narrative nor the opening is given.
                expect(hardTest(id).prompt).not.toContain(scenarios[id].narrative);
                expect(hardTest(id).prompt).not.toContain(scenarios[id].opening);
                for (const row of FORECASTS[id].table) expect(row.time).toBeLessThanOrEqual(FORECASTS[id].now);
                for (const q of gradedQuantities(id)) expect(hardTest(id).prompt).not.toContain(String(q.truth));
            }
        });

        simTest.each(hardIds)('%s: the truth and band are the hidden run\'s end values, and no naive guess lands in the band', async (id) => {
            const s = scenarios[id];
            const glossary = glossaryModel(s);
            const names = gradedQuantities(id).map((q) => findVariable(glossary.variables, q.glossary).name);
            const run = await simulateModel({ ...glossary, relationships: glossary.relationships || [], specs: s.model.specs }, names, null);
            gradedQuantities(id).forEach((q, i) => {
                const series = run.series[names[i]];
                expect([q.glossary, Number(series.at(-1).toPrecision(3))]).toEqual([q.glossary, q.truth]);
                // Every naive guess: the run's own first value, the forecast rule's first, last, lowest,
                // highest and trend values over the first half, and the constants 0 and 1.
                for (const guess of [series[0], q.naive.first, q.naive.persistence, q.naive.min, q.naive.max, q.naive.trend, 0, 1, ...numbersIn(hardTest(id).prompt)]) expect([q.glossary, guess, within(guess, q)]).toEqual([q.glossary, guess, false]);
                // The tighter band: half the forecast band.
                const wide = FORECASTS[id].quantities.find((x) => x.glossary === q.glossary);
                expect([q.glossary, Math.abs(q.band - wide.band * HARD_BAND_SHARE) <= 0.01 * wide.band]).toEqual([q.glossary, true]);
            });
        });

        simTest.each(hardIds)('%s: a model that ends inside the forecast band but outside the tighter one fails', async (id) => {
            const s = scenarios[id];
            const quantities = gradedQuantities(id);
            const wide = (q) => FORECASTS[id].quantities.find((x) => x.glossary === q.glossary).band;
            const flat = { variables: quantities.map((q) => ({ name: q.glossary, type: 'variable', equation: String(q.truth + 0.9 * wide(q)), units: 'units' })), relationships: [], specs: s.model.specs };
            expect(await grade(id, { model: flat })).toEqual(quantities.map(() => 'End value off'));
            const near = { ...flat, variables: quantities.map((q) => ({ name: q.glossary, type: 'variable', equation: String(q.truth + 0.9 * q.band), units: 'units' })) };
            expect(await grade(id, { model: near })).toEqual([]);
        });

        describe.each(hardIds)('%s', (id) => {
            const s = scenarios[id];

            simTest('the hidden model in glossary names passes', async () => {
                expect(await grade(id, { model: referenceAnswer(s) })).toEqual([]);
            });

            simTest('no model, a model frozen at its start, and a constant model fail', async () => {
                expect(await grade(id, { model: { variables: [], relationships: [] } })).toEqual(['No model produced']);
                const frozen = referenceAnswer(s);
                for (const v of frozen.variables) if (v.type === 'flow') v.equation = '0';
                expect((await grade(id, { model: frozen })).length).toBeGreaterThan(0);
                for (const constant of ['0', '1']) {
                    const flat = { variables: gradedQuantities(id).map((q) => ({ name: q.glossary, type: 'variable', equation: constant, units: 'units' })), relationships: [], specs: s.model.specs };
                    expect([constant, await grade(id, { model: flat })]).toEqual([constant, gradedQuantities(id).map(() => 'End value off')]);
                }
            });

            simTest('one quantity left out or off by more than its band fails', async () => {
                const off = referenceAnswer(s);
                const [q] = gradedQuantities(id);
                off.variables = off.variables.filter((v) => findVariable([v], q.glossary) === undefined);
                expect(await grade(id, { model: off })).toContain('End value off');
            });
        });
    });
});
