import {
  createReadModelSectionTool,
  createEditVariablesTool,
  createEditRelationshipsTool,
  createEditModulesTool
} from '../../../agent/tools/builtin/largeModelTools.js';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SESSION_ID = 'test-session';

// Canonical storage format: variable names use spaces, equations use underscores
const BASE_MODEL = {
  specs: { startTime: 0, stopTime: 100, dt: 1, timeUnits: 'Year' },
  variables: [
    { name: 'birth rate', type: 'variable', equation: 'Population * birth_fraction' },
    { name: 'death rate', type: 'variable', equation: 'Population * death_fraction' },
    { name: 'Population', type: 'stock', equation: '1000' },
    { name: 'Finance.net revenue', type: 'variable', equation: 'total_revenue - total_costs' },
    { name: 'Finance.total costs', type: 'variable', equation: 'fixed_costs + variable_costs' },
  ],
  relationships: [
    { from: 'birth rate', to: 'Population', polarity: '+' },
    { from: 'death rate', to: 'Population', polarity: '-' },
  ],
  modules: [
    { name: 'Finance', parentModule: null },
    { name: 'My Module', parentModule: null },
  ],
};

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(model = BASE_MODEL) {
  const dir = mkdtempSync(join(tmpdir(), 'sd-ai-test-'));
  writeFileSync(join(dir, 'model.sdjson'), JSON.stringify(model));
  return dir;
}

function makeReadTool(tempDir) {
  const sessionManager = { getSessionTempDir: () => tempDir };
  return createReadModelSectionTool(sessionManager, SESSION_ID);
}

function parseResult(result) {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

// ─── createReadModelSectionTool ───────────────────────────────────────────────

describe('createReadModelSectionTool normalization', () => {
  let tempDir;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  describe('variableNames filter', () => {
    it('matches underscore query against space-named variables', async () => {
      const tool = makeReadTool(tempDir);
      const { variables } = parseResult(
        await tool.handler({ section: 'variables', filter: { variableNames: ['birth_rate'] } })
      );
      expect(variables).toHaveLength(1);
      expect(variables[0].name).toBe('birth_rate'); // read tool outputs underscores
    });

    it('matches space query against space-named variables', async () => {
      const tool = makeReadTool(tempDir);
      const { variables } = parseResult(
        await tool.handler({ section: 'variables', filter: { variableNames: ['birth rate'] } })
      );
      expect(variables).toHaveLength(1);
    });

    it('is case-insensitive', async () => {
      const tool = makeReadTool(tempDir);
      const { variables } = parseResult(
        await tool.handler({ section: 'variables', filter: { variableNames: ['BIRTH_RATE'] } })
      );
      expect(variables).toHaveLength(1);
    });

    it('matches base name (without module prefix) using underscores', async () => {
      const tool = makeReadTool(tempDir);
      const { variables } = parseResult(
        await tool.handler({ section: 'variables', filter: { variableNames: ['net_revenue'] } })
      );
      expect(variables).toHaveLength(1);
      expect(variables[0].name).toBe('Finance.net_revenue');
    });
  });

  describe('moduleName filter (variables section)', () => {
    it('matches exact module name', async () => {
      const tool = makeReadTool(tempDir);
      const { variables } = parseResult(
        await tool.handler({ section: 'variables', filter: { moduleName: 'Finance' } })
      );
      expect(variables).toHaveLength(2);
    });

    it('is case-insensitive', async () => {
      const tool = makeReadTool(tempDir);
      const { variables } = parseResult(
        await tool.handler({ section: 'variables', filter: { moduleName: 'FINANCE' } })
      );
      expect(variables).toHaveLength(2);
    });

    it('treats underscores and spaces as equivalent', async () => {
      const dir = makeTempDir({
        ...BASE_MODEL,
        variables: [{ name: 'My Module.revenue', type: 'variable', equation: '100' }],
      });
      const tool = makeReadTool(dir);
      const { variables } = parseResult(
        await tool.handler({ section: 'variables', filter: { moduleName: 'My_Module' } })
      );
      expect(variables).toHaveLength(1);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('usedInEquation filter', () => {
    it('finds variables when searching with spaces (equation uses underscores)', async () => {
      const tool = makeReadTool(tempDir);
      const { variables } = parseResult(
        await tool.handler({ section: 'variables', filter: { usedInEquation: 'birth fraction' } })
      );
      expect(variables).toHaveLength(1);
      expect(variables[0].name).toBe('birth_rate');
    });

    it('finds variables when searching with underscores', async () => {
      const tool = makeReadTool(tempDir);
      const { variables } = parseResult(
        await tool.handler({ section: 'variables', filter: { usedInEquation: 'birth_fraction' } })
      );
      expect(variables).toHaveLength(1);
    });

    it('is case-insensitive', async () => {
      const tool = makeReadTool(tempDir);
      const { variables } = parseResult(
        await tool.handler({ section: 'variables', filter: { usedInEquation: 'BIRTH_FRACTION' } })
      );
      expect(variables).toHaveLength(1);
    });

    it('searches arrayEquations with normalization', async () => {
      const dir = makeTempDir({
        ...BASE_MODEL,
        variables: [{
          name: 'arrayed var', type: 'variable',
          arrayEquations: [{ index: '1', equation: 'base_rate * scale' }],
        }],
      });
      const tool = makeReadTool(dir);
      const { variables } = parseResult(
        await tool.handler({ section: 'variables', filter: { usedInEquation: 'base rate' } })
      );
      expect(variables).toHaveLength(1);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('relationshipFrom filter', () => {
    it('matches underscore query against space-stored from field', async () => {
      const tool = makeReadTool(tempDir);
      const { relationships } = parseResult(
        await tool.handler({ section: 'relationships', filter: { relationshipFrom: 'birth_rate' } })
      );
      expect(relationships).toHaveLength(1);
      expect(relationships[0].to).toBe('Population');
    });

    it('is case-insensitive', async () => {
      const tool = makeReadTool(tempDir);
      const { relationships } = parseResult(
        await tool.handler({ section: 'relationships', filter: { relationshipFrom: 'Birth Rate' } })
      );
      expect(relationships).toHaveLength(1);
    });
  });

  describe('relationshipTo filter', () => {
    it('matches underscore query against space-stored to field', async () => {
      const tool = makeReadTool(tempDir);
      const { relationships } = parseResult(
        await tool.handler({ section: 'relationships', filter: { relationshipTo: 'population' } })
      );
      expect(relationships).toHaveLength(2);
    });
  });

  describe('moduleName filter (modules section)', () => {
    it('is case-insensitive', async () => {
      const tool = makeReadTool(tempDir);
      const { modules } = parseResult(
        await tool.handler({ section: 'modules', filter: { moduleName: 'finance' } })
      );
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('Finance');
    });

    it('treats underscores and spaces as equivalent', async () => {
      const tool = makeReadTool(tempDir);
      const { modules } = parseResult(
        await tool.handler({ section: 'modules', filter: { moduleName: 'My_Module' } })
      );
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('My Module');
    });
  });

  describe('subType filter', () => {
    it('returns only variables matching the given subType', async () => {
      const dir = makeTempDir({
        ...BASE_MODEL,
        variables: [
          { name: 'work queue', type: 'stock', subType: 'queue', additionalProperties: { fifoEnabled: true } },
          { name: 'pipeline', type: 'stock', subType: 'conveyor', additionalProperties: { processTime: '5' } },
          { name: 'regular stock', type: 'stock', equation: '0' },
        ],
      });
      const tool = makeReadTool(dir);
      const { variables } = parseResult(
        await tool.handler({ section: 'variables', filter: { subType: 'queue' } })
      );
      expect(variables).toHaveLength(1);
      expect(variables[0].name).toBe('work_queue');
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns empty array when no variables match the subType', async () => {
      const tool = makeReadTool(tempDir);
      const { variables } = parseResult(
        await tool.handler({ section: 'variables', filter: { subType: 'oven' } })
      );
      expect(variables).toHaveLength(0);
    });

    it('can be combined with moduleName filter', async () => {
      const dir = makeTempDir({
        ...BASE_MODEL,
        variables: [
          { name: 'Ops.work queue', type: 'stock', subType: 'queue', additionalProperties: {} },
          { name: 'Finance.budget queue', type: 'stock', subType: 'queue', additionalProperties: {} },
        ],
      });
      const tool = makeReadTool(dir);
      const { variables } = parseResult(
        await tool.handler({ section: 'variables', filter: { subType: 'queue', moduleName: 'Ops' } })
      );
      expect(variables).toHaveLength(1);
      expect(variables[0].name).toBe('Ops.work_queue');
      rmSync(dir, { recursive: true, force: true });
    });
  });
});

// ─── per-section edit tools ─────────────────────────────────────────────────

describe('per-section edit tools normalization', () => {
  let tempDir;
  let session;

  // sendToClient mock: captures the sent model and resolves the pending request
  // via setTimeout so the promise set up after sendToClient can be resolved.
  function makeSendToClient() {
    let capturedModel = null;
    const sendToClient = async (msg) => {
      if (msg.type === 'update_model') {
        capturedModel = JSON.parse(JSON.stringify(msg.modelData));
        setTimeout(() => {
          const pending = session.pendingModelRequests?.get(msg.requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            pending.resolve('ok');
          }
        }, 0);
      }
    };
    return { sendToClient, getModel: () => capturedModel };
  }

  function makeEditTools(sendToClient) {
    session = {
      mode: 'sfd',
      context: { supportsArrays: false, supportsModules: true, supportsSubTypes: true },
      pendingModelRequests: new Map(),
    };
    const sessionManager = {
      getSession: () => session,
      getSessionTempDir: () => tempDir,
      updateClientModel: () => {},
    };
    return {
      variables: createEditVariablesTool(sessionManager, SESSION_ID, sendToClient),
      relationships: createEditRelationshipsTool(sessionManager, SESSION_ID, sendToClient),
      modules: createEditModulesTool(sessionManager, SESSION_ID, sendToClient),
    };
  }

  function resetModel(model) {
    writeFileSync(join(tempDir, 'model.sdjson'), JSON.stringify(model));
  }

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'sd-ai-test-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  describe('variables add', () => {
    it('normalizes underscore names to spaces', async () => {
      resetModel({ variables: [], relationships: [], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.variables.handler({ operation: 'add', data: [
        { name: 'birth_rate', type: 'variable', equation: '0.1' }
      ]});

      expect(getModel().variables[0].name).toBe('birth rate');
    });

    it('normalizes module-qualified names', async () => {
      resetModel({ variables: [], relationships: [], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.variables.handler({ operation: 'add', data: [
        { name: 'Finance.net_revenue', type: 'variable', equation: '100' }
      ]});

      expect(getModel().variables[0].name).toBe('Finance.net revenue');
    });
  });

  describe('variables update', () => {
    it('finds variable by underscore name', async () => {
      resetModel({ variables: [{ name: 'birth rate', type: 'variable', equation: '0.1' }], relationships: [], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.variables.handler({ operation: 'update', data: [
        { name: 'birth_rate', equation: '0.2' }
      ]});

      expect(getModel().variables[0].equation).toBe('0.2');
    });

    it('finds variable case-insensitively', async () => {
      resetModel({ variables: [{ name: 'birth rate', type: 'variable', equation: '0.1' }], relationships: [], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.variables.handler({ operation: 'update', data: [
        { name: 'Birth Rate', equation: '0.2' }
      ]});

      expect(getModel().variables[0].equation).toBe('0.2');
    });

    it('finds variable with mixed case and underscores', async () => {
      resetModel({ variables: [{ name: 'birth rate', type: 'variable', equation: '0.1' }], relationships: [], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.variables.handler({ operation: 'update', data: [
        { name: 'BIRTH_RATE', equation: '0.2' }
      ]});

      expect(getModel().variables[0].equation).toBe('0.2');
    });

    it('normalizes newName to spaces', async () => {
      resetModel({ variables: [{ name: 'birth rate', type: 'variable', equation: '0.1' }], relationships: [], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.variables.handler({ operation: 'update', data: [
        { name: 'birth_rate', newName: 'birth_fraction' }
      ]});

      expect(getModel().variables[0].name).toBe('birth fraction');
    });

    it('updates equation-valued additionalProperties fields on rename', async () => {
      resetModel({
        variables: [
          { name: 'process time', type: 'variable', equation: '10' },
          { name: 'pipeline', type: 'stock', subType: 'conveyor', additionalProperties: { processTime: 'process_time', capacity: '100' } },
        ],
        relationships: [],
        modules: [],
      });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.variables.handler({ operation: 'update', data: [
        { name: 'process_time', newName: 'transit_time' }
      ]});

      const conveyor = getModel().variables.find(v => v.name === 'pipeline');
      expect(conveyor.additionalProperties.processTime).toBe('transit_time');
    });

    it('leaves boolean additionalProperties fields untouched on rename', async () => {
      resetModel({
        variables: [
          { name: 'flag', type: 'variable', equation: '1' },
          { name: 'work queue', type: 'stock', subType: 'queue', additionalProperties: { fifoEnabled: true, overflow: false } },
        ],
        relationships: [],
        modules: [],
      });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.variables.handler({ operation: 'update', data: [
        { name: 'flag', newName: 'signal' }
      ]});

      const queue = getModel().variables.find(v => v.name === 'work queue');
      expect(queue.additionalProperties.fifoEnabled).toBe(true);
      expect(queue.additionalProperties.overflow).toBe(false);
    });
  });

  describe('variables remove', () => {
    it('removes variable found by underscore name', async () => {
      resetModel({ variables: [{ name: 'birth rate', type: 'variable', equation: '0.1' }], relationships: [], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.variables.handler({ operation: 'remove', data: [{name: 'birth_rate'}] });

      expect(getModel().variables).toHaveLength(0);
    });

    it('removes variable case-insensitively', async () => {
      resetModel({ variables: [{ name: 'birth rate', type: 'variable', equation: '0.1' }], relationships: [], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.variables.handler({ operation: 'remove', data: [{name: 'BIRTH RATE'}] });

      expect(getModel().variables).toHaveLength(0);
    });

    it('removes variable with mixed case and underscores', async () => {
      resetModel({ variables: [{ name: 'birth rate', type: 'variable', equation: '0.1' }], relationships: [], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.variables.handler({ operation: 'remove', data: [{name: 'Birth_Rate'}] });

      expect(getModel().variables).toHaveLength(0);
    });

    it('also removes relationships where the removed variable is the from or the to', async () => {
      resetModel({
        variables: [
          { name: 'birth rate', type: 'variable', equation: '0.1' },
          { name: 'Population', type: 'stock', equation: '1000' },
          { name: 'death rate', type: 'variable', equation: '0.05' },
        ],
        relationships: [
          { from: 'birth rate', to: 'Population', polarity: '+' }, // removed: from-match
          { from: 'Population', to: 'birth rate', polarity: '+' }, // removed: to-match
          { from: 'death rate', to: 'Population', polarity: '-' }, // kept: untouched
        ],
        modules: [],
      });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.variables.handler({ operation: 'remove', data: [{ name: 'birth_rate' }] });

      const model = getModel();
      expect(model.variables.map(v => v.name)).toEqual(['Population', 'death rate']);
      expect(model.relationships).toEqual([
        { from: 'death rate', to: 'Population', polarity: '-' },
      ]);
    });

    it('prunes relationships for every variable in a multi-variable remove', async () => {
      resetModel({
        variables: [
          { name: 'birth rate', type: 'variable', equation: '0.1' },
          { name: 'death rate', type: 'variable', equation: '0.05' },
          { name: 'Population', type: 'stock', equation: '1000' },
        ],
        relationships: [
          { from: 'birth rate', to: 'Population', polarity: '+' },
          { from: 'death rate', to: 'Population', polarity: '-' },
        ],
        modules: [],
      });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.variables.handler({ operation: 'remove', data: [
        { name: 'birth_rate' }, { name: 'death_rate' }
      ]});

      const model = getModel();
      expect(model.variables.map(v => v.name)).toEqual(['Population']);
      expect(model.relationships).toHaveLength(0);
    });
  });

  describe('relationships add', () => {
    it('normalizes from and to to spaces', async () => {
      resetModel({ variables: [], relationships: [], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.relationships.handler({ operation: 'add', data: [
        { from: 'birth_rate', to: 'Population', polarity: '+' }
      ]});

      expect(getModel().relationships[0].from).toBe('birth rate');
      expect(getModel().relationships[0].to).toBe('Population');
    });
  });

  describe('relationships update', () => {
    it('finds relationship by underscore from/to', async () => {
      resetModel({ variables: [], relationships: [{ from: 'birth rate', to: 'Population', polarity: '+' }], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.relationships.handler({ operation: 'update', data: [{
        from: 'birth_rate', to: 'Population', polarity: '-'
      }]});

      expect(getModel().relationships[0].polarity).toBe('-');
    });

    it('finds relationship case-insensitively', async () => {
      resetModel({ variables: [], relationships: [{ from: 'birth rate', to: 'Population', polarity: '+' }], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.relationships.handler({ operation: 'update', data: [{
        from: 'BIRTH RATE', to: 'population', polarity: '-'
      }]});

      expect(getModel().relationships[0].polarity).toBe('-');
    });

    it('finds relationship with mixed case and underscores', async () => {
      resetModel({ variables: [], relationships: [{ from: 'birth rate', to: 'Population', polarity: '+' }], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.relationships.handler({ operation: 'update', data: [{
        from: 'Birth_Rate', to: 'POPULATION', polarity: '-'
      }]});

      expect(getModel().relationships[0].polarity).toBe('-');
    });
  });

  describe('relationships remove', () => {
    it('removes relationship found by underscore from/to', async () => {
      resetModel({ variables: [], relationships: [{ from: 'birth rate', to: 'Population', polarity: '+' }], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.relationships.handler({ operation: 'remove', data: [
        { from: 'birth_rate', to: 'Population' }
      ]});

      expect(getModel().relationships).toHaveLength(0);
    });

    it('removes relationship case-insensitively', async () => {
      resetModel({ variables: [], relationships: [{ from: 'birth rate', to: 'Population', polarity: '+' }], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.relationships.handler({ operation: 'remove', data: [
        { from: 'BIRTH RATE', to: 'POPULATION' }
      ]});

      expect(getModel().relationships).toHaveLength(0);
    });

    it('removes relationship with mixed case and underscores', async () => {
      resetModel({ variables: [], relationships: [{ from: 'birth rate', to: 'Population', polarity: '+' }], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.relationships.handler({ operation: 'remove', data: [
        { from: 'Birth_Rate', to: 'population' }
      ]});

      expect(getModel().relationships).toHaveLength(0);
    });

    it('removes relationship stored WITH underscores when queried with spaces', async () => {
      resetModel({ variables: [], relationships: [{ from: 'birth_rate', to: 'net_revenue', polarity: '+' }], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.relationships.handler({ operation: 'remove', data: [
        { from: 'birth rate', to: 'net revenue' }
      ]});

      expect(getModel().relationships).toHaveLength(0);
    });

    it('removes relationship stored WITHOUT underscores when queried with underscores', async () => {
      resetModel({ variables: [], relationships: [{ from: 'birth rate', to: 'net revenue', polarity: '+' }], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.relationships.handler({ operation: 'remove', data: [
        { from: 'birth_rate', to: 'net_revenue' }
      ]});

      expect(getModel().relationships).toHaveLength(0);
    });

    it('normalizes case AND underscore/space on both from and to together', async () => {
      resetModel({ variables: [], relationships: [{ from: 'Birth_Rate', to: 'net revenue', polarity: '+' }], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.relationships.handler({ operation: 'remove', data: [
        { from: 'birth rate', to: 'NET_REVENUE' }
      ]});

      expect(getModel().relationships).toHaveLength(0);
    });

    it('only removes the matching relationship, leaving others intact', async () => {
      resetModel({ variables: [], relationships: [
        { from: 'birth_rate', to: 'net revenue', polarity: '+' },
        { from: 'death rate', to: 'net_revenue', polarity: '-' },
      ], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.relationships.handler({ operation: 'remove', data: [
        { from: 'Birth Rate', to: 'Net_Revenue' }
      ]});

      const rels = getModel().relationships;
      expect(rels).toHaveLength(1);
      expect(rels[0].from).toBe('death rate');
    });
  });

  describe('modules add', () => {
    it('normalizes module name underscores to spaces', async () => {
      resetModel({ variables: [], relationships: [], modules: [] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.modules.handler({ operation: 'add', data: [
        { name: 'My_Module', parentModule: null }
      ]});

      expect(getModel().modules[0].name).toBe('My Module');
    });
  });

  describe('modules update', () => {
    it('normalizes module names in replacement array', async () => {
      resetModel({ variables: [], relationships: [], modules: [{ name: 'Finance', parentModule: null }] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.modules.handler({ operation: 'update', data: [
        { name: 'Finance_Sub', parentModule: 'Finance' }
      ]});

      expect(getModel().modules[0].name).toBe('Finance Sub');
    });
  });

  describe('modules remove', () => {
    it('removes module found by underscore name', async () => {
      resetModel({ variables: [], relationships: [], modules: [{ name: 'My Module', parentModule: null }] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.modules.handler({ operation: 'remove', data: [{name: 'My_Module'}] });

      expect(getModel().modules).toHaveLength(0);
    });

    it('removes module case-insensitively', async () => {
      resetModel({ variables: [], relationships: [], modules: [{ name: 'Finance', parentModule: null }] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.modules.handler({ operation: 'remove', data: [{name: 'FINANCE'}] });

      expect(getModel().modules).toHaveLength(0);
    });

    it('removes module with mixed case and underscores', async () => {
      resetModel({ variables: [], relationships: [], modules: [{ name: 'My Module', parentModule: null }] });
      const { sendToClient, getModel } = makeSendToClient();
      const tools = makeEditTools(sendToClient);

      await tools.modules.handler({ operation: 'remove', data: [{name: 'MY_MODULE'}] });

      expect(getModel().modules).toHaveLength(0);
    });
  });
});

// ─── delay marks ────────────────────────────────────────────────────────────

describe('relationship delay marks', () => {
  let tempDir;
  let session;

  const MODEL = {
    variables: [
      { name: 'a', type: 'variable' },
      { name: 'b', type: 'variable' },
    ],
    relationships: [
      { from: 'a', to: 'b', polarity: '+' },
      { from: 'b', to: 'a', polarity: '-' },
    ],
  };

  function makeTool() {
    writeFileSync(join(tempDir, 'model.sdjson'), JSON.stringify(MODEL));
    let sent = null;
    session = { mode: 'cld', context: {}, pendingModelRequests: new Map() };
    const sendToClient = async (msg) => {
      if (msg.type !== 'update_model') return;
      sent = JSON.parse(JSON.stringify(msg.modelData));
      setTimeout(() => {
        const pending = session.pendingModelRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          pending.resolve({});
        }
      }, 0);
    };
    const sessionManager = {
      getSession: () => session,
      getSessionTempDir: () => tempDir,
      updateClientModel: () => ({}),
    };
    return { tool: createEditRelationshipsTool(sessionManager, SESSION_ID, sendToClient), sent: () => sent };
  }

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'sd-ai-test-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('sets a delay mark on an existing relationship', async () => {
    const { tool, sent } = makeTool();
    parseResult(await tool.handler({ operation: 'update', data: [{ from: 'b', to: 'a', delay: true }] }));
    const rel = sent().relationships.find(r => r.from === 'b' && r.to === 'a');
    expect(rel.delay).toBe(true);
    expect(rel.polarity).toBe('-');
  });

  it('describes a delay mark as drawing only, set in a stock-and-flow model only when asked', () => {
    const { tool } = makeTool();
    expect(tool.description).toContain('It changes no equation');
    expect(tool.description).toContain('set or remove one only when the user asks');
    expect(tool.description).toContain('never add a DELAY or SMTH function because a link is marked');
  });

  it('rejects a delay that is not a boolean', async () => {
    const { tool, sent } = makeTool();
    const result = await tool.handler({ operation: 'update', data: [{ from: 'b', to: 'a', delay: 'yes' }] });
    expect(result.isError).toBe(true);
    expect(sent()).toBeNull();
  });
});
