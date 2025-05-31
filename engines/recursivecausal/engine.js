import AdvancedEngineBrain from '../default/AdvancedEngineBrain.js';
import { LLMWrapper } from '../../utils.js';

const RECURSIVE_SYSTEM_PROMPT = `You are a System Dynamics Assistant. Users will give you a topic, text and optionally some extra information to take into consideration. It is your job to generate causal relationships from that text while following other user specifications.
        
You must keep in mind the following:

1. You must name the variables identified in a concise manner. A variable name should not be more than 3 words. Variable names should be neutral, i.e., there shouldn't be positive or negative meaning in variable names.

2. For each variable, represent its causal relationships with other variables correctly. There are two different kinds of polarities for causal relationships: positive polarity represented with a + symbol and negative represented with a - symbol. A positive polarity (+) relationship exits when variables are positively correlated.  Here are two examples of positive polarity (+) relationships. If a decline in the causing variable (the from variable) leads to a decline in the effect variable (the to variable), then the relationship has a positive polarity (+). A relationship also has a positive polarity (+) if an increase in the causing variable (the from variable) leads to an increase in the effect variable (the to variable).  A negative polarity (-) is when variables are anticorrelated.  Here are two examples of negative polarity (-) relationships.  If a decline in the causing variable (the from variable) leads to an increase in the effect variable (the to variable), then the relationship has a negative polarity (-). A relationship also has a negative polarity (-) if an increase in the causing variable (the from variable) causes a decrease in the effect variable (the to variable). 

3. When three variables are related in a sentence, make sure the relationship between second and third variable is correct. For example, if "Variable1" inhibits "Variable2", leading to less "Variable3", "Variable2" and "Variable3" have a positive polarity (+) relationship.

5. If there are no causal relationships at all in the provided text, return an empty JSON array.  Do not create relationships which do not exist in reality (or text).

6. Try as hard as you can to close feedback loops between the variables you find. It is very important that your answer includes feedback.  A feedback loop happens when there is a closed causal chain of relationships.  An example would be “Variable1” causes “Variable2” to increase, which causes “Variable3” to decrease which causes “Variable1” to again increase.  Try to find as many of the feedback loops as you can.`


class RecursiveCausalEngine {
  additionalParameters() {
    let parameters = LLMWrapper.additionalParameters();
    return parameters.concat([
      {
        name: "problemStatement",
        type: "string",
        required: false,
        uiElement: "textarea",
        saveForUser: "local",
        label: "Problem Statement",
        description: "Description of a dynamic issue within the system you are studying that highlights an undesirable behavior over time.",
        minHeight: 50,
        maxHeight: 100
      },
      {
        name: "backgroundKnowledge",
        type: "string",
        required: false,
        uiElement: "textarea",
        saveForUser: "local",
        label: "Background Knowledge",
        description: "Background information you want the OpenAI model to consider when generating a diagram for you",
        minHeight: 100
      },
      {
        name: "mainTopics",
        type: "string",
        required: false,
        uiElement: "textarea",
        saveForUser: "local",
        label: "Main Topics",
        description: "Comma-separated list of main variables or topics to explore. Leave empty to auto-infer.",
        minHeight: 50,
      },
      {
        name: "depth",
        type: "number",
        required: true,
        uiElement: "lineedit",
        saveForUser: "local",
        label: "Depth",
        description: "How many layers of cause/effect to explore",
      }
    ]);
  }

  async generate(prompt, currentModel, parameters) {
    try {
      let mainTopics = (parameters.mainTopics || "")
        .split(',')
        .map(x => x.trim().toLowerCase())
        .filter(x => x.length > 0);

      if (mainTopics.length === 0 || mainTopics.includes("infer topic")) {
        const topicBrain = new AdvancedEngineBrain({
          ...parameters,
          systemPrompt: `You are a system dynamics assistant. Identify the main variables or topics you think are being discussed in the user-provided text below. Return only a comma-separated list of key topics.
          
          For example:
          Text:
          If A goes up then B goes down, which causes C to go up.

          Output:
          ['A', 'B', 'C']
          `,
          problemStatement: null
        });

        const inferencePrompt = `Text:\n"""\n${prompt}\n"""`;

        const result = await topicBrain.generateDiagram(inferencePrompt, { relationships: [] });
        if (Array.isArray(result.relationships) && result.relationships.length > 0) {
          mainTopics = result.relationships.map(r => r.from.toLowerCase());
        } else {
          throw new Error("Failed to infer main topics.");
        }
      }

      const maxDepth = parameters.depth;
      const explored = new Set();
      let allRelationships = [];

      const recursiveBrain = new AdvancedEngineBrain({
        ...parameters,
        systemPrompt: RECURSIVE_SYSTEM_PROMPT,
        problemStatement: prompt,
      });

      const exploreTopic = async (topic, depth) => {
        if (depth > maxDepth || explored.has(topic)) return;
        explored.add(topic);

        const topicPrompt = `Given the following user-provided text:"""\n${prompt}\n"""\nIdentify causes (drivers) and effects (impacts) of the topic: "${topic}" present in the text.`;

        const result = await recursiveBrain.generateDiagram(topicPrompt, { relationships: [] });

        if (!result.relationships || result.relationships.length === 0) return;

        allRelationships.push(...result.relationships);

        const nextTopics = new Set();
        for (const rel of result.relationships) {
          const from = rel.from.toLowerCase();
          const to = rel.to.toLowerCase();
          if (!explored.has(from)) nextTopics.add(from);
          if (!explored.has(to)) nextTopics.add(to);
        }

        for (const nextTopic of nextTopics) {
          await exploreTopic(nextTopic, depth + 1);
        }
      };

      for (const topic of mainTopics) {
        await exploreTopic(topic, 1);
      }

      const cleaned = await this.cleanRelationships(allRelationships, prompt, parameters);
      const polished = await this.adjustPolarities(cleaned, prompt, parameters);
      const variables = [...new Set(polished.flatMap(r => [r.from, r.to]))];

      return {
        supportingInfo: {
          explanation: "Recursive causal relationships extracted and polished up to specified depth.",
          title: "Recursive Causal Map"
        },
        model: {
          relationships: polished,
          variables
        }
      };
    } catch (err) {
      console.error(err);
      return { err: err.toString() };
    }
  }

  async cleanRelationships(relationships, prompt, parameters) {
    if (!relationships || relationships.length === 0) return relationships;

    const cleaningBrain = new AdvancedEngineBrain({
      ...parameters,
      systemPrompt: "You are a system dynamics assistant who improves variable naming and eliminates redundant links.",
      problemStatement: prompt
    });

    const cleanPrompt = `Given the following text: """${prompt}"""\nAnd the following causal relationships:\n${JSON.stringify(relationships, null, 2)}\n\nPlease:\n1. Normalize variable names (short, neutral phrases, 3 words or fewer)\n2. Merge variables that refer to the same thing\n3. Remove duplicate or redundant relationships\nReturn the cleaned relationships as a JSON array in the same format.`;

    const result = await cleaningBrain.generateDiagram(cleanPrompt, { relationships });
    return result.relationships || [];
  }

  async adjustPolarities(relationships, prompt, parameters) {
    if (!relationships || relationships.length === 0) return relationships;

    const polarityBrain = new AdvancedEngineBrain({
      ...parameters,
      systemPrompt: "You are a system dynamics expert that double-checks polarity logic between cause and effect variables.",
      problemStatement: prompt
    });

    const polishPrompt = `Given the following text: """${prompt}"""\nAnd the following causal relationships:\n${JSON.stringify(relationships, null, 2)}\n\nCheck the polarity and reasoning with repect to the text for each relationship based on the cause and effect. Make sure:\n- "+" means they change in the same direction\n- "-" means they change in opposite directions\nUpdate polarityReasoning if needed.\nReturn the adjusted relationships as a JSON array in the same format.`;

    const result = await polarityBrain.generateDiagram(polishPrompt, { relationships });
    return result.relationships || [];
  }
}

export default RecursiveCausalEngine;
