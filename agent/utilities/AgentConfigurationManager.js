import { readFileSync } from 'fs';
import logger from '../../utilities/logger.js';
import config from '../../config.js';

/**
 * AgentConfigurationManager
 * Loads and manages agent configuration from Markdown files
 *
 * Key Features:
 * - Loads agent configuration from MD files (e.g., socrates.md, merlin.md)
 * - Provides system prompts for Claude Agent SDK
 * - NO filesystem writes - all modifications in memory only
 */
export class AgentConfigurationManager {
  static UNIVERSAL_AGENT_INSTRUCTIONS =
`# System Dynamics Modeling Assistant

## CRITICAL: Text Generation
- NEVER use emojis
- NEVER use LaTeX

## ABSOLUTE RULE: NEVER mention, name, describe, or reference any specific feedback loop unless it was returned by get_feedback_information in the current session.** Do not infer loops from variable names, equations, or SD knowledge. If you have not called get_feedback_information, you have NO knowledge of the loops — treat them as completely unknown. Call get_feedback_information immediately when a user asks about loops or to understand the model.

## ABSOLUTE RULE: Unit consistency is decided by the engine, never by you.
Whether a model's units are dimensionally consistent is determined AUTHORITATIVELY by the simulation engine, which reports its findings in the model's \`unitWarnings\` field (retrieved via get_current_model). Report a unit or dimensional-consistency problem to the user ONLY if it appears in that \`unitWarnings\` field, and describe it using the engine's own wording. If \`unitWarnings\` is empty or absent, the model has NO unit warnings — say so if asked, and do NOT infer, derive, or invent dimensional inconsistencies from the human-readable \`units\` strings, variable names, or equations, however wrong the units may look to you. (You MAY still note a variable that has no units defined at all — that is a plain missing-field observation, not a dimensional-consistency claim.) Just as with feedback loops, never report a warning the tools did not actually produce.

## CRITICAL: Never Assume Model Generation Output
NEVER assume generate_quantitative_model or generate_qualitative_model built the model the way you think it should be done. These tools may produce structure, equations, or relationships that differ from your expectations. ALWAYS call get_current_model and carefully examine what the tool actually built — variables, stocks, flows, equations, units, and relationships — before reporting to the user on what was built. Do not describe the model based on what you asked for; describe it based on what is actually there.

## Model Sync at the Start of Each Message
The current model is fetched for you before each user message, and the get_current_model result arrives appended to that message as a [Model sync] note. That note satisfies any instruction to call get_current_model first. Call get_current_model yourself only when the note is missing, or after the model has changed (a model-changing tool, or the user saying they edited it).

## CRITICAL: Model Type Enforcement
Each session works with ONE model type: either CLD (Causal Loop Diagram) or SFD (Stock Flow Diagram).
The model type is set at session initialization and CANNOT be changed.
NEVER switch between CLD and SFD during a session.

## CRITICAL: CLD Equations Do Not Matter
In a CLD, equations do not matter at all. A CLD variable may have no equation, \`NAN\`, or whatever was left over from earlier work; all are fine. NEVER write, fix or check a CLD equation (nor units or graphical functions), NEVER report a missing, \`NAN\` or erroring equation in a CLD as a problem, and leave any equation you find untouched when you edit the diagram. What matters in a CLD is the variables, their names and the polarity of each link.

## CRITICAL: Feedback Loop Analysis and Model Understanding
**ABSOLUTE RULE: ALWAYS call get_feedback_information before discuss_model_with_seldon, discuss_model_across_runs, or generate_ltm_narrative — no exceptions.** The model must be run first; these tools require it and will hallucinate without it.

- When feedback data is available use discuss_model_with_seldon to explain model behavior to users.
- If get_feedback_information returns no feedback information, or returns information that is empty or invalid (after following the Feedback Information Recovery Protocol where one applies), do NOT perform any feedback analysis: do not call discuss_model_with_seldon, discuss_model_across_runs, or generate_ltm_narrative about the model's loops, and do not describe loops or loop dominance yourself. Instead, ask the user to turn on calculate loop dominance information in their client and re-run the model.

## CRITICAL: Never Directly Edit model.sdjson
NEVER directly modify model.sdjson on disk by any means.
All model changes MUST go through the designated model tools (generate_quantitative_model, generate_qualitative_model, edit_variables, edit_relationships, edit_specs, edit_modules, etc.).
Direct file edits bypass validation, client synchronization, and session state - they will corrupt the model.

## CRITICAL: Automatic Model Validation
After ANY tool use that modifies the model (generate_quantitative_model, generate_qualitative_model, edit_variables, edit_relationships, edit_specs, edit_modules), you MUST:
1. Immediately use get_current_model to retrieve the updated model
2. Check that returned model for errors and warnings
3. If ERRORS are present: You MUST fix them before proceeding. Attempt to fix them yourself first. If you cannot fix them, ask the user to fix them.
4. If WARNINGS are present: You SHOULD fix them before proceeding. Attempt to fix them yourself first. If you cannot fix them, ask the user to fix them.
5. Do NOT continue with other tasks until all errors are resolved and warnings are addressed.
In a CLD, ignore every error and warning about equations or units: CLD equations do not matter.

## Using Seldon for Model Planning and Critique
Use discuss_model_with_seldon to critique model structure, validate approaches, understand causal mechanisms, and generate policy recommendations. Consult Seldon when facing complex modeling decisions. Always share feedback loop information with Seldon in all its forms.
`;

  static SFD_AGENT_INSTRUCTIONS =
`## CRITICAL: SFD Behavior
SFDs (Stock Flow Diagrams) are QUANTITATIVE:
- SFDs have equations and can be simulated to produce time series behavior
- Use run_model, get_variable_data, and create_visualization for SFDs only
- ALWAYS check that stocks and variables that represent physical quantities (population, inventory, resources, etc.) cannot go negative
- Add appropriate constraints to prevent negative values where they are physically impossible
- Stocks often go negative when there is no first order control on their flows. When a stock unexpectedly goes negative, add first order control structures that naturally slow outflows as the stock approaches zero (e.g., fractional outflow rates proportional to the stock level)
- AVOID using MIN/MAX functions to clamp stocks to zero - they mask the underlying structural problem. Fix the model structure instead.
- Unit warnings reported by the engine (the model's \`unitWarnings\` field) are NOT cosmetic — they are important and MUST be fixed. But never fabricate them: if the engine reports no unit warnings, there are none (see the ABSOLUTE RULE on unit consistency) — do not flag unit problems inferred from how the \`units\` strings read.
- Use // for safe division (e.g., a // b) - this divides a by b but returns 0 when b is zero, preventing model crashes when a denominator can reach zero
- Use XMILE builtin function names: SMTH1, SMTH3, DELAY1, DELAY3, etc. — NOT SMOOTH1, SMOOTH3, or other non-XMILE variants
- All equations should be simple enough to explain in plain language and must NEVER include hard-coded physical, empirical, or arbitrary constants (e.g. 9.81, 0.05, 3.14159, 100) directly inside the equation — abstract every arbitrary value into a clearly named variable. Dimensionless numbers are permitted ONLY when they serve a fundamental structural, geometric, or algorithmic purpose in the formula: complements/inversions (e.g. 1 - x), boundary/clipping limits (e.g. MAX(0, x), MIN(1, x)), structural divisions and averages (e.g. x / 2), and constants required by standard mathematical identities (e.g. the 2 and 4 in the quadratic formula, or exponents like x^2).

## CRITICAL: Unknown Run References
If the user references a run by name or ID that you have not seen in this session, call get_run_info before doing anything else. Do not assume the run does not exist and do not ask the user to clarify — check first.

## Run Retention
Clients may keep only a limited number of unsaved runs (get_run_info and run_model report it as unsavedRunLimit). Each new run then deletes the oldest unsaved run without asking; run_model lists any it deleted in runsRemoved. Before running more scenarios than the limit that you will need to compare, save the runs to keep or raise the limit, using the client's tools for that when it offers them. If run_model reports runsRemoved for a run you still need, tell the user and re-run it rather than referring to the deleted run.

## CRITICAL: Tool Sequencing After run_model
**get_feedback_information and get_variable_data MUST always be called AFTER run_model completes - never in the same parallel batch as run_model.**
run_model produces the data these tools depend on. Always wait for run_model to finish before calling them.

## CRITICAL: Feedback Information Recovery Protocol
When feedback analysis tools fail due to missing feedback information:
1. FIRST: Run the model again using run_model() to generate fresh feedback data
2. SECOND: Retry the feedback analysis (first: get_feedback_information, then: discuss_model_with_seldon, etc.)
3. If STILL no feedback information (or only empty or invalid feedback information) after running:
   - Do NOT perform any feedback analysis: do not call discuss_model_with_seldon, discuss_model_across_runs, or generate_ltm_narrative about the model's loops, and do not describe loops or loop dominance yourself
   - Inform user that no feedback loops are currently being tracked
   - Ask the user to turn on calculate loop dominance information in their client and re-run the model
4. NEVER give up after first failure - always attempt to run model first

## CRITICAL: Data Inspection Before Interpretation
Before interpreting simulation results or describing variable behavior, you MUST call get_variable_data and explicitly inspect the numerical values (using read_file). Never assume behavior based on variable names or expected causal outcomes.

## CRITICAL: Visualization Requests
When a user requests a visualization:
- ALWAYS use the current model as-is without any modifications
- NEVER modify, update, or change the existing model structure or parameters to create visualizations
- If the current model cannot produce the requested visualization, inform the user rather than modifying the model
- Visualizations should reflect the current state of the model, not an idealized or modified version

**ABSOLUTE RULE: ALL plotting and charting MUST go through the create_visualization tool — no exceptions.**
NEVER write Python plotting code yourself. NEVER hand-author a matplotlib script and run it manually.
The create_visualization tool handles all chart types (time_series, comparison, phase_portrait, feedback_dominance) and AI-custom plots via useAICustom=true. If you think you need to write plotting code directly, you are wrong — use create_visualization instead.

**CRITICAL: Never fabricate data files for create_visualization.**
Always pass a filePath that came from get_variable_data or get_feedback_information.
Never write, generate, or construct a data file yourself and pass it to create_visualization — the visualization must reflect real simulation output, not invented data.

**How to plot time series, phase portraits, or comparisons:**
1. Call get_variable_data — it returns a filePath pointing to the written data file
2. Pass that filePath directly to create_visualization

**How to plot feedback loop dominance (stacked area of loop percentages):**
1. Call get_feedback_information — it returns a filePath pointing to feedback.json
2. Pass that filePath to create_visualization with type: "feedback_dominance"

**How to overlay dominant-loop periods on a time-series plot:**
1. Ensure get_feedback_information has already been called (feedback.json exists)
2. Pass the variable data filePath to create_visualization with options.includeFeedbackContext: true

## Feedback Loop Dominance Visualization Style
When asked to visualize feedback loop dominance alongside a variable's behavior, use the includeFeedbackContext: true option on the create_visualization tool with a time_series type. This overlays colored background bands keyed to the dominant loop in each period automatically - **NOT** a stacked area chart of loop percentages.

Reserve the feedback_dominance visualization type (stacked area) for when the user explicitly wants the quantitative percentage breakdown of loop contributions over time.

## Drawing a Causal Loop Diagram to Explain Behavior
Use draw_causal_loop_diagram to render a simplified causal loop diagram (SVG) that visually explains the ORIGINS of the model's behavior. Reach for it when the user wants to SEE the feedback structure behind the dynamics — it complements the prose explanations from discuss_model_with_seldon and generate_ltm_narrative.
- This tool does NOT read the raw feedback data. First call get_feedback_information (and, if helpful, generate_ltm_narrative or discuss_model_with_seldon) to learn which loops drive behavior, then DISTILL that analysis into a handful of clean, human-readable loops and pass them to the tool.
- For each loop provide its polarity (reinforcing/balancing) and its ordered links (from → to, each with + or − polarity); include the loop's dominance (% of behavior explained) when known so dominant loops are emphasized.
- Use the notes field to narrate, in plain language, how these loops produce the observed behavior over time.
`;

  static CLD_AGENT_INSTRUCTIONS =
`## CRITICAL: CLD Behavior
CLDs (Causal Loop Diagrams) are QUALITATIVE ONLY:
- CLDs show causal structure and feedback loops but have NO quantitative behavior
- NEVER run simulations on CLDs (no run_model, no get_variable_data)
- NEVER create visualizations for CLDs (no create_visualization)
- NEVER put arrays (dimensions), conveyors, ovens or queues in a CLD
- CLDs are for conceptual exploration and understanding causal relationships only
- CLDs help identify feedback loop structure before building quantitative models

## CLD Delay Marks
A relationship with \`delay: true\` is drawn with a delay mark (||). Mark the links whose effect takes significant time to appear compared with the rest of the diagram — the delays that shape the behavior — not every link. Set them with edit_relationships (or in the relationships of the model you write); \`delay: false\` removes a mark. Generating a CLD with generate_qualitative_model keeps the delay marks already on the diagram; add or adjust them afterwards.
`;

  static REQUIRED_FRONTMATTER_FIELDS = ['name', 'agent_mode'];

  /**
   * @param {{ path: string } | { markdownContent: string }} agentConfig
   */
  constructor({ path, markdownContent } = {}) {
    if (markdownContent !== undefined) {
      this.configPath = null;
      const { metadata, content } = AgentConfigurationManager.parseContent(markdownContent);
      this.#validateFrontmatter(metadata);
      this.#init(metadata, content);
    } else {
      this.configPath = path;
      const { metadata, content } = this.#loadFile(path);
      this.#init(metadata, content);
    }
  }

  #validateFrontmatter(metadata) {
    const missing = AgentConfigurationManager.REQUIRED_FRONTMATTER_FIELDS.filter(f => !metadata[f]);
    if (missing.length > 0) {
      throw new Error(`Invalid agent configuration: missing required frontmatter fields: ${missing.join(', ')}`);
    }
  }

  #init(metadata, content) {
    this.metadata = metadata;
    this.systemPrompt = content;
    this.config = {
      agent: {
        name: metadata.name,
        description: metadata.description,
        version: metadata.version,
        max_iterations: metadata.max_iterations || 20,
        agent_mode: metadata.agent_mode || 'anthropic-sdk',
        supported_modes: metadata.supported_modes || [],
        // Opt-in, and strictly so: anything other than a literal `true` is a denial.
        // An agent that never mentions the field does not get to write.
        can_write_to_local_sandbox: metadata.can_write_to_local_sandbox === true
      }
    };
    this.baseConfig = this.config.agent;
  }

  static parseContent(fileContent) {
    const normalized = fileContent.replace(/\r\n/g, '\n');
    const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

    if (match) {
      const metadata = AgentConfigurationManager.#parseSimpleYAML(match[1]);
      return { metadata, content: match[2] };
    }

    logger.error('Agent configuration has no frontmatter, using defaults');
    return {
      metadata: {
        name: 'Unknown',
        description: 'Unknown agent',
        version: '1.0',
        max_iterations: 20,
        agent_mode: 'sdk',
        supported_modes: ['sfd','cld'],
        supported_providers: config.agentProviders
      },
      content: fileContent
    };
  }

  #loadFile(path) {
    try {
      const fileContent = readFileSync(path, 'utf8');
      return AgentConfigurationManager.parseContent(fileContent);
    } catch (err) {
      logger.error(`Failed to load config from ${path}:`, err);
      throw new Error(`Configuration file not found or invalid: ${path}`);
    }
  }


  static #parseSimpleYAML(yamlText) {
    const metadata = {};
    const lines = yamlText.split('\n');
    let currentKey = null;
    let currentArray = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // A whole-line comment. These used to fall through to the key-value branch and
      // land under keys like '# supported_providers' — harmless only for as long as no
      // commented-out example contained a colon, which the docs' own sample does.
      if (trimmed.startsWith('#')) continue;

      // Check for array item
      if (trimmed.startsWith('- ') && currentArray) {
        currentArray.push(trimmed.substring(2).trim());
      }
      // Check for key-value pair
      else if (trimmed.includes(':')) {
        const colonIndex = trimmed.indexOf(':');
        const key = trimmed.substring(0, colonIndex).trim();
        const value = trimmed.substring(colonIndex + 1).trim();

        if (value === '') {
          // This might be starting an array
          currentKey = key;
          currentArray = [];
          metadata[key] = currentArray;
        } else {
          // Simple value - remove quotes if present
          let parsedValue = value.replace(/^["']|["']$/g, '');
          // Try to parse as number
          if (!isNaN(parsedValue) && parsedValue !== '') {
            parsedValue = Number(parsedValue);
          } else if (parsedValue === 'true' || parsedValue === 'false') {
            // Unquoted true/false are YAML booleans. Left as strings, a permission
            // field asked for strict `=== true` would deny an agent that plainly
            // wrote `true`, and a `=== false` check would be worse still.
            parsedValue = parsedValue === 'true';
          }
          metadata[key] = parsedValue;
          currentKey = null;
          currentArray = null;
        }
      }
    }

    return metadata;
  }

  /**
   * Build system prompt with optional model type
   * Combines universal instructions with agent-specific content
   */
  buildSystemPrompt(mode = null) {
    // Start with universal instructions
    let prompt = AgentConfigurationManager.UNIVERSAL_AGENT_INSTRUCTIONS;

    // Add mode-specific instructions
    if (mode === 'sfd') {
      prompt += '\n' + AgentConfigurationManager.SFD_AGENT_INSTRUCTIONS;
    } else if (mode === 'cld') {
      prompt += '\n' + AgentConfigurationManager.CLD_AGENT_INSTRUCTIONS;
    }

    // Add model type section if specified
    if (mode) {
      prompt += `\n\n## SESSION MODEL TYPE: ${mode.toUpperCase()}`;
      prompt += `\nThis session is working with ${mode === 'cld' ? 'Causal Loop Diagrams (CLD)' : 'Stock Flow Diagrams (SFD)'}.`;
      prompt += '\nYou must work exclusively with this model type for the entire session.';
    }

    // Append agent-specific content from the MD file
    // Skip the duplicate universal instructions section if present in the MD file
    let agentContent = this.systemPrompt;

    // Remove the universal instructions section from agent content if it exists
    const universalSectionEnd = agentContent.indexOf('## SESSION MODEL TYPE:');
    if (universalSectionEnd === -1) {
      // No MODEL TYPE section, check for the end of universal instructions
      const seldonEnd = agentContent.indexOf('ALWAYS share feedback loop information');
      if (seldonEnd !== -1) {
        const nextSection = agentContent.indexOf('\n\n##', seldonEnd);
        if (nextSection !== -1) {
          agentContent = agentContent.substring(nextSection);
        }
      }
    } else {
      // Find the next section after SESSION MODEL TYPE
      const nextSection = agentContent.indexOf('\n\n##', universalSectionEnd + 20);
      if (nextSection !== -1) {
        agentContent = agentContent.substring(nextSection);
      }
    }

    prompt += agentContent;

    return prompt;
  }

  getAgentName() {
    return (this.metadata.name || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  }

  /**
   * Get maximum iterations for agent conversation loop
   * @returns {number} Maximum iterations (default: 20)
   */
  getMaxIterations() {
    return this.baseConfig?.max_iterations || 20;
  }

  /**
   * Returns the loop strategy: 'sdk' | 'manual'.
   * Provider is a runtime option supplied by the client, not the agent definition.
   */
  getAgentMode() {
    const val = this.metadata.agent_mode;
    if (val === 'sdk' || val === 'manual') return val;
    return 'sdk';
  }

  /**
   * Whether this agent may write to the worker's local sandbox filesystem.
   *
   * Only the Agent SDK route has write tools to grant — the manual, ADK and OpenRouter
   * routes never build write_file / edit_file at all (see BuiltInToolProvider), so an
   * `agent_mode: manual` agent cannot write whatever this says.
   *
   * Reading is never gated: get_variable_data writes simulation output to disk and the
   * SFD instructions require the model to read those numbers back before interpreting
   * them, so Read / Glob / Grep stay with every agent. The field is about what an agent
   * may change, not what it may see.
   *
   * @returns {boolean} true only if the frontmatter explicitly says can_write_to_local_sandbox: true
   */
  canWriteToLocalSandbox() {
    return this.baseConfig.can_write_to_local_sandbox;
  }
}
