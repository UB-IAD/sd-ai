import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';

// An orchestrator that says the next queued reply each turn, optionally writing a model first.
let replies = [];
let received = [];
jest.unstable_mockModule('../../agent/AgentOrchestrator.js', () => ({
    AgentOrchestrator: class MockOrchestrator {
        constructor(sessionManager, sessionId, sendFn) {
            this._sm = sessionManager;
            this._id = sessionId;
            this._send = sendFn;
        }
        async startConversation(msg) {
            received.push(msg);
            const next = replies.shift() ?? { text: '' };
            if (next.model) this._sm.updateClientModel(this._id, next.model);
            if (next.tool) await this._send({ type: 'tool_call_notification', callId: `c${received.length}`, toolName: next.tool, arguments: {}, isBuiltIn: true });
            if (next.text) await this._send({ type: 'agent_text', content: next.text });
            await this._send({ type: 'agent_complete', status: 'done' });
        }
    }
}));

// The scripted user's router: a question mentioning "delay" asks topic 1; anything with "?" is a question.
jest.unstable_mockModule('../../evals/utilities/judge.js', () => ({
    extract: async (key, messages) => {
        const text = messages[1].content.split('Message:')[1];
        return { asksQuestion: text.includes('?') ? 'yes' : 'no', topics: [{ number: 1, asked: text.includes('delay') ? 'yes' : 'no' }] };
    },
    clearJudgeCache: () => {}
}));

let runAgent;
let patchAgentConfig;
beforeAll(async () => {
    ({ runAgent, patchAgentConfig } = await import('../../agent/utilities/AgentEvalRunner.js'));
});
beforeEach(() => { replies = []; received = []; });

const MODEL = { variables: [{ name: 'a', type: 'variable', equation: '1' }], relationships: [] };
const params = (extra) => ({ agentName: 'merlin', provider: 'anthropic', mode: 'cld', ...extra });

describe('conversation mode', () => {
    test('a conversation tells the agent a user is present; a single-shot run does not', () => {
        const md = '---\nmax_iterations: 5\n---\nbody';
        expect(patchAgentConfig(md, null, true)).toContain('EVAL MODE: Conversation');
        expect(patchAgentConfig(md, null, false)).toContain('EVAL MODE: No User Present');
    });

    test('scripted turns are sent in order; transcript and snapshots line up turn by turn', async () => {
        replies = [{ text: 'first', model: MODEL }, { text: 'second', tool: 'update_model' }];
        const result = await runAgent('opening', null, params({ turns: ['follow up'] }));
        expect(received[1]).toBe('follow up');
        expect(result.transcript.map((t) => [t.role, t.turn, t.text])).toEqual([
            ['user', 1, 'opening'], ['agent', 1, 'first'], ['user', 2, 'follow up'], ['agent', 2, 'second']
        ]);
        expect(result.snapshots.map((s) => s.turn)).toEqual([1, 2]);
        expect(result.snapshots[0].model.variables[0].name).toBe('a');
        expect(result.toolLog).toEqual([expect.objectContaining({ toolName: 'update_model', turn: 2 })]);
    });

    test('the scripted user answers only what was asked, and stops when the agent stops asking', async () => {
        replies = [{ text: 'What is the delay?', model: MODEL }, { text: 'And the colour?' }, { text: 'Thanks, here is my answer.' }, { text: 'closing reply' }];
        const result = await runAgent('opening', null, params({
            userScript: { id: 's', facts: [{ id: 'd', topic: 'the delay', text: 'Nine months.' }], unknownReply: 'Not sure.', maxQuestionTurns: 5, maxFactsPerTurn: 2, closingMessage: 'Now summarize.' }
        }));
        const users = result.transcript.filter((t) => t.role === 'user').map((t) => t.text);
        expect(users).toEqual(['opening', 'Nine months.', 'Not sure.', 'Now summarize.']);
        expect(result.transcript.find((t) => t.role === 'agent' && t.turn === 1).factsReleasedAfter).toEqual(['d']);
    });

    test('the scripted user stops after maxQuestionTurns even if the agent keeps asking', async () => {
        replies = Array.from({ length: 10 }, () => ({ text: 'delay?', model: MODEL }));
        const result = await runAgent('opening', null, params({
            userScript: { id: 's', facts: [{ id: 'd', topic: 'the delay', text: 'Nine months.' }], unknownReply: 'Not sure.', maxQuestionTurns: 2, maxFactsPerTurn: 1 }
        }));
        expect(result.transcript.filter((t) => t.role === 'user').length).toBe(3);
    });

    test('a script without its limits is rejected rather than silently never answering', async () => {
        replies = [{ text: 'delay?', model: MODEL }];
        await expect(runAgent('opening', null, params({ userScript: { id: 's', facts: [], unknownReply: '?' } }))).rejects.toThrow(/maxQuestionTurns/);
    });

    test("the harness's own model-not-written nudge is tagged in the transcript", async () => {
        replies = [{ text: 'no model yet' }, { text: 'still none' }, { text: 'ok', model: MODEL }];
        const result = await runAgent('opening', null, params({ turns: ['next'] }));
        const nudge = result.transcript.find((t) => t.synthetic);
        expect(nudge).toEqual(expect.objectContaining({ role: 'user', synthetic: 'modelNotWritten' }));
    });

    test('a single-shot run returns no transcript', async () => {
        replies = [{ text: 'done', model: MODEL }];
        const result = await runAgent('opening', null, params({}));
        expect(result.transcript).toBeUndefined();
        expect(result.snapshots).toBeUndefined();
    });
});
