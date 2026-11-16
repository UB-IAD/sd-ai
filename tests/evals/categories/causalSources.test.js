import { groupTests } from '../../../evals/utilities/heldOut.js';
import fs from 'fs';
import { jest } from '@jest/globals';

let reply = { links: [], citedSources: [] };
jest.unstable_mockModule('../../../evals/utilities/judge.js', () => ({
    extract: async () => reply,
    clearJudgeCache: () => {}
}));

const { evaluate, groups, methodology, FILES, SUPPORTED, UNSUPPORTED, GLOSSARY, CORPORA, hardGlossary } = await import('../../../evals/categories/causalSources.js');
const { HARD_SECOND, secondUnsupported } = await import('../../../evals/categories/causalSourcesData/hardLinks.js');

const tests = groupTests(groups, 'causalSources').filter((t) => t.expectations.corpus === 'bikeShare');
const asked = [...SUPPORTED, UNSUPPORTED];
const diagram = (links) => ({ model: { variables: [], relationships: links.map((l) => ({ ...l })) }, supportingInfo: { explanation: 'x' }, toolLog: [{ toolName: 'Read', arguments: { file_path: '/tmp/x/rag/eval-file-1/member_survey_2025.md' } }] });
const all = [...SUPPORTED, UNSUPPORTED];
const run = async (response) => Object.fromEntries(await Promise.all(tests.map(async (t) => [t.name, (await evaluate(response, t.expectations)).map((f) => f.type)])));
const sources = (fn) => asked.map((l, i) => ({ number: i + 1, source: fn(l) }));

describe('causalSources category', () => {
    test('every document is attached and exists; each supported link\'s document states it in plain words', () => {
        const attached = tests[0].additionalParameters.attachments.map((a) => a.path);
        expect(attached).toHaveLength(FILES.length);
        for (const p of attached) expect(fs.existsSync(p)).toBe(true);
        const text = Object.fromEntries(attached.map((p) => [p.split('/').pop(), fs.readFileSync(p, 'utf8').toLowerCase()]));
        // The planted support: each document mentions the link's two quantities in its own words.
        const words = { 'members': /member/, 'word of mouth': /friend|someone they know|talked them|mention/, 'signing up': /sign/, 'advertising': /advert|campaign/, 'potential members': /pool|has not signed up|could realistically sign up/ };
        for (const l of SUPPORTED) expect([l.source, words[l.from].test(text[l.source]), words[l.to].test(text[l.source])]).toEqual([l.source, true, true]);
        expect(text['tyre_prices.md']).not.toMatch(/sign|member/);
    });

    test('the unsupported link is stated by no document: nothing says sign-ups become or join as members', () => {
        for (const f of FILES) expect([f, fs.readFileSync(tests[0].additionalParameters.attachments.find((a) => a.path.endsWith(f)).path, 'utf8')]).not.toEqual([f, expect.stringMatching(/\bjoin|become members?|sign-ups? (add|become)/i)]);
    });

    describe.each(Object.keys(CORPORA))('corpus %s', (id) => {
        const c = CORPORA[id];
        const mine = groupTests(groups, 'causalSources').filter((t) => t.expectations.corpus === id);
        const text = Object.fromEntries(c.files.map((f) => [f, fs.readFileSync(`${c.dir}/${f}`, 'utf8').toLowerCase()]));

        test('every document exists and is attached; the unrelated one mentions none of the quantities', () => {
            expect(mine[0].additionalParameters.attachments.map((a) => a.path.split('/').pop()).sort()).toEqual([...c.files].sort());
            for (const n of c.glossary) expect([n, new RegExp(c.words[n]).test(text[c.unrelated])]).toEqual([n, false]);
        });

        test('each supported link\'s document names both its quantities in plain words', () => {
            for (const l of c.supported) expect([l.source, new RegExp(c.words[l.from]).test(text[l.source]), new RegExp(c.words[l.to]).test(text[l.source])]).toEqual([l.source, true, true]);
        });

        test('no document states the unsupported link', () => {
            for (const f of c.files) expect([f, new RegExp(c.notStated, 'i').test(text[f])]).toEqual([f, false]);
        });

        test('no modeling vocabulary in the subject, the question or the documents (the problem statement names the diagram asked for)', () => {
            const JARGON = /\b(loops?|feedback|reinforc\w*|balancing|archetypes?|stocks? and flows?|causal|system dynamics)\b/i;
            for (const [what, t] of [['subject', c.subject], ['question', c.question], ...c.files.map((f) => [f, text[f]])]) expect([what, t.match(JARGON)?.[0] ?? null]).toEqual([what, null]);
        });

        test('every link uses glossary names, every source is a file, and the prompt names no file', () => {
            for (const l of [...c.supported, c.unsupported]) expect([l.from, l.to].every((n) => c.glossary.includes(n))).toBe(true);
            for (const l of c.supported) expect(c.files).toContain(l.source);
            for (const f of c.files) expect(mine[0].prompt).not.toContain(f);
            expect(mine).toHaveLength(c.supported.length + 3);
        });

        test('the right diagram with the right sources passes everything; nothing passes a do-nothing answer', async () => {
            const all = [...c.supported, c.unsupported];
            reply = { links: all.map((l, i) => ({ number: i + 1, source: l.source || 'marked as an assumption or a definition' })), citedSources: [...new Set(c.supported.map((l) => l.source))] };
            const response = { model: { variables: [], relationships: all.map((l) => ({ ...l })) }, supportingInfo: { explanation: 'x' }, toolLog: [{ toolName: 'Read', arguments: { file_path: `/tmp/x/rag/eval-file-1/${c.files[0]}` } }] };
            for (const t of mine) expect([t.name, await evaluate(response, t.expectations)]).toEqual([t.name, []]);
            reply = { links: [], citedSources: [] };
            for (const t of mine) expect([t.name, (await evaluate({}, t.expectations)).length > 0]).toEqual([t.name, true]);
        });
    });

    test('the assumption drawn with the wrong polarity fails, even when marked as an assumption', async () => {
        reply = { links: sources((l) => l.source || 'marked as an assumption or a definition'), citedSources: [...new Set(SUPPORTED.map((l) => l.source))] };
        const reversed = all.map((l) => (l === UNSUPPORTED ? { ...l, polarity: l.polarity === '+' ? '-' : '+' } : l));
        const results = await run(diagram(reversed));
        expect(results[tests.find((t) => t.expectations.criterion === 'unsupported').name]).toEqual(['Assumption not marked']);
    });

    test('the prompt asks for polarities', () => {
        expect(tests[0].prompt).toMatch(/polarit/);
    });

    test('a read of an upload by any read tool counts; reading some other file does not', async () => {
        const t = tests.find((x) => x.expectations.criterion === 'read');
        for (const toolName of ['read_file', 'Read', 'mcp__sdai__read_file']) expect(await evaluate({ toolLog: [{ toolName, arguments: { path: 'rag/eval-file-2/x.md' } }] }, t.expectations)).toEqual([]);
        expect((await evaluate({ toolLog: [{ toolName: 'Read', arguments: { file_path: '/etc/hosts' } }] }, t.expectations)).map((f) => f.type)).toEqual(['Documents not read']);
    });

    test('every link uses glossary names, and the prompt names no file', () => {
        for (const l of all) expect([GLOSSARY.includes(l.from), GLOSSARY.includes(l.to)]).toEqual([true, true]);
        for (const f of FILES) expect(tests[0].prompt).not.toContain(f);
    });

    test('every failure type is documented', () => {
        expect(methodology().criteria.map((c) => c.name)).toEqual(expect.arrayContaining(['Supported link missing', 'Wrong source', 'Assumption not marked', 'Source fabricated', 'Documents not read', 'No diagram produced', 'Evaluation error']));
    });

    test('the right diagram with the right sources passes everything', async () => {
        reply = { links: sources((l) => l.source || 'marked as an assumption or a definition'), citedSources: [...new Set(SUPPORTED.map((l) => l.source))] };
        expect(Object.values(await run(diagram(all))).flat()).toEqual([]);
    });

    test('a wrong source, a source for the assumption, and an invented report all fail', async () => {
        reply = { links: sources((l) => (l === SUPPORTED[0] ? 'marketing_review_2025.md' : l === UNSUPPORTED ? 'member_survey_2025.md' : l.source)), citedSources: ['member_survey_2025.md', 'a source that was not uploaded'] };
        const results = await run(diagram(all));
        expect(results[tests[0].name]).toEqual(['Wrong source']);
        expect(results[tests.find((t) => t.expectations.criterion === 'unsupported').name]).toEqual(['Assumption not marked']);
        expect(results[tests.find((t) => t.expectations.criterion === 'noFabrication').name]).toEqual(['Source fabricated']);
    });

    test('a missing or reversed link fails its test; no reads fails the read test', async () => {
        reply = { links: sources((l) => l.source || 'marked as an assumption or a definition'), citedSources: [] };
        const flipped = all.map((l) => (l === SUPPORTED[4] ? { ...l, polarity: '+' } : l)).filter((l) => l !== SUPPORTED[2]);
        const response = { ...diagram(flipped), toolLog: [] };
        const results = await run(response);
        expect(results[tests[2].name]).toEqual(['Supported link missing']);
        expect(results[tests[4].name]).toEqual(['Supported link missing']);
        expect(results[tests.find((t) => t.expectations.criterion === 'read').name]).toEqual(['Documents not read']);
    });

    describe('hard group: a second unstated link by rule, every link graded in one test', () => {
        const hard = groupTests(groups, 'causalSourcesHard');
        const ASSUMED = 'marked as an assumption or a definition';

        test('every corpus has one hard test, dev and held out, whose prompt adds the second link\'s flow to the glossary', () => {
            expect(Object.keys(HARD_SECOND).sort()).toEqual(Object.keys(CORPORA).sort());
            expect(hard.map((t) => t.expectations.corpus)).toEqual(Object.keys(CORPORA));
            expect(groups.causalSourcesHard.length).toBeGreaterThan(0);
            expect(groups.causalSourcesHardHeldOut.length).toBeGreaterThan(0);
            for (const t of hard) {
                const c = CORPORA[t.expectations.corpus];
                expect(t.prompt).toContain(hardGlossary(c).join(', '));
                for (const f of c.files) expect(t.prompt).not.toContain(f);
                // Guidance withheld: no word on assumptions, file names or where to put sources.
                expect(t.prompt).not.toMatch(/assumption|file name|reasoning|no document|support/i);
                expect(t.prompt).toMatch(/where it comes from/);
            }
        });

        test.each(Object.keys(CORPORA))('%s: the second link is the other flow of the unsupported link\'s stock, and no document mentions it', (id) => {
            const c = CORPORA[id];
            const second = secondUnsupported(c);
            expect(second.to).toBe(c.unsupported.to);
            expect(second.polarity).toBe(c.unsupported.polarity === '+' ? '-' : '+');
            expect(c.glossary).not.toContain(second.from);
            for (const f of c.files) expect([f, new RegExp(HARD_SECOND[id].notStated, 'i').test(fs.readFileSync(`${c.dir}/${f}`, 'utf8'))]).toEqual([f, false]);
        });

        test.each(Object.keys(CORPORA))('%s: the reference answer passes; doing nothing, any constant source, a source for the second assumption, or leaving it out fails', async (id) => {
            const c = CORPORA[id];
            const t = hard.find((x) => x.expectations.corpus === id);
            const second = secondUnsupported(c);
            const all = [...c.supported, c.unsupported, second];
            const read = [{ toolName: 'Read', arguments: { file_path: `/tmp/x/rag/eval-file-1/${c.files[0]}` } }];
            const response = (links) => ({ model: { variables: [], relationships: links.map((l) => ({ ...l })) }, supportingInfo: { explanation: 'x' }, toolLog: read });
            const sourcing = (fn) => ({ links: all.map((l, i) => ({ number: i + 1, source: fn(l, i) })), citedSources: [...new Set(c.supported.map((l) => l.source))] });
            reply = sourcing((l) => l.source || ASSUMED);
            expect(await evaluate(response(all), t.expectations)).toEqual([]);
            reply = { links: [], citedSources: [] };
            expect((await evaluate({}, t.expectations)).length).toBeGreaterThan(0);
            expect((await evaluate({ model: { variables: [], relationships: [] }, supportingInfo: { explanation: '' }, toolLog: [] }, t.expectations)).length).toBeGreaterThan(0);
            for (const constant of [...c.files, ASSUMED, 'some other source', 'no source given']) {
                reply = sourcing(() => constant);
                expect([constant, (await evaluate(response(all), t.expectations)).length > 0]).toEqual([constant, true]);
            }
            reply = sourcing((l) => (l === second ? c.supported[0].source : l.source || ASSUMED));
            expect((await evaluate(response(all), t.expectations)).map((f) => f.type)).toEqual(['Assumption not marked']);
            reply = sourcing((l) => l.source || ASSUMED);
            expect((await evaluate(response(all.filter((l) => l !== second)), t.expectations)).map((f) => f.type)).toEqual(['Assumption not marked']);
            expect((await evaluate({ ...response(all), toolLog: [] }, t.expectations)).map((f) => f.type)).toEqual(['Documents not read']);
        });
    });
});
