import { groupTests, laterBatch } from '../../../evals/utilities/heldOut.js';
import { jest } from '@jest/globals';

// The judge is the only LLM call; stand in for it so the tests run offline and exactly.
let identified = new Set();
let cleanVerdict = null;
jest.unstable_mockModule('../../../evals/utilities/judge.js', () => ({
    extract: async (key, messages, schema) => {
        if (schema?.shape?.verdict) return { verdict: cleanVerdict };
        const listed = messages[1].content.split('Response:')[0];
        const numbers = [...listed.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ number: Number(m[1]), text: m[2] }));
        return { problems: numbers.map((p) => ({ number: p.number, identified: identified.has(p.text) ? 'yes' : 'no' })) };
    },
    clearJudgeCache: () => {}
}));

const { evaluate, groups, methodology, problemList, HARD } = await import('../../../evals/categories/guidedCorrection.js');
const { cases, generatedCases, hardCases, plantErrors } = await import('../../../evals/categories/guidedCorrectionData/cases.js');
const { CLEAN_VERDICTS: CLEAN } = await import('../../../evals/categories/guidedCorrectionData/hardShared.js');
const { findVariable } = await import('../../../evals/utilities/modelDiff.js');
const { simulateModel } = await import('../../../evals/utilities/simulateModel.js');

const testsFor = (group, name) => groupTests(groups, group).filter((t) => t.expectations.caseName === name);
const failuresFor = async (tests, response) => {
    const out = {};
    for (const t of tests) out[t.name] = (await evaluate(response, t.expectations)).map((f) => f.type);
    return out;
};
const withText = (model, text) => ({ model, supportingInfo: { explanation: text } });

/** The correct model plus the case's requested addition, built the way the request asks. */
const extended = function(name) {
    const model = structuredClone(cases[name].correct);
    const add = (v) => model.variables.push(v);
    if (generatedCases[name]) {
        // The general request: a flow draining one stock at a constant fraction.
        const { stockFlows: [{ stock, outflow }], variables: [, { name: fraction }] } = cases[name].extension;
        add({ name: outflow, type: 'flow', equation: `${stock.replace(/ /g, '_')} * ${fraction.replace(/ /g, '_')}` });
        add({ name: fraction, type: 'variable', equation: '0.01' });
        findVariable(model.variables, stock).outflows.push(outflow);
    } else if (name === 'Endemic Infection') {
        add({ name: 'vaccinating', type: 'flow', equation: 'Susceptible * vaccination_fraction', units: 'people/year' });
        add({ name: 'vaccination fraction', type: 'variable', equation: '0.05', units: '1/year' });
        findVariable(model.variables, 'Susceptible').outflows.push('vaccinating');
        findVariable(model.variables, 'Recovered').inflows.push('vaccinating');
    } else if (name === 'Inventory and Workforce') {
        add({ name: 'promotional demand', type: 'variable', equation: '5', units: 'widgets/month' });
        add({ name: 'base demand', type: 'variable', equation: '20', units: 'widgets/month' });
        findVariable(model.variables, 'demand').equation = 'base_demand + promotional_demand';
    } else {
        add({ name: 'adult immigration', type: 'flow', equation: 'immigrants_per_year', units: 'people/year' });
        add({ name: 'immigrants per year', type: 'variable', equation: '200', units: 'people/year' });
        findVariable(model.variables, 'Adults').inflows.push('adult immigration');
    }
    return model;
};

describe('guidedCorrection category', () => {
    jest.setTimeout(600000);

    test('every planted error visibly changes behavior (so fixing it is measurable)', async () => {
        for (const [name, c] of Object.entries(cases)) {
            const stocks = c.correct.variables.filter((v) => v.type === 'stock').map((v) => v.name);
            const truth = await simulateModel(c.correct, stocks, null);
            for (const error of c.errors) {
                const broken = await simulateModel(plantErrors(c.correct, [error]), stocks, null);
                const differs = !broken.ok || stocks.some((s) => broken.series[s].some((v, i) => Math.abs(v - truth.series[s][i]) > 0.05 * Math.max(...truth.series[s].map(Math.abs))));
                expect([name, error.id, differs]).toEqual([name, error.id, true]);
            }
        }
    });

    test('the judge always sees distractors next to the real errors, and the prompt never names them', () => {
        for (const [name, c] of Object.entries(cases)) {
            const list = problemList(c);
            expect(list.filter((p) => p.errorId === null).length).toBe(c.distractors.length);
            for (const t of [...testsFor('findAndFix', name), ...testsFor('selfCorrection', name)]) {
                for (const error of c.errors) expect(t.prompt).not.toContain(error.text);
            }
        }
    });

    test('no case asks for an addition that touches the variable its earlier error lives in', () => {
        // hybridModel copies the engine's whole version of that variable into the correct model. If
        // the requested addition also changed it (a new flow on the same stock, say), a correct fix
        // plus the addition would differ from the correct model and fail "Own error not fixed".
        for (const [name, c] of Object.entries(cases)) {
            const planted = c.errors.find((e) => e.id === c.plantedForExtension).variable;
            const touched = [
                ...(c.extension.stockFlows || []).map((s) => s.stock),
                ...(c.extension.references || []).map((r) => r.variable),
                ...(c.extension.variables || []).map((v) => v.name)
            ];
            expect([name, touched.includes(planted)]).toEqual([name, false]);
        }
    });

    test('generated cases are the general rule applied to every scenario in the library', async () => {
        const { generateCase } = await import('../../../evals/categories/guidedCorrectionData/generate.js');
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        const expected = {};
        for (const s of Object.values(scenarios)) {
            const c = await generateCase(s);
            if (c) expected[c.name] = c;
        }
        expect(Object.fromEntries(Object.entries(generatedCases).map(([n, { correct, ...g }]) => [n, g]))).toEqual(expected);
    });

    test('generated errors are of two different kinds in two different variables, and every distractor is a claim the model does not bear out', async () => {
        const { candidatesFor } = await import('../../../evals/categories/guidedCorrectionData/generate.js');
        for (const [name, c] of Object.entries(generatedCases)) {
            expect(new Set(c.errors.map((e) => e.kind)).size).toBe(2);
            expect(new Set(c.errors.map((e) => e.variable)).size).toBe(2);
            const claims = candidatesFor(c.correct).filter((x) => !c.errors.some((e) => e.id === x.id)).map((x) => x.falseClaim);
            for (const d of c.distractors) expect([name, claims.includes(d)]).toEqual([name, true]);
        }
    });

    test('every failure type is documented', () => {
        const documented = methodology().criteria.map((c) => c.name);
        expect(documented).toEqual(expect.arrayContaining(['Error not fixed', 'Error not explained', 'Model still misbehaves', 'Own error not fixed', 'Requested addition missing', 'Model does not simulate', 'No model produced', 'Evaluation error']));
    });

    describe.each(Object.keys(cases))('%s', (name) => {
        const c = cases[name];

        test('findAndFix: the correct model with every error explained passes everything', async () => {
            identified = new Set(c.errors.map((e) => e.text));
            const results = await failuresFor(testsFor('findAndFix', name), withText(structuredClone(c.correct), 'I found and fixed the problems.'));
            expect(Object.values(results).flat()).toEqual([]);
        });

        test('findAndFix: returning the broken model unexplained fails every error and the behavior test', async () => {
            identified = new Set();
            const results = await failuresFor(testsFor('findAndFix', name), withText(plantErrors(c.correct, c.errors), 'Looks fine to me.'));
            // Each error test must fail on the fix itself, not only on the missing explanation.
            for (const t of testsFor('findAndFix', name)) {
                const types = results[t.name];
                if (t.expectations.criterion === 'behavior') expect([t.name, types.length > 0]).toEqual([t.name, true]);
                else expect([t.name, types]).toEqual([t.name, expect.arrayContaining(['Error not fixed', 'Error not explained'])]);
            }
        });

        test('findAndFix: fixing one error and explaining it passes that error only', async () => {
            const [fixed, left] = c.errors;
            identified = new Set([fixed.text]);
            const results = await failuresFor(testsFor('findAndFix', name), withText(plantErrors(c.correct, [left]), 'One problem.'));
            expect(results[`${name}: finds and fixes "${fixed.id}"`]).toEqual([]);
            expect(results[`${name}: finds and fixes "${left.id}"`]).toEqual(expect.arrayContaining(['Error not fixed', 'Error not explained']));
        });

        test('findAndFix: fixing silently, without explaining, is not enough', async () => {
            identified = new Set();
            const results = await failuresFor(testsFor('findAndFix', name), withText(structuredClone(c.correct), 'Done.'));
            expect(results[`${name}: finds and fixes "${c.errors[0].id}"`]).toEqual(['Error not explained']);
        });

        test('selfCorrection: fixing the earlier error while adding what was asked passes everything', async () => {
            const results = await failuresFor(testsFor('selfCorrection', name), { model: extended(name) });
            expect(Object.values(results).flat()).toEqual([]);
        });

        test('selfCorrection: adding what was asked but leaving the error fails only the self-correction test', async () => {
            const planted = c.errors.find((e) => e.id === c.plantedForExtension);
            const results = await failuresFor(testsFor('selfCorrection', name), { model: plantErrors(extended(name), [planted]) });
            expect(Object.entries(results).filter(([, types]) => types.length).map(([n, types]) => [n.split(': ')[1].split(' ')[0], types])).toEqual([['fixes', ['Own error not fixed']]]);
        });

        test('selfCorrection: fixing the error but skipping the addition fails the addition test, and the simulates test with it', async () => {
            const results = await failuresFor(testsFor('selfCorrection', name), { model: structuredClone(c.correct) });
            const failed = Object.entries(results).filter(([, types]) => types.length);
            // The simulates test counts only once the addition is made, so it fails with the addition test.
            expect(failed.map(([n]) => testsFor('selfCorrection', name).find((t) => t.name === n).expectations.criterion).sort()).toEqual(['extension', 'simulates']);
            for (const [, types] of failed) expect(types.every((t) => t === 'Requested addition missing')).toBe(true);
        });
    });

    test('a fix that introduces a helper variable still counts', async () => {
        const c = cases['Endemic Infection'];
        identified = new Set(c.errors.map((e) => e.text));
        const model = structuredClone(c.correct);
        findVariable(model.variables, 'recovering').equation = 'Infected * recovery_rate';
        model.variables.push({ name: 'recovery rate', type: 'variable', equation: '1 / illness_duration', units: '1/year' });
        const results = await failuresFor(testsFor('findAndFix', 'Endemic Infection'), withText(model, 'Fixed recovery.'));
        expect(results['Endemic Infection: finds and fixes "recovery formulation"']).toEqual([]);
    });

    test('fixing a stock\'s flows while also changing its initial value still fixes the flow error', async () => {
        const c = cases['Endemic Infection'];
        identified = new Set(c.errors.map((e) => e.text));
        const model = structuredClone(c.correct);
        findVariable(model.variables, 'Infected').equation = '500';
        const results = await failuresFor(testsFor('findAndFix', 'Endemic Infection'), withText(model, 'Reconnected infecting; also changed the initial infected.'));
        expect(results['Endemic Infection: finds and fixes "infecting not connected"']).toEqual([]);
        expect(results['Endemic Infection: corrected model behaves like the correct one']).toEqual(['Model still misbehaves']);
    });

    test('no model is reported, not thrown', async () => {
        const results = await failuresFor(testsFor('selfCorrection', 'Population Aging Chain'), { err: 'boom' });
        expect(Object.values(results).every((t) => t.length > 0 && t.every((x) => x === 'No model produced'))).toBe(true);
    });
});

describe('guidedCorrection conversation group', () => {
    test('the novice knows only symptoms, one per error, and the opening names no error', async () => {
        const { noviceScriptFor } = await import('../../../evals/categories/guidedCorrection.js');
        for (const [name, c] of Object.entries(cases)) {
            const script = noviceScriptFor(name);
            expect(script.facts.map((f) => f.id)).toEqual(c.errors.map((e) => e.id));
            const opening = groupTests(groups, 'guidedConversation').find((t) => t.expectations.caseName === name).prompt;
            for (const e of c.errors) { expect(opening).not.toContain(e.symptom); expect(opening).not.toContain(e.text); }
        }
    });

    test('running the model after the last change passes; changing after the last run fails', async () => {
        const t = groupTests(groups, 'guidedConversation').find((x) => x.expectations.criterion === 'ranAfterChange');
        const model = structuredClone(cases[t.expectations.caseName].correct);
        const ok = await evaluate({ model, toolLog: [{ toolName: 'edit_variables' }, { toolName: 'mcp__sd-ai__run_model' }] }, t.expectations);
        expect(ok).toEqual([]);
        const late = await evaluate({ model, toolLog: [{ toolName: 'run_model' }, { toolName: 'edit_variables' }] }, t.expectations);
        expect(late.map((f) => f.type)).toEqual(['Did not check its fix']);
        const neverChanged = await evaluate({ model, toolLog: [{ toolName: 'run_model' }] }, t.expectations);
        expect(neverChanged.map((f) => f.type)).toEqual(['Did not check its fix']);
        const notes = await evaluate({ model, toolLog: [{ toolName: 'edit_variables' }, { toolName: 'run_model' }, { toolName: 'Write', arguments: { file_path: '/tmp/notes.md' } }] }, t.expectations);
        expect(notes).toEqual([]);
    });

    test('the per-error tests work the same in the conversation group', async () => {
        const name = 'Endemic Infection';
        const c = cases[name];
        identified = new Set(c.errors.map((e) => e.text));
        const tests = groupTests(groups, 'guidedConversation').filter((x) => x.expectations.caseName === name && x.expectations.criterion === 'error');
        for (const t of tests) expect(await evaluate({ model: structuredClone(c.correct), supportingInfo: { explanation: 'found them' } }, t.expectations)).toEqual([]);
    });
});

describe('guidedCorrection hard group', () => {
    jest.setTimeout(900000);
    const hardTests = (name) => groupTests(groups, 'findAndFixHard').filter((t) => t.expectations.caseName === name && t.expectations.criterion !== 'clean');
    const cleanTest = (name) => groupTests(groups, 'findAndFixHard').find((t) => t.expectations.caseName === name && t.expectations.criterion === 'clean');

    test('hard cases are the rule applied to every scenario in the library', async () => {
        const { generateHardCase } = await import('../../../evals/categories/guidedCorrectionData/hard.js');
        const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
        const expected = {};
        for (const s of Object.values(scenarios)) {
            const c = await generateHardCase(s);
            if (c) expected[c.name] = c;
        }
        expect(Object.fromEntries(Object.entries(hardCases).map(([n, { correct, ...g }]) => [n, g]))).toEqual(expected);
    });

    test('the group takes the first dev and first two held-out hard cases, with clean controls on the first of each, about five generations', async () => {
        const { caseHeldOut } = await import('../../../evals/utilities/heldOut.js');
        // The first dev case, the first two first-batch held-out cases, then every later-batch one (heldOut.js laterBatch).
        const firstBatch = HARD.faulty.filter((n) => !laterBatch(hardCases[n]));
        expect(firstBatch.map((n) => caseHeldOut(hardCases[n]))).toEqual([false, true, true]);
        expect(HARD.faulty.slice(0, 3)).toEqual(firstBatch);
        expect(HARD.faulty.slice(3).every((n) => caseHeldOut(hardCases[n]) && laterBatch(hardCases[n]))).toBe(true);
        expect(HARD.clean.map((n) => caseHeldOut(hardCases[n]))).toEqual([false, true]);
        const tests = groupTests(groups, 'findAndFixHard');
        expect(new Set(tests.map((t) => JSON.stringify([t.prompt, t.currentModel]))).size).toBe(HARD.faulty.length + HARD.clean.length);
        expect(groups.findAndFixHard.length).toBeGreaterThan(0);
        expect(groups.findAndFixHardHeldOut.length).toBeGreaterThan(0);
    });

    test('every hard case has three errors of three kinds plus at most one more, each in its own variable and changing behavior, and distractors the model does not bear out', async () => {
        const { candidatesFor } = await import('../../../evals/categories/guidedCorrectionData/generate.js');
        for (const [name, c] of Object.entries(hardCases)) {
            expect(new Set(c.errors.slice(0, 3).map((e) => e.kind)).size).toBe(3);
            expect([3, 4]).toContain(c.errors.length);
            expect(new Set(c.errors.map((e) => e.variable)).size).toBe(c.errors.length);
            expect(new Set(c.errors.map((e) => e.id)).size).toBe(c.errors.length);
            expect(c.distractors.length).toBe(2);
            const stocks = c.correct.variables.filter((v) => v.type === 'stock').map((v) => v.name);
            const truth = await simulateModel(c.correct, stocks, null);
            for (const error of c.errors) {
                const broken = await simulateModel(plantErrors(c.correct, [error]), stocks, null);
                const differs = !broken.ok || stocks.some((s) => broken.series[s].some((v, i) => Math.abs(v - truth.series[s][i]) > 0.05 * Math.max(...truth.series[s].map(Math.abs))));
                expect([name, error.id, differs]).toEqual([name, error.id, true]);
            }
            const claims = candidatesFor(c.correct).filter((x) => !c.errors.some((e) => e.id === x.id)).map((x) => x.falseClaim);
            for (const d of c.distractors) expect([name, claims.includes(d)]).toEqual([name, true]);
        }
    });

    test('the extra-fault lever: every case the group takes carries four errors at once', () => {
        for (const name of HARD.faulty) expect([name, hardCases[name].errors.length]).toEqual([name, 4]);
        expect(groupTests(groups, 'findAndFixHard').filter((t) => t.expectations.criterion === 'error').length).toBe(12);
    });

    test('the hard request names no kind of problem', () => {
        for (const t of groupTests(groups, 'findAndFixHard')) {
            expect(t.prompt).not.toMatch(/multipl|divid|backwards|gap|connect|outflow|inflow|drain|error|wrong|misbehav/i);
        }
    });

    describe.each(HARD.faulty)('%s', (name) => {
        const c = () => hardCases[name];

        test('the correct model with every error explained passes every hard test', async () => {
            identified = new Set(c().errors.map((e) => e.text));
            const results = await failuresFor(hardTests(name), withText(structuredClone(c().correct), 'I found and fixed every problem.'));
            expect(Object.values(results).flat()).toEqual([]);
        });

        test('returning the planted model unexplained fails every hard test', async () => {
            identified = new Set();
            const results = await failuresFor(hardTests(name), withText(plantErrors(c().correct, c().errors), 'It is ready.'));
            for (const [n, types] of Object.entries(results)) expect([n, types.length > 0]).toEqual([n, true]);
        });

        test('fixing all but the last error fails that one and the behavior test only', async () => {
            identified = new Set(c().errors.map((e) => e.text));
            const [left] = c().errors.slice(-1);
            const results = await failuresFor(hardTests(name), withText(plantErrors(c().correct, [left]), 'Fixed what I found.'));
            for (const t of hardTests(name)) {
                const failed = results[t.name].length > 0;
                expect([t.name, failed]).toEqual([t.name, t.expectations.criterion === 'behavior' || t.expectations.errorId === left.id]);
            }
        });
    });

    describe.each(HARD.clean)('%s (clean control)', (name) => {
        const c = () => hardCases[name];

        test('leaving the correct model alone and saying it is ready passes', async () => {
            cleanVerdict = CLEAN.ready;
            expect(await evaluate(withText(structuredClone(c().correct), 'Nothing needs fixing.'), cleanTest(name).expectations)).toEqual([]);
        });

        test('reporting problems that are not there fails, even with the model unchanged', async () => {
            cleanVerdict = CLEAN.problems;
            expect((await evaluate(withText(structuredClone(c().correct), 'I fixed several problems.'), cleanTest(name).expectations)).map((f) => f.type)).toEqual(['Problem reported in a correct model']);
            cleanVerdict = CLEAN.silent;
            expect((await evaluate(withText(structuredClone(c().correct), 'Here is the model.'), cleanTest(name).expectations)).map((f) => f.type)).toEqual(['Problem reported in a correct model']);
        });

        test('"fixing" something that is not broken fails', async () => {
            // Any of the planted errors, applied to the correct model as a "fix", changes it.
            for (const error of c().errors) {
                cleanVerdict = CLEAN.problems;
                const types = (await evaluate(withText(plantErrors(c().correct, [error]), 'Fixed it.'), cleanTest(name).expectations)).map((f) => f.type);
                expect([error.id, types]).toEqual([error.id, ['Correct model changed', 'Problem reported in a correct model']]);
            }
        });

        test('returning nothing fails', async () => {
            expect((await evaluate({ err: 'boom' }, cleanTest(name).expectations)).map((f) => f.type)).toEqual(['No model produced']);
        });
    });
});
