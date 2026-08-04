import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import Anthropic from "@anthropic-ai/sdk";
import { OpenRouter } from "@openrouter/sdk";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { extractJsonFromContent } from "./jsonUtils.js";
import TokenUsageReporter, { Provider } from "./TokenUsageReporter.js";
import config from "../config.js";

export const ModelType = Object.freeze({
  GEMINI:   Symbol("Gemini"),
  OPEN_AI:  Symbol("OpenAI"),
  LLAMA: Symbol("Llama"),
  DEEPSEEK: Symbol("Deepseek"),
  CLAUDE: Symbol("Claude"),
  OPEN_ROUTER: Symbol("OpenRouter")
});

// OpenRouter model slugs are namespaced as `<provider>/<model>` — the slash is the
// reliable signal that a model should be routed via the OpenRouter SDK rather than
// matching `qwen`/`deepseek`/`kimi` substrings (which previously meant local-LMStudio).
const OPEN_ROUTER_SLUG_REGEX = /\//;


export class ModelCapabilities {
  hasStructuredOutput= true;
  hasSystemMode = true;
  hasTemperature = true;
  systemModeUser = 'system';

  name = 'model';

  constructor(modelName) {
      this.name = modelName;
      const lowerModelName = modelName.toLowerCase();
      const isOpenRouter = OPEN_ROUTER_SLUG_REGEX.test(lowerModelName);

      this.hasStructuredOutput = lowerModelName !== 'o1-mini';
      // Native DeepSeek models (bare ids like 'deepseek-v4-pro', as opposed to the
      // namespaced OpenRouter slug 'deepseek/deepseek-v4-pro') support only the
      // json_object response_format, not json_schema — so they fall back to
      // prompt-level JSON enforcement (#injectJsonFallback). The OpenRouter-routed
      // slug keeps json_schema because OpenRouter translates it for the upstream.
      if (!isOpenRouter && lowerModelName.includes('deepseek')) {
          this.hasStructuredOutput = false;
      }
      this.hasSystemMode = lowerModelName !== 'o1-mini';
      this.hasTemperature = !lowerModelName.startsWith('o') && !lowerModelName.startsWith('gpt-5');
      if (isOpenRouter || lowerModelName.includes('gemini') || lowerModelName.includes('llama') || lowerModelName.includes('claude') || lowerModelName.includes('deepseek')) {
          this.systemModeUser = 'system';
      } else {
          this.systemModeUser = 'developer';
      }
  }

  get kind() {
      const lowerModelName = this.name.toLowerCase();
      // OpenRouter slugs are namespaced (e.g. 'qwen/qwen3.7-max') — check this BEFORE
      // the substring routes below, since those would otherwise claim 'qwen', 'kimi',
      // and 'deepseek' for the local LMStudio path.
      if (OPEN_ROUTER_SLUG_REGEX.test(lowerModelName)) {
          return ModelType.OPEN_ROUTER;
      } else if (lowerModelName.includes('gemini')) {
          return ModelType.GEMINI;
      } else if (lowerModelName.includes('llama') || lowerModelName.includes('glm') || lowerModelName.includes('kimi') || lowerModelName.includes('qwen') || lowerModelName.includes('mistral')) {
          return ModelType.LLAMA;
      } else if (lowerModelName.includes('deepseek')) {
          return ModelType.DEEPSEEK;
      } else if (lowerModelName.includes('claude')) {
          return ModelType.CLAUDE;
      } else {
          return ModelType.OPEN_AI;
      }
  }

  // Which Claude models accept `thinking: {type: "adaptive"}`. Sending adaptive
  // to a model that doesn't support it (Sonnet 4.5, Haiku 4.5, Opus 4.5 and
  // earlier) is a 400, so we only auto-enable thinking where it's accepted:
  // the Fable/Mythos models (always-on), plus Sonnet and Opus from 4.6 onward.
  get supportsAdaptiveThinking() {
      const n = this.name.toLowerCase();
      if (n.includes('fable') || n.includes('mythos')) return true;
      // Adaptive landed on Sonnet 4.6 and Opus 4.6; assume every later version of
      // those families keeps it. Parse <family>-<major>[-<minor>] and compare to the
      // first version that supported it so new releases don't need a code change.
      // The minor is optional because the 5 generation dropped it (claude-opus-5,
      // claude-sonnet-5); a missing minor counts as 0, which is fine since those
      // ids are all major-version bumps past the threshold.
      const thresholds = { sonnet: [4, 6], opus: [4, 6] };
      for (const [family, [minMajor, minMinor]] of Object.entries(thresholds)) {
          const m = n.match(new RegExp(`${family}-(\\d+)(?:-(\\d+))?`));
          if (m) {
              const major = Number(m[1]);
              const minor = m[2] === undefined ? 0 : Number(m[2]);
              if (major > minMajor || (major === minMajor && minor >= minMinor)) return true;
          }
      }
      return false;
  }
};

export class LLMWrapper {

  #openAIKey;
  #googleKey;
  #anthropicKey;
  #openRouterKey;
  #deepseekKey;
  #clientKey = false;
  #temperatureOverride;
  #topP;
  #topK;
  #seed;
  #maxTokens;
  #thinking;
  #jsonObjectMode = false;
  #localBaseURL;
  #openAIAPI = null;
  #geminiAPI = null;
  #anthropicAPI = null;
  #openRouterAPI = null;
  #deepseekAPI = null;
  #tokenReporter = null;
  // Per-model cache of the Anthropic model's maximum output tokens, resolved
  // lazily from the Models API so we never impose an arbitrary cap that could
  // truncate a large generation mid-JSON.
  #anthropicMaxTokensByModel = new Map();

  model = new ModelCapabilities(LLMWrapper.BUILD_DEFAULT_MODEL);

  constructor(parameters = {}) {
    if (!parameters.openAIKey) {
        this.#openAIKey = process.env.OPENAI_API_KEY
    } else {
      this.#openAIKey = parameters.openAIKey;
      if (parameters.openAIKey !== process.env.OPENAI_API_KEY) {
        this.#clientKey = true;
      }
    }

    if (!parameters.googleKey) {
        this.#googleKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    } else {
      this.#googleKey = parameters.googleKey;
      if (parameters.googleKey !== process.env.GEMINI_API_KEY && parameters.googleKey !== process.env.GOOGLE_API_KEY) {
        this.#clientKey = true;
      }
    }

    if (!parameters.anthropicKey) {
        this.#anthropicKey = process.env.ANTHROPIC_API_KEY
    } else {
      this.#anthropicKey = parameters.anthropicKey;
      if (parameters.anthropicKey !== process.env.ANTHROPIC_API_KEY) {
        this.#clientKey = true;
      }
    }

    if (!parameters.openRouterKey) {
        this.#openRouterKey = process.env.OPEN_ROUTER_API_KEY
    } else {
      this.#openRouterKey = parameters.openRouterKey;
      if (parameters.openRouterKey !== process.env.OPEN_ROUTER_API_KEY) {
        this.#clientKey = true;
      }
    }

    if (!parameters.deepseekKey) {
        this.#deepseekKey = process.env.DEEPSEEK_API_KEY
    } else {
      this.#deepseekKey = parameters.deepseekKey;
      if (parameters.deepseekKey !== process.env.DEEPSEEK_API_KEY) {
        this.#clientKey = true;
      }
    }

    this.#temperatureOverride = parameters.temperature ?? parameters.temp ?? parameters.temperatureOverride;
    this.#topP = parameters.top_p ?? parameters.topP;
    this.#topK = parameters.top_k ?? parameters.topK;
    this.#seed = parameters.seed ?? parameters.randomSeed;
    this.#maxTokens = parameters.max_tokens ?? parameters.maxTokens;
    this.#thinking = parameters.thinking;
    this.#localBaseURL = parameters.baseURL ?? 'http://localhost:1234/v1';

    if (parameters.underlyingModel)
      this.model = new ModelCapabilities(parameters.underlyingModel);

    if (parameters.structuredOutput === false)
      this.model.hasStructuredOutput = false;

    if (parameters.jsonObjectMode === true)
      this.#jsonObjectMode = true;

    this.#tokenReporter = new TokenUsageReporter(config.tokenReporterURL, parameters.clientId ?? null);

    switch (this.model.kind) {
        case ModelType.GEMINI:
            if (!this.#googleKey) {
              throw new Error("To access this service you need to send a Google key");
            }

            this.#geminiAPI = new GoogleGenAI({ apiKey: this.#googleKey });
            break;
        case ModelType.OPEN_AI:
            if (!this.#openAIKey) {
              throw new Error("To access this service you need to send an OpenAI key");
            }

            this.#openAIAPI = new OpenAI({
                apiKey: this.#openAIKey,
            });
            break;
        case ModelType.CLAUDE:
            if (!this.#anthropicKey) {
              throw new Error("To access this service you need to send an Anthropic key");
            }

            this.#anthropicAPI = new Anthropic({
                apiKey: this.#anthropicKey,
            });
            break;
        case ModelType.OPEN_ROUTER:
            if (!this.#openRouterKey) {
              throw new Error("To access this service you need to send an OpenRouter key");
            }

            this.#openRouterAPI = new OpenRouter({
                apiKey: this.#openRouterKey,
            });
            break;
        case ModelType.DEEPSEEK:
            if (!this.#deepseekKey) {
              throw new Error("To access this service you need to send a DeepSeek key");
            }

            // DeepSeek exposes an OpenAI-compatible API. DEEPSEEK_BASE_URL lets
            // deployments point it at any OpenAI-compatible gateway (proxy, cloud
            // vendor endpoint); the default is the official API.
            this.#deepseekAPI = new OpenAI({
                apiKey: this.#deepseekKey,
                baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
                timeout: (parameters.timeoutMinutes ?? 30) * 60 * 1000,
            });
            break;
        case ModelType.LLAMA:
            // Local LM Studio server
            this.#openAIAPI = new OpenAI({
                apiKey: 'junk', // required but unused
                baseURL: this.#localBaseURL,
                timeout: (parameters.timeoutMinutes ?? 30) * 60 * 1000,
            });
            break;
    }
  }

  static MODELS = [
      {label: "GPT-5.6 Sol", value: 'gpt-5.6-sol'},
      {label: "GPT-5.6 Terra", value: 'gpt-5.6-terra'},
      {label: "GPT-5.6 Luna", value: 'gpt-5.6-luna'},
      {label: "Gemini 3.1-pro-preview", value: 'gemini-3.1-pro-preview'},
      {label: "Gemini 3.6-flash", value: 'gemini-3.6-flash'},
      {label: "Gemini 3.6-flash high", value: 'gemini-3.6-flash high'},
      {label: "Gemini 3.6-flash medium", value: 'gemini-3.6-flash medium'},
      {label: "Gemini 3.6-flash low", value: 'gemini-3.6-flash low'},
      {label: "Gemini 3.5-flash", value: 'gemini-3.5-flash'},
      {label: "Gemini 2.5-flash", value: 'gemini-2.5-flash'},
      {label: "Gemini 2.5-pro", value: 'gemini-2.5-pro'},
      {label: "Claude Fable 5", value: 'claude-fable-5'},
      {label: "Claude Opus 5", value: 'claude-opus-5'},
      {label: "Claude Sonnet 5", value: 'claude-sonnet-5'},
      {label: "Claude Haiku 4.5", value: 'claude-haiku-4-5'},
      {label: "Qwen3.7 Max", value: 'qwen/qwen3.7-max'},
      {label: "Qwen3.7 Plus", value: 'qwen/qwen3.7-plus'},
      {label: "Deepseek v4 Pro", value: 'deepseek/deepseek-v4-pro'},
      {label: "Deepseek v4 Flash", value: 'deepseek/deepseek-v4-flash'},
      // Native DeepSeek API models (routed directly to DEEPSEEK_API_KEY, not OpenRouter)
      {label: "Deepseek v4 Pro (API)", value: 'deepseek-v4-pro'},
      {label: "Deepseek v4 Flash (API)", value: 'deepseek-v4-flash'},
      {label: "Kimi K3", value: 'moonshotai/kimi-k3'},
      {label: "GLM 5.2", value: 'z-ai/glm-5.2'},
  ];

  static BUILD_DEFAULT_MODEL = config.buildDefaultModel;
  static NON_BUILD_DEFAULT_MODEL = config.nonBuildDefaultModel;
  static EVAL_MODEL = process.env.EVAL_MODEL ?? 'gemini-2.5-flash';
  
  static SCHEMA_STRINGS = {
    "from": "This is a variable which causes the to variable in this relationship that is between two variables, from and to.  The from variable is the equivalent of a cause.  The to variable is the equivalent of an effect",
    "to": "This is a variable which is impacted by the from variable in this relationship that is between two variables, from and to.  The from variable is the equivalent of a cause.  The to variable is the equivalent of an effect",
    "reasoning": "This is an explanation for why this relationship exists",
    "polarity": "There are two possible kinds of relationships.  The first are relationships with positive polarity that are represented with a + symbol.  In relationships with positive polarity (+) a change in the from variable causes a change in the same direction in the to variable.  For example, in a relationship with positive polarity (+), a decrease in the from variable, would lead to a decrease in the to variable.  The second kind of relationship are those with negative polarity that are represented with a - symbol.  In relationships with negative polarity (-) a change in the from variable causes a change in the opposite direction in the to variable.  For example, in a relationship with negative polarity (-) an increase in the from variable, would lead to a decrease in the to variable.",
    "polarityReasoning": "This is the reason for why the polarity for this relationship was chosen",
    "relationship": "This is a relationship between two variables, from and to (from is the cause, to is the effect).  The relationship also contains a polarity which describes how a change in the from variable impacts the to variable",

    "relationships": "The list of relationships you think are appropriate to satisfy my request based on all of the information I have given you",

    "explanation": "Concisely explain your reasoning for each change you made to the old model to create the new model. Speak in plain English, refer to system archetypes, don't reference json specifically. Don't reiterate the request or any of these instructions.",

    "title": "A highly descriptive 7 word max title describing your explanation.",

    "quantExplanation": "This is markdown formatted text. Concisely explain your reasoning for each change you made to the old model to create the new model. Speak in plain English, refer to system archetypes, don't reference json specifically. Don't reiterate the request or any of these instructions.",
    "mentorModeQuantExplanation": "This is markdown formatted text where you try to teach the user about the model you built, explaining any flaws it may have, or problems that could exist with it. Never enumerate the feedback loops in the model!  This explanation should contain questions for the user customized to their specific context to help them think through their work.  This critique of the model you deliver here should be thorough and complete, leave no reasonable critique of the model unsaid.  Consider any missing concepts or other issues with model scope and construction technqiue.  Help the user to understand if their model is giving them the right behavior for the right reason. Speak in plain English, don't reference json specifically. Don't reiterate the request or any of these instructions.",

    "variables": "The list of variables you think are appropriate to satisfy my request based on all of the information I have given you",

    "equation": "The XMILE equation for this variable. CRITICAL: Every variable MUST have either this 'equation' field non-empty OR the 'arrayEquations' array non-empty (never both, never neither). For scalar (non-arrayed) variables: ALWAYS provide a non-empty equation here and leave arrayEquations empty. For arrayed variables where all elements use the SAME formula: provide the equation here and leave arrayEquations empty. For arrayed variables where elements have DIFFERENT formulas: leave this field EMPTY (empty string) and use arrayEquations instead. This equation can be a number, or an algebraic expression of other variables. Make sure that whenever you include a variable name with spaces that you replace those spaces with underscores. If the type for this variable is a stock, then the equation is its initial value, do not use INTEG for the equation of a stock, only its initial value. NEVER use IF THEN ELSE or conditional functions inside of equations. If you want to check for division by zero use the operator //. If this variable is a table function, lookup function or graphical function, the equation should be an algebraic expression containing only the inputs to the function! If a variable is making use of a graphical function only the name of the variable with the graphical function should appear in the equation.",

    "type": "There are three types of variables, stock, flow, and variable. A stock is an accumulation of its flows, it is an integral.  A stock can only change because of its flows. A flow is the derivative of a stock.  A plain variable is used for algebraic expressions.",
    "uniflow": "This should be true if this flow should never go negative (i.e., it represents a one-directional process that can only add to or subtract from a stock in one direction). When true, the flow will be constrained to be non-negative during simulation - if the equation would produce a negative value, it will be set to zero instead. Use false for flows that can legitimately be negative (bidirectional flows). This attribute only applies to variables with type flow. Common examples of uniflow=true: births, deaths, purchases, production. Common examples of uniflow=false: net migration, balance adjustments, corrections.",
    "name": "The name of a variable. CRITICAL MODULE NAMING RULE: For variables in modules, use ONLY the immediate owning module name as a prefix (ModuleName.variableName), NEVER use the full module hierarchy path. Examples: CORRECT: 'Sales.revenue' (even if Sales is nested in Company), WRONG: 'Company.Sales.revenue'. Variable names are ONLY qualified by their direct parent module, never by grandparent or higher-level modules.",
    "crossLevelGhostOf": "The module qualified name of the variable that this variable is representing from another module. Use only the immediate module name, not the full hierarchy path.",
    "inflows": "Only used on variables that are of type stock.  It is an array of variable names representing flows that add to this stock. CRITICAL: A flow can NEVER appear in both inflows and outflows of the same stock - each flow must be EITHER an inflow OR an outflow, never both.",
    "outflows": "Only used on variables that are of type stock.  It is an array of variable names representing flows that subtract from this stock. CRITICAL: A flow can NEVER appear in both inflows and outflows of the same stock - each flow must be EITHER an inflow OR an outflow, never both.",
    "documentation": "Documentation for the variable including the reason why it was chosen, what it represents, and a simple explanation why it is calculated this way",
    "units": "The units of measure for this variable",
    "gfEquation": "Only used on variables which contain a table function, lookup function, or graphical function. This is an array of point objects with x and y values.",
    "gfPoint": "This object represents a single value pair used in a table function, lookup function, or graphical function.",
    "gfPointX": "This is the \"x\" value in the x,y value pair, or graphical function point. This is the value used for the lookup.",
    "gfPointY": "This is the \"y\" value in the x,y value pair, or graphical function point. This is the value returned by the lookup.",

    "simSpecs": "This object describes settings for the model and how it runs.",
    "startTime": "The time at which this model starts calculating.  It is measured in the units of \"timeUnits\".",
    "stopTime": "The time at which this model stops calculating.  It is measured in the units of \"timeUnits\".",
    "dt": "The time step for the model, how often is it calculated.  The most common dt is 0.25. It is measured in the units of \"timeUnits\".",
    "timeUnits": "The unit of time for this model.  This should match with the equations that you generate.",
    "integrationMethod": "The method used to solve this model.  Euler (Default), RK4, is an optional method for systems with oscillations.",
    
    "loopIdentifier": "The globally unique identifer for this feedback loop.  You will take this value from the feedback loop identifier given to you.",
    "loopName": "A short, but unique name, for the process this feedback loop represents.  This name must be distinct for each loop you give a name to. This name should not refer directly to the polarity of the loop.  Don't use the words: growth, decline, stablizing, dampening, balancing, reinforcing, positive or negative in the name.",
    "loopDescription": "A description of what the process this feedback loop represents.  This description should discusses the purpose of this feedback loop. It should not be longer then 3 paragraphs",
    "loopsDescription": "A list of feedback loops with names and descriptions for the end-user.",
    "loopsNarrative": "A markdown formatted string containing an essay consisting of multiple paragraphs (unless instructed to do otherwise) that stitches together the feedback loops and their loopDescriptions into a narrative that describes the origins of behavior in the model. This essay should note each time period where there is a change in loop dominance.",

    "variableName": "The name of the variable being documented",
    "variableDocumentation": "Clear, comprehensive documentation for this variable describing what it represents, its role within the model, and how it relates to other elements. Should be 2-4 sentences that are informative without being overly verbose.",
    "documentedVariables": "A list of variables with their generated documentation",
    "documentationSummary": "A markdown formatted summary that provides an overview of the documentation generated, highlights key variables in the model, and is helpful for understanding the structure of the model.",

    "dimensionType": "The type of this dimension: either 'numeric' or 'labels'. For numeric dimensions, the element names are automatically generated as strings based on indices (e.g., '1', '2', '3'). For label dimensions, element names are explicitly defined by the user with meaningful names.",
    "dimensionName": "The XMILE name for an array dimension. Must be singular (never pluralized), containing only alphanumeric characters (letters and numbers), no punctuation or special symbols allowed.",
    "dimensionSize": "The total count of elements in this array dimension. Must be a positive integer. For numeric dimensions, this determines how many auto-generated numeric element names to create. For label dimensions, this should match the length of the elements array.",
    "dimensionElements": "An array of names for each element within this dimension. Each element name must contain only alphanumeric characters (letters and numbers), with no punctuation or special symbols. For numeric dimensions, this will be auto-generated as string numbers (e.g., ['1', '2', '3']). For label dimensions, provide meaningful names that describe each element (e.g., ['North', 'South', 'East', 'West']).",
    "dimension": "A definition of an XMILE array dimension that defines a set of indices over which variables can be arrayed. Every dimension must specify: type ('numeric' or 'label'), name (singular, alphanumeric), size (positive integer), and elements (array of element names). For numeric dimensions, elements are auto-generated numeric strings. For label dimensions, elements are user-defined meaningful names. Variables can be subscripted by one or more dimensions to create multi-dimensional arrays.",
    "arrayDimensions": "The complete list of all array dimension definitions used anywhere in this model. Each dimension must be fully defined here in the simulation specs before it can be referenced by variables in their 'dimensions' field. All dimensions must have all four required fields: type, name, size, and elements.",
    "variableDimensions": "An ordered list of dimension names that define the subscript structure for this arrayed variable. The order matters: each element in the forElements arrays must correspond positionally to the dimensions listed here (first element matches first dimension, second element matches second dimension, etc.). If empty or omitted, this is a scalar (non-arrayed) variable.",
    "arrayElementEquation": "Specifies the equation for a specific subset of array elements in an arrayed variable. The 'equation' field contains the XMILE equation, and the 'forElements' field specifies which array elements this equation applies to (ordered to match the variable's dimensions list).",
    "arrayEquationForElements": "An array of element names that identifies which specific array element(s) use this equation. Each element name corresponds positionally to the dimensions in the variable's 'dimensions' field (first element name matches first dimension, second matches second, etc.). For single-dimension arrays, this has one element name. For multi-dimensional arrays, this has multiple element names in the same order as the dimensions. Example: ['North','Q1'] or ['South','Q2'].",
    "variableArrayEquation": "CRITICAL: Used for arrayed variables when elements need different equations OR for arrayed stocks to specify initial values. Every variable MUST have either this array non-empty OR the 'equation' field non-empty - never both non-empty, never both empty. For arrayed variables: if elements have DIFFERENT formulas, you MUST populate this array with equation objects and leave 'equation' empty (empty string). This is a list of equation objects, where each object specifies an equation and the array elements it applies to (via the forElements field). You MUST provide equations that cover EVERY valid combination of array elements across all dimensions. For arrayed STOCKS, you MUST use this field to provide initial values for each stock element.",

    "moduleName": "The name of a module. Must follow variable naming rules: contains only alphanumeric characters and underscores, no spaces or special characters. Should never be module-qualified (do not include parent module names with dots). This is a simple identifier for the module itself.",
    "parentModule": "The name of the module that contains this module. If this module is at the top level (not nested within another module), this should be an empty string. If nested, this should be the simple name (not module-qualified) of the parent module.",
    "modules": "A list of module definitions that exist within this model. Each module represents a logical grouping or subsystem within the model hierarchy. Modules can contain variables and can be nested within other modules to create hierarchical model structures.",

    "subType": "The sub-type of this stock, flow, or variable. Stock sub-types (also set additionalProperties): 'queue' (a waiting line that holds items until they can be processed), 'oven' (a batch processor where items are held for a fixed cook time then released together), 'conveyor' (a pipeline delay where items travel a fixed transit time before exiting). Flow sub-types — automatically managed flows you name but do NOT write equations for: 'discreteOutflow' (output from a conveyor or oven), 'conveyorLeakage' (leakage from a conveyor — set additionalProperties to configure leakage behavior), 'queueOutflow' (output from a queue), 'queueOverflow' (overflow when a queue is full). Variable sub-types: 'delayVariable' (a plain variable whose equation contains a DELAY or SMTH builtin function — set this whenever the variable equation uses DELAY1, DELAY3, DELAY N, SMTH1, SMTH3, or any other DELAY/SMTH variant). Omit this field for all other stocks, flows, and variables.",

    "additionalProperties": "Sub-type-specific configuration for queue, oven, conveyor, conveyorLeakage, and any regular flow that uses spreadFlow. Include this object when subType is 'queue', 'oven', 'conveyor', or 'conveyorLeakage', or when the variable is a regular flow that sets spreadFlow. Omit entirely for all other variable types.",

    "processTime": "CONVEYOR/OVEN: Equation string for the transit time (conveyor) or cook time (oven) — how long items spend inside. Required for conveyor and oven sub-types.",
    "capacity": "CONVEYOR/OVEN: Equation string for the maximum number of items the element can hold. Leave empty for unlimited capacity.",
    "inflowLimit": "CONVEYOR/OVEN: Equation string for the maximum inflow rate per time step. Leave empty for no inflow limit.",
    "fillTime": "OVEN only: Equation string for the time required to fill the element before it begins processing. Leave empty to use the default.",
    "cleanTime": "OVEN only: Equation string for the clean-up time after the element empties before it can accept new items. Leave empty if no clean time is needed.",
    "leakFraction": "CONVEYOR LEAKAGE: Equation string for the leak fraction. When exponential (default), this is a rate in units of 1/time_unit (e.g. 0.1 means 10% per time unit). When not exponential, this is a dimensionless fraction of contents that leaks per time step. Leave empty for no leakage.",
    "exponential": "CONVEYOR LEAKAGE: If true (STRONG default — almost always use exponential), leakage is exponential (a constant fraction of remaining contents leaks each step, leak fraction in 1/time_unit). If false, leakage is linear (a fixed absolute amount, leak fraction is dimensionless). Only set false when the user explicitly requests linear leakage.",
    "leakZoneStart": "CONVEYOR LEAKAGE: Equation string for the starting position (as a percentage 0–100) along the conveyor where leakage begins. Leave empty to apply leakage across the entire length.",
    "leakZoneEnd": "CONVEYOR LEAKAGE: Equation string for the ending position (as a percentage 0–100) along the conveyor where leakage ends. Leave empty to apply leakage across the entire length.",
    "leakIntegers": "CONVEYOR LEAKAGE: If true, leakage amounts are rounded to whole integers.",
    "sample": "CONVEYOR/OVEN: Equation string — re-samples the transit or cook time when this expression evaluates to non-zero.",
    "arrest": "CONVEYOR/OVEN: Equation string — halts movement through the conveyor or oven when this expression evaluates to non-zero.",
    "spreadFlow": "Controls how inflows are distributed when they enter a CONVEYOR. 'none' (default): all inflow enters at the front. 'even': spread evenly across all positions. 'destination': spread proportional to existing content volume at each position. 'distribution': spread according to a user-defined distribution table (requires distribEq). 'source': spread based on the source's material profile.",
    "distribEq": "Required when spreadFlow is 'distribution': Equation string specifying the distribution table. Leave empty when spreadFlow is not 'distribution'.",
    "ignorePrevZones": "CONVEYOR LEAKAGE: If true, each leak zone operates independently without accounting for losses from earlier zones in the same conveyor.",
    "forceLeakFraction": "CONVEYOR LEAKAGE: If true, the same leak fraction is applied regardless of how long items have been in transit.",
    "fifoEnabled": "QUEUE only: If true, the queue dispatches items in FIFO (first-in, first-out) order. If false (default), items are dispatched in LIFO (last-in, first-out) order.",
    "oneAtATime": "CONVEYOR/OVEN only: If true, the stock accepts only one batch of items per time step. REQUIRES a Queue to be upstream.",
    "splitBatches": "CONVEYOR/OVEN only: If true, incoming batches may be split when entering the stock (partial batches are allowed). REQUIRES a Queue to be upstream.",
    "discrete": "QUEUE only: If true, the queue operates in discrete mode (integer item quantities only). If false (default), the queue operates continuously.",
    "roundRobin": "QUEUE only: If true, the queue uses round-robin selection when dispatching items to competing outflows.",
    "queueOutflowPriority": "QUEUE only: Equation string setting the dispatch priority for the queue outflow. Leave empty to use the default priority.",
    "purgeEq": "QUEUE only: Equation string specifying a maximum age (in time units) — items older than this value are automatically removed from the queue.",
    "overflow": "QUEUE only: If true, an automatic queue overflow flow is created to handle items that cannot enter because the queue is full."
  };

  generateSeldonResponseSchema(includeFeedbackInformationRequired) {
      let responseDescription = "The text containing the response. This text can only contain simple HTML formatted text.  Use only the HTML tags <h4>, <h5>, <h6>, <ol>, <ul>, <li>, <a>, <b>, <i>, <br>, <p> and <span>. Do not use markdown, LaTeX or any other kind of formatting.";

      const shape = {};

      if (includeFeedbackInformationRequired) {
        responseDescription += " If feedbackInformationRequired is true and no feedback information was passed, this response should be only one sentence long explaining why feedback loop information is necessary to properly answer the question";
      }

      shape.response = z.string().describe(responseDescription);

      if (includeFeedbackInformationRequired) {
        shape.feedbackInformationRequired = z.boolean().describe("A boolean indicating whether feedback loop information (loops that matter) is required to answer the question. Set to true for any question involving feedback loops, answering why or how things work in the model, or anything which requires knowledge of what is happening within the model's dynamics. Feedback information is essential for understanding model behavior and causality");
      }

      return z.object(shape);
  }

  generateLTMNarrativeResponseSchema(removeDescription = false) {
      // Conditionally adds a description to a Zod schema object.
      // If removeDescription is true, it returns the schema without the description.
      const withDescription = (schema, description) => {
          return removeDescription ? schema : schema.describe(description);
      };

      const FeedbackLoop = z.object({
        identifier: withDescription(z.string(), LLMWrapper.SCHEMA_STRINGS.loopIdentifier),
        name: withDescription(z.string(), LLMWrapper.SCHEMA_STRINGS.loopName),
        description: withDescription(z.string(), LLMWrapper.SCHEMA_STRINGS.loopDescription)
      });

      const FeedbackLoopList = withDescription(z.array(FeedbackLoop), LLMWrapper.SCHEMA_STRINGS.loopsDescription);

      const LTMToolResponse = z.object({
        feedbackLoops: FeedbackLoopList,
        narrativeMarkdown: withDescription(z.string(), LLMWrapper.SCHEMA_STRINGS.loopsNarrative)
      });

      return LTMToolResponse;
  }

  generateDocumentationResponseSchema(includeRelationships, includePolarity, removeDescription = false) {
      // Conditionally adds a description to a Zod schema object.
      // If removeDescription is true, it returns the schema without the description.
      const withDescription = (schema, description) => {
          return removeDescription ? schema : schema.describe(description);
      };

      const DocumentedVariable = z.object({
        name: withDescription(z.string(), LLMWrapper.SCHEMA_STRINGS.variableName),
        documentation: withDescription(z.string(), LLMWrapper.SCHEMA_STRINGS.variableDocumentation)
      });

      const DocumentedVariableList = withDescription(z.array(DocumentedVariable), LLMWrapper.SCHEMA_STRINGS.documentedVariables);

      const responseObject = {
        variables: DocumentedVariableList,
        summary: withDescription(z.string(), LLMWrapper.SCHEMA_STRINGS.documentationSummary)
      };

      // Optionally include relationships with reasoning
      if (includeRelationships) {
        const PolarityEnum = withDescription(z.enum(["+", "-"]), LLMWrapper.SCHEMA_STRINGS.polarity);

        const relationshipFields = {
          from: withDescription(z.string(), LLMWrapper.SCHEMA_STRINGS.from),
          to: withDescription(z.string(), LLMWrapper.SCHEMA_STRINGS.to),
          reasoning: withDescription(z.string(), LLMWrapper.SCHEMA_STRINGS.reasoning)
        };

        // Add polarity fields if requested
        if (includePolarity) {
          relationshipFields.polarity = PolarityEnum;
          relationshipFields.polarityReasoning = withDescription(z.string(), LLMWrapper.SCHEMA_STRINGS.polarityReasoning);
        }

        const DocumentedRelationship = z.object(relationshipFields);

        const DocumentedRelationshipList = withDescription(
          z.array(DocumentedRelationship),
          "A list of relationships with reasoning explaining why each connection exists in the model"
        );

        responseObject.relationships = DocumentedRelationshipList;
      }

      const DocumentationResponse = z.object(responseObject);

      return DocumentationResponse;
  }

  generateQualitativeSDJSONResponseSchema(removeDescription = false) {
      // Conditionally adds a description to a Zod schema object.
      // If removeDescription is true, it returns the schema without the description.
      const withDescription = (schema, description) => {
          return removeDescription ? schema : schema.describe(description);
      };

      const PolarityEnum = withDescription(z.enum(["+", "-"]), LLMWrapper.SCHEMA_STRINGS.polarity);

      const Relationship = withDescription(z.object({
          from: withDescription(z.string(), LLMWrapper.SCHEMA_STRINGS.from),
          to: withDescription(z.string(), LLMWrapper.SCHEMA_STRINGS.to),
          polarity: PolarityEnum,
          reasoning: withDescription(z.string(), LLMWrapper.SCHEMA_STRINGS.reasoning),
          polarityReasoning: withDescription(z.string(), LLMWrapper.SCHEMA_STRINGS.polarityReasoning)
      }), LLMWrapper.SCHEMA_STRINGS.relationship);

      const Relationships = z.object({
          explanation: withDescription(z.string(), LLMWrapper.SCHEMA_STRINGS.explanation),
          title: withDescription(z.string(), LLMWrapper.SCHEMA_STRINGS.title),
          relationships: withDescription(z.array(Relationship), LLMWrapper.SCHEMA_STRINGS.relationships)
      });

      return Relationships;
  }

  generateQuantitativeSDJSONResponseSchema(mentorMode, supportsArrays, supportsSubTypes) {
      const TypeEnum = z.enum(["stock", "flow", "variable"]).describe(LLMWrapper.SCHEMA_STRINGS.type);
      const PolarityEnum = z.enum(["+", "-"]).describe(LLMWrapper.SCHEMA_STRINGS.polarity);
      const Dimension = LLMWrapper.dimensionSchema();
      const GraphicalFunction = LLMWrapper.graphicalFunctionSchema().describe(LLMWrapper.SCHEMA_STRINGS.gfEquation);
      const Relationship = z.object(LLMWrapper.relationshipSchemaBase()).describe(LLMWrapper.SCHEMA_STRINGS.relationship);
      const Relationships = z.array(Relationship).describe(LLMWrapper.SCHEMA_STRINGS.relationships);
      const ArrayElementEquation = LLMWrapper.arrayElementEquationSchema().describe(LLMWrapper.SCHEMA_STRINGS.arrayElementEquation);

      const variableObj = {
        name: z.string().describe(LLMWrapper.SCHEMA_STRINGS.name),
        equation: z.string().describe(LLMWrapper.SCHEMA_STRINGS.equation),
        inflows: z.array(z.string()).describe(LLMWrapper.SCHEMA_STRINGS.inflows),
        outflows: z.array(z.string()).describe(LLMWrapper.SCHEMA_STRINGS.outflows),
        graphicalFunction: GraphicalFunction,
        type: TypeEnum,
        uniflow: z.boolean().describe(LLMWrapper.SCHEMA_STRINGS.uniflow),
        crossLevelGhostOf: z.string().describe(LLMWrapper.SCHEMA_STRINGS.crossLevelGhostOf),
        documentation: z.string().describe(LLMWrapper.SCHEMA_STRINGS.documentation),
        units: z.string().describe(LLMWrapper.SCHEMA_STRINGS.units)
      };

      if (supportsArrays) {
        variableObj.dimensions = z.array(z.string()).describe(LLMWrapper.SCHEMA_STRINGS.variableDimensions);
        variableObj.arrayEquations = z.array(ArrayElementEquation).describe(LLMWrapper.SCHEMA_STRINGS.variableArrayEquation);
      }

      if (supportsSubTypes) {
        variableObj.subType = LLMWrapper.subTypeSchema().optional();
        variableObj.additionalProperties = LLMWrapper.additionalPropertiesSchema().describe(LLMWrapper.SCHEMA_STRINGS.additionalProperties).optional();
      }

      const Variable = z.object(variableObj);
      const Variables = z.array(Variable).describe(LLMWrapper.SCHEMA_STRINGS.variables);

      const simSpecsObj = LLMWrapper.simSpecsSchemaBase();
      if (!supportsArrays) delete simSpecsObj.arrayDimensions;
      const SimSpecs = z.object(simSpecsObj).describe(LLMWrapper.SCHEMA_STRINGS.simSpecs);

      const Module = LLMWrapper.moduleSchema();

      const Model = z.object({
        variables: Variables,
        relationships: Relationships,
        explanation: z.string().describe(mentorMode ? LLMWrapper.SCHEMA_STRINGS.mentorModeQuantExplanation: LLMWrapper.SCHEMA_STRINGS.quantExplanation),
        title: z.string().describe(LLMWrapper.SCHEMA_STRINGS.title),
        specs: SimSpecs,
        modules: z.array(Module).describe(LLMWrapper.SCHEMA_STRINGS.modules)
      });

      return Model;
  }

    static DEFAULT_TEMPERATURE = undefined; //by default keep temperature undefined

  /**
   * Gets the LLM parameters based on model capabilities
   * @param {number} defaultTemperature - The default temperature to use (default: LLMWrapper.DEFAULT_TEMPERATURE)
   * @returns {{underlyingModel: string, systemRole: string, temperature: number|undefined, reasoningEffort: string|undefined}}
   */
  getLLMParameters(defaultTemperature = LLMWrapper.DEFAULT_TEMPERATURE) {
    let underlyingModel = this.model.name;
    let reasoningEffort = undefined;

    // Parse o3 models with reasoning effort
    if (underlyingModel.startsWith('o3-mini ')) {
      const parts = underlyingModel.split(' ');
      underlyingModel = 'o3-mini';
      reasoningEffort = parts[1].trim();
    } else if (underlyingModel.startsWith('o3 ')) {
      const parts = underlyingModel.split(' ');
      underlyingModel = 'o3';
      reasoningEffort = parts[1].trim();
    } else if (underlyingModel.startsWith('gpt-5.1 ')) {
      const parts = underlyingModel.split(' ');
      underlyingModel = 'gpt-5.1';
      reasoningEffort = parts[1].trim();
    } else if (underlyingModel.startsWith('gpt-5.2 ')) {
      const parts = underlyingModel.split(' ');
      underlyingModel = 'gpt-5.2';
      reasoningEffort = parts[1].trim();
    } else if (underlyingModel.includes('gemini') && underlyingModel.includes(' ')) {
      // Parse gemini models with thinking levels (e.g., 'gemini-3-flash-preview medium')
      const parts = underlyingModel.split(' ');
      underlyingModel = parts[0];
      reasoningEffort = parts[1].trim();
    } else if (underlyingModel.includes('claude') && underlyingModel.includes(' ')) {
      // Parse Claude models with an effort level (e.g. 'claude-opus-4-8 max').
      // Effort is low | medium | high | xhigh | max and is applied via
      // output_config.effort on the Anthropic path; the bare id is sent to the API.
      const parts = underlyingModel.split(' ');
      underlyingModel = parts[0];
      reasoningEffort = parts[1].trim();
    }

    // Determine system role
    let systemRole = this.model.hasSystemMode ? this.model.systemModeUser : 'user';

    // Determine temperature
    let temperature = this.#temperatureOverride ?? defaultTemperature;
    if (!this.model.hasSystemMode) {
      temperature = 1;
    }
    if (!this.model.hasTemperature) {
      temperature = undefined;
    }
    // Gemini-3 models really don't want you messing with temperature!
    if (underlyingModel.startsWith('gemini-3')) {
      temperature = undefined;
    }

    return { underlyingModel, systemRole, temperature, reasoningEffort };
  }

  #collapseUserMessages(messages) {
    const userContents = [];
    let nonUserCount = 0;
    let nonUserCountAtLastUser = -1;

    messages.forEach((message) => {
      if (message.role === "user") {
        if (message.content) {
          userContents.push(message.content);
        }
        nonUserCountAtLastUser = nonUserCount;
      } else {
        nonUserCount += 1;
      }
    });

    if (userContents.length === 0) {
      return messages;
    }

    const collapsedMessages = messages.filter((message) => message.role !== "user");
    const insertIndex = Math.min(
      nonUserCountAtLastUser < 0 ? collapsedMessages.length : nonUserCountAtLastUser,
      collapsedMessages.length
    );

    collapsedMessages.splice(insertIndex, 0, {
      role: "user",
      content: userContents.join("\n\n")
    });

    return collapsedMessages;
  }

  // When a model lacks native structured output support, inject an explicit JSON
  // instruction into the system message so the model knows what to return.
  // This keeps all local-vs-remote awareness inside LLMWrapper.
  #injectJsonFallback(messages, zodSchema) {
    if (!zodSchema?.shape) return messages;
    const fields = Object.entries(zodSchema.shape).map(([k, v]) => {
      const t = v._def?.typeName?.replace('Zod', '').toLowerCase() ?? 'value';
      return `"${k}": <${t}>`;
    });
    const instruction = `\n\nCRITICAL: Your entire response MUST be a single valid JSON object with no text before or after it. No markdown, no explanation, no code fences. Only output this exact structure:\n{${fields.join(', ')}}`;
    const result = messages.map(m => ({ ...m }));
    const sys = result.find(m => m.role === 'system' || m.role === 'developer');
    if (sys) {
      sys.content = (sys.content ?? '') + instruction;
    } else {
      result.unshift({ role: 'system', content: instruction.trim() });
    }
    return result;
  }

  async createChatCompletion(messages, model, zodSchema = null, temperature = null, reasoningEffort = null) {
    let normalizedMessages = messages;
    // DeepSeek (and other strict upstreams) reject non-alternating turns, so
    // consecutive user messages must be collapsed into one. OpenRouter is included
    // here because slugs like `deepseek/deepseek-v4-pro` route as OPEN_ROUTER, not
    // DEEPSEEK — so without this they'd bypass the collapse the local path gets.
    if (this.model.kind === ModelType.LLAMA || this.model.kind === ModelType.DEEPSEEK || this.model.kind === ModelType.OPEN_ROUTER) {
      normalizedMessages = this.#collapseUserMessages(messages);
    }

    // For models that don't support structured output, fall back to prompt-level
    // JSON enforcement and drop the schema so the API doesn't reject it.
    let effectiveSchema = zodSchema;
    if (zodSchema && !this.model.hasStructuredOutput) {
      normalizedMessages = this.#injectJsonFallback(normalizedMessages, zodSchema);
      effectiveSchema = null;
    }

    if (this.model.kind === ModelType.GEMINI) {
      return await this.#createGeminiChatCompletion(normalizedMessages, model, effectiveSchema, temperature, reasoningEffort);
    } else if (this.model.kind === ModelType.CLAUDE) {
      return await this.#createClaudeChatCompletion(normalizedMessages, model, effectiveSchema, temperature, reasoningEffort);
    } else if (this.model.kind === ModelType.OPEN_ROUTER) {
      return await this.#createOpenRouterChatCompletion(normalizedMessages, model, effectiveSchema, temperature);
    } else if (this.model.kind === ModelType.DEEPSEEK) {
      return await this.#createDeepSeekChatCompletion(normalizedMessages, model, effectiveSchema, temperature);
    }

    return await this.#createOpenAIChatCompletion(normalizedMessages, model, effectiveSchema, temperature, reasoningEffort);
  }

  async #createOpenRouterChatCompletion(messages, model, zodSchema = null, temperature = null) {
    const chatRequest = {
      model,
      messages: messages.map((m) => ({
        role: m.role === 'developer' ? 'system' : m.role,
        content: m.content ?? ''
      }))
    };

    if (zodSchema) {
      chatRequest.responseFormat = {
        type: 'json_schema',
        jsonSchema: {
          name: 'sdai_schema',
          schema: zodSchema.toJSONSchema(),
          strict: true
        }
      };
    } else if (this.#jsonObjectMode) {
      chatRequest.responseFormat = { type: 'json_object' };
    }

    if (temperature !== null && temperature !== undefined) {
      chatRequest.temperature = temperature;
    }
    if (this.#topP !== null && this.#topP !== undefined) {
      chatRequest.topP = this.#topP;
    }
    if (this.#seed !== null && this.#seed !== undefined) {
      chatRequest.seed = this.#seed;
    }
    if (this.#maxTokens !== null && this.#maxTokens !== undefined) {
      chatRequest.maxCompletionTokens = this.#maxTokens;
    }

    // Alibaba (Qwen's upstream via OpenRouter) downgrades json_schema to
    // json_object and then rejects with "'messages' must contain the word
    // 'json'" if no message mentions it. Append a minimal note when needed.
    if (chatRequest.responseFormat) {
      const mentionsJson = chatRequest.messages.some(m =>
        typeof m.content === 'string' && /json/i.test(m.content)
      );
      if (!mentionsJson) {
        const sys = chatRequest.messages.find(m => m.role === 'system');
        const note = '\n\nRespond with valid JSON.';
        if (sys) {
          sys.content = (sys.content ?? '') + note;
        } else {
          chatRequest.messages.unshift({ role: 'system', content: note.trim() });
        }
      }
    }

    const completion = await this.#openRouterAPI.chat.send({ chatRequest });
    this.#tokenReporter.report({ provider: Provider.OPENROUTER, model, usage: completion.usage, clientKey: this.#clientKey });

    const message = completion.choices?.[0]?.message ?? {};
    const content = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.filter(b => b && (b.type === 'text' || typeof b.text === 'string')).map(b => b.text ?? '').join('')
        : '';
    return { ...message, content };
  }

  async #createDeepSeekChatCompletion(messages, model, zodSchema = null, temperature = null) {
    const chatRequest = {
      model,
      messages: messages.map((m) => ({
        role: m.role === 'developer' ? 'system' : m.role,
        content: m.content ?? ''
      }))
    };

    // DeepSeek's API supports only the json_object response_format (no
    // json_schema), so structured outputs degrade to json_object. JSON mode also
    // requires the word 'json' to appear in some message, otherwise the model
    // can emit blank whitespace until it hits the token limit — so append a
    // minimal note when nothing mentions it (same guard as the OpenRouter path).
    if (zodSchema || this.#jsonObjectMode) {
      chatRequest.responseFormat = { type: 'json_object' };
      const mentionsJson = chatRequest.messages.some(m =>
        typeof m.content === 'string' && /json/i.test(m.content)
      );
      if (!mentionsJson) {
        const sys = chatRequest.messages.find(m => m.role === 'system');
        const note = '\n\nRespond with valid JSON.';
        if (sys) {
          sys.content = (sys.content ?? '') + note;
        } else {
          chatRequest.messages.unshift({ role: 'system', content: note.trim() });
        }
      }
    }

    if (temperature !== null && temperature !== undefined) {
      chatRequest.temperature = temperature;
    }
    if (this.#topP !== null && this.#topP !== undefined) {
      chatRequest.topP = this.#topP;
    }
    if (this.#maxTokens !== null && this.#maxTokens !== undefined) {
      chatRequest.maxTokens = this.#maxTokens;
    }

    // Thinking mode is on by default at the API; only send a thinking config when
    // the caller explicitly asked for one. DeepSeek accepts no seed/top_k — those
    // stay on the local LM Studio (LLAMA) path.
    if (this.#thinking !== null && this.#thinking !== undefined) {
      chatRequest.thinking = {
        type: (this.#thinking === true || this.#thinking?.type === 'enabled') ? 'enabled' : 'disabled'
      };
    }

    const completion = await this.#deepseekAPI.chat.completions.create(chatRequest);
    this.#tokenReporter.report({ provider: Provider.DEEPSEEK, model, usage: completion.usage, clientKey: this.#clientKey });

    const message = completion.choices?.[0]?.message ?? {};
    let content = typeof message.content === 'string' ? message.content : '';
    // Reasoning models emit chain-of-thought in reasoning_content and may leave
    // content null (e.g. json_object mode with thinking on); try to extract a
    // valid JSON block from the reasoning text so callers get parseable content.
    if (!content && message.reasoning_content) {
      const extracted = extractJsonFromContent(message.reasoning_content);
      content = extracted ? JSON.stringify(extracted) : message.reasoning_content;
    }
    return { ...message, content };
  }

  async #createOpenAIChatCompletion(messages, model, zodSchema = null, temperature = null, reasoningEffort = null) {
    const completionParams = {
      messages,
      model
    };

    if (zodSchema) {
      completionParams.response_format = zodResponseFormat(zodSchema, "sdai_schema");
    } else if (this.#jsonObjectMode) {
      completionParams.response_format = { type: "json_object" };
    }

    if (temperature !== null && temperature !== undefined) {
      completionParams.temperature = temperature;
    }

    if (reasoningEffort) {
      completionParams.reasoning_effort = reasoningEffort;
    }

    if (this.#topP !== null && this.#topP !== undefined) {
      completionParams.top_p = this.#topP;
    }

    if ((this.model.kind === ModelType.LLAMA || this.model.kind === ModelType.DEEPSEEK)
      && this.#topK !== null && this.#topK !== undefined) {
      completionParams.top_k = this.#topK;
    }

    if ((this.model.kind === ModelType.LLAMA || this.model.kind === ModelType.DEEPSEEK)
      && this.#seed !== null && this.#seed !== undefined) {
      completionParams.seed = this.#seed;
    }

    if (this.#maxTokens !== null && this.#maxTokens !== undefined) {
      completionParams.max_tokens = this.#maxTokens;
    }

    if ((this.model.kind === ModelType.LLAMA || this.model.kind === ModelType.DEEPSEEK)
      && this.#thinking !== null && this.#thinking !== undefined) {
      completionParams.thinking = this.#thinking;
    }

    const completion = await this.#openAIAPI.chat.completions.create(completionParams);
    this.#tokenReporter.report({ provider: Provider.OPENAI, model, usage: completion.usage, clientKey: this.#clientKey });
    const message = completion.choices[0].message;
    // Reasoning models (e.g. GLM-5) emit chain-of-thought in reasoning_content and
    // leave content null. Try to extract a valid JSON block from the reasoning text
    // so callers receive parseable content rather than raw prose.
    const reasoningText = message.reasoning_content ?? message.reasoning;
    if (!message.content && reasoningText) {
      const extracted = extractJsonFromContent(reasoningText);
      return { ...message, content: extracted ? JSON.stringify(extracted) : reasoningText };
    }
    return message;
  }

  async #createGeminiChatCompletion(messages, model, zodSchema = null, temperature = null, reasoningEffort = null) {
    const geminiMessages = this.convertMessagesToGeminiFormat(messages);

    // Set up request config
    const requestConfig = {
      model: model,
      contents: geminiMessages.contents
    };

    // Set up generation config
    const config = {};

    // Add system instruction if present (as array of strings in config)
    if (geminiMessages.systemInstruction) {
      config.systemInstruction = [geminiMessages.systemInstruction];
    }

    if (temperature !== null && temperature !== undefined) {
      config.temperature = temperature;
    }

    // Set thinking level if present (reasoningEffort is the thinking level for Gemini)
    if (reasoningEffort) {
      config.thinkingConfig = { thinkingLevel: reasoningEffort };
    }

    if (zodSchema) {
      config.responseMimeType = "application/json";
      config.responseJsonSchema = zodSchema.toJSONSchema();
    }

    if (Object.keys(config).length > 0) {
      requestConfig.config = config;
    }

    const result = await this.#geminiAPI.models.generateContent(requestConfig);
    this.#tokenReporter.report({ provider: Provider.GOOGLE, model, usage: result.usageMetadata, clientKey: this.#clientKey });

    // Convert Gemini response to OpenAI format
    return {
      content: result.text
    };
  }

  async #createClaudeChatCompletion(messages, model, zodSchema = null, temperature = null, reasoningEffort = null) {
    const claudeMessages = this.convertMessagesToClaudeFormat(messages);

    const completionParams = {
      model,
      messages: claudeMessages.messages,
      // The Messages API requires max_tokens, so we can't omit it — but we don't
      // want an arbitrary cap that truncates a large generation mid-JSON. Honor a
      // caller-supplied limit, otherwise use the model's own maximum output.
      max_tokens: this.#maxTokens ?? await this.#resolveAnthropicMaxTokens(model)
    };

    if (claudeMessages.system) {
      completionParams.system = claudeMessages.system;
    }

    // An effort level runs with adaptive thinking, which only permits
    // temperature=1 (and Opus 4.7/4.8 reject sampling params outright). So when an
    // effort level is requested, omit temperature and let the model default it.
    if (!reasoningEffort && temperature !== null && temperature !== undefined) {
      completionParams.temperature = temperature;
    }

    // Claude models think by default: honor an explicit caller-provided thinking
    // config, otherwise enable adaptive thinking on every model that supports it
    // (Opus 4.6+/Sonnet 4.6/Fable/Mythos). At the default effort the model almost
    // always thinks, which improves generation quality. Models without adaptive
    // support are left alone so we don't trigger a 400.
    if (this.#thinking) {
      completionParams.thinking = this.#thinking;
    } else if (this.model.supportsAdaptiveThinking) {
      completionParams.thinking = { type: 'adaptive' };
    }

    // output_config carries two independent settings, so build it incrementally:
    //   - format: structured outputs via the current `output_config.format`
    //     parameter (GA on Opus 4.8 / Sonnet 4.6 / Haiku 4.5). This supersedes the
    //     deprecated top-level `output_format` + `structured-outputs-2025-11-13`
    //     beta header; no beta header is required. The model returns a JSON string
    //     in a text block.
    //   - effort: thinking depth + token spend (low | medium | high | xhigh | max),
    //     parsed from the model name (e.g. 'claude-opus-4-8 max'). Default when
    //     omitted is `high`. `max` is Opus-tier only; Haiku 4.5 / Sonnet 4.5 reject
    //     effort entirely, so we only send it when the caller asked for a level.
    const outputConfig = {};
    if (zodSchema) {
      outputConfig.format = {
        type: "json_schema",
        schema: LLMWrapper.#makeClaudeSchemaStrict(zodSchema.toJSONSchema())
      };
    }
    if (reasoningEffort) {
      outputConfig.effort = reasoningEffort;
    }
    if (Object.keys(outputConfig).length > 0) {
      completionParams.output_config = outputConfig;
    }

    // Stream and reassemble: max_tokens above ~16K risks the SDK HTTP timeout on
    // a non-streaming call, so we always stream here and collect the final message
    // (same shape as messages.create).
    const completion = await this.#anthropicAPI.messages.stream(completionParams).finalMessage();
    this.#tokenReporter.report({ provider: Provider.ANTHROPIC, model, usage: completion.usage, clientKey: this.#clientKey });

    // A truncated response produces invalid JSON downstream; surface the real
    // cause instead of letting it fail later as an opaque "Bad JSON" parse error.
    if (completion.stop_reason === 'max_tokens') {
      throw new Error(`Anthropic response truncated at max_tokens (${completionParams.max_tokens}) for model ${model}; increase max_tokens`);
    }

    // Don't assume content[0] is the text block. When thinking is enabled the
    // content array carries one or more `thinking` blocks BEFORE the text block,
    // so content[0].text is undefined. Scan for the first text block instead —
    // this holds for both the structured-output and plain paths.
    const textBlock = (completion.content ?? []).find(
      (block) => block?.type === 'text' && typeof block.text === 'string'
    );

    let content = textBlock ? textBlock.text : null;

    // Structured outputs went out with every optional field forced to
    // required-but-nullable (see #makeClaudeSchemaStrict), so the model emits
    // explicit nulls for absent optionals. Strip them so downstream sees the same
    // shape the other providers produce. Guarded: if it isn't valid JSON (it always
    // should be under a schema), leave the raw text untouched.
    if (content && zodSchema) {
      try {
        content = JSON.stringify(LLMWrapper.#stripNullValues(JSON.parse(content)));
      } catch {
        // Not parseable JSON — return as-is rather than dropping the response.
      }
    }

    return { content };
  }

  // Resolve a model's maximum output tokens from the Models API (cached per
  // model). Falls back to 32000 if the lookup fails (e.g. the model isn't listed
  // by the endpoint), which still comfortably exceeds typical generations.
  async #resolveAnthropicMaxTokens(model) {
    if (this.#anthropicMaxTokensByModel.has(model)) {
      return this.#anthropicMaxTokensByModel.get(model);
    }
    let maxTokens = 32000;
    try {
      const info = await this.#anthropicAPI.models.retrieve(model);
      if (Number.isInteger(info?.max_tokens) && info.max_tokens > 0) {
        maxTokens = info.max_tokens;
      }
    } catch {
      // Models endpoint unavailable or model not listed — keep the safe default.
    }
    this.#anthropicMaxTokensByModel.set(model, maxTokens);
    return maxTokens;
  }

  convertMessagesToGeminiFormat(messages) {
    const geminiMessages = {
      systemInstruction: null,
      contents: []
    };

    let systemMessageCount = 0;
    for (const message of messages) {
      if (!message.content)
        continue; //don't send empty messages, throws a 500 inside of gemini
      if (message.role === "system") {
        systemMessageCount++;
        if (systemMessageCount === 1) {
          // First system message becomes system instruction
          geminiMessages.systemInstruction = message.content;
        } else {
          // Second and subsequent system messages become user prompts
          geminiMessages.contents.push({
            role: "user",
            parts: [{ text: message.content }]
          });
        }
      } else if (message.role === "user") {
        geminiMessages.contents.push({
          role: "user",
          parts: [{ text: message.content }]
        });
      } else if (message.role === "assistant") {
        geminiMessages.contents.push({
          role: "model",
          parts: [{ text: message.content }]
        });
      }
    }

    return geminiMessages;
  }

  convertMessagesToClaudeFormat(messages) {
    const claudeMessages = {
      system: null,
      messages: []
    };

    let systemMessageCount = 0;
    for (const message of messages) {
      if (message.role === "system") {
        systemMessageCount++;
        if (systemMessageCount === 1) {
          // First system message becomes system instruction
          claudeMessages.system = message.content;
        } else {
          // Second and subsequent system messages become user prompts
          claudeMessages.messages.push({
            role: "user",
            content: message.content
          });
        }
      } else if (message.role === "user" || message.role === "assistant") {
        claudeMessages.messages.push({
          role: message.role,
          content: message.content
        });
      }
    }

    return claudeMessages;
  }

  // Anthropic compiles a structured-output schema into a grammar and caps the
  // number of OPTIONAL parameters (keys absent from an object's `required`) at 24
  // across the whole schema; our quantitative schema has 26 and 400s. Rewrite the
  // schema so every property is `required`, expressing former optionality as
  // "required but may be null" (anyOf with a null branch). This drops the optional
  // count to zero — the same transform OpenAI strict mode applies, which is why the
  // OpenAI/Gemini paths never hit this. Only used on the Claude path. Mutates and
  // returns the (freshly generated, unshared) schema.
  static #makeClaudeSchemaStrict(schema) {
    const makeNullable = (node) => {
      if (node && typeof node === 'object'
          && Array.isArray(node.anyOf) && node.anyOf.some((s) => s && s.type === 'null')) {
        return node; // already nullable
      }
      if (node && typeof node === 'object') {
        const { description, ...rest } = node;
        const wrapped = { anyOf: [rest, { type: 'null' }] };
        if (description !== undefined) wrapped.description = description;
        return wrapped;
      }
      return { anyOf: [node, { type: 'null' }] };
    };

    const walk = (node) => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== 'object') return;

      if (node.type === 'object' && node.properties) {
        const originallyRequired = new Set(node.required ?? []);
        for (const key of Object.keys(node.properties)) {
          walk(node.properties[key]); // strictify children first
          if (!originallyRequired.has(key)) {
            node.properties[key] = makeNullable(node.properties[key]);
          }
        }
        node.required = Object.keys(node.properties);
      }

      if (node.items) walk(node.items);
      if (node.anyOf) walk(node.anyOf);
      if (node.oneOf) walk(node.oneOf);
      if (node.allOf) walk(node.allOf);
      if (node.$defs) Object.values(node.$defs).forEach(walk);
      if (node.definitions) Object.values(node.definitions).forEach(walk);
    };

    walk(schema);
    return schema;
  }

  // Counterpart to #makeClaudeSchemaStrict: the model returns explicit nulls for the
  // fields we forced to be required-but-nullable. Recursively drop null-valued keys
  // so callers get the same shape the other providers produce (optional fields
  // simply absent). Safe because none of our schemas declare a field nullable, so
  // every null here is an omitted optional.
  static #stripNullValues(value) {
    if (Array.isArray(value)) {
      return value.map((item) => LLMWrapper.#stripNullValues(item));
    }
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, val] of Object.entries(value)) {
        if (val === null) continue;
        out[key] = LLMWrapper.#stripNullValues(val);
      }
      return out;
    }
    return value;
  }

  static moduleSchema() {
    return z.object({
      name: z.string().describe(LLMWrapper.SCHEMA_STRINGS.moduleName),
      parentModule: z.string().describe(LLMWrapper.SCHEMA_STRINGS.parentModule)
    });
  }

  static relationshipSchemaBase() {
    return {
      from: z.string().describe(LLMWrapper.SCHEMA_STRINGS.from),
      to: z.string().describe(LLMWrapper.SCHEMA_STRINGS.to),
      polarity: z.enum(["+", "-"]).describe(LLMWrapper.SCHEMA_STRINGS.polarity),
      reasoning: z.string().describe(LLMWrapper.SCHEMA_STRINGS.reasoning),
      polarityReasoning: z.string().describe(LLMWrapper.SCHEMA_STRINGS.polarityReasoning)
    };
  }

  static dimensionSchema() {
    return z.object({
      type: z.enum(["labels", "numeric"]).describe(LLMWrapper.SCHEMA_STRINGS.dimensionType),
      name: z.string().describe(LLMWrapper.SCHEMA_STRINGS.dimensionName),
      size: z.number().describe(LLMWrapper.SCHEMA_STRINGS.dimensionSize),
      elements: z.array(z.string()).describe(LLMWrapper.SCHEMA_STRINGS.dimensionElements)
    }).describe(LLMWrapper.SCHEMA_STRINGS.dimension);
  }

  static simSpecsSchemaBase() {
    return {
      startTime: z.number().describe(LLMWrapper.SCHEMA_STRINGS.startTime),
      stopTime: z.number().describe(LLMWrapper.SCHEMA_STRINGS.stopTime),
      dt: z.number().describe(LLMWrapper.SCHEMA_STRINGS.dt),
      timeUnits: z.string().describe(LLMWrapper.SCHEMA_STRINGS.timeUnits),
      integrationMethod: z.enum(["Euler", "RK4"]).describe(LLMWrapper.SCHEMA_STRINGS.integrationMethod),
      arrayDimensions: z.array(LLMWrapper.dimensionSchema()).describe(LLMWrapper.SCHEMA_STRINGS.arrayDimensions)
    };
  }

  static graphicalFunctionSchema() {
    return z.object({
      points: z.array(z.object({
        x: z.number().describe(LLMWrapper.SCHEMA_STRINGS.gfPointX),
        y: z.number().describe(LLMWrapper.SCHEMA_STRINGS.gfPointY)
      }).describe(LLMWrapper.SCHEMA_STRINGS.gfPoint))
    });
  }

  static arrayElementEquationSchema() {
    return z.object({
      equation: z.string().describe(LLMWrapper.SCHEMA_STRINGS.equation),
      forElements: z.array(z.string()).describe(LLMWrapper.SCHEMA_STRINGS.arrayEquationForElements)
    });
  }

  static subTypeSchema() {
    return z.enum([
      "queue", "oven", "conveyor",
      "discreteOutflow", "conveyorLeakage", "queueOutflow", "queueOverflow",
      "delayVariable"
    ]).describe(LLMWrapper.SCHEMA_STRINGS.subType);
  }

  static additionalPropertiesSchema() {
    return z.object({
      // CONVEYOR + OVEN
      processTime: z.string().describe(LLMWrapper.SCHEMA_STRINGS.processTime).optional(),
      capacity: z.string().describe(LLMWrapper.SCHEMA_STRINGS.capacity).optional(),
      inflowLimit: z.string().describe(LLMWrapper.SCHEMA_STRINGS.inflowLimit).optional(),
      fillTime: z.string().describe(LLMWrapper.SCHEMA_STRINGS.fillTime).optional(),
      cleanTime: z.string().describe(LLMWrapper.SCHEMA_STRINGS.cleanTime).optional(),
      leakFraction: z.string().describe(LLMWrapper.SCHEMA_STRINGS.leakFraction).optional(),
      exponential: z.boolean().describe(LLMWrapper.SCHEMA_STRINGS.exponential).optional(),
      leakZoneStart: z.string().describe(LLMWrapper.SCHEMA_STRINGS.leakZoneStart).optional(),
      leakZoneEnd: z.string().describe(LLMWrapper.SCHEMA_STRINGS.leakZoneEnd).optional(),
      leakIntegers: z.boolean().describe(LLMWrapper.SCHEMA_STRINGS.leakIntegers).optional(),
      sample: z.string().describe(LLMWrapper.SCHEMA_STRINGS.sample).optional(),
      arrest: z.string().describe(LLMWrapper.SCHEMA_STRINGS.arrest).optional(),
      // CONVEYOR-only
      spreadFlow: z.enum(["none", "even", "destination", "distribution", "source"]).describe(LLMWrapper.SCHEMA_STRINGS.spreadFlow).optional(),
      distribEq: z.string().describe(LLMWrapper.SCHEMA_STRINGS.distribEq).optional(),
      ignorePrevZones: z.boolean().describe(LLMWrapper.SCHEMA_STRINGS.ignorePrevZones).optional(),
      forceLeakFraction: z.boolean().describe(LLMWrapper.SCHEMA_STRINGS.forceLeakFraction).optional(),
      // QUEUE
      fifoEnabled: z.boolean().describe(LLMWrapper.SCHEMA_STRINGS.fifoEnabled).optional(),
      oneAtATime: z.boolean().describe(LLMWrapper.SCHEMA_STRINGS.oneAtATime).optional(),
      splitBatches: z.boolean().describe(LLMWrapper.SCHEMA_STRINGS.splitBatches).optional(),
      discrete: z.boolean().describe(LLMWrapper.SCHEMA_STRINGS.discrete).optional(),
      roundRobin: z.boolean().describe(LLMWrapper.SCHEMA_STRINGS.roundRobin).optional(),
      queueOutflowPriority: z.string().describe(LLMWrapper.SCHEMA_STRINGS.queueOutflowPriority).optional(),
      purgeEq: z.string().describe(LLMWrapper.SCHEMA_STRINGS.purgeEq).optional(),
      overflow: z.boolean().describe(LLMWrapper.SCHEMA_STRINGS.overflow).optional()
    });
  }

  static variableSchemaBase() {
    return {
      name: z.string().describe(LLMWrapper.SCHEMA_STRINGS.name),
      type: z.enum(["stock", "flow", "variable"]).describe(LLMWrapper.SCHEMA_STRINGS.type),
      equation: z.string().describe(LLMWrapper.SCHEMA_STRINGS.equation).optional(),
      documentation: z.string().describe(LLMWrapper.SCHEMA_STRINGS.documentation).optional(),
      units: z.string().describe(LLMWrapper.SCHEMA_STRINGS.units).optional(),
      uniflow: z.boolean().describe(LLMWrapper.SCHEMA_STRINGS.uniflow).optional(),
      inflows: z.array(z.string()).describe(LLMWrapper.SCHEMA_STRINGS.inflows).optional(),
      outflows: z.array(z.string()).describe(LLMWrapper.SCHEMA_STRINGS.outflows).optional(),
      dimensions: z.array(z.string()).describe(LLMWrapper.SCHEMA_STRINGS.variableDimensions).optional(),
      arrayEquations: z.array(LLMWrapper.arrayElementEquationSchema()).describe(LLMWrapper.SCHEMA_STRINGS.variableArrayEquation).optional(),
      crossLevelGhostOf: z.string().describe(LLMWrapper.SCHEMA_STRINGS.crossLevelGhostOf).optional(),
      graphicalFunction: LLMWrapper.graphicalFunctionSchema().describe(LLMWrapper.SCHEMA_STRINGS.gfEquation).optional(),
      subType: LLMWrapper.subTypeSchema().optional(),
      additionalProperties: LLMWrapper.additionalPropertiesSchema().describe(LLMWrapper.SCHEMA_STRINGS.additionalProperties).optional()
    };
  }

  static additionalParameters(defaultModel) {
    return [{
            name: "clientId",
            type: "string",
            required: false,
            uiElement: "hidden",
            description: "A unique identifier for the end user of this session"
        },{
            name: "openAIKey",
            type: "string",
            required: false,
            uiElement: "password",
            saveForUser: "global",
            label: "Open AI API Key",
            description: "Leave blank for the default, or your Open AI key - skprojectXXXXX"
        },{
            name: "googleKey",
            type: "string",
            required: false,
            uiElement: "password",
            saveForUser: "global",
            label: "Google API Key",
            description: "Leave blank for the default, or your Google API key - XXXXXX"
        },{
            name: "anthropicKey",
            type: "string",
            required: false,
            uiElement: "password",
            saveForUser: "global",
            label: "Anthropic API Key",
            description: "Leave blank for the default, or your Anthropic API key - sk-ant-XXXXXX"
        },{
            name: "openRouterKey",
            type: "string",
            required: false,
            uiElement: "password",
            saveForUser: "global",
            label: "OpenRouter API Key",
            description: "Leave blank for the default, or your OpenRouter API key - sk-or-XXXXXX"
        },{
            name: "deepseekKey",
            type: "string",
            required: false,
            uiElement: "password",
            saveForUser: "global",
            label: "DeepSeek API Key",
            description: "Leave blank for the default, or your DeepSeek API key - sk-XXXXXX (base URL from DEEPSEEK_BASE_URL, default https://api.deepseek.com)"
        },{
            name: "underlyingModel",
            type: "string",
            defaultValue: defaultModel,
            required: false,
            options: LLMWrapper.MODELS,
            uiElement: "combobox",
            saveForUser: "local",
            label: "LLM Model",
            description: "The LLM model that you want to use to process your queries."
        }];
    }
};
