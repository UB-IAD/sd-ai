import { runAgent } from '../../agent/utilities/AgentEvalRunner.js';
import logger from '../../utilities/logger.js';

class Engine {
  static supportedModes() {
    return ['sfd', 'cld'];
  }

  static description() {
    return 'Test engine that wraps AgentOrchestrator for model-generation evals. Never shown in the public engine list.';
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
      const { lastModel, explanation, toolLog } = await runAgent(prompt, currentModel, parameters);
      if (!lastModel) {
        return { err: 'Agent did not produce a model' };
      }
      return {
        supportingInfo: {
          title: lastModel.title,
          explanation
        },
        model: {
          relationships: lastModel.relationships || [],
          variables: lastModel.variables || [],
          ...(lastModel.specs   && { specs: lastModel.specs }),
          ...(lastModel.modules && { modules: lastModel.modules })
        },
        // What the agent did, not only what it produced: process-graded categories read this.
        toolLog
      };
    } catch (err) {
      logger.error('[test-agent-build] generate error:', err);
      return { err: err.toString() };
    }
  }
}

export default Engine;
