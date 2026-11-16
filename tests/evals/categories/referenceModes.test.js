import { groupTests } from '../../../evals/utilities/heldOut.js';
import { jest } from '@jest/globals';

let reading = null;
const judgeCalls = [];
jest.unstable_mockModule('../../../evals/utilities/judge.js', () => ({
    extract: async (key, messages) => { judgeCalls.push({ key, messages }); return reading; },
    clearJudgeCache: () => {}
}));

const { evaluate, groups, methodology, candidateQuantities, FORECASTS, hardQuantities, forecastPrompt } = await import('../../../evals/categories/referenceModes.js');
const { forecastFor, numbersIn, within, HARD_BAND_SHARE } = await import('../../../evals/categories/referenceModesData/forecast.js');
const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
const { computeKey } = await import('../../../evals/utilities/scenarios/scenarioKit.js');

const testsFor = (id) => groupTests(groups, 'referenceModes').filter((t) => t.expectations.scenario === id);
const conversation = (firstAnswer, links) => ({
    transcript: [{ role: 'user', turn: 1, text: 'q' }, { role: 'agent', turn: 1, text: firstAnswer }, { role: 'user', turn: 2, text: 'q2' }, { role: 'agent', turn: 2, text: 'here' }],
    model: { variables: [], relationships: links }
});
/** A reading that proposes every key quantity with its true shape and leaves the distractor out. */
const perfectReading = (s) => ({ quantities: candidateQuantities(s).map((q, i) => {
    const key = s.keyVariables.find((k) => k.glossary === q);
    return { number: i + 1, proposed: key ? 'yes' : 'no', shape: key ? key.narrativeShape : 'unclear' };
}) });
/** A diagram drawing each explaining loop link for link, in glossary names. */
const loopLinks = (s) => s.loops.flatMap((l) => {
    const n = l.variables.length;
    return l.variables.map((from, i) => ({ from, to: l.variables[(i + 1) % n], polarity: i === 0 ? l.polarity : '+' }));
});
const run = async (tests, response) => {
    const out = {};
    for (const t of tests) out[t.name] = (await evaluate(response, t.expectations)).map((f) => f.type);
    return out;
};

describe('referenceModes category', () => {
    jest.setTimeout(600000);

    test('every scenario is honest: the narrative shapes are what the hidden model does, and every explaining loop matters', async () => {
        for (const s of Object.values(scenarios)) {
            const key = await computeKey(s);
            for (const k of s.keyVariables) expect([s.id, k.model, key.shapes[k.model]]).toEqual([s.id, k.model, k.narrativeShape]);
            for (const l of s.loops) expect([s.id, l.id, key.mechanisms[l.mechanism].verdict]).toEqual([s.id, l.id, 'matters']);
        }
    });

    test('the narrative never uses modeling vocabulary, and loop variables are all in the glossary', () => {
        for (const s of Object.values(scenarios)) {
            expect(s.narrative).not.toMatch(/feedback|loop|stock|flow|reinforcing|balancing|simulation|system dynamics/i);
            for (const l of s.loops) for (const v of l.variables) expect(s.glossary).toContain(v);
        }
    });

    test('siblings share one conversation and the second turn is scripted', () => {
        for (const id of Object.keys(scenarios)) {
            const tests = testsFor(id);
            expect(new Set(tests.map((t) => JSON.stringify([t.prompt, t.currentModel, t.additionalParameters]))).size).toBe(1);
            expect(tests[0].additionalParameters.turns).toHaveLength(1);
            expect(tests[0].prompt).not.toMatch(/glossary/i);
        }
    });

    test('every failure type is documented', () => {
        expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['Reference mode missing', 'Reference mode misdescribed', 'Unrelated trend proposed', 'Explaining loop missing', 'No causal loop diagram produced', 'No response produced', 'Evaluation error']));
    });

    describe.each(Object.keys(scenarios))('%s', (id) => {
        const s = scenarios[id];

        test('a perfect answer and hypothesis pass everything', async () => {
            reading = perfectReading(s);
            const results = await run(testsFor(id), conversation('my answer', loopLinks(s)));
            expect(Object.values(results).flat()).toEqual([]);
        });

        test('wrong shapes, the distractor proposed, and no diagram fail everything', async () => {
            reading = { quantities: candidateQuantities(s).map((q, i) => ({ number: i + 1, proposed: 'yes', shape: 'flat' })) };
            const results = await run(testsFor(id), conversation('my answer', []));
            for (const types of Object.values(results)) expect(types.length).toBeGreaterThan(0);
        });

        test('an explaining loop with its polarity flipped is caught', async () => {
            reading = perfectReading(s);
            const flipped = loopLinks(s).map((l, i) => (i === 0 ? { ...l, polarity: l.polarity === '+' ? '-' : '+' } : l));
            const results = await run(testsFor(id).filter((t) => t.expectations.criterion === 'loop'), conversation('a', flipped));
            expect(Object.values(results)[0]).toEqual(['Explaining loop missing']);
        });
    });

    test('the judge reads only the first answer, never sees the shapes it is graded against, and is called once per conversation', async () => {
        const s = scenarios.dialysisClinic;
        reading = perfectReading(s);
        judgeCalls.length = 0;
        await run(testsFor('dialysisClinic'), conversation('FIRST ANSWER TEXT', loopLinks(s)));
        expect(new Set(judgeCalls.map((c) => c.key)).size).toBe(1);
        const shown = JSON.stringify(judgeCalls[0].messages);
        expect(shown).toContain('FIRST ANSWER TEXT');
        expect(shown).not.toContain('here');
    });

    test("a stock's own drain loop does not pass for the explaining loop", async () => {
        reading = perfectReading(scenarios.dialysisClinic);
        const drain = [{ from: 'waiting list', to: 'treatments started', polarity: '+' }, { from: 'treatments started', to: 'waiting list', polarity: '-' }];
        const results = await run(testsFor('dialysisClinic').filter((t) => t.expectations.criterion === 'loop'), conversation('a', drain));
        expect(Object.values(results)[0]).toEqual(['Explaining loop missing']);
        const supply = [{ from: 'supply line', to: 'deliveries', polarity: '+' }, { from: 'deliveries', to: 'supply line', polarity: '-' }];
        const results2 = await run(testsFor('distributor').filter((t) => t.expectations.criterion === 'loop'), conversation('a', supply));
        expect(Object.values(results2)[0]).toEqual(['Explaining loop missing']);
    });

    test('an explaining loop through an extra intermediate outside the glossary still counts', async () => {
        const links = [
            { from: 'waiting list', to: 'desired chairs', polarity: '+' }, { from: 'desired chairs', to: 'chairs on order', polarity: '+' },
            { from: 'chairs on order', to: 'chairs', polarity: '+' }, { from: 'chairs', to: 'treatments started', polarity: '+' },
            { from: 'treatments started', to: 'waiting list', polarity: '-' }
        ];
        const results = await run(testsFor('dialysisClinic').filter((t) => t.expectations.criterion === 'loop'), conversation('a', links));
        expect(Object.values(results)[0]).toEqual([]);
    });

    test('a response without a transcript says which engine the category needs', async () => {
        const failures = await evaluate({ model: { variables: [], relationships: [] } }, testsFor('bikeShare')[0].expectations);
        expect(failures[0].details).toMatch(/test-agent-converse/);
    });

    describe('hard group: forecasts from a rough table', () => {
        const hard = groupTests(groups, 'referenceModesHard');
        const hardIds = [...new Set(hard.map((t) => t.expectations.scenario))];
        const forecastReading = (id, valueOf) => ({ forecasts: hardQuantities(id).map((q, i) => ({ number: i + 1, value: valueOf(q) })) });
        const hardRun = async (id, response) => run(hard.filter((t) => t.expectations.scenario === id), response);

        test('a forecast given as the answer of a one-turn response with no transcript is read', async () => {
            const id = hardIds[0];
            reading = forecastReading(id, (q) => q.truth);
            const results = await hardRun(id, { supportingInfo: { explanation: 'my forecast' }, model: { variables: [], relationships: [] } });
            for (const types of Object.values(results)) expect(types).toEqual([]);
        });

        test('forecasts.json is the general rule applied to every scenario, re-derived by simulation', async () => {
            for (const s of Object.values(scenarios)) expect([s.id, await forecastFor(s)]).toEqual([s.id, FORECASTS[s.id]]);
        });

        test('the hard group covers every scenario with a graded quantity, dev and held out, one prompt each, and grades only those quantities', () => {
            expect(groups.referenceModesHard.length).toBeGreaterThan(0);
            expect(groups.referenceModesHardHeldOut.length).toBeGreaterThan(0);
            expect(hardIds).toEqual(Object.keys(scenarios).filter((id) => hardQuantities(id).some((q) => q.graded)));
            for (const id of hardIds) {
                const tests = hard.filter((t) => t.expectations.scenario === id);
                expect(new Set(tests.map((t) => JSON.stringify([t.prompt, t.currentModel, t.additionalParameters]))).size).toBe(1);
                expect(tests.map((t) => t.expectations.quantity)).toEqual(hardQuantities(id).filter((q) => q.graded).map((q) => q.glossary));
                // No hint: the prompt carries neither the narrative (which describes the whole run) nor the patterns, nor names a method.
                expect(tests[0].prompt).not.toContain(scenarios[id].narrative);
                expect(tests[0].prompt).not.toMatch(/model|simulat|feedback|loop|stock|reference mode|rising|falling|oscillat/i);
            }
        });

        test('the tighter band is half the forecast band, and grading under it is the rule: no naive answer, constant or number written in the prompt lands in it; the scenarios asked are the same as under the forecast band', () => {
            const before = Object.keys(FORECASTS).filter((id) => FORECASTS[id].quantities.some((q) => q.graded));
            // Every first-batch scenario asked under the forecast band is asked under the tighter one;
            // a later-batch scenario may have nothing left to grade under it.
            expect(hardIds).toEqual(before.filter((id) => hardIds.includes(id)));
            expect(before.filter((id) => !hardIds.includes(id)).every((id) => scenarios[id].batch === 2)).toBe(true);
            for (const id of Object.keys(FORECASTS)) {
                const promptNumbers = numbersIn(forecastPrompt(scenarios[id], FORECASTS[id]));
                hardQuantities(id).forEach((q, i) => {
                    const wide = FORECASTS[id].quantities[i];
                    expect([id, q.glossary, q.truth, Math.abs(q.band - wide.band * HARD_BAND_SHARE) <= 0.01 * wide.band]).toEqual([id, wide.glossary, wide.truth, true]);
                    const blind = [q.naive.persistence, q.naive.trend, q.naive.first, q.naive.min, q.naive.max, 0, 1, ...promptNumbers];
                    expect([id, q.glossary, q.graded]).toEqual([id, q.glossary, !blind.some((v) => within(v, q))]);
                });
            }
            expect(numbersIn('about 1,200 families, 0.05% of them, $2.6 million')).toEqual([1200, 0.05, 2.6, 2600000]);
        });

        test.each(Object.keys(FORECASTS).filter((id) => hardQuantities(id).some((q) => q.graded)))('%s: the hidden run passes; system-blind answers, constants, numbers from the prompt, the old wider band, silence and no numbers fail', async (id) => {
            const answer = conversation('my forecast', []);
            reading = forecastReading(id, (q) => q.truth);
            expect(Object.values(await hardRun(id, answer)).flat()).toEqual([]);
            reading = forecastReading(id, (q) => q.truth + 0.9 * q.band);
            expect(Object.values(await hardRun(id, answer)).flat()).toEqual([]);
            // An answer that would have passed the forecast band (15%) but misses the tighter one fails.
            reading = forecastReading(id, (q) => q.truth + 0.9 * q.band / HARD_BAND_SHARE);
            for (const types of Object.values(await hardRun(id, answer))) expect(types).toEqual(['Forecast off']);
            for (const x of numbersIn(forecastPrompt(scenarios[id], FORECASTS[id]))) {
                reading = forecastReading(id, () => x);
                for (const types of Object.values(await hardRun(id, answer))) expect([x, types]).toEqual([x, ['Forecast off']]);
            }
            for (const blind of [(q) => q.naive.persistence, (q) => q.naive.trend, (q) => q.naive.first, (q) => q.naive.min, (q) => q.naive.max, () => 0, () => 1, (q) => q.truth + 1.1 * q.band]) {
                reading = forecastReading(id, blind);
                for (const types of Object.values(await hardRun(id, answer))) expect(types).toEqual(['Forecast off']);
            }
            reading = forecastReading(id, () => null);
            for (const types of Object.values(await hardRun(id, answer))) expect(types).toEqual(['Forecast missing']);
            reading = { forecasts: [] };
            for (const types of Object.values(await hardRun(id, answer))) expect(types).toEqual(['Forecast missing']);
            for (const types of Object.values(await hardRun(id, conversation('', [])))) expect(types).toEqual(['No response produced']);
        });

        test('the forecast judge is shown the answer and the quantities, never the hidden values', async () => {
            const t = hard[0];
            reading = forecastReading(t.expectations.scenario, (q) => q.truth);
            judgeCalls.length = 0;
            await evaluate(conversation('FORECAST TEXT', []), t.expectations);
            const shown = JSON.stringify(judgeCalls[0].messages);
            expect(shown).toContain('FORECAST TEXT');
            expect(shown).not.toContain(String(t.expectations.truth));
        });
    });

    test('an engine failure is reported, not thrown', async () => {
        const results = await run(testsFor('bikeShare'), { err: 'boom' });
        expect(Object.values(results).every((t) => t.includes('No response produced'))).toBe(true);
    });
});

const { TRAJECTORIES, trajectoryPoints, trajectoryAsked, trajectoryPrompt } = await import('../../../evals/categories/referenceModes.js');
const { trajectoryFor, pointGraded, MIN_TRAJECTORY_TIMES, HORIZONS, TOLERANCE, FLOOR } = await import('../../../evals/categories/referenceModesData/forecast.js');

describe('referenceModes second hard group: a path of forecasts, graded together', () => {
    jest.setTimeout(600000);
    const hard2 = groupTests(groups, 'referenceModesHard2');
    const ids = hard2.map((t) => t.expectations.scenario);
    const testOf = (id) => hard2.find((t) => t.expectations.scenario === id);
    const pathReading = (id, valueOf) => ({ forecasts: trajectoryPoints(id).map((p, i) => ({ number: i + 1, value: valueOf(p, i) })) });
    const grade = async (id, response) => (await evaluate(response, testOf(id).expectations)).map((f) => f.type);
    const answer = conversation('my forecast', []);

    test('trajectories.json is the general rule applied to every scenario, re-derived by simulation', async () => {
        for (const s of Object.values(scenarios)) expect([s.id, await trajectoryFor(s, FORECASTS[s.id])]).toEqual([s.id, TRAJECTORIES[s.id]]);
        for (const tr of Object.values(TRAJECTORIES)) expect(tr.times.length).toBe(HORIZONS.length);
    });

    test('the group holds one test for every held-out scenario with graded points at enough different times, at least three, and only those points are graded', () => {
        expect(groups.referenceModesHard2).toBeUndefined();
        expect(ids).toEqual(Object.keys(scenarios).filter((id) => scenarios[id].split === 'heldout' && trajectoryAsked(id)));
        expect(ids.length).toBeGreaterThanOrEqual(3);
        for (const id of ids) {
            const t = testOf(id);
            const points = trajectoryPoints(id);
            const promptNumbers = numbersIn(t.prompt);
            expect(t.expectations.graded.map((g) => g.item)).toEqual(points.flatMap((p, i) => (pointGraded(p, promptNumbers) ? [i] : [])));
            expect(new Set(t.expectations.graded.map((g) => points[g.item].at)).size).toBeGreaterThanOrEqual(MIN_TRAJECTORY_TIMES);
            for (const g of t.expectations.graded) {
                const p = points[g.item];
                const blind = [p.naive.persistence, p.naive.trend, p.naive.first, p.naive.min, p.naive.max, 0, 1, ...promptNumbers];
                expect([id, p.glossary, p.at, blind.some((v) => within(v, g))]).toEqual([id, p.glossary, p.at, false]);
                // The hard group's tighter band at that time: at least half the forecast band's share of the value.
                expect([id, p.at, g.band >= 0.99 * HARD_BAND_SHARE * TOLERANCE * Math.abs(g.truth), g.band > 0]).toEqual([id, p.at, true, true]);
                expect([id, p.at, g.band <= 1.01 * HARD_BAND_SHARE * Math.max(TOLERANCE * Math.abs(g.truth), FLOOR * Math.max(...FORECASTS[id].table.map((r) => Math.abs(r[p.glossary]))) * 1.1)]).toEqual([id, p.at, true]);
            }
            // The same facts and table as the hard group's question, no hint, a new prompt.
            expect(t.prompt).toBe(trajectoryPrompt(scenarios[id], FORECASTS[id], TRAJECTORIES[id]));
            expect(t.prompt).not.toBe(forecastPrompt(scenarios[id], FORECASTS[id]));
            expect(t.prompt).toContain(forecastPrompt(scenarios[id], FORECASTS[id]).split('We are at')[0]);
            expect(t.prompt).not.toContain(scenarios[id].narrative);
            expect(t.prompt).not.toMatch(/model|simulat|feedback|loop|stock|reference mode|rising|falling|oscillat/i);
        }
    });

    test.each(ids)('%s: the hidden run passes; one point off, the end right but the path not, blind answers, numbers from the prompt, silence and no numbers fail', async (id) => {
        const graded = testOf(id).expectations.graded;
        reading = pathReading(id, (p) => p.truth);
        expect(await grade(id, answer)).toEqual([]);
        expect(await grade(id, { supportingInfo: { explanation: 'my forecast' }, model: { variables: [], relationships: [] } })).toEqual([]);
        reading = pathReading(id, (p) => p.truth + 0.9 * p.band);
        expect(await grade(id, answer)).toEqual([]);
        reading = pathReading(id, (p) => p.truth - 0.9 * p.band);
        expect(await grade(id, answer)).toEqual([]);
        // Every point but one right fails.
        for (const g of graded) {
            reading = pathReading(id, (p, i) => (i === g.item ? p.truth + 1.1 * p.band : p.truth));
            expect(await grade(id, answer)).toEqual(['Forecast off']);
        }
        // An answer at the level of the hard group: the end of the run right, the rest of the path carried on from the last record.
        const end = Math.max(...TRAJECTORIES[id].times);
        reading = pathReading(id, (p) => (p.at === end ? p.truth : p.naive.persistence));
        expect(await grade(id, answer)).toContain('Forecast off');
        for (const blind of [(p) => p.naive.persistence, (p) => p.naive.trend, (p) => p.naive.first, (p) => p.naive.min, (p) => p.naive.max, () => 0, () => 1]) {
            reading = pathReading(id, blind);
            expect(await grade(id, answer)).toEqual(graded.map(() => 'Forecast off'));
        }
        for (const x of numbersIn(testOf(id).prompt)) {
            reading = pathReading(id, () => x);
            expect([x, await grade(id, answer)]).toEqual([x, graded.map(() => 'Forecast off')]);
        }
        reading = pathReading(id, () => null);
        expect(await grade(id, answer)).toEqual(graded.map(() => 'Forecast missing'));
        reading = { forecasts: [] };
        expect(await grade(id, answer)).toEqual(graded.map(() => 'Forecast missing'));
        expect(await grade(id, conversation('', []))).toEqual(['No response produced']);
    });

    test('the judge is shown the answer, the quantities and the times, never the hidden values', async () => {
        const t = hard2[0];
        reading = pathReading(t.expectations.scenario, (p) => p.truth);
        judgeCalls.length = 0;
        await evaluate(conversation('PATH TEXT', []), t.expectations);
        const shown = JSON.stringify(judgeCalls[0].messages);
        expect(shown).toContain('PATH TEXT');
        for (const x of t.expectations.items) expect(shown).toContain(`${x.quantity} at`);
        for (const g of t.expectations.graded) expect(shown).not.toContain(String(g.truth));
    });

    test('the methodology describes the group', () => {
        expect(methodology().howItWorks.some((x) => x.includes('referenceModesHard2'))).toBe(true);
    });
});
