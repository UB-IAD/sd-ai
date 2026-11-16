import { groupTests, laterBatch } from '../../../evals/utilities/heldOut.js';
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

const { evaluate, groups, methodology, issueList } = await import('../../../evals/categories/mece.js');
const { cases, plantedModel } = await import('../../../evals/categories/meceData/cases.js');
const { behaviorMismatch } = await import('../../../evals/utilities/behaviorCompare.js');
const { findVariable } = await import('../../../evals/utilities/modelDiff.js');

const testsFor = (name) => groupTests(groups, 'mece').filter((t) => t.expectations.caseName === name);
const run = async (tests, response) => {
    const out = {};
    for (const t of tests) out[t.expectations.criterion] = (await evaluate(response, t.expectations)).map((f) => f.type);
    return out;
};

describe('mece category', () => {
    jest.setTimeout(600000);

    test('every planted error changes what the model computes', async () => {
        for (const [name, c] of Object.entries(cases)) expect([name, Boolean(await behaviorMismatch(plantedModel(c), c.correct, 0.02))]).toEqual([name, true]);
    });

    test('the judge sees distractors, and the prompt names no error', () => {
        for (const [name, c] of Object.entries(cases)) {
            expect(issueList(c).filter((i) => !i.real).length).toBe(2);
            expect(testsFor(name)[0].prompt).not.toContain(c.text);
        }
    });

    test('generated cases are the general rule applied to every scenario in the library', async () => {
        const { generateCases } = await import('../../../evals/categories/meceData/generate.js');
        const { generatedCases } = await import('../../../evals/categories/meceData/cases.js');
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        const expected = {};
        for (const s of Object.values(scenarios)) for (const c of await generateCases(s)) expected[c.name] = c;
        expect(Object.fromEntries(Object.entries(generatedCases).map(([n, { correct, ...g }]) => [n, g]))).toEqual(expected);
    }, 1800000);

    test('a fix in a neighbouring variable counts; a compensation that leaves the miscounted quantity wrong does not', async () => {
        const { evaluate, groups } = await import('../../../evals/categories/mece.js');
        const { cases, plantedModel } = await import('../../../evals/categories/meceData/cases.js');
        const name = 'Hotel Ready Rooms';
        const t = groupTests(groups, 'mece').find((x) => x.expectations.caseName === name && x.expectations.criterion === 'error');
        const c = cases[name];
        const notFixed = async (model) => (await evaluate({ model, supportingInfo: { explanation: '' } }, t.expectations)).map((f) => f.type).includes('MECE error not fixed');
        // The planted total left as it is, the missing rooms subtracted where it is used: ready rooms is right again.
        const neighbour = plantedModel(c);
        neighbour.variables.find((v) => v.name === 'ready rooms').equation = 'total_rooms - rooms_out_of_service - Rooms_Awaiting_Cleaning';
        // "rooms out of service" fixed in place: the hybrid check passes, as before.
        const inPlace = plantedModel(c);
        inPlace.variables.find((v) => v.name === 'rooms out of service').equation = 'Occupied_Rooms + Rooms_Awaiting_Cleaning';
        expect(await notFixed(inPlace)).toBe(false);
        // Whether the neighbour fix counts depends on the planted quantity: here it is still miscounted,
        // so it fails — the rule accepts a fix elsewhere only when the planted variable itself computes right.
        expect(await notFixed(neighbour)).toBe(true);
        // The unchanged planted model fails.
        expect(await notFixed(plantedModel(c))).toBe(true);
        // The total rebuilt through a new helper: the put-back copies a reference to a helper the
        // correct model lacks, so that check fails, but the model and the total itself are right.
        const viaHelper = plantedModel(c);
        viaHelper.variables.find((v) => v.name === 'rooms out of service').equation = 'rooms_unavailable';
        viaHelper.variables.push({ name: 'rooms unavailable', type: 'variable', equation: 'Occupied_Rooms + Rooms_Awaiting_Cleaning', units: viaHelper.variables.find((v) => v.name === 'rooms out of service').units });
        expect(await notFixed(viaHelper)).toBe(false);
        // The path the elsewhere rule exists for, and its limit, on the gym: the overlap undone by
        // restructuring the inputs passes; by zeroing a real share (a compensation) it fails.
        const g = cases['Gym Crowding'];
        const gt = groupTests(groups, 'mece').find((x) => x.expectations.caseName === 'Gym Crowding' && x.expectations.criterion === 'error');
        const gymNotFixed = async (model) => (await evaluate({ model, supportingInfo: { explanation: '' } }, gt.expectations)).map((f) => f.type).includes('MECE error not fixed');
        const zeroed = plantedModel(g);
        zeroed.variables.find((v) => v.name === 'personal training share').equation = '0';
        expect(await gymNotFixed(zeroed)).toBe(true);
        const { fixedElsewhere } = await import('../../../evals/categories/mece.js');
        expect(await fixedElsewhere(zeroed, g)).toBe(false);
    }, 600000);

    test('the elsewhere rule accepts a model whose whole run and planted quantity both match the correct one', async () => {
        const { fixedElsewhere } = await import('../../../evals/categories/mece.js');
        const { cases, plantedModel } = await import('../../../evals/categories/meceData/cases.js');
        for (const name of ['Hotel Ready Rooms', 'Project Backlog and Staff']) {
            const c = cases[name];
            expect([name, await fixedElsewhere(structuredClone(c.correct), c)]).toEqual([name, true]);
            expect([name, await fixedElsewhere(plantedModel(c), c)]).toEqual([name, false]);
        }
    }, 600000);

    test('every failure type is documented', () => {
        expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['MECE error not fixed', 'MECE error not identified', 'Model still miscounts', 'No model produced', 'Evaluation error']));
    });

    describe.each(Object.keys(cases))('%s', (name) => {
        const c = cases[name];
        test('the correct model with the error explained passes', async () => {
            identified = new Set([c.text]);
            expect(await run(testsFor(name), { model: structuredClone(c.correct), supportingInfo: { explanation: 'x' } })).toEqual({ error: [], behavior: [] });
        });
        test('the planted model returned unexplained fails both', async () => {
            identified = new Set();
            const results = await run(testsFor(name), { model: plantedModel(c), supportingInfo: { explanation: 'fine' } });
            expect(results.error).toEqual(['MECE error not fixed', 'MECE error not identified']);
            expect(results.behavior).toEqual(['Model still miscounts']);
        });
        test('naming a distractor instead of the real error does not count', async () => {
            identified = new Set(c.distractors);
            const results = await run(testsFor(name).filter((t) => t.expectations.criterion === 'error'), { model: structuredClone(c.correct), supportingInfo: { explanation: 'x' } });
            expect(results.error).toEqual(['MECE error not identified']);
        });
    });

    test('removing the duplicate flow fixes the double drain, even if the flow variable stays behind', async () => {
        const c = cases['Inventory and Workforce'];
        identified = new Set([c.text]);
        const model = plantedModel(c);
        findVariable(model.variables, 'Inventory').outflows = ['shipping'];
        const t = testsFor('Inventory and Workforce').find((x) => x.expectations.criterion === 'error');
        expect(await evaluate({ model, supportingInfo: { explanation: 'x' } }, t.expectations)).toEqual([]);
    });
});

const { HARD, hardIssueList } = await import('../../../evals/categories/mece.js');
const { hardCases, plantedHardModel } = await import('../../../evals/categories/meceData/cases.js');
const { CLEAN_VERDICTS: CLEAN } = await import('../../../evals/categories/guidedCorrectionData/hardShared.js');
const { caseHeldOut } = await import('../../../evals/utilities/heldOut.js');

describe('mece hard group', () => {
    jest.setTimeout(900000);
    const hardTests = (name) => groupTests(groups, 'meceHard').filter((t) => t.expectations.caseName === name && t.expectations.criterion !== 'clean');
    const cleanTest = (name) => groupTests(groups, 'meceHard').find((t) => t.expectations.caseName === name && t.expectations.criterion === 'clean');
    const failuresFor = async (tests, response) => {
        const out = {};
        for (const t of tests) out[t.name] = (await evaluate(response, t.expectations)).map((f) => f.type);
        return out;
    };

    test('hard cases are the rule applied to every scenario and hand case', async () => {
        const { allHardCases } = await import('../../../evals/categories/meceData/hard.js');
        expect(Object.fromEntries(Object.entries(hardCases).map(([n, { correct, ...g }]) => [n, g]))).toEqual(await allHardCases());
    });

    test('the group takes the first dev and first two held-out hard cases, with clean controls on the first of each, five generations', () => {
        // The first dev case, the first two first-batch held-out cases, then every later-batch one (heldOut.js laterBatch).
        const firstBatch = HARD.faulty.filter((n) => !laterBatch(hardCases[n]));
        expect(firstBatch.map((n) => caseHeldOut(hardCases[n]))).toEqual([false, true, true]);
        expect(HARD.faulty.slice(0, 3)).toEqual(firstBatch);
        expect(HARD.faulty.slice(3).every((n) => caseHeldOut(hardCases[n]) && laterBatch(hardCases[n]))).toBe(true);
        expect(HARD.clean.map((n) => caseHeldOut(hardCases[n]))).toEqual([false, true]);
        expect(new Set(groupTests(groups, 'meceHard').map((t) => JSON.stringify([t.prompt, t.currentModel]))).size).toBe(HARD.faulty.length + HARD.clean.length);
    });

    test('every hard case has errors of at least two kinds in different variables, each changing behavior; the request names none', async () => {
        const { plantAll } = await import('../../../evals/categories/meceData/hard.js');
        for (const [name, c] of Object.entries(hardCases)) {
            expect(c.plants.length).toBeGreaterThanOrEqual(2);
            expect(new Set(c.plants.map((p) => p.kind)).size).toBeGreaterThanOrEqual(2);
            expect(new Set(c.plants.map((p) => p.variable)).size).toBe(c.plants.length);
            for (const p of c.plants) expect([name, p.id, Boolean(await behaviorMismatch(plantAll(c.correct, [p]), c.correct, 0.02))]).toEqual([name, p.id, true]);
            expect(hardIssueList(c).filter((x) => x.plantId === null).length).toBe(2);
        }
        for (const t of groupTests(groups, 'meceHard')) expect(t.prompt).not.toMatch(/overlap|twice|left out|leaves out|missing|count|categor|MECE|exclusive|exhaustive/i);
    });

    test('the extra-fault lever: every case the group takes adds a stock filled twice, for three or four errors at once', () => {
        for (const name of HARD.faulty) {
            const c = hardCases[name];
            expect([name, c.plants.at(-1).kind, c.plants.length >= 3]).toEqual([name, 'doubleFill', true]);
            const stock = c.correct.variables.find((v) => v.name === c.plants.at(-1).variable);
            expect(stock.type).toBe('stock');
            expect(c.plants.filter((p) => p.variable === stock.name).length).toBe(1);
        }
    });

    describe.each(HARD.faulty)('%s', (name) => {
        const c = () => hardCases[name];
        test('the correct model with every error explained passes every hard test', async () => {
            identified = new Set(c().plants.map((p) => p.text));
            expect(Object.values(await failuresFor(hardTests(name), { model: structuredClone(c().correct), supportingInfo: { explanation: 'x' } })).flat()).toEqual([]);
        });
        test('returning the planted model unexplained fails every hard test', async () => {
            identified = new Set();
            const results = await failuresFor(hardTests(name), { model: plantedHardModel(c()), supportingInfo: { explanation: 'It is ready.' } });
            for (const [n, types] of Object.entries(results)) expect([n, types.length > 0]).toEqual([n, true]);
        });
        test('fixing all but the last error fails that error and the behavior test only', async () => {
            const { plantAll } = await import('../../../evals/categories/meceData/hard.js');
            identified = new Set(c().plants.map((p) => p.text));
            const left = c().plants.at(-1);
            const results = await failuresFor(hardTests(name), { model: plantAll(c().correct, [left]), supportingInfo: { explanation: 'x' } });
            for (const t of hardTests(name)) expect([t.name, results[t.name].length > 0]).toEqual([t.name, t.expectations.criterion === 'behavior' || t.expectations.plantId === left.id]);
        });
        test('naming the distractors instead of the real errors does not count', async () => {
            identified = new Set(c().distractors);
            const results = await failuresFor(hardTests(name).filter((t) => t.expectations.criterion === 'error'), { model: structuredClone(c().correct), supportingInfo: { explanation: 'x' } });
            for (const types of Object.values(results)) expect(types).toEqual(['MECE error not identified']);
        });
    });

    describe.each(HARD.clean)('%s (clean control)', (name) => {
        const c = () => hardCases[name];
        test('leaving the correct model alone and saying it is ready passes', async () => {
            cleanVerdict = CLEAN.ready;
            expect(await evaluate({ model: structuredClone(c().correct), supportingInfo: { explanation: 'Nothing to fix.' } }, cleanTest(name).expectations)).toEqual([]);
        });
        test('reporting problems that are not there, or not saying, fails even with the model unchanged', async () => {
            for (const verdict of [CLEAN.problems, CLEAN.silent]) {
                cleanVerdict = verdict;
                expect((await evaluate({ model: structuredClone(c().correct), supportingInfo: { explanation: 'x' } }, cleanTest(name).expectations)).map((f) => f.type)).toEqual(['Problem reported in a correct model']);
            }
        });
        test('"fixing" something that is not broken fails', async () => {
            const { plantAll } = await import('../../../evals/categories/meceData/hard.js');
            cleanVerdict = CLEAN.ready;
            for (const p of c().plants) {
                expect([p.id, (await evaluate({ model: plantAll(c().correct, [p]), supportingInfo: { explanation: 'Fixed.' } }, cleanTest(name).expectations)).map((f) => f.type)]).toEqual([p.id, ['Correct model changed']]);
            }
        });
    });
});
