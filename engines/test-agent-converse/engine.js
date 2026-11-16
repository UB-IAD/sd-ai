import { runAgent } from '../../agent/utilities/AgentEvalRunner.js';
import logger from '../../utilities/logger.js';

class Engine {
  static supportedModes() {
    return ['sfd', 'cld'];
  }

  static description() {
    return 'Test engine that runs an agent through a whole conversation for the agent evals: scripted follow-up turns, or a scripted user who answers its questions from a fact bank. Returns the model, the agent text, the transcript, per-turn model snapshots and the tool log. Never shown in the public engine list.';
  }

  additionalParameters() {
    return [
      {
        name: 'agentName',
        type: 'string',
        required: true,
        uiElement: 'text',
        label: 'Agent Name',
        description: 'Which agent config to use (e.g. merlin, socrates)'
      },
      {
        name: 'agentMode',
        type: 'string',
        required: false,
        uiElement: 'text',
        label: 'Agent Mode',
        description: 'Execution mode override: sdk or manual. Defaults to the agent config value.'
      },
      {
        name: 'provider',
        type: 'string',
        required: false,
        uiElement: 'text',
        label: 'Provider',
        description: 'LLM provider: anthropic (default) or google'
      },
      {
        name: 'mode',
        type: 'string',
        required: true,
        uiElement: 'text',
        label: 'Mode',
        description: 'Model type: sfd or cld'
      },
      {
        name: 'intelligence',
        type: 'string',
        required: false,
        uiElement: 'text',
        label: 'Intelligence',
        description: 'Intelligence level id from the provider ladder in config.agentIntelligence (e.g. standard, high, maximum). Picks the conversation model. Defaults to the provider default level.'
      },
      {
        name: 'toolModels',
        type: 'json',
        required: false,
        uiElement: 'hidden',
        label: 'Tool Models',
        description: 'Engine-tool lane override, shaped like an agentToolModels lane: { build: { normal, hard }, nonBuild: { normal, hard } }. Pins what the engine tools run on for this whole run instead of resolving the shared config lane.'
      },
      {
        name: 'problemStatement',
        type: 'string',
        required: false,
        uiElement: 'textarea',
        saveForUser: 'local',
        label: 'Problem Statement',
        description: 'Description of a dynamic issue within the system you are studying that highlights an undesirable behavior over time.',
        minHeight: 50,
        maxHeight: 100
      },
      {
        name: 'backgroundKnowledge',
        type: 'string',
        required: false,
        uiElement: 'textarea',
        saveForUser: 'local',
        label: 'Background Knowledge',
        description: 'Background information you want the LLM model to consider when generating a diagram for you',
        minHeight: 100
      },
      {
        name: 'turns',
        type: 'json',
        required: false,
        uiElement: 'hidden',
        label: 'Turns',
        description: 'Eval-only: follow-up user messages sent in order after the first, each after the agent finishes its turn.'
      },
      {
        name: 'userScript',
        type: 'json',
        required: false,
        uiElement: 'hidden',
        label: 'User Script',
        description: 'Eval-only: a scripted user, { id, facts: [{ id, topic, text }], unknownReply, maxQuestionTurns, maxFactsPerTurn, closingMessage }, who answers the agent\'s questions from the fact bank and nothing else.'
      },
      {
        name: 'analysisTools',
        type: 'boolean',
        required: false,
        uiElement: 'hidden',
        label: 'Analysis Tools',
        description: 'Eval-only: give the agent the evals\' scenario, sensitivity, calibration and optimization tools as client tools.'
      },
      {
        name: 'calibrationData',
        type: 'json',
        required: false,
        uiElement: 'hidden',
        label: 'Calibration Data',
        description: 'Eval-only: the historical data load_calibration_data returns, as { series: { name: [{ time, value }] } }.'
      },
      {
        name: 'unitChecking',
        type: 'boolean',
        required: false,
        uiElement: 'hidden',
        label: 'Unit Checking',
        description: 'Eval-only: report the evals unit checker\'s warnings to the agent as unitWarnings on every model echo, the way Stella reports its unit check.'
      },
      {
        name: 'attachments',
        type: 'json',
        required: false,
        uiElement: 'hidden',
        label: 'Attachments',
        description: 'Eval-only: files to attach to the session as if the user had uploaded them, as [{ path, name? }]. They go through RagStore, so the agent finds them with search_documents and read_file.'
      }
    ];
  }

  async generate(prompt, currentModel, parameters) {
    try {
      const { lastModel, explanation, toolLog, transcript, snapshots } = await runAgent(prompt, currentModel, parameters);
      const model = lastModel || { variables: [], relationships: [] };
      return {
        output: { textContent: explanation },
        transcript: transcript || [],
        snapshots: snapshots || [],
        supportingInfo: {
          title: model.title,
          explanation
        },
        model: {
          relationships: model.relationships || [],
          variables: model.variables || [],
          ...(model.specs   && { specs: model.specs }),
          ...(model.modules && { modules: model.modules })
        },
        // What the agent did, not only what it produced: process-graded categories read this.
        toolLog
      };
    } catch (err) {
      logger.error('[test-agent-converse] generate error:', err);
      return { err: err.toString() };
    }
  }
}

export default Engine;
