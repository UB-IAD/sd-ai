import { groupTests, laterBatch } from '../../../evals/utilities/heldOut.js';
import { jest } from '@jest/globals';
import { evaluate, groups, methodology } from '../../../evals/categories/extremeConditions.js';
import { cases, plantedModel } from '../../../evals/categories/extremeConditionsData/cases.js';
import { impossibleUnder } from '../../../evals/utilities/extremeRun.js';
import { behaviorMismatch } from '../../../evals/utilities/behaviorCompare.js';
import { findVariable } from '../../../evals/utilities/modelDiff.js';

const testsFor = (name) => groupTests(groups, 'extremeConditions').filter((t) => t.expectations.caseName === name);
const run = async (tests, response) => {
    const out = {};
    for (const t of tests) out[t.expectations.criterion] = (await evaluate(response, t.expectations)).map((f) => f.type);
    return out;
};
const scenarioCall = (overrides) => ({ toolName: 'mcp__sd-ai__run_scenario', arguments: { overrides, outputs: [] } });

describe('extremeConditions category', () => {
    jest.setTimeout(900000);

    test('each plant fails under its extreme, the robust model does not, and normally they agree', async () => {
        for (const [name, c] of Object.entries(cases)) {
            expect([name, Boolean(await impossibleUnder(plantedModel(c), c.trigger))]).toEqual([name, true]);
            expect([name, await impossibleUnder(c.clean, c.trigger)]).toEqual([name, null]);
            expect([name, await behaviorMismatch(plantedModel(c), c.clean, 0.05)]).toEqual([name, null]);
        }
    });

    test('every test turns on the analysis tools, and the prompt does not give the extreme away', () => {
        for (const [name, c] of Object.entries(cases)) {
            for (const t of testsFor(name)) expect(t.additionalParameters.analysisTools).toBe(true);
            for (const key of Object.keys(c.trigger)) expect(testsFor(name)[0].prompt).not.toContain(`"${key}"`);
        }
    });

    test('generated cases are the general rule applied to every scenario in the library', async () => {
        const { generateCase } = await import('../../../evals/categories/extremeConditionsData/generate.js');
        const { generatedCases } = await import('../../../evals/categories/extremeConditionsData/cases.js');
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        const expected = {};
        for (const s of Object.values(scenarios)) {
            const c = await generateCase(s);
            if (c) expected[c.name] = c;
        }
        expect(Object.fromEntries(Object.entries(generatedCases).map(([n, { clean, ...g }]) => [n, g]))).toEqual(expected);
    });

    test('every failure type is documented', () => {
        expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['Problem not found by testing', 'Formulation not fixed', 'Normal behavior changed', 'Model not robust', 'No model produced']));
    });

    describe.each(Object.keys(cases))('%s', (name) => {
        const c = cases[name];

        test('testing the right extreme and returning the robust model passes everything', async () => {
            const results = await run(testsFor(name), { model: structuredClone(c.clean), toolLog: [scenarioCall(c.trigger)] });
            expect(results).toEqual({ found: [], fixed: [], robust: [] });
        });

        test('never testing and returning the model unchanged fails everything', async () => {
            const results = await run(testsFor(name), { model: plantedModel(c), toolLog: [] });
            expect(results.found).toEqual(['Problem not found by testing']);
            expect(results.fixed).toEqual(['Formulation not fixed']);
            expect(results.robust).toEqual(['Model not robust']);
        });

        test('a what-if run that does not expose the problem does not count as finding it', async () => {
            const harmless = Object.fromEntries(Object.keys(c.trigger).map((k) => [k, String(findVariable(c.clean.variables, k).equation)]));
            const results = await run(testsFor(name).filter((t) => t.expectations.criterion === 'found'), { model: c.clean, toolLog: [scenarioCall(harmless)] });
            expect(results.found).toEqual(['Problem not found by testing']);
        });
    });

    test('runs that do not expose the planted formulation do not count: a typo, or an extreme that breaks any model', async () => {
        const inv = testsFor('Inventory and Workforce').find((x) => x.expectations.criterion === 'found');
        for (const overrides of [{ demandd: 0 }, { demand: -50 }]) {
            expect([overrides, (await evaluate({ model: cases['Inventory and Workforce'].clean, toolLog: [scenarioCall(overrides)] }, inv.expectations)).map((f) => f.type)]).toEqual([overrides, ['Problem not found by testing']]);
        }
        const inf = testsFor('Endemic Infection').find((x) => x.expectations.criterion === 'found');
        expect((await evaluate({ model: cases['Endemic Infection'].clean, toolLog: [scenarioCall({ 'illness duration': 0 })] }, inf.expectations)).map((f) => f.type)).toEqual(['Problem not found by testing']);
    });

    test('client tools are recognized whatever prefix the route gives them', async () => {
        const c = cases['Inventory and Workforce'];
        const t = testsFor('Inventory and Workforce').find((x) => x.expectations.criterion === 'found');
        for (const toolName of ['client_run_scenario', 'mcp__sd-ai__client_run_scenario', 'run_scenario']) {
            expect([toolName, await evaluate({ model: c.clean, toolLog: [{ toolName, arguments: { overrides: c.trigger } }] }, t.expectations)]).toEqual([toolName, []]);
        }
    });

    test('a "fix" that zeroes the flow survives the extreme but changes normal behavior', async () => {
        const c = cases['Project Backlog and Staff'];
        const model = plantedModel(c);
        findVariable(model.variables, c.plant.variable).equation = '0';
        const t = testsFor('Project Backlog and Staff').find((x) => x.expectations.criterion === 'fixed');
        expect((await evaluate({ model }, t.expectations)).map((f) => f.type)).toEqual(['Normal behavior changed']);
    });

    test('a different correct fix (a MAX guard) also counts', async () => {
        const c = cases['Endemic Infection'];
        const model = plantedModel(c);
        findVariable(model.variables, 'infecting').equation = 'transmission_rate * Susceptible * Infected / MAX(Susceptible + Infected + Recovered, 0.001)';
        const t = testsFor('Endemic Infection').find((x) => x.expectations.criterion === 'fixed');
        expect(await evaluate({ model }, t.expectations)).toEqual([]);
    });
});

describe('extremeConditions hard group', () => {
    jest.setTimeout(1800000);
    let HARD, hardCases, plantAll, CLEAN, caseHeldOut, setReader;
    beforeAll(async () => {
        ({ HARD } = await import('../../../evals/categories/extremeConditions.js'));
        ({ hardCases } = await import('../../../evals/categories/extremeConditionsData/cases.js'));
        ({ plantAll } = await import('../../../evals/categories/extremeConditionsData/hard.js'));
        ({ CLEAN_VERDICTS: CLEAN } = await import('../../../evals/categories/guidedCorrectionData/hardShared.js'));
        ({ caseHeldOut } = await import('../../../evals/utilities/heldOut.js'));
        ({ setReader } = await import('../../../evals/utilities/judge.js'));
    });
    afterAll(() => setReader(null));
    const verdict = (v) => setReader(() => ({ verdict: v }));
    const hardTests = (name) => groupTests(groups, 'extremeConditionsHard').filter((t) => t.expectations.caseName === name && t.expectations.criterion !== 'clean');
    const cleanTest = (name) => groupTests(groups, 'extremeConditionsHard').find((t) => t.expectations.caseName === name && t.expectations.criterion === 'clean');
    const runAll = async (tests, response) => {
        const out = {};
        for (const t of tests) out[t.name] = (await evaluate(response, t.expectations)).map((f) => f.type);
        return out;
    };

    test('hard cases are the rule applied to every scenario in the library', async () => {
        const { generateHardCase } = await import('../../../evals/categories/extremeConditionsData/hard.js');
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        const expected = {};
        for (const s of Object.values(scenarios)) {
            const c = await generateHardCase(s);
            if (c) expected[c.name] = c;
        }
        expect(Object.fromEntries(Object.entries(hardCases).map(([n, { clean, ...g }]) => [n, g]))).toEqual(expected);
    }, 3600000);

    test('the group takes the first dev and first two held-out hard cases, with clean controls on the first of each', () => {
        const dev = Object.keys(hardCases).filter((n) => !caseHeldOut(hardCases[n]));
        const held = Object.keys(hardCases).filter((n) => caseHeldOut(hardCases[n]) && !laterBatch(hardCases[n]));
        const later = Object.keys(hardCases).filter((n) => caseHeldOut(hardCases[n]) && laterBatch(hardCases[n]));
        // The first dev case, the first two first-batch held-out cases, then every later-batch one (heldOut.js laterBatch).
        expect(HARD.faulty).toEqual([...dev.slice(0, 1), ...held.slice(0, 2), ...later]);
        expect(HARD.clean).toEqual([...dev.slice(0, 1), ...held.slice(0, 1)]);
        expect(new Set(groupTests(groups, 'extremeConditionsHard').map((t) => JSON.stringify([t.prompt, t.currentModel]))).size).toBe(HARD.faulty.length + HARD.clean.length);
    });

    test('each plant fails under its own extreme, the robust model survives every extreme, and normally they agree; the request does not mention extremes', async () => {
        for (const [name, c] of Object.entries(hardCases)) {
            expect(c.plants.length).toBeGreaterThanOrEqual(1);
            expect(new Set(c.plants.map((p) => p.variable)).size).toBe(c.plants.length);
            for (const p of c.plants) {
                expect([name, p.id, Boolean(await impossibleUnder(plantAll(c.clean, [p]), p.trigger))]).toEqual([name, p.id, true]);
                expect([name, p.id, await impossibleUnder(c.clean, p.trigger)]).toEqual([name, p.id, null]);
            }
            expect([name, await behaviorMismatch(plantAll(c.clean, c.plants), c.clean, 0.05)]).toEqual([name, null]);
        }
        for (const t of groupTests(groups, 'extremeConditionsHard')) {
            expect(t.additionalParameters.analysisTools).toBe(true);
            expect(t.prompt).not.toMatch(/extreme|robust|negative|zero|very large|turn.*off/i);
            // Withheld feedback: the tool is on but never suggested.
            expect(t.prompt).not.toMatch(/run_scenario|tool|what-if|simulat|scenario/i);
        }
    });

    test('testing every extreme and returning the robust model passes every hard test; doing nothing fails every one; fixing all but one plant fails that plant and robustness only', async () => {
        for (const name of HARD.faulty) {
            const c = hardCases[name];
            const calls = c.plants.map((p) => scenarioCall(p.trigger));
            const good = await runAll(hardTests(name), { model: structuredClone(c.clean), toolLog: calls });
            expect([name, Object.values(good).flat()]).toEqual([name, []]);
            const bad = await runAll(hardTests(name), { model: plantAll(c.clean, c.plants), toolLog: [] });
            for (const [n, types] of Object.entries(bad)) expect([n, types.length > 0]).toEqual([n, true]);
            const left = c.plants.at(-1);
            const partial = await runAll(hardTests(name), { model: plantAll(c.clean, [left]), toolLog: calls });
            for (const t of hardTests(name)) {
                const failing = t.expectations.criterion === 'robust' || (t.expectations.criterion === 'fixed' && t.expectations.plantId === left.id);
                expect([t.name, partial[t.name].length > 0]).toEqual([t.name, failing]);
            }
        }
    });

    test('a run that exposes only another plant does not count as finding this one', async () => {
        for (const name of HARD.faulty) {
            const c = hardCases[name];
            for (const p of c.plants) {
                const harmless = Object.fromEntries(Object.keys(p.trigger).map((k) => [k, String(findVariable(c.clean.variables, k).equation)]));
                const t = hardTests(name).find((x) => x.expectations.criterion === 'found' && x.expectations.plantId === p.id);
                expect((await evaluate({ model: c.clean, toolLog: [scenarioCall(harmless)] }, t.expectations)).map((f) => f.type)).toEqual(['Problem not found by testing']);
            }
        }
    });

    test('clean controls: leaving the robust model alone and saying so passes; reporting problems, not saying, or "fixing" what is not broken fails', async () => {
        for (const name of HARD.clean) {
            const c = hardCases[name];
            const t = cleanTest(name);
            verdict(CLEAN.ready);
            expect([name, await evaluate({ model: structuredClone(c.clean), supportingInfo: { explanation: 'It holds up.' } }, t.expectations)]).toEqual([name, []]);
            for (const v of [CLEAN.problems, CLEAN.silent]) {
                verdict(v);
                expect([name, (await evaluate({ model: structuredClone(c.clean), supportingInfo: { explanation: 'x' } }, t.expectations)).map((f) => f.type)]).toEqual([name, ['Problem reported in a correct model']]);
            }
            verdict(CLEAN.ready);
            // Taking a guard out, or zeroing a flow, is not a fix of anything.
            for (const p of c.plants) {
                expect([name, p.id, (await evaluate({ model: plantAll(c.clean, [p]), supportingInfo: { explanation: 'Simplified.' } }, t.expectations)).map((f) => f.type)]).toEqual([name, p.id, ['Correct model changed']]);
            }
            const zeroed = structuredClone(c.clean);
            findVariable(zeroed.variables, c.plants[0].variable).equation = '0';
            expect((await evaluate({ model: zeroed, supportingInfo: { explanation: 'Fixed.' } }, t.expectations)).map((f) => f.type)).toContain('Correct model changed');
            expect((await evaluate({ err: 'boom' }, t.expectations)).map((f) => f.type)).toEqual(['No model produced']);
        }
    });
});
