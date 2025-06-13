import { LLMWrapper } from '../../utils.js';
import SeldonBrain from './SeldonBrain.js'

class Engine {
    constructor() {

    }

    static role() {
        return "discuss";
    }

    static supportedModes() {
        return ["sfd-discuss", "cld-discuss"];
    }

    additionalParameters()  {
        const additionalParameters = LLMWrapper.additionalParameters();
        return additionalParameters.concat([{
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
        }]);
    }

    async generate(prompt, currentModel, parameters) {
        try {
            let brain = new SeldonBrain(parameters);
            const response = await brain.converse(prompt, currentModel);
            return {
                output: {
                    textContent: response
                }
            };
        } catch(err) {
            console.error(err);
            return { 
                err: err.toString() 
            };
        }
    }
}

export default Engine;