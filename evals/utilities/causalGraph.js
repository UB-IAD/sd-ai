/**
 * Causal-graph utilities for categories that grade a causal loop diagram against a source model.
 *
 * A source model (a stock-and-flow model or a CLD) becomes a signed directed graph. A CLD an engine
 * built is read from the relationships of the model it returned.
 * The graders then ask two deterministic questions:
 *   - is a link the engine drew backed by a causal path in the source with the same polarity
 *     (going only through variables the engine left out, which is what summarizing means)?
 *   - does a loop in the engine's CLD stand for a particular loop of the source?
 *
 * @module utilities/causalGraph
 */

import utils from '../../utilities/utils.js';
import { dependenceSigns, lookupDirection, variableValueSigns } from './units/equationSign.js';

/**
 * Fold a variable name for comparison: case-insensitive, spaces, underscores and XMILE's literal
 * "\n" all the same separator.
 * @param {string} name A variable name
 * @returns {string} The folded name
 */
export const foldVariable = function(name) {
    if (typeof name !== 'string') return '';
    return utils.caseFold(name.replace(/\\n/g, ' ').replace(/[`*"]/g, '').trim().replace(/\s+/g, ' '));
};

/**
 * Normalize a polarity to '+', '-' or '?'.
 * @param {*} polarity A polarity as written ('+', 'positive', '-', 's', 'o', ...)
 * @returns {string} '+', '-' or '?' when unknown
 */
export const normalizePolarity = function(polarity) {
    const p = String(polarity ?? '').trim().toLowerCase();
    if (['+', 'positive', 'pos', 's', 'same', 'reinforcing'].includes(p)) return '+';
    if (['-', '−', '–', 'negative', 'neg', 'o', 'opposite', 'balancing'].includes(p)) return '-';
    return '?';
};

/** Steps a path search may take; far above what the eval models need, it only guards a pathological graph. */
export const PATH_STEP_BUDGET = 200000;

const multiply = (a, b) => (a === '?' || b === '?') ? '?' : (a === b ? '+' : '-');

/**
 * A signed directed graph.
 * @typedef {Object} SignedGraph
 * @property {Map<string, string>} names Folded name to display name
 * @property {Map<string, Map<string, string>>} edges from -> (to -> polarity '+', '-' or '?')
 */

const addEdge = function(graph, from, to, polarity) {
    const f = foldVariable(from);
    const t = foldVariable(to);
    if (!f || !t || f === t) return;
    if (!graph.names.has(f)) graph.names.set(f, from.replace(/\\n/g, ' '));
    if (!graph.names.has(t)) graph.names.set(t, to.replace(/\\n/g, ' '));
    if (!graph.edges.has(f)) graph.edges.set(f, new Map());
    const existing = graph.edges.get(f).get(t);
    // A known polarity beats an unknown one; two different known polarities make the link ambiguous.
    if (existing === undefined || existing === '?') graph.edges.get(f).set(t, polarity);
    else if (polarity !== '?' && existing !== polarity) graph.edges.get(f).set(t, '?');
};

/**
 * Build the signed causal graph of a source model.
 *
 * Polarity comes, in order of authority, from: the links of the model's analysed feedback loops
 * (an LTM fixture's `feedbackLoops`); the equations themselves, whose dependence on each input has
 * a sign (equationSign.js); the stock-flow structure (an inflow raises its stock, an outflow lowers
 * it); and last the model's relationships, which fill in links the equations do not determine
 * (every link of a CLD, and a lookup's). A link whose sign none of these settles is '?'.
 *
 * @param {Object} model An sd-json model (stock-and-flow or CLD)
 * @param {Array<Object>|null} analysedLoops Loops with `links: [{from, to, polarity}]`, or null
 * @returns {SignedGraph} The graph
 */
export const sourceGraph = function(model, analysedLoops) {
    const graph = { names: new Map(), edges: new Map() };
    const variables = (model?.variables || []).filter((v) => v && typeof v.name === 'string');
    for (const variable of variables) {
        const f = foldVariable(variable.name);
        if (f && !graph.names.has(f)) graph.names.set(f, variable.name.replace(/\\n/g, ' '));
    }
    for (const loop of analysedLoops || []) {
        for (const link of loop.links || []) addEdge(graph, link.from, link.to, normalizePolarity(link.polarity));
    }
    // Links read from equations, with the polarity the equation itself implies (the sign of its
    // dependence on each input, see equationSign.js). In a stock-and-flow model the equations are
    // the truth, so these take precedence over whatever polarity the relationships list states.
    // A stock's equation is its initial value, not a causal dependence, so stocks are skipped; a
    // lookup's link takes the lookup's direction (rising, falling, or unsigned when it turns).
    const fromEquations = new Set();
    const allNames = variables.map((v) => v.name);
    const named = variableValueSigns(variables);
    for (const variable of variables.filter((v) => v.type !== 'stock')) {
        let signs = dependenceSigns(variable.equation ?? '', allNames, foldVariable, named);
        if (!signs) {
            // An equation the parser cannot read (arrays, unusual syntax) still names its inputs.
            signs = new Map();
            const text = String(variable.equation ?? '').replace(/"([^"]*)"/g, (_, q) => q.replace(/\s+/g, '_'));
            for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_.]*/g)) {
                if (graph.names.has(foldVariable(match[0]))) signs.set(foldVariable(match[0]), '?');
            }
        }
        const isLookup = Array.isArray(variable.graphicalFunction) ? variable.graphicalFunction.length > 0 : (variable.graphicalFunction?.points || []).length > 0;
        // A lookup's output follows its input expression through the lookup's own direction.
        const direction = isLookup ? lookupDirection(variable.graphicalFunction) : '+';
        for (const [source, sign] of signs) {
            if (source === foldVariable(variable.name)) continue;
            const signed = direction === '?' || sign === '?' ? '?' : (direction === '+' ? sign : (sign === '+' ? '-' : '+'));
            addEdge(graph, graph.names.get(source), variable.name, signed);
            fromEquations.add(`${source}|${foldVariable(variable.name)}`);
        }
    }
    for (const variable of variables.filter((v) => v.type === 'stock')) {
        for (const inflow of variable.inflows || []) addEdge(graph, inflow, variable.name, '+');
        for (const outflow of variable.outflows || []) addEdge(graph, outflow, variable.name, '-');
    }
    // Relationships fill in what the equations do not say: a CLD has no equations, and a lookup's
    // polarity is only known if someone states it.
    for (const rel of model?.relationships || []) {
        const key = `${foldVariable(rel.from)}|${foldVariable(rel.to)}`;
        const existing = graph.edges.get(foldVariable(rel.from))?.get(foldVariable(rel.to));
        if (fromEquations.has(key) && existing !== '?') continue;
        addEdge(graph, rel.from, rel.to, normalizePolarity(rel.polarity));
    }
    return graph;
};

/**
 * Build a graph from a list of links.
 * @param {Array<{from: string, to: string, polarity: string}>} links Links
 * @returns {SignedGraph} The graph
 */
export const graphFromLinks = function(links) {
    const graph = { names: new Map(), edges: new Map() };
    for (const link of links) addEdge(graph, link.from, link.to, normalizePolarity(link.polarity));
    return graph;
};

/**
 * Every simple cycle in a graph, each found once, up to a cap.
 *
 * @param {SignedGraph} graph The graph
 * @param {number} cap Stop after this many cycles; models in the evals are far below it
 * @returns {Array<{nodes: Array<string>, polarity: string}>} Cycles as folded node lists, with loop polarity
 */
export const findCycles = function(graph, cap) {
    const nodes = [...graph.names.keys()].sort();
    const index = new Map(nodes.map((n, i) => [n, i]));
    const cycles = [];
    for (let start = 0; start < nodes.length && cycles.length < cap; start++) {
        const startNode = nodes[start];
        const path = [startNode];
        const signs = [];
        const onPath = new Set([startNode]);
        const dfs = (node) => {
            for (const [to, polarity] of graph.edges.get(node) || []) {
                if (cycles.length >= cap) return;
                if (to === startNode) {
                    cycles.push({ nodes: [...path], polarity: [...signs, polarity].reduce(multiply, '+') });
                } else if (!onPath.has(to) && index.get(to) > start) {
                    onPath.add(to); path.push(to); signs.push(polarity);
                    dfs(to);
                    onPath.delete(to); path.pop(); signs.pop();
                }
            }
        };
        dfs(startNode);
    }
    return cycles;
};

/**
 * The polarities of the causal paths from one variable to another in a source graph, going only
 * through intermediate variables that are not in `kept` (the variables the engine's CLD shows).
 *
 * A CLD link from A to B is a faithful summary when such a path exists with the link's polarity:
 * the variables it skipped over are ones the CLD left out. Paths through a variable the CLD does
 * show do not count, because that variable's own links have to carry that path. Only simple paths
 * count: going round a loop of omitted variables is not a causal route from A to B.
 *
 * @param {SignedGraph} graph The source graph
 * @param {string} from Folded start variable
 * @param {string} to Folded end variable
 * @param {Set<string>} kept Folded variables the CLD shows
 * @returns {Set<string>} The polarities ('+', '-', '?') of the qualifying paths; empty when none exist
 */
export const pathPolarities = function(graph, from, to, kept) {
    // Simple paths only: a walk that goes round a loop of omitted variables flips its own sign
    // and would make every link through that loop look right with either polarity. Depth-first
    // over simple paths, stopping once every polarity is found or the step budget is spent.
    const found = new Set();
    const onPath = new Set([from]);
    let budget = PATH_STEP_BUDGET;
    const dfs = (node, sign) => {
        for (const [next, polarity] of graph.edges.get(node) || []) {
            if (budget-- <= 0 || found.size === 3) return;
            const nextSign = multiply(sign, polarity);
            if (next === to) { found.add(nextSign); continue; }
            if (kept.has(next) || onPath.has(next)) continue;
            onPath.add(next);
            dfs(next, nextSign);
            onPath.delete(next);
        }
    };
    dfs(from, '+');
    return found;
};

/**
 * The CLD an engine built: the signed relationships of the model it returned, which for an agent
 * is the model it actually wrote to the client (see engines/test-agent-build). Links without a
 * usable polarity are dropped, since a CLD link's polarity is part of what is graded.
 *
 * @param {Object} generatedResponse The engine's response
 * @returns {Array<{from: string, to: string, polarity: string}>} The CLD's links
 */
export const cldLinksFromResponse = function(generatedResponse) {
    const relationships = generatedResponse?.model?.relationships || [];
    return relationships
        .map((r) => ({ from: r.from, to: r.to, polarity: normalizePolarity(r.polarity) }))
        .filter((r) => typeof r.from === 'string' && typeof r.to === 'string' && r.polarity !== '?');
};
