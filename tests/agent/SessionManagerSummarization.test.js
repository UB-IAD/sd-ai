import { SessionManager } from '../../agent/utilities/SessionManager.js';
import { AgentOrchestrator } from '../../agent/AgentOrchestrator.js';
import config from '../../config.js';
import { jest } from '@jest/globals';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AGENT_A_CONFIG = { path: path.join(__dirname, '../../agent/config/socrates.md') };
const AGENT_B_CONFIG = { path: path.join(__dirname, '../../agent/config/merlin.md') };

function makeGeminiMock(summaryText = 'Mocked summary.') {
  return {
    models: {
      generateContent: jest.fn().mockResolvedValue({
        text: summaryText
      })
    }
  };
}

function makeAnthropicMock(summaryText = 'Mocked summary.') {
  return {
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: summaryText }],
        usage: { input_tokens: 10, output_tokens: 20 }
      })
    }
  };
}

function makeOpenRouterMock(summaryText = 'Mocked summary.') {
  return {
    chat: {
      send: jest.fn().mockResolvedValue({
        choices: [{ message: { content: summaryText } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.0001 }
      })
    }
  };
}

function makeDeepSeekMock(summaryText = 'Mocked summary.') {
  return {
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content: summaryText } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 }
        })
      }
    }
  };
}

// Pre-populate every SDK instance property with a throw-on-call guard so a test
// that triggers summarization without first wiring the provider it exercises
// fails loudly instead of attempting a real LLM call. The lazy loaders in
// SessionManager only instantiate a fresh SDK when the instance is falsy, so
// truthy guards short-circuit the import-and-instantiate path entirely. Tests
// that need a working mock for a specific provider replace the relevant
// property after this is installed.
function installSdkGuards(sessionManager) {
  const guard = (provider) => jest.fn(() => {
    throw new Error(
      `Test triggered ${provider} LLM call without installing a mock. ` +
      `Set sessionManager.${provider} to a mock before calling cleanupContext().`
    );
  });
  sessionManager.anthropic = { messages: { create: guard('anthropic') } };
  sessionManager.gemini = { models: { generateContent: guard('gemini') } };
  sessionManager.openRouter = { chat: { send: guard('openRouter') } };
  sessionManager.deepSeek = { chat: { completions: { create: guard('deepSeek') } } };
}

function userTextMsg(text) {
  return { role: 'user', content: text };
}

function assistantTextMsg(text) {
  return { role: 'assistant', content: text };
}

function userMsg(text) {
  return { role: 'user', parts: [{ text }] };
}

function modelMsg(text) {
  return { role: 'model', parts: [{ text }] };
}

function modelResultMessage(id) {
  return {
    role: 'user',
    parts: [{
      functionResponse: {
        name: 'generate_model',
        response: { result: JSON.stringify({ model: { variables: [] }, resultId: id }) }
      }
    }]
  };
}

function modelToolCallMessage(id) {
  return {
    role: 'model',
    parts: [{
      functionCall: {
        name: 'generate_model',
        args: { id }
      }
    }]
  };
}

// ─── SessionManager.cleanupContext ─────────────────────────────────

describe('SessionManager.cleanupContext', () => {
  let sessionManager;
  let sessionId;

  beforeEach(() => {
    sessionManager = new SessionManager();
    sessionId = sessionManager.createSession(null);
    sessionManager.initializeSession(sessionId, 'cld', {}, [], {}, 'test-client');
    installSdkGuards(sessionManager);
    sessionManager.gemini = makeGeminiMock();
  });

  afterEach(() => { sessionManager.shutdown(); });

  it('does nothing when context is under the token limit', async () => {
    sessionManager.addToConversationHistory(sessionId, userMsg('Hello'));
    sessionManager.addToConversationHistory(sessionId, modelMsg('Hi there'));

    const contextBefore = [...sessionManager.getConversationContext(sessionId)];
    await sessionManager.cleanupContext(sessionId, 100_000, 'google');

    expect(sessionManager.getConversationContext(sessionId)).toEqual(contextBefore);
    expect(sessionManager.gemini.models.generateContent).not.toHaveBeenCalled();
  });

  it('replaces old messages with a summary when over the token limit', async () => {
    for (let i = 0; i < 10; i++) {
      sessionManager.addToConversationHistory(sessionId, userMsg(`Message ${i}`));
      sessionManager.addToConversationHistory(sessionId, modelMsg(`Response ${i}`));
    }

    await sessionManager.cleanupContext(sessionId, 1, 'google');

    const context = sessionManager.getConversationContext(sessionId);
    expect(context[0].role).toBe('user');
    expect(context[0].parts[0].text).toMatch(/\[Previous conversation summary\]/);
    expect(sessionManager.gemini.models.generateContent).toHaveBeenCalled();
  });

  it('modifies the session context in-place so the live reference reflects the change', async () => {
    for (let i = 0; i < 8; i++) {
      sessionManager.addToConversationHistory(sessionId, userMsg(`Message ${i}`));
      sessionManager.addToConversationHistory(sessionId, modelMsg(`Response ${i}`));
    }

    const liveRef = sessionManager.getConversationContext(sessionId);
    const originalLength = liveRef.length;

    await sessionManager.cleanupContext(sessionId, 1, 'google');

    // splice is in-place: the same array object must be updated, not replaced
    expect(liveRef).toBe(sessionManager.getConversationContext(sessionId));
    expect(liveRef.length).toBeLessThan(originalLength);
    expect(liveRef[0].parts[0].text).toMatch(/\[Previous conversation summary\]/);
  });

  it('uses a fallback summary message when the LLM call fails', async () => {
    sessionManager.gemini.models.generateContent.mockRejectedValue(new Error('API error'));

    for (let i = 0; i < 5; i++) {
      sessionManager.addToConversationHistory(sessionId, userMsg(`Message ${i}`));
      sessionManager.addToConversationHistory(sessionId, modelMsg(`Response ${i}`));
    }

    await sessionManager.cleanupContext(sessionId, 1, 'google');

    const context = sessionManager.getConversationContext(sessionId);
    expect(context[0].parts[0].text).toMatch(/condensed/);
  });

  it('does nothing for a non-existent session ID', async () => {
    await expect(
      sessionManager.cleanupContext('non-existent-id', 1, 'google')
    ).resolves.toBeUndefined();
  });
});

// ─── SessionManager.cleanupContext ───────────────────────────────────────────

describe('SessionManager.cleanupContext', () => {
  let sessionManager;
  let sessionId;

  beforeEach(() => {
    sessionManager = new SessionManager();
    sessionId = sessionManager.createSession(null);
    sessionManager.initializeSession(sessionId, 'cld', {}, [], {}, 'test-client');
    installSdkGuards(sessionManager);
    sessionManager.gemini = makeGeminiMock();
  });

  afterEach(() => { sessionManager.shutdown(); });

  it('does nothing when context is empty', async () => {
    await expect(
      sessionManager.cleanupContext(sessionId, 100_000, 'google')
    ).resolves.toBeUndefined();
    expect(sessionManager.getConversationContext(sessionId)).toHaveLength(0);
  });

  it('summarizes after removing stale models when still over the token limit', async () => {
    for (let i = 0; i < 5; i++) {
      sessionManager.addToConversationHistory(sessionId, userMsg(`request ${i}`));
      sessionManager.addToConversationHistory(sessionId, modelToolCallMessage(String(i)));
      sessionManager.addToConversationHistory(sessionId, modelResultMessage(String(i)));
    }

    await sessionManager.cleanupContext(sessionId, 1, 'google');

    const context = sessionManager.getConversationContext(sessionId);
    const hasSummary = context.some(
      msg => Array.isArray(msg.parts) && msg.parts[0]?.text?.includes('[Previous conversation summary]')
    );
    expect(hasSummary).toBe(true);
    expect(sessionManager.gemini.models.generateContent).toHaveBeenCalled();
  });
});

// ─── Agent switch context continuity ─────────────────────────────────────────

describe('Agent switch - context continuity between orchestrators', () => {
  let sessionManager;
  let sessionId;
  const sendToClient = jest.fn();

  beforeEach(() => {
    sessionManager = new SessionManager();
    sessionId = sessionManager.createSession(null);
    sessionManager.initializeSession(sessionId, 'cld', {}, [], {}, 'test-client');
    installSdkGuards(sessionManager);
    process.env.GEMINI_API_KEY = 'dummy_key';
    process.env.ANTHROPIC_API_KEY = 'dummy_key';
    process.env.OPEN_ROUTER_API_KEY = 'dummy_key';
  });

  afterEach(() => {
    sessionManager.shutdown();
    sendToClient.mockClear();
  });

  it('second orchestrator sees context accumulated by the first orchestrator', () => {
    const orchestratorA = new AgentOrchestrator(sessionManager, sessionId, sendToClient, AGENT_A_CONFIG);

    // Simulate agent A processing a conversation turn (manual mode pushes to live context)
    sessionManager.addToConversationHistory(sessionId, userMsg('Build a causal loop diagram'));
    const context = sessionManager.getConversationContext(sessionId);
    context.push(modelMsg('Here is the CLD.'));

    // websocket.js captures the context on switch, then creates a new orchestrator
    const capturedOnSwitch = sessionManager.getConversationContext(sessionId);

    const orchestratorB = new AgentOrchestrator(sessionManager, sessionId, sendToClient, AGENT_B_CONFIG);

    // Agent B reads the session context — must see what agent A built
    const agentBContext = sessionManager.getConversationContext(sessionId);
    expect(agentBContext).toBe(capturedOnSwitch);
    expect(agentBContext).toHaveLength(2);
    expect(agentBContext[0].parts[0].text).toBe('Build a causal loop diagram');
    expect(agentBContext[1].parts[0].text).toBe('Here is the CLD.');

    orchestratorA.destroy();
    orchestratorB.destroy();
  });

  it('second orchestrator sees the summarized context after summarization by the first', async () => {
    sessionManager.gemini = makeGeminiMock(
      'Agent A built a CLD with 5 variables and 3 feedback loops.'
    );

    const orchestratorA = new AgentOrchestrator(sessionManager, sessionId, sendToClient, AGENT_A_CONFIG);

    // Agent A accumulates a large context
    for (let i = 0; i < 10; i++) {
      sessionManager.addToConversationHistory(sessionId, userMsg(`Step ${i}`));
      sessionManager.addToConversationHistory(sessionId, modelMsg(`Done ${i}`));
    }
    const fullLength = sessionManager.getConversationContext(sessionId).length;

    // Summarization fires during agent A's last turn
    await sessionManager.cleanupContext(sessionId, 1, 'google');

    // websocket.js captures context and creates agent B
    const capturedOnSwitch = sessionManager.getConversationContext(sessionId);
    const orchestratorB = new AgentOrchestrator(sessionManager, sessionId, sendToClient, AGENT_B_CONFIG);

    const agentBContext = sessionManager.getConversationContext(sessionId);

    // Agent B sees the summarized (shorter) context, not the full bloated one
    expect(agentBContext).toBe(capturedOnSwitch);
    expect(agentBContext.length).toBeLessThan(fullLength);
    expect(
      agentBContext.some(m => Array.isArray(m.parts) && m.parts[0]?.text?.includes('[Previous conversation summary]'))
    ).toBe(true);

    orchestratorA.destroy();
    orchestratorB.destroy();
  });
});

// ─── SessionManager.cleanupContext (Anthropic provider) ──────────────────────

describe('SessionManager.cleanupContext (Anthropic)', () => {
  let sessionManager;
  let sessionId;

  beforeEach(() => {
    sessionManager = new SessionManager();
    sessionId = sessionManager.createSession(null);
    sessionManager.initializeSession(sessionId, 'cld', {}, [], {}, 'test-client');
    installSdkGuards(sessionManager);
    sessionManager.anthropic = makeAnthropicMock();
  });

  afterEach(() => { sessionManager.shutdown(); });

  it('does nothing when context is under the token limit', async () => {
    sessionManager.addToConversationHistory(sessionId, userTextMsg('Hello'));
    sessionManager.addToConversationHistory(sessionId, assistantTextMsg('Hi there'));

    const contextBefore = [...sessionManager.getConversationContext(sessionId)];
    await sessionManager.cleanupContext(sessionId, 100_000, 'anthropic');

    expect(sessionManager.getConversationContext(sessionId)).toEqual(contextBefore);
    expect(sessionManager.anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('replaces old messages with a Claude-format summary when over the token limit', async () => {
    for (let i = 0; i < 10; i++) {
      sessionManager.addToConversationHistory(sessionId, userTextMsg(`Message ${i}`));
      sessionManager.addToConversationHistory(sessionId, assistantTextMsg(`Response ${i}`));
    }

    await sessionManager.cleanupContext(sessionId, 1, 'anthropic');

    const context = sessionManager.getConversationContext(sessionId);
    // Anthropic path emits {role, content} shape, not Gemini's {role, parts}
    expect(context[0].role).toBe('user');
    expect(typeof context[0].content).toBe('string');
    expect(context[0].content).toMatch(/\[Previous conversation summary\]/);
    expect(sessionManager.anthropic.messages.create).toHaveBeenCalled();
  });

  it('uses a fallback summary message when Anthropic call fails', async () => {
    sessionManager.anthropic.messages.create.mockRejectedValue(new Error('API error'));

    for (let i = 0; i < 5; i++) {
      sessionManager.addToConversationHistory(sessionId, userTextMsg(`Message ${i}`));
      sessionManager.addToConversationHistory(sessionId, assistantTextMsg(`Response ${i}`));
    }

    await sessionManager.cleanupContext(sessionId, 1, 'anthropic');

    const context = sessionManager.getConversationContext(sessionId);
    expect(context[0].content).toMatch(/condensed/);
  });

  it('summarizes assistant messages with tool_use/text content blocks', async () => {
    sessionManager.addToConversationHistory(sessionId, userTextMsg('Run the tool'));
    sessionManager.addToConversationHistory(sessionId, {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will use the tool now.' },
        { type: 'tool_use', id: 't1', name: 'do_thing', input: {} }
      ]
    });
    sessionManager.addToConversationHistory(sessionId, {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]
    });
    for (let i = 0; i < 5; i++) {
      sessionManager.addToConversationHistory(sessionId, userTextMsg(`Followup ${i}`));
      sessionManager.addToConversationHistory(sessionId, assistantTextMsg(`Reply ${i}`));
    }

    await sessionManager.cleanupContext(sessionId, 1, 'anthropic');

    expect(sessionManager.anthropic.messages.create).toHaveBeenCalled();
    const callArgs = sessionManager.anthropic.messages.create.mock.calls[0][0];
    // The prompt should include the text content from the assistant block
    expect(callArgs.messages[0].content).toContain('I will use the tool now.');
  });
});

// ─── SessionManager.cleanupContext (OpenRouter provider) ─────────────────────

describe('SessionManager.cleanupContext (OpenRouter)', () => {
  let sessionManager;
  let sessionId;

  beforeEach(() => {
    sessionManager = new SessionManager();
    sessionId = sessionManager.createSession(null);
    sessionManager.initializeSession(sessionId, 'cld', {}, [], {}, 'test-client');
    installSdkGuards(sessionManager);
    sessionManager.openRouter = makeOpenRouterMock();
  });

  afterEach(() => { sessionManager.shutdown(); });

  it.each(['qwen', 'moonshotai'])(
    'routes %s provider through the OpenRouter SDK', async (provider) => {
      for (let i = 0; i < 10; i++) {
        sessionManager.addToConversationHistory(sessionId, userTextMsg(`Message ${i}`));
        sessionManager.addToConversationHistory(sessionId, assistantTextMsg(`Response ${i}`));
      }

      await sessionManager.cleanupContext(sessionId, 1, provider);

      expect(sessionManager.openRouter.chat.send).toHaveBeenCalled();
      const context = sessionManager.getConversationContext(sessionId);
      expect(context[0].role).toBe('user');
      expect(typeof context[0].content).toBe('string');
      expect(context[0].content).toMatch(/\[Previous conversation summary\]/);
    }
  );

  it('passes the brand-specific summary model to OpenRouter', async () => {
    for (let i = 0; i < 10; i++) {
      sessionManager.addToConversationHistory(sessionId, userTextMsg(`Message ${i}`));
      sessionManager.addToConversationHistory(sessionId, assistantTextMsg(`Response ${i}`));
    }

    await sessionManager.cleanupContext(sessionId, 1, 'qwen');

    const callArgs = sessionManager.openRouter.chat.send.mock.calls[0][0];
    expect(callArgs.chatRequest.model).toMatch(/qwen/);
    expect(callArgs.chatRequest.messages[0].role).toBe('user');
    expect(callArgs.chatRequest.maxCompletionTokens).toBe(1024);
  });

  it('uses a fallback summary message when OpenRouter call fails', async () => {
    sessionManager.openRouter.chat.send.mockRejectedValue(new Error('OR error'));

    for (let i = 0; i < 5; i++) {
      sessionManager.addToConversationHistory(sessionId, userTextMsg(`Message ${i}`));
      sessionManager.addToConversationHistory(sessionId, assistantTextMsg(`Response ${i}`));
    }

    await sessionManager.cleanupContext(sessionId, 1, 'deepseek');

    const context = sessionManager.getConversationContext(sessionId);
    expect(context[0].content).toMatch(/condensed/);
  });

  it('handles array-shaped OpenRouter content blocks', async () => {
    sessionManager.openRouter.chat.send.mockResolvedValue({
      choices: [{
        message: {
          content: [
            { type: 'text', text: 'First part. ' },
            { type: 'text', text: 'Second part.' }
          ]
        }
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.0001 }
    });

    for (let i = 0; i < 10; i++) {
      sessionManager.addToConversationHistory(sessionId, userTextMsg(`Message ${i}`));
      sessionManager.addToConversationHistory(sessionId, assistantTextMsg(`Response ${i}`));
    }

    await sessionManager.cleanupContext(sessionId, 1, 'moonshotai');

    const context = sessionManager.getConversationContext(sessionId);
    expect(context[0].content).toContain('First part. Second part.');
  });
});

// ─── SessionManager.cleanupContext (native DeepSeek provider) ───────────────

describe('SessionManager.cleanupContext (native DeepSeek)', () => {
  let sessionManager;
  let sessionId;

  beforeEach(() => {
    sessionManager = new SessionManager();
    sessionId = sessionManager.createSession(null);
    sessionManager.initializeSession(sessionId, 'cld', {}, [], {}, 'test-client');
    installSdkGuards(sessionManager);
    sessionManager.deepSeek = makeDeepSeekMock();
  });

  afterEach(() => { sessionManager.shutdown(); });

  it('routes deepseek provider through the native DeepSeek API', async () => {
    for (let i = 0; i < 10; i++) {
      sessionManager.addToConversationHistory(sessionId, userTextMsg(`Message ${i}`));
      sessionManager.addToConversationHistory(sessionId, assistantTextMsg(`Response ${i}`));
    }

    await sessionManager.cleanupContext(sessionId, 1, 'deepseek');

    expect(sessionManager.deepSeek.chat.completions.create).toHaveBeenCalled();
    const context = sessionManager.getConversationContext(sessionId);
    expect(context[0].role).toBe('user');
    expect(typeof context[0].content).toBe('string');
    expect(context[0].content).toMatch(/\[Previous conversation summary\]/);
  });

  it('passes the native summary model to the DeepSeek API', async () => {
    for (let i = 0; i < 10; i++) {
      sessionManager.addToConversationHistory(sessionId, userTextMsg(`Message ${i}`));
      sessionManager.addToConversationHistory(sessionId, assistantTextMsg(`Response ${i}`));
    }

    await sessionManager.cleanupContext(sessionId, 1, 'deepseek');

    const callArgs = sessionManager.deepSeek.chat.completions.create.mock.calls[0][0];
    expect(callArgs.model).toBe(config.nativeAgentProviders.deepseek.summaryModel);
    expect(callArgs.messages[0].role).toBe('user');
  });

  it('throws a clear error when DEEPSEEK_API_KEY is missing and no client is installed', async () => {
    delete process.env.DEEPSEEK_API_KEY;
    sessionManager.deepSeek = null;
    for (let i = 0; i < 5; i++) {
      sessionManager.addToConversationHistory(sessionId, userTextMsg(`Message ${i}`));
      sessionManager.addToConversationHistory(sessionId, assistantTextMsg(`Response ${i}`));
    }

    // The missing-key throw is caught inside #summarizeMessages and converted to
    // a fallback summary; the error must not escape cleanupContext.
    await sessionManager.cleanupContext(sessionId, 1, 'deepseek');

    const context = sessionManager.getConversationContext(sessionId);
    const summaryText = context[0].content;
    expect(summaryText).toMatch(/condensed/);
  });
});

// ─── SDK guards ──────────────────────────────────────────────────────────────
// Guards short-circuit the lazy SDK loader path: when a test triggers
// summarization without first mocking the provider it routes to, the guard
// throws synchronously inside #summarizeMessages. That exception is caught by
// the surrounding try/catch and a fallback summary is produced instead. The
// test below verifies both that no real SDK was instantiated AND that the
// guard's call counter recorded the attempted call.

describe('SessionManager.cleanupContext SDK guards', () => {
  let sessionManager;
  let sessionId;

  beforeEach(() => {
    sessionManager = new SessionManager();
    sessionId = sessionManager.createSession(null);
    sessionManager.initializeSession(sessionId, 'cld', {}, [], {}, 'test-client');
    installSdkGuards(sessionManager);
  });

  afterEach(() => { sessionManager.shutdown(); });

  it.each([
    ['google', 'gemini', sm => sm.gemini.models.generateContent],
    ['anthropic', 'anthropic', sm => sm.anthropic.messages.create],
    ['qwen', 'openRouter', sm => sm.openRouter.chat.send],
    ['deepseek', 'deepSeek', sm => sm.deepSeek.chat.completions.create],
    ['moonshotai', 'openRouter', sm => sm.openRouter.chat.send],
  ])('guard for %s fires when no working mock is installed', async (provider, _instance, getMockFn) => {
    for (let i = 0; i < 5; i++) {
      sessionManager.addToConversationHistory(sessionId, userTextMsg(`Message ${i}`));
      sessionManager.addToConversationHistory(sessionId, assistantTextMsg(`Response ${i}`));
    }

    // Should not throw — the guard's throw is caught and converted to a fallback summary.
    await sessionManager.cleanupContext(sessionId, 1, provider);

    expect(getMockFn(sessionManager)).toHaveBeenCalled();

    const context = sessionManager.getConversationContext(sessionId);
    const summaryMsg = context[0];
    const summaryText = Array.isArray(summaryMsg.parts)
      ? summaryMsg.parts[0].text
      : summaryMsg.content;
    expect(summaryText).toMatch(/condensed/);
  });
});
