/**
 * This is the causal sources test
 *
 * A causal loop diagram is only as trustworthy as the evidence for its links. An assistant should
 * be able to say, for each link it draws, which document it comes from — and to say plainly when a
 * link is its own assumption rather than inventing a source. This category uploads a small set of
 * documents about a bike-share scheme (a member survey, a marketing review, a planning note, and an
 * unrelated note on tyre prices) and asks for a diagram whose every link names its source or is
 * marked as an assumption.
 *
 * Grading, one generation:
 *   - one test per link the documents support: the diagram has it with the right polarity, and the
 *     agent cites the document that states it (a judge reads the citation from closed options)
 *   - one test for a link the diagram needs but no document states (sign-ups add to members): it is
 *     marked as an assumption or a definition, not given a source
 *   - no fabricated sources: every document the agent cites is one of the uploaded files
 *   - the agent read the documents: its tool log shows a search or a read
 *
 * The causalSourcesHard group adds a second unstated link by rule, grades every link in one test,
 * and withholds the guidance: its prompt asks only where each link comes from (hardPromptFor).
 *
 * @module categories/causalSources
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { extract } from '../utilities/judge.js';
import { cldLinksFromResponse } from '../utilities/causalGraph.js';
import { namesEqual } from '../utilities/nameMatching.js';
import { readUpload } from '../utilities/toolLog.js';
import { withFloors } from '../floors/statement.js';

import fs from 'fs';
import { splitHeldOut } from '../utilities/heldOut.js';
import { HARD_SECOND, secondUnsupported } from './causalSourcesData/hardLinks.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'causalSourcesData');

/**
 * The corpora: the bike-share one in causalSourcesData/corpus, and every folder under
 * causalSourcesData/corpora. Each folder holds its documents and a spec.json: the subject and the
 * question, the glossary, the files, the links the documents state (each with the file that states
 * it), one link the loops need that no document states, whether the corpus is held out, and the
 * plain words each glossary name goes by in the documents (checked by the unit tests).
 */
const loadCorpus = (dir) => ({ ...JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8')), dir });
const corporaDir = path.join(DATA, 'corpora');
export const CORPORA = Object.fromEntries([
    loadCorpus(path.join(DATA, 'corpus')),
    ...(fs.existsSync(corporaDir) ? fs.readdirSync(corporaDir).sort().filter((d) => fs.existsSync(path.join(corporaDir, d, 'spec.json'))).map((d) => loadCorpus(path.join(corporaDir, d))) : [])
].map((c) => [c.id, c]));

// The bike-share corpus, under the names the category has always exported.
export const FILES = CORPORA.bikeShare.files;
export const GLOSSARY = CORPORA.bikeShare.glossary;
export const SUPPORTED = CORPORA.bikeShare.supported;
export const UNSUPPORTED = CORPORA.bikeShare.unsupported;

export const description = () => {
    return `The causal sources test evaluates whether an agent can ground a causal loop diagram in uploaded documents: drawing the links the documents state, citing for each the document it comes from, marking the links no document supports as assumptions, and never inventing a source.`;
};

const promptFor = (c, glossary) => `I've uploaded our documents about ${c.subject}. Please draw a causal loop diagram of ${c.question}, using these names: ${glossary.join(', ')}. Give every link its polarity. For every link, tell me which of the uploaded documents it comes from, by file name — and if no document supports a link, say it is an assumption rather than giving it a source. You can put each link's source in the link's reasoning and list them in your answer.`;

const label = (l) => `${l.from} -> ${l.to}`;

/** The tests for one corpus; the bike-share corpus keeps its original test names. */
const testsFor = function(c) {
    const base = {
        prompt: promptFor(c, c.glossary),
        currentModel: { variables: [], relationships: [] },
        additionalParameters: { mode: 'cld', attachments: c.files.map((f) => ({ path: path.join(c.dir, f) })), problemStatement: c.problemStatement }
    };
    const pre = c.id === 'bikeShare' ? '' : `${c.title}: `;
    const shared = { corpus: c.id };
    return [
        ...c.supported.map((l) => ({ ...base, name: `${pre}draws "${label(l)}" and cites ${l.source}`, expectations: { ...shared, criterion: 'supported', link: l } })),
        { ...base, name: `${pre}marks "${label(c.unsupported)}" as an assumption`, expectations: { ...shared, criterion: 'unsupported', link: c.unsupported } },
        { ...base, name: `${pre}cites no source that does not exist`, expectations: { ...shared, criterion: 'noFabrication' } },
        { ...base, name: `${pre}reads the documents`, expectations: { ...shared, criterion: 'read' } }
    ];
};

/** The hard prompt's glossary: the corpus's, with the flow of the second unsupported link added. */
export const hardGlossary = (c) => [...c.glossary, HARD_SECOND[c.id].flow];

/**
 * The hard prompt withholds the guidance the other groups give: it does not say what to do with a
 * link no document supports (mark it as an assumption), nor how to name a source (by file name) or
 * where to put it (each link's reasoning). It asks only where each link comes from.
 */
export const hardPromptFor = (c, glossary) => `I've uploaded our documents about ${c.subject}. Please draw a causal loop diagram of ${c.question}, using these names: ${glossary.join(', ')}. Give every link its polarity, and for every link tell me where it comes from.`;

/**
 * The hard test for one corpus: every link it states, both unsupported links (the corpus's own and
 * the second one, by the rule in causalSourcesData/hardLinks.js), no fabricated source and the
 * documents read — all in one test.
 */
const hardTestFor = function(c) {
    return {
        prompt: hardPromptFor(c, hardGlossary(c)),
        currentModel: { variables: [], relationships: [] },
        additionalParameters: { mode: 'cld', attachments: c.files.map((f) => ({ path: path.join(c.dir, f) })), problemStatement: c.problemStatement },
        name: `${c.title}: (hard) every link drawn and sourced right, both assumptions marked, nothing invented, documents read`,
        expectations: { corpus: c.id, criterion: 'hard' }
    };
};

const rawGroups = {
    causalSources: Object.values(CORPORA).flatMap(testsFor),
    causalSourcesHard: Object.values(CORPORA).filter((c) => HARD_SECOND[c.id]).map(hardTestFor)
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => Boolean(CORPORA[t.expectations.corpus]?.heldOut));
const ASSUMPTION = 'marked as an assumption or a definition';
const NONE = 'no source given';
const OTHER = 'some other source';
const NOT_UPLOADED = 'a source that was not uploaded';

const readingSchemaFor = (files, example) => z.object({
    links: z.array(z.object({
        number: z.number().int().positive(),
        source: z.enum([...files, ASSUMPTION, OTHER, NONE]).describe(`What the answer gives as this link's source: one of the uploaded files, '${ASSUMPTION}' if it says the link is its own assumption or true by definition (even if it also points to a document for context), '${OTHER}' if it cites anything else, '${NONE}' if it gives nothing for this link.`)
    })),
    citedSources: z.array(z.enum([...files, NOT_UPLOADED])).describe(`Every specific document, report, study or file the answer cites anywhere as a source, each as the uploaded file it refers to (by file name or by its title, ${example}), or '${NOT_UPLOADED}' for a specific source that is none of them. Leave out general references to "the documents" or "the uploads".`)
});

/** The text the judge reads: each diagram link with its own note, then the answer. */
const readable = function(response) {
    const rels = (response?.model?.relationships || []).map((r) => `${r.from} -> ${r.to} (${r.polarity})${r.reasoning ? `: ${r.reasoning}` : ''}`);
    const text = response?.supportingInfo?.explanation || response?.output?.textContent || '';
    return `Diagram links:\n${rels.join('\n')}\n\nAnswer:\n${text}`;
};

/**
 * Evaluates one criterion.
 * @param {Object} generatedResponse The engine's response: model, text and tool log
 * @param {Object} expectations The criterion
 * @returns {Promise<Array<Object>>} Failures
 */
export const evaluate = async function(generatedResponse, expectations) {
    const failures = [];
    if (expectations.criterion === 'read') {
        if (!readUpload(generatedResponse?.toolLog)) failures.push({ type: 'Documents not read', details: 'The tool log shows no search of the uploaded documents and no file read.' });
        return validateEvaluationResult(failures);
    }
    const links = cldLinksFromResponse(generatedResponse);
    if (!links.length) return validateEvaluationResult([{ type: 'No diagram produced', details: `The engine returned no causal links.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    const c = CORPORA[expectations.corpus ?? 'bikeShare'];
    const hard = expectations.criterion === 'hard';
    const unsupported = hard ? [c.unsupported, secondUnsupported(c)] : [c.unsupported];
    const asked = [...c.supported, ...unsupported];
    let reading;
    try {
        reading = await extract(`causalSources|${hard ? 'hard|' : ''}${c.id === 'bikeShare' && !hard ? '' : `${c.id}|`}${readable(generatedResponse)}`, [
            { role: 'system', content: 'You read a causal loop diagram and the answer that came with it, and report the source the answer gives for each listed link, and every source it cites. Report only what the answer says.' },
            { role: 'user', content: `Uploaded files: ${c.files.join(', ')}\n\nLinks:\n${asked.map((l, i) => `${i + 1}. ${label(l)}`).join('\n')}\n\n"""\n${readable(generatedResponse)}\n"""` }
        ], readingSchemaFor(c.files, c.id === 'bikeShare' ? 'e.g. "the member survey" is member_survey_2025.md' : 'e.g. a document called by its title rather than its file name'));
    } catch (error) {
        return validateEvaluationResult([{ type: 'Evaluation error', details: `Error reading the answer: ${error.message}` }]);
    }
    const sourceOf = (l) => (reading.links || []).find((x) => x.number === asked.indexOf(l) + 1)?.source ?? NONE;
    const drawn = (l) => links.find((x) => namesEqual(x.from, l.from) && namesEqual(x.to, l.to));
    const markedAsAssumption = function(l) {
        const out = [];
        if (drawn(l) && sourceOf(l) !== ASSUMPTION) out.push({ type: 'Assumption not marked', details: `No document states "${label(l)}", but the answer gives it as ${sourceOf(l)} instead of marking it as an assumption.` });
        if (drawn(l) && drawn(l).polarity !== l.polarity) out.push({ type: 'Assumption not marked', details: `The diagram has "${label(l)}" with polarity ${drawn(l).polarity}; the loops need ${l.polarity}.` });
        if (!drawn(l)) out.push({ type: 'Assumption not marked', details: `The diagram leaves out "${label(l)}", which its loops need; it should be drawn and marked as an assumption.` });
        return out;
    };
    switch (expectations.criterion) {
        case 'hard': {
            // Every link of the corpus at once: each stated link drawn with its polarity and its
            // document; both unsupported links drawn, with their polarity, as assumptions; no
            // invented source; the documents read.
            for (const l of c.supported) {
                const d = drawn(l);
                if (!d) failures.push({ type: 'Supported link missing', details: `The documents state "${label(l)}" (${l.source}), but the diagram does not have it.` });
                else if (d.polarity !== l.polarity) failures.push({ type: 'Supported link missing', details: `The diagram has "${label(l)}" with polarity ${d.polarity}; ${l.source} says ${l.polarity}.` });
                if (sourceOf(l) !== l.source) failures.push({ type: 'Wrong source', details: `"${label(l)}" comes from ${l.source}; the answer gives ${sourceOf(l)}.` });
            }
            for (const l of unsupported) failures.push(...markedAsAssumption(l));
            const fake = (reading.citedSources || []).filter((x) => x === NOT_UPLOADED).length + asked.filter((l) => sourceOf(l) === OTHER).length;
            if (fake) failures.push({ type: 'Source fabricated', details: `The answer cites ${fake} source${fake > 1 ? 's' : ''} that ${fake > 1 ? 'are' : 'is'} not among the uploaded documents.` });
            if (!readUpload(generatedResponse?.toolLog)) failures.push({ type: 'Documents not read', details: 'The tool log shows no search of the uploaded documents and no file read.' });
            break;
        }
        case 'supported': {
            const l = c.supported.find((x) => x.from === expectations.link.from && x.to === expectations.link.to);
            const d = drawn(l);
            if (!d) failures.push({ type: 'Supported link missing', details: `The documents state "${label(l)}" (${l.source}), but the diagram does not have it.` });
            else if (d.polarity !== l.polarity) failures.push({ type: 'Supported link missing', details: `The diagram has "${label(l)}" with polarity ${d.polarity}; ${l.source} says ${l.polarity}.` });
            const s = sourceOf(l);
            if (s !== l.source) failures.push({ type: 'Wrong source', details: `"${label(l)}" comes from ${l.source}; the answer gives ${s}.` });
            break;
        }
        case 'unsupported': {
            const l = c.unsupported;
            if (drawn(l) && sourceOf(l) !== ASSUMPTION) failures.push({ type: 'Assumption not marked', details: `No document states "${label(l)}", but the answer gives it as ${sourceOf(l)} instead of marking it as an assumption.` });
            if (drawn(l) && drawn(l).polarity !== l.polarity) failures.push({ type: 'Assumption not marked', details: `The diagram has "${label(l)}" with polarity ${drawn(l).polarity}; the loops need ${l.polarity}.` });
            if (!drawn(l)) failures.push({ type: 'Assumption not marked', details: `The diagram leaves out "${label(l)}", which its loops need; it should be drawn and marked as an assumption.` });
            break;
        }
        case 'noFabrication': {
            const fake = (reading.citedSources || []).filter((c) => c === NOT_UPLOADED).length + asked.filter((l) => sourceOf(l) === OTHER).length;
            if (fake) failures.push({ type: 'Source fabricated', details: `The answer cites ${fake} source${fake > 1 ? 's' : ''} that ${fake > 1 ? 'are' : 'is'} not among the uploaded documents.` });
            break;
        }
        default:
            throw new Error(`Unknown criterion ${expectations.criterion}`);
    }
    return validateEvaluationResult(failures);
};

export const methodology = () => withFloors('causalSources', {
    howItWorks: [
        `Each corpus is a small set of documents about one organization, uploaded through the same document tools a user's uploads go through, with a glossary of quantity names; the agent is asked for a causal loop diagram whose every link names the document it comes from, or is marked as an assumption. The first corpus is about a bike-share scheme (a member survey, a marketing review, a city planning note, and an unrelated note on tyre prices); the others, each in its own folder with a spec of what it states, are held out unless marked otherwise: ${Object.values(CORPORA).filter((c) => c.heldOut).map((c) => c.title).join(', ') || 'none yet'}.`,
        `Each link a document states is a test: the diagram must have it with the stated polarity, and the answer — read by a fixed judge model from closed options, the diagram's link notes included — must give that document as its source. A link the loops need but no document states must be marked as an assumption or a definition. Every source the answer cites must be one of the uploaded files, and the tool log must show the documents were searched or read. The unit tests check each corpus: every supported link's document names both its quantities in plain words, the unrelated document names none of them, and no document states the unsupported link.`,
        `Hard group (causalSourcesHard): every corpus (one dev, the rest held out) again, with a second link no document states added by a general rule — the other flow of the stock its unsupported link reaches (members leaving, new volunteers, jobs completed), which joins the glossary and which no document mentions (checked by the unit tests) — and one test per corpus that needs every stated link drawn with its polarity and its document, both unstated links drawn and marked as assumptions, no invented source and the documents read, all at once. The hard prompt withholds the guidance the other groups give — it asks only where each link comes from, never saying that a link no document supports should be called an assumption, nor to cite by file name or in the link's notes — so marking the unstated links, and sourcing the rest, is left to the agent.`
    ],
    criteria: [
        { name: 'Supported link missing', description: 'A link the documents state is missing from the diagram, or has the wrong polarity.' },
        { name: 'Wrong source', description: 'A link the documents state is credited to the wrong document, to no document, or to an assumption.' },
        { name: 'Assumption not marked', description: 'A link no document states is given a source instead of being marked as an assumption, is left out, or is drawn with the wrong polarity.' },
        { name: 'Source fabricated', description: 'The answer cites a document that was not uploaded.' },
        { name: 'Documents not read', description: 'The tool log shows no search or read of the uploaded documents.' },
        { name: 'No diagram produced', description: 'The engine returned no causal links.' },
        { name: 'Evaluation error', description: 'The judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `One test per stated link, plus the assumption, fabrication and reading tests, for each corpus; each corpus is one session. The hard group has one test per corpus, every link graded together, from a session of its own.`
});
