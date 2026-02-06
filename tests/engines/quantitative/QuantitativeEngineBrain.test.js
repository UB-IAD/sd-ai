import QuantitativeEngineBrain from '../../../engines/quantitative/QuantitativeEngineBrain.js';
import { LLMWrapper } from '../../../utilities/LLMWrapper.js';

describe('QuantitativeEngineBrain', () => {
  let quantitativeEngine;

  beforeEach(() => {
    quantitativeEngine = new QuantitativeEngineBrain({
      openAIKey: 'test-key',
      googleKey: 'test-google-key'
    });
  });

  describe('processResponse', () => {
    it('should trim from and to variables and validate relationships exist in variables', async () => {
      const originalResponse = {
        variables: [
          { name: 'Population', type: 'stock', equation: '1000', inflows: ['Birth Rate'], outflows: [] },
          { name: 'Birth Rate', type: 'flow', equation: '0.05 * Population' }
        ],
        relationships: [
          {
            from: '  Population  ',
            to: '  Birth Rate  ',
            polarity: '+',
            reasoning: 'More population leads to more births',
            polarityReasoning: 'Direct correlation'
          }
        ]
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.relationships).toHaveLength(1);
      expect(result.relationships[0].from).toBe('Population');
      expect(result.relationships[0].to).toBe('Birth Rate');
      expect(result.relationships[0].valid).toBeUndefined();
    });

    it('should filter out relationships where variables do not exist in variables array', async () => {
      const originalResponse = {
        variables: [
          { name: 'Population', type: 'stock', equation: '1000', inflows: [], outflows: [] }
        ],
        relationships: [
          {
            from: 'Population',
            to: 'Birth Rate',  // Does not exist in variables
            polarity: '+',
            reasoning: 'Valid from, invalid to',
            polarityReasoning: 'Missing variable'
          },
          {
            from: 'Death Rate',  // Does not exist in variables
            to: 'Population',
            polarity: '+',
            reasoning: 'Invalid from, valid to',
            polarityReasoning: 'Missing variable'
          }
        ]
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.relationships).toHaveLength(0);
    });

    it('should filter out self-referencing relationships', async () => {
      const originalResponse = {
        variables: [
          { name: 'Population', type: 'stock', equation: '1000', inflows: ['Birth Rate'], outflows: [] },
          { name: 'Birth Rate', type: 'flow', equation: '0.05 * Population' }
        ],
        relationships: [
          {
            from: 'Population',
            to: 'Population',  // Self-reference
            polarity: '+',
            reasoning: 'Self reference',
            polarityReasoning: 'Same variable'
          },
          {
            from: 'Population',
            to: 'Birth Rate',
            polarity: '+',
            reasoning: 'Valid relationship',
            polarityReasoning: 'Different variables'
          }
        ]
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.relationships).toHaveLength(1);
      expect(result.relationships[0].from).toBe('Population');
      expect(result.relationships[0].to).toBe('Birth Rate');
    });

    it('should remove duplicate relationships keeping the first occurrence', async () => {
      const originalResponse = {
        variables: [
          { name: 'Population', type: 'stock', equation: '1000', inflows: ['Birth Rate'], outflows: ['Death Rate'] },
          { name: 'Birth Rate', type: 'flow', equation: '0.05 * Population' },
          { name: 'Death Rate', type: 'flow', equation: '0.02 * Population' }
        ],
        relationships: [
          {
            from: 'Population',
            to: 'Birth Rate',
            polarity: '+',
            reasoning: 'First occurrence',
            polarityReasoning: 'First reasoning'
          },
          {
            from: 'Population',
            to: 'Death Rate',
            polarity: '+',
            reasoning: 'Different relationship',
            polarityReasoning: 'Different reasoning'
          },
          {
            from: 'Population',
            to: 'Birth Rate',
            polarity: '-',
            reasoning: 'Duplicate occurrence',
            polarityReasoning: 'Different reasoning'
          }
        ]
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.relationships).toHaveLength(2);
      expect(result.relationships[0].from).toBe('Population');
      expect(result.relationships[0].to).toBe('Birth Rate');
      expect(result.relationships[0].reasoning).toBe('First occurrence');
      expect(result.relationships[1].from).toBe('Population');
      expect(result.relationships[1].to).toBe('Death Rate');
    });

    it('should convert unused flows to variable type', async () => {
      const originalResponse = {
        variables: [
          { name: 'Population', type: 'stock', equation: '1000', inflows: ['Birth Rate'], outflows: ['Death Rate'] },
          { name: 'Birth Rate', type: 'flow', equation: '0.05 * Population' },
          { name: 'Death Rate', type: 'flow', equation: '0.02 * Population' },
          { name: 'Unused Flow', type: 'flow', equation: '10' }  // Not used in any stock
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      const unusedFlow = result.variables.find(v => v.name === 'Unused Flow');
      const usedBirthRate = result.variables.find(v => v.name === 'Birth Rate');
      const usedDeathRate = result.variables.find(v => v.name === 'Death Rate');

      expect(unusedFlow.type).toBe('variable');
      expect(usedBirthRate.type).toBe('flow');
      expect(usedDeathRate.type).toBe('flow');
    });

    it('should handle flows used in both inflows and outflows', async () => {
      const originalResponse = {
        variables: [
          { name: 'Stock A', type: 'stock', equation: '100', inflows: ['Transfer Flow'], outflows: [] },
          { name: 'Stock B', type: 'stock', equation: '200', inflows: [], outflows: ['Transfer Flow'] },
          { name: 'Transfer Flow', type: 'flow', equation: '5' }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      const transferFlow = result.variables.find(v => v.name === 'Transfer Flow');
      expect(transferFlow.type).toBe('flow');
    });

    it('should handle case-insensitive duplicate detection with trimming', async () => {
      const originalResponse = {
        variables: [
          { name: 'Population', type: 'stock', equation: '1000', inflows: ['Birth Rate'], outflows: [] },
          { name: 'Birth Rate', type: 'flow', equation: '0.05 * Population' }
        ],
        relationships: [
          {
            from: 'Population',
            to: 'Birth Rate',
            polarity: '+',
            reasoning: 'First occurrence',
            polarityReasoning: 'First reasoning'
          },
          {
            from: '  POPULATION  ',
            to: '  birth_rate  ',
            polarity: '-',
            reasoning: 'Should be filtered out',
            polarityReasoning: 'Duplicate'
          }
        ]
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.relationships).toHaveLength(1);
      expect(result.relationships[0].from).toBe('Population');
      expect(result.relationships[0].to).toBe('Birth Rate');
      expect(result.relationships[0].reasoning).toBe('First occurrence');
    });

    it('should handle empty relationships and variables arrays', async () => {
      const originalResponse = {
        variables: [],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.variables).toHaveLength(0);
      expect(result.relationships).toHaveLength(0);
    });

    it('should handle missing relationships or variables properties', async () => {
      const originalResponse = {
        variables: [
          { name: 'Population', type: 'stock', equation: '1000' }
        ]
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.relationships).toHaveLength(0);
      expect(result.variables).toHaveLength(1);
    });

    it('should preserve all other properties of the original response', async () => {
      const originalResponse = {
        explanation: 'Test explanation',
        title: 'Test title',
        specs: {
          startTime: 0,
          stopTime: 100,
          dt: 0.25,
          timeUnits: 'years'
        },
        variables: [
          { name: 'A', type: 'variable', equation: '10' }
        ],
        relationships: [
          {
            from: 'A',
            to: 'A',  // Invalid self-reference
            polarity: '+',
            reasoning: 'Test reasoning',
            polarityReasoning: 'Test polarity reasoning'
          }
        ]
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.title).toBe('Test title');
      expect(result.specs).toEqual({
        startTime: 0,
        stopTime: 100,
        dt: 0.25,
        timeUnits: 'years'
      });
      expect(result.relationships).toHaveLength(0); // Invalid self-reference filtered out
    });

    it('should remove the valid property from processed relationships', async () => {
      const originalResponse = {
        variables: [
          { name: 'A', type: 'variable', equation: '10' },
          { name: 'B', type: 'variable', equation: '20' }
        ],
        relationships: [
          {
            from: 'A',
            to: 'B',
            polarity: '+',
            reasoning: 'Valid relationship',
            polarityReasoning: 'Test reasoning'
          }
        ]
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.relationships[0].valid).toBeUndefined();
      expect(result.relationships[0].from).toBe('A');
      expect(result.relationships[0].to).toBe('B');
      expect(result.relationships[0].polarity).toBe('+');
      expect(result.relationships[0].reasoning).toBe('Valid relationship');
      expect(result.relationships[0].polarityReasoning).toBe('Test reasoning');
    });

    it('should handle complex scenario with multiple stocks, flows and relationships', async () => {
      const originalResponse = {
        variables: [
          { 
            name: 'Population', 
            type: 'stock', 
            equation: '1000',
            inflows: ['Birth Rate'], 
            outflows: ['Death Rate']
          },
          { 
            name: 'Birth Rate', 
            type: 'flow', 
            equation: '0.05 * Population'
          },
          { 
            name: 'Death Rate', 
            type: 'flow', 
            equation: '0.02 * Population'
          },
          { 
            name: 'Unused Flow', 
            type: 'flow', 
            equation: '10'
          },
          { 
            name: 'Life Expectancy', 
            type: 'variable', 
            equation: '75'
          }
        ],
        relationships: [
          {
            from: 'Population',
            to: 'Population',  // Invalid self-reference
            polarity: '+',
            reasoning: 'Self reference',
            polarityReasoning: 'Invalid'
          },
          {
            from: '  Population  ',
            to: '  Birth Rate  ',
            polarity: '+',
            reasoning: 'Population affects birth rate',
            polarityReasoning: 'More people, more births'
          },
          {
            from: 'population',  // Duplicate of above (case insensitive)
            to: 'BIRTH_RATE',
            polarity: '-',
            reasoning: 'Should be filtered',
            polarityReasoning: 'Duplicate'
          },
          {
            from: 'Life Expectancy',
            to: 'Death Rate',
            polarity: '-',
            reasoning: 'Higher life expectancy reduces death rate',
            polarityReasoning: 'Negative correlation'
          },
          {
            from: 'Nonexistent Variable',  // Variable doesn't exist
            to: 'Population',
            polarity: '+',
            reasoning: 'Should be filtered',
            polarityReasoning: 'Missing variable'
          }
        ]
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      // Check relationships - should have 2 valid ones
      expect(result.relationships).toHaveLength(2);
      expect(result.relationships[0].from).toBe('Population');
      expect(result.relationships[0].to).toBe('Birth Rate');
      expect(result.relationships[1].from).toBe('Life Expectancy');
      expect(result.relationships[1].to).toBe('Death Rate');

      // Check variables - unused flow should be converted to variable type
      const unusedFlow = result.variables.find(v => v.name === 'Unused Flow');
      const birthRate = result.variables.find(v => v.name === 'Birth Rate');
      const deathRate = result.variables.find(v => v.name === 'Death Rate');
      const population = result.variables.find(v => v.name === 'Population');
      
      expect(unusedFlow.type).toBe('variable');
      expect(birthRate.type).toBe('flow');
      expect(deathRate.type).toBe('flow');
      expect(population.type).toBe('stock');
    });

    it('should handle stocks with empty inflows and outflows arrays', async () => {
      const originalResponse = {
        variables: [
          { name: 'Stock A', type: 'stock', equation: '100', inflows: [], outflows: [] },
          { name: 'Flow A', type: 'flow', equation: '5' }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      const flowA = result.variables.find(v => v.name === 'Flow A');
      expect(flowA.type).toBe('variable'); // Should be converted since not used
    });

    it('should handle stocks without inflows or outflows properties', async () => {
      const originalResponse = {
        variables: [
          { name: 'Stock A', type: 'stock', equation: '100', inflows: [], outflows: [] },
          { name: 'Flow A', type: 'flow', equation: '5' }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      const flowA = result.variables.find(v => v.name === 'Flow A');
      expect(flowA.type).toBe('variable'); // Should be converted since not used
    });
  });

  describe('setupLLMParameters', () => {
    it('should setup basic LLM parameters with default model', () => {
      const userPrompt = 'Test prompt';
      const result = quantitativeEngine.setupLLMParameters(userPrompt);

      expect(result.model).toBe(LLMWrapper.DEFAULT_MODEL);
      expect(result.temperature).toBe(0);
      expect(result.reasoningEffort).toBeUndefined();
      expect(result.responseFormat).toBeDefined();
      expect(result.messages).toBeInstanceOf(Array);
      expect(result.messages.length).toBeGreaterThan(0);
      expect(result.messages[result.messages.length - 1].content).toBe(userPrompt);
    });

    it('should handle o3-mini model with reasoning effort', () => {
      const engineWithO3Mini = new QuantitativeEngineBrain({
        openAIKey: 'test-key',
        googleKey: 'test-google-key',
        underlyingModel: 'o3-mini low'
      });

      const result = engineWithO3Mini.setupLLMParameters('Test prompt');

      expect(result.model).toBe('o3-mini');
      expect(result.reasoningEffort).toBe('low');
    });

    it('should handle o3 model with reasoning effort', () => {
      const engineWithO3 = new QuantitativeEngineBrain({
        openAIKey: 'test-key',
        googleKey: 'test-google-key',
        underlyingModel: 'o3 high'
      });

      const result = engineWithO3.setupLLMParameters('Test prompt');

      expect(result.model).toBe('o3');
      expect(result.reasoningEffort).toBe('high');
    });

    it('should throw error when model lacks structured output support', () => {
      const engineWithoutStructured = new QuantitativeEngineBrain({
        openAIKey: 'test-key',
        googleKey: 'test-google-key',
        underlyingModel: 'o1-mini'
      });

      expect(() => {
        engineWithoutStructured.setupLLMParameters('Test prompt');
      }).toThrow('Unsupported LLM o1-mini it does support structured outputs which are required.');
    });

    it('should set system role to user and temperature to 1 when model lacks system mode', () => {
      const engineWithoutSystemMode = new QuantitativeEngineBrain({
        openAIKey: 'test-key',
        googleKey: 'test-google-key',
        underlyingModel: 'llama'
      });

      const result = engineWithoutSystemMode.setupLLMParameters('Test prompt');

      expect(result.messages[0].role).toBe('system');
      expect(result.temperature).toBe(0);
    });

    it('should set temperature to undefined when model lacks temperature support', () => {
      const engineWithO3 = new QuantitativeEngineBrain({
        openAIKey: 'test-key',
        googleKey: 'test-google-key',
        underlyingModel: 'o3'  // o3 model doesn't support temperature
      });

      const result = engineWithO3.setupLLMParameters('Test prompt');

      expect(result.temperature).toBeUndefined();
    });

    it('should include background knowledge in messages when provided', () => {
      const engineWithBackground = new QuantitativeEngineBrain({
        openAIKey: 'test-key',
        googleKey: 'test-google-key',
        backgroundKnowledge: 'Important context information'
      });

      const result = engineWithBackground.setupLLMParameters('Test prompt');

      const backgroundMessage = result.messages.find(m => m.content.includes('Important context information'));
      expect(backgroundMessage).toBeDefined();
      expect(backgroundMessage.role).toBe('user');
    });

    it('should include problem statement in messages when provided', () => {
      const engineWithProblem = new QuantitativeEngineBrain({
        openAIKey: 'test-key',
        googleKey: 'test-google-key',
        problemStatement: 'Create population dynamics model'
      });

      const result = engineWithProblem.setupLLMParameters('Test prompt');

      const problemMessage = result.messages.find(m => m.content.includes('Create population dynamics model'));
      expect(problemMessage).toBeDefined();
    });

    it('should include lastModel and assistant prompt when lastModel is provided', () => {
      const lastModel = {
        variables: [
          { name: 'Population', type: 'stock', equation: '1000' }
        ],
        relationships: [
          { from: 'A', to: 'B', polarity: '+' }
        ]
      };

      const result = quantitativeEngine.setupLLMParameters('Test prompt', lastModel);

      const assistantMessage = result.messages.find(m => m.role === 'assistant');
      expect(assistantMessage).toBeDefined();
      expect(assistantMessage.content).toContain('Population');
      
      const assistantPromptMessage = result.messages.find(m => 
        m.role === 'user' && m.content.includes('consider the model which you have already')
      );
      expect(assistantPromptMessage).toBeDefined();
    });

    it('should not include assistant prompt when lastModel is not provided', () => {
      const result = quantitativeEngine.setupLLMParameters('Test prompt');

      const assistantMessage = result.messages.find(m => m.role === 'assistant');
      expect(assistantMessage).toBeUndefined();

      const assistantPromptMessage = result.messages.find(m => 
        m.role === 'user' && m.content.includes('consider the model which you have already')
      );
      expect(assistantPromptMessage).toBeUndefined();
    });

    it('should include user prompt as last message', () => {
      const result = quantitativeEngine.setupLLMParameters('Test prompt');

      const lastMessage = result.messages[result.messages.length - 1];
      expect(lastMessage.content).toBe('Test prompt');
      expect(lastMessage.role).toBe('user');
    });

    it('should handle custom prompts', () => {
      const engineWithCustomPrompts = new QuantitativeEngineBrain({
        openAIKey: 'test-key',
        googleKey: 'test-google-key',
        systemPrompt: 'Custom quantitative system prompt',
        assistantPrompt: 'Custom quantitative assistant prompt'
      });

      const lastModel = {
        variables: [{ name: 'Test', type: 'variable', equation: '10' }],
        relationships: [{ from: 'X', to: 'Y', polarity: '+' }]
      };
      const result = engineWithCustomPrompts.setupLLMParameters('Test prompt', lastModel);

      const systemMessage = result.messages[0];
      expect(systemMessage.content).toBe('Custom quantitative system prompt');

      const assistantPromptMessage = result.messages.find(m =>
        m.content === 'Custom quantitative assistant prompt'
      );
      expect(assistantPromptMessage).toBeDefined();
    });

    it('should properly order messages in the conversation', () => {
      const engineWithAll = new QuantitativeEngineBrain({
        openAIKey: 'test-key',
        googleKey: 'test-google-key',
        backgroundKnowledge: 'Background info',
        problemStatement: 'Problem to solve'
      });

      const lastModel = {
        variables: [{ name: 'Test', type: 'variable', equation: '10' }],
        relationships: [{ from: 'A', to: 'B', polarity: '+' }]
      };
      const result = engineWithAll.setupLLMParameters('User prompt', lastModel);

      expect(result.messages[0].role).toBe('system');
      expect(result.messages[1].role).toBe('user');
      expect(result.messages[1].content).toContain('Background info');
      expect(result.messages[2].role).toBe('system');
      expect(result.messages[2].content).toContain('Problem to solve');
      expect(result.messages[3].role).toBe('assistant');
      expect(result.messages[4].role).toBe('user');
      expect(result.messages[5].content).toBe('User prompt');
      expect(result.messages.length).toBe(6);
    });

    it('should handle edge case with null lastModel', () => {
      const result = quantitativeEngine.setupLLMParameters('Test prompt', null);

      const assistantMessage = result.messages.find(m => m.role === 'assistant');
      expect(assistantMessage).toBeUndefined();
      expect(result.messages[result.messages.length - 1].content).toBe('Test prompt');
    });

    it('should handle edge case with undefined lastModel', () => {
      const result = quantitativeEngine.setupLLMParameters('Test prompt', undefined);

      const assistantMessage = result.messages.find(m => m.role === 'assistant');
      expect(assistantMessage).toBeUndefined();
      expect(result.messages[result.messages.length - 1].content).toBe('Test prompt');
    });

    it('should return all required parameters for OpenAI API call', () => {
      const result = quantitativeEngine.setupLLMParameters('Test prompt');

      expect(result).toHaveProperty('messages');
      expect(result).toHaveProperty('model');
      expect(result).toHaveProperty('responseFormat');
      expect(result).toHaveProperty('temperature');
      expect(result).toHaveProperty('reasoningEffort');

      expect(Array.isArray(result.messages)).toBe(true);
      expect(typeof result.model).toBe('string');
    });
  });
});