import { groupTests, laterBatch } from '../../../evals/utilities/heldOut.js';
import { jest } from '@jest/globals';
import { evaluate, groups, methodology } from '../../../evals/categories/unitConsistency.js';
import { buildCases, fixCases, plantUnitErrors } from '../../../evals/categories/unitConsistencyData/cases.js';
import { checkUnits } from '../../../evals/utilities/units/unitChecker.js';
import { findVariable } from '../../../evals/utilities/modelDiff.js';

const testsFor = (group, name) => groupTests(groups, group).filter((t) => t.expectations.caseName === name);
const failuresFor = async (tests, response) => {
    const out = {};
    for (const t of tests) out[t.expectations.criterion + (t.expectations.errorId ? `:${t.expectations.errorId}` : '')] = (await evaluate(response, t.expectations)).map((f) => f.type);
    return out;
};

describe('unitConsistency category', () => {
    jest.setTimeout(600000);

    test('every reference and correct model is unit-consistent, and every planted error is flagged', () => {
        for (const c of Object.values(buildCases)) expect(checkUnits(c.reference)).toEqual([]);
        for (const [name, c] of Object.entries(fixCases)) {
            expect(checkUnits(c.correct)).toEqual([]);
            for (const error of c.errors) expect([name, error.id, checkUnits(plantUnitErrors(c.correct, [error])).length > 0]).toEqual([name, error.id, true]);
        }
    });

    test('every test outside the hard group asks the agent to run with unit checking, and siblings share a generation', () => {
        for (const [name, group] of Object.entries(groups)) {
            for (const t of group) expect(t.additionalParameters.unitChecking).toBe(!name.startsWith('fixUnitsHard'));
        }
        for (const [group, cases] of [['buildWithUnits', buildCases], ['fixUnits', fixCases]]) {
            for (const name of Object.keys(cases)) {
                const tests = testsFor(group, name);
                expect(new Set(tests.map((t) => JSON.stringify([t.prompt, t.currentModel, t.additionalParameters]))).size).toBe(1);
            }
        }
    });

    test('generated fix cases are the general rule applied to every scenario in the library', async () => {
        const { generateCase } = await import('../../../evals/categories/unitConsistencyData/generate.js');
        const { generatedFixCases } = await import('../../../evals/categories/unitConsistencyData/cases.js');
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        const expected = {};
        for (const s of Object.values(scenarios)) {
            const c = await generateCase(s);
            if (c) expected[c.name] = c;
        }
        expect(Object.fromEntries(Object.entries(generatedFixCases).map(([n, { correct, ...g }]) => [n, g]))).toEqual(expected);
    });

    test('generated build cases are the general rule applied to every scenario in the library', async () => {
        const { generateBuildCase } = await import('../../../evals/categories/unitConsistencyData/generate.js');
        const { generatedBuildCases } = await import('../../../evals/categories/unitConsistencyData/cases.js');
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        const expected = {};
        for (const s of Object.values(scenarios)) {
            const c = generateBuildCase(s);
            if (c) expected[c.name] = c;
        }
        expect(Object.fromEntries(Object.entries(generatedBuildCases).map(([n, { reference, group, ...g }]) => [n, g]))).toEqual(expected);
    });

    test('every failure type is documented', () => {
        expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['Unit inconsistency', 'Missing units', 'Behavior differs', 'Unit error not fixed', 'No model produced']));
    });

    describe.each(Object.keys(buildCases))('build: %s', (name) => {
        const c = buildCases[name];
        const tests = testsFor('buildWithUnits', name);

        test('the reference model passes everything', async () => {
            expect(Object.values(await failuresFor(tests, { model: structuredClone(c.reference) })).flat()).toEqual([]);
        });

        test('the reference with its units stripped fails both units tests, not the behavior test', async () => {
            const model = structuredClone(c.reference);
            for (const v of model.variables) delete v.units;
            const results = await failuresFor(tests, { model });
            expect(results).toEqual({ consistent: expect.arrayContaining(['Unit inconsistency']), allHaveUnits: expect.arrayContaining(['Missing units']), behavior: [] });
        });

        test('a flow multiplied where it should divide fails consistency and behavior', async () => {
            const model = structuredClone(c.reference);
            // A generated case uses its scenario's planted time-constant error, which moves a stock
            // by at least 10%; a hand-written case, its first flow with a division.
            const planted = c.scenario && Object.values(fixCases).find((f) => f.scenario === c.scenario)?.errors[0];
            const flow = planted ? findVariable(model.variables, planted.variable) : model.variables.find((v) => v.type === 'flow' && /\//.test(v.equation));
            if (!flow) return;
            flow.equation = planted ? planted.change.equation : flow.equation.replace('/', '*');
            const results = await failuresFor(tests, { model });
            expect(results.consistent).toContain('Unit inconsistency');
            expect(results.behavior).toEqual(['Behavior differs']);
        });
    });

    describe.each(Object.keys(fixCases))('fix: %s', (name) => {
        const c = fixCases[name];
        const tests = testsFor('fixUnits', name);

        test('the correct model passes everything', async () => {
            expect(Object.values(await failuresFor(tests, { model: structuredClone(c.correct) })).flat()).toEqual([]);
        });

        test('returning the broken model fails every error and the consistency test', async () => {
            const results = await failuresFor(tests, { model: plantUnitErrors(c.correct, c.errors) });
            for (const error of c.errors) expect(results[`error:${error.id}`]).toEqual(['Unit error not fixed']);
            expect(results.consistent.length).toBeGreaterThan(0);
        });

        test('fixing one error passes that error only', async () => {
            const [, left] = c.errors;
            const results = await failuresFor(tests, { model: plantUnitErrors(c.correct, [left]) });
            expect(results[`error:${c.errors[0].id}`]).toEqual([]);
            expect(results[`error:${left.id}`]).toEqual(['Unit error not fixed']);
        });
    });

    test('silencing a unit error by changing what the model computes does not count as a fix', async () => {
        // "release" was Water * residence_time (wrong units). Making it Water / residence_time / 2
        // has the right units but drains twice as slowly.
        const c = fixCases['Reservoir'];
        const model = plantUnitErrors(c.correct, [c.errors[1]]);
        findVariable(model.variables, 'release').equation = 'Water_in_Reservoir / residence_time / 2';
        const results = await failuresFor(testsFor('fixUnits', 'Reservoir'), { model });
        expect(results['error:release multiplies by residence time']).toEqual(['Unit error not fixed']);
    });

    test('deleting the units of the erroneous variables does not count as fixing them', async () => {
        for (const [name, c] of Object.entries(fixCases)) {
            const model = plantUnitErrors(c.correct, c.errors);
            for (const error of c.errors) findVariable(model.variables, error.variable).units = '';
            const results = await failuresFor(testsFor('fixUnits', name), { model });
            for (const error of c.errors) expect([name, error.id, results[`error:${error.id}`]]).toEqual([name, error.id, ['Unit error not fixed']]);
            expect(results.consistent.length).toBeGreaterThan(0);
        }
    });

    test('no model is reported, not thrown', async () => {
        const results = await failuresFor(testsFor('fixUnits', 'Reservoir'), { err: 'boom' });
        expect(Object.values(results).every((t) => t.join() === 'No model produced')).toBe(true);
    });
});

describe('unitConsistency hard group', () => {
    jest.setTimeout(900000);
    let HARD, hardFixCases, CLEAN, caseHeldOut, setReader;
    beforeAll(async () => {
        ({ HARD } = await import('../../../evals/categories/unitConsistency.js'));
        ({ hardFixCases } = await import('../../../evals/categories/unitConsistencyData/cases.js'));
        ({ CLEAN_VERDICTS: CLEAN } = await import('../../../evals/categories/guidedCorrectionData/hardShared.js'));
        ({ caseHeldOut } = await import('../../../evals/utilities/heldOut.js'));
        ({ setReader } = await import('../../../evals/utilities/judge.js'));
    });
    afterAll(() => setReader(null));
    const verdict = (v) => setReader(() => ({ verdict: v }));
    const hardTests = (name) => testsFor('fixUnitsHard', name).filter((t) => t.expectations.criterion !== 'clean');
    const cleanTest = (name) => testsFor('fixUnitsHard', name).find((t) => t.expectations.criterion === 'clean');

    test('hard cases are the rule applied to every scenario in the library', async () => {
        const { generateHardCase } = await import('../../../evals/categories/unitConsistencyData/hard.js');
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        const expected = {};
        for (const s of Object.values(scenarios)) {
            const c = await generateHardCase(s);
            if (c) expected[c.name] = c;
        }
        expect(Object.fromEntries(Object.entries(hardFixCases).map(([n, { correct, ...g }]) => [n, g]))).toEqual(expected);
    });

    test('the group takes the first dev and first two held-out hard cases, with clean controls on the first of each, five generations', () => {
        // The first dev case, the first two first-batch held-out cases, then every later-batch one (heldOut.js laterBatch).
        const firstBatch = HARD.faulty.filter((n) => !laterBatch(hardFixCases[n]));
        expect(firstBatch.map((n) => caseHeldOut(hardFixCases[n]))).toEqual([false, true, true]);
        expect(HARD.faulty.slice(0, 3)).toEqual(firstBatch);
        expect(HARD.faulty.slice(3).every((n) => caseHeldOut(hardFixCases[n]) && laterBatch(hardFixCases[n]))).toBe(true);
        expect(HARD.clean.map((n) => caseHeldOut(hardFixCases[n]))).toEqual([false, true]);
        expect(new Set(groupTests(groups, 'fixUnitsHard').map((t) => JSON.stringify([t.prompt, t.currentModel]))).size).toBe(HARD.faulty.length + HARD.clean.length);
    });

    test('every hard case has three errors of three kinds in three variables, each flagged; equation errors change behavior; the request names none', async () => {
        const { behaviorMismatch } = await import('../../../evals/utilities/behaviorCompare.js');
        for (const [name, c] of Object.entries(hardFixCases)) {
            expect(new Set(c.errors.map((e) => e.kind)).size).toBe(3);
            expect(new Set(c.errors.map((e) => e.variable)).size).toBe(3);
            expect(checkUnits(c.correct)).toEqual([]);
            for (const e of c.errors) {
                expect([name, e.id, checkUnits(plantUnitErrors(c.correct, [e])).length > 0]).toEqual([name, e.id, true]);
                if (e.change.equation) expect([name, e.id, Boolean(await behaviorMismatch(plantUnitErrors(c.correct, [e]), c.correct, 0.02))]).toEqual([name, e.id, true]);
            }
        }
        for (const t of groupTests(groups, 'fixUnitsHard')) expect(t.prompt).not.toMatch(/unit|dimension|consisten/i);
    });

    test('the hard group withholds the unit checker from the agent; the other fix and build groups keep it', () => {
        const hard = groupTests(groups, 'fixUnitsHard');
        expect(hard.length).toBeGreaterThan(0);
        for (const t of hard) expect(t.additionalParameters.unitChecking).toBe(false);
        for (const g of ['fixUnits', 'buildWithUnits']) for (const t of groupTests(groups, g)) expect(t.additionalParameters.unitChecking).toBe(true);
    });

    test('the correct model passes every hard test; the planted model fails every one; fixing all but one error fails that error only', async () => {
        for (const name of HARD.faulty) {
            const c = hardFixCases[name];
            const good = await failuresFor(hardTests(name), { model: structuredClone(c.correct) });
            expect([name, Object.values(good).flat()]).toEqual([name, []]);
            const bad = await failuresFor(hardTests(name), { model: plantUnitErrors(c.correct, c.errors) });
            for (const [k, types] of Object.entries(bad)) expect([name, k, types.length > 0]).toEqual([name, k, true]);
            const left = c.errors.at(-1);
            const partial = await failuresFor(hardTests(name), { model: plantUnitErrors(c.correct, [left]) });
            for (const e of c.errors) expect([name, e.id, partial[`error:${e.id}`].length > 0]).toEqual([name, e.id, e === left]);
            expect(partial.consistent.length).toBeGreaterThan(0);
        }
    });

    test('clean controls: leaving the model alone and saying so passes; reporting problems, not saying, or "fixing" what is not broken fails', async () => {
        for (const name of HARD.clean) {
            const c = hardFixCases[name];
            const t = cleanTest(name);
            verdict(CLEAN.ready);
            expect([name, await evaluate({ model: structuredClone(c.correct), supportingInfo: { explanation: 'Nothing to fix.' } }, t.expectations)]).toEqual([name, []]);
            for (const v of [CLEAN.problems, CLEAN.silent]) {
                verdict(v);
                expect([name, (await evaluate({ model: structuredClone(c.correct), supportingInfo: { explanation: 'x' } }, t.expectations)).map((f) => f.type)]).toEqual([name, ['Problem reported in a correct model']]);
            }
            verdict(CLEAN.ready);
            for (const e of c.errors) {
                const types = (await evaluate({ model: plantUnitErrors(c.correct, [e]), supportingInfo: { explanation: 'Fixed.' } }, t.expectations)).map((f) => f.type);
                expect([name, e.id, types.length > 0 && types.every((x) => x === 'Correct model changed')]).toEqual([name, e.id, true]);
            }
            expect((await evaluate({ err: 'boom' }, t.expectations)).map((f) => f.type)).toEqual(['No model produced']);
        }
    });
});
