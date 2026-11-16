import { groupTests } from '../../../evals/utilities/heldOut.js';
import { jest } from '@jest/globals';

let reply = {};
jest.unstable_mockModule('../../../evals/utilities/judge.js', () => ({
    extract: async (key) => (key.includes('|diagnosis|') ? { diagnosis: reply.diagnosis ?? 'unclear' } : { missing: reply.missing ?? 'none of these' }),
    clearJudgeCache: () => {}
}));

const { evaluate, groups, methodology, rSquared, dataOf, mechanismList, FIT_R_SQUARED, FIT_R_SQUARED_HARD } = await import('../../../evals/categories/calibration.js');
const { cases, handCases, generatedCases, dataFor, givenModel, specsFor } = await import('../../../evals/categories/calibrationData/cases.js');
const { applyChanges, calibratedFit, MISFIT } = await import('../../../evals/categories/calibrationData/generate.js');
const { runAnalysisTool } = await import('../../../evals/utilities/analysisTools.js');
const { findVariable } = await import('../../../evals/utilities/modelDiff.js');

const testsFor = (name) => groupTests(groups, 'calibration').filter((t) => t.expectations.caseName === name);
const SAYS = { parameters: 'the parameter values were off', structure: 'the structure is missing something' };

/** The parameters a modeler would calibrate in each scenario. */
const RELEVANT = { bikeShare: ['persuasion', 'advertising effect', 'contact rate'], dialysisClinic: ['base referrals', 'patients per chair', 'build delay', 'target wait'], distributor: ['adjustment time', 'delivery delay', 'coverage', 'expectation time'] };

describe('calibration category', () => {
    jest.setTimeout(1800000);

    test('the frozen data are what the truths produce', async () => {
        for (const [name, c] of Object.entries(cases)) expect([name, await dataFor(c)]).toEqual([name, dataOf(name)]);
    });

    test.each(Object.keys(cases))('%s: the truth fits its data, the given model does not, and calibration behaves as the case says', async (name) => {
        const c = cases[name];
        const data = dataOf(name);
        expect(await rSquared(c.truth, c, data)).toBeGreaterThan(0.98);
        expect(await rSquared(givenModel(c), c, data)).toBeLessThan(0.9);
        const m = givenModel(c);
        const parameters = (RELEVANT[c.scenario] ?? c.calibrated).map((n) => { const v = Number(findVariable(m.variables, n).equation); return { name: n, min: v / 5, max: v * 5 }; });
        const fit = await runAnalysisTool('run_calibration', { parameters, variable: c.series, series: c.series }, m, { series: { [c.series]: data } });
        if (c.kind === 'parameters') expect(fit.rSquared).toBeGreaterThan(FIT_R_SQUARED);
        else expect(fit.rSquared).toBeLessThan(0.9);
    });

    test('every structure case lists its real mechanism among distractors, its place spread evenly over the cases', () => {
        const places = Object.keys(cases).filter((n) => cases[n].kind === 'structure').map((n) => mechanismList(n).indexOf(cases[n].mechanism));
        const counts = [0, 1, 2].map((k) => places.filter((x) => x === k).length);
        expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
        for (const n of Object.keys(cases).filter((x) => cases[x].kind === 'structure')) expect(mechanismList(n)).toHaveLength(3);
    });

    test.each(Object.keys(generatedCases).filter((n) => generatedCases[n].kind === 'structure'))('%s: the data rule out each distractor mechanism, even with its strength calibrated', async (name) => {
        const c = generatedCases[name];
        const data = dataOf(name);
        expect(c.distractorModels.map((d) => d.mechanism)).toEqual(c.distractors);
        for (const d of c.distractorModels) {
            const m = applyChanges(givenModel(c), d.changes);
            expect([d.mechanism, (await calibratedFit(m, c.series, data, [...c.calibrated, d.strength], [d.strength])) < MISFIT]).toEqual([d.mechanism, true]);
        }
    });

    test('generated cases come only from scenarios with no hand-written ones, and each names its calibrated parameters', () => {
        const covered = new Set(Object.values(handCases).map((c) => c.scenario));
        for (const c of Object.values(generatedCases)) {
            expect([c.name, covered.has(c.scenario)]).toEqual([c.name, false]);
            expect(c.calibrated.length).toBeGreaterThanOrEqual(2);
            if (c.kind === 'parameters') expect(c.calibrated).toEqual(expect.arrayContaining(c.parameters));
        }
    });

    test('fitting a parameters case by changing structure fails, even when it fits', async () => {
        const name = 'Bike share, parameters';
        const c = cases[name];
        reply = { diagnosis: SAYS.parameters };
        const forced = { ...structuredClone(c.truth), specs: specsFor(c) };
        forced.variables.push({ name: 'fudge', type: 'variable', equation: '0', units: 'people/month' });
        findVariable(forced.variables, 'signing up').equation = '(potential_members * advertising_effect + word_of_mouth) + fudge';
        const t = testsFor(name).find((x) => x.expectations.criterion === 'fit');
        expect((await evaluate({ model: forced, supportingInfo: { explanation: 'x' } }, t.expectations)).map((f) => f.type)).toEqual(['Structure changed']);
    });

    test('a parameter written as arithmetic is still calibration', async () => {
        const name = 'Bike share, parameters';
        const c = cases[name];
        reply = { diagnosis: SAYS.parameters };
        const m = { ...structuredClone(c.truth), specs: specsFor(c) };
        findVariable(m.variables, 'persuasion').equation = '0.016 * 2';
        const t = testsFor(name).find((x) => x.expectations.criterion === 'fit');
        expect(await evaluate({ model: m, supportingInfo: { explanation: 'x' } }, t.expectations)).toEqual([]);
    });

    test('a parameter rewritten to change over time is structure, not calibration', async () => {
        const name = 'Bike share, parameters';
        const c = cases[name];
        reply = { diagnosis: SAYS.parameters };
        const t = testsFor(name).find((x) => x.expectations.criterion === 'fit');
        for (const eq of ['0.025 + 0.0001 * TIME', 'STEP(0.01, 12) + 0.025', '0.03 * (1 + 0.2 * SIN(TIME))']) {
            const m = { ...structuredClone(c.truth), specs: specsFor(c) };
            findVariable(m.variables, 'persuasion').equation = eq;
            expect([eq, (await evaluate({ model: m, supportingInfo: { explanation: 'x' } }, t.expectations)).map((f) => f.type)]).toEqual([eq, expect.arrayContaining(['Structure changed'])]);
        }
    });

    test('every failure type is documented', () => {
        expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['Wrong diagnosis', 'Poor fit', 'Structure changed', 'Missing mechanism not named', 'No model produced', 'No answer given', 'Evaluation error']));
    });

    describe('hard group', () => {
        const hardTests = () => groupTests(groups, 'calibrationHard');
        const hardOf = (name) => hardTests().find((t) => t.expectations.caseName === name);
        const verdict = async (name, response) => (await evaluate(response, hardOf(name).expectations)).map((f) => f.type);

        test('the hard cases are both cases of every scenario with both kinds: answers split evenly, dev and held-out alike', () => {
            const names = hardTests().map((t) => t.expectations.caseName);
            const scenarioIds = new Set(names.map((n) => cases[n].scenario));
            for (const id of scenarioIds) expect([id, names.filter((n) => cases[n].scenario === id).map((n) => cases[n].kind).sort()]).toEqual([id, ['parameters', 'structure']]);
            for (const [id] of Object.entries(Object.fromEntries(Object.values(cases).map((c) => [c.scenario, true])))) {
                const kinds = new Set(Object.values(cases).filter((c) => c.scenario === id).map((c) => c.kind));
                expect([id, scenarioIds.has(id)]).toEqual([id, kinds.size === 2]);
            }
            const held = hardTests().map((t) => t.heldOut);
            expect(held).toContain(true);
            expect(held).toContain(false);
        });

        test('no hard prompt names the method or the kind of problem', () => {
            for (const t of hardTests()) expect(t.prompt.replace(/"[^"]*"/g, '""')).not.toMatch(/calibrat|parameter|structur|missing|mechanism|\bfit(s|ted)?\b/i);
        });

        test.each(groupTests(groups, 'calibrationHard').map((t) => t.expectations.caseName))('%s: the reference answer passes; nothing, a constant answer or the other diagnosis fails', async (name) => {
            const c = cases[name];
            const fixed = c.kind === 'parameters' ? { ...structuredClone(c.truth), specs: specsFor(c) } : givenModel(c);
            reply = { diagnosis: SAYS[c.kind], missing: c.mechanism };
            expect(await verdict(name, { model: fixed, supportingInfo: { explanation: 'x' } })).toEqual([]);
            expect((await verdict(name, { model: { variables: [], relationships: [] } })).length).toBeGreaterThan(0);
            // Constant answers: "the parameters were off" with the model handed back fails every case;
            // "the structure is missing something" fails every parameters case, which is half the group.
            reply = { diagnosis: SAYS.parameters, missing: c.kind === 'structure' ? mechanismList(name)[0] : 'none of these' };
            expect((await verdict(name, { model: givenModel(c), supportingInfo: { explanation: 'x' } })).length).toBeGreaterThan(0);
            if (c.kind === 'parameters') {
                reply = { diagnosis: SAYS.structure, missing: 'none of these' };
                expect(await verdict(name, { model: givenModel(c), supportingInfo: { explanation: 'x' } })).toEqual(expect.arrayContaining(['Wrong diagnosis', 'Poor fit']));
            }
            reply = { diagnosis: SAYS[c.kind === 'parameters' ? 'structure' : 'parameters'], missing: c.mechanism };
            expect(await verdict(name, { model: fixed, supportingInfo: { explanation: 'x' } })).toContain('Wrong diagnosis');
        });

        test.each(groupTests(groups, 'calibrationHard').map((t) => t.expectations.caseName).filter((n) => cases[n].kind === 'parameters'))('%s: the tighter fit is within reach — calibrating the given model reaches it, and the truth clears it', async (name) => {
            const c = cases[name];
            const data = dataOf(name);
            expect(await rSquared(c.truth, c, data)).toBeGreaterThan(FIT_R_SQUARED_HARD);
            const m = givenModel(c);
            const parameters = (RELEVANT[c.scenario] ?? c.calibrated).map((n) => { const v = Number(findVariable(m.variables, n).equation); return { name: n, min: v / 5, max: v * 5 }; });
            const fit = await runAnalysisTool('run_calibration', { parameters, variable: c.series, series: c.series }, m, { series: { [c.series]: data } });
            expect(fit.rSquared).toBeGreaterThan(FIT_R_SQUARED_HARD);
        });

        test('a fit good enough for the dev test but short of the tighter one fails the hard test', async () => {
            const name = 'Bike share, parameters';
            const c = cases[name];
            reply = { diagnosis: SAYS.parameters };
            let found = null;
            for (const f of [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9]) {
                const m = { ...structuredClone(c.truth), specs: specsFor(c) };
                findVariable(m.variables, 'persuasion').equation = String(0.025 + (0.032 - 0.025) * f);
                const r2 = await rSquared(m, c, dataOf(name));
                if (r2 >= FIT_R_SQUARED && r2 < FIT_R_SQUARED_HARD) { found = m; break; }
            }
            expect(found).not.toBeNull();
            const fitTest = testsFor(name).find((t) => t.expectations.criterion === 'fit');
            expect(await evaluate({ model: found, supportingInfo: { explanation: 'x' } }, fitTest.expectations)).toEqual([]);
            expect(await verdict(name, { model: found, supportingInfo: { explanation: 'x' } })).toEqual(['Poor fit']);
        });
    });

    describe('second hard group (a mechanism of the scenario removed)', () => {
        const hard2 = () => groupTests(groups, 'calibrationHard2');
        const hard2Of = (name) => hard2().find((t) => t.expectations.caseName === name);
        const verdict2 = async (name, response) => (await evaluate(response, hard2Of(name).expectations)).map((f) => f.type);

        test('hard2.json is the rule applied to every held-out scenario, re-derived by simulation', async () => {
            const { hard2Cases, hard2Skipped } = await import('../../../evals/categories/calibration.js');
            const { removedMechanismCase } = await import('../../../evals/categories/calibrationData/removedMechanism.js');
            const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
            const heldOut = Object.keys(scenarios).filter((id) => scenarios[id].split === 'heldout');
            const covered = new Set(Object.values(hard2Cases).map((c) => c.scenario));
            expect([...covered, ...Object.keys(hard2Skipped)].sort()).toEqual([...heldOut].sort());
            for (const id of heldOut) {
                const derived = await removedMechanismCase(scenarios[id]);
                if (derived.skip) expect([id, hard2Skipped[id]]).toEqual([id, derived.skip]);
                else expect([id, (({ given, ...c }) => c)(hard2Cases[derived.name])]).toEqual([id, derived]);
            }
        });

        test('it is held out only: every structure case paired with its scenario\'s parameters case, at least three scenarios', async () => {
            const { hard2Cases, hard2Pairs } = await import('../../../evals/categories/calibration.js');
            expect(groups.calibrationHard2).toBeUndefined();
            expect(hard2Pairs().length).toBe(Object.keys(hard2Cases).length);
            expect(hard2Pairs().length).toBeGreaterThanOrEqual(3);
            for (const [p, st] of hard2Pairs()) {
                expect([p, cases[p].kind, cases[p].scenario]).toEqual([p, 'parameters', hard2Cases[st].scenario]);
                expect([hard2Of(p).heldOut, hard2Of(st).heldOut]).toEqual([true, true]);
            }
            for (const t of hard2()) expect(t.prompt.replace(/"[^"]*"/g, '""')).not.toMatch(/calibrat|parameter|structur|missing|mechanism|\bfit(s|ted)?\b/i);
        });

        test('balance: each closed field\'s right option is the right one in at most half the tests that read it', async () => {
            const { hard2Cases, hard2MechanismList } = await import('../../../evals/categories/calibration.js');
            const names = hard2().map((t) => t.expectations.caseName);
            const kinds = names.map((n) => (cases[n] ? 'parameters' : 'structure'));
            for (const k of ['parameters', 'structure']) expect([k, kinds.filter((x) => x === k).length <= names.length / 2]).toEqual([k, true]);
            const structureNames = names.filter((n) => !cases[n]);
            const places = structureNames.map((n) => hard2MechanismList(n).indexOf(hard2Cases[n].mechanism));
            for (const p of [0, 1, 2]) expect([p, places.filter((x) => x === p).length <= structureNames.length / 2]).toEqual([p, true]);
        });

        test('every structure case: the given model lacks the mechanism and everything only it fed, and its data come from the full model', async () => {
            const { hard2Cases } = await import('../../../evals/categories/calibration.js');
            const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
            const { sampledData, baseModel, plainFit } = await import('../../../evals/categories/calibrationData/generate.js');
            for (const [name, c] of Object.entries(hard2Cases)) {
                const s = scenarios[c.scenario];
                const given = c.given();
                expect([name, given.variables.length]).toEqual([name, s.model.variables.length - c.dropped.length]);
                expect([name, await sampledData(baseModel(s), c.series)]).toEqual([name, c.data]);
                expect([name, (await plainFit(given, c.series, c.data)) < MISFIT]).toEqual([name, true]);
                // Every given variable still exists in the full model, and no stock is left with a flow it no longer has.
                const names = new Set(given.variables.map((v) => v.name));
                for (const v of given.variables) for (const f of [...(v.inflows || []), ...(v.outflows || [])]) expect([name, v.name, f, names.has(f)]).toEqual([name, v.name, f, true]);
            }
        });

        test.each(groupTests(groups, 'calibrationHard2').map((t) => t.expectations.caseName))('%s: the reference answer passes; nothing, a constant diagnosis, the other diagnosis or a generic mechanism fails', async (name) => {
            const { hard2Cases, hard2MechanismList } = await import('../../../evals/categories/calibration.js');
            const structure = !cases[name];
            const c = structure ? hard2Cases[name] : cases[name];
            const fixed = structure ? c.given() : { ...structuredClone(c.truth), specs: specsFor(c) };
            const given = structure ? c.given() : givenModel(c);
            reply = { diagnosis: SAYS[c.kind], missing: c.mechanism };
            expect(await verdict2(name, { model: fixed, supportingInfo: { explanation: 'x' } })).toEqual([]);
            reply = {};
            expect((await verdict2(name, { model: { variables: [], relationships: [] }, supportingInfo: { explanation: '' } })).length).toBeGreaterThan(0);
            for (const d of Object.values(SAYS)) {
                reply = { diagnosis: d, missing: structure ? hard2MechanismList(name)[0] : 'none of these' };
                if (structure && d === SAYS.structure && hard2MechanismList(name)[0] === c.mechanism) continue;
                expect([d, (await verdict2(name, { model: given, supportingInfo: { explanation: 'x' } })).length > 0]).toEqual([d, true]);
            }
            reply = { diagnosis: SAYS[c.kind === 'parameters' ? 'structure' : 'parameters'], missing: c.mechanism };
            expect(await verdict2(name, { model: fixed, supportingInfo: { explanation: 'x' } })).toContain('Wrong diagnosis');
            if (structure) {
                // The first hard group's level of answer: a generic pattern in the data named as what is missing.
                for (const d of c.distractors) {
                    reply = { diagnosis: SAYS.structure, missing: d };
                    expect(await verdict2(name, { model: given, supportingInfo: { explanation: 'x' } })).toEqual(['Missing mechanism not named']);
                }
                expect(hard2MechanismList(name)).toHaveLength(3);
                expect(hard2MechanismList(name)).toContain(c.mechanism);
            }
        });
    });

    describe.each(Object.keys(cases))('%s', (name) => {
        const c = cases[name];
        const run = async (response) => {
            const out = {};
            for (const t of testsFor(name)) out[t.expectations.criterion] = (await evaluate(response, t.expectations)).map((f) => f.type);
            return out;
        };

        test('the right answer passes', async () => {
            reply = { diagnosis: SAYS[c.kind], missing: c.mechanism };
            const model = c.kind === 'parameters' ? { ...structuredClone(c.truth), specs: specsFor(c) } : givenModel(c);
            const results = await run({ model, supportingInfo: { explanation: 'x' } });
            expect(Object.values(results).flat()).toEqual([]);
        });

        test('the wrong diagnosis fails, and so does an uncalibrated model or a distractor', async () => {
            reply = { diagnosis: SAYS[c.kind === 'parameters' ? 'structure' : 'parameters'], missing: c.distractors?.[0] };
            const results = await run({ model: givenModel(c), supportingInfo: { explanation: 'x' } });
            expect(results.diagnosis).toContain('Wrong diagnosis');
            if (c.kind === 'parameters') expect(results.fit).toEqual(['Poor fit']);
            else expect(results.mechanism).toEqual(['Missing mechanism not named']);
        });
    });
});
