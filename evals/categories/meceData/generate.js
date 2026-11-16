/**
 * The general rule that makes mece cases for every scenario in the library.
 *
 * A scenario's model qualifies through its totals: a variable whose equation adds up two or more of
 * its stocks (a population made of the people who have joined and those who have not). Each total
 * gives up to two cases, one plant each, on the scenario's glossary model:
 *   - gap: the total leaves one of its stocks out, so it no longer covers every part
 *   - overlap: the total counts one of its stocks twice, so the parts are no longer exclusive
 * The stock tried is each of the total's stocks in turn; a plant is kept only if it moves some stock
 * of the model by at least MIN_DEVIATION of its largest value, so the error changes what the model
 * computes and a fix can be checked by simulation. Distractors are claims of the kinds the hand
 * cases use, about other parts of the model, chosen to make sense on their face: that two other
 * stocks measured in the same units overlap and one should go (else that one of the total's stocks
 * should not be a stock), and that a flow into or out of the total's stocks should be split into
 * separate rates by kind (else that the total should be a stock).
 *
 * @module categories/meceData/generate
 */

import { foldName } from '../../utilities/modelDiff.js';
import { correctModel, deviation, MIN_DEVIATION } from '../guidedCorrectionData/generate.js';

const under = (n) => n.replace(/\s+/g, '_');

/** The totals of a model: variables whose equations are sums of two or more of its stocks. */
export const totalsOf = function(model) {
    const stocks = new Map(model.variables.filter((v) => v.type === 'stock').map((v) => [foldName(v.name), v.name]));
    const out = [];
    for (const v of model.variables.filter((x) => x.type !== 'stock')) {
        const terms = String(v.equation ?? '').split('+').map((t) => t.trim());
        if (terms.length < 2 || !terms.every((t) => stocks.has(foldName(t)))) continue;
        out.push({ variable: v.name, parts: terms.map((t) => stocks.get(foldName(t))) });
    }
    return out;
};

/**
 * The generated cases for one scenario.
 * @param {Object} s A scenario from the library
 * @returns {Promise<Array<Object>>} Cases in the hand cases' shape, without `correct` (cases.js builds it)
 */
export const generateCases = async function(s) {
    const correct = correctModel(s);
    const out = [];
    const stocks = correct.variables.filter((v) => v.type === 'stock').map((v) => v.name);
    for (const total of totalsOf(correct)) {
        // Distractors that make sense on their face: two other stocks measured alike said to overlap,
        // and a flow of the total's own stocks said to need splitting by kind.
        const unitsOf = (n) => String(correct.variables.find((v) => v.name === n).units ?? '').trim().toLowerCase();
        const others = stocks.filter((n) => !total.parts.includes(n));
        let pair = null;
        for (let i = 0; i < others.length && !pair; i++) for (let j = i + 1; j < others.length && !pair; j++) if (unitsOf(others[i]) === unitsOf(others[j])) pair = [others[i], others[j]];
        const partFlows = correct.variables.filter((v) => v.type === 'stock' && total.parts.includes(v.name)).flatMap((v) => [...(v.inflows || []), ...(v.outflows || [])]);
        const distractors = [
            pair ? `"${pair[0]}" and "${pair[1]}" overlap and one should be removed.` : `"${total.parts[0]}" should not be a stock.`,
            partFlows.length ? `"${partFlows[0]}" should be split into separate rates for every kind of ${total.variable}.` : `"${total.variable}" should be a stock.`
        ];
        const kinds = {
            gap: (part) => ({
                equation: total.parts.filter((p) => p !== part).map(under).join(' + '),
                text: `"${total.variable}" adds up ${total.parts.filter((p) => p !== part).map((p) => `"${p}"`).join(' and ')} and leaves out "${part}", so it is not the whole of ${total.variable}.`
            }),
            overlap: (part) => ({
                equation: [...total.parts, part].map(under).join(' + '),
                text: `"${total.variable}" counts "${part}" twice, so the people or things in "${part}" are counted as if they were a separate group.`
            })
        };
        for (const [kind, make] of Object.entries(kinds)) {
            for (const part of total.parts) {
                const plant = make(part);
                const planted = structuredClone(correct);
                planted.variables.find((v) => v.name === total.variable).equation = plant.equation;
                const d = await deviation(planted, correct);
                if (d === null || d < MIN_DEVIATION) continue;
                out.push({
                    name: `${s.title}: ${total.variable} (${kind})`,
                    scenario: s.id,
                    description: `the ${s.title.toLowerCase()}`,
                    plant: { variable: total.variable, change: { equation: plant.equation } },
                    kind,
                    text: plant.text,
                    distractors
                });
                break;
            }
        }
    }
    return out;
};
