import { groupTests } from '../../../evals/utilities/heldOut.js';
import { simTest } from '../simTest.js';
import { jest } from '@jest/globals';

let reply = {};
jest.unstable_mockModule('../../../evals/utilities/judge.js', () => ({
    extract: async () => reply,
    clearJudgeCache: () => {}
}));

const { evaluate, groups, methodology, cases, costAt, bestCost, truePeak, usedMethod, costModel, COST_TOLERANCE } = await import('../../../evals/categories/policyAnalysisMethods.js');
const { cases: calibrationCases, givenModel } = await import('../../../evals/categories/calibrationData/cases.js');
const { findVariable } = await import('../../../evals/utilities/modelDiff.js');
const { simulateModel } = await import('../../../evals/utilities/simulateModel.js');
const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
const { glossaryModel } = await import('../../../evals/utilities/scenarios/renameModel.js');

const testOf = (name, criterion) => groupTests(groups, 'policyAnalysisMethods').find((t) => t.expectations.caseName === name && t.expectations.criterion === criterion);
const types = async (name, criterion, response) => (await evaluate(response, testOf(name, criterion).expectations)).map((f) => f.type);
const call = (toolName, args) => ({ toolName, arguments: args });

describe('policyAnalysisMethods category', () => {
    jest.setTimeout(900000);

    simTest('the cost optimum is inside the range, and the current target wait is well short of it', async () => {
        const best = await bestCost();
        expect(best.targetWait).toBeGreaterThan(0.4);
        expect(best.targetWait).toBeLessThan(1.5);
        expect(await costAt(2)).toBeGreaterThan(best.cost * (1 + 3 * COST_TOLERANCE));
        expect(await costAt(0.25)).toBeGreaterThan(best.cost * (1 + COST_TOLERANCE));
        expect(await costAt(6)).toBeGreaterThan(best.cost * (1 + COST_TOLERANCE));
    });

    simTest('in the bike-share model, persuasion moves members at month 18 several times as much as advertising', async () => {
        const m = { ...glossaryModel(scenarios.bikeShare), specs: scenarios.bikeShare.model.specs };
        const at18 = async (o) => { const r = await simulateModel(m, ['members'], o); return r.series.members[r.time.findIndex((t) => t >= 18 - 1e-9)]; };
        const base = await at18(null);
        const swing = async (p, v) => Math.abs((await at18({ [p]: String(v * 1.2) })) - (await at18({ [p]: String(v * 0.8) }))) / base;
        expect(await swing('persuasion', 0.025)).toBeGreaterThan(3 * (await swing('advertising effect', 0.0005)));
    });

    simTest('the referral jump raises the peak well beyond the tolerance', async () => {
        const m = { ...glossaryModel(scenarios.dialysisClinic), specs: scenarios.dialysisClinic.model.specs };
        const r = await simulateModel(m, ['waiting list'], null);
        expect(await truePeak()).toBeGreaterThan(1.3 * Math.max(...r.series['waiting list']));
    });

    simTest('generated cases are the general rule applied to every scenario the hand-written cases do not use', async () => {
        const { generateCases } = await import('../../../evals/categories/policyAnalysisMethodsData/generate.js');
        const { generatedCases } = await import('../../../evals/categories/policyAnalysisMethods.js');
        const HAND = ['dialysisClinic', 'bikeShare', 'distributor'];
        const expected = {};
        for (const [id, s] of Object.entries(scenarios)) if (!HAND.includes(id)) for (const c of await generateCases(s, calibrationCases)) expected[c.name] = c;
        expect(Object.fromEntries(Object.entries(generatedCases).map(([n, { model, ...g }]) => [n, g]))).toEqual(expected);
    });

    simTest('generated cases: the right answers pass, a wrong one fails, and the method is needed', async () => {
        const { generatedCases } = await import('../../../evals/categories/policyAnalysisMethods.js');
        for (const [name, c] of Object.entries(generatedCases)) {
            if (c.kind === 'scenario') {
                reply = { peak: c.truth };
                expect([name, await types(name, 'result', { supportingInfo: { explanation: 'x' } })]).toEqual([name, []]);
                reply = { peak: c.truth * 1.5 };
                expect([name, await types(name, 'result', { supportingInfo: { explanation: 'x' } })]).toEqual([name, ['Wrong answer']]);
                const log = [call('run_scenario', { overrides: { [c.overrideNames[0]]: String(c.overrideValue) } })];
                expect([name, usedMethod(c, log), usedMethod(c, [])]).toEqual([name, true, false]);
            } else if (c.kind === 'sensitivity') {
                const swept = [call('run_sensitivity', { parameters: c.parameters.map((p) => ({ name: p })) })];
                reply = { matters_more: c.answer };
                expect([name, await types(name, 'result', { supportingInfo: { explanation: 'x' }, toolLog: swept })]).toEqual([name, []]);
                expect([name, await types(name, 'result', { supportingInfo: { explanation: 'x' } })]).toEqual([name, ['Wrong method']]);
                reply = { matters_more: c.options.find((o) => o !== c.answer) };
                expect([name, await types(name, 'result', { supportingInfo: { explanation: 'x' }, toolLog: swept })]).toEqual([name, ['Wrong answer']]);
                expect([name, usedMethod(c, [call('run_sensitivity', { parameters: c.parameters.map((p) => ({ name: p })) })]), usedMethod(c, [])]).toEqual([name, true, false]);
            } else {
                const cal = calibrationCases[c.calibrationCase];
                expect([name, await types(name, 'result', { model: { ...structuredClone(cal.truth), specs: givenModel(cal).specs } })]).toEqual([name, []]);
                expect([name, (await types(name, 'result', { model: givenModel(cal) })).includes('Wrong answer')]).toEqual([name, true]);
            }
        }
    });

    simTest('generated cases: each scenario answer is what the model gives, and each sensitivity answer clearly leads', async () => {
        const { generatedCases } = await import('../../../evals/categories/policyAnalysisMethods.js');
        const { measureOf, SENSITIVITY_MARGIN, MIN_SCENARIO_CHANGE, MIN_TRUTH_SHARE } = await import('../../../evals/categories/policyAnalysisMethodsData/generate.js');
        for (const [name, c] of Object.entries(generatedCases)) {
            const s = scenarios[c.scenario];
            if (c.kind === 'scenario') {
                const base = await measureOf(s, null);
                expect([name, await measureOf(s, { [c.overrideNames[0]]: String(c.overrideValue) })]).toEqual([name, c.truth]);
                expect([name, Math.abs(c.truth - base) >= MIN_SCENARIO_CHANGE * Math.abs(base), Math.abs(c.truth) >= MIN_TRUTH_SHARE * Math.abs(base)]).toEqual([name, true, true]);
            } else if (c.kind === 'sensitivity') {
                const base = await measureOf(s, null);
                const swing = async (p) => Math.max(...(await Promise.all([0.8, 1.2].map((f) => measureOf(s, { [p]: String(c.baseValues[p] * f) })))).map((x) => Math.abs(x - base)));
                const other = c.options.find((o) => o !== c.answer);
                expect([name, (await swing(c.answer)) >= SENSITIVITY_MARGIN * (await swing(other))]).toEqual([name, true]);
            }
        }
    });

    test('no prompt names the method', () => {
        // Quoted variable names ("fertility sensitivity") are the model's words, not a method named.
        for (const t of groupTests(groups, 'policyAnalysisMethods')) expect(t.prompt.replace(/"[^"]*"/g, '""')).not.toMatch(/optimi[sz]|sensitivity|calibrat|scenario/i);
    });

    describe('hard group', () => {
        const hardTests = () => groupTests(groups, 'policyAnalysisMethodsHard');
        const hardTest = (name, criterion) => hardTests().find((t) => t.expectations.caseName === name && t.expectations.criterion === criterion);
        const hardTypes = async (name, criterion, response) => (await evaluate(response, hardTest(name, criterion).expectations)).map((f) => f.type);

        simTest('the hard cases are the rule applied to every scenario, re-derived by simulation, from dev and held-out scenarios alike', async () => {
            const { generateHardCase, generateUnreachableCase } = await import('../../../evals/categories/policyAnalysisMethodsData/generate.js');
            const { hardCases } = await import('../../../evals/categories/policyAnalysisMethods.js');
            const expected = {};
            for (const s of Object.values(scenarios)) {
                const c = await generateHardCase(s);
                if (c) expected[c.name] = c;
                const u = await generateUnreachableCase(s, c?.lever ?? null);
                if (u) expected[u.name] = u;
            }
            expect(Object.fromEntries(Object.entries(hardCases).map(([n, { model, ...g }]) => [n, g]))).toEqual(expected);
            const ids = Object.values(expected).map((c) => c.scenario);
            expect(ids.some((id) => scenarios[id].split === 'heldout')).toBe(true);
            expect(ids.some((id) => scenarios[id].split !== 'heldout')).toBe(true);
            expect(Object.keys(expected).length).toBeGreaterThanOrEqual(4);
        });

        simTest('every hard case: the goal is missed now, met at the limit, and flips at the crossing', async () => {
            const { hardCases } = await import('../../../evals/categories/policyAnalysisMethods.js');
            const { measureOf } = await import('../../../evals/categories/policyAnalysisMethodsData/generate.js');
            for (const [name, c] of Object.entries(hardCases).filter(([, x]) => x.reachable)) {
                const s = scenarios[c.scenario];
                const meets = (x) => (s.goal.direction === 'below' ? x < s.goal.threshold : x > s.goal.threshold);
                const step = 0.02 * (c.limit - c.current);
                expect([name, meets(await measureOf(s, null)), meets(await measureOf(s, { [c.lever]: String(c.limit) }))]).toEqual([name, false, true]);
                expect([name, meets(await measureOf(s, { [c.lever]: String(c.crossing - step) })), meets(await measureOf(s, { [c.lever]: String(c.crossing + step) }))]).toEqual([name, false, true]);
            }
        });

        simTest('every out-of-reach case: the goal is missed now and all the way to the limit, though the lever helps; answers balance both ways in dev and held out', async () => {
            const { hardCases } = await import('../../../evals/categories/policyAnalysisMethods.js');
            const { measureOf, REACH_MOVE } = await import('../../../evals/categories/policyAnalysisMethodsData/generate.js');
            for (const [name, c] of Object.entries(hardCases).filter(([, x]) => x.reachable === false)) {
                const s = scenarios[c.scenario];
                const meets = (x) => (s.goal.direction === 'below' ? x < s.goal.threshold : x > s.goal.threshold);
                const base = await measureOf(s, null);
                expect([name, meets(base)]).toEqual([name, false]);
                for (let k = 0; k <= 20; k++) expect([name, k, meets(await measureOf(s, { [c.lever]: String(c.current + ((c.limit - c.current) * k) / 20) }))]).toEqual([name, k, false]);
                const atLimit = await measureOf(s, { [c.lever]: String(c.limit) });
                expect([name, atLimit]).toEqual([name, c.truth]);
                expect([name, (s.goal.direction === 'below' ? base - atLimit : atLimit - base) / Math.abs(base - s.goal.threshold) >= REACH_MOVE]).toEqual([name, true]);
                // The prompt is the reachable cases' prompt, word for word, but for the lever.
                expect(c.prompt).toMatch(/Could we meet the goal by taking it no further than that/);
            }
            for (const held of [true, false]) {
                const set = Object.values(hardCases).filter((c) => (scenarios[c.scenario].split === 'heldout') === held);
                expect([held, set.some((c) => c.reachable), set.some((c) => !c.reachable)]).toEqual([held, true, true]);
            }
        });

        simTest('every hard case: the measure read off the run_scenario grid is the stored one, and an answer giving it passes', async () => {
            const { hardCases, REACH } = await import('../../../evals/categories/policyAnalysisMethods.js');
            const { sampledMeasureOf } = await import('../../../evals/categories/policyAnalysisMethodsData/generate.js');
            const { runAnalysisTool } = await import('../../../evals/utilities/analysisTools.js');
            const { goalMeasure } = await import('../../../evals/categories/policyAnalysisMethodsData/generate.js');
            for (const [name, c] of Object.entries(hardCases)) {
                const s = scenarios[c.scenario];
                expect([name, await sampledMeasureOf(s, { [c.lever]: String(c.limit) })]).toEqual([name, c.sampledTruth]);
                // The grid is the one the run_scenario tool hands the agent, on the model the test gives it.
                const m = goalMeasure(s);
                const out = await runAnalysisTool('run_scenario', { overrides: { [c.lever]: c.limit }, outputs: [m.output] }, hardTest(name, 'result').currentModel, null);
                expect([name, m.fn(out.outputs[m.output])]).toEqual([name, c.sampledTruth]);
                const text = { supportingInfo: { explanation: 'x' }, toolLog: [] };
                reply = c.reachable ? { reach: REACH.yes, needed_value: c.crossing, at_limit: c.sampledTruth } : { reach: REACH.no, needed_value: null, at_limit: c.sampledTruth };
                expect([name, await hardTypes(name, 'result', text)]).toEqual([name, []]);
            }
        });

        test('no hard prompt names the method', () => {
            for (const t of hardTests()) expect(t.prompt.replace(/"[^"]*"/g, '""')).not.toMatch(/optimi[sz]|sensitivity|calibrat|scenario|search|sweep/i);
        });

        simTest('every hard case: the reference answer passes; nothing, constants, the status quo or one number alone fail', async () => {
            const { hardCases } = await import('../../../evals/categories/policyAnalysisMethods.js');
            const { measureOf } = await import('../../../evals/categories/policyAnalysisMethodsData/generate.js');
            const { REACH } = await import('../../../evals/categories/policyAnalysisMethods.js');
            for (const [name, c] of Object.entries(hardCases).filter(([, x]) => x.reachable)) {
                const tries = [0, 0.25, 0.5, 0.75, 1].map((f) => call('run_scenario', { overrides: { [c.lever]: String(c.current + (c.limit - c.current) * f) } }));
                const text = { supportingInfo: { explanation: 'x' }, toolLog: tries };
                expect([name, await hardTypes(name, 'method', text)]).toEqual([name, []]);
                expect([name, await hardTypes(name, 'method', { toolLog: [] })]).toEqual([name, ['Wrong method']]);
                // One run at the limit is not a search for a goal within reach.
                expect([name, await hardTypes(name, 'method', { toolLog: [tries[4]] })]).toEqual([name, ['Wrong method']]);
                // The right numbers with "it cannot be done", or no verdict, fail.
                for (const reach of [REACH.no, REACH.unsaid]) {
                    reply = { reach, needed_value: c.crossing, at_limit: c.truth };
                    expect([name, reach, await hardTypes(name, 'result', text)]).toEqual([name, reach, ['Wrong answer']]);
                }
                reply = { reach: REACH.yes, needed_value: c.crossing, at_limit: c.truth };
                expect([name, await hardTypes(name, 'result', text)]).toEqual([name, []]);
                expect([name, await hardTypes(name, 'result', {})]).toEqual([name, ['No answer given']]);
                const base = await measureOf(scenarios[c.scenario], null);
                for (const wrong of [{ needed_value: 1, at_limit: 1 }, { needed_value: 0, at_limit: 0 }, { needed_value: null, at_limit: null }, { needed_value: c.current, at_limit: base }, { needed_value: c.limit, at_limit: c.truth }]) {
                    for (const reach of Object.values(REACH)) {
                        reply = { reach, ...wrong };
                        expect([name, wrong, reach, (await hardTypes(name, 'result', text)).length > 0]).toEqual([name, wrong, reach, true]);
                    }
                }
                reply = { reach: REACH.yes, needed_value: c.crossing, at_limit: c.truth * 1.1 };
                expect([name, await hardTypes(name, 'result', text)]).toEqual([name, ['Wrong answer']]);
            }
        });

        simTest('every out-of-reach case: the reference answer passes; a value, no verdict, constants or the status quo fail; one run at the limit is the method', async () => {
            const { hardCases, REACH } = await import('../../../evals/categories/policyAnalysisMethods.js');
            const { measureOf } = await import('../../../evals/categories/policyAnalysisMethodsData/generate.js');
            for (const [name, c] of Object.entries(hardCases).filter(([, x]) => x.reachable === false)) {
                const atLimit = { supportingInfo: { explanation: 'x' }, toolLog: [call('run_scenario', { overrides: { [c.lever]: c.limit } })] };
                expect([name, await hardTypes(name, 'method', atLimit)]).toEqual([name, []]);
                expect([name, await hardTypes(name, 'method', { toolLog: [call('run_scenario', { overrides: { [c.lever]: c.current } })] })]).toEqual([name, ['Wrong method']]);
                expect([name, await hardTypes(name, 'method', { toolLog: [] })]).toEqual([name, ['Wrong method']]);
                reply = { reach: REACH.no, needed_value: null, at_limit: c.truth };
                expect([name, await hardTypes(name, 'result', atLimit)]).toEqual([name, []]);
                expect([name, await hardTypes(name, 'result', {})]).toEqual([name, ['No answer given']]);
                const base = await measureOf(scenarios[c.scenario], null);
                for (const wrong of [{ reach: REACH.yes, needed_value: c.limit, at_limit: c.truth }, { reach: REACH.unsaid, needed_value: null, at_limit: c.truth }, { reach: REACH.no, needed_value: null, at_limit: base }, { reach: REACH.no, needed_value: null, at_limit: 0 }, { reach: REACH.no, needed_value: null, at_limit: 1 }, { reach: REACH.no, needed_value: null, at_limit: null }, { reach: REACH.yes, needed_value: 1, at_limit: 1 }]) {
                    reply = wrong;
                    expect([name, wrong, await hardTypes(name, 'result', atLimit)]).toEqual([name, wrong, expect.arrayContaining(['Wrong answer'])]);
                }
            }
        });
    });

    describe('second hard group (how far, and how far to be sure)', () => {
        const hard2 = () => groupTests(groups, 'policyAnalysisMethodsHard2');
        const hard2Types = async (name, response) => (await evaluate(response, hard2().find((t) => t.expectations.caseName === name).expectations)).map((f) => f.type);

        simTest('robustGenerated.json is the rule applied to every held-out scenario, re-derived by simulation', async () => {
            const { generateRobustCase } = await import('../../../evals/categories/policyAnalysisMethodsData/generate.js');
            const { robustCases, robustSkipped } = await import('../../../evals/categories/policyAnalysisMethods.js');
            const expected = {};
            const skipped = [];
            for (const [id, s] of Object.entries(scenarios)) {
                if (s.split !== 'heldout') continue;
                const c = await generateRobustCase(s);
                if (c) expected[c.name] = c; else skipped.push(id);
            }
            expect(Object.fromEntries(Object.entries(robustCases).map(([n, { model, ...g }]) => [n, g]))).toEqual(expected);
            expect(robustSkipped).toEqual(skipped);
        });

        test('it is held out only, at least three scenarios, and no prompt names the method or which way the uncertainty hurts', async () => {
            const { robustCases } = await import('../../../evals/categories/policyAnalysisMethods.js');
            expect(groups.policyAnalysisMethodsHard2).toBeUndefined();
            expect(hard2().length).toBe(Object.keys(robustCases).length);
            expect(hard2().length).toBeGreaterThanOrEqual(3);
            for (const t of hard2()) {
                expect([t.name, t.heldOut]).toEqual([t.name, true]);
                expect(t.prompt.replace(/"[^"]*"/g, '""')).not.toMatch(/optimi[sz]|sensitivity|calibrat|scenario|search|sweep|higher|lower|worse|better/i);
            }
        });

        simTest('every case: the goal flips at both stored crossings, with the uncertain quantity as it is and at its adverse end', async () => {
            const { robustCases } = await import('../../../evals/categories/policyAnalysisMethods.js');
            const { measureOf } = await import('../../../evals/categories/policyAnalysisMethodsData/generate.js');
            for (const [name, c] of Object.entries(robustCases)) {
                const s = scenarios[c.scenario];
                const meets = (x) => (s.goal.direction === 'below' ? x < s.goal.threshold : x > s.goal.threshold);
                const step = 0.02 * (c.limit - c.current);
                const adverse = { [c.uncertain]: String(c.uncertainValue * c.adverseFactor) };
                expect([name, meets(await measureOf(s, { [c.lever]: String(c.crossing - step) })), meets(await measureOf(s, { [c.lever]: String(c.crossing + step) }))]).toEqual([name, false, true]);
                expect([name, meets(await measureOf(s, { ...adverse, [c.lever]: String(c.robustCrossing - step) })), meets(await measureOf(s, { ...adverse, [c.lever]: String(c.robustCrossing + step) }))]).toEqual([name, false, true]);
                // The first answer is not sure: with the quantity at its adverse end, it misses the goal.
                expect([name, meets(await measureOf(s, { ...adverse, [c.lever]: String(c.crossing) }))]).toEqual([name, false]);
            }
        });

        test('every case: the reference answer passes; nothing, constants, the first answer twice, the other end of the range or the limit fail', async () => {
            const { robustCases } = await import('../../../evals/categories/policyAnalysisMethods.js');
            const text = { supportingInfo: { explanation: 'x' }, toolLog: [] };
            for (const [name, c] of Object.entries(robustCases)) {
                reply = { needed_value: c.crossing, sure_value: c.robustCrossing };
                expect([name, await hard2Types(name, text)]).toEqual([name, []]);
                expect([name, await hard2Types(name, {})]).toEqual([name, ['No answer given']]);
                for (const wrong of [{ needed_value: null, sure_value: null }, { needed_value: 0, sure_value: 0 }, { needed_value: 1, sure_value: 1 }, { needed_value: c.current, sure_value: c.current }, { needed_value: c.crossing, sure_value: c.crossing }, { needed_value: c.crossing, sure_value: c.otherCrossing }, { needed_value: c.crossing, sure_value: c.limit }, { needed_value: c.limit, sure_value: c.limit }, { needed_value: c.robustCrossing, sure_value: c.robustCrossing }]) {
                    reply = wrong;
                    expect([name, wrong, (await hard2Types(name, text)).length > 0]).toEqual([name, wrong, true]);
                }
                reply = { needed_value: c.crossing, sure_value: c.crossing };
                expect([name, await hard2Types(name, text)]).toEqual([name, ['Uncertainty not allowed for']]);
            }
        });

        test('its failure type is documented', () => {
            expect(methodology().criteria.map((c) => c.name)).toContain('Uncertainty not allowed for');
        });
    });

    test('every failure type is documented', () => {
        expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['Wrong method', 'Wrong answer', 'No answer given', 'Evaluation error']));
    });

    test('method: the fitting analysis passes, others fail', () => {
        expect(usedMethod(cases['Dialysis cost optimum'], [call('run_optimization', { lever: { name: 'target wait', min: 0.25, max: 6 } })])).toBe(true);
        expect(usedMethod(cases['Dialysis cost optimum'], [0.5, 1, 1.5, 2].map((v) => call('run_scenario', { overrides: { 'target wait': v } })))).toBe(true);
        expect(usedMethod(cases['Dialysis cost optimum'], [call('run_scenario', { overrides: { 'target wait': 1 } })])).toBe(false);
        expect(usedMethod(cases['Bike share drivers'], [call('run_sensitivity', { parameters: [{ name: 'persuasion', values: [0.02, 0.03] }, { name: 'advertising effect', values: [0.0004, 0.0006] }] })])).toBe(true);
        expect(usedMethod(cases['Bike share drivers'], [call('run_sensitivity', { parameters: [{ name: 'persuasion', values: [0.02, 0.03] }] })])).toBe(false);
        expect(usedMethod(cases['Distributor history'], [call('run_calibration', { parameters: [] })])).toBe(true);
        expect(usedMethod(cases['Distributor history'], [call('run_scenario', { overrides: {} })])).toBe(false);
        expect(usedMethod(cases['Dialysis referral jump'], [call('run_scenario', { overrides: { 'base referrals': 45 } })])).toBe(true);
        expect(usedMethod(cases['Dialysis referral jump'], [call('run_scenario', { overrides: { 'base referrals': 40 } })])).toBe(false);
        expect(usedMethod(cases['Dialysis referral jump'], [call('run_scenario', { overrides: { 'referrals': 45 } })])).toBe(true);
        expect(usedMethod(cases['Bike share drivers'], [call('run_scenario', { overrides: { persuasion: 0.03 } }), call('run_scenario', { overrides: { 'advertising effect': 0.0006 } })])).toBe(true);
        expect(usedMethod(cases['Bike share drivers'], [call('run_scenario', { overrides: { persuasion: 0.0251 } }), call('run_scenario', { overrides: { 'advertising effect': 0.0006 } })])).toBe(false);
    });

    simTest('result: the optimum passes, the current setting fails', async () => {
        const best = await bestCost();
        const m = costModel();
        findVariable(m.variables, 'target wait').equation = String(best.targetWait);
        expect(await types('Dialysis cost optimum', 'result', { model: m })).toEqual([]);
        expect(await types('Dialysis cost optimum', 'result', { model: costModel() })).toEqual(['Wrong answer']);
    });

    test('result: the right parameter passes, the other fails, and an answer with no analysis behind it fails', async () => {
        const swept = [call('run_sensitivity', { parameters: [{ name: 'persuasion', values: [0.02, 0.03] }, { name: 'advertising effect', values: [0.0004, 0.0006] }] })];
        reply = { matters_more: 'persuasion' };
        expect(await types('Bike share drivers', 'result', { supportingInfo: { explanation: 'x' }, toolLog: swept })).toEqual([]);
        expect(await types('Bike share drivers', 'result', { supportingInfo: { explanation: 'x' } })).toEqual(['Wrong method']);
        reply = { matters_more: 'advertising effect' };
        expect(await types('Bike share drivers', 'result', { supportingInfo: { explanation: 'x' }, toolLog: swept })).toEqual(['Wrong answer']);
    });

    simTest('result: the true model fits the history, the given one does not', async () => {
        const cal = calibrationCases['Distributor, parameters'];
        expect(await types('Distributor history', 'result', { model: structuredClone(cal.truth) })).toEqual([]);
        expect(await types('Distributor history', 'result', { model: givenModel(cal) })).toEqual(['Wrong answer']);
        const forced = structuredClone(cal.truth);
        forced.variables.push({ name: 'correction', type: 'variable', equation: '0', units: 'cases' });
        expect(await types('Distributor history', 'result', { model: forced })).toEqual(['Wrong answer']);
    });

    simTest('result: a peak within 10% passes, one further off or none fails', async () => {
        const truth = await truePeak();
        reply = { peak: truth * 1.05 };
        expect(await types('Dialysis referral jump', 'result', { supportingInfo: { explanation: 'x' } })).toEqual([]);
        reply = { peak: truth * 1.2 };
        expect(await types('Dialysis referral jump', 'result', { supportingInfo: { explanation: 'x' } })).toEqual(['Wrong answer']);
        reply = { peak: null };
        expect(await types('Dialysis referral jump', 'result', { supportingInfo: { explanation: 'x' } })).toEqual(['Wrong answer']);
    });
});
