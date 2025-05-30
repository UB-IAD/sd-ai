import projectUtils, { LLMWrapper } from '../../utils.js'

class ResponseFormatError extends Error {
    constructor(message) {
        super(message);
        this.name = "ResponseFormatError";
    }
}

class QuantitativeEngineBrain {

    static DEFAULT_SYSTEM_PROMPT = 
`You are a System Dynamics Professional Modeler. Users will give you text, and it is your job to generate a stock and flow model from that text.

You will conduct a multistep process:

1. You will identify all the entities that have a cause-and-effect relationships between. These entities are variables. Name these variables in a concise manner. A variable name should not be more than 5 words. Make sure that you minimize the number of variables used. Variable names should be neutral, i.e., there shouldn't be positive or negative meaning in variable names. Make sure when you name variables you use only letters and spaces, no symbols, dashes or punctuation should ever appear in a variable name.

2. For each variable, represent its causal relationships with other variables. There are two different kinds of polarities for causal relationships: positive polarity represented with a + symbol and negative represented with a - symbol. A positive polarity (+) relationship exits when variables are positively correlated.  Here are two examples of positive polarity (+) relationships. If a decline in the causing variable (the from variable) leads to a decline in the effect variable (the to variable), then the relationship has a positive polarity (+).  A relationship also has a positive polarity (+) if an increase in the causing variable (the from variable) leads to an increase in the effect variable (the to variable).  A negative polarity (-) is when variables are anticorrelated.  Here are two examples of negative polarity (-) relationships.  If a decline in the causing variable (the from variable) leads to an increase in the effect variable (the to variable), then the relationship has a negative polarity (-). A relationship also has a negative polarity (-) if an increase in the causing variable (the from variable) causes a decrease in the effect variable (the to variable). 

3. For each variable you will determine its type.  There are three types of variables, stock, flow, and variable. A stock is an accumulation of its flows.  A stock can only change because of its flows. A flow is the derivative of a stock.  A plain variable is used for algebraic expressions.

4. If there are no causal relationships at all in the provided text, return an empty JSON array.  Do not create relationships which do not exist in reality.

5. For each variable you will provide its equation.  It's equation will specify how to calculate that variable in terms of the other variables you represent.  The equations must be written in XMILE format.  Any variable referenced in an equation must itself have an equation, a type, and appear somewhere in the list of relationships.

6. Try as hard as you can to close feedback loops between the variables you find. It is very important that your answer includes feedback.  A feedback loop happens when there is a closed causal chain of relationships.  An example would be "Variable1" causes "Variable2" to increase, which causes "Variable3" to decrease which causes "Variable1" to again increase.  Try to find as many of the feedback loops as you can.`

    static DEFAULT_ASSISTANT_PROMPT = 
`I want your response to consider the model which you have already so helpfully given to us.  Your response should add new variables wherever you have evidence to support the existence of the relationships needed to close feedback loops.  Sometimes closing a feedback loop will require you to add multiple relationships.`

    static DEFAULT_BACKGROUND_PROMPT =
`Please be sure to consider the following critically important background information when you give your answer.

{backgroundKnowledge}`

    static DEFAULT_FEEDBACK_PROMPT =
`Find out if there are any possibilities of forming closed feedback loops that are implied in the analysis that you are doing. If it is possible to create a feedback loop using the variables you've found in your analysis, then close any feedback loops you can by adding the extra relationships which are necessary to do so.  This may require you to add many relationships.  This is okay as long as there is evidence to support each relationship you add.`

    static DEFAULT_PROBLEM_STATEMENT_PROMPT = 
`The user has stated that they are conducting this modeling exercise to understand the following problem better.

{problemStatement}`

    #data = {
        backgroundKnowledge: null,
        problemStatement: null,
        openAIKey: null,
        googleKey: null,
        underlyingModel: LLMWrapper.DEFAULT_MODEL,
        systemPrompt: QuantitativeEngineBrain.DEFAULT_SYSTEM_PROMPT,
        assistantPrompt: QuantitativeEngineBrain.DEFAULT_ASSISTANT_PROMPT,
        feedbackPrompt: QuantitativeEngineBrain.DEFAULT_FEEDBACK_PROMPT,
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

    #processResponse(originalResponse) {
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
        return originalResponse;
    }

    async generateModel(userPrompt, lastModel) {        
        //start with the system prompt
        let underlyingModel = this.#data.underlyingModel;
        let systemRole = this.#llmWrapper.model.systemModeUser;
        let systemPrompt = this.#data.systemPrompt;
        let responseFormat = this.#llmWrapper.generateQuantitativeSDJSONResponseSchema();
        let temperature = 0;
        let reasoningEffort = undefined;

        if (underlyingModel.startsWith('o3-mini ')) {
            const parts = underlyingModel.split(' ');
            underlyingModel = 'o3-mini';
            reasoningEffort = parts[1].trim();
        } else if (underlyingModel.startsWith('o3 ')) {
            const parts = underlyingModel.split(' ');
            underlyingModel = 'o3';
            reasoningEffort = parts[1].trim();
        }

        if (!this.#llmWrapper.model.hasStructuredOutput) {
            throw new Error("Unsupported LLM " + this.#data.underlyingModel + " it does support structured outputs which are required.");
        }

        if (!this.#llmWrapper.model.hasSystemMode) {
            systemRole = "user";
            temperature = 1;
        }

        if (!this.#llmWrapper.model.hasTemperature) {
            temperature = undefined;
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
        messages.push({ role: "user", content: this.#data.feedbackPrompt }); //then have it try to close feedback
        
        //get what it thinks the relationships are with this information
        const originalCompletion = await this.#llmWrapper.openAIAPI.chat.completions.create({
            messages: messages,
            model: underlyingModel,
            response_format: responseFormat,
            temperature: temperature,
            reasoning_effort: reasoningEffort
        });

        const originalResponse = originalCompletion.choices[0].message;
        if (originalResponse.refusal) {
            throw new ResponseFormatError(originalResponse.refusal);
        } else if (originalResponse.parsed) {
            return this.#processResponse(originalResponse.parsed);
        } else if (originalResponse.content) {
            let parsedObj = {variables: [], relationships: []};
            try {
                parsedObj = JSON.parse(originalResponse.content);
            } catch (err) {
                throw new ResponseFormatError("Bad JSON returned by underlying LLM");
            }
            return this.#processResponse(parsedObj);
        }
    }
}

export default QuantitativeEngineBrain;