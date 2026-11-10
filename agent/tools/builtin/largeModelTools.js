import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createUpdateModelMessage, UpdateModelResponseSchema } from '../../utilities/MessageProtocol.js';
import { generateRequestId, createSuccessResponse, createErrorResponse } from './toolHelpers.js';
import { LLMWrapper } from '../../../utilities/LLMWrapper.js';

const variableBase = LLMWrapper.variableSchemaBase(LLMWrapper.SCHEMA_STRINGS);
const simSpecsBase = LLMWrapper.simSpecsSchemaBase(LLMWrapper.SCHEMA_STRINGS);
const relationshipBase = LLMWrapper.relationshipSchemaBase(LLMWrapper.SCHEMA_STRINGS);

// Variable names are stored with spaces; equations use underscores.
const normName = n => typeof n === 'string' ? n.replace(/_/g, ' ') : n;
const normSearch = s => typeof s === 'string' ? s.toLowerCase().replace(/[ _]/g, '_') : s;

/**
 * Read a specific section of the large model file
 */
export function createReadModelSectionTool(sessionManager, sessionId) {
  return {
    description: `Read a specific section of the large model file. Use this to inspect parts of the model without loading the entire thing.

Available sections:
- specs: simulation specifications (startTime, stopTime, dt, timeUnits, arrayDimensions).
  * arrayDimensions schema: [{type: "numeric"|"labels", name: string (singular, alphanumeric), size: number (positive integer), elements: string[] (element names)}]
  * All four fields (type, name, size, elements) are required for each dimension
  * type="numeric": elements auto-generated as ['1','2','3'...]
  * type="labels": elements are user-defined meaningful names like ['North','South','East','West']
- variables: array of variables with schema: {name, type (stock|flow|variable), equation, documentation, units, uniflow, inflows, outflows, dimensions, arrayEquations, crossLevelGhostOf, graphicalFunction, subType?, additionalProperties?}
- relationships: array of relationships with schema: {from, to, polarity (+|-|""), reasoning, polarityReasoning, delay?}. delay: true means the arrow carries a delay mark, a drawing mark only; it changes no equation.
- modules: module hierarchy with schema: {name, parentModule}. IMPORTANT: The modules array only defines the hierarchical structure (which modules exist and their parent-child relationships). It does NOT tell you which variables belong to a module - variable membership is determined by the variable name prefix (e.g., "Finance.revenue" belongs to the Finance module).

Module handling:
- In modular models, variable names are module-qualified as "Module_Name.variable_name"
- To find variables in a module, use the moduleName filter (filters by name prefix)
- The modules section only shows the module hierarchy, not the contents

Array handling:
- Variables with the "dimensions" field are arrayed variables
- Array dimensions must be defined in specs.arrayDimensions BEFORE being referenced by variables
- Each dimension requires all four fields: type, name, size, elements
- Element-specific equations are in the "arrayEquations" field

Sub-type handling:
- Stock sub-types — "queue", "oven" and "conveyor" set subType + additionalProperties, "nonNegative" sets subType only: "queue" (waiting line), "oven" (batch processor), "conveyor" (pipeline delay), "nonNegative" (stock that can never go below zero)
- Flow sub-types (set subType only, equation = ""): "discreteOutflow" (output from conveyor/oven), "conveyorLeakage" (leakage from conveyor), "queueOutflow" (output from queue), "queueOverflow" (overflow from full queue)
- Variable sub-types: "delayVariable" (plain variable whose equation uses a DELAY or SMTH builtin function)
- additionalProperties fields by subType:
  * conveyor/oven: {processTime (required), capacity?, inflowLimit?, fillTime? (oven only), cleanTime? (oven only), sample?, arrest?}
  * conveyorLeakage: {leakFraction? (units 1/time_unit when exponential, dimensionless otherwise), exponential?, leakZoneStart?, leakZoneEnd?, leakIntegers?, ignorePrevZones?, forceLeakFraction?}
  * queue: {fifoEnabled?, oneAtATime?, splitBatches?, discrete?, roundRobin?, queueOutflowPriority?, purgeEq?, overflow?}
  * inflow to conveyor (regular flow): {spreadFlow? ("none"|"even"|"destination"|"distribution"|"source"), distribEq? (required when spreadFlow="distribution")}

Filtering:
- variableNames filter matches base names (e.g., "cost" matches "Module_1.cost", "Module_2.cost", and "cost")
- moduleName filter gets all variables from a specific module (by name prefix)
- usedInEquation filter finds all variables whose equations reference a given variable (case-insensitive, matches XMILE format with underscores)
- subType filter gets all variables with a specific discrete-entity sub-type (e.g., filter all queues or all conveyors)`,
    supportedModes: ['sfd', 'cld'],
    inputSchema: z.object({
      section: z.enum(['specs', 'variables', 'relationships', 'modules']).describe('Which section to read'),
      filter: z.object({
        variableNames: z.array(z.string()).optional().describe('Filter variables by base name (matches both qualified and unqualified names, e.g., "cost" matches "Module_1.cost", "Module_2.cost", and "cost")'),
        variableType: z.enum(['stock', 'flow', 'variable']).optional().describe('Filter variables by type'),
        subType: z.enum(['queue', 'oven', 'conveyor', 'nonNegative', 'discreteOutflow', 'conveyorLeakage', 'queueOutflow', 'queueOverflow', 'delayVariable']).optional().describe('Filter variables by sub-type (e.g., find all conveyors, all queues, or all delay variables)'),
        moduleName: z.string().optional().describe('Filter variables by module (e.g., "Module_Name" - variable names are module-qualified as Module_Name.variable_name)'),
        usedInEquation: z.string().optional().describe('Find variables whose equations reference this variable (case-insensitive). Searches in both equation and arrayEquations fields.'),
        relationshipFrom: z.string().optional().describe('Filter relationships by source variable'),
        relationshipTo: z.string().optional().describe('Filter relationships by target variable'),
        limit: z.number().optional().describe('Limit number of results returned (default: 500)')
      }).optional().describe('Optional filters for variables/relationships/modules')
    }),
    handler: async ({ section, filter }) => {
      try {
        const sessionTempDir = sessionManager.getSessionTempDir(sessionId);
        const modelPath = join(sessionTempDir, 'model.sdjson');

        if (!existsSync(modelPath)) {
          return createErrorResponse('Error: Model file not found. The model may not have exceeded the token limit yet.');
        }

        const modelContent = readFileSync(modelPath, 'utf-8');
        const model = JSON.parse(modelContent);

        const norm = s => s.toLowerCase().replace(/[ _]/g, '_');
        const limit = filter?.limit || 500;
        let result = {};

        switch (section) {
          case 'specs':
            result = model.specs || {};
            break;

          case 'variables':
            let variables = model.variables || [];

            // Apply filters (case-insensitive, spaces and underscores treated as equivalent)
            if (filter?.variableNames && filter.variableNames.length > 0) {
              const normFilterNames = filter.variableNames.map(name => norm(name));
              variables = variables.filter(v => {
                if (normFilterNames.includes(norm(v.name))) return true;
                const baseName = v.name.includes('.') ? v.name.split('.').pop() : v.name;
                return normFilterNames.includes(norm(baseName));
              });
            }
            if (filter?.variableType) {
              variables = variables.filter(v => v.type === filter.variableType);
            }
            if (filter?.subType) {
              variables = variables.filter(v => v.subType === filter.subType);
            }
            if (filter?.moduleName) {
              const normModule = norm(filter.moduleName);
              variables = variables.filter(v => norm(v.name).startsWith(normModule + '.'));
            }
            if (filter?.usedInEquation) {
              const searchTerm = norm(filter.usedInEquation);
              variables = variables.filter(v => {
                if (v.equation && norm(v.equation).includes(searchTerm)) {
                  return true;
                }
                if (v.arrayEquations && Array.isArray(v.arrayEquations)) {
                  return v.arrayEquations.some(ae =>
                    ae.equation && norm(ae.equation).includes(searchTerm)
                  );
                }
                return false;
              });
            }

            const total = variables.length;
            variables = variables.slice(0, limit);

            variables = variables.map(v => ({
              ...v,
              name: v.name.replace(/ /g, '_')
            }));

            result = {
              variables,
              total,
              returned: variables.length,
              truncated: total > limit
            };
            break;

          case 'relationships':
            let relationships = model.relationships || [];

            if (filter?.relationshipFrom) {
              const normFrom = norm(filter.relationshipFrom);
              relationships = relationships.filter(r => norm(r.from) === normFrom);
            }
            if (filter?.relationshipTo) {
              const normTo = norm(filter.relationshipTo);
              relationships = relationships.filter(r => norm(r.to) === normTo);
            }

            const totalRels = relationships.length;
            relationships = relationships.slice(0, limit);

            result = {
              relationships,
              total: totalRels,
              returned: relationships.length,
              truncated: totalRels > limit
            };
            break;

          case 'modules':
            let modules = model.modules || [];

            if (filter?.moduleName) {
              const normModule = norm(filter.moduleName);
              modules = modules.filter(m => norm(m.name) === normModule);
            }

            result = {
              modules,
              total: modules.length
            };
            break;
        }

        return createSuccessResponse(result);
      } catch (error) {
        return createErrorResponse(`Failed to read model section: ${error.message}`, error);
      }
    }
  };
}

/**
 * Load the on-disk model for the session, applying a mutation, then push to client.
 * Shared by all per-section edit tools.
 *
 * @param {Object} args
 * @param {Object} args.sessionManager
 * @param {string} args.sessionId
 * @param {Function} args.sendToClient
 * @param {string} args.section - For the response message
 * @param {string} args.operation - For the response message
 * @param {Function} args.mutate - (model) => string|null; return error message to abort
 */
async function applyEdit({ sessionManager, sessionId, sendToClient, section, operation, mutate }) {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const sessionTempDir = sessionManager.getSessionTempDir(sessionId);
  const modelPath = join(sessionTempDir, 'model.sdjson');

  if (!existsSync(modelPath)) {
    return createErrorResponse('Error: Model file not found. Call get_current_model to get it.');
  }

  const modelContent = readFileSync(modelPath, 'utf-8');
  const model = JSON.parse(modelContent);

  const mutationError = mutate(model);
  if (mutationError) {
    return createErrorResponse(mutationError);
  }

  if (!model.variables || !Array.isArray(model.variables)) {
    return createErrorResponse('Model validation failed: model.variables must be an array.');
  }

  if (!model.relationships || !Array.isArray(model.relationships)) {
    return createErrorResponse('Model validation failed: model.relationships must be an array.');
  }

  const updateRequestId = generateRequestId('model');
  await sendToClient(createUpdateModelMessage(sessionId, updateRequestId, model));

  const updatePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Update model timeout: Client did not respond within 30 seconds'));
    }, 30000);

    if (!session.pendingModelRequests) {
      session.pendingModelRequests = new Map();
    }
    session.pendingModelRequests.set(updateRequestId, { resolve, reject, timeout });
  });

  const clientResult = await updatePromise;
  const parsed = UpdateModelResponseSchema.parse(clientResult);

  const { issues } = sessionManager.updateClientModel(sessionId, parsed);

  return createSuccessResponse({
    message: `Successfully edited ${section} section (${operation} operation). The model has been validated, processed, and sent to the client.`,
    ...(issues && { issues })
  });
}

function specsMutator(data) {
  return (model) => {
    model.specs = model.specs || {};
    if (data.startTime !== undefined) model.specs.startTime = data.startTime;
    if (data.stopTime !== undefined) model.specs.stopTime = data.stopTime;
    if (data.dt !== undefined) model.specs.dt = data.dt;
    if (data.timeUnits !== undefined) model.specs.timeUnits = data.timeUnits;

    if (data.arrayDimensions !== undefined) {
      if (Array.isArray(data.arrayDimensions)) {
        for (const dim of data.arrayDimensions) {
          if (!dim.type || !dim.name || dim.size === undefined || !Array.isArray(dim.elements)) {
            return `Error: Array dimension "${dim.name || 'unknown'}" is missing required fields. All dimensions must have: type ("numeric" or "labels"), name (singular, alphanumeric), size (positive integer), and elements (array of element names).`;
          }
          if (dim.type !== 'numeric' && dim.type !== 'labels') {
            return `Error: Array dimension "${dim.name}" has invalid type "${dim.type}". Must be "numeric" or "labels".`;
          }
          if (typeof dim.size !== 'number' || dim.size <= 0) {
            return `Error: Array dimension "${dim.name}" size must be a positive integer, got: ${dim.size}`;
          }
          if (dim.elements.length !== dim.size) {
            return `Error: Array dimension "${dim.name}" has size=${dim.size} but elements array has ${dim.elements.length} items. They must match.`;
          }
        }
      }
      model.specs.arrayDimensions = data.arrayDimensions;
    }
    return null;
  };
}

function variablesMutator(operation, data) {
  return (model) => {
    model.variables = model.variables || [];
    if (operation === 'add') {
      if (!Array.isArray(data)) {
        return 'Error: For add operation, data must be an array of variable objects. Example: [{name: "var1", type: "stock", equation: "100"}]';
      }
      for (const v of data) { if (v.name) v.name = normName(v.name); }
      const errors = [];
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        const varLabel = data.length > 1 ? `Variable ${i + 1} (${v.name || 'unnamed'})` : `Variable "${v.name || 'unnamed'}"`;

        if (!v.name || !v.type) {
          errors.push(`${varLabel}: Missing required fields. Must have "name" and "type".`);
        } else if (!['stock', 'flow', 'variable'].includes(v.type)) {
          errors.push(`${varLabel}: Invalid type "${v.type}". Must be "stock", "flow", or "variable".`);
        }
      }

      if (errors.length > 0) {
        return `Error adding ${data.length} variable(s):\n\n${errors.join('\n')}\n\nProvide an array of variable objects: [{name: "var1", type: "stock", equation: "100"}, {name: "var2", type: "variable", equation: "20"}]`;
      }

      model.variables.push(...data);
    } else if (operation === 'update') {
      if (!Array.isArray(data)) {
        return 'Error: For update operation, data must be an array of variable objects. Example: [{name: "Population", equation: "2000"}]';
      }
      for (const update of data) {
        const varName = normName(update.name);
        update.name = varName;
        if (update.newName) update.newName = normName(update.newName);
        if (!varName) {
          return 'Error: Must specify "name" field to update a variable';
        }
        const index = model.variables.findIndex(v => normSearch(v.name) === normSearch(varName));
        if (index >= 0) {
          const oldVariable = model.variables[index];
          const oldName = oldVariable.name;

          const isRenamed = update.newName && update.newName !== oldName;

          if (isRenamed) {
            const newName = update.newName;
            const oldNameXMILE = oldName.replace(/ /g, '_');
            const newNameXMILE = newName.replace(/ /g, '_');

            const varRegex = new RegExp(`\\b${oldNameXMILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');

            for (const variable of model.variables) {
              if (variable.equation && varRegex.test(variable.equation)) {
                variable.equation = variable.equation.replace(varRegex, newNameXMILE);
              }

              if (variable.arrayEquations && Array.isArray(variable.arrayEquations)) {
                for (const ae of variable.arrayEquations) {
                  if (ae.equation && varRegex.test(ae.equation)) {
                    ae.equation = ae.equation.replace(varRegex, newNameXMILE);
                  }
                }
              }

              if (variable.additionalProperties && typeof variable.additionalProperties === 'object') {
                for (const [key, val] of Object.entries(variable.additionalProperties)) {
                  if (typeof val === 'string' && varRegex.test(val)) {
                    variable.additionalProperties[key] = val.replace(varRegex, newNameXMILE);
                  }
                }
              }
            }

            update.name = newName;
            delete update.newName;
          }

          model.variables[index] = { ...model.variables[index], ...update };
        } else {
          return `Error: Variable "${varName}" not found`;
        }
      }
    } else if (operation === 'remove') {
      if (!Array.isArray(data)) {
        return 'Error: For remove operation, data must be an array of objects with name. Example: [{name: "var1"}, {name: "var2"}]';
      }
      const normalizedRemoveNames = data.map(item => normSearch(item?.name));
      model.variables = model.variables.filter(v => !normalizedRemoveNames.includes(normSearch(v.name)));
      // A removed variable orphans any causal arrow touching it; drop those too
      // so we never leave a relationship pointing at a non-existent variable.
      if (Array.isArray(model.relationships)) {
        model.relationships = model.relationships.filter(r =>
          !normalizedRemoveNames.includes(normSearch(r.from)) &&
          !normalizedRemoveNames.includes(normSearch(r.to))
        );
      }
    }
    return null;
  };
}

function relationshipsMutator(operation, data) {
  return (model) => {
    model.relationships = model.relationships || [];
    if (!Array.isArray(data)) {
      return `Error: For ${operation} operation, data must be an array of relationship objects. Example: [{from: "var1", to: "var2", polarity: "+"}]`;
    }
    for (const r of data) {
      r.from = normName(r.from);
      r.to = normName(r.to);
      if (!r.from || !r.to) {
        return 'Error: Relationships must have "from" and "to" fields';
      }
      if (r.delay !== undefined && typeof r.delay !== 'boolean') {
        return `Error: Relationship delay must be true or false, got "${r.delay}"`;
      }
    }

    if (operation === 'add') {
      for (const r of data) {
        if (r.polarity !== undefined && !['+', '-'].includes(r.polarity)) {
          return `Error: Relationship polarity must be "+" or "-", got "${r.polarity}"`;
        }
      }
      model.relationships.push(...data);
    } else if (operation === 'update') {
      for (const update of data) {
        const index = model.relationships.findIndex(r => normSearch(r.from) === normSearch(update.from) && normSearch(r.to) === normSearch(update.to));
        if (index >= 0) {
          model.relationships[index] = { ...model.relationships[index], ...update };
        } else {
          return `Error: Relationship from "${update.from}" to "${update.to}" not found`;
        }
      }
    } else if (operation === 'remove') {
      model.relationships = model.relationships.filter(r =>
        !data.some(rem => normSearch(rem.from) === normSearch(r.from) && normSearch(rem.to) === normSearch(r.to))
      );
    }
    return null;
  };
}

function modulesMutator(operation, data) {
  return (model) => {
    model.modules = model.modules || [];
    if (operation === 'update') {
      if (!Array.isArray(data)) {
        return 'Error: For update operation, data must be an array of module objects. Example: [{name: "Module1", parentModule: null}]';
      }
      for (const m of data) {
        m.name = normName(m.name);
        if (!m.name || m.parentModule === undefined) {
          return 'Error: Modules must have "name" and "parentModule" fields';
        }
      }
      model.modules = data;
    } else if (operation === 'add') {
      if (!Array.isArray(data)) {
        return 'Error: For add operation, data must be an array of module objects. Example: [{name: "Module1", parentModule: null}]';
      }
      for (const m of data) {
        m.name = normName(m.name);
        if (!m.name || m.parentModule === undefined) {
          return 'Error: Modules must have "name" and "parentModule" fields';
        }
      }
      model.modules.push(...data);
    } else if (operation === 'remove') {
      if (!Array.isArray(data)) {
        return 'Error: For remove operation, data must be an array of objects with name. Example: [{name: "Module1"}, {name: "Module2"}]';
      }
      const normalizedRemoveModules = data.map(item => normSearch(item?.name));
      model.modules = model.modules.filter(m => !normalizedRemoveModules.includes(normSearch(m.name)));
    }
    return null;
  };
}

/**
 * Edit variables: add, update (including rename), or remove.
 */
export function createEditVariablesTool(sessionManager, sessionId, sendToClient) {
  return {
    description: `Edit the variables section of the model. data is always an array of variable objects. Every object must include 'name'. Other fields are interpreted by operation:

- add: every object must also include 'type' (stock|flow|variable); other fields populate the new variable
- update: 'name' locates the existing variable; the other fields you include replace those values. To rename, also pass 'newName' — the tool then rewrites ALL references to the old name across every equation, arrayEquations entry, and equation-valued additionalProperties field (processTime, capacity, leakFraction, purgeEq, etc.) in every variable across every module, matching case-insensitively in XMILE format (with underscores). To change additionalProperties, provide the COMPLETE replacement object.
- remove: only 'name' is read; all other fields are ignored. Removing a variable also automatically removes every relationship where it is the 'from' or 'to' (its causal arrows), so you do NOT need a separate edit_relationships call to clean those up. Note this does NOT rewrite equations that still reference the removed variable — fix those separately.

CRITICAL EQUATION RULES:
- XMILE naming: replace spaces with underscores in variable references inside equations ("birth_rate" not "birth rate")
- Every variable MUST have either 'equation' OR 'arrayEquations' (never both, never neither). For arrayed STOCKS, always use arrayEquations to give per-element initial values.
- All equations should be simple enough to explain in plain language and must NEVER include hard-coded physical, empirical, or arbitrary constants (e.g. 9.81, 0.05, 3.14159, 100) directly inside the equation — abstract every arbitrary value into a clearly named variable. Dimensionless numbers are permitted ONLY when they serve a fundamental structural, geometric, or algorithmic purpose in the formula: complements/inversions (e.g. 1 - x), boundary/clipping limits (e.g. MAX(0, x), MIN(1, x)), structural divisions and averages (e.g. x / 2), and constants required by standard mathematical identities (e.g. the 2 and 4 in the quadratic formula, or exponents like x^2)
- Stock-flow constraint: a flow can NEVER appear in BOTH inflows AND outflows of the same stock
- SUM function syntax: always use asterisk for the dimension being summed, e.g. SUM(Revenue[*]) — every SUM equation must contain at least one *

CRITICAL MODULE RULES:
- Variable names use ONLY the immediate owning module as a prefix: "ModuleName.variableName"
- NEVER use the full hierarchy path in a variable name (WRONG: "Company.Sales.revenue", CORRECT: "Sales.revenue")
- Cross-module references require ghost variables: set crossLevelGhostOf to the source variable name, leave equation empty
- To change the attributes of a cross-level ghost, edit the SOURCE variable (the one named in crossLevelGhostOf), NOT the ghost itself — the ghost mirrors its source

CRITICAL ARRAY RULES:
- Array dimensions must be defined in specs.arrayDimensions BEFORE any variable references them (use edit_specs first)
- For arrayed variables, set 'dimensions' to the list of dimension names that exist in specs.arrayDimensions
- If all elements share one formula, provide 'equation' only; if elements differ, provide 'arrayEquations' for every element and leave 'equation' empty

CRITICAL SUBTYPE RULES (queue/oven/conveyor/leakage/discreteOutflow/queueOutflow/queueOverflow):
- Use sub-types ONLY when the model already has discrete-entity semantics or the user explicitly requests them — they add significant complexity
- Stock sub-types: set subType, plus additionalProperties for queue/oven/conveyor (not nonNegative); equation is still the initial value (like a regular stock)
- Flow sub-types: set subType only and leave equation as "" — the flow is computed automatically, do NOT write an equation
- All sub-type settings (processTime, capacity, leakFraction, etc.) go in additionalProperties, NEVER embedded in equations
- Every variable referenced in an additionalProperties equation REQUIRES a relationship arrow FROM that variable TO the element
- CONVEYOR WIRING: every conveyorLeakage flow MUST appear in the outflows of its source conveyor AND in the inflows of its destination. NEVER split a conveyor outflow with auxiliary arithmetic — route directly to one destination.
- queueOverflow flows require overflow: true on the queue's additionalProperties
- Use conveyor (not plain stock) when entities must spend a minimum/fixed duration in a stage; use a plain stock when residence time is exponentially distributed (first-order delay)

After editing, the model is validated and sent to the client for processing before the session state is updated.`,
    supportedModes: ['sfd', 'cld'],
    requiresModelContent: true,
    inputSchema: z.object({
      operation: z.enum(['add', 'update', 'remove']).describe('Operation to perform'),
      data: z.array(z.object({
        ...variableBase,
        newName: z.string().describe(LLMWrapper.SCHEMA_STRINGS.name).optional()
      }).partial().required({ name: true })).describe('Array of variable objects. Each requires name; for add also requires type; for update fields you include replace those values (pass newName to rename); for remove only name is read.')
    }),
    handler: async ({ operation, data }) => {
      try {
        return await applyEdit({
          sessionManager, sessionId, sendToClient,
          section: 'variables', operation,
          mutate: variablesMutator(operation, data)
        });
      } catch (error) {
        return createErrorResponse(`Failed to edit variables: ${error.message}`, error);
      }
    }
  };
}

/**
 * Edit relationships: add, update, or remove.
 */
export function createEditRelationshipsTool(sessionManager, sessionId, sendToClient) {
  return {
    description: `Edit the relationships section of the model. A relationship is a causal arrow from one variable to another with a polarity (+ or -). data is always an array of relationship objects. Each object must include 'from' and 'to'. Other fields are interpreted by operation:

- add: include polarity and (optionally) reasoning/polarityReasoning/delay for each new relationship
- update: 'from' and 'to' locate the existing relationship; other fields you include replace those values
- remove: only 'from' and 'to' are read; other fields are ignored

Delay marks: delay: true draws a delay mark (||) on the arrow; delay: false removes it. It changes no equation. Marks belong mainly in causal loop diagrams, where you mark only the delays that shape the behavior. In a stock-and-flow model, set or remove one only when the user asks, and never add a DELAY or SMTH function because a link is marked.

CRITICAL: Every variable referenced inside an additionalProperties equation on a discrete-entity element (e.g. processTime, capacity, leakFraction, purgeEq, queueOutflowPriority) REQUIRES a relationship arrow FROM that referenced variable TO the element.`,
    supportedModes: ['sfd', 'cld'],
    requiresModelContent: true,
    inputSchema: z.object({
      operation: z.enum(['add', 'update', 'remove']).describe('Operation to perform'),
      data: z.array(
        z.object(relationshipBase).partial().required({ from: true, to: true })
      ).describe('Array of relationship objects. Each requires from and to; for add also requires polarity; for update fields you include replace those values; for remove only from and to are read.')
    }),
    handler: async ({ operation, data }) => {
      try {
        return await applyEdit({
          sessionManager, sessionId, sendToClient,
          section: 'relationships', operation,
          mutate: relationshipsMutator(operation, data)
        });
      } catch (error) {
        return createErrorResponse(`Failed to edit relationships: ${error.message}`, error);
      }
    }
  };
}

/**
 * Edit simulation specs (startTime, stopTime, dt, timeUnits, arrayDimensions).
 */
export function createEditSpecsTool(sessionManager, sessionId, sendToClient) {
  return {
    description: `Update the simulation specs (startTime, stopTime, dt, timeUnits, arrayDimensions). Only fields you include in data are changed; omitted fields keep their current values.

CRITICAL: When updating arrayDimensions, provide the COMPLETE array — it replaces the entire arrayDimensions list. Each dimension requires all four fields (type, name, size, elements) and elements.length MUST equal size. Define dimensions here BEFORE any variable references them via its 'dimensions' field.`,
    supportedModes: ['sfd', 'cld'],
    requiresModelContent: true,
    inputSchema: z.object({
      data: z.object(simSpecsBase).partial().describe('Spec fields to update. Only included fields are changed.')
    }),
    handler: async ({ data }) => {
      try {
        return await applyEdit({
          sessionManager, sessionId, sendToClient,
          section: 'specs', operation: 'update',
          mutate: specsMutator(data)
        });
      } catch (error) {
        return createErrorResponse(`Failed to edit specs: ${error.message}`, error);
      }
    }
  };
}

/**
 * Edit modules: add, update (replace entire hierarchy), or remove.
 */
export function createEditModulesTool(sessionManager, sessionId, sendToClient) {
  return {
    description: `Edit the module hierarchy. data is always an array of module objects. Each object must include 'name'. Other fields are interpreted by operation:

- add: include 'parentModule' (string parent name, or null for a root module)
- update: data is the COMPLETE replacement array — every module you want kept must be present with its parentModule; modules omitted are dropped
- remove: only 'name' is read; other fields are ignored

IMPORTANT: The modules array only defines the hierarchical structure. It does NOT control which variables belong to a module — variable membership is determined by the variable name prefix ("Finance.revenue" belongs to Finance). To move a variable between modules, edit the variable's name via edit_variables (operation: update, newName: "NewModule.variableName").`,
    supportedModes: ['sfd', 'cld'],
    requiresModelContent: true,
    inputSchema: z.object({
      operation: z.enum(['add', 'update', 'remove']).describe('Operation to perform'),
      data: z.array(
        LLMWrapper.moduleSchema(LLMWrapper.SCHEMA_STRINGS).partial().required({ name: true })
      ).describe('Array of module objects. Each requires name; for add/update also include parentModule; for remove only name is read.')
    }),
    handler: async ({ operation, data }) => {
      try {
        return await applyEdit({
          sessionManager, sessionId, sendToClient,
          section: 'modules', operation,
          mutate: modulesMutator(operation, data)
        });
      } catch (error) {
        return createErrorResponse(`Failed to edit modules: ${error.message}`, error);
      }
    }
  };
}
