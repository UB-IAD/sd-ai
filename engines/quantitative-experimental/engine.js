import { LLMWrapper } from '../../utilities/LLMWrapper.js';
import QuantitativeEngineBrain from '../quantitative/QuantitativeEngineBrain.js'
import Engine from './../quantitative/engine.js'

class QuantativeExperimental extends Engine {
    static SYSTEM_PROMPT_DESC = 
`
An system prompt is a predefined instruction or set of instructions provided to guide the behavior, style, or functionality of a language model during a conversation. This prompt sets the tone, context, and boundaries for how the AI should interact with the user.

Key Features of a System Prompt:

1. Behavior Definition:
It specifies the role the AI should take. For example: "You are an AI assistant." or "You are a helpful tutor for physics concepts."

2. Scope and Boundaries:
It defines what the AI can or cannot do. For instance: "Stick to verified information."

3. Context Initialization:
It provides context for the conversation, such as introducing a fictional scenario, setting up a task, or clarifying the AI's expertise.

4. User Experience Shaping:
It ensures the AI’s responses align with the intended user experience, such as focusing on clarity, brevity, or detail.
`

    constructor() {
        super();
    }

    static supportedModes() {
        return ["sfd"];
    }

    static description() {
        return `Exactly the same as the Quantitative engine, but with ability to customize all system prompts, 
select underlying LLM service and bring your own API key. This engine is designed for the tinkerer who wants 
to experiment with the specific prompts passed to the LLM.`;
    }

    additionalParameters()  {
        let parameters = LLMWrapper.additionalParameters();

        return parameters.concat([{
                name: "systemPrompt",
                type: "string",
                defaultValue: QuantitativeEngineBrain.DEFAULT_SYSTEM_PROMPT,
                required: false,
                uiElement: "textarea",
                saveForUser: "global",
                label: "System Prompt",
                description: QuantativeExperimental.SYSTEM_PROMPT_DESC,
                minHeight: 100
            },{
                name: "backgroundPrompt",
                type: "string",
                defaultValue: QuantitativeEngineBrain.DEFAULT_BACKGROUND_PROMPT,
                required: false,
                uiElement: "textarea",
                saveForUser: "global",
                label: "Background Knowledge Prompt",
                description: "This prompt its given to the AI to help it make sense of, and to urge it to include this information into its thinking.  This prompt MUST contain the string {backgroundKnowledge}",
                minHeight: 50,
            },{
                name: "problemStatementPrompt",
                type: "string",
                defaultValue: QuantitativeEngineBrain.DEFAULT_PROBLEM_STATEMENT_PROMPT,
                required: false,
                uiElement: "textarea",
                saveForUser: "global",
                label: "Problem Statement Prompt",
                description: "This prompt its given to the AI to help it make sense of, and to urge it use the user given problem statement in its response.  This prompt MUST contain the string {problemStatement}",
                minHeight: 50,
            },{
                name: "assistantPrompt",
                type: "string",
                defaultValue: QuantitativeEngineBrain.DEFAULT_ASSISTANT_PROMPT,
                required: false,
                uiElement: "textarea",
                saveForUser: "global",
                label: "Assistant Prompt",
                description: "A prompt given to the AI immediately after it has recieved a copy of the current state of the model.  This prompt should remind the AI to include the information that it has already generated into its next response",
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
                description: "Background information you want the underlying model to consider when generating a diagram for you",
                minHeight: 100
            }
        ]);
    }
}

export default QuantativeExperimental;