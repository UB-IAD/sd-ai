import projectUtils from '../../utilities/utils.js'
import { LLMWrapper } from '../../utilities/LLMWrapper.js'
import { marked } from 'marked';

class ResponseFormatError extends Error {
    constructor(message) {
        super(message);
        this.name = "ResponseFormatError";
    }
}

class QuantitativeEngineBrain {

    static BASE_SYSTEM_PROMPT_CORE =
`CRITICAL MODULAR MODEL REQUIREMENTS:

WHEN TO USE MODULES:
- DO NOT create modules unless the model already uses modules OR the user explicitly requests modular structure
- If the existing model has NO modules, build a NON-MODULAR model
- If the existing model HAS modules, maintain and extend the modular structure
- Only introduce modules when specifically asked by the user

WHEN USING MODULES - GHOST VARIABLE REQUIREMENTS:
When constructing modular models, you MUST create cross-level ghost variables for ALL inter-module references:
1. Create the source variable in its computation module
2. Create a cross-level ghost variable in EVERY consuming module that references the source variable
3. The ghost variable MUST have an identical local name as the source variable
4. Mark the ghost variable explicitly as: crossLevelGhostOf = <sourceVariable>
5. Ghost variables have NO equation - they reference their source variable only
6. ALL equations in the consuming module MUST reference the cross-level ghost variable, NOT the original source variable

FAILURE TO CREATE AND LINK GHOST VARIABLES WILL BREAK SIMULATION. This is non-negotiable.
REFERENCING THE ORIGINAL SOURCE VARIABLE DIRECTLY FROM A CONSUMING MODULE WILL BREAK SIMULATION. Always use the ghost.

CRITICAL ARRAY REQUIREMENTS:

WHEN TO USE ARRAYS:
- DO NOT create arrays or array dimensions unless the model already uses arrays OR the user explicitly requests arrayed variables
- If the existing model has NO arrays, build a NON-ARRAYED model with scalar variables only
- If the existing model HAS arrays, maintain and extend the array structure consistently
- Only introduce arrays when specifically asked by the user
- Arrays add significant complexity - use them ONLY when necessary

WHEN USING ARRAYS - DIMENSION AND EQUATION REQUIREMENTS:
When constructing models with arrayed variables, you MUST follow these rules:
1. ALL array dimensions MUST be defined in the specs.arrayDimensions list before being referenced
2. Each dimension MUST have a unique name (singular, alphanumeric only)
3. For label dimensions: specify element names; for numeric dimensions: specify size
4. Variables reference dimensions by name in their dimensions array (order matters)
5. Arrayed variables MUST have equations for ALL element combinations:
   - If all elements use the SAME formula: provide ONE equation in the 'equation' field
   - If elements differ: provide element-specific equations in the 'arrayEquations' array (NOT 'equation')
   - For arrayed STOCKS: you MUST provide initial values for each element using 'arrayEquations'
   - NEVER leave the 'equation' or 'arrayEquations' fields empty for any variable
6. Array element references in 'forElements' use individual dimension element names (e.g., ["North", "Q1"])
7. SUM function syntax - CRITICAL:
   - ALWAYS use asterisk (*) to represent the dimension being summed - NEVER use the dimension name
   - MANDATORY: Every SUM equation MUST contain at least one asterisk (*) - without it, the SUM is invalid
   - WRONG: SUM(Revenue[region]) or SUM(Sales[product])
   - CORRECT: SUM(Revenue[*]) to sum across all elements of a single dimension
   - CORRECT: SUM(Sales[product,*]) to sum across the second dimension of a 2D array
   - The asterisk (*) is a wildcard that means "sum over all elements of this dimension"

FAILURE TO PROPERLY DEFINE DIMENSIONS AND EQUATIONS WILL BREAK SIMULATION. This is non-negotiable.

CONSTANT HANDLING:
NEVER embed numerical constants directly in equations with other variables. ALWAYS create separate named variables for all constants.

MANDATORY PROCESS - Execute these steps in order:

STEP 1 - IDENTIFY VARIABLES:
Identify all entities with cause-and-effect relationships. Name variables using these rules:
- Maximum 5 words per name
- Minimize total variable count
- Use neutral terminology (no positive/negative connotations)
- Use ONLY letters and spaces (NO symbols, dashes, or punctuation)

STEP 2 - DEFINE CAUSAL RELATIONSHIPS:
Assign polarity to each causal relationship:
- Positive polarity (+): Variables move together (both increase OR both decrease)
  Example 1: Decrease in cause → decrease in effect = POSITIVE (+)
  Example 2: Increase in cause → increase in effect = POSITIVE (+)
- Negative polarity (-): Variables move opposite (anticorrelated)
  Example 1: Decrease in cause → increase in effect = NEGATIVE (-)
  Example 2: Increase in cause → decrease in effect = NEGATIVE (-)

STEP 3 - DETERMINE VARIABLE TYPES:
Classify each variable as one of three types:
- STOCK: Accumulations that change ONLY via their flows
- FLOW: Derivatives that change stocks (rate of change)
- VARIABLE: Auxiliary variables for algebraic expressions

STEP 4 - WRITE EQUATIONS:
Provide equations for every variable:
- Write all equations in XMILE format
- NEVER embed numbers directly in equations
- Every variable referenced in an equation MUST have its own equation, type, and appear in the relationships list
- CRITICAL EQUATION REQUIREMENT: Every variable MUST have EITHER 'equation' OR 'arrayEquations' populated (never both, never neither)
  * Exception: Cross-level ghost variables (with crossLevelGhostOf set) have NO equation
  * For SCALAR (non-arrayed) variables: ALWAYS provide 'equation'
  * For ARRAYED variables where all elements use the SAME formula: provide 'equation' only
  * For ARRAYED variables where elements have DIFFERENT formulas: provide 'arrayEquations' with entries for ALL elements (omit 'equation')
  * For arrayed STOCKS with numeric initialization: ALWAYS use 'arrayEquations' to specify initial values for each element individually (omit 'equation')
- In SUM functions: ALWAYS use asterisk (*) for the dimension to sum, NEVER the dimension name
  * CRITICAL: Every SUM equation MUST contain at least one asterisk (*) - this is mandatory
  * Example: SUM(Revenue[*]) NOT SUM(Revenue[region])
  * The asterisk (*) represents "sum over all elements of this dimension"

STEP 5 - VERIFY MODEL VALIDITY:
Continuously verify the model produces correct results for correct reasons. Question whether the structure truly represents the described system.`

    static FORMULATION_ERROR_SECTION =
`IDENTIFY FORMULATION ERRORS:
When reviewing or fixing models, detect and correct these common errors:

a. GRAPHICAL FUNCTION INPUT ERRORS:
   - Graphical functions MUST NEVER use DT as input (DT is constant)
   - USE TIME instead of DT for graphical functions

b. VARIABLE TYPE ERRORS FOR AGGREGATIONS:
   - Simple sums (e.g., total population) MUST be auxiliaries (type "variable"), NOT stocks
   - Stocks represent accumulations via flows; sums are algebraic calculations

c. AVERAGING FUNCTION ERRORS:
   - USE SMOOTH function for moving averages
   - DO NOT USE DELAY1 or DELAY3 for averaging (delays only shift time, they don't average)

- PROVIDE detailed explanation listing: every error found, exact variable name, what was wrong, how it was fixed`

    static MENTOR_ADDITIONAL_CONCERNS =
`EVALUATE MODEL SCOPE (Teaching Focus):
Critically assess model completeness and guide users through questioning:
- Are all relevant variables included?
- Are there missing connections between variables that should exist?
- Work with the user to help them understand where the model might fall short
- Ensure all suggestions follow MECE principle (Mutually Exclusive, Collectively Exhaustive)
- NEVER suggest additions that duplicate existing model elements

EXAMINE STOCK DYNAMICS (Teaching Focus):
For each stock, help the user consider if there are any missing flows which could drive important dynamics relative to their problem statement.`

    static MENTOR_SYSTEM_PROMPT =
`You are a System Dynamics Mentor and Teacher. Generate stock and flow models from user-provided text while teaching users to understand and improve their work through Socratic questioning and constructive critique.

PEDAGOGICAL APPROACH:
Your role is to facilitate learning, NOT to provide praise. Execute these teaching principles:
- Ask probing questions that guide users to discover what could be improved in the model
- Think critically about the model and their questions to determine the right questions to ask
- Be a constant source of constructive critique
- Explain problems you identify AND ask questions to help users learn to critique models themselves
- Explicitly state when you lack confidence in your model
- Help users learn System Dynamics principles through dialogue
- Add smaller, logically connected pieces of structure incrementally to the model

CRITICAL TEACHING RESTRICTION:
NEVER identify feedback loops for the user in explanatory text. Let users discover loops themselves through your questioning.

${QuantitativeEngineBrain.BASE_SYSTEM_PROMPT_CORE}

STEP 6 - ${QuantitativeEngineBrain.MENTOR_ADDITIONAL_CONCERNS}

STEP 7 - ${QuantitativeEngineBrain.FORMULATION_ERROR_SECTION}`

    static DEFAULT_SYSTEM_PROMPT =
`You are a System Dynamics Professional Modeler. Generate stock and flow models from user-provided text following these mandatory rules:

${QuantitativeEngineBrain.BASE_SYSTEM_PROMPT_CORE}

STEP 6 - ${QuantitativeEngineBrain.FORMULATION_ERROR_SECTION}`

    static DEFAULT_ASSISTANT_PROMPT = 
`I want your response to consider the model which you have already so helpfully given to us. You should never change the name of any variable you've already given us. Your response should add new variables wherever you have evidence to support the existence of the relationships needed to close feedback loops.  Sometimes closing a feedback loop will require you to add multiple relationships.`

    static DEFAULT_BACKGROUND_PROMPT =
`Please be sure to consider the following critically important background information when you give your answer.

{backgroundKnowledge}`

    static DEFAULT_PROBLEM_STATEMENT_PROMPT = 
`The user has stated that they are conducting this modeling exercise to understand the following problem better.

{problemStatement}`

    #data = {
        backgroundKnowledge: null,
        problemStatement: null,
        openAIKey: null,
        googleKey: null,
        mentorMode: false,
        underlyingModel: LLMWrapper.DEFAULT_MODEL,
        systemPrompt: QuantitativeEngineBrain.DEFAULT_SYSTEM_PROMPT,
        assistantPrompt: QuantitativeEngineBrain.DEFAULT_ASSISTANT_PROMPT,
        backgroundPrompt: QuantitativeEngineBrain.DEFAULT_BACKGROUND_PROMPT,
        problemStatementPrompt: QuantitativeEngineBrain.DEFAULT_PROBLEM_STATEMENT_PROMPT
    };

    #llmWrapper;

    constructor(params) {
        Object.assign(this.#data, params);

        if (!this.#data.problemStatementPrompt.includes('{problemStatement')) {
            this.#data.problemStatementPrompt = this.#data.problemStatementPrompt.trim() + "\n\n{problemStatement}";
        }

        if (!this.#data.backgroundPrompt.includes('{backgroundKnowledge')) {
            this.#data.backgroundPrompt = this.#data.backgroundPrompt.trim() + "\n\n{backgroundKnowledge}";
        }

        this.#llmWrapper = new LLMWrapper(params);
       
    }

    #isFlowUsed(flow, response) {
        return response.variables.findIndex((v)=> {
            if (v.type === "stock") {
                const inflowMatch = (v.inflows || []).findIndex((f) => {
                    return flow.name === f;
                }) >= 0;
                const outflowMatch = (v.outflows || []).findIndex((f) => {
                    return flow.name === f;
                }) >= 0;
                return inflowMatch || outflowMatch;
            }

            return false;
        }) >= 0;
    }

    #containsHtmlTags(str) {
        // This regex looks for patterns like <tag>, </tag>, or <tag attribute="value">
        const htmlTagRegex = /<[a-z/][^>]*>/i; 
        return htmlTagRegex.test(str);
    }

    async processResponse(originalResponse) {

        //logger.log(JSON.stringify(originalResponse));
        //logger.log(originalResponse);
        const responseHasVariable = (variable) => {
            return originalResponse.variables.findIndex((v) => {
                return projectUtils.sameVars(v.name, variable);
            }) >= 0;
        };

        let origRelationships = originalResponse.relationships || [];

        let relationships = origRelationships.map(relationship => { 
            let ret = Object.assign({}, relationship);
            ret.from = relationship.from.trim();
            ret.to = relationship.to.trim();
            ret.valid = !projectUtils.sameVars(ret.from, ret.to) && responseHasVariable(ret.from) && responseHasVariable(ret.to);
            return ret;
        });

        //filter out any relationship whose .to attribute is a variable that has a crossLevelGhostOf
        relationships.forEach(relationship => {
            if (relationship.valid) {
                const toVariable = originalResponse.variables.find(v => projectUtils.sameVars(v.name, relationship.to));
                if (toVariable && toVariable.crossLevelGhostOf && toVariable.crossLevelGhostOf.length > 0) {
                    relationship.valid = false;
                }
            }
        });

        //filter out any relationships that reference array elements with bracket notation
        relationships.forEach(relationship => {
            if (relationship.valid) {
                //if the to or from has a [ in the name mark it invalid (array element references)
                if (relationship.from.includes('[') || relationship.to.includes('[')) {
                    relationship.valid = false;
                }
            }
        });

        //mark for removal any relationships which are duplicates, keep the first one we encounter
        for (let i=1,len=relationships.length; i < len; ++i) {
            for (let j=0; j < i; ++j) {
                let relJ = relationships[j];
                let relI = relationships[i];
                
                //who cares if its an invalid link
                if (!relI.valid || !relJ.valid)
                    continue;

                if (projectUtils.sameVars(relJ.from, relI.from) && projectUtils.sameVars(relJ.to, relI.to)) {
                    relI.valid = false;
                }
            }
        }

        //remove the invalid ones, then remove the valid field
        relationships = relationships.filter((relationship) => { 
            return relationship.valid;
        });

        relationships.forEach((relationship) => {             
            delete relationship.valid;
        });
        
        originalResponse.relationships = relationships;
        originalResponse.variables = originalResponse.variables || [];

        //LLMs like gemini-3-flash-preview (before I made it so that all properties are required, but nullable) 
        //does not like to generate the inflow and outflow lists for stocks.
        //to solve the problem, we look at the list of relationships to generate the inflow and outflow lists
        //We do that by going through all of the relationships and if there is a link pointing to a stock from a flow, 
        //make sure its registered as an inflow or an outflow
        relationships.forEach((relationship) => {
            const toVariable = originalResponse.variables.find(v => projectUtils.sameVars(v.name, relationship.to));
            const fromVariable = originalResponse.variables.find(v => projectUtils.sameVars(v.name, relationship.from));

            if (toVariable && toVariable.type === "stock" && fromVariable && fromVariable.type === "flow") {
                // Initialize inflows and outflows arrays if they don't exist
                if (!toVariable.inflows) {
                    toVariable.inflows = [];
                }
                if (!toVariable.outflows) {
                    toVariable.outflows = [];
                }

                // If this variable is an inflow or an outflow already, don't re-add it
                const isInInflows = toVariable.inflows.findIndex(f => projectUtils.sameVars(f, fromVariable.name)) >= 0;
                const isInOutflows = toVariable.outflows.findIndex(f => projectUtils.sameVars(f, fromVariable.name)) >= 0;
                if (isInInflows || isInOutflows) {
                    return;
                }

                // Add flow to inflows or outflows based on polarity, if no polarity then we add it as an inflow
                if (relationship.polarity === "-") {
                    if (!isInOutflows) {
                        toVariable.outflows.push(fromVariable.name);
                    }
                } else { //positive polarity or unknown, its an inflow
                    if (!isInInflows) {
                        toVariable.inflows.push(fromVariable.name);
                    }
                }
            }
        });

        //this fixes generating flows that are not connected to stocks
        originalResponse.variables.forEach((v)=>{
            //go through all the flows -- make sure they appear in an inflows or outflows, and if they don't change them to type variable
            if (v.type === "flow" && !this.#isFlowUsed(v, originalResponse)) {
                v.type = "variable";
                //logger.log("Changing type from flow to variable for... " + v.name);
                //logger.log(v);
            }
        });

        if (originalResponse.explanation)
            originalResponse.explanation = await marked.parse(originalResponse.explanation);

        return originalResponse;
    }

    mentor() {
        this.#data.systemPrompt = QuantitativeEngineBrain.MENTOR_SYSTEM_PROMPT;
        this.#data.mentorMode = true;
    }

    setupLLMParameters(userPrompt, lastModel) {
        //start with the system prompt
        const { underlyingModel, systemRole, temperature, reasoningEffort } = this.#llmWrapper.getLLMParameters();
        let systemPrompt = this.#data.systemPrompt;
        let responseFormat = this.#llmWrapper.generateQuantitativeSDJSONResponseSchema(this.#data.mentorMode);

        if (!this.#llmWrapper.model.hasStructuredOutput) {
            throw new Error("Unsupported LLM " + this.#data.underlyingModel + " it does support structured outputs which are required.");
        }

        let messages = [{ 
            role: systemRole, 
            content: systemPrompt 
        }];

        if (this.#data.backgroundKnowledge) {
            messages.push({
                role: "user",
                content:  this.#data.backgroundPrompt.replaceAll("{backgroundKnowledge}", this.#data.backgroundKnowledge),
            });
        }
        if (this.#data.problemStatement) {
            messages.push({
                role: systemRole,
                content: this.#data.problemStatementPrompt.replaceAll("{problemStatement}", this.#data.problemStatement),
            });
        }

        if (lastModel) {
            messages.push({ role: "assistant", content: JSON.stringify(lastModel, null, 2) });

            if (this.#data.assistantPrompt)
                messages.push({ role: "user", content: this.#data.assistantPrompt });
        }

        //give it the user prompt
        messages.push({ role: "user", content: userPrompt });

        return {
            messages,
            model: underlyingModel,
            responseFormat: responseFormat,
            temperature: temperature,
            reasoningEffort: reasoningEffort
        };
    }

    async generateModel(userPrompt, lastModel) {
        const llmParams = this.setupLLMParameters(userPrompt, lastModel);

        //get what it thinks the relationships are with this information
        const originalResponse = await this.#llmWrapper.createChatCompletion(
            llmParams.messages,
            llmParams.model,
            llmParams.responseFormat,
            llmParams.temperature,
            llmParams.reasoningEffort
        );
        if (originalResponse.refusal) {
            throw new ResponseFormatError(originalResponse.refusal);
        } else if (originalResponse.parsed) {
            return this.processResponse(originalResponse.parsed);
        } else if (originalResponse.content) {
            let parsedObj = {variables: [], relationships: []};
            try {
                parsedObj = JSON.parse(originalResponse.content);
            } catch (err) {
                throw new ResponseFormatError("Bad JSON returned by underlying LLM");
            }
            return this.processResponse(parsedObj);
        } else {
            throw new ResponseFormatError("LLM response did not contain any recognized format (no refusal, parsed, or content fields)");
        }
    }
}

export default QuantitativeEngineBrain;