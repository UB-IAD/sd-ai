/**
 * This is the stocks and leverage test
 *
 * Two things a modeler needs from an agent before a causal loop diagram is useful for policy:
 * knowing which quantities accumulate (a waiting list, a membership, an inventory — the things
 * that carry the past into the future) and knowing where a change would make the biggest
 * difference. Both are graded against the hidden scenarios of the conversation evals.
 *
 *   - stocksInCLD: the agent hears what a manager has seen, draws a causal loop diagram in the
 *     scenario's own names and says which quantities are accumulations. One test per quantity that
 *     is a stock in the hidden model: it is in the diagram and called an accumulation. One test per
 *     scenario: no rate or plain quantity is called an accumulation, so calling everything a stock
 *     does not pass.
 *   - leverage: the agent gets the working model, a run_scenario tool for what-if runs and the
 *     goal its behavior misses, and is asked where the high-leverage points are and which way to
 *     push each. The answer is read against the scenario's policies, whose effect on the goal comes
 *     from the hidden simulation: a change that meets the goal must be named as high leverage, and
 *     the change a novice wrongly expects to work must not be.
 *
 * @module categories/cldStocksAndLeverage
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { extract } from '../utilities/judge.js';
import { cldLinksFromResponse } from '../utilities/causalGraph.js';
import { namesEqual } from '../utilities/nameMatching.js';
import { glossaryModel } from '../utilities/scenarios/renameModel.js';
import { scenarios } from '../utilities/scenarios/library.js';
import { withFloors } from '../floors/statement.js';
import { splitHeldOut, isHeldOutScenario } from '../utilities/heldOut.js';
import { LEVER_MARGIN, balancedOrder } from './cldStocksAndLeverageData/leverKey.js';

export const description = () => {
    return `The stocks and leverage test evaluates two things an agent needs before a causal diagram is useful for policy: whether it recognizes which quantities accumulate over time and keeps them in its causal loop diagram, and whether, given a working model and a goal, it identifies the changes that would make the biggest difference and avoids the one a novice would wrongly expect to work. Both are graded against hidden simulations.`;
};

/**
 * Quantities whose status as an accumulation is a matter of modeling judgment, so neither answer is
 * graded: an expectation that adjusts gradually is a stock in the hidden model, but calling it a
 * plain belief is not wrong; "orders" is a rate in the hidden model but reads just as well as the
 * backlog of orders outstanding.
 */
export const UNGRADED_STOCKS = { distributor: ['expected demand', 'orders'] };

/**
 * The scenario's glossary names, split by what they are in the hidden model.
 * @param {string} id A scenario id
 * @returns {{stocks: string[], others: string[]}}
 */
export const stockKey = function(id) {
    const s = scenarios[id];
    const stockNames = new Set(s.model.variables.filter((v) => v.type === 'stock').map((v) => v.name));
    const ungraded = new Set(UNGRADED_STOCKS[id] || []);
    const graded = s.glossary.filter((g) => !ungraded.has(g));
    const isStock = (g) => stockNames.has(s.glossaryToModel[g]);
    return { stocks: graded.filter(isStock), others: graded.filter((g) => !isStock(g)) };
};

/**
 * What the organization could realistically do, told to the agent, so that whether a change is high
 * leverage has one answer: given unlimited money, ten times the advertising does meet the goal, and
 * a leverage verdict that turns on a magnitude nobody could afford would grade the agent on a guess.
 */
export const REALISTIC = Object.fromEntries(Object.entries(scenarios).filter(([, s]) => s.realistic).map(([id, s]) => [id, s.realistic.text]));

/**
 * For each scenario, the changes the leverage answer is read against: every one of its single
 * policies (not combinations), in the scenario's own words, which name the change and its size.
 * Nothing here is written per scenario — a new scenario brings its policies, and its realistic
 * limits, with it. `range` holds the policy's own overrides and, for a lever with a realistic limit
 * in the direction the policy pushes, that limit too; the unit tests check the policy's verdict holds
 * at every point (a change that does not work does not start working at the limit).
 */
const toGlossaryName = (s, name) => Object.entries(s.glossaryToModel).find(([, m]) => m === name)?.[0] ?? name;
const rangeFor = function(s, policy) {
    const points = [policy.overrides];
    const entries = Object.entries(policy.overrides);
    if (entries.length === 1 && !policy.effective) {
        const [name, value] = entries[0];
        const b = s.realistic?.bounds?.[toGlossaryName(s, name)];
        const base = Number(s.model.variables.find((v) => v.name === name)?.equation);
        if (b && Number.isFinite(base)) {
            const limit = Number(value) > base ? b.max : b.min;
            if (limit !== undefined && limit !== Number(value)) points.push({ [name]: String(limit) });
        }
    }
    return points;
};
export const LEVERAGE_CANDIDATES = Object.fromEntries(Object.entries(scenarios)
    .filter(([, s]) => s.policies && s.misconception && s.realistic)
    .map(([id, s]) => [id, s.policies.filter((p) => !p.parts).map((p) => ({ policy: p.id, text: p.text.replace(/\.$/, ''), range: rangeFor(s, p) }))]));

const leverageIds = Object.keys(LEVERAGE_CANDIDATES);
const stockIds = Object.keys(scenarios);

const policyOf = (id, candidate) => scenarios[id].policies.find((p) => p.id === candidate.policy);

const stocksPrompt = (s) => `${s.narrative}\n\nPlease draw a causal loop diagram of what is going on, using these names for the quantities: ${s.glossary.join(', ')}. Then, for each of those quantities, tell me whether it is an accumulation — something that builds up or drains away over time — or not.`;

const leveragePrompt = (s) => `Here is my model of the ${s.title.toLowerCase()}. Our goal is to ${s.goal.label}, and as things stand we miss it. Using the model — you can try changes with the run_scenario tool — tell me where the high-leverage points are: the changes we could make that would do the most to meet the goal, and which way to push each. Also tell me which of the obvious levers would not help much. ${REALISTIC[s.id]} Please don't change the model itself.`;

const generateStockTests = function(id) {
    const s = scenarios[id];
    const base = { prompt: stocksPrompt(s), currentModel: { variables: [], relationships: [] }, additionalParameters: { mode: 'cld', problemStatement: s.opening } };
    const { stocks } = stockKey(id);
    return [
        ...stocks.map((stock) => ({ ...base, name: `${s.title}: "${stock}" is in the diagram as an accumulation`, expectations: { scenario: id, criterion: 'stock', quantity: stock } })),
        { ...base, name: `${s.title}: no rate or plain quantity is called an accumulation`, expectations: { scenario: id, criterion: 'notStocks' } }
    ];
};

/**
 * The hard leverage group's scenarios, by rule: those whose single policies split roughly evenly
 * between changes that meet the goal and changes that do not (a third to two thirds effective), so
 * a constant verdict on every change gets about half of them wrong.
 */
export const HARD_SHARE = [1 / 3, 2 / 3];
export const hardLeverageIds = leverageIds.filter((id) => {
    const share = LEVERAGE_CANDIDATES[id].filter((c) => policyOf(id, c).effective).length / LEVERAGE_CANDIDATES[id].length;
    return share >= HARD_SHARE[0] - 1e-9 && share <= HARD_SHARE[1] + 1e-9;
});

/**
 * The hard prompt names no method and no kind of answer ("high leverage", "which would not help"):
 * the manager lists the changes on the table and asks whether any is worth making. The what-if
 * feedback is withheld too: the hard test offers no run_scenario tool (the leverage group does), so
 * every verdict has to come from the agent's own reading or running of the model.
 */
const hardLeveragePrompt = (s) => `Here is my model of the ${s.title.toLowerCase()}. We want to ${s.goal.label}. These are the changes we have been weighing:\n${LEVERAGE_CANDIDATES[s.id].map((c) => `- ${c.text}`).join('\n')}\n\nIs it worth making any of them, and if so which? ${REALISTIC[s.id]} Please don't change the model itself.`;

const generateHardLeverageTests = function(id) {
    const s = scenarios[id];
    return [{
        prompt: hardLeveragePrompt(s),
        currentModel: glossaryModel(s),
        additionalParameters: { mode: 'sfd', problemStatement: `I want to ${s.goal.label}.` },
        name: `${s.title}: (hard) every change on the table judged right — those that meet the goal recommended, the rest not`,
        expectations: { scenario: id, criterion: 'everyChangeJudged' }
    }];
};

const generateLeverageTests = function(id) {
    const s = scenarios[id];
    const base = { prompt: leveragePrompt(s), currentModel: glossaryModel(s), additionalParameters: { mode: 'sfd', analysisTools: true, problemStatement: `I want to ${s.goal.label}.` } };
    const misconception = LEVERAGE_CANDIDATES[id].find((c) => c.policy === s.misconception);
    return [
        { ...base, name: `${s.title}: names a change that meets the goal as high leverage`, expectations: { scenario: id, criterion: 'effectiveNamed' } },
        { ...base, name: `${s.title}: does not call "${misconception.policy}" high leverage`, expectations: { scenario: id, criterion: 'misconceptionAvoided' } }
    ];
};

/**
 * The second hard leverage group (leverageHard2), held out only: for every held-out scenario the
 * rule in cldStocksAndLeverageData/leverKey.js takes, the agent gets no list of changes — only the
 * levers management controls and how far each could realistically go — and must say, for every
 * one, whether moving it on its own would meet the goal and which way. Frozen in leverKeys.json
 * (the unit tests re-derive it).
 */
export const LEVER_KEYS = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'cldStocksAndLeverageData', 'leverKeys.json'), 'utf8'));
export const hard2Ids = Object.keys(LEVER_KEYS).filter((id) => scenarios[id] && isHeldOutScenario(id) && LEVER_KEYS[id].taken);
/** Each scenario's levers in the order they are listed and read (leverKey.js, balancedOrder). */
export const LEVER_ORDER = balancedOrder(LEVER_KEYS, hard2Ids);

const limitText = (l) => (l.min !== undefined && l.max !== undefined ? `anywhere from ${l.min} to ${l.max}` : l.max !== undefined ? `up to ${l.max}` : `down to ${l.min}`);

/** The second hard prompt: the levers and their limits, no changes, no method, no tool. */
const hard2Prompt = (s) => `Here is my model of the ${s.title.toLowerCase()}. We want to ${s.goal.label}. These are the things we control, and how far we could realistically take each:\n${LEVER_ORDER[s.id].map((l) => `- "${l.lever}", now ${l.current}: realistically ${limitText(l)}`).join('\n')}\n\nWhich of them, if any, would get us there on its own, and which way would we have to move it? Please don't change the model itself.`;

const generateHard2Tests = function(id) {
    const s = scenarios[id];
    return [{
        prompt: hard2Prompt(s),
        currentModel: glossaryModel(s),
        additionalParameters: { mode: 'sfd', problemStatement: `I want to ${s.goal.label}.` },
        name: `${s.title}: (hard, levers) every lever judged right — whether it meets the goal on its own within its limits, and which way`,
        expectations: { scenario: id, criterion: 'everyLeverJudged' }
    }];
};

const rawGroups = {
    stocksInCLD: stockIds.flatMap(generateStockTests),
    leverage: leverageIds.flatMap(generateLeverageTests),
    leverageHard: hardLeverageIds.flatMap(generateHardLeverageTests),
    leverageHard2: hard2Ids.flatMap(generateHard2Tests)
};


/** The groups, each split into its dev tests and its held-out ones (`<group>HeldOut`); see utilities/heldOut.js. */
export const groups = splitHeldOut(rawGroups, (t) => isHeldOutScenario(t.expectations.scenario));
const responseText = (r) => r?.supportingInfo?.explanation || r?.output?.textContent || '';

const stockSchemaFor = (names) => z.object(Object.fromEntries(names.map((n, i) => [
    `q${i + 1}`,
    z.enum(['accumulation', 'not an accumulation', 'not said']).describe(`"${n}": what the response says it is. 'accumulation' if it calls it a stock, level or accumulation, something that builds up or drains away; 'not an accumulation' if it calls it a rate, flow, or a quantity that does not accumulate; 'not said' if it says neither or both.`)
])));

export const ON_ITS_OWN = 'recommended as high leverage on its own';
export const ALONGSIDE = 'recommended only alongside other changes';

const leverageSchemaFor = (candidates) => z.object(Object.fromEntries(candidates.map((c, i) => [
    `q${i + 1}`,
    z.enum([ON_ITS_OWN, ALONGSIDE, 'said to help little or not at all', 'not discussed']).describe(`Change ${i + 1}: ${c.text}. '${ON_ITS_OWN}' only if the response recommends this change, in this direction, as one of the changes that would do the most for the goal by itself; 'recommended only alongside other changes' if it says the change helps mainly as a supplement or in combination, or would not be enough alone.`)
])));

/** How the response classifies each glossary name, from the diagram's variable types and the text. */
const readStocks = async function(id, response) {
    const s = scenarios[id];
    const text = responseText(response);
    let reading = {};
    if (text.trim()) {
        reading = await extract(`cldStocksAndLeverage|stocks|${id}|${text}`, [
            { role: 'system', content: 'You read a response about a causal loop diagram and report, for each listed quantity, whether the response says it is an accumulation. Report only what the response says.' },
            { role: 'user', content: `Quantities:\n${s.glossary.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n\nResponse:\n"""\n${text}\n"""` }
        ], stockSchemaFor(s.glossary));
    }
    const variables = response?.model?.variables || [];
    return Object.fromEntries(s.glossary.map((n, i) => {
        const typed = variables.find((v) => namesEqual(v.name, n))?.type;
        const said = reading[`q${i + 1}`] ?? 'not said';
        return [n, typed === 'stock' || said === 'accumulation'];
    }));
};

/**
 * Evaluates one criterion.
 * @param {Object} generatedResponse The engine's response
 * @param {Object} expectations The criterion
 * @returns {Promise<Array<Object>>} Failures
 */
export const evaluate = async function(generatedResponse, expectations) {
    // Calling no rate an accumulation counts only once some real stock is recognized, and avoiding
    // the misconception only once a change that works is named: saying nothing scores nothing.
    const own = await evaluateOne(generatedResponse, expectations);
    const { scenario, criterion } = expectations;
    let prerequisite = null;
    if (criterion === 'notStocks') {
        const stocks = stockKey(scenario).stocks;
        let any = false;
        for (const q of stocks) if (!(await evaluateOne(generatedResponse, { scenario, criterion: 'stock', quantity: q })).length) { any = true; break; }
        if (!any) prerequisite = { type: 'Stock not recognized', details: 'This test counts only once at least one real stock is in the diagram as an accumulation; none is.' };
    }
    if (criterion === 'misconceptionAvoided' && (await evaluateOne(generatedResponse, { scenario, criterion: 'effectiveNamed' })).length) {
        prerequisite = { type: 'High-leverage change missed', details: 'This test counts only once a change that meets the goal is recommended; none is.' };
    }
    return prerequisite ? validateEvaluationResult([...own, prerequisite]) : own;
};

const evaluateOne = async function(generatedResponse, expectations) {
    const id = expectations.scenario;
    const s = scenarios[id];
    const failures = [];
    if (expectations.criterion === 'stock' || expectations.criterion === 'notStocks') {
        const links = cldLinksFromResponse(generatedResponse);
        if (!links.length) return validateEvaluationResult([{ type: 'No diagram produced', details: `The engine returned no causal links.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
        let marked;
        try {
            marked = await readStocks(id, generatedResponse);
        } catch (error) {
            return validateEvaluationResult([{ type: 'Evaluation error', details: `Error reading the response: ${error.message}` }]);
        }
        if (expectations.criterion === 'stock') {
            const q = expectations.quantity;
            if (!links.some((l) => namesEqual(l.from, q) || namesEqual(l.to, q))) failures.push({ type: 'Stock missing from diagram', details: `"${q}" accumulates, but it is in none of the diagram's links.` });
            if (!marked[q]) failures.push({ type: 'Stock not recognized', details: `"${q}" accumulates, but the response does not say so.` });
        } else {
            const wrong = stockKey(id).others.filter((n) => marked[n]);
            if (wrong.length) failures.push({ type: 'Non-stock called an accumulation', details: `${wrong.map((n) => `"${n}"`).join(', ')} ${wrong.length > 1 ? 'do' : 'does'} not accumulate, but the response says ${wrong.length > 1 ? 'they do' : 'it does'}.` });
        }
        return validateEvaluationResult(failures);
    }
    const text = responseText(generatedResponse);
    if (!text.trim()) return validateEvaluationResult([{ type: 'No answer given', details: `The engine gave no explanation.${generatedResponse?.err ? ` Engine error: ${generatedResponse.err}` : ''}` }]);
    if (expectations.criterion === 'everyLeverJudged') return evaluateLevers(id, text);
    const candidates = LEVERAGE_CANDIDATES[id];
    let reading;
    try {
        reading = await extract(`cldStocksAndLeverage|leverage|${id}|${text}`, [
            { role: 'system', content: 'You read advice about a model and report, for each listed change, whether the advice recommends it as a high-leverage change by itself, recommends it only alongside other changes, says it would help little, or does not discuss it. Report only what the advice says; do not judge whether it is right.' },
            { role: 'user', content: `Goal: ${s.goal.label}\n\nChanges:\n${candidates.map((c, i) => `${i + 1}. ${c.text}`).join('\n')}\n\nAdvice:\n"""\n${text}\n"""` }
        ], leverageSchemaFor(candidates));
    } catch (error) {
        return validateEvaluationResult([{ type: 'Evaluation error', details: `Error reading the advice: ${error.message}` }]);
    }
    // A change that works counts when it is recommended on its own or as part of a package (the
    // package still contains it); the misconception fails only when it is offered as working on
    // its own, since a supplement to a change that works does no harm.
    const said = (c) => reading[`q${candidates.indexOf(c) + 1}`];
    const recommended = candidates.filter((c) => said(c) === ON_ITS_OWN);
    const recommendedAtAll = candidates.filter((c) => said(c) === ON_ITS_OWN || said(c) === ALONGSIDE);
    if (expectations.criterion === 'effectiveNamed') {
        if (!recommendedAtAll.some((c) => policyOf(id, c).effective)) {
            const effective = candidates.filter((c) => policyOf(id, c).effective).map((c) => `"${c.text}"`).join(' or ');
            failures.push({ type: 'High-leverage change missed', details: `None of the changes that meet the goal in simulation (${effective}) is recommended as high leverage.` });
        }
    } else if (expectations.criterion === 'misconceptionAvoided') {
        const misconception = candidates.find((c) => c.policy === s.misconception);
        if (recommended.includes(misconception)) failures.push({ type: 'Low-leverage change recommended', details: `"${misconception.text}" is recommended as high leverage on its own, but in simulation it does not meet the goal.` });
    } else if (expectations.criterion === 'everyChangeJudged') {
        // Every change on the table, together: one that meets the goal must be recommended on its
        // own (it does so by itself); one that does not must be said to help little, or offered only
        // as a supplement — left undiscussed or recommended on its own, it fails.
        for (const c of candidates) {
            const verdict = said(c) ?? 'not discussed';
            if (policyOf(id, c).effective && verdict !== ON_ITS_OWN) failures.push({ type: 'High-leverage change missed', details: `"${c.text}" meets the goal in simulation by itself, but the answer ${verdict === 'not discussed' ? 'does not discuss it' : `has it ${verdict}`}.` });
            if (!policyOf(id, c).effective && (verdict === ON_ITS_OWN || verdict === 'not discussed')) failures.push({ type: verdict === ON_ITS_OWN ? 'Low-leverage change recommended' : 'Change not judged', details: verdict === ON_ITS_OWN ? `"${c.text}" is recommended on its own, but in simulation it does not meet the goal.` : `"${c.text}" was on the table and does not meet the goal, but the answer does not say so.` });
        }
    } else {
        throw new Error(`Unknown criterion ${expectations.criterion}`);
    }
    return validateEvaluationResult(failures);
};

/** The closed reading of what an answer says about each lever; keyed by the verdict each option stands for. */
export const LEVER_SAYS = { raised: 'meets the goal on its own if raised', lowered: 'meets the goal on its own if lowered', alongside: 'helps only alongside other changes', no: 'would not meet the goal on its own within those limits', unsaid: 'not discussed' };

const leverSchemaFor = (levers) => z.object(Object.fromEntries(levers.map((l, i) => [
    `q${i + 1}`,
    z.enum([LEVER_SAYS.raised, LEVER_SAYS.lowered, LEVER_SAYS.alongside, LEVER_SAYS.no, LEVER_SAYS.unsaid]).describe(`Lever ${i + 1}: "${l.lever}". '${LEVER_SAYS.raised}' or '${LEVER_SAYS.lowered}' only if the advice says that moving this lever that way, by itself, within the stated limits, would meet the goal; '${LEVER_SAYS.alongside}' if it recommends the lever only as part of a package, as a supplement, or says it would not be enough alone but helps with others; '${LEVER_SAYS.no}' if it says this lever alone would not meet the goal, either way, and does not recommend it; '${LEVER_SAYS.unsaid}' if it says neither.`)
])));

/** The second hard group: every graded lever's verdict and direction right, all together. */
const evaluateLevers = async function(id, text) {
    const s = scenarios[id];
    const levers = LEVER_ORDER[id];
    let reading;
    try {
        reading = await extract(`cldStocksAndLeverage|levers|${id}|${text}`, [
            { role: 'system', content: 'You read advice about a model and report, for each listed lever, whether the advice says that moving it by itself, within the stated limits, would meet the goal, and which way it would have to move; or that it would not; or neither. Report only what the advice says; do not judge whether it is right.' },
            { role: 'user', content: `Goal: ${s.goal.label}\n\nLevers:\n${levers.map((l, i) => `${i + 1}. ${l.lever}`).join('\n')}\n\nAdvice:\n"""\n${text}\n"""` }
        ], leverSchemaFor(levers));
    } catch (error) {
        return validateEvaluationResult([{ type: 'Evaluation error', details: `Error reading the advice: ${error.message}` }]);
    }
    const failures = [];
    levers.forEach((l, i) => {
        if (l.verdict === null) return;
        const said = reading[`q${i + 1}`] ?? LEVER_SAYS.unsaid;
        if (said === LEVER_SAYS[l.verdict]) return;
        // Only a lever recommended in its own right counts as recommended: one offered only alongside
        // other changes fails a lever that works alone, and is a fair reading of one that does not.
        if (l.verdict === 'no' && said === LEVER_SAYS.alongside) return;
        if (l.verdict === 'no') {
            failures.push(said === LEVER_SAYS.unsaid
                ? { type: 'Lever not judged', details: `"${l.lever}" does not meet the goal on its own within its limits, but the answer does not say so.` }
                : { type: 'Low-leverage change recommended', details: `The answer says "${l.lever}" ${said}; in simulation it does not meet the goal on its own within its limits.` });
        } else {
            const moved = said === LEVER_SAYS.raised || said === LEVER_SAYS.lowered;
            failures.push({ type: moved ? 'Wrong direction' : 'High-leverage change missed', details: `"${l.lever}" meets the goal on its own if ${l.verdict} within its limits, but the answer ${said === LEVER_SAYS.unsaid ? 'does not discuss it' : `says it ${said}`}.` });
        }
    });
    return validateEvaluationResult(failures);
};

export const methodology = ()=> withFloors('cldStocksAndLeverage', {
    howItWorks: [
        `Both groups use the hidden scenarios of the conversation evals — a dialysis waiting list, a bike-share scheme, a distributor's inventory — each a small working simulation the agent never sees.`,
        `Stocks in the diagram: the agent hears the manager's account and is asked for a causal loop diagram in the scenario's own names, and for each quantity whether it accumulates. Each quantity that is a stock in the hidden model is a test: it must be in the diagram's links and be called an accumulation (by the text, read by a fixed judge model from closed options, or by its type in the diagram). One more test per scenario checks that no rate or plain quantity is called an accumulation. An expected demand that adjusts gradually is a stock in the hidden model, and "orders" can be read as a rate or as a backlog; neither is graded either way.`,
        `Leverage: the agent gets the working model in the scenario's names, a run_scenario tool and the goal its behavior misses, and is asked for the high-leverage changes and which way to push each, and which obvious levers would not help; it is told what changes are realistic (how fast chairs can be built, how much the advertising budget could grow), because with unlimited means even a weak lever eventually meets a goal. A fixed judge model reads the answer against a list of changes, each one of the scenario's policies whose effect on the goal comes from the hidden simulation. The agent must recommend one change that meets the goal, on its own or as part of a package, and must not recommend on its own the change a novice wrongly expects to work — offering it as a supplement to a change that works is fine, since together they still meet the goal.`,
        `Hard leverage group (leverageHard): for every scenario whose single policies split roughly evenly between changes that meet the goal and changes that do not (a third to two thirds effective), the manager lists all of them and asks only whether any is worth making — no mention of leverage or of what would not help — with the what-if feedback withheld (no run_scenario tool is offered, unlike the leverage group, so each verdict must come from the agent's own reading or running of the model), and one test needs every change judged right at once: each that meets the goal recommended on its own, each that does not dismissed or offered only as a supplement, so any constant verdict fails.`,
        `Second hard leverage group (leverageHard2, held-out scenarios only): no change is listed at all — the manager names only the levers they control and how far each could realistically go, and asks which, if any, would get there on its own and which way to move it, with no method, no tool and the what-if feedback withheld as in leverageHard. The key comes from a general rule (cldStocksAndLeverageData/leverKey.js): each lever is simulated at ten points from its value to each realistic limit, and meets the goal one way when some point clears the threshold by ${100 * LEVER_MARGIN}% and the other way (if any) misses it by as much; a lever too close to call is listed but not graded. A scenario is taken when its graded levers split both ways and its key says more than its listed changes do (some lever is in none of them, or its verdict differs, as when lowering a lever works though the listed change raises it), so judging only the first hard group's list cannot pass. One test needs every graded lever judged right at once, direction included. Only a lever recommended in its own right counts as recommended: one offered only alongside other changes fails a lever that meets the goal alone (and is a fair reading of one that does not), so hedging every lever scores nothing. The levers are listed in an order (balancedOrder) that keeps the right reading of each listed position as even across the group as the scenarios allow, so no constant reading of one position rides on every scenario listing a working lever first.`
    ],
    criteria: [
        { name: 'Stock missing from diagram', description: 'A quantity that accumulates is in none of the diagram\'s links.' },
        { name: 'Stock not recognized', description: 'A quantity that accumulates is not called an accumulation.' },
        { name: 'Non-stock called an accumulation', description: 'A rate or plain quantity is called an accumulation.' },
        { name: 'High-leverage change missed', description: 'None of the changes that meet the goal in simulation is recommended, on its own or as part of a package.' },
        { name: 'Low-leverage change recommended', description: 'The change a novice wrongly expects to work, which does not meet the goal in simulation, is recommended as high leverage on its own.' },
        { name: 'Change not judged', description: 'Hard leverage group: a change on the table that does not meet the goal is left undiscussed.' },
        { name: 'Lever not judged', description: 'Second hard leverage group: a lever that does not meet the goal on its own within its limits is left undiscussed.' },
        { name: 'Wrong direction', description: 'Second hard leverage group: a lever that meets the goal on its own within its limits is said to do so when moved the other way.' },
        { name: 'No diagram produced', description: 'The engine returned no causal links.' },
        { name: 'No answer given', description: 'The engine gave no explanation.' },
        { name: 'Evaluation error', description: 'The judge call failed; recorded as a failure so a broken judge never reads as a good answer.' }
    ],
    scoring: `Stocks: one test per accumulating quantity plus one per scenario against over-calling. Leverage: two tests per scenario. Hard leverage: one test per qualifying scenario, all its changes graded together. Tests of a scenario share one generation.`
});
