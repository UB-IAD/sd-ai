import { groupTests } from '../../../evals/utilities/heldOut.js';
import { simTest } from '../simTest.js';
import { jest } from '@jest/globals';

let said = {};
let range = {};
jest.unstable_mockModule('../../../evals/utilities/judge.js', () => ({
    extract: async (key, messages) => {
        if (key.startsWith('analysisSetup|range|') || key.startsWith('analysisSetup|jointRange|')) return range;
        const listed = messages[1].content.split('Answer:')[0];
        const items = [...listed.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ number: Number(m[1]), text: m[2] }));
        return Object.fromEntries(items.map((x) => [`q${x.number}`, said[x.text] ?? 'not mentioned']));
    },
    clearJudgeCache: () => {}
}));

const { evaluate, groups, methodology, KEY, constantsOf, STANDOUT, HARD_RANGES, rangeTaken, JOINT_RANGES, jointIds } = await import('../../../evals/categories/analysisSetup.js');
const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
const { glossaryModel } = await import('../../../evals/utilities/scenarios/renameModel.js');
const { runSweep } = await import('../../../evals/utilities/simulator/sensitivity.js');
const { findVariable } = await import('../../../evals/utilities/modelDiff.js');

const testsFor = (id) => groupTests(groups, 'analysisSetup').filter((t) => t.expectations.scenario === id);
const run = async (id, response) => {
    const out = {};
    for (const t of testsFor(id)) out[t.name] = (await evaluate(response, t.expectations)).map((f) => f.type);
    return out;
};

/** Each constant's swing in the measure when moved by ±share. */
const swings = async (id, share) => {
    const m = glossaryModel(scenarios[id]);
    const k = KEY[id];
    const output = findVariable(m.variables, k.output).name;
    const params = constantsOf(m).filter((c) => c.value !== 0).map((c) => ({ name: c.name, values: [c.value * (1 - share), c.value * (1 + share)] }));
    const sweep = await runSweep(m, [output], params);
    const base = k.measure.of(sweep.base.series[output], sweep.base.time);
    const out = {};
    for (const p of params) {
        const values = sweep.runs.filter((r) => r.parameter === p.name && r.ok).map((r) => k.measure.of(r.series[output], r.time));
        out[p.name] = (Math.max(base, ...values) - Math.min(base, ...values)) / Math.abs(base);
    }
    return out;
};

/** A session that sweeps the given parameters ±50% while recording the output, and says `said`. */
const session = (id, names, explanation) => {
    const m = glossaryModel(scenarios[id]);
    const constants = constantsOf(m);
    return {
        supportingInfo: { explanation },
        toolLog: [{ toolName: 'run_sensitivity', arguments: { outputs: [KEY[id].output], parameters: names.map((n) => { const v = constants.find((c) => c.name === findVariable(m.variables, n).name).value; return { name: n, values: [v * 0.5, v * 1.5] }; }) } }]
    };
};

describe('analysisSetup category', () => {
    jest.setTimeout(900000);

    simTest('every key is the general rule applied to its scenario, and no scenario has a hand-made entry', async () => {
        const { deriveKey } = await import('../../../evals/categories/analysisSetupData/deriveKey.js');
        for (const id of Object.keys(scenarios)) {
            const derived = await deriveKey(scenarios[id]);
            if (derived.influential.length) expect([id, KEY[id] && { output: KEY[id].output, label: KEY[id].label, influential: KEY[id].influential, negligible: KEY[id].negligible, ungraded: KEY[id].ungraded }]).toEqual([id, derived]);
            else expect([id, KEY[id]]).toEqual([id, undefined]);
        }
    });

    test('every failure type is documented', () => {
        expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['Influential parameter not tested', 'Influential parameter not reported', 'Negligible parameter reported', 'Implausible ranges', 'Evaluation error']));
    });

    describe.each(Object.keys(KEY))('%s', (id) => {
        const k = KEY[id];

        test('sweeping and reporting the influential parameters, and calling the negligible ones minor, passes everything', async () => {
            said = Object.fromEntries([...k.influential.map((p) => [p, 'has a substantial effect']), ...k.negligible.map((p) => [p, 'hardly matters'])]);
            expect(Object.values(await run(id, session(id, [...k.influential, ...k.negligible], 'x'))).flat()).toEqual([]);
        });

        test('reporting without sweeping, or sweeping without recording the output, fails the influential tests', async () => {
            said = Object.fromEntries(k.influential.map((p) => [p, 'has a substantial effect']));
            const t = testsFor(id).find((x) => x.expectations.criterion === 'influential');
            expect((await evaluate(session(id, [], 'x'), t.expectations)).map((f) => f.type)).toEqual(['Influential parameter not tested']);
            const wrongOutput = session(id, k.influential, 'x');
            wrongOutput.toolLog[0].arguments.outputs = ['something else'];
            expect((await evaluate(wrongOutput, t.expectations)).map((f) => f.type)).toEqual(['Influential parameter not tested']);
        });

        test('a tiny variation does not count as testing a parameter', async () => {
            said = Object.fromEntries(k.influential.map((p) => [p, 'has a substantial effect']));
            const s = session(id, k.influential, 'x');
            for (const p of s.toolLog[0].arguments.parameters) p.values = [(p.values[0] / 0.5) * 1.02];
            const t = testsFor(id).find((x) => x.expectations.criterion === 'influential');
            expect((await evaluate(s, t.expectations)).map((f) => f.type)).toEqual(['Influential parameter not tested']);
        });

        test('a what-if run that varies the parameter counts as testing it', async () => {
            said = Object.fromEntries(k.influential.map((p) => [p, 'has a substantial effect']));
            const m = glossaryModel(scenarios[id]);
            const p = k.influential[0];
            const value = constantsOf(m).find((c) => c.name === findVariable(m.variables, p).name).value;
            const s = { supportingInfo: { explanation: 'x' }, toolLog: [{ toolName: 'run_scenario', arguments: { overrides: { [p]: value * 1.3 }, outputs: [k.output] } }] };
            const t = testsFor(id).find((x) => x.expectations.parameter === p);
            expect(await evaluate(s, t.expectations)).toEqual([]);
        });

        test('sweeping without reporting fails', async () => {
            said = {};
            const t = testsFor(id).find((x) => x.expectations.criterion === 'influential');
            expect((await evaluate(session(id, k.influential, 'x'), t.expectations)).map((f) => f.type)).toEqual(['Influential parameter not reported']);
        });

        if (k.negligible.length) {
            test('calling everything important fails the negligible test', async () => {
                const m = glossaryModel(scenarios[id]);
                said = Object.fromEntries(constantsOf(m).map((c) => [c.name, 'has a substantial effect']));
                const t = testsFor(id).find((x) => x.expectations.criterion === 'negligible');
                expect((await evaluate(session(id, k.influential, 'x'), t.expectations)).map((f) => f.type)).toEqual(['Negligible parameter reported']);
            });
        }

        test('an absurd or wrong-signed value fails the ranges test, and no sweep at all does too', async () => {
            const t = testsFor(id).find((x) => x.expectations.criterion === 'ranges');
            const s = session(id, k.influential, 'x');
            s.toolLog[0].arguments.parameters[0].values.push(-1 * Math.abs(s.toolLog[0].arguments.parameters[0].values[0]));
            expect((await evaluate(s, t.expectations)).map((f) => f.type)).toEqual(['Implausible ranges']);
            const huge = session(id, k.influential, 'x');
            huge.toolLog[0].arguments.parameters[0].values = [huge.toolLog[0].arguments.parameters[0].values[1] * 100];
            expect((await evaluate(huge, t.expectations)).map((f) => f.type)).toEqual(['Implausible ranges']);
            expect((await evaluate({ supportingInfo: { explanation: 'x' }, toolLog: [] }, t.expectations)).map((f) => f.type)).toEqual(['Implausible ranges']);
            const off = session(id, k.influential, 'x');
            off.toolLog[0].arguments.parameters[0].values.push(0);
            expect(await evaluate(off, t.expectations)).toEqual([]);
        });
    });

    describe('hard group', () => {
        const hardTests = groupTests(groups, 'analysisSetupHard');
        const hardIds = [...new Set(hardTests.map((t) => t.expectations.scenario))];
        const hardFor = (id) => hardTests.filter((t) => t.expectations.scenario === id);
        const runHard = async (id, response) => Object.fromEntries(await Promise.all(hardFor(id).map(async (t) => [t.expectations.criterion, (await evaluate(response, t.expectations)).map((f) => f.type)])));

        test('it takes every scenario with both influential and negligible parameters, dev and held out, and names neither method nor tool', () => {
            expect(hardIds.sort()).toEqual(Object.keys(KEY).filter((id) => KEY[id].influential.length && KEY[id].negligible.length).sort());
            expect(hardIds.some((id) => scenarios[id].split === 'heldout') && hardIds.some((id) => scenarios[id].split !== 'heldout')).toBe(true);
            for (const t of hardTests) expect(t.prompt).not.toMatch(/sensitiv|run_|tool|sweep|parameter/i);
        });

        test.each(Object.keys(KEY).filter((id) => KEY[id].negligible.length))('%s: the reference answer passes; doing nothing, saying nothing, or one constant verdict fails', async (id) => {
            const k = KEY[id];
            const m = glossaryModel(scenarios[id]);
            said = Object.fromEntries([...k.influential.map((p) => [p, 'has a substantial effect']), ...k.negligible.map((p) => [p, 'hardly matters'])]);
            const all = session(id, [...k.influential, ...k.negligible], 'x');
            range = { lowest: HARD_RANGES[id].low.exact, highest: HARD_RANGES[id].high.exact };
            expect(await runHard(id, all)).toEqual({ allInfluential: [], allNegligible: [], ...(rangeTaken(id) ? { range: [] } : {}) });
            // Sweeping only the influential ones cannot show the others hardly matter.
            expect((await runHard(id, session(id, k.influential, 'x'))).allNegligible).toEqual(k.negligible.map(() => 'Negligible parameter not tested'));
            // Leaving one influential parameter out fails the first test, and with it the second.
            if (k.influential.length > 1) {
                said = Object.fromEntries([...k.influential.slice(1).map((p) => [p, 'has a substantial effect']), ...k.negligible.map((p) => [p, 'hardly matters'])]);
                const r = await runHard(id, all);
                expect(r.allInfluential).toEqual(['Influential parameter not reported']);
                expect(r.allNegligible).toContain('Influential parameter not reported');
            }
            // Doing nothing: no text, no runs.
            said = {};
            range = {};
            for (const v of Object.values(await runHard(id, { supportingInfo: { explanation: '' }, toolLog: [] }))) expect(v.length).toBeGreaterThan(0);
            // One verdict for every parameter, with every parameter swept.
            const everything = session(id, constantsOf(m).filter((c) => c.value !== 0).map((c) => c.name), 'x');
            for (const verdict of ['has a substantial effect', 'hardly matters', 'not mentioned']) {
                said = Object.fromEntries(constantsOf(m).map((c) => [c.name, verdict]));
                const r = await runHard(id, everything);
                expect([verdict, r.allInfluential.length + r.allNegligible.length > 0, r.allNegligible.length > 0]).toEqual([verdict, true, true]);
            }
        });

        simTest('hardRanges.json is the rule applied to every hard scenario, re-derived by simulation, and counting more parameters than the influential ones moves neither end', async () => {
            const { rangeOver, endWithin } = await import('../../../evals/categories/analysisSetupData/hardRange.js');
            const { measureFor } = await import('../../../evals/categories/analysisSetupData/deriveKey.js');
            expect(Object.keys(HARD_RANGES).sort()).toEqual([...hardIds].sort());
            for (const id of hardIds) {
                const s = scenarios[id];
                const k = KEY[id];
                expect([id, await rangeOver(s, k.output, measureFor(s).of, k.influential)]).toEqual([id, HARD_RANGES[id]]);
                // Every graded parameter that is not negligible, influential or not, gives the same ends.
                const m = glossaryModel(s);
                const others = constantsOf(m).filter((c) => c.value !== 0).map((c) => c.name).filter((n) => ![...k.negligible, ...k.ungraded].some((p) => findVariable(m.variables, p).name === n));
                const wide = await rangeOver(s, k.output, measureFor(s).of, others);
                expect([id, endWithin(wide.low.exact, HARD_RANGES[id].low), endWithin(wide.high.exact, HARD_RANGES[id].high)]).toEqual([id, true, true]);
            }
        });

        test('every first-batch range test is taken; a later-batch one only with both ends above zero', async () => {
            const { laterBatch } = await import('../../../evals/utilities/heldOut.js');
            for (const id of Object.keys(HARD_RANGES)) {
                const expected = !laterBatch({ scenario: id }) || (HARD_RANGES[id].low.exact !== 0 && HARD_RANGES[id].high.exact !== 0);
                expect([id, rangeTaken(id)]).toEqual([id, expected]);
            }
        });

        test.each(Object.keys(HARD_RANGES).filter(rangeTaken))('%s range: the simulated ends pass, read either way; the status quo, constants, one end, or ends off by a fifth fail', async (id) => {
            const r = HARD_RANGES[id];
            const t = hardTests.find((x) => x.expectations.scenario === id && x.expectations.criterion === 'range');
            const types = async (reading) => { range = reading; return (await evaluate({ supportingInfo: { explanation: 'x' } }, t.expectations)).map((f) => f.type); };
            expect(await types({ lowest: r.low.exact, highest: r.high.exact })).toEqual([]);
            expect(await types({ lowest: r.low.shown, highest: r.high.shown })).toEqual([]);
            expect(await types({ lowest: Number(r.low.exact.toPrecision(2)), highest: Number(r.high.exact.toPrecision(2)) })).toEqual([]);
            for (const wrong of [{ lowest: r.base, highest: r.base }, { lowest: 0, highest: 0 }, { lowest: 1, highest: 1 }, { lowest: 0, highest: 1 }, { lowest: null, highest: null }, { lowest: r.low.exact, highest: null }, { lowest: r.low.exact, highest: r.base }, { lowest: r.base, highest: r.high.exact }, { lowest: r.low.exact * 0.8, highest: r.high.exact }, { lowest: r.low.exact, highest: r.high.exact * 1.2 }]) {
                expect([wrong, (await types(wrong)).length > 0]).toEqual([wrong, true]);
            }
            range = { lowest: r.low.exact, highest: r.high.exact };
            expect((await evaluate({ supportingInfo: { explanation: '' } }, t.expectations)).map((f) => f.type)).toEqual(['Range wrong']);
        });
    });
    describe('second hard group (every constant off at once)', () => {
        const jointTests = () => groupTests(groups, 'analysisSetupHard2');
        const jointTest = (id) => jointTests().find((t) => t.expectations.scenario === id);
        const types = async (id, reading, text) => { range = reading; return (await evaluate({ supportingInfo: { explanation: text ?? 'x' } }, jointTest(id).expectations)).map((f) => f.type); };

        simTest('jointRanges.json is the rule applied to every held-out scenario, re-derived by simulation', async () => {
            const { jointRange } = await import('../../../evals/categories/analysisSetupData/jointRange.js');
            const heldOut = Object.keys(scenarios).filter((id) => scenarios[id].split === 'heldout');
            expect(Object.keys(JOINT_RANGES).sort()).toEqual([...heldOut].sort());
            for (const id of heldOut) expect([id, await jointRange(scenarios[id])]).toEqual([id, JOINT_RANGES[id]]);
        });

        test('it is held out only, at least three scenarios, one test each, and names neither method nor tool', () => {
            expect(groups.analysisSetupHard2).toBeUndefined();
            expect(jointIds.length).toBeGreaterThanOrEqual(3);
            expect(jointTests().map((t) => t.expectations.scenario)).toEqual(jointIds);
            for (const t of jointTests()) {
                expect([t.name, t.heldOut]).toEqual([t.name, true]);
                expect(t.prompt).not.toMatch(/sensitiv|run_|tool|sweep|parameter/i);
            }
            for (const id of Object.keys(JOINT_RANGES).filter((x) => !jointIds.includes(x))) expect([id, typeof JOINT_RANGES[id].skip]).toEqual([id, 'string']);
        });

        test('every taken range stands clear of the one-at-a-time range and the status quo, and no end is near zero', async () => {
            const { JOINT_CLEAR, JOINT_MIN_SHARE, bandOf, jointEndWithin } = await import('../../../evals/categories/analysisSetupData/jointRange.js');
            for (const id of jointIds) {
                const r = JOINT_RANGES[id];
                // Clear of every value of the band, not only its nearer edge.
                const apart = (v, end) => bandOf(end).every((x) => Math.abs(v - x) > JOINT_CLEAR * Math.abs(x));
                expect([id, apart(r.oneAtATime.low, r.low) || apart(r.oneAtATime.high, r.high), apart(r.base, r.low), apart(r.base, r.high)]).toEqual([id, true, true, true]);
                expect([id, jointEndWithin(r.oneAtATime.low, r.low) && jointEndWithin(r.oneAtATime.high, r.high)]).toEqual([id, false]);
                for (const end of ['low', 'high']) for (const x of bandOf(r[end])) expect([id, end, Math.abs(x) >= JOINT_MIN_SHARE * Math.abs(r.base)]).toEqual([id, end, true]);
                // The improved end is at least as far out as the corner.
                expect([id, r.low.exact <= r.low.corner, r.high.exact >= r.high.corner]).toEqual([id, true, true]);
            }
        });

        test.each(Object.keys(JOINT_RANGES).filter((id) => !JOINT_RANGES[id].skip))('%s: the simulated ends pass, read either way; nothing, the status quo, constants, one end, the one-at-a-time range or ends off by a fifth fail', async (id) => {
            const { bandOf } = await import('../../../evals/categories/analysisSetupData/jointRange.js');
            const r = JOINT_RANGES[id];
            expect(await types(id, { lowest: r.low.exact, highest: r.high.exact })).toEqual([]);
            expect(await types(id, { lowest: r.low.shown, highest: r.high.shown })).toEqual([]);
            expect(await types(id, { lowest: r.low.corner, highest: r.high.corner })).toEqual([]);
            expect(await types(id, { lowest: r.low.cornerShown, highest: r.high.cornerShown })).toEqual([]);
            expect(await types(id, { lowest: Number(r.low.exact.toPrecision(2)), highest: Number(r.high.exact.toPrecision(2)) })).toEqual([]);
            expect(await types(id, { lowest: r.low.exact, highest: r.high.exact }, '')).toEqual(['Joint range wrong']);
            for (const wrong of [{ lowest: r.base, highest: r.base }, { lowest: 0, highest: 0 }, { lowest: 1, highest: 1 }, { lowest: 0, highest: 1 }, { lowest: null, highest: null }, { lowest: r.low.exact, highest: null }, { lowest: r.oneAtATime.low, highest: r.oneAtATime.high }, { lowest: Math.min(...bandOf(r.low)) * 0.8, highest: r.high.exact }, { lowest: r.low.exact, highest: Math.max(...bandOf(r.high)) * 1.2 }, { lowest: Math.max(...bandOf(r.low)) * 1.2, highest: r.high.exact }, { lowest: r.low.exact, highest: Math.min(...bandOf(r.high)) * 0.8 }]) {
                expect([wrong, (await types(id, wrong)).length > 0]).toEqual([wrong, true]);
            }
        });

        test('its failure type is documented', () => {
            expect(methodology().criteria.map((c) => c.name)).toContain('Joint range wrong');
        });
    });
});
