import { groupTests } from '../../../evals/utilities/heldOut.js';
import { simTest } from '../simTest.js';
import { jest } from '@jest/globals';
import { evaluate, groups, methodology, goalOn, HARD_GOALS, HARD2_GOALS } from '../../../evals/categories/policyImplementation.js';
import { MIN_GAP } from '../../../evals/categories/policyImplementationData/hardGoals.js';
import { hardGoal, hard2Goal } from '../../../evals/categories/policyImplementationData/hardGoals.js';
import { scenarios } from '../../../evals/utilities/scenarios/library.js';
import { glossaryModel, renameModel } from '../../../evals/utilities/scenarios/renameModel.js';
import { applyOverrides } from '../../../evals/utilities/simulateModel.js';
import { findVariable } from '../../../evals/utilities/modelDiff.js';

const ids = [...new Set(groupTests(groups, 'policyImplementation').map((t) => t.expectations.scenario))];
const testsFor = (id) => groupTests(groups, 'policyImplementation').filter((t) => t.expectations.scenario === id);
const run = async (tests, model) => {
    const out = {};
    for (const t of tests) out[t.expectations.criterion] = (await evaluate({ model }, t.expectations)).map((f) => f.type);
    return out;
};
/** The glossary model with one of the scenario's policies applied. */
const withPolicy = (s, policy) => {
    const toGlossary = Object.fromEntries(Object.entries(s.glossaryToModel).map(([g, m]) => [m, g]));
    return renameModel(applyOverrides(s.model, policy.overrides), toGlossary);
};

describe('policyImplementation category', () => {
    jest.setTimeout(900000);

    simTest('every protected quantity exists in the glossary model, and the goal is missed as things stand', async () => {
        for (const id of ids) {
            const s = scenarios[id];
            const m = glossaryModel(s);
            for (const v of s.protected.variables) expect([id, v, Boolean(findVariable(m.variables, v))]).toEqual([id, v, true]);
            expect([id, (await goalOn(m, s)).meets]).toEqual([id, false]);
        }
    });

    test('every lever is a plain number or a stock start, with a realistic bound, so no lever can be pushed or rewritten without limit', () => {
        // A lever may be rewritten outright, skipping the layering check and its 1.5x limit, so a lever
        // that is a formula (a decision rule or a flow) would let the agent replace the rule unbounded.
        for (const id of ids) {
            const s = scenarios[id];
            const m = glossaryModel(s);
            for (const l of s.levers) {
                const v = findVariable(m.variables, l) || findVariable(s.model.variables, l);
                expect([id, l, Boolean(v)]).toEqual([id, l, true]);
                const kind = v.type === 'stock' ? 'stock' : /^[-+]?[0-9.eE+-]+$/.test(String(v.equation).trim()) ? 'number' : 'formula';
                expect([id, l, kind === 'formula', Boolean(s.realistic.bounds[l] || s.realistic.bounds[v.name])]).toEqual([id, l, false, true]);
            }
        }
    });

    test('the prompt names what may not change and gives away no policy', () => {
        for (const id of ids) {
            const s = scenarios[id];
            const p = testsFor(id)[0].prompt;
            expect(p).toContain(s.protected.label);
            for (const policy of s.policies) expect(p).not.toContain(policy.text);
        }
    });

    test('every failure type is documented', () => {
        expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['Goal not met', 'Problem changed', 'Unrealistic lever', 'Impossible behavior', 'No model produced']));
    });

    describe.each(ids)('%s', (id) => {
        const s = scenarios[id];

        simTest('implementing a policy that works passes everything', async () => {
            const policy = s.policies.find((p) => p.effective && !p.parts);
            expect(await run(testsFor(id), withPolicy(s, policy))).toEqual({ meetsGoal: [], intact: [], sensible: [] });
        });

        simTest('implementing the misconception misses the goal', async () => {
            const policy = s.policies.find((p) => p.id === s.misconception);
            expect((await run(testsFor(id), withPolicy(s, policy))).meetsGoal).toEqual(['Goal not met']);
        });

        simTest('changing what management does not control is caught', async () => {
            const model = glossaryModel(s);
            const v = findVariable(model.variables, s.protected.variables[0]);
            v.equation = v.type === 'stock' ? String(Number(v.equation) / 2) : `(${v.equation}) * 0.5`;
            expect((await run(testsFor(id), model)).intact.filter((t) => t !== 'Goal not met')).toEqual(['Problem changed']);
        });
    });

    simTest('moving the goalposts is caught: driving patients away, rewriting structure', async () => {
        const d = glossaryModel(scenarios.dialysisClinic);
        findVariable(d.variables, 'give up fraction').equation = '0.5';
        expect((await run(testsFor('dialysisClinic'), d)).intact.filter((t) => t !== 'Goal not met')).toEqual(['Problem changed']);
        const b = glossaryModel(scenarios.bikeShare);
        findVariable(b.variables, 'total population').equation = '(potential_members + members) / 3';
        expect((await run(testsFor('bikeShare'), b)).intact.filter((t) => t !== 'Goal not met')).toEqual(['Problem changed']);
    });

    simTest('lowering the inventory target does not count as removing the overshoot', async () => {
        const m = glossaryModel(scenarios.distributor);
        findVariable(m.variables, 'coverage').equation = '3';
        expect((await run(testsFor('distributor'), m)).meetsGoal).toEqual(['Goal not met']);
    });

    simTest('a new policy variable wired into an existing equation is allowed', async () => {
        const m = glossaryModel(scenarios.bikeShare);
        findVariable(m.variables, 'word of mouth').equation = 'contact_rate * members * potential_members / total_population * persuasion * referral_multiplier';
        m.variables.push({ name: 'referral multiplier', type: 'variable', equation: '1.5', units: 'dimensionless' });
        const results = await run(testsFor('bikeShare'), m);
        expect(results.intact.filter((t) => t !== 'Goal not met')).toEqual([]);
        expect(results.meetsGoal).toEqual([]);
        const d = glossaryModel(scenarios.dialysisClinic);
        findVariable(d.variables, 'treatments started').equation = 'MIN(waiting_list / minimum_wait, chairs * patients_per_chair * shift_multiplier)';
        d.variables.push({ name: 'shift multiplier', type: 'variable', equation: '1.5', units: 'dimensionless' });
        expect((await run(testsFor('dialysisClinic'), d)).intact.filter((t) => t !== 'Goal not met')).toEqual([]);
    });

    simTest('a do-nothing policy variable cannot be used to rewrite a constant or an identity', async () => {
        const d = glossaryModel(scenarios.dialysisClinic);
        findVariable(d.variables, 'give up fraction').equation = '0.5 * retention_policy';
        d.variables.push({ name: 'retention policy', type: 'variable', equation: '1', units: 'dimensionless' });
        expect((await run(testsFor('dialysisClinic'), d)).intact.filter((t) => t !== 'Goal not met')).toEqual(['Problem changed']);
        const b = glossaryModel(scenarios.bikeShare);
        findVariable(b.variables, 'total population').equation = '(potential_members + members) / outreach_policy';
        b.variables.push({ name: 'outreach policy', type: 'variable', equation: '3', units: 'dimensionless' });
        expect((await run(testsFor('bikeShare'), b)).intact.filter((t) => t !== 'Goal not met')).toEqual(['Problem changed']);
        const w = glossaryModel(scenarios.bikeShare);
        findVariable(w.variables, 'word of mouth').equation = 'contact_rate * members / total_population * persuasion * campaign';
        w.variables.push({ name: 'campaign', type: 'variable', equation: '40000', units: 'people' });
        expect((await run(testsFor('bikeShare'), w)).intact.filter((t) => t !== 'Goal not met')).toEqual(['Problem changed']);
    });

    simTest('a policy variable cannot scale what patients or customers do', async () => {
        const d = glossaryModel(scenarios.dialysisClinic);
        findVariable(d.variables, 'patients giving up').equation = 'waiting_list * give_up_fraction * retention_policy';
        d.variables.push({ name: 'retention policy', type: 'variable', equation: '10', units: 'dimensionless' });
        expect((await run(testsFor('dialysisClinic'), d)).intact.filter((t) => t !== 'Goal not met')).toEqual(['Problem changed']);
        const w = glossaryModel(scenarios.distributor);
        findVariable(w.variables, 'shipments').equation = 'demand * fill_policy';
        w.variables.push({ name: 'fill policy', type: 'variable', equation: '0.8', units: 'dimensionless' });
        expect((await run(testsFor('distributor'), w)).intact.filter((t) => t !== 'Goal not met')).toEqual(['Problem changed']);
    });

    simTest('pushing a lever past what the organization could do is caught: 1000 chairs, a one-week build', async () => {
        const d = glossaryModel(scenarios.dialysisClinic);
        findVariable(d.variables, 'chairs').equation = '1000';
        expect((await run(testsFor('dialysisClinic'), d)).intact.filter((t) => t !== 'Goal not met')).toEqual(['Unrealistic lever']);
        const e = glossaryModel(scenarios.dialysisClinic);
        findVariable(e.variables, 'build delay').equation = '0.25';
        expect((await run(testsFor('dialysisClinic'), e)).intact.filter((t) => t !== 'Goal not met')).toEqual(['Unrealistic lever']);
    });

    test('every scenario\'s working policy is within its realistic limits, and the prompt states them', () => {
        for (const id of ids) {
            const s = scenarios[id];
            expect(testsFor(id)[0].prompt).toContain(s.realistic.text);
            const policy = s.policies.find((p) => p.effective && !p.parts);
            const toGlossary = Object.fromEntries(Object.entries(s.glossaryToModel).map(([g, m]) => [m, g]));
            for (const [name, value] of Object.entries(policy.overrides)) {
                const b = s.realistic.bounds[toGlossary[name] ?? name];
                if (b) expect([id, name, (b.min === undefined || Number(value) >= b.min) && (b.max === undefined || Number(value) <= b.max)]).toEqual([id, name, true]);
            }
        }
    });

    simTest('a starting value written as a formula with the same value is not a change; a different start is', async () => {
        const m = glossaryModel(scenarios.distributor);
        findVariable(m.variables, 'supply line').equation = 'base_demand * delivery_delay';
        expect((await run(testsFor('distributor'), m)).intact.filter((t) => t !== 'Goal not met')).toEqual([]);
        const n = glossaryModel(scenarios.distributor);
        findVariable(n.variables, 'supply line').equation = 'base_demand * delivery_delay * 2';
        expect((await run(testsFor('distributor'), n)).intact.filter((t) => t !== 'Goal not met')).toEqual(['Problem changed']);
    });

    simTest('a layered policy cannot carry a lever past its realistic limit: tripled word of mouth, three shifts', async () => {
        const b = glossaryModel(scenarios.bikeShare);
        findVariable(b.variables, 'word of mouth').equation = '(contact_rate * members * potential_members / total_population * persuasion) * referral_boost';
        b.variables.push({ name: 'referral boost', type: 'variable', equation: '3', units: 'dimensionless' });
        expect((await run(testsFor('bikeShare'), b)).intact.filter((t) => t !== 'Goal not met')).toEqual(['Unrealistic lever']);
        for (const boost of ['1', '2']) {
            const w = glossaryModel(scenarios.bikeShare);
            findVariable(w.variables, 'word of mouth').equation = '(contact_rate * members * potential_members / total_population * persuasion) * (1 + boost)';
            w.variables.push({ name: 'boost', type: 'variable', equation: boost, units: 'dimensionless' });
            expect([boost, (await run(testsFor('bikeShare'), w)).intact]).toEqual([boost, ['Unrealistic lever']]);
        }
        const d = glossaryModel(scenarios.dialysisClinic);
        findVariable(d.variables, 'treatments started').equation = 'MIN(waiting_list / minimum_wait, chairs * patients_per_chair * shifts)';
        d.variables.push({ name: 'shifts', type: 'variable', equation: '3', units: 'dimensionless' });
        expect((await run(testsFor('dialysisClinic'), d)).intact).toContain('Unrealistic lever');
    });

    simTest('an unchanged model earns nothing: intact and sensible count only for a policy that meets the goal', async () => {
        for (const id of ids) {
            const results = await run(testsFor(id), glossaryModel(scenarios[id]));
            expect([id, results]).toEqual([id, { meetsGoal: ['Goal not met'], intact: ['Goal not met'], sensible: ['Goal not met'] }]);
        }
    });

    simTest('meeting the goal by removing a stock is caught as changing the problem', async () => {
        const s = scenarios.dialysisClinic;
        const model = glossaryModel(s);
        model.variables = model.variables.filter((v) => v.name !== 'discouraged patients');
        expect((await run(testsFor('dialysisClinic'), model)).intact.filter((t) => t !== 'Goal not met')).toEqual(['Problem changed']);
    });

    describe('hard group', () => {
        const hardTests = groupTests(groups, 'policyImplementationHard');
        const hardIds = hardTests.map((t) => t.expectations.scenario);
        const gradeHard = async (id, model) => (await evaluate({ model }, hardTests.find((t) => t.expectations.scenario === id).expectations)).map((f) => f.type);

        simTest('hardGoals.json is what the rule gives, re-derived by simulation, from both splits', async () => {
            const derived = {};
            for (const [id, s] of Object.entries(scenarios)) {
                const g = await hardGoal(s);
                if (g) derived[id] = g;
            }
            expect(derived).toEqual(HARD_GOALS);
            expect(hardIds).toEqual(Object.keys(HARD_GOALS));
            expect(hardIds.some((id) => scenarios[id].split === 'heldout')).toBe(true);
            expect(hardIds.some((id) => scenarios[id].split !== 'heldout')).toBe(true);
        });

        test('the best realistic setting moves only the scenario\'s levers, each within its realistic limits (that it meets the hard goal and the combination does not is simulated below)', () => {
            for (const [id, g] of Object.entries(HARD_GOALS)) {
                const s = scenarios[id];
                for (const [name, value] of Object.entries(g.reference)) {
                    const lever = s.levers.find((l) => (s.glossaryToModel?.[l] ?? l) === name);
                    const { min, max } = s.realistic.bounds[lever] || s.realistic.bounds[name] || {};
                    expect([id, name, Boolean(lever), (min === undefined || Number(value) >= min) && (max === undefined || Number(value) <= max)]).toEqual([id, name, true, true]);
                }
            }
        });

        test('the hard goal is tighter than the scenario\'s own, and the prompt neither says it is missed nor asks for a policy', () => {
            for (const t of hardTests) {
                const s = scenarios[t.expectations.scenario];
                const tighter = s.goal.direction === 'below' ? t.expectations.threshold < s.goal.threshold : t.expectations.threshold > s.goal.threshold;
                expect([s.id, tighter]).toEqual([s.id, true]);
                expect(t.prompt).toContain(s.protected.label);
                expect(t.prompt).toContain(s.realistic.text);
                expect([s.id, /miss|policy|lever|leverage|sensitiv/i.test(t.prompt.replace(s.protected.label, '').replace(s.realistic.text, ''))]).toEqual([s.id, false]);
                for (const policy of s.policies) expect(t.prompt).not.toContain(policy.text);
            }
        });

        simTest.each(Object.keys(HARD_GOALS))('%s: the best realistic setting passes; every listed policy (single or combined, or single only where the goal falls back), the unchanged model and nothing fail', async (id) => {
            const s = scenarios[id];
            expect(await gradeHard(id, withPolicy(s, { overrides: HARD_GOALS[id].reference }))).toEqual([]);
            expect(Math.abs(HARD_GOALS[id].tighterThreshold - HARD_GOALS[id].referenceValue) >= MIN_GAP * Math.abs(s.goal.threshold) || HARD_GOALS[id].tighterThreshold === HARD_GOALS[id].threshold).toBe(true);
            // Where the tighter goal leaves no clear margin it falls back to the combination-only goal:
            // then the listed combination meets it and every single policy still fails.
            const fallback = HARD_GOALS[id].tighterThreshold === HARD_GOALS[id].threshold;
            for (const p of s.policies) if (!(fallback && p.parts)) expect([p.id, await gradeHard(id, withPolicy(s, p))]).toEqual([p.id, ['Goal not met']]);
            if (fallback) expect(await gradeHard(id, withPolicy(s, s.policies.find((p) => p.id === HARD_GOALS[id].combination)))).toEqual([]);
            expect(await gradeHard(id, glossaryModel(s))).toEqual(['Goal not met']);
            expect(await gradeHard(id, { variables: [], relationships: [] })).toEqual(['No model produced']);
        });

        simTest.each(Object.keys(HARD_GOALS))('%s: meeting the tighter goal by changing what management does not control fails', async (id) => {
            const s = scenarios[id];
            const model = withPolicy(s, { overrides: HARD_GOALS[id].reference });
            const v = findVariable(model.variables, s.protected.variables[0]);
            v.equation = v.type === 'stock' ? String(Number(v.equation) / 2) : `(${v.equation}) * 0.5`;
            expect(await gradeHard(id, model)).toContain('Problem changed');
        });
    });
    describe('second hard group (tighter tolerance, held-out scenarios only)', () => {
        const hard2Tests = groupTests(groups, 'policyImplementationHard2');
        const hard2Ids = hard2Tests.map((t) => t.expectations.scenario);
        const gradeHard2 = async (id, model) => (await evaluate({ model }, hard2Tests.find((t) => t.expectations.scenario === id).expectations)).map((f) => f.type);
        const gradeHard = async (id, model) => (await evaluate({ model }, groupTests(groups, 'policyImplementationHard').find((t) => t.expectations.scenario === id).expectations)).map((f) => f.type);

        simTest('hard2Goals.json is what the rule gives from the first hard goals, re-derived by simulation; every case is held out, at least three', async () => {
            const derived = {};
            for (const [id, s] of Object.entries(scenarios).filter(([x]) => scenarios[x].split === 'heldout')) {
                const g = await hard2Goal(s, HARD_GOALS[id]);
                if (g) derived[id] = g;
            }
            expect(derived).toEqual(HARD2_GOALS);
            expect(hard2Ids).toEqual(Object.keys(HARD2_GOALS));
            expect(hard2Ids.length).toBeGreaterThanOrEqual(3);
            expect(groups.policyImplementationHard2).toBeUndefined();
            for (const id of hard2Ids) expect(scenarios[id].split).toBe('heldout');
        }, 3600000);

        test('the new goal is tighter than the first hard goal, a clear margin short of the best realistic setting, and the prompt is the hard prompt with no hint', () => {
            for (const t of hard2Tests) {
                const id = t.expectations.scenario;
                const s = scenarios[id];
                const { tighterThreshold, threshold: fallback, referenceValue } = HARD_GOALS[id];
                const t2 = t.expectations.threshold;
                const below = s.goal.direction === 'below';
                expect([id, tighterThreshold !== fallback, below ? t2 < tighterThreshold : t2 > tighterThreshold]).toEqual([id, true, true]);
                expect([id, Math.abs(t2 - referenceValue) >= MIN_GAP * Math.abs(s.goal.threshold) - 1e-9]).toEqual([id, true]);
                expect(t.prompt).toContain(s.protected.label);
                expect(t.prompt).toContain(s.realistic.text);
                expect([id, /miss|policy|lever|leverage|sensitiv/i.test(t.prompt.replace(s.protected.label, '').replace(s.realistic.text, ''))]).toEqual([id, false]);
                const first = groupTests(groups, 'policyImplementationHard').find((x) => x.expectations.scenario === id);
                expect(t.prompt).not.toEqual(first.prompt);
            }
        });

        simTest.each(Object.keys(HARD2_GOALS))('%s: the best realistic setting passes with a clear margin; the setting that meets the first hard goal, every listed policy, the unchanged model and nothing fail', async (id) => {
            const s = scenarios[id];
            const t2 = HARD2_GOALS[id].threshold;
            const reference = withPolicy(s, { overrides: HARD_GOALS[id].reference });
            expect(await gradeHard2(id, reference)).toEqual([]);
            const value = (await goalOn(reference, s)).value;
            expect([id, Math.abs(value - t2) >= 0.9 * MIN_GAP * Math.abs(s.goal.threshold)]).toEqual([id, true]);
            // An answer at the level of the first hard group: it passes that group and fails this one.
            const earlier = withPolicy(s, { overrides: HARD2_GOALS[id].earlier });
            expect(await gradeHard(id, earlier)).toEqual([]);
            expect(await gradeHard2(id, earlier)).toEqual(['Goal not met']);
            for (const p of s.policies) expect([p.id, await gradeHard2(id, withPolicy(s, p))]).toEqual([p.id, ['Goal not met']]);
            expect(await gradeHard2(id, glossaryModel(s))).toEqual(['Goal not met']);
            expect(await gradeHard2(id, { variables: [], relationships: [] })).toEqual(['No model produced']);
        });

        simTest.each(Object.keys(HARD2_GOALS))('%s: meeting the new goal by changing what management does not control fails', async (id) => {
            const s = scenarios[id];
            const model = withPolicy(s, { overrides: HARD_GOALS[id].reference });
            const v = findVariable(model.variables, s.protected.variables[0]);
            v.equation = v.type === 'stock' ? String(Number(v.equation) / 2) : `(${v.equation}) * 0.5`;
            expect(await gradeHard2(id, model)).toContain('Problem changed');
        });
    });
});
