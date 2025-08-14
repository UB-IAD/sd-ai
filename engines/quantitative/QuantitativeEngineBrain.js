import projectUtils, { LLMWrapper } from '../../utils.js'
import { marked } from 'marked';

class ResponseFormatError extends Error {
    constructor(message) {
        super(message);
        this.name = "ResponseFormatError";
    }
}

class QuantitativeEngineBrain {

    // Prompts are optimized for large frontier models. Smaller on-device
    // models may benefit from shorter instructions and explicit examples to
    // stay within their context window and reduce ambiguity.

     static MENTOR_SYSTEM_PROMPT =
`You are a meticulous system dynamics tutor. Your role is to guide the user in building a correct stock and flow model from the text they provide and to deepen their understanding. Ask focused questions, highlight uncertainties, and never name feedback loops directly.

Follow this procedure:

1. Read the text carefully and extract the minimal set of neutral variable names (max five words, letters and spaces only).
2. For each variable, identify causal relationships and mark polarity with "+" for same-direction change and "-" for opposite-direction change.
3. Classify each variable as stock, flow, or variable.
4. Provide an XMILE equation for every variable, referencing only other variables.
5. Search for feedback loops and add justified relationships to close them.
6. For every stock, check for missing inflows or outflows.
7. Point out scope gaps and ask questions that help the learner critique the model.

If no causal relationships are supported by the text, return {"variables": [], "relationships": []}.

The final reply must be valid JSON conforming to the provided schema with no extra text. Think through the problem before answering.
`


    static DEFAULT_SYSTEM_PROMPT = 
`You are a System Dynamics professional modeler. Build a stock and flow model from the user's text.

Procedure:

1. Extract the minimal set of neutral variable names (max five words, letters and spaces only).
2. Record causal relationships and label the polarity with "+" or "-".
3. Classify each variable as stock, flow, or variable.
4. Provide an XMILE equation for every variable using only other variables.
5. If evidence allows, close feedback loops by adding additional relationships.
6. Return an empty JSON structure when no causal links exist.
7. Ensure the model explains the behavior for the right reasons.

Output must be valid JSON with fields: variables, relationships, explanation. Do not include commentary outside the JSON. Think step by step before responding.
`

    static DEFAULT_ASSISTANT_PROMPT = 
`Consider the model you have already provided. Keep existing variable names exactly as they were. Add only variables or relationships that are clearly supported by the text and that help close feedback loops. Ensure every referenced variable has a defined type and equation, and every stock has the necessary inflows and outflows. Return the full updated model as valid JSON.
`

    static DEFAULT_BACKGROUND_PROMPT =
`Please incorporate the following background information when forming your answer. Treat it as context; do not quote it directly.

{backgroundKnowledge}
`

    static DEFAULT_FEEDBACK_PROMPT =
`Review the draft model. If additional evidence-supported links allow closed feedback loops, add them and update equations. Remove duplicate or self-referential relationships. Confirm that every variable used in a relationship has a defined equation and type. Respond with the revised model as valid JSON.
`

    static DEFAULT_PROBLEM_STATEMENT_PROMPT = 
`The user is building this model to explore the following problem:

{problemStatement}
`

    #data = {
        backgroundKnowledge: null,
        problemStatement: null,
        openAIKey: null,
        googleKey: null,
        mentorMode: false,
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

    #isFlowUsed(flow, response) {
        return response.variables.findIndex((v)=> {
            if (v.type === "stock") {
                return v.inflows.findIndex((f) => {
                    return flow.name === f;
                }) >= 0 || v.outflows.findIndex((f) => {
                    return flow.name === f;
                }) >= 0;
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
        let underlyingModel = this.#data.underlyingModel;
        let systemRole = this.#llmWrapper.model.systemModeUser;
        let systemPrompt = this.#data.systemPrompt;
        let responseFormat = this.#llmWrapper.generateQuantitativeSDJSONResponseSchema(this.#data.mentorMode);
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

        return {
            messages,
            model: underlyingModel,
            response_format: responseFormat,
            temperature: temperature,
            reasoning_effort: reasoningEffort
        };
    }

    async generateModel(userPrompt, lastModel) {
        const llmParams = this.setupLLMParameters(userPrompt, lastModel);
        
        //get what it thinks the relationships are with this information
        const originalCompletion = await this.#llmWrapper.openAIAPI.chat.completions.create(llmParams);

        const originalResponse = originalCompletion.choices[0].message;
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
        }
    }
}

export default QuantitativeEngineBrain;