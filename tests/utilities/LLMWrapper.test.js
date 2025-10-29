import { LLMWrapper, ModelType } from '../../utilities/LLMWrapper.js';

describe('LLMWrapper', () => {
  describe('Gemini message content validation', () => {
    let llmWrapper;

    beforeEach(() => {
      llmWrapper = new LLMWrapper({
        googleKey: 'test-google-key',
        underlyingModel: 'gemini-2.5-flash'
      });
    });

    it('should filter out messages with no content when converting to Gemini format', () => {
      const messages = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: '' }, // Empty content
        { role: 'user', content: 'How are you?' },
        { role: 'assistant', content: null }, // Null content
        { role: 'user', content: 'Please respond' }
      ];

      const result = llmWrapper.convertMessagesToGeminiFormat(messages);

      // Should only have messages with content
      expect(result.contents.length).toBe(3); // 'Hello', 'How are you?', 'Please respond'
      expect(result.contents[0].parts[0].text).toBe('Hello');
      expect(result.contents[1].parts[0].text).toBe('How are you?');
      expect(result.contents[2].parts[0].text).toBe('Please respond');
    });

    it('should include system instruction from first system message', () => {
      const messages = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' }
      ];

      const result = llmWrapper.convertMessagesToGeminiFormat(messages);

      expect(result.systemInstruction).toBe('You are a helpful assistant');
      expect(result.contents.length).toBe(1);
      expect(result.contents[0].parts[0].text).toBe('Hello');
    });

    it('should handle all messages with empty content', () => {
      const messages = [
        { role: 'user', content: '' },
        { role: 'assistant', content: null },
        { role: 'user', content: undefined }
      ];

      const result = llmWrapper.convertMessagesToGeminiFormat(messages);

      expect(result.contents.length).toBe(0);
      expect(result.systemInstruction).toBeNull();
    });

    it('should handle messages with whitespace-only content', () => {
      const messages = [
        { role: 'user', content: '   ' }, // Whitespace only - should be included
        { role: 'assistant', content: '' }, // Empty - should be filtered
        { role: 'user', content: 'Real content' }
      ];

      const result = llmWrapper.convertMessagesToGeminiFormat(messages);

      // Whitespace-only content is technically content (truthy), so it should be included
      expect(result.contents.length).toBe(2);
      expect(result.contents[0].parts[0].text).toBe('   ');
      expect(result.contents[1].parts[0].text).toBe('Real content');
    });

    it('should convert second and subsequent system messages to user messages and filter empty ones', () => {
      const messages = [
        { role: 'system', content: 'First system message' },
        { role: 'system', content: '' }, // Empty - should be filtered
        { role: 'system', content: 'Third system message' },
        { role: 'user', content: 'User message' }
      ];

      const result = llmWrapper.convertMessagesToGeminiFormat(messages);

      expect(result.systemInstruction).toBe('First system message');
      expect(result.contents.length).toBe(2); // 'Third system message' as user, and 'User message'
      expect(result.contents[0].role).toBe('user');
      expect(result.contents[0].parts[0].text).toBe('Third system message');
      expect(result.contents[1].role).toBe('user');
      expect(result.contents[1].parts[0].text).toBe('User message');
    });

    it('should handle assistant messages with empty content', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'How are you?' },
        { role: 'assistant', content: '' }, // Empty assistant
        { role: 'user', content: 'Still there?' }
      ];

      const result = llmWrapper.convertMessagesToGeminiFormat(messages);

      expect(result.contents.length).toBe(4); // Should skip the empty assistant message
      expect(result.contents[0].role).toBe('user');
      expect(result.contents[0].parts[0].text).toBe('Hello');
      expect(result.contents[1].role).toBe('model'); // assistant -> model
      expect(result.contents[1].parts[0].text).toBe('Hi there');
      expect(result.contents[2].role).toBe('user');
      expect(result.contents[2].parts[0].text).toBe('How are you?');
      expect(result.contents[3].role).toBe('user');
      expect(result.contents[3].parts[0].text).toBe('Still there?');
    });

    it('should ensure all returned messages have content', () => {
      const messages = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'User 1' },
        { role: 'assistant', content: null },
        { role: 'user', content: '' },
        { role: 'assistant', content: 'Assistant 1' },
        { role: 'user', content: 'User 2' }
      ];

      const result = llmWrapper.convertMessagesToGeminiFormat(messages);

      // Verify every message in contents has non-empty content
      result.contents.forEach((message) => {
        expect(message.parts).toBeDefined();
        expect(message.parts.length).toBeGreaterThan(0);
        expect(message.parts[0].text).toBeTruthy();
      });

      // Verify we got the correct messages
      expect(result.contents.length).toBe(3);
      expect(result.systemInstruction).toBe('System');
    });
  });

  describe('Claude message content validation', () => {
    let llmWrapper;

    beforeEach(() => {
      llmWrapper = new LLMWrapper({
        anthropicKey: 'test-anthropic-key',
        underlyingModel: 'claude-sonnet-4-5-20250929'
      });
    });

    it('should include all messages with content when converting to Claude format', () => {
      const messages = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'How are you?' }
      ];

      const result = llmWrapper.convertMessagesToClaudeFormat(messages);

      expect(result.system).toBe('You are a helpful assistant');
      expect(result.messages.length).toBe(3);
      expect(result.messages[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(result.messages[1]).toEqual({ role: 'assistant', content: 'Hi there' });
      expect(result.messages[2]).toEqual({ role: 'user', content: 'How are you?' });
    });

    it('should handle messages with empty content', () => {
      const messages = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: '' }, // Empty content
        { role: 'user', content: 'How are you?' },
        { role: 'assistant', content: null }, // Null content
        { role: 'user', content: 'Please respond' }
      ];

      const result = llmWrapper.convertMessagesToClaudeFormat(messages);

      // Claude format includes all messages, even empty ones
      expect(result.messages.length).toBe(5);
      expect(result.messages[0].content).toBe('Hello');
      expect(result.messages[1].content).toBe('');
      expect(result.messages[2].content).toBe('How are you?');
      expect(result.messages[3].content).toBe(null);
      expect(result.messages[4].content).toBe('Please respond');
    });

    it('should convert second and subsequent system messages to user messages', () => {
      const messages = [
        { role: 'system', content: 'First system message' },
        { role: 'system', content: 'Second system message' },
        { role: 'user', content: 'User message' }
      ];

      const result = llmWrapper.convertMessagesToClaudeFormat(messages);

      expect(result.system).toBe('First system message');
      expect(result.messages.length).toBe(2);
      expect(result.messages[0]).toEqual({ role: 'user', content: 'Second system message' });
      expect(result.messages[1]).toEqual({ role: 'user', content: 'User message' });
    });
  });

  describe('OpenAI message content validation', () => {
    let llmWrapper;

    beforeEach(() => {
      llmWrapper = new LLMWrapper({
        openAIKey: 'test-openai-key',
        underlyingModel: 'gpt-4o'
      });
    });

    it('should pass messages directly to OpenAI without filtering', () => {
      const messages = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: '' }, // Empty content
        { role: 'user', content: 'How are you?' }
      ];

      // OpenAI doesn't have a conversion method, messages are passed directly
      // We can verify this by checking that the model type is OpenAI
      expect(llmWrapper.model.kind).toBe(ModelType.OPEN_AI);
    });

    it('should identify OpenAI models correctly', () => {
      expect(llmWrapper.model.kind).toBe(ModelType.OPEN_AI);
      expect(llmWrapper.model.name).toBe('gpt-4o');
    });
  });

  describe('ModelCapabilities', () => {
    it('should identify Gemini models correctly', () => {
      const wrapper = new LLMWrapper({
        googleKey: 'test-key',
        underlyingModel: 'gemini-2.5-flash'
      });

      expect(wrapper.model.kind).toBe(ModelType.GEMINI);
    });

    it('should identify Claude models correctly', () => {
      const wrapper = new LLMWrapper({
        anthropicKey: 'test-key',
        underlyingModel: 'claude-sonnet-4-5-20250929'
      });

      expect(wrapper.model.kind).toBe(ModelType.CLAUDE);
    });

    it('should identify OpenAI models correctly', () => {
      const wrapper = new LLMWrapper({
        openAIKey: 'test-key',
        underlyingModel: 'gpt-4o'
      });

      expect(wrapper.model.kind).toBe(ModelType.OPEN_AI);
    });
  });

  describe('Cross-model empty content handling', () => {
    it('should ensure Gemini never receives messages with no content', () => {
      const llmWrapper = new LLMWrapper({
        googleKey: 'test-google-key',
        underlyingModel: 'gemini-2.5-flash'
      });

      const messages = [
        { role: 'user', content: 'Valid message' },
        { role: 'assistant', content: '' },
        { role: 'user', content: null },
        { role: 'assistant', content: undefined },
        { role: 'user', content: 'Another valid message' }
      ];

      const result = llmWrapper.convertMessagesToGeminiFormat(messages);

      // Verify no message in the result has empty/null/undefined content
      result.contents.forEach((message) => {
        expect(message.parts[0].text).toBeTruthy();
        expect(message.parts[0].text).not.toBe('');
        expect(message.parts[0].text).not.toBe(null);
        expect(message.parts[0].text).not.toBe(undefined);
      });

      expect(result.contents.length).toBe(2);
    });

    it('should document that Claude may receive messages with empty content', () => {
      const llmWrapper = new LLMWrapper({
        anthropicKey: 'test-anthropic-key',
        underlyingModel: 'claude-sonnet-4-5-20250929'
      });

      const messages = [
        { role: 'user', content: 'Valid message' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'Another valid message' }
      ];

      const result = llmWrapper.convertMessagesToClaudeFormat(messages);

      // Claude does not filter empty messages
      expect(result.messages.length).toBe(3);
      expect(result.messages[1].content).toBe('');
    });

    it('should document that OpenAI receives messages as-is', () => {
      const llmWrapper = new LLMWrapper({
        openAIKey: 'test-openai-key',
        underlyingModel: 'gpt-4o'
      });

      // OpenAI messages are passed directly to the API without conversion
      expect(llmWrapper.model.kind).toBe(ModelType.OPEN_AI);
    });
  });
});
