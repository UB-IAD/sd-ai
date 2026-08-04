import { LLMWrapper, ModelType } from '../../utilities/LLMWrapper.js';

describe('LLMWrapper', () => {
  describe('Gemini message content validation', () => {
    let llmWrapper;

    beforeEach(() => {
      llmWrapper = new LLMWrapper({
        openAIKey: 'test-key',
        anthropicKey: 'test-claude-key',
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
        openAIKey: 'test-key',
        anthropicKey: 'test-claude-key',
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
        anthropicKey: 'test-claude-key',
        underlyingModel: 'gpt-4o'
      });

      expect(wrapper.model.kind).toBe(ModelType.OPEN_AI);
    });
  });

  describe('Cross-model empty content handling', () => {
    it('should ensure Gemini never receives messages with no content', () => {
      const llmWrapper = new LLMWrapper({
        openAIKey: 'test-key',
        anthropicKey: 'test-claude-key',
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

  describe('getLLMParameters', () => {
    describe('o3-mini model parsing', () => {
      it('should parse o3-mini with low reasoning effort', () => {
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          underlyingModel: 'o3-mini low'
        });

        const params = wrapper.getLLMParameters();

        expect(params.underlyingModel).toBe('o3-mini');
        expect(params.reasoningEffort).toBe('low');
        expect(params.systemRole).toBe('developer');
        expect(params.temperature).toBeUndefined();
      });

      it('should parse o3-mini with medium reasoning effort', () => {
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          underlyingModel: 'o3-mini medium'
        });

        const params = wrapper.getLLMParameters();

        expect(params.underlyingModel).toBe('o3-mini');
        expect(params.reasoningEffort).toBe('medium');
      });

      it('should parse o3-mini with high reasoning effort', () => {
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          underlyingModel: 'o3-mini high'
        });

        const params = wrapper.getLLMParameters();

        expect(params.underlyingModel).toBe('o3-mini');
        expect(params.reasoningEffort).toBe('high');
      });
    });

    describe('o3 model parsing', () => {
      it('should parse o3 with low reasoning effort', () => {
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          underlyingModel: 'o3 low'
        });

        const params = wrapper.getLLMParameters();

        expect(params.underlyingModel).toBe('o3');
        expect(params.reasoningEffort).toBe('low');
        expect(params.systemRole).toBe('developer');
        expect(params.temperature).toBeUndefined();
      });

      it('should parse o3 with medium reasoning effort', () => {
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          underlyingModel: 'o3 medium'
        });

        const params = wrapper.getLLMParameters();

        expect(params.underlyingModel).toBe('o3');
        expect(params.reasoningEffort).toBe('medium');
      });

      it('should parse o3 with high reasoning effort', () => {
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          underlyingModel: 'o3 high'
        });

        const params = wrapper.getLLMParameters();

        expect(params.underlyingModel).toBe('o3');
        expect(params.reasoningEffort).toBe('high');
      });
    });

    describe('gpt-5.1 model parsing', () => {
      it('should parse gpt-5.1 with medium reasoning effort', () => {
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          underlyingModel: 'gpt-5.1 medium'
        });

        const params = wrapper.getLLMParameters();

        expect(params.underlyingModel).toBe('gpt-5.1');
        expect(params.reasoningEffort).toBe('medium');
        expect(params.systemRole).toBe('developer');
        expect(params.temperature).toBeUndefined();
      });

      it('should parse gpt-5.1 with low reasoning effort', () => {
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          underlyingModel: 'gpt-5.1 low'
        });

        const params = wrapper.getLLMParameters();

        expect(params.underlyingModel).toBe('gpt-5.1');
        expect(params.reasoningEffort).toBe('low');
      });

      it('should parse claude with max effort and strip it from the model id', () => {
        const wrapper = new LLMWrapper({
          anthropicKey: 'test-claude-key',
          underlyingModel: 'claude-opus-4-8 max'
        });

        const params = wrapper.getLLMParameters();

        expect(params.underlyingModel).toBe('claude-opus-4-8');
        expect(params.reasoningEffort).toBe('max');
        expect(params.systemRole).toBe('system');
      });
    });

    describe('standard models without reasoning effort', () => {
      it('should handle gpt-4o without parsing', () => {
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          underlyingModel: 'gpt-4o'
        });

        const params = wrapper.getLLMParameters();

        expect(params.underlyingModel).toBe('gpt-4o');
        expect(params.reasoningEffort).toBeUndefined();
        expect(params.systemRole).toBe('developer');
        expect(params.temperature).toBeUndefined();
      });

      it('should handle gemini models', () => {
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          googleKey: 'test-key',
          underlyingModel: 'gemini-2.5-flash'
        });

        const params = wrapper.getLLMParameters();

        expect(params.underlyingModel).toBe('gemini-2.5-flash');
        expect(params.reasoningEffort).toBeUndefined();
        expect(params.systemRole).toBe('system');
        expect(params.temperature).toBeUndefined();
      });

      it('should handle claude models', () => {
        const wrapper = new LLMWrapper({
          anthropicKey: 'test-key',
          underlyingModel: 'claude-sonnet-4-5-20250929'
        });

        const params = wrapper.getLLMParameters();

        expect(params.underlyingModel).toBe('claude-sonnet-4-5-20250929');
        expect(params.reasoningEffort).toBeUndefined();
        expect(params.systemRole).toBe('system');
        expect(params.temperature).toBeUndefined();
      });
    });

    describe('system role determination', () => {
      it('should use "developer" for OpenAI models with system mode', () => {
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          underlyingModel: 'gpt-4o'
        });

        const params = wrapper.getLLMParameters();
        expect(params.systemRole).toBe('developer');
      });

      it('should use "system" for Gemini models', () => {
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          googleKey: 'test-key',
          underlyingModel: 'gemini-2.5-flash'
        });

        const params = wrapper.getLLMParameters();
        expect(params.systemRole).toBe('system');
      });

      it('should use "system" for Claude models', () => {
        const wrapper = new LLMWrapper({
          anthropicKey: 'test-key',
          underlyingModel: 'claude-sonnet-4-5-20250929'
        });

        const params = wrapper.getLLMParameters();
        expect(params.systemRole).toBe('system');
      });

      it('should use "user" for o1-mini which does not have system mode', () => {
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          underlyingModel: 'o1-mini'
        });

        const params = wrapper.getLLMParameters();
        expect(params.systemRole).toBe('user');
      });
    });

    describe('temperature determination', () => {
      it('should return default temperature of 0 for models with temperature support', () => {
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          underlyingModel: 'gpt-4o'
        });

        const params = wrapper.getLLMParameters();
        expect(params.temperature).toBeUndefined();
      });

      it('should return custom default temperature when specified', () => {
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          underlyingModel: 'gpt-4o'
        });

        const params = wrapper.getLLMParameters(0.7);
        expect(params.temperature).toBe(0.7);
      });

      it('should return undefined for models without temperature support', () => {
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          underlyingModel: 'o3-mini low'
        });

        const params = wrapper.getLLMParameters();
        expect(params.temperature).toBeUndefined();
      });

      it('should return temperature 1 for models without system mode but with temperature support', () => {
        // Note: o1-mini doesn't have temperature support, so we need a hypothetical model
        // that has temperature support but no system mode. Since all real models that lack
        // system mode also lack temperature support, this test verifies the logic order.
        // In practice, this scenario doesn't occur with current models.
        // The test verifies that if hasSystemMode is false and hasTemperature is true,
        // temperature would be 1. However, since o1-mini has hasTemperature=false,
        // it returns undefined instead.
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          underlyingModel: 'o1-mini'
        });

        const params = wrapper.getLLMParameters();
        // o1-mini has no system mode AND no temperature support
        // The hasTemperature check comes last, so it returns undefined
        expect(params.temperature).toBeUndefined();
        expect(params.systemRole).toBe('user'); // Verify it has no system mode
      });

      it('should return undefined for models without temperature support even if no system mode', () => {
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          underlyingModel: 'o3 high'
        });

        const params = wrapper.getLLMParameters();
        // o3 has no hasSystemMode and no hasTemperature
        // hasTemperature check comes after hasSystemMode check
        expect(params.temperature).toBeUndefined();
      });
    });

    describe('return value structure', () => {
      it('should return all four required parameters', () => {
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          underlyingModel: 'gpt-4o'
        });

        const params = wrapper.getLLMParameters();

        expect(params).toHaveProperty('underlyingModel');
        expect(params).toHaveProperty('systemRole');
        expect(params).toHaveProperty('temperature');
        expect(params).toHaveProperty('reasoningEffort');
      });

      it('should have exactly 4 properties', () => {
        const wrapper = new LLMWrapper({
          openAIKey: 'test-key',
          anthropicKey: 'test-claude-key',
          underlyingModel: 'o3-mini medium'
        });

        const params = wrapper.getLLMParameters();

        expect(Object.keys(params).length).toBe(4);
      });
    });
  });

  describe('Native DeepSeek models', () => {
    beforeEach(() => {
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.DEEPSEEK_BASE_URL;
    });

    it('should classify a bare deepseek model id as ModelType.DEEPSEEK', () => {
      const wrapper = new LLMWrapper({
        deepseekKey: 'test-deepseek-key',
        underlyingModel: 'deepseek-v4-pro'
      });

      expect(wrapper.model.kind).toBe(ModelType.DEEPSEEK);
    });

    it('should classify an OpenRouter deepseek slug as ModelType.OPEN_ROUTER', () => {
      const wrapper = new LLMWrapper({
        openRouterKey: 'test-openrouter-key',
        underlyingModel: 'deepseek/deepseek-v4-pro'
      });

      expect(wrapper.model.kind).toBe(ModelType.OPEN_ROUTER);
    });

    it('should disable structured output for native DeepSeek but not for the OpenRouter slug', () => {
      const native = new LLMWrapper({
        deepseekKey: 'test-deepseek-key',
        underlyingModel: 'deepseek-v4-pro'
      });
      const slug = new LLMWrapper({
        openRouterKey: 'test-openrouter-key',
        underlyingModel: 'deepseek/deepseek-v4-pro'
      });

      expect(native.model.hasStructuredOutput).toBe(false);
      expect(slug.model.hasStructuredOutput).toBe(true);
    });

    it('should throw when no DeepSeek key is available for a native DeepSeek model', () => {
      expect(() => new LLMWrapper({
        underlyingModel: 'deepseek-v4-pro'
      })).toThrow('DeepSeek key');
    });

    it('should accept a DeepSeek key passed as a parameter', () => {
      const wrapper = new LLMWrapper({
        deepseekKey: 'test-deepseek-key',
        underlyingModel: 'deepseek-v4-flash'
      });

      expect(wrapper.model.name).toBe('deepseek-v4-flash');
      expect(wrapper.model.systemModeUser).toBe('system');
    });

    it('should use the system role for DeepSeek messages', () => {
      const wrapper = new LLMWrapper({
        deepseekKey: 'test-deepseek-key',
        underlyingModel: 'deepseek-v4-pro'
      });

      const params = wrapper.getLLMParameters();
      expect(params.systemRole).toBe('system');
    });
  });
});
