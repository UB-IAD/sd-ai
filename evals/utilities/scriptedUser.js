/**
 * A scripted user for conversation evals.
 *
 * Categories that measure how an agent elicits information need a user who answers questions —
 * but a free-roaming simulated user is unreproducible, and could hand out more or less than the
 * test intends. This user holds a fixed bank of facts, each a pre-written sentence, and answers
 * only what the agent asked about:
 *   - a router reads the agent's turn and picks, from the bank's topics, which facts it asked for
 *     (a closed-option reading through the shared judge, cached by the agent's text, so the same
 *     turn always gets the same answer)
 *   - the reply is those facts' sentences, in bank order, or a fixed "don't know" reply when the
 *     agent asked something the bank does not cover
 *   - a turn with no question ends the questioning
 *
 *   - a turn's reply carries at most `maxFactsPerTurn` facts, and a catch-all request ("tell me
 *     everything") asks about no particular topic, so the bank cannot be emptied in one go
 *
 * The facts released and when are recorded on the transcript, so a category grades exactly what
 * the agent learned and how many questions it took.
 *
 * In AgentEvalRunner, fixed `turns` are sent first and the scripted user answers only from the
 * agent's reply to the last of them; questions asked during the fixed turns go unanswered.
 *
 * @module utilities/scriptedUser
 */

import { z } from 'zod';
import { extract } from './judge.js';

/** The reply to a question about something the user has already answered. */
export const REPEAT_REPLY = "As I said, that's all I know about that.";

export const routingSchema = z.object({
    asksQuestion: z.enum(['yes', 'no']).describe("'yes' if the message asks the user anything at all (a question, or a request for information); 'no' if it only states, explains or concludes"),
    topics: z.array(z.object({
        number: z.number().int().positive().describe('The topic number'),
        asked: z.enum(['yes', 'no']).describe("'yes' if the message specifically asks about this topic (by name, or with a question clearly aimed at it, in any words); 'no' otherwise, including for catch-all requests like 'tell me everything'")
    })).describe('One entry for every numbered topic')
});

const routingMessages = function(script, agentText) {
    return [
        {
            role: 'system',
            content: `You read one message from an assistant to a user and report what the assistant asked the user about. You are given a numbered list of topics the user can talk about. Mark a topic as asked only if the message specifically asks about it: it names that topic, or asks a question that is clearly aimed at it (in other words is fine). A catch-all request such as "tell me everything about your situation" or "what else should I know?" does not ask about any particular topic. A topic the assistant merely mentions or assumes, without asking, is not asked.`
        },
        {
            role: 'user',
            content: `Topics:
${script.facts.map((f, i) => `${i + 1}. ${f.topic}`).join('\n')}

Message:
"""
${agentText}
"""

Report whether the message asks the user anything, and which topics it asks about.`
        }
    ];
};

/**
 * Decide the scripted user's reply to one agent turn.
 *
 * @param {{id: string, facts: Array<{id: string, topic: string, text: string}>, unknownReply: string, maxFactsPerTurn: number}} script The fact bank
 * @param {string} agentText What the agent said this turn
 * @param {Set<string>} released Fact ids already given; each fact is given once, so a topic the
 *   agent keeps touching on cannot crowd out the ones it has not heard yet
 * @returns {Promise<{done: boolean, factIds: Array<string>, text: string}>} The reply; `done` when the agent asked nothing
 */
export const answerFromScript = async function(script, agentText, released) {
    if (!String(agentText || '').trim()) return { done: true, factIds: [], text: '' };
    const reading = await extract(`scriptedUser|${script.id}|${agentText}`, routingMessages(script, agentText), routingSchema);
    if (reading.asksQuestion !== 'yes') return { done: true, factIds: [], text: '' };
    const asked = new Set((reading.topics || []).filter((t) => t.asked === 'yes').map((t) => t.number));
    // A turn that asks about more topics than a person would answer at once gets the first few, in
    // bank order; a shotgun of questions is not rewarded with the whole bank.
    // A fact is given once. Asking again about something already answered, or about nothing in the
    // bank, gets the fixed "don't know" reply: repeating the same sentences only stalls the
    // conversation and crowds out what the agent has not heard yet.
    const askedFacts = script.facts.filter((_, i) => asked.has(i + 1));
    const facts = askedFacts.filter((f) => !released.has(f.id)).slice(0, script.maxFactsPerTurn);
    if (facts.length === 0) {
        // Asked only about things already answered: say so, rather than claim not to know.
        return { done: false, factIds: [], text: askedFacts.length ? REPEAT_REPLY : script.unknownReply };
    }
    return { done: false, factIds: facts.map((f) => f.id), text: facts.map((f) => f.text).join(' ') };
};
