import { groupTests } from '../../../evals/utilities/heldOut.js';
import { jest } from '@jest/globals';

let named = 'none or several';
const judgeKeys = [];
jest.unstable_mockModule('../../../evals/utilities/judge.js', () => ({
    extract: async (key, messages) => { judgeKeys.push({ key, system: messages[0].content }); return { archetype: named }; },
    clearJudgeCache: () => {}
}));

const { evaluate, groups, methodology, hardCaseNames, HARD_MIN_LOOPS } = await import('../../../evals/categories/archetypes.js');
const { ARCHETYPES, cases, DISTRACTOR_OF } = await import('../../../evals/categories/archetypesData/cases.js');

const testsFor = (name) => groupTests(groups, 'archetypes').filter((t) => t.expectations.caseName === name);
const run = async (name, response) => {
    const out = {};
    for (const t of testsFor(name)) out[t.name] = (await evaluate(response, t.expectations)).map((f) => f.type);
    return out;
};
const diagram = (links) => ({ model: { variables: [], relationships: structuredClone(links) }, supportingInfo: { explanation: 'x' } });
const flip = (p) => (p === '+' ? '-' : '+');

const JARGON = /\b(loop|feedback|reinforc\w*|balanc\w*|archetype|stock|flow|vicious|virtuous|delay|limits? to growth|tragedy|commons|escalat\w*|fixes that fail|shifting the burden|underinvest\w*|erod\w*|erosion|adversar\w*|success to the successful|growth and underinvestment)\b/i;

describe('archetypes category', () => {
    test('no situation uses modeling vocabulary or names an archetype', () => {
        for (const [name, c] of Object.entries(cases)) expect([name, c.narrative.match(JARGON)?.[0] ?? null]).toEqual([name, null]);
    });

    test('every case is a listed archetype, every archetype has a case, and none has more than two', () => {
        const archetypes = Object.values(cases).map((c) => c.archetype);
        for (const a of archetypes) expect(ARCHETYPES).toContain(a);
        for (const a of ARCHETYPES) expect([a, archetypes.filter((x) => x === a).length >= 1 && archetypes.filter((x) => x === a).length <= 2]).toEqual([a, true]);
    });

    test('every glossary name a loop uses is in the glossary', () => {
        for (const c of Object.values(cases)) for (const loop of c.loops) for (const v of [...loop.variables, ...loop.core]) expect(c.glossary).toContain(v);
    });

    test('every failure type is documented', () => {
        expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['Archetype not identified', 'Archetype loop missing', 'No diagram produced', 'Evaluation error']));
    });

    describe.each(Object.keys(cases))('%s', (name) => {
        const c = cases[name];

        test('the reference diagram, with the right archetype, passes everything', async () => {
            named = c.archetype;
            expect(Object.values(await run(name, diagram(c.links))).flat()).toEqual([]);
        });

        test('another archetype, or none, fails the archetype test', async () => {
            const t = testsFor(name).find((x) => x.expectations.criterion === 'archetype');
            named = ARCHETYPES.find((a) => a !== c.archetype);
            expect((await evaluate(diagram(c.links), t.expectations)).map((f) => f.type)).toEqual(['Archetype not identified']);
            named = 'none or several';
            expect((await evaluate(diagram(c.links), t.expectations)).map((f) => f.type)).toEqual(['Archetype not identified']);
        });

        test('each loop is needed: removing one of its links fails that loop', async () => {
            for (const loop of c.loops) {
                const t = testsFor(name).find((x) => x.expectations.loop === loop.id);
                for (const core of loop.core) {
                    const cut = c.links.filter((l) => !(l.from === core && loop.variables.includes(l.to)));
                    expect([loop.id, core, (await evaluate(diagram(cut), t.expectations)).map((f) => f.type)]).toEqual([loop.id, core, ['Archetype loop missing']]);
                }
            }
        });

        test('flipping the polarity of one link on a loop breaks that loop, for every loop', async () => {
            for (const loop of c.loops) {
                const t = testsFor(name).find((x) => x.expectations.loop === loop.id);
                const onLoop = new Set(loop.variables);
                const flipped = c.links.map((l) => (onLoop.has(l.from) && onLoop.has(l.to) && l.from === loop.core[0] ? { ...l, polarity: flip(l.polarity) } : l));
                expect([loop.id, (await evaluate(diagram(flipped), t.expectations)).map((f) => f.type)]).toEqual([loop.id, ['Archetype loop missing']]);
            }
        });
    });

    test('reasonable variants of a loop pass: breakdowns acting through running hours, promotions eroding skills directly', async () => {
        named = 'Fixes that Fail';
        const m = cases['Machine maintenance'];
        const viaHours = [...m.links.filter((l) => !(l.from === 'breakdowns')), { from: 'breakdowns', to: 'machine running hours', polarity: '-' }];
        const side = testsFor('Machine maintenance').find((x) => x.expectations.loop === 'side effect');
        expect(await evaluate(diagram(viaHours), side.expectations)).toEqual([]);
        const p = cases['Sales promotions'];
        const direct = [...p.links.filter((l) => !(l.from === 'discount promotions' && l.to === 'sales training')), { from: 'discount promotions', to: 'selling skills', polarity: '-' }];
        const dependence = testsFor('Sales promotions').find((x) => x.expectations.loop === 'dependence');
        expect(await evaluate(diagram(direct), dependence.expectations)).toEqual([]);
    });

    test('the hard test lets the answer describe the archetype instead of naming it (the hard prompt asks for none)', async () => {
        const name = groupTests(groups, 'archetypesHard')[0].expectations.caseName;
        const t = groupTests(groups, 'archetypesHard')[0];
        named = cases[name].archetype;
        judgeKeys.length = 0;
        await evaluate(diagram(cases[name].links), t.expectations);
        const own = judgeKeys.find((k) => k.key.startsWith('archetypes|described|'));
        expect(Boolean(own)).toBe(true);
        expect(own.system).toMatch(/describing its defining structure/);
        judgeKeys.length = 0;
        await evaluate(diagram(cases[name].links), { caseName: name, criterion: 'archetype' });
        expect(judgeKeys[0].system).not.toMatch(/describing its defining structure/);
    });

    test('an empty diagram fails the loop tests', async () => {
        const t = groupTests(groups, 'archetypes').find((x) => x.expectations.criterion === 'loop');
        expect((await evaluate({ model: { variables: [], relationships: [] } }, t.expectations)).map((f) => f.type)).toEqual(['No diagram produced']);
    });

    describe('hard group: no archetype asked for, archetype and every loop in one test', () => {
        const hard = groupTests(groups, 'archetypesHard');
        const gradeHard = async (name, response) => (await evaluate(response, hard.find((t) => t.expectations.caseName === name).expectations)).map((f) => f.type);

        test('the rule takes every situation with four or more loops, dev and held out, one test each; the prompt asks for no archetype', () => {
            expect(hardCaseNames).toEqual(Object.keys(cases).filter((n) => cases[n].loops.length >= HARD_MIN_LOOPS));
            expect(hard.map((t) => t.expectations.caseName)).toEqual(hardCaseNames);
            expect(groups.archetypesHard.length).toBeGreaterThan(0);
            expect(groups.archetypesHardHeldOut.length).toBeGreaterThan(0);
            for (const t of hard) {
                expect(t.prompt).toContain(cases[t.expectations.caseName].narrative);
                expect(t.prompt.replace(cases[t.expectations.caseName].narrative, '').replace('causal loop diagram', '')).not.toMatch(JARGON);
            }
        });

        describe.each(hardCaseNames)('%s', (name) => {
            const c = cases[name];

            test('the reference diagram with the right archetype passes', async () => {
                named = c.archetype;
                expect(await gradeHard(name, diagram(c.links))).toEqual([]);
            });

            test('doing nothing, naming no archetype, a constant archetype, or one loop flipped fails', async () => {
                named = 'none or several';
                expect(await gradeHard(name, { model: { variables: [], relationships: [] }, supportingInfo: { explanation: '' } })).toEqual(['Archetype not identified', ...c.loops.map(() => 'No diagram produced')]);
                expect(await gradeHard(name, diagram(c.links))).toEqual(['Archetype not identified']);
                // Every constant archetype but the right one fails; hardCaseNames spans more than one archetype.
                for (const a of ARCHETYPES.filter((x) => x !== c.archetype)) {
                    named = a;
                    expect([a, await gradeHard(name, diagram(c.links))]).toEqual([a, ['Archetype not identified']]);
                }
                named = c.archetype;
                const loop = c.loops[0];
                const onLoop = new Set(loop.variables);
                const flipped = c.links.map((l) => (onLoop.has(l.from) && onLoop.has(l.to) && l.from === loop.core[0] ? { ...l, polarity: flip(l.polarity) } : l));
                expect(await gradeHard(name, diagram(flipped))).toContain('Archetype loop missing');
            });
        });

        test('every hard situation is told with a distractor archetype\'s surface features, by rule: a reading in another archetype\'s terms, after the narrative, with no modeling vocabulary and no quantity of its own', () => {
            for (const name of hardCaseNames) {
                const c = cases[name];
                const t = hard.find((x) => x.expectations.caseName === name);
                expect([name, Boolean(DISTRACTOR_OF[c.archetype]), DISTRACTOR_OF[c.archetype] !== c.archetype]).toEqual([name, true, true]);
                expect(ARCHETYPES).toContain(DISTRACTOR_OF[c.archetype]);
                expect([name, typeof c.distractor === 'string' && c.distractor.length > 40]).toEqual([name, true]);
                expect([name, c.distractor.match(JARGON)?.[0] ?? null]).toEqual([name, null]);
                expect(t.prompt).toContain(`${c.narrative} ${c.distractor}`);
                for (const g of c.glossary) expect([name, g, c.distractor.toLowerCase().includes(g.toLowerCase())]).toEqual([name, g, false]);
            }
            // Only the hard prompt carries it: the archetypes group's prompts are unchanged.
            for (const t of groupTests(groups, 'archetypes')) if (cases[t.expectations.caseName].distractor) expect(t.prompt).not.toContain(cases[t.expectations.caseName].distractor);
        });

        test.each(hardCaseNames)('%s: naming the distractor archetype fails', async (name) => {
            named = DISTRACTOR_OF[cases[name].archetype];
            expect(await gradeHard(name, diagram(cases[name].links))).toEqual(['Archetype not identified']);
        });

        test('no single archetype is right for every hard situation', () => {
            expect(new Set(hardCaseNames.map((n) => cases[n].archetype)).size).toBeGreaterThan(1);
        });
    });
});
