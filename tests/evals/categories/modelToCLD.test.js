import fs from 'fs';
import path from 'path';
import { evaluate, groups, methodology, hardSuccinctLimit, SUCCINCT_SHARE } from '../../../evals/categories/modelToCLD.js';
import { buildAll, GIBBERISH_CLDS, HARD_CLDS } from '../../../evals/categories/modelToCLDData/buildClds.js';
import { sourceGraph, findCycles, pathPolarities, foldVariable } from '../../../evals/utilities/causalGraph.js';
import { cldToXmile } from '../../../evals/utilities/cldXmile.js';

const DATA = path.join(process.cwd(), 'evals/categories/modelToCLDData');
const readFixture = (key) => JSON.parse(fs.readFileSync(path.join(DATA, `${key}.json`), 'utf8'));

const allTests = Object.values(groups).flat();
const testsFor = (prefix) => allTests.filter((t) => t.name.startsWith(prefix));
const byCriterion = (tests, criterion) => tests.filter((t) => t.expectations.criterion === criterion);

const asResponse = (links, toolLog) => ({ model: { variables: [], relationships: links }, toolLog: toolLog ?? [] });

/** A perfect summary of a CLD fixture: each designed loop collapsed onto its core variables. */
const collapsedLoops = function(fixture) {
    const sign = (a, b) => (a === b ? '+' : '-');
    const links = [];
    for (const loop of fixture.loops) {
        const cycle = [...loop.nodes, loop.nodes[0]];
        const edge = (from, to) => fixture.model.relationships.find((r) => r.from === from && r.to === to).polarity;
        for (let c = 0; c < loop.core.length; c++) {
            const from = loop.core[c];
            const to = loop.core[(c + 1) % loop.core.length];
            let i = cycle.indexOf(from);
            let polarity = '+';
            do { polarity = sign(polarity, edge(cycle[i], cycle[i + 1])); i++; } while (cycle[i] !== to);
            if (!links.some((l) => l.from === from && l.to === to)) links.push({ from, to, polarity });
        }
    }
    return links;
};

const run = async (tests, response) => {
    const results = [];
    for (const t of tests) results.push({ name: t.name, criterion: t.expectations.criterion, failures: await evaluate(response, t.expectations) });
    return results;
};

describe('modelToCLD category', () => {
    test('committed CLD fixtures match the generator, and their loops are exactly the designed ones', () => {
        for (const [key, cld] of Object.entries(buildAll())) {
            const fixture = readFixture(key);
            expect(fixture.model.relationships).toEqual(cld.relationships);
            expect(fs.readFileSync(path.join(DATA, `${key}.stmx`), 'utf8')).toBe(cldToXmile(fixture.model, cld.title));
            const found = findCycles(sourceGraph(fixture.model, null), 1000);
            expect(found.length).toBeGreaterThanOrEqual(cld.loops.length);
            if (GIBBERISH_CLDS.includes(key)) expect(found.length).toBe(cld.loops.length);
        }
    });

    test('uploaded CLD files carry every link with its polarity', () => {
        const fixture = readFixture('gibberishSmall');
        const xml = fs.readFileSync(path.join(DATA, 'gibberishSmall.stmx'), 'utf8');
        expect((xml.match(/<connector /g) || []).length).toBe(fixture.model.relationships.length);
        for (const rel of fixture.model.relationships) {
            expect(xml).toContain(`polarity="${rel.polarity}">\n\t\t\t\t\t<from>${rel.from.replace(/ /g, '_')}</from>\n\t\t\t\t\t<to>${rel.to.replace(/ /g, '_')}</to>`);
        }
    });

    test('sibling tests of one source share a generation, and uploads attach a file that exists', () => {
        for (const prefix of ['armsRace (uploaded model)', 'gibberishLarge (uploaded CLD)', 'maibab (current model)']) {
            const tests = testsFor(prefix);
            expect(tests.length).toBeGreaterThan(2);
            const keys = new Set(tests.map((t) => JSON.stringify([t.prompt, t.currentModel, t.additionalParameters])));
            expect(keys.size).toBe(1);
            for (const a of tests[0].additionalParameters.attachments || []) expect(fs.existsSync(a.path)).toBe(true);
        }
    });

    test('every failure type is documented', () => {
        const documented = methodology().criteria.map((c) => c.name);
        expect(documented).toEqual(expect.arrayContaining(['Key loop missing', 'Link not faithful to source', 'CLD not succinct', 'Uploaded file not read', 'No causal loop diagram produced']));
    });

    describe.each(['gibberishSmall', 'gibberishMedium', 'gibberishLarge', 'softwareRework', 'trafficCongestion'])('CLD source %s', (key) => {
        const fixture = readFixture(key);
        const tests = testsFor(`${key} (uploaded CLD)`);

        test('a perfect summary that read the file passes every test', async () => {
            const results = await run(tests, asResponse(collapsedLoops(fixture), [{ toolName: 'mcp__sd-ai__read_file', arguments: { file_path: '/tmp/session/rag/eval-file-1/extracted.txt' } }]));
            expect(results.filter((r) => r.failures.length)).toEqual([]);
        });

        test('the source copied unchanged keeps every loop and link but is not succinct', async () => {
            const results = await run(tests, asResponse(fixture.model.relationships, [{ toolName: 'search_documents' }]));
            const failed = results.filter((r) => r.failures.length).map((r) => r.criterion);
            expect(failed).toEqual(['succinct']);
        });

        test('one wrong polarity per loop fails every loop test and the link test', async () => {
            // Flipping one link on each loop flips each loop's polarity (flipping every link would
            // leave even-length loops unchanged, which the grader rightly accepts).
            const toFlip = new Set(fixture.loops.map((l) => `${l.core[0]}->${l.core[1]}`));
            const flipped = collapsedLoops(fixture).map((l) => toFlip.has(`${l.from}->${l.to}`) ? { ...l, polarity: l.polarity === '+' ? '-' : '+' } : l);
            const results = await run(byCriterion(tests, 'links'), asResponse(flipped, []));
            expect(results[0].failures.map((f) => f.type)).toContain('Link not faithful to source');
            const loopResults = await run(byCriterion(tests, 'loop'), asResponse(flipped, []));
            expect(loopResults.filter((r) => r.failures.length).length).toBeGreaterThan(0);
        });

        // Only the gibberish flowers: there each loop's first two variables belong to that loop alone.
        // In the real-domain diagrams loops share their opening link, so this fake would draw one
        // link with two contradictory polarities — a bad summary, which the grader rightly fails.
        const testIfSeparateLoops = GIBBERISH_CLDS.includes(key) ? test : test.skip;
        testIfSeparateLoops('keeping different variables of a loop than the designed core still counts', async () => {
            // Collapse each loop onto its first core variable and the variable just after it on the
            // loop, instead of onto the designed core: a different, equally faithful summary.
            const links = [];
            for (const loop of fixture.loops) {
                const cycle = [...loop.nodes, loop.nodes[0]];
                const edge = (from, to) => fixture.model.relationships.find((r) => r.from === from && r.to === to).polarity;
                const keep = [cycle[0], cycle[1]];
                links.push({ from: keep[0], to: keep[1], polarity: edge(keep[0], keep[1]) });
                let polarity = '+';
                for (let i = 1; i < cycle.length - 1; i++) polarity = polarity === edge(cycle[i], cycle[i + 1]) ? '+' : '-';
                links.push({ from: keep[1], to: keep[0], polarity });
            }
            const results = await run(byCriterion(tests, 'loop'), asResponse(links, []));
            expect(results.filter((r) => r.failures.length)).toEqual([]);
        });

        test('reading some other file does not count as reading the upload', async () => {
            const results = await run(byCriterion(tests, 'readFile'), asResponse(collapsedLoops(fixture), [{ toolName: 'Read', arguments: { file_path: '/tmp/session/model.sdjson' } }]));
            expect(results[0].failures.map((f) => f.type)).toEqual(['Uploaded file not read']);
        });

        test('a CLD that never touched the file fails the read test', async () => {
            const results = await run(byCriterion(tests, 'readFile'), asResponse(collapsedLoops(fixture), []));
            expect(results[0].failures.map((f) => f.type)).toEqual(['Uploaded file not read']);
        });
    });

    test('a loop made of invented links does not stand for a key loop', async () => {
        // Two 2-cycles through the source loops' variables, neither a causal summary of the source.
        const invented = [
            { from: 'producing', to: 'Workers', polarity: '+' }, { from: 'Workers', to: 'producing', polarity: '-' },
            { from: 'hiring or firing', to: 'workers gap', polarity: '+' }, { from: 'workers gap', to: 'hiring or firing', polarity: '-' }
        ];
        const tests = testsFor('inventoryWorkforce (current model)');
        const results = await run(byCriterion(tests, 'loop'), asResponse(invented, []));
        expect(results.length).toBeGreaterThan(0);
        for (const r of results) expect([r.name, r.failures.map((f) => f.type)]).toEqual([r.name, ['Key loop missing']]);
    });

    describe.each(['armsRace', 'bassDiffusion', 'inventoryWorkforce', 'predatorPrey', 'maibab', 'marketGrowth'])('stock-and-flow source %s', (key) => {
        const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'evals/categories/feedbackExplanationData', `${key}.json`), 'utf8'));
        const loopLinks = [];
        for (const loop of fixture.feedback.feedbackLoops) {
            for (const l of loop.links) if (!loopLinks.some((x) => x.from === l.from && x.to === l.to)) loopLinks.push(l);
        }
        const tests = testsFor(`${key} (current model)`);

        test('the analysed loops drawn link for link keep every key loop with faithful links', async () => {
            const results = await run([...byCriterion(tests, 'loop'), ...byCriterion(tests, 'links')], asResponse(loopLinks, []));
            expect(results.filter((r) => r.failures.length)).toEqual([]);
        });

        test('a link between real variables with no causal path behind it is caught', async () => {
            // Find a pair of model variables with no path between them in the source at all.
            const src = sourceGraph(fixture.model, fixture.feedback.feedbackLoops);
            const names = fixture.model.variables.map((v) => v.name);
            let pair = null;
            for (const a of names) {
                for (const b of names) {
                    if (!pair && a !== b && pathPolarities(src, foldVariable(a), foldVariable(b), new Set()).size === 0) pair = [a, b];
                }
            }
            expect(pair).not.toBeNull();
            const results = await run(byCriterion(tests, 'links'), asResponse([...loopLinks, { from: pair[0], to: pair[1], polarity: '+' }], []));
            const details = results[0].failures.map((f) => f.details).join(' ');
            expect(details).toContain(`"${src.names.get(foldVariable(pair[0]))}" to "${src.names.get(foldVariable(pair[1]))}"`);
        });

        test('a variable the source does not have is caught', async () => {
            const results = await run(byCriterion(tests, 'links'), asResponse([...loopLinks, { from: 'made up thing', to: fixture.model.variables[0].name, polarity: '-' }], []));
            expect(results[0].failures.map((f) => f.details).join(' ')).toContain('"made up thing" is not a variable in the source');
        });

        test('no model at all is reported on every test, not thrown', async () => {
            const results = await run(tests, { err: 'boom' });
            expect(results.every((r) => r.failures.map((f) => f.type).join() === 'No causal loop diagram produced')).toBe(true);
        });
    });

    describe('hard group: bigger diagrams, no method named, every criterion in one test', () => {
        const hard = [...(groups.uploadedCLDHard || []), ...(groups.uploadedCLDHardHeldOut || [])];
        const READ = [{ toolName: 'mcp__sd-ai__read_file', arguments: { file_path: '/tmp/session/rag/eval-file-1/extracted.txt' } }];

        test('one test per hard diagram, dev and held out by the key convention; every hard diagram is bigger than any other diagram', () => {
            expect(hard.map((t) => t.expectations.fileName.replace('.stmx', ''))).toEqual(HARD_CLDS);
            expect(groups.uploadedCLDHard.length).toBeGreaterThan(0);
            expect(groups.uploadedCLDHardHeldOut.map((t) => t.expectations.fileName.replace('.stmx', ''))).toEqual(HARD_CLDS.filter((k) => k.startsWith('heldout')));
            const loopsOf = (k) => readFixture(k).loops.length;
            const biggestOther = Math.max(...GIBBERISH_CLDS.map(loopsOf));
            for (const k of HARD_CLDS) expect([k, loopsOf(k) > biggestOther]).toEqual([k, true]);
            for (const t of hard) {
                expect(fs.existsSync(t.additionalParameters.attachments[0].path)).toBe(true);
                expect(t.prompt.replace(/causal loop diagram/g, '')).not.toMatch(/loop|feedback|polarit|chain|collapse|succinct/i);
            }
        });

        test('the hard flowers\' loops are exactly the designed ones, of both polarities', () => {
            for (const k of HARD_CLDS) {
                const fixture = readFixture(k);
                expect(findCycles(sourceGraph(fixture.model, null), 1000).length).toBe(fixture.loops.length);
                expect(new Set(fixture.loops.map((l) => l.polarity)).size).toBe(2);
            }
        });

        describe.each(HARD_CLDS)('%s', (key) => {
            const fixture = readFixture(key);
            const t = hard.find((x) => x.expectations.fileName === `${key}.stmx`);
            const grade = (response) => evaluate(response, t.expectations).map((f) => f.type);

            test('the reference summary (each loop collapsed onto its core), read from the file, passes', () => {
                expect(grade(asResponse(collapsedLoops(fixture), READ))).toEqual([]);
            });

            test('doing nothing, copying the file, one loop flipped, one loop dropped, or not reading the file fails', () => {
                expect(grade({ model: { variables: [], relationships: [] } })).toEqual(['No causal loop diagram produced']);
                expect(grade(asResponse(fixture.model.relationships, READ))).toEqual(['CLD not succinct']);
                const reference = collapsedLoops(fixture);
                const first = fixture.loops[0];
                const flipped = reference.map((l) => (l.from === first.core[0] && l.to === first.core[1] ? { ...l, polarity: l.polarity === '+' ? '-' : '+' } : l));
                expect(grade(asResponse(flipped, READ))).toEqual(expect.arrayContaining(['Key loop missing', 'Link not faithful to source']));
                const last = fixture.loops.at(-1);
                const dropped = reference.filter((l) => !(l.from === last.core.at(-1) && l.to === last.core[0]));
                expect(grade(asResponse(dropped, READ))).toEqual(['Key loop missing']);
                expect(grade(asResponse(reference, []))).toEqual(['Uploaded file not read']);
            });

            test('succinct is held to the tighter hard limit: the loops\' core variables plus a little room, under the share the other groups allow', () => {
                const limit = hardSuccinctLimit(fixture);
                const cores = new Set(fixture.loops.flatMap((l) => l.core));
                expect(t.expectations.succinctLimit).toBe(limit);
                expect(limit).toBe(cores.size + Math.max(2, Math.ceil(0.2 * cores.size)));
                expect(limit).toBeLessThan(Math.ceil(SUCCINCT_SHARE * fixture.model.variables.length));
                const reference = collapsedLoops(fixture);
                expect(new Set(reference.flatMap((l) => [l.from, l.to])).size).toBe(cores.size);
                // A faithful extra the room allows: an input the file has that feeds a loop variable directly.
                const input = fixture.model.relationships.find((r) => cores.has(r.to) && !fixture.loops.some((l) => l.nodes.includes(r.from)));
                if (input) expect(grade(asResponse([...reference, input], READ))).toEqual([]);
                // Keeping one chain variable of every loop uncollapsed is more than the room allows.
                let unrolled = [...reference];
                for (const loop of fixture.loops) {
                    const chainVar = loop.nodes[1];
                    if (cores.has(chainVar)) continue;
                    const ref = unrolled.find((l) => l.from === loop.core[0] && l.to === loop.core[1]);
                    const edge = fixture.model.relationships.find((r) => r.from === loop.core[0] && r.to === chainVar);
                    if (!ref || !edge) continue;
                    unrolled = [...unrolled.filter((l) => l !== ref), { from: loop.core[0], to: chainVar, polarity: edge.polarity }, { from: chainVar, to: loop.core[1], polarity: edge.polarity === ref.polarity ? '+' : '-' }];
                }
                expect(new Set(unrolled.flatMap((l) => [l.from, l.to])).size).toBeGreaterThan(limit);
                expect(grade(asResponse(unrolled, READ))).toEqual(['CLD not succinct']);
            });

            test('a constant answer — every link of the diagram drawn with one polarity — fails', () => {
                for (const polarity of ['+', '-']) {
                    const constant = collapsedLoops(fixture).map((l) => ({ ...l, polarity }));
                    expect([polarity, grade(asResponse(constant, READ)).length > 0]).toEqual([polarity, true]);
                }
            });
        });
    });
});
