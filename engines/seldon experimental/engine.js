import { LLMWrapper } from '../../utils.js';
import SeldonBrain from '../seldon/SeldonBrain.js'

class Engine {
        static SYSTEM_PROMPT_DESC = 
`An system prompt is a predefined instruction or set of instructions provided to guide the behavior, style, or functionality of a language model during a conversation. This prompt sets the tone, context, and boundaries for how the AI should interact with the user.

Key Features of a System Prompt:

1. Behavior Definition:
It specifies the role the AI should take. For example: "You are an AI assistant." or "You are a helpful tutor for physics concepts."

2. Scope and Boundaries:
It defines what the AI can or cannot do. For instance: "Stick to verified information."

3. Context Initialization:
It provides context for the conversation, such as introducing a fictional scenario, setting up a task, or clarifying the AI's expertise.

4. User Experience Shaping:
It ensures the AI’s responses align with the intended user experience, such as focusing on clarity, brevity, or detail.`

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
            name: "systemPrompt",
            type: "string",
            defaultValue: SeldonBrain.DEFAULT_SYSTEM_PROMPT,
            required: false,
            uiElement: "textarea",
            saveForUser: "global",
            label: "System Prompt",
            description: Engine.SYSTEM_PROMPT_DESC,
            minHeight: 100
        },{
            name: "structurePrompt",
            type: "string",
            defaultValue: SeldonBrain.DEFAULT_STRUCTURE_PROMPT,
            required: false,
            uiElement: "textarea",
            saveForUser: "global",
            label: "Structure Prompt",
            description: "A prompt given to the AI immediately after it has recieved a copy of the current state of the model.",
            minHeight: 50,
        },{
            name: "behaviorPrompt",
            type: "string",
            defaultValue: SeldonBrain.DEFAULT_BEHAVIOR_PROMPT,
            required: false,
            uiElement: "textarea",
            saveForUser: "global",
            label: "Behavior Prompt",
            description: "A prompt given to the AI with the behavioral description.  This prompt MUST contain the string {behaviorContent}",
            minHeight: 50,
        },{
            name: "feedbackPrompt",
            type: "string",
            defaultValue: SeldonBrain.DEFAULT_FEEDBACK_PROMPT,
            required: false,
            uiElement: "textarea",
            saveForUser: "global",
            label: "Feedback Prompt",
            description: "A prompt given to the AI with the feedback description.  This prompt MUST contain the string {feedbackContent}",
            minHeight: 50,
        },{
            name: "backgroundPrompt",
            type: "string",
            defaultValue: SeldonBrain.DEFAULT_BACKGROUND_PROMPT,
            required: false,
            uiElement: "textarea",
            saveForUser: "global",
            label: "Background Knowledge Prompt",
            description: "This prompt its given to the AI to help it make sense of, and to urge it to include this information into its thinking.  This prompt MUST contain the string {backgroundKnowledge}",
            minHeight: 50,
        },{
            name: "problemStatementPrompt",
            type: "string",
            defaultValue: SeldonBrain.DEFAULT_PROBLEM_STATEMENT_PROMPT,
            required: false,
            uiElement: "textarea",
            saveForUser: "global",
            label: "Problem Statement Prompt",
            description: "This prompt its given to the AI to help it make sense of, and to urge it use the user given problem statement in its response.  This prompt MUST contain the string {problemStatement}",
            minHeight: 50,
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