import { groupTests } from '../../../evals/utilities/heldOut.js';
import { jest } from '@jest/globals';

// The stubbed judge: `said` maps a quantity (stocks) or a candidate's text (leverage) to the
// option the judge reports.
let said = {};
jest.unstable_mockModule('../../../evals/utilities/judge.js', () => ({
    extract: async (key, messages) => {
        const listed = messages[1].content.split('"""')[0];
        const items = [...listed.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ number: Number(m[1]), text: m[2] }));
        const fallback = key.includes('|stocks|') ? 'not said' : 'not discussed';
        return Object.fromEntries(items.map((x) => [`q${x.number}`, said[x.text] ?? fallback]));
    },
    clearJudgeCache: () => {}
}));

const { evaluate, groups, methodology, stockKey, LEVERAGE_CANDIDATES, hardLeverageIds, HARD_SHARE, LEVER_KEYS, hard2Ids, LEVER_SAYS } = await import('../../../evals/categories/cldStocksAndLeverage.js');
const { scenarios } = await import('../../../evals/utilities/scenarios/library.js');
const { evaluatePolicy } = await import('../../../evals/utilities/scenarios/scenarioKit.js');

const run = async (tests, response) => {
    const out = {};
    for (const t of tests) out[t.name] = (await evaluate(response, t.expectations)).map((f) => f.type);
    return out;
};
const stockTests = (id) => groupTests(groups, 'stocksInCLD').filter((t) => t.expectations.scenario === id);
const leverageTests = (id) => groupTests(groups, 'leverage').filter((t) => t.expectations.scenario === id);
const hardTests = (id) => groupTests(groups, 'leverageHard').filter((t) => t.expectations.scenario === id);

/** A CLD whose links touch every glossary name. */
const diagramOf = (id) => {
    const g = scenarios[id].glossary;
    return { variables: g.map((name) => ({ name, type: 'variable' })), relationships: g.map((name, i) => ({ from: name, to: g[(i + 1) % g.length], polarity: '+' })) };
};

describe('cldStocksAndLeverage category', () => {
    jest.setTimeout(600000);

    test('every scenario has stocks to find and quantities that are not stocks', () => {
        for (const id of Object.keys(scenarios)) {
            const { stocks, others } = stockKey(id);
            expect([id, stocks.length > 0, others.length > 0]).toEqual([id, true, true]);
        }
        expect(stockKey('dialysisClinic').stocks).toEqual(['waiting list', 'chairs', 'chairs on order', 'discouraged patients']);
        expect(stockKey('distributor').stocks).toEqual(['inventory', 'supply line']);
        expect(stockKey('distributor').others).not.toContain('orders');
    });

    test('every leverage candidate is one of the scenario\'s policies, at least one meets the goal, and the misconception does not', async () => {
        for (const [id, candidates] of Object.entries(LEVERAGE_CANDIDATES)) {
            const s = scenarios[id];
            const policies = candidates.map((c) => s.policies.find((p) => p.id === c.policy));
            expect(policies.every(Boolean)).toBe(true);
            expect(candidates.some((c) => c.policy === s.misconception)).toBe(true);
            for (const p of policies) expect([id, p.id, (await evaluatePolicy(s, p.overrides)).meets]).toEqual([id, p.id, p.effective]);
            // Across what is realistic, a change that does not work never does, and one that works
            // does at its realistic limit.
            for (const c of candidates) {
                const p = s.policies.find((x) => x.id === c.policy);
                const points = p.effective ? [c.range[c.range.length - 1]] : c.range;
                for (const o of points) expect([id, c.policy, o, (await evaluatePolicy(s, o)).meets]).toEqual([id, c.policy, o, p.effective]);
            }
            expect(policies.some((p) => p.effective)).toBe(true);
        }
    });

    test('the prompts name no answer', () => {
        for (const t of groupTests(groups, 'stocksInCLD')) expect(t.prompt).not.toMatch(/\bstock\b/i);
        for (const t of groupTests(groups, 'leverage')) {
            for (const c of LEVERAGE_CANDIDATES[t.expectations.scenario]) expect(t.prompt).not.toContain(c.text);
        }
    });

    test('every failure type is documented', () => {
        const names = methodology().criteria.map((c) => c.name);
        expect(names).toEqual(expect.arrayContaining(['Stock missing from diagram', 'Stock not recognized', 'Non-stock called an accumulation', 'High-leverage change missed', 'Low-leverage change recommended', 'No diagram produced', 'No answer given', 'Evaluation error']));
    });

    describe.each(Object.keys(scenarios))('stocks: %s', (id) => {
        const { stocks, others } = stockKey(id);

        test('a diagram that calls exactly the stocks accumulations passes everything', async () => {
            said = Object.fromEntries([...stocks.map((n) => [n, 'accumulation']), ...others.map((n) => [n, 'not an accumulation'])]);
            const results = await run(stockTests(id), { model: diagramOf(id), supportingInfo: { explanation: 'x' } });
            expect(Object.values(results).flat()).toEqual([]);
        });

        test('calling everything an accumulation fails the over-calling test only', async () => {
            said = Object.fromEntries(scenarios[id].glossary.map((n) => [n, 'accumulation']));
            const results = await run(stockTests(id), { model: diagramOf(id), supportingInfo: { explanation: 'x' } });
            const notStocks = stockTests(id).find((t) => t.expectations.criterion === 'notStocks').name;
            expect(results[notStocks]).toEqual(['Non-stock called an accumulation']);
            expect(Object.entries(results).filter(([n]) => n !== notStocks).flatMap(([, f]) => f)).toEqual([]);
        });

        test('typing a stock in the diagram counts even if the text says nothing', async () => {
            said = {};
            const model = diagramOf(id);
            for (const v of model.variables) if (stocks.includes(v.name)) v.type = 'stock';
            const results = await run(stockTests(id), { model, supportingInfo: { explanation: 'x' } });
            expect(Object.values(results).flat()).toEqual([]);
        });

        test('a stock left out of the diagram, or not recognized, fails its test', async () => {
            said = {};
            const model = diagramOf(id);
            model.relationships = model.relationships.filter((r) => r.from !== stocks[0] && r.to !== stocks[0]);
            const t = stockTests(id).find((x) => x.expectations.quantity === stocks[0]);
            expect((await evaluate({ model, supportingInfo: { explanation: 'x' } }, t.expectations)).map((f) => f.type)).toEqual(['Stock missing from diagram', 'Stock not recognized']);
        });
    });

    test('an empty diagram fails every stock test', async () => {
        const t = groupTests(groups, 'stocksInCLD')[0];
        expect((await evaluate({ model: { variables: [], relationships: [] } }, t.expectations)).map((f) => f.type)).toEqual(['No diagram produced']);
    });

    describe.each(Object.keys(LEVERAGE_CANDIDATES))('leverage: %s', (id) => {
        const s = scenarios[id];
        const candidates = LEVERAGE_CANDIDATES[id];
        const effective = candidates.filter((c) => s.policies.find((p) => p.id === c.policy).effective);
        const misconception = candidates.find((c) => c.policy === s.misconception);

        test('recommending a change that works and dismissing the misconception passes both', async () => {
            said = { [effective[0].text]: 'recommended as high leverage on its own', [misconception.text]: 'said to help little or not at all' };
            expect(Object.values(await run(leverageTests(id), { supportingInfo: { explanation: 'x' } })).flat()).toEqual([]);
        });

        test('recommending the misconception fails, and recommending everything fails it too', async () => {
            said = { [misconception.text]: 'recommended as high leverage on its own' };
            // The misconception test also fails its prerequisite: no working change is named.
            expect(Object.values(await run(leverageTests(id), { supportingInfo: { explanation: 'x' } })).flat()).toEqual(['High-leverage change missed', 'Low-leverage change recommended', 'High-leverage change missed']);
            said = Object.fromEntries(candidates.map((c) => [c.text, 'recommended as high leverage on its own']));
            expect(Object.values(await run(leverageTests(id), { supportingInfo: { explanation: 'x' } })).flat()).toEqual(['Low-leverage change recommended']);
        });

        test('offering the misconception only as a supplement is fine', async () => {
            said = { [effective[0].text]: 'recommended as high leverage on its own', [misconception.text]: 'recommended only alongside other changes' };
            expect(Object.values(await run(leverageTests(id), { supportingInfo: { explanation: 'x' } })).flat()).toEqual([]);
        });

        test('recommending a change that works as part of a package counts', async () => {
            said = { [effective[0].text]: 'recommended only alongside other changes' };
            expect(Object.values(await run(leverageTests(id), { supportingInfo: { explanation: 'x' } })).flat()).toEqual([]);
        });

        test('saying nothing fails', async () => {
            said = {};
            expect(Object.values(await run(leverageTests(id), { supportingInfo: { explanation: '' } })).flat()).toEqual(['No answer given', 'No answer given', 'High-leverage change missed']);
        });
    });

    test('hard leverage: the rule takes every scenario whose changes split a third to two thirds effective, from both splits', () => {
        const expected = Object.keys(LEVERAGE_CANDIDATES).filter((id) => {
            const c = LEVERAGE_CANDIDATES[id];
            const share = c.filter((x) => scenarios[id].policies.find((p) => p.id === x.policy).effective).length / c.length;
            return share >= HARD_SHARE[0] - 1e-9 && share <= HARD_SHARE[1] + 1e-9;
        });
        expect(hardLeverageIds).toEqual(expected);
        expect(hardLeverageIds.some((id) => scenarios[id].split === 'heldout')).toBe(true);
        expect(hardLeverageIds.some((id) => scenarios[id].split !== 'heldout')).toBe(true);
        for (const id of hardLeverageIds) expect([id, hardTests(id).length]).toEqual([id, 1]);
    });

    test('hard leverage: the prompt lists every change and names no method or kind of answer', () => {
        for (const id of hardLeverageIds) {
            const p = hardTests(id)[0].prompt;
            for (const c of LEVERAGE_CANDIDATES[id]) expect(p).toContain(c.text);
            expect([id, /leverage|sensitiv|run_scenario|tool|would not help|as things stand we miss/i.test(p)]).toEqual([id, false]);
        }
    });

    test('hard leverage: the what-if feedback is withheld — no run_scenario tool, which the leverage group offers', () => {
        for (const id of hardLeverageIds) expect([id, Boolean(hardTests(id)[0].additionalParameters.analysisTools)]).toEqual([id, false]);
        for (const id of hardLeverageIds) expect([id, leverageTests(id)[0].additionalParameters.analysisTools]).toEqual([id, true]);
    });

    describe.each(hardLeverageIds)('leverage (hard): %s', (id) => {
        const s = scenarios[id];
        const candidates = LEVERAGE_CANDIDATES[id];
        const works = (c) => s.policies.find((p) => p.id === c.policy).effective;
        const response = { supportingInfo: { explanation: 'x' } };

        test('judging every change right passes; a supplement in place of a dismissal is fine', async () => {
            said = Object.fromEntries(candidates.map((c) => [c.text, works(c) ? 'recommended as high leverage on its own' : 'said to help little or not at all']));
            expect(Object.values(await run(hardTests(id), response)).flat()).toEqual([]);
            said = Object.fromEntries(candidates.map((c) => [c.text, works(c) ? 'recommended as high leverage on its own' : 'recommended only alongside other changes']));
            expect(Object.values(await run(hardTests(id), response)).flat()).toEqual([]);
        });

        test('every constant verdict fails, and so does saying nothing', async () => {
            for (const verdict of ['recommended as high leverage on its own', 'recommended only alongside other changes', 'said to help little or not at all', 'not discussed']) {
                said = Object.fromEntries(candidates.map((c) => [c.text, verdict]));
                expect([verdict, Object.values(await run(hardTests(id), response)).flat().length > 0]).toEqual([verdict, true]);
            }
            said = {};
            expect(Object.values(await run(hardTests(id), { supportingInfo: { explanation: '' } })).flat()).toEqual(['No answer given']);
        });

        test('one change judged wrong fails: a working change only as a package, a failing one left undiscussed', async () => {
            const right = Object.fromEntries(candidates.map((c) => [c.text, works(c) ? 'recommended as high leverage on its own' : 'said to help little or not at all']));
            said = { ...right, [candidates.find(works).text]: 'recommended only alongside other changes' };
            expect(Object.values(await run(hardTests(id), response)).flat()).toEqual(['High-leverage change missed']);
            said = { ...right, [candidates.find((c) => !works(c)).text]: 'not discussed' };
            expect(Object.values(await run(hardTests(id), response)).flat()).toEqual(['Change not judged']);
            said = { ...right, [candidates.find((c) => c.policy === s.misconception).text]: 'recommended as high leverage on its own' };
            expect(Object.values(await run(hardTests(id), response)).flat()).toEqual(['Low-leverage change recommended']);
        });
    });
    describe('second hard leverage group (levers, no list of changes)', () => {
        const hard2 = (id) => groupTests(groups, 'leverageHard2').filter((t) => t.expectations.scenario === id);
        const response = { supportingInfo: { explanation: 'x' } };
        const graded = (id) => LEVER_KEYS[id].levers.filter((l) => l.verdict !== null);

        test('a hedge-everything agent — every change, the misconception included, offered only alongside other changes — scores 0', async () => {
            let passed = 0;
            for (const id of hard2Ids) {
                said = Object.fromEntries([...LEVER_KEYS[id].levers.map((l) => [l.lever, LEVER_SAYS.alongside]), ...(LEVERAGE_CANDIDATES[id] ?? []).map((c) => [c.text, 'recommended only alongside other changes'])]);
                if (!Object.values(await run(hard2(id), response)).flat().length) passed++;
                expect([id, Object.values(await run(hard2(id), response)).flat()]).toEqual([id, expect.arrayContaining(['High-leverage change missed'])]);
            }
            expect(passed).toBe(0);
        });

        test('balance: at every listed position read by two or more tests, no closed option is the right reading in more than half of them', async () => {
            const { LEVER_ORDER } = await import('../../../evals/categories/cldStocksAndLeverage.js');
            const longest = Math.max(...hard2Ids.map((id) => LEVER_ORDER[id].length));
            for (let p = 0; p < longest; p++) {
                const readers = hard2Ids.filter((id) => LEVER_ORDER[id][p]);
                if (readers.length < 2) continue;
                for (const [key, option] of Object.entries(LEVER_SAYS)) {
                    // A constant reading of this position passes where it is right (alongside is right where the lever does not work).
                    const right = readers.filter((id) => { const l = LEVER_ORDER[id][p]; return l.verdict === null || LEVER_SAYS[l.verdict] === option || (key === 'alongside' && l.verdict === 'no'); }).length;
                    expect([p + 1, option, right <= readers.length / 2]).toEqual([p + 1, option, true]);
                }
            }
            // Every scenario's listing is a reordering of its levers.
            for (const id of hard2Ids) expect([...LEVER_ORDER[id]].map((l) => l.lever).sort()).toEqual(LEVER_KEYS[id].levers.map((l) => l.lever).sort());
        });

        test('its failure types are documented', () => {
            expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['Lever not judged', 'Wrong direction']));
        });

        test('leverKeys.json is the rule applied to every held-out scenario, re-derived by simulation', async () => {
            const { leverKey } = await import('../../../evals/categories/cldStocksAndLeverageData/leverKey.js');
            const heldOut = Object.keys(scenarios).filter((id) => scenarios[id].split === 'heldout');
            expect(Object.keys(LEVER_KEYS).sort()).toEqual([...heldOut].sort());
            for (const id of heldOut) expect([id, await leverKey(scenarios[id])]).toEqual([id, LEVER_KEYS[id]]);
        });

        test('it holds only held-out scenarios, at least three, each taken by the rule; nothing else changes', () => {
            expect([groups.leverageHard2, groups.leverageHard2HeldOut.length]).toEqual([undefined, hard2Ids.length]);
            expect(hard2Ids).toEqual(Object.keys(LEVER_KEYS).filter((id) => LEVER_KEYS[id].taken));
            expect(hard2Ids.length).toBeGreaterThanOrEqual(3);
            for (const id of hard2Ids) {
                expect([id, scenarios[id].split]).toEqual([id, 'heldout']);
                expect([id, hard2(id).length, hard2(id)[0].heldOut]).toEqual([id, 1, true]);
            }
            for (const id of Object.keys(LEVER_KEYS).filter((x) => !LEVER_KEYS[x].taken)) expect([id, typeof LEVER_KEYS[id].why]).toEqual([id, 'string']);
        });

        test('the prompt lists every lever with its limits, no change, no method, and no tool is offered', () => {
            for (const id of hard2Ids) {
                const t = hard2(id)[0];
                for (const l of LEVER_KEYS[id].levers) expect(t.prompt).toContain(`"${l.lever}", now ${l.current}`);
                for (const c of LEVERAGE_CANDIDATES[id] ?? []) expect(t.prompt).not.toContain(c.text);
                expect([id, /leverage|sensitiv|run_scenario|tool|as things stand we miss/i.test(t.prompt)]).toEqual([id, false]);
                expect([id, Boolean(t.additionalParameters.analysisTools)]).toEqual([id, false]);
            }
        });

        test('every taken scenario splits both ways, and every graded verdict clears the margin', async () => {
            const { LEVER_MARGIN } = await import('../../../evals/categories/cldStocksAndLeverageData/leverKey.js');
            for (const id of hard2Ids) {
                const g = graded(id);
                expect([id, g.some((l) => l.verdict === 'no'), g.some((l) => l.verdict !== 'no')]).toEqual([id, true, true]);
                for (const l of g) for (const b of Object.values(l.best)) expect([id, l.lever, Math.abs(b) >= LEVER_MARGIN]).toEqual([id, l.lever, true]);
            }
        });

        describe.each(hard2Ids)('%s', (id) => {
            const run2 = async (r) => Object.values(await run(hard2(id), r)).flat();
            const right = () => Object.fromEntries(graded(id).map((l) => [l.lever, LEVER_SAYS[l.verdict]]));

            test('the reference answer passes; ungraded levers may be said anything', async () => {
                said = right();
                expect(await run2(response)).toEqual([]);
                said = { ...right(), ...Object.fromEntries(LEVER_KEYS[id].levers.filter((l) => l.verdict === null).map((l) => [l.lever, LEVER_SAYS.raised])) };
                expect(await run2(response)).toEqual([]);
            });

            test('doing nothing, every constant verdict, and the first hard group\'s level of answer fail', async () => {
                const { policyVerdict } = await import('../../../evals/categories/cldStocksAndLeverageData/leverKey.js');
                said = {};
                expect(await run2({ supportingInfo: { explanation: '' } })).toEqual(['No answer given']);
                for (const v of Object.values(LEVER_SAYS)) {
                    said = Object.fromEntries(LEVER_KEYS[id].levers.map((l) => [l.lever, v]));
                    expect([v, (await run2(response)).length > 0]).toEqual([v, true]);
                }
                // Judging only what the listed changes say: their verdicts, and nothing on any other lever.
                said = Object.fromEntries(LEVER_KEYS[id].levers.map((l) => [l.lever, LEVER_SAYS[policyVerdict(scenarios[id], l.lever, l.current) ?? 'unsaid']]));
                expect((await run2(response)).length).toBeGreaterThan(0);
            });

            test('one lever wrong fails: the wrong direction, a working lever dismissed, a failing one left out', async () => {
                const works = graded(id).find((l) => l.verdict !== 'no');
                const fails = graded(id).find((l) => l.verdict === 'no');
                said = { ...right(), [works.lever]: LEVER_SAYS[works.verdict === 'raised' ? 'lowered' : 'raised'] };
                expect(await run2(response)).toEqual(['Wrong direction']);
                said = { ...right(), [works.lever]: LEVER_SAYS.no };
                expect(await run2(response)).toEqual(['High-leverage change missed']);
                said = { ...right(), [works.lever]: LEVER_SAYS.alongside };
                expect(await run2(response)).toEqual(['High-leverage change missed']);
                said = { ...right(), [fails.lever]: LEVER_SAYS.alongside };
                expect(await run2(response)).toEqual([]);
                said = { ...right(), [fails.lever]: LEVER_SAYS.unsaid };
                expect(await run2(response)).toEqual(['Lever not judged']);
                said = { ...right(), [fails.lever]: LEVER_SAYS.raised };
                expect(await run2(response)).toEqual(['Low-leverage change recommended']);
            });
        });
    });
});
