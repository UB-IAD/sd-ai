import { groupTests, laterBatch } from '../../../evals/utilities/heldOut.js';
import { simTest } from '../simTest.js';
import { jest } from '@jest/globals';

let identified = new Set();
let cleanVerdict = null;
jest.unstable_mockModule('../../../evals/utilities/judge.js', () => ({
    extract: async (key, messages, schema) => {
        if (schema?.shape?.verdict) return { verdict: cleanVerdict };
        const listed = messages[1].content.split('Review:')[0];
        const items = [...listed.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ number: Number(m[1]), text: m[2] }));
        return { issues: items.map((x) => ({ number: x.number, identified: identified.has(x.text) ? 'yes' : 'no' })) };
    },
    clearJudgeCache: () => {}
}));

const { evaluate, groups, methodology, issueList } = await import('../../../evals/categories/formulationCritique.js');
const { cases, plantedModel } = await import('../../../evals/categories/formulationCritiqueData/cases.js');
const { lintFormulations } = await import('../../../evals/utilities/formulationLint.js');
const { behaviorMismatch } = await import('../../../evals/utilities/behaviorCompare.js');
const { findVariable } = await import('../../../evals/utilities/modelDiff.js');

const testsFor = (name) => groupTests(groups, 'formulationCritique').filter((t) => t.expectations.caseName === name);
const run = async (tests, response) => {
    const out = {};
    for (const t of tests) out[t.name] = (await evaluate(response, t.expectations)).map((f) => f.type);
    return out;
};

describe('formulationCritique category', () => {
    jest.setTimeout(600000);

    simTest('every plant trips its rule, the clean formulation does not, and the plant computes the same thing', async () => {
        for (const [name, c] of Object.entries(cases)) {
            const clean = lintFormulations(c.clean);
            const planted = lintFormulations(plantedModel(c));
            for (const p of c.plants) {
                expect([name, p.id, clean.some((f) => f.variable === p.variable && f.rule === p.rule)]).toEqual([name, p.id, false]);
                expect([name, p.id, planted.some((f) => f.variable === p.variable && f.rule === p.rule)]).toEqual([name, p.id, true]);
            }
            expect([name, await behaviorMismatch(plantedModel(c), c.clean, 0.001)]).toEqual([name, null]);
        }
    });

    test('the judge always sees distractors, and the prompt names no plant', () => {
        for (const [name, c] of Object.entries(cases)) {
            expect(issueList(c).filter((i) => i.plantId === null).length).toBe(c.distractors.length);
            for (const p of c.plants) expect(testsFor(name)[0].prompt).not.toContain(p.text);
        }
    });

    test('generated cases are the general rule applied to every scenario in the library without a hand-written case', async () => {
        const { generateCase } = await import('../../../evals/categories/formulationCritiqueData/generate.js');
        const { handCases, generatedCases } = await import('../../../evals/categories/formulationCritiqueData/cases.js');
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        const expected = {};
        for (const s of Object.values(scenarios)) {
            const c = generateCase(s);
            if (c && !handCases[c.name]) expected[c.name] = c;
        }
        expect(Object.fromEntries(Object.entries(generatedCases).map(([n, { clean, ...g }]) => [n, g]))).toEqual(expected);
    });

    test('every failure type is documented', () => {
        expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['Formulation not fixed', 'Formulation not identified', 'Behavior changed', 'No model produced', 'Evaluation error']));
    });

    describe.each(Object.keys(cases))('%s', (name) => {
        const c = cases[name];

        simTest('the clean model with every plant named passes everything', async () => {
            identified = new Set(c.plants.map((p) => p.text));
            const results = await run(testsFor(name), { model: structuredClone(c.clean), supportingInfo: { explanation: 'review' } });
            expect(Object.values(results).flat()).toEqual([]);
        });

        simTest('returning the planted model unchanged, with nothing named, fails every plant', async () => {
            identified = new Set();
            const results = await run(testsFor(name).filter((t) => t.expectations.criterion === 'plant'), { model: plantedModel(c), supportingInfo: { explanation: 'looks fine' } });
            for (const types of Object.values(results)) expect(types).toEqual(expect.arrayContaining(['Formulation not fixed', 'Formulation not identified']));
        });
    });

    simTest('a fix that names a new constant counts; one that changes the value does not', async () => {
        const c = cases['Predators and Prey'];
        identified = new Set(c.plants.map((p) => p.text));
        const t = testsFor('Predators and Prey').find((x) => x.expectations.criterion === 'plant');
        const named = plantedModel(c);
        findVariable(named.variables, 'predator deaths').equation = 'Predators * predator_mortality';
        named.variables.push({ name: 'predator mortality', type: 'variable', equation: '0.2', units: '1/year' });
        expect(await evaluate({ model: named, supportingInfo: { explanation: 'x' } }, t.expectations)).toEqual([]);
        const changed = plantedModel(c);
        findVariable(changed.variables, 'predator deaths').equation = 'Predators * predator_death_rate * 2';
        const types = (await evaluate({ model: changed, supportingInfo: { explanation: 'x' } }, t.expectations)).map((f) => f.type);
        expect(types.length).toBeGreaterThan(0);
        expect(new Set(types)).toEqual(new Set(['Formulation not fixed']));
    });

    simTest('splitting an inlined formula into a named intermediate fixes too-many-inputs', async () => {
        const c = cases['Inventory and Workforce'];
        identified = new Set(c.plants.map((p) => p.text));
        const t = testsFor('Inventory and Workforce').find((x) => x.expectations.plantId === 'desired workers inlined');
        const model = plantedModel(c);
        findVariable(model.variables, 'desired workers').equation = 'production_target / productivity';
        model.variables.push({ name: 'production target', type: 'variable', equation: 'Expected_Demand + (desired_inventory - Inventory) / inventory_adjustment_time', units: 'widgets/month' });
        expect(await evaluate({ model, supportingInfo: { explanation: 'x' } }, t.expectations)).toEqual([]);
    });
});

const { HARD } = await import('../../../evals/categories/formulationCritique.js');
const { hardCases } = await import('../../../evals/categories/formulationCritiqueData/cases.js');
const { CLEAN_VERDICTS: CLEAN } = await import('../../../evals/categories/guidedCorrectionData/hardShared.js');
const { caseHeldOut } = await import('../../../evals/utilities/heldOut.js');

describe('formulationCritique hard group', () => {
    jest.setTimeout(900000);
    const hardTests = (name) => groupTests(groups, 'formulationCritiqueHard').filter((t) => t.expectations.caseName === name && t.expectations.criterion !== 'clean');
    const cleanTest = (name) => groupTests(groups, 'formulationCritiqueHard').find((t) => t.expectations.caseName === name && t.expectations.criterion === 'clean');

    simTest('hard cases are the rule applied to every scenario in the library', async () => {
        const { generateHardCase } = await import('../../../evals/categories/formulationCritiqueData/hard.js');
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        const expected = {};
        for (const s of Object.values(scenarios)) {
            const c = await generateHardCase(s);
            if (c) expected[c.name] = c;
        }
        expect(Object.fromEntries(Object.entries(hardCases).map(([n, { clean, ...g }]) => [n, g]))).toEqual(expected);
    });

    test('the group takes the first dev and first two held-out hard cases, with clean controls on the first of each, five generations', () => {
        // The first dev case, the first two first-batch held-out cases, then every later-batch one (heldOut.js laterBatch).
        const firstBatch = HARD.faulty.filter((n) => !laterBatch(hardCases[n]));
        expect(firstBatch.map((n) => caseHeldOut(hardCases[n]))).toEqual([false, true, true]);
        expect(HARD.faulty.slice(0, 3)).toEqual(firstBatch);
        expect(HARD.faulty.slice(3).every((n) => caseHeldOut(hardCases[n]) && laterBatch(hardCases[n]))).toBe(true);
        expect(HARD.clean.map((n) => caseHeldOut(hardCases[n]))).toEqual([false, true]);
        expect(new Set(groupTests(groups, 'formulationCritiqueHard').map((t) => JSON.stringify([t.prompt, t.currentModel]))).size).toBe(HARD.faulty.length + HARD.clean.length);
    });

    simTest('every hard case has three or more plants of two or more kinds in different variables; each trips its rule and computes the same thing; the request names none', async () => {
        for (const [name, c] of Object.entries(hardCases)) {
            expect(c.plants.length).toBeGreaterThanOrEqual(3);
            expect(new Set(c.plants.map((p) => p.rule)).size).toBeGreaterThanOrEqual(2);
            expect(new Set(c.plants.map((p) => p.variable)).size).toBe(c.plants.length);
            expect(lintFormulations(c.clean)).toEqual([]);
            const planted = lintFormulations(plantedModel(c));
            for (const p of c.plants) expect([name, p.id, planted.some((f) => f.variable === p.variable && f.rule === p.rule)]).toEqual([name, p.id, true]);
            expect([name, await behaviorMismatch(plantedModel(c), c.clean, 0.001)]).toEqual([name, null]);
        }
        for (const t of groupTests(groups, 'formulationCritiqueHard')) expect(t.prompt).not.toMatch(/formulation|best practice|constant|input|number|clarity|robust|STEP|switch|division/i);
    });

    describe.each(HARD.faulty)('%s', (name) => {
        const c = () => hardCases[name];
        simTest('the clean model with every plant named passes every hard test', async () => {
            identified = new Set(c().plants.map((p) => p.text));
            expect(Object.values(await run(hardTests(name), { model: structuredClone(c().clean), supportingInfo: { explanation: 'review' } })).flat()).toEqual([]);
        });
        simTest('returning the planted model unchanged, with nothing named, fails every hard test', async () => {
            identified = new Set();
            const results = await run(hardTests(name), { model: plantedModel(c()), supportingInfo: { explanation: 'It is ready.' } });
            for (const [n, types] of Object.entries(results)) expect([n, types.length > 0]).toEqual([n, true]);
        });
        simTest('more faults: the second pass gives the case more than the first three plants, and fixing only the first three fails every later one', async () => {
            const { HARD_PLANTS, MAX_PLANTS } = await import('../../../evals/categories/formulationCritiqueData/hard.js');
            expect(c().plants.length).toBeGreaterThan(HARD_PLANTS);
            expect(c().plants.length).toBeLessThanOrEqual(MAX_PLANTS);
            identified = new Set(c().plants.map((p) => p.text));
            const later = c().plants.slice(HARD_PLANTS);
            const results = await run(hardTests(name), { model: plantedModel({ ...c(), plants: later }), supportingInfo: { explanation: 'x' } });
            for (const t of hardTests(name).filter((x) => x.expectations.criterion === 'plant')) expect([t.name, results[t.name].length > 0]).toEqual([t.name, later.some((p) => p.id === t.expectations.plantId)]);
        });
        simTest('fixing all but the last plant fails that plant only', async () => {
            identified = new Set(c().plants.map((p) => p.text));
            const left = c().plants.at(-1);
            const results = await run(hardTests(name), { model: plantedModel({ ...c(), plants: [left] }), supportingInfo: { explanation: 'x' } });
            for (const t of hardTests(name)) expect([t.name, results[t.name].length > 0]).toEqual([t.name, t.expectations.plantId === left.id]);
        });
    });

    describe.each(HARD.clean)('%s (clean control)', (name) => {
        const c = () => hardCases[name];
        simTest('leaving the clean model alone and saying it is ready passes', async () => {
            cleanVerdict = CLEAN.ready;
            expect(await evaluate({ model: structuredClone(c().clean), supportingInfo: { explanation: 'Nothing to fix.' } }, cleanTest(name).expectations)).toEqual([]);
        });
        simTest('reporting problems that are not there, or not saying, fails even with the model unchanged', async () => {
            for (const verdict of [CLEAN.problems, CLEAN.silent]) {
                cleanVerdict = verdict;
                expect((await evaluate({ model: structuredClone(c().clean), supportingInfo: { explanation: 'x' } }, cleanTest(name).expectations)).map((f) => f.type)).toEqual(['Problem reported in a correct model']);
            }
        });
        simTest('"fixing" something that is not broken fails: a plant put in, or a constant changed', async () => {
            cleanVerdict = CLEAN.ready;
            for (const p of c().plants) {
                expect([p.id, (await evaluate({ model: plantedModel({ ...c(), plants: [p] }), supportingInfo: { explanation: 'Fixed.' } }, cleanTest(name).expectations)).map((f) => f.type)]).toEqual([p.id, ['Correct model changed']]);
            }
            const changed = structuredClone(c().clean);
            const constant = changed.variables.find((v) => v.type !== 'stock' && /^[0-9.]+$/.test(String(v.equation).trim()) && Number(v.equation) > 0 && c().plants.some((p) => p.text.includes(`"${v.name}"`)));
            constant.equation = String(Number(constant.equation) * 2);
            expect((await evaluate({ model: changed, supportingInfo: { explanation: 'Adjusted.' } }, cleanTest(name).expectations)).map((f) => f.type)).toEqual(['Correct model changed']);
        });
    });
});
