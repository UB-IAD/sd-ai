import { LLMWrapper } from '../../utils.js';
import SeldonBrain from '../seldon/SeldonBrain.js'

class Engine {
    constructor() {

    }

    static role() {
        return "discuss";
    }

    static supportedModes() {
        return ["sfd-discuss", "cld-discuss"];
    }

    static description() {
        return ` This engine is used to discuss your model with “Seldon” (aka Hari Seldon the greatest System 
    Dynamicist who never lived), to learn about your model (AI built or human built, quantitative or qualitative). 
    Seldon is a chatbot that isn’t capable of editing or changing your model, but instead Seldon answers questions about your model.`;    
    }

    static link() {
        return "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5341966";
    }

    additionalParameters()  {
         return [{
            name: "googleKey",
            type: "string",
            required: false,
            uiElement: "password",
            saveForUser: "global",
            label: "Google API Key",
            description: "Leave blank for the default, or your Google API key - XXXXXX"
        },{
            name: "problemStatement",
            type: "string",
            required: false,
            uiElement: "textarea",
            saveForUser: "local",
            label: "Problem Statement",
            description: "Description of a dynamic issue within the system you are studying that highlights an undesirable behavior over time.",
            minHeight: 50,
            maxHeight: 100
        },{
            name: "backgroundKnowledge",
            type: "string",
            required: false,
            uiElement: "textarea",
            saveForUser: "local",
            label: "Background Knowledge",
            description: "Background information you want the LLM model to consider when generating a model for you",
            minHeight: 100
        },{
            name: "behaviorContent",
            type: "string",
            required: false,
            uiElement: "textarea",
            label: "Behavioral Description",
            description: "Copy and paste the contents of a table from your model with the variables you want the AI to help you to understand the behavior of. Or give it a text description of your reference mode or any other behavioral elements related to your model",
            minHeight: 100,
            maxHeight: 100
        },{
            name: "feedbackContent",
            type: "feedbackJSON",
            required: false,
            uiElement: "hidden",
            label: "JSON Description of feedback loops",
            description: "A JSON array of feedback loops in the model"
        }];
    }

    async generate(prompt, currentModel, parameters) {
        try {
            parameters.systemPrompt = SeldonBrain.QUESTION_SYSTEM_PROMPT;
            let brain = new SeldonBrain(parameters);
            const response = await brain.converse(prompt, currentModel);
            return {
                output: {
                    textContent: response
                }
            };
        } catch(err) {
            logger.error(err);
            return { 
                err: err.toString() 
            };
        }
    }
}

export default Engine;