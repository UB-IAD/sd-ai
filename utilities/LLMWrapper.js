import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { ZodToStructuredOutputConverter } from "./ZodToStructuredOutputConverter.js";
import logger from "./logger.js";
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load pricing data from JSON file
const pricingData = JSON.parse(readFileSync(join(__dirname, 'model-pricing.json'), 'utf-8'));

export const ModelType = Object.freeze({
  GEMINI:   Symbol("Gemini"),
  OPEN_AI:  Symbol("OpenAI"),
  LLAMA: Symbol("Llama"),
  DEEPSEEK: Symbol("Deepseek"),
  CLAUDE: Symbol("Claude")
});


export class ModelCapabilities {
  hasStructuredOutput= true;
  hasSystemMode = true;
  hasTemperature = true;
  systemModeUser = 'system';

  name = 'model';

  constructor(modelName) {
      this.name = modelName;

      this.hasStructuredOutput = modelName !== 'o1-mini';
      this.hasSystemMode = modelName !== 'o1-mini';
      this.hasTemperature = !modelName.startsWith('o') && !modelName.startsWith('gpt-5');
      if (modelName.includes('gemini') || modelName.includes('llama') || modelName.includes('claude')) {
          this.systemModeUser = 'system';
      } else {
          this.systemModeUser = 'developer';
      }
  }

  get kind() {
      if (this.name.includes('gemini')) {
          return ModelType.GEMINI;
      } else if (this.name.includes('llama')) {
          return ModelType.LLAMA;
      } else if (this.name.includes('deepseek')) {
          return ModelType.DEEPSEEK;
      } else if (this.name.includes('claude')) {
          return ModelType.CLAUDE;
      } else {
          return ModelType.OPEN_AI;
      }
  }
};

export class LLMWrapper {
  #openAIKey;
  #googleKey;
  #anthropicKey;
  #openAIAPI = null;
  #geminiAPI = null;
  #anthropicAPI = null;
  #zodToStructuredOutputConverter = new ZodToStructuredOutputConverter();

  model = new ModelCapabilities(LLMWrapper.BUILD_DEFAULT_MODEL);

  // Pricing per million tokens (input/output) in USD
  // Loaded dynamically from model-pricing.json
  static MODEL_PRICING = pricingData.pricing;

  constructor(parameters) {
    if (!parameters.openAIKey) {
        this.#openAIKey = process.env.OPENAI_API_KEY
    } else {
      this.#openAIKey = parameters.openAIKey;
    }

    if (!parameters.googleKey) {
        this.#googleKey = process.env.GOOGLE_API_KEY
    } else {
      this.#googleKey = parameters.googleKey;
    }

    if (!parameters.anthropicKey) {
        this.#anthropicKey = process.env.ANTHROPIC_API_KEY
    } else {
      this.#anthropicKey = parameters.anthropicKey;
    }

    if (parameters.underlyingModel)
      this.model = new ModelCapabilities(parameters.underlyingModel);

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
        case ModelType.DEEPSEEK:
        case ModelType.LLAMA:
            this.#openAIAPI = new OpenAI({
                apiKey: 'junk', // required but unused
                baseURL: 'http://localhost:11434/v1',
            });
            break;
    }
  }

  static MODELS = [
      {label: "GPT-5.2", value: 'gpt-5.2 medium'},
      {label: "GPT-5.1", value: 'gpt-5.1 medium'},
      {label: "GPT-5", value: 'gpt-5'},
      {label: "GPT-5-mini", value: 'gpt-5-mini'},
      {label: "GPT-5-nano", value: 'gpt-5-nano'},
      {label: "GPT-4.1", value: 'gpt-4.1'},
      {label: "GPT-4.1-mini", value: 'gpt-4.1-mini'},
      {label: "GPT-4.1-nano", value: 'gpt-4.1-nano'},
      {label: "GPT-4o", value: 'gpt-4o'},
      {label: "GPT-4o-mini", value: 'gpt-4o-mini'},
      {label: "Gemini 3.1-pro-preview", value: 'gemini-3.1-pro-preview'},
      {label: "Gemini 3-flash-preview medium", value: 'gemini-3-flash-preview medium'},
      {label: "Gemini 3-flash-preview low", value: 'gemini-3-flash-preview low'},
      {label: "Gemini 3-flash-preview minimal", value: 'gemini-3-flash-preview minimal'},
      {label: "Gemini 2.5-flash", value: 'gemini-2.5-flash'},
      {label: "Gemini 2.5-flash-lite", value: 'gemini-2.5-flash-lite'},
      {label: "Gemini 2.5-pro", value: 'gemini-2.5-pro'},
      {label: "Claude Opus 4.6", value: 'claude-opus-4-6'},
      {label: "Claude Sonnet 4.6", value: 'claude-sonnet-4-6'},
      {label: "Claude Haiku 4.5", value: 'claude-haiku-4-5'},
      {label: "Claude Opus 4.5", value: 'claude-sonnet-4-5'},
      {label: "Claude Sonnet 4.5", value: 'claude-opus-4-5'},
      {label: "Claude Opus 4.1", value: 'claude-opus-4-1-20250805'},
      {label: "Claude Sonnet 4", value: 'claude-sonnet-4-20250514'},
      {label: "o1", value: 'o1'},
      {label: "o3-mini low", value: 'o3-mini low'},
      {label: "o3-mini medium", value: 'o3-mini medium'},
      {label: "o3-mini high", value: 'o3-mini high'},
      {label: "o3", value: 'o3'},
      {label: "o4-mini", value: 'o4-mini'}
  ];

  static BUILD_DEFAULT_MODEL = 'gemini-3-flash-preview low'; //'claude-opus-4-6';
  static NON_BUILD_DEFAULT_MODEL = 'gemini-3-flash-preview low'; //'claude-opus-4-6';
  static EVAL_MODEL = 'gemini-2.5-flash';
  
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
    "arrayEquationForElements": "A comma-separated string of array element names that identifies which specific array element(s) use this equation. Each element name corresponds positionally to the dimensions in the variable's 'dimensions' field (first element name matches first dimension, second matches second, etc.). For single-dimension arrays, this has one element name. For multi-dimensional arrays, this has multiple element names separated by commas in the same order as the dimensions. Example: 'North,Q1' or 'South,Q2'.",
    "variableArrayEquation": "CRITICAL: Used for arrayed variables when elements need different equations OR for arrayed stocks to specify initial values. Every variable MUST have either this array non-empty OR the 'equation' field non-empty - never both non-empty, never both empty. For arrayed variables: if elements have DIFFERENT formulas, you MUST populate this array with equation objects and leave 'equation' empty (empty string). This is a list of equation objects, where each object specifies an equation and the array elements it applies to (via the forElements field). You MUST provide equations that cover EVERY valid combination of array elements across all dimensions. For arrayed STOCKS, you MUST use this field to provide initial values for each stock element.",

    "moduleName": "The name of a module. Must follow variable naming rules: contains only alphanumeric characters and underscores, no spaces or special characters. Should never be module-qualified (do not include parent module names with dots). This is a simple identifier for the module itself.",
    "parentModule": "The name of the module that contains this module. If this module is at the top level (not nested within another module), this should be an empty string. If nested, this should be the simple name (not module-qualified) of the parent module.",
    "modules": "A list of module definitions that exist within this model. Each module represents a logical grouping or subsystem within the model hierarchy. Modules can contain variables and can be nested within other modules to create hierarchical model structures."
  };

  generateSeldonResponseSchema() {
      return z.object({
        response: z.string().describe("The text containing the response. This text can only contain simple HTML formatted text.  Use only the HTML tags <h4>, <h5>, <h6>, <ol>, <ul>, <li>, <a>, <b>, <i>, <br>, <p> and <span>. Do not use markdown, LaTeX or any other kind of formatting. If feedbackInformationRequired is true and no feedback information was passed, this response should be only one sentence long explaining why feedback loop information is necessary to properly answer the question"),
        feedbackInformationRequired: z.boolean().describe("A boolean indicating whether feedback loop information (loops that matter) is required to answer the question. Set to true for any question involving feedback loops, answering why or how things work in the model, or anything which requires knowledge of what is happening within the model's dynamics. Feedback information is essential for understanding model behavior and causality")
      });
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

  generateQuantitativeSDJSONResponseSchema(mentorMode, supportsArrays) {
      const TypeEnum = z.enum(["stock", "flow", "variable"]).describe(LLMWrapper.SCHEMA_STRINGS.type);
      const PolarityEnum = z.enum(["+", "-"]).describe(LLMWrapper.SCHEMA_STRINGS.polarity);

      const Dimension = z.object({
        type: z.enum(["labels", "numeric"]).describe(LLMWrapper.SCHEMA_STRINGS.dimensionType),
        name: z.string().describe(LLMWrapper.SCHEMA_STRINGS.dimensionName),
        size: z.number().describe(LLMWrapper.SCHEMA_STRINGS.dimensionSize),
        elements: z.array(z.string()).describe(LLMWrapper.SCHEMA_STRINGS.dimensionElements)
      }).describe(LLMWrapper.SCHEMA_STRINGS.dimension);


      const GFPoint = z.object({
        x: z.number().describe(LLMWrapper.SCHEMA_STRINGS.gfPointX),
        y: z.number().describe(LLMWrapper.SCHEMA_STRINGS.gfPointY)
      }).describe(LLMWrapper.SCHEMA_STRINGS.gfPoint);

      const Relationship = z.object({
          from: z.string().describe(LLMWrapper.SCHEMA_STRINGS.from),
          to: z.string().describe(LLMWrapper.SCHEMA_STRINGS.to),
          polarity: PolarityEnum,
          reasoning: z.string().describe(LLMWrapper.SCHEMA_STRINGS.reasoning),
          polarityReasoning: z.string().describe(LLMWrapper.SCHEMA_STRINGS.polarityReasoning)
      }).describe(LLMWrapper.SCHEMA_STRINGS.relationship);

      const Relationships = z.array(Relationship).describe(LLMWrapper.SCHEMA_STRINGS.relationships);

      // Flattened: forElements is a comma-separated string instead of array of strings
      // This reduces nesting depth from 6 to 5 levels for array support
      const ArrayElementEquation = z.object({
        equation: z.string().describe(LLMWrapper.SCHEMA_STRINGS.equation),
        forElements: z.string().describe(LLMWrapper.SCHEMA_STRINGS.arrayEquationForElements)
      }).describe(LLMWrapper.SCHEMA_STRINGS.arrayElementEquation);

      const variableObj = {
        name: z.string().describe(LLMWrapper.SCHEMA_STRINGS.name),
        equation: z.string().describe(LLMWrapper.SCHEMA_STRINGS.equation),
        inflows: z.array(z.string()).describe(LLMWrapper.SCHEMA_STRINGS.inflows),
        outflows: z.array(z.string()).describe(LLMWrapper.SCHEMA_STRINGS.outflows),
        graphicalFunction: z.array(GFPoint).describe(LLMWrapper.SCHEMA_STRINGS.gfEquation),
        type: TypeEnum,
        crossLevelGhostOf: z.string().describe(LLMWrapper.SCHEMA_STRINGS.crossLevelGhostOf),
        documentation: z.string().describe(LLMWrapper.SCHEMA_STRINGS.documentation),
        units: z.string().describe(LLMWrapper.SCHEMA_STRINGS.units)
      };
      
      if (supportsArrays) {
        variableObj.dimensions = z.array(z.string()).describe(LLMWrapper.SCHEMA_STRINGS.variableDimensions);
        variableObj.arrayEquations = z.array(ArrayElementEquation).describe(LLMWrapper.SCHEMA_STRINGS.variableArrayEquation);
      }

      const Variable = z.object(variableObj);
      const Variables = z.array(Variable).describe(LLMWrapper.SCHEMA_STRINGS.variables);

      const simSpecsObj = {
        startTime: z.number().describe(LLMWrapper.SCHEMA_STRINGS.startTime),
        stopTime: z.number().describe(LLMWrapper.SCHEMA_STRINGS.stopTime),
        dt: z.number().describe(LLMWrapper.SCHEMA_STRINGS.dt),
        timeUnits: z.string().describe(LLMWrapper.SCHEMA_STRINGS.timeUnits)
      };

      if (supportsArrays) {
        simSpecsObj.arrayDimensions = z.array(Dimension).describe(LLMWrapper.SCHEMA_STRINGS.arrayDimensions);
      }
      
      const SimSpecs = z.object(simSpecsObj).describe(LLMWrapper.SCHEMA_STRINGS.simSpecs);

      const Module = z.object({
        name: z.string().describe(LLMWrapper.SCHEMA_STRINGS.moduleName),
        parentModule: z.string().describe(LLMWrapper.SCHEMA_STRINGS.parentModule)
      });

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

  /**
   * Calculates the cost in USD for a given model and token usage
   * @param {string} model - The model name
   * @param {number} inputTokens - Number of input tokens
   * @param {number} outputTokens - Number of output tokens
   * @returns {number} Cost in USD, or NaN if pricing is unavailable
   */
  #calculateCostEstimate(model, inputTokens, outputTokens) {
    // Get pricing for the model (strip reasoning effort suffixes if present)
    const baseModel = model.split(' ')[0];
    const pricing = LLMWrapper.MODEL_PRICING[baseModel];

    if (!pricing) {
      // Unknown model, return NaN to indicate pricing unavailable
      logger.debug(`[Cost Tracking] No pricing available for model: ${model}, returning NaN`);
      return NaN;
    }

    // Validate pricing data
    if (typeof pricing.input !== 'number' || typeof pricing.output !== 'number') {
      logger.warn(`[Cost Tracking] Invalid pricing data for model: ${model}, returning NaN`);
      return NaN;
    }

    // Calculate cost: (tokens / 1,000,000) * price_per_million
    const inputCost = (inputTokens / 1000000) * pricing.input;
    const outputCost = (outputTokens / 1000000) * pricing.output;
    const totalCost = inputCost + outputCost;

    logger.debug(`[Cost Tracking] Model: ${model}, Input: ${inputTokens} tokens ($${inputCost.toFixed(6)}), Output: ${outputTokens} tokens ($${outputCost.toFixed(6)}), Total: $${totalCost.toFixed(6)}`);

    return totalCost;
  }

  /**
   * Gets the LLM parameters based on model capabilities
   * @param {number} defaultTemperature - The default temperature to use (default: 0)
   * @returns {{underlyingModel: string, systemRole: string, temperature: number|undefined, reasoningEffort: string|undefined}}
   */
  getLLMParameters(defaultTemperature = 0) {
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
    }

    // Determine system role
    let systemRole = this.model.hasSystemMode ? this.model.systemModeUser : 'user';

    // Determine temperature
    let temperature = defaultTemperature;
    if (!this.model.hasSystemMode) {
      temperature = 1;
    }
    if (!this.model.hasTemperature) {
      temperature = undefined;
    }

    return { underlyingModel, systemRole, temperature, reasoningEffort };
  }

  /**
   * Creates a chat completion with cost tracking
   * @returns {Promise<{content: string, cost: number}>} Object with content and cost in USD
   */
  async createChatCompletion(messages, model, zodSchema = null, temperature = null, reasoningEffort = null) {
    if (this.model.kind === ModelType.GEMINI) {
      return await this.#createGeminiChatCompletion(messages, model, zodSchema, temperature, reasoningEffort);
    } else if (this.model.kind === ModelType.CLAUDE) {
      return await this.#createClaudeChatCompletion(messages, model, zodSchema, temperature);
    }

    return await this.#createOpenAIChatCompletion(messages, model, zodSchema, temperature, reasoningEffort);
  }

  async #createOpenAIChatCompletion(messages, model, zodSchema = null, temperature = null, reasoningEffort = null) {
    const completionParams = {
      messages,
      model
    };

    if (zodSchema) {
      completionParams.response_format = zodResponseFormat(zodSchema, "sdai_schema");
    }

    if (temperature !== null && temperature !== undefined) {
      completionParams.temperature = temperature;
    }

    if (reasoningEffort) {
      completionParams.reasoning_effort = reasoningEffort;
    }

    const completion = await this.#openAIAPI.chat.completions.create(completionParams);
    const message = completion.choices[0].message;

    // Calculate cost from usage data
    const usage = completion.usage || {};
    const inputTokens = usage.prompt_tokens || 0;
    const outputTokens = usage.completion_tokens || 0;
    const costEstimate = this.#calculateCostEstimate(model, inputTokens, outputTokens);

    // Return message content along with cost
    return {
      ...message,
      costEstimate
    };
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
      this.#zodToStructuredOutputConverter.setOptions({
        emitOptionalProperties: false
      });

      config.responseMimeType = "application/json";
      config.responseJsonSchema = this.#zodToStructuredOutputConverter.convert(zodSchema);
    }

    if (Object.keys(config).length > 0) {
      requestConfig.config = config;
    }

    const result = await this.#geminiAPI.models.generateContent(requestConfig);

    // Extract usage metadata from Gemini response
    const usageMetadata = result.usageMetadata || {};
    const inputTokens = usageMetadata.promptTokenCount || 0;
    const outputTokens = usageMetadata.candidatesTokenCount || 0;
    const costEstimate = this.#calculateCostEstimate(model, inputTokens, outputTokens);

    // Convert Gemini response to OpenAI format with cost
    return {
      content: result.text,
      costEstimate
    };
  }

  async #createClaudeChatCompletion(messages, model, zodSchema = null, temperature = null) {
    const claudeMessages = this.convertMessagesToClaudeFormat(messages);

    const completionParams = {
      model,
      messages: claudeMessages.messages,
      max_tokens: 8192
    };

    if (claudeMessages.system) {
      completionParams.system = claudeMessages.system;
    }

    if (temperature !== null && temperature !== undefined) {
      completionParams.temperature = temperature;
    }

    // Use structured outputs with output_format parameter
    if (zodSchema) {
      completionParams.output_format = {
        type: "json_schema",
        schema: this.#zodToStructuredOutputConverter.convert(zodSchema)
      };
    }

    // Set the beta header for structured outputs
    const headers = zodSchema ? {
      'anthropic-beta': 'structured-outputs-2025-11-13'
    } : undefined;

    const completion = await this.#anthropicAPI.messages.create(
      completionParams,
      { headers }
    );

    // Extract usage from Claude response
    const usage = completion.usage || {};
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const costEstimate = this.#calculateCostEstimate(model, inputTokens, outputTokens);

    // Return content with cost
    return {
      content: completion.content[0].text,
      costEstimate
    };
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

  static additionalParameters(defaultModel) {
    return [{
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