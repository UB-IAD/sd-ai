import { jest } from '@jest/globals';

// The router is the judge; stand in for it so routing is exact and offline.
let reading = null;
const calls = [];
jest.unstable_mockModule('../../../evals/utilities/judge.js', () => ({
    extract: async (key, messages) => { calls.push({ key, messages }); return reading; },
    clearJudgeCache: () => {}
}));

const { answerFromScript } = await import('../../../evals/utilities/scriptedUser.js');

const script = {
    id: 'clinic',
    facts: [
        { id: 'delay', topic: 'how long new chairs take', text: 'Chairs take about nine months to arrive.' },
        { id: 'giveup', topic: 'whether people leave the list', text: 'Some people give up after six months.' },
        { id: 'return', topic: 'whether people come back', text: 'Most of them come back about a year later.' }
    ],
    unknownReply: "I'm not sure.",
    maxFactsPerTurn: 2
};

const asked = (...numbers) => ({ asksQuestion: 'yes', topics: [1, 2, 3].map((n) => ({ number: n, asked: numbers.includes(n) ? 'yes' : 'no' })) });

describe('scripted user', () => {
    beforeEach(() => { calls.length = 0; });

    test('an empty agent turn ends the questioning without asking the router', async () => {
        expect(await answerFromScript(script, '   ', new Set())).toEqual({ done: true, factIds: [], text: '' });
        expect(calls).toEqual([]);
    });

    test('a turn with no question ends the questioning', async () => {
        reading = { asksQuestion: 'no', topics: [] };
        expect((await answerFromScript(script, 'Here is my analysis.', new Set())).done).toBe(true);
    });

    test('a question the bank does not cover gets the fixed unknown reply', async () => {
        reading = asked();
        expect(await answerFromScript(script, 'What colour are the chairs?', new Set())).toEqual({ done: false, factIds: [], text: "I'm not sure." });
    });

    test('asked topics are answered with their fixed sentences, in bank order', async () => {
        reading = asked(3, 1);
        expect(await answerFromScript(script, 'Do people come back? And how long do chairs take?', new Set())).toEqual({
            done: false, factIds: ['delay', 'return'], text: 'Chairs take about nine months to arrive. Most of them come back about a year later.'
        });
    });

    test('a shotgun of questions gets at most maxFactsPerTurn facts', async () => {
        reading = asked(1, 2, 3);
        expect((await answerFromScript(script, 'Tell me about chairs, leaving and returning.', new Set())).factIds).toEqual(['delay', 'giveup']);
    });

    test('each fact is given once: new facts fill the reply, and a repeat question is told it was answered', async () => {
        reading = asked(1, 2, 3);
        expect((await answerFromScript(script, 'All three?', new Set(['delay']))).factIds).toEqual(['giveup', 'return']);
        reading = asked(1);
        expect(await answerFromScript(script, 'The delay again?', new Set(['delay']))).toEqual({ done: false, factIds: [], text: "As I said, that's all I know about that." });
    });

    test('the router sees topics only, never the fact sentences, and is cached by the agent text', async () => {
        reading = asked(1);
        await answerFromScript(script, 'How long do chairs take?', new Set());
        const shown = JSON.stringify(calls[0].messages);
        expect(shown).toContain('how long new chairs take');
        expect(shown).not.toContain('nine months');
        expect(calls[0].key).toBe('scriptedUser|clinic|How long do chairs take?');
    });
});
