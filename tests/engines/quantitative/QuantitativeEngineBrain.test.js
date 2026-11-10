import QuantitativeEngineBrain from '../../../engines/quantitative/QuantitativeEngineBrain.js';
import { LLMWrapper } from '../../../utilities/LLMWrapper.js';

describe('QuantitativeEngineBrain', () => {
  let quantitativeEngine;

  beforeEach(() => {
    quantitativeEngine = new QuantitativeEngineBrain({
      openAIKey: 'test-key',
      anthropicKey: 'test-claude-key',
      googleKey: 'test-google-key'
    });
  });

  describe('generateSystemPrompt arrays', () => {
    it('lets dimensions named in the request through when arrays are supported', () => {
      const prompt = QuantitativeEngineBrain.generateSystemPrompt(false, true, false, false);
      expect(prompt).toContain('that the request names as dimensions');
      expect(prompt).toContain('Never invent a dimension the request does not name');
      expect(prompt).not.toContain('Only introduce arrays when specifically asked by the user');
    });

    it('has no array section when arrays are not supported', () => {
      const prompt = QuantitativeEngineBrain.generateSystemPrompt(false, false, false, false);
      expect(prompt).not.toContain('WHEN TO USE ARRAYS');
    });
  });

  describe('delay marks', () => {
    it('tells the model a delay mark is structure, not a DELAY function', () => {
      const prompt = QuantitativeEngineBrain.generateSystemPrompt(false, false, false, false);
      expect(prompt).toContain('DELAYS AND DELAY MARKS');
      expect(prompt).toContain('NEVER wrap a link in DELAY or SMTH just because a diagram marked it');
      expect(QuantitativeEngineBrain.DEFAULT_SYSTEM_PROMPT).toContain('DELAYS AND DELAY MARKS');
    });

    it('asks for a required delay mark on every relationship', () => {
      const schema = quantitativeEngine.setupLLMParameters('Test prompt').responseFormat;
      const relationship = schema.shape.relationships.element;
      expect(relationship.shape.delay).toBeDefined();
      expect(relationship.safeParse({ from: 'a', to: 'b', reasoning: '', polarityReasoning: '', polarity: '+' }).success).toBe(false);
      expect(relationship.safeParse({ from: 'a', to: 'b', reasoning: '', polarityReasoning: '', polarity: '+', delay: false }).success).toBe(true);
      expect(relationship.shape.delay.description).toContain('changes no equation');
    });

    it('shows existing delay marks in the prior model so they can be copied', () => {
      const lastModel = {
        variables: [{ name: 'A', type: 'variable', equation: '1' }, { name: 'B', type: 'variable', equation: 'A' }],
        relationships: [{ from: 'A', to: 'B', polarity: '+', delay: true }]
      };
      const result = quantitativeEngine.setupLLMParameters('Test prompt', lastModel);
      const prior = JSON.parse(result.messages.find(m => m.role === 'assistant').content);
      expect(prior.relationships[0].delay).toBe(true);
    });

    it('keeps the delay mark the model returns', async () => {
      const result = await quantitativeEngine.processResponse({
        variables: [
          { name: 'A', type: 'variable', equation: '1', inflows: [], outflows: [] },
          { name: 'B', type: 'variable', equation: 'A', inflows: [], outflows: [] }
        ],
        relationships: [{ from: 'A', to: 'B', polarity: '+', reasoning: '', polarityReasoning: '', delay: true }]
      });
      expect(result.relationships[0].delay).toBe(true);
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

    it('should create modules array from variable names with module prefixes', async () => {
      const originalResponse = {
        variables: [
          { name: 'Hares.population', type: 'stock', equation: '5000', inflows: [], outflows: [] },
          { name: 'Hares.birth_rate', type: 'variable', equation: '0.1' },
          { name: 'Lynx.population', type: 'stock', equation: '100', inflows: [], outflows: [] },
          { name: 'Lynx.death_rate', type: 'variable', equation: '0.05' }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.modules).toBeDefined();
      expect(result.modules).toHaveLength(2);

      const haresModule = result.modules.find(m => m.name === 'Hares');
      const lynxModule = result.modules.find(m => m.name === 'Lynx');

      expect(haresModule).toBeDefined();
      expect(haresModule.parentModule).toBe('');
      expect(lynxModule).toBeDefined();
      expect(lynxModule.parentModule).toBe('');
    });

    it('should remove unused modules from modules array', async () => {
      const originalResponse = {
        variables: [
          { name: 'Hares.population', type: 'stock', equation: '5000', inflows: [], outflows: [] }
        ],
        modules: [
          { name: 'Hares', parentModule: '' },
          { name: 'Lynx', parentModule: '' }, // Not used
          { name: 'Wolves', parentModule: '' } // Not used
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.modules).toHaveLength(1);
      expect(result.modules[0].name).toBe('Hares');
      expect(result.modules[0].parentModule).toBe('');
    });

    it('should preserve existing module parentModule values', async () => {
      const originalResponse = {
        variables: [
          { name: 'Child.variable', type: 'variable', equation: '10' },
          { name: 'parent.variable', type: 'variable', equation: '11'}
        ],
        modules: [
          { name: 'Parent', parentModule: '' },
          { name: 'Child', parentModule: 'Parent' }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.modules).toHaveLength(2);

      const parentModule = result.modules.find(m => m.name === 'Parent');
      const childModule = result.modules.find(m => m.name === 'Child');

      expect(parentModule.parentModule).toBe('');
      expect(childModule.parentModule).toBe('Parent');
    });

    it('should handle case-insensitive module name matching', async () => {
      const originalResponse = {
        variables: [
          { name: 'Hares.population', type: 'stock', equation: '5000', inflows: [], outflows: [] },
          { name: 'HARES.birth_rate', type: 'variable', equation: '0.1' },
          { name: 'hares.death_rate', type: 'variable', equation: '0.05' }
        ],
        modules: [
          { name: 'Hares', parentModule: '' }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.modules).toHaveLength(1);
      expect(result.modules[0].name).toBe('Hares'); // Preserves original capitalization
    });

    it('should add missing modules while preserving existing ones', async () => {
      const originalResponse = {
        variables: [
          { name: 'Hares.population', type: 'stock', equation: '5000', inflows: [], outflows: [] },
          { name: 'Lynx.population', type: 'stock', equation: '100', inflows: [], outflows: [] }
        ],
        modules: [
          { name: 'Hares', parentModule: '' }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.modules).toHaveLength(2);

      const haresModule = result.modules.find(m => m.name === 'Hares');
      const lynxModule = result.modules.find(m => m.name === 'Lynx');

      expect(haresModule).toBeDefined();
      expect(haresModule.parentModule).toBe('');
      expect(lynxModule).toBeDefined();
      expect(lynxModule.parentModule).toBe('');
    });

    it('should use canonical capitalization from first variable reference for new modules', async () => {
      const originalResponse = {
        variables: [
          { name: 'MyModule.var1', type: 'variable', equation: '10' },
          { name: 'MYMODULE.var2', type: 'variable', equation: '20' },
          { name: 'mymodule.var3', type: 'variable', equation: '30' }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.modules).toHaveLength(1);
      expect(result.modules[0].name).toBe('MyModule'); // Uses first occurrence capitalization
    });

    it('should handle variables without module prefixes', async () => {
      const originalResponse = {
        variables: [
          { name: 'population', type: 'stock', equation: '1000', inflows: [], outflows: [] },
          { name: 'birth_rate', type: 'variable', equation: '0.05' }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.modules).toBeDefined();
      expect(result.modules).toHaveLength(0);
    });

    it('should handle mix of modular and non-modular variables', async () => {
      const originalResponse = {
        variables: [
          { name: 'Hares.population', type: 'stock', equation: '5000', inflows: [], outflows: [] },
          { name: 'global_parameter', type: 'variable', equation: '10' },
          { name: 'Lynx.population', type: 'stock', equation: '100', inflows: [], outflows: [] }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.modules).toHaveLength(2);

      const haresModule = result.modules.find(m => m.name === 'Hares');
      const lynxModule = result.modules.find(m => m.name === 'Lynx');

      expect(haresModule).toBeDefined();
      expect(lynxModule).toBeDefined();
    });

    it('should initialize empty modules array if not present', async () => {
      const originalResponse = {
        variables: [
          { name: 'simple_variable', type: 'variable', equation: '10' }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.modules).toBeDefined();
      expect(Array.isArray(result.modules)).toBe(true);
      expect(result.modules).toHaveLength(0);
    });

    it('should convert variable names with spaces to underscores in equations (XMILE format)', async () => {
      const originalResponse = {
        variables: [
          { name: 'total population', type: 'stock', equation: '1000', inflows: ['birth rate'], outflows: ['death rate'] },
          { name: 'birth rate', type: 'flow', equation: 'total population * birth fraction' },
          { name: 'death rate', type: 'flow', equation: 'total population * death fraction' },
          { name: 'birth fraction', type: 'variable', equation: '0.05' },
          { name: 'death fraction', type: 'variable', equation: '0.02' },
          { name: 'net growth', type: 'variable', equation: 'birth rate - death rate' }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      // Check that equations now use underscores instead of spaces
      const birthRate = result.variables.find(v => v.name === 'birth rate');
      const deathRate = result.variables.find(v => v.name === 'death rate');
      const netGrowth = result.variables.find(v => v.name === 'net growth');

      expect(birthRate.equation).toBe('total_population * birth_fraction');
      expect(deathRate.equation).toBe('total_population * death_fraction');
      expect(netGrowth.equation).toBe('birth_rate - death_rate');
    });

    it('should convert variable names with spaces in complex equations', async () => {
      const originalResponse = {
        variables: [
          { name: 'total revenue', type: 'variable', equation: '1000' },
          { name: 'operating costs', type: 'variable', equation: '500' },
          { name: 'net profit', type: 'variable', equation: '(total revenue - operating costs) / total revenue' },
          { name: 'profit margin', type: 'variable', equation: 'IF net profit > 0 THEN net profit ELSE 0' }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      const netProfit = result.variables.find(v => v.name === 'net profit');
      const profitMargin = result.variables.find(v => v.name === 'profit margin');

      expect(netProfit.equation).toBe('(total_revenue - operating_costs) / total_revenue');
      expect(profitMargin.equation).toBe('IF net_profit > 0 THEN net_profit ELSE 0');
    });

    it('should convert variable names in arrayEquations', async () => {
      const originalResponse = {
        variables: [
          {
            name: 'product sales',
            type: 'variable',
            dimensions: ['Product'],
            arrayEquations: [
              { forElements: ['Pizza'], equation: 'base demand * price multiplier' },
              { forElements: ['Kebab'], equation: 'base demand * price multiplier * 0.8' }
            ]
          },
          { name: 'base demand', type: 'variable', equation: '1000' },
          { name: 'price multiplier', type: 'variable', equation: '1.2' }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      const productSales = result.variables.find(v => v.name === 'product sales');

      expect(productSales.arrayEquations[0].equation).toBe('base_demand * price_multiplier');
      expect(productSales.arrayEquations[1].equation).toBe('base_demand * price_multiplier * 0.8');
    });

    it('should not replace variable names that are substrings of other names', async () => {
      const originalResponse = {
        variables: [
          { name: 'rate', type: 'variable', equation: '0.05' },
          { name: 'birth rate', type: 'variable', equation: 'rate * 2' },
          { name: 'total birth rate', type: 'variable', equation: 'birth rate * population' },
          { name: 'population', type: 'stock', equation: '1000', inflows: [], outflows: [] }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      const birthRate = result.variables.find(v => v.name === 'birth rate');
      const totalBirthRate = result.variables.find(v => v.name === 'total birth rate');

      // Should replace 'rate' with 'rate' (no spaces, stays the same)
      expect(birthRate.equation).toBe('rate * 2');

      // Should replace 'birth rate' with 'birth_rate' and 'population' with 'population'
      expect(totalBirthRate.equation).toBe('birth_rate * population');
    });

    it('should handle variables without spaces in names (already XMILE format)', async () => {
      const originalResponse = {
        variables: [
          { name: 'population', type: 'stock', equation: '1000', inflows: ['birth_rate'], outflows: [] },
          { name: 'birth_rate', type: 'flow', equation: 'population * 0.05' }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      const birthRate = result.variables.find(v => v.name === 'birth_rate');

      // Should remain unchanged
      expect(birthRate.equation).toBe('population * 0.05');
    });

    it('should initialize variables array when missing', async () => {
      const originalResponse = {
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.variables).toBeDefined();
      expect(Array.isArray(result.variables)).toBe(true);
      expect(result.variables).toHaveLength(0);
    });

    it('should filter out relationships whose target is a cross-level ghost variable', async () => {
      const originalResponse = {
        variables: [
          { name: 'Hares.Hares', type: 'stock', equation: '5000', inflows: [], outflows: [] },
          { name: 'Lynx.Lynx', type: 'stock', equation: '100', inflows: [], outflows: [] },
          { name: 'Hares.Lynx', type: 'variable', equation: '', crossLevelGhostOf: 'Lynx.Lynx' }
        ],
        relationships: [
          {
            from: 'Hares.Hares',
            to: 'Hares.Lynx',
            polarity: '+',
            reasoning: 'Should be filtered because target is a ghost',
            polarityReasoning: 'Ghost target'
          },
          {
            from: 'Hares.Hares',
            to: 'Lynx.Lynx',
            polarity: '+',
            reasoning: 'Valid relationship targeting source',
            polarityReasoning: 'Real target'
          }
        ]
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.relationships).toHaveLength(1);
      expect(result.relationships[0].to).toBe('Lynx.Lynx');
    });

    it('should filter out relationships that reference array elements with bracket notation', async () => {
      const originalResponse = {
        variables: [
          { name: 'Revenue', type: 'variable', equation: '0' },
          { name: 'Total', type: 'variable', equation: '0' }
        ],
        relationships: [
          {
            from: 'Revenue[Pizza]',
            to: 'Total',
            polarity: '+',
            reasoning: 'Bracket in from',
            polarityReasoning: 'Should be filtered'
          },
          {
            from: 'Revenue',
            to: 'Total[NYC]',
            polarity: '+',
            reasoning: 'Bracket in to',
            polarityReasoning: 'Should be filtered'
          },
          {
            from: 'Revenue',
            to: 'Total',
            polarity: '+',
            reasoning: 'Valid',
            polarityReasoning: 'OK'
          }
        ]
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.relationships).toHaveLength(1);
      expect(result.relationships[0].from).toBe('Revenue');
      expect(result.relationships[0].to).toBe('Total');
    });

    it('should strip array bracket notation from stock inflow/outflow names', async () => {
      const originalResponse = {
        variables: [
          {
            name: 'Population',
            type: 'stock',
            equation: '1000',
            inflows: ['birth rate[Region]'],
            outflows: ['death rate[Region, Age]']
          },
          { name: 'birth rate', type: 'flow', equation: '50' },
          { name: 'death rate', type: 'flow', equation: '10' }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      const population = result.variables.find(v => v.name === 'Population');
      expect(population.inflows).toEqual(['birth rate']);
      expect(population.outflows).toEqual(['death rate']);
    });

    it('should remove empty and nonexistent inflow/outflow names from stocks', async () => {
      const originalResponse = {
        variables: [
          {
            name: 'Population',
            type: 'stock',
            equation: '1000',
            inflows: ['birth rate', '', '   ', 'ghost flow'],
            outflows: ['death rate', '[Region]']
          },
          { name: 'birth rate', type: 'flow', equation: '50' },
          { name: 'death rate', type: 'flow', equation: '10' }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      const population = result.variables.find(v => v.name === 'Population');
      expect(population.inflows).toEqual(['birth rate']);
      expect(population.outflows).toEqual(['death rate']);
    });

    it('should infer inflow on stock from positive-polarity flow→stock relationship', async () => {
      const originalResponse = {
        variables: [
          { name: 'Population', type: 'stock', equation: '1000' },
          { name: 'births', type: 'flow', equation: '50' }
        ],
        relationships: [
          { from: 'births', to: 'Population', polarity: '+' }
        ]
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      const population = result.variables.find(v => v.name === 'Population');
      expect(population.inflows).toContain('births');
      expect(population.outflows || []).not.toContain('births');
      // The flow stays a flow because it is now used
      const births = result.variables.find(v => v.name === 'births');
      expect(births.type).toBe('flow');
    });

    it('should infer outflow on stock from negative-polarity flow→stock relationship', async () => {
      const originalResponse = {
        variables: [
          { name: 'Population', type: 'stock', equation: '1000' },
          { name: 'deaths', type: 'flow', equation: '10' }
        ],
        relationships: [
          { from: 'deaths', to: 'Population', polarity: '-' }
        ]
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      const population = result.variables.find(v => v.name === 'Population');
      expect(population.outflows).toContain('deaths');
      expect(population.inflows || []).not.toContain('deaths');
    });

    it('should default to inflow when polarity is missing or unknown on inferred flow→stock', async () => {
      const originalResponse = {
        variables: [
          { name: 'Population', type: 'stock', equation: '1000' },
          { name: 'births', type: 'flow', equation: '50' }
        ],
        relationships: [
          { from: 'births', to: 'Population' }
        ]
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      const population = result.variables.find(v => v.name === 'Population');
      expect(population.inflows).toContain('births');
    });

    it('should not duplicate an inferred flow already present in inflows or outflows', async () => {
      const originalResponse = {
        variables: [
          {
            name: 'Population',
            type: 'stock',
            equation: '1000',
            inflows: ['births'],
            outflows: ['deaths']
          },
          { name: 'births', type: 'flow', equation: '50' },
          { name: 'deaths', type: 'flow', equation: '10' }
        ],
        relationships: [
          { from: 'births', to: 'Population', polarity: '+' },
          { from: 'deaths', to: 'Population', polarity: '-' }
        ]
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      const population = result.variables.find(v => v.name === 'Population');
      expect(population.inflows.filter(f => f === 'births')).toHaveLength(1);
      expect(population.outflows.filter(f => f === 'deaths')).toHaveLength(1);
    });

    it('should not infer inflows/outflows for non-flow→stock relationships', async () => {
      const originalResponse = {
        variables: [
          { name: 'Population', type: 'stock', equation: '1000' },
          { name: 'temperature', type: 'variable', equation: '20' }
        ],
        relationships: [
          { from: 'temperature', to: 'Population', polarity: '+' }
        ]
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      const population = result.variables.find(v => v.name === 'Population');
      // Inflows/outflows should not be populated from a variable→stock relationship
      expect(population.inflows || []).not.toContain('temperature');
      expect(population.outflows || []).not.toContain('temperature');
    });

    it('should rewrite DT to TIME in equations of graphical functions', async () => {
      const originalResponse = {
        variables: [
          {
            name: 'demand curve',
            type: 'variable',
            equation: 'DT',
            graphicalFunction: {
              points: [{ x: 0, y: 0 }, { x: 1, y: 1 }]
            }
          },
          {
            name: 'shock curve',
            type: 'variable',
            equation: 'dt',
            graphicalFunction: {
              points: [{ x: 0, y: 0 }, { x: 1, y: 1 }]
            }
          },
          {
            name: 'noop',
            type: 'variable',
            equation: 'DT',
            graphicalFunction: { points: [] }
          },
          {
            name: 'plain',
            type: 'variable',
            equation: 'DT'
          }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.variables.find(v => v.name === 'demand curve').equation).toBe('TIME');
      expect(result.variables.find(v => v.name === 'shock curve').equation).toBe('TIME');
      // No graphical function points → DT is not rewritten
      expect(result.variables.find(v => v.name === 'noop').equation).toBe('DT');
      expect(result.variables.find(v => v.name === 'plain').equation).toBe('DT');
    });

    it('should normalize comma-separated forElements strings into arrays', async () => {
      const originalResponse = {
        variables: [
          {
            name: 'sales',
            type: 'variable',
            dimensions: ['Product', 'Location'],
            arrayEquations: [
              { forElements: 'Pizza, BGO', equation: '100' },
              { forElements: ['Kebab', 'NYC'], equation: '200' },
              { forElements: 42, equation: '300' }
            ]
          }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      const sales = result.variables.find(v => v.name === 'sales');
      expect(sales.arrayEquations[0].forElements).toEqual(['Pizza', 'BGO']);
      expect(sales.arrayEquations[1].forElements).toEqual(['Kebab', 'NYC']);
      // Non-string, non-array forElements becomes []
      expect(sales.arrayEquations[2].forElements).toEqual([]);
    });

    it('should convert variable names with spaces inside additionalProperties for sub-typed variables', async () => {
      const originalResponse = {
        variables: [
          {
            name: 'queue stock',
            type: 'stock',
            subType: 'queue',
            equation: '0',
            inflows: [],
            outflows: [],
            additionalProperties: {
              fifoEnabled: true,
              purgeEq: 'service time * arrival rate',
              overflow: 'max capacity - service time'
            }
          },
          { name: 'service time', type: 'variable', equation: '5' },
          { name: 'arrival rate', type: 'variable', equation: '2' },
          { name: 'max capacity', type: 'variable', equation: '100' }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      const queueStock = result.variables.find(v => v.name === 'queue stock');
      expect(queueStock.additionalProperties.purgeEq).toBe('service_time * arrival_rate');
      expect(queueStock.additionalProperties.overflow).toBe('max_capacity - service_time');
      // Non-string property is left untouched
      expect(queueStock.additionalProperties.fifoEnabled).toBe(true);
    });

    it('should turn the schema\'s settings list back into an additionalProperties object', async () => {
      const originalResponse = {
        variables: [
          {
            name: 'queue stock',
            type: 'stock',
            subType: 'queue',
            equation: '0',
            inflows: [],
            outflows: [],
            additionalProperties: [
              { property: 'fifoEnabled', value: 'true' },
              { property: 'discrete', value: 'False' },
              { property: 'purgeEq', value: 'service time' }
            ]
          },
          { name: 'service time', type: 'variable', subType: 'none', equation: '5', additionalProperties: [] }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      const queueStock = result.variables.find(v => v.name === 'queue stock');
      expect(queueStock.additionalProperties).toEqual({ fifoEnabled: true, discrete: false, purgeEq: 'service_time' });
      const plain = result.variables.find(v => v.name === 'service time');
      expect(plain).not.toHaveProperty('subType');
      expect(plain).not.toHaveProperty('additionalProperties');
    });

    it('should not touch additionalProperties when variable has no subType', async () => {
      const originalResponse = {
        variables: [
          {
            name: 'plain stock',
            type: 'stock',
            equation: '0',
            inflows: [],
            outflows: [],
            additionalProperties: {
              note: 'service time'
            }
          },
          { name: 'service time', type: 'variable', equation: '5' }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      const plainStock = result.variables.find(v => v.name === 'plain stock');
      // No subType → additionalProperties is left as-is
      expect(plainStock.additionalProperties.note).toBe('service time');
    });

    it('should preserve a module referenced only as a parentModule', async () => {
      const originalResponse = {
        variables: [
          { name: 'Child.variable', type: 'variable', equation: '10' }
        ],
        modules: [
          { name: 'Grandparent', parentModule: '' },
          { name: 'Parent', parentModule: 'Grandparent' },
          { name: 'Child', parentModule: 'Parent' }
        ],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      // All three modules survive because the parentModule chain references each
      const names = result.modules.map(m => m.name).sort();
      expect(names).toEqual(['Child', 'Grandparent', 'Parent']);

      const child = result.modules.find(m => m.name === 'Child');
      const parent = result.modules.find(m => m.name === 'Parent');
      const grandparent = result.modules.find(m => m.name === 'Grandparent');
      expect(child.parentModule).toBe('Parent');
      expect(parent.parentModule).toBe('Grandparent');
      expect(grandparent.parentModule).toBe('');
    });

    it('should parse explanation markdown into HTML', async () => {
      const originalResponse = {
        variables: [],
        relationships: [],
        explanation: '# Title\n\nThis is **bold** and *italic*.'
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.explanation).toContain('<h1');
      expect(result.explanation).toContain('Title');
      expect(result.explanation).toContain('<strong>bold</strong>');
      expect(result.explanation).toContain('<em>italic</em>');
    });

    it('should not crash when explanation is absent', async () => {
      const originalResponse = {
        variables: [],
        relationships: []
      };

      const result = await quantitativeEngine.processResponse(originalResponse);

      expect(result.explanation).toBeUndefined();
    });
  });

  describe('setupLLMParameters', () => {
    it('should setup basic LLM parameters with default model', () => {
      const userPrompt = 'Test prompt';
      const result = quantitativeEngine.setupLLMParameters(userPrompt);

      // Parse the default model to extract base model and reasoning effort
      const parts = LLMWrapper.BUILD_DEFAULT_MODEL.split(' ');
      const expectedModel = parts[0];
      const expectedReasoningEffort = parts.length > 1 ? parts[1] : undefined;

      expect(result.model).toBe(expectedModel);
      expect(result.reasoningEffort).toBe(expectedReasoningEffort);
      expect(result.responseFormat).toBeDefined();
      expect(result.messages).toBeInstanceOf(Array);
      expect(result.messages.length).toBeGreaterThan(0);
      expect(result.messages[result.messages.length - 1].content).toBe(userPrompt);
    });

    it('should handle o3-mini model with reasoning effort', () => {
      const engineWithO3Mini = new QuantitativeEngineBrain({
        openAIKey: 'test-key',
        anthropicKey: 'test-claude-key',
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
        anthropicKey: 'test-claude-key',
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
        anthropicKey: 'test-claude-key',
        googleKey: 'test-google-key',
        underlyingModel: 'o1-mini'
      });

      expect(() => {
        engineWithoutStructured.setupLLMParameters('Test prompt');
      }).toThrow('Unsupported LLM o1-mini it does support structured outputs which are required.');
    });

    it('should set system role to user when model lacks system mode', () => {
      const engineWithoutSystemMode = new QuantitativeEngineBrain({
        openAIKey: 'test-key',
        anthropicKey: 'test-claude-key',
        googleKey: 'test-google-key',
        underlyingModel: 'llama'
      });

      const result = engineWithoutSystemMode.setupLLMParameters('Test prompt');

      expect(result.messages[0].role).toBe('system');
    });

    it('should not include a temperature in the LLM parameters', () => {
      const engineWithO3 = new QuantitativeEngineBrain({
        openAIKey: 'test-key',
        anthropicKey: 'test-claude-key',
        googleKey: 'test-google-key',
        underlyingModel: 'o3'
      });

      const result = engineWithO3.setupLLMParameters('Test prompt');

      expect(result).not.toHaveProperty('temperature');
    });

    it('should include background knowledge in messages when provided', () => {
      const engineWithBackground = new QuantitativeEngineBrain({
        openAIKey: 'test-key',
        anthropicKey: 'test-claude-key',
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
        anthropicKey: 'test-claude-key',
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
        anthropicKey: 'test-claude-key',
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
        anthropicKey: 'test-claude-key',
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
      expect(result).not.toHaveProperty('temperature');
      expect(result).toHaveProperty('reasoningEffort');

      expect(Array.isArray(result.messages)).toBe(true);
      expect(typeof result.model).toBe('string');
    });
  });
});