import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { ZodToStructuredOutputConverter } from "./ZodToStructuredOutputConverter.js";

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

  model = new ModelCapabilities(LLMWrapper.DEFAULT_MODEL);

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
      {label: "GPT-4o", value: 'gpt-4o'},
      {label: "GPT-4o-mini", value: 'gpt-4o-mini'},
      {label: "GPT-4.1", value: 'gpt-4.1'},
      {label: "GPT-4.1-mini", value: 'gpt-4.1-mini'},
      {label: "GPT-4.1-nano", value: 'gpt-4.1-nano'},
      {label: "Gemini 3-pro-preview", value: 'gemini-3-pro-preview'},
      {label: "Gemini 3-flash-preview", value: 'gemini-3-flash-preview'},
      {label: "Gemini 2.5-flash", value: 'gemini-2.5-flash'},
      {label: "Gemini 2.5-flash-preview-09-2025", value: 'gemini-2.5-flash-preview-09-2025'},
      {label: "Gemini 2.5-flash-lite", value: 'gemini-2.5-flash-lite'},
      {label: "Gemini 2.5-pro", value: 'gemini-2.5-pro'},
      {label: "Gemini 2.0", value: 'gemini-2.0-flash'},
      {label: "Gemini 2.0-Lite", value: 'gemini-2.0-flash-lite'},
      {label: "Gemini 1.5", value: 'gemini-1.5-flash'},
      {label: "Claude Haiku 4.5", value: 'claude-haiku-4-5-20251001'},
      {label: "Claude Opus 4.5", value: 'claude-sonnet-4-5-20250929'},
      {label: "Claude Sonnet 4.5", value: 'claude-opus-4-5-20251101'},
      {label: "Claude Opus 4.1", value: 'claude-opus-4-1-20250805'},
      {label: "Claude Sonnet 4", value: 'claude-sonnet-4-20250514'},
      {label: "o1", value: 'o1'},
      {label: "o3-mini low", value: 'o3-mini low'},
      {label: "o3-mini medium", value: 'o3-mini medium'},
      {label: "o3-mini high", value: 'o3-mini high'},
      {label: "o3", value: 'o3'},
      {label: "o4-mini", value: 'o4-mini'}
  ];

  static DEFAULT_MODEL = 'gemini-2.5-flash-preview-09-2025';

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

    "equation": "The XMILE equation for this variable. CRITICAL: Every variable MUST have either this 'equation' field OR the 'arrayEquations' field populated - never both, never neither (exception: cross-level ghost variables have neither). For scalar (non-arrayed) variables: ALWAYS use this field. For arrayed variables where all elements use the SAME formula: use this field. For arrayed variables where elements have DIFFERENT formulas OR for arrayed stocks: use 'arrayEquations' instead and leave this empty. This equation can be a number, or an algebraic expression of other variables. Make sure that whenever you include a variable name with spaces that you replace those spaces with underscores. If the type for this variable is a stock, then the equation is its initial value, do not use INTEG for the equation of a stock, only its initial value. NEVER use IF THEN ELSE or conditional functions inside of equations. If you want to check for division by zero use the operator //. If this variable is a table function, lookup function or graphical function, the equation should be an algebraic expression containing only the inputs to the function! If a variable is making use of a graphical function only the name of the variable with the graphical function should appear in the equation.",

    "type": "There are three types of variables, stock, flow, and variable. A stock is an accumulation of its flows, it is an integral.  A stock can only change because of its flows. A flow is the derivative of a stock.  A plain variable is used for algebraic expressions.",
    "name": "The name of a variable",
    "crossLevelGhostOf": "The module qualified name of the variable that this variable is representing from another module",
    "inflows": "Only used on variables that are of type stock.  It is an array of variable names representing flows that add to this stock.",
    "outflows": "Only used on variables that are of type stock.  It is an array of variable names representing flows that subtract from this stock.",
    "documentation": "Documentation for the variable including the reason why it was chosen, what it represents, and a simple explanation why it is calculated this way",
    "units": "The units of measure for this variable",
    "gfEquation": "Only used on variables which contain a table function, lookup function, or graphical function.",

    "gf": "This object represents a table function, lookup function or graphical function.  It is a list of value pairs or points.  The value computed by the equation is looked up in this list of points using the \"x\" value, and the \"y\" value is returned.",
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
    "arrayEquationForElements": "An ordered list of array element names that identifies which specific array element(s) use this equation. Each element name in this list corresponds positionally to the dimensions in the variable's 'dimensions' field (first element name matches first dimension, second matches second, etc.). For single-dimension arrays, this list has one element name. For multi-dimensional arrays, this list has multiple element names in the same order as the dimensions.",
    "variableArrayEquation": "CRITICAL: Used for arrayed variables when elements need different equations OR for arrayed stocks to specify initial values. Every variable MUST have either this field OR the 'equation' field populated - never both, never neither (exception: cross-level ghost variables have neither). For arrayed variables: if elements have DIFFERENT formulas OR if it's an arrayed stock, you MUST use this field and leave 'equation' empty. This is a list of equation objects, where each object specifies an equation and the array elements it applies to (via the forElements field). You MUST provide equations that cover EVERY valid combination of array elements across all dimensions. For arrayed STOCKS, you MUST use this field to provide initial values for each stock element. If all array elements of a non-stock variable use the identical equation, you may use the 'equation' field instead and omit this field entirely."
  };

  generateSeldonResponseSchema() {
      return z.object({
        response: z.string().describe("The text containing the response. This text can only contain simple HTML formatted text.  Use only the HTML tags <h4>, <h5>, <h6>, <ol>, <ul>, <li>, <a>, <b>, <i>, <br>, <p> and <span>. Do not use markdown, LaTeX or any other kind of formatting")
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

  generateQuantitativeSDJSONResponseSchema(mentorMode) {
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

      const GF = z.object({
        points: z.array(GFPoint)
      }).describe(LLMWrapper.SCHEMA_STRINGS.gf);

      const Relationship = z.object({
          from: z.string().describe(LLMWrapper.SCHEMA_STRINGS.from),
          to: z.string().describe(LLMWrapper.SCHEMA_STRINGS.to),
          polarity: PolarityEnum,
          reasoning: z.string().describe(LLMWrapper.SCHEMA_STRINGS.reasoning),
          polarityReasoning: z.string().describe(LLMWrapper.SCHEMA_STRINGS.polarityReasoning)
      }).describe(LLMWrapper.SCHEMA_STRINGS.relationship);

      const Relationships = z.array(Relationship).describe(LLMWrapper.SCHEMA_STRINGS.relationships);

      const ArrayElementEquation = z.object({
        equation: z.string().describe(LLMWrapper.SCHEMA_STRINGS.equation),
        forElements: z.array(z.string()).describe(LLMWrapper.SCHEMA_STRINGS.arrayEquationForElements)
      }).describe(LLMWrapper.SCHEMA_STRINGS.arrayElementEquation);

      const Variable = z.object({
        name: z.string().describe(LLMWrapper.SCHEMA_STRINGS.name),
        equation: z.string().optional().describe(LLMWrapper.SCHEMA_STRINGS.equation),
        inflows: z.array(z.string()).optional().describe(LLMWrapper.SCHEMA_STRINGS.inflows),
        outflows: z.array(z.string()).optional().describe(LLMWrapper.SCHEMA_STRINGS.outflows),
        graphicalFunction: GF.optional().describe(LLMWrapper.SCHEMA_STRINGS.gfEquation),
        type: TypeEnum,
        crossLevelGhostOf: z.string().optional().describe(LLMWrapper.SCHEMA_STRINGS.crossLevelGhostOf),
        documentation: z.string().describe(LLMWrapper.SCHEMA_STRINGS.documentation),
        units: z.string().describe(LLMWrapper.SCHEMA_STRINGS.units),
        dimensions: z.array(z.string()).optional().describe(LLMWrapper.SCHEMA_STRINGS.variableDimensions),
        arrayEquations: z.array(ArrayElementEquation).optional().describe(LLMWrapper.SCHEMA_STRINGS.variableArrayEquation)
      });

      const Variables = z.array(Variable).describe(LLMWrapper.SCHEMA_STRINGS.variables);

      const SimSpecs = z.object({
        startTime: z.number().describe(LLMWrapper.SCHEMA_STRINGS.startTime),
        stopTime: z.number().describe(LLMWrapper.SCHEMA_STRINGS.stopTime),
        dt: z.number().describe(LLMWrapper.SCHEMA_STRINGS.dt),
        timeUnits: z.string().describe(LLMWrapper.SCHEMA_STRINGS.timeUnits),
        arrayDimensions: z.array(Dimension).describe(LLMWrapper.SCHEMA_STRINGS.arrayDimensions)
      }).describe(LLMWrapper.SCHEMA_STRINGS.simSpecs);

      const Model = z.object({
        variables: Variables,
        relationships: Relationships,
        explanation: z.string().describe(mentorMode ? LLMWrapper.SCHEMA_STRINGS.mentorModeQuantExplanation: LLMWrapper.SCHEMA_STRINGS.quantExplanation),
        title: z.string().describe(LLMWrapper.SCHEMA_STRINGS.title),
        specs: SimSpecs
      });

      return Model;
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

  async createChatCompletion(messages, model, zodSchema = null, temperature = null, reasoningEffort = null) {
    if (this.model.kind === ModelType.GEMINI) {
      return await this.#createGeminiChatCompletion(messages, model, zodSchema, temperature);
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
    return completion.choices[0].message;
  }

  async #createGeminiChatCompletion(messages, model, zodSchema = null, temperature = null) {
    const geminiMessages = this.convertMessagesToGeminiFormat(messages);

    // Set up request config
    const requestConfig = {
      model: model,
      contents: geminiMessages.contents
    };

    // Add system instruction if present
    if (geminiMessages.systemInstruction) {
      requestConfig.systemInstruction = { parts: [{ text: geminiMessages.systemInstruction }] };
    }

    // Set up generation config
    const config = {};
    if (temperature !== null && temperature !== undefined) {
      config.temperature = temperature;
    }

    if (zodSchema) {
      this.#zodToStructuredOutputConverter.setOptions({
        emitOptionalProperties: false
      });

      config.responseMimeType = "application/json";
      config.responseSchema = this.#zodToStructuredOutputConverter.convert(zodSchema);
    }

    if (Object.keys(config).length > 0) {
      requestConfig.config = config;
    }

    const result = await this.#geminiAPI.models.generateContent(requestConfig);

    // Convert Gemini response to OpenAI format
    return {
      content: result.text
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

    // With output_format, the response is always in content[0].text as JSON
    if (zodSchema) {
      return {
        content: completion.content[0].text
      };
    }

    return {
      content: completion.content[0].text
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

  static additionalParameters() {
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
            defaultValue: LLMWrapper.DEFAULT_MODEL,
            required: false,
            options: LLMWrapper.MODELS,
            uiElement: "combobox",
            saveForUser: "local",
            label: "LLM Model",
            description: "The LLM model that you want to use to process your queries."
        }];
    }
};