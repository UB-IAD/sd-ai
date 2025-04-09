import AdvancedEngine from './../engines/advanced/engine.js'
import 'dotenv/config'
import setup from './support/setup.js'

setup();

const cases = {
    "American Revolution": {
        prompt: "Using your knowledge of how the american revolution started and the additional information I have given you, please give me a feedback based explanation for how the american revolution came about.",
        problemStatement: "I am trying to understand how the american revolution started.  I'd like to know what caused hostilities to break out.",
        backgroundKnowledge:
`The American Revolution was caused by a number of factors, including:
Taxation
The British imposed new taxes on the colonies to raise money, such as the Stamp Act of 1765, which taxed legal documents, newspapers, and playing cards. The colonists were angry because they had no representatives in Parliament. 
The Boston Massacre
In 1770, British soldiers fired on a crowd of colonists in Boston, killing five people. The massacre intensified anti-British sentiment and became a propaganda tool for the colonists. 
The Boston Tea Party
The Boston Tea Party was a major act of defiance against British rule. It showed that Americans would not tolerate tyranny and taxation. 
The Intolerable Acts
The British government passed harsh laws that the colonists called the Intolerable Acts. One of the acts closed the port of Boston until the colonists paid for the tea they had ruined. 
The French and Indian War
The British wanted the colonies to repay them for their defense during the French and Indian War (1754–63). 
Colonial identity
The colonists developed a stronger sense of American identity`
    }, 
    "Road Rage": {
        prompt: "Using your knowledge of how road rage happens and the additional information I have given you, please give me a feedback based explanation for how road rage incidents might change in the future.",
        problemStatement: "I am trying to understand how road rage happens.  I'd like to know what causes road rage in society.",
        backgroundKnowledge: 
`Road rage, defined as aggressive driving behavior caused by anger and frustration, can be triggered by various factors: 
Psychological Factors: 
Stress and Anxiety:
High stress levels can make drivers more irritable and prone to aggressive reactions. 
Personality Traits:
Individuals with impulsive, hostile, or competitive personalities may be more likely to engage in road rage. 
Frustration:
Feeling frustrated or blocked by other drivers can lead to anger and aggression. 
Situational Factors: 
Traffic Congestion:
Heavy traffic, delays, and stop-and-go conditions can increase stress and impatience. 
Perceived Provocations:
Being cut off, tailgated, or honked at can provoke anger and retaliatory behavior. 
Impatience:
Drivers who are running late or have a low tolerance for delays may become aggressive. 
Environmental Factors: 
Road Design:
Poor road design, such as narrow lanes or confusing intersections, can contribute to traffic congestion and frustration. 
Weather Conditions:
Adverse weather conditions, such as heavy rain or snow, can increase stress and make driving more challenging. 
Other Factors: 
Learned Behavior: Observing aggressive driving behavior from others can normalize it and increase the likelihood of engaging in road rage. 
Lack of Sleep: Fatigue can impair judgment and make drivers more susceptible to anger. 
Distracted Driving: Using a phone, texting, or eating while driving can increase the risk of accidents and provoke anger.`
    }
};

const extractVariables = function(relationshipList) {
    let set = new Set();
    for (const relationship of relationshipList) {
        set.add(relationship.from);
        set.add(relationship.to);
    }
    return set;
};

const countLoops = function(relationshipList) {
    let graph = {};

    for (const relationship of relationshipList) {
        if (relationship.from in graph)
            graph[relationship.from].push(relationship.to);
        else
            graph[relationship.from] = [relationship.to];
    }

    let count = 0;
    const numNodes = Object.keys(graph).length;
    const visited = new Array(numNodes).fill(false);
    const recursionStack = new Array(numNodes).fill(false);

    function dfs(node) {
        visited[node] = true;
        recursionStack[node] = true;

        for (const neighbor of graph[node] || []) {
            if (!visited[neighbor]) {
                if (dfs(neighbor)) {
                    return true;
                }
            } else if (recursionStack[neighbor]) {
                count++; // Cycle detected
                return true;
            }
        }

        recursionStack[node] = false;
        return false;
    }

    for (const node of Object.keys(graph)) {
        if (!visited[node]) {
            dfs(node);
        }
    }

    return count;
};

const compareRelationshipLists = function(fromAI, requirements) {
    const fromAIVariables = extractVariables(fromAI);
    const fromAIFeedbackLoops = countLoops(fromAI);

    if ("variables" in requirements) {    
        for (const requiredVar of requirements.variables)
            expect(fromAIVariables).withContext("Missing required variables: Variables are: " + Array.from(fromAIVariables).join(', ')).toContain(requiredVar);
    }

    if ("minVariables" in requirements) {
        expect(fromAIVariables.size).withContext("Too few variables: Variables are: " + Array.from(fromAIVariables).join(', ')).toBeGreaterThanOrEqual(requirements.minVariables);
    }

    if ("maxVariables" in requirements) {
        expect(fromAIVariables.size).withContext("Too many variables: Variables are: " + Array.from(fromAIVariables).join(', ')).toBeLessThanOrEqual(requirements.maxVariables);
    }
    
    if ("minFeedback" in requirements) {
        expect(fromAIFeedbackLoops).withContext("Too few feedback loops: The number of feedback loops found was " + fromAIFeedbackLoops).toBeGreaterThanOrEqual(requirements.minFeedback);
    }

    if ("maxFeedback" in requirements) {
        expect(fromAIFeedbackLoops).withContext("Too many feedback loops: The number of feedback loops found was " + fromAIFeedbackLoops).toBeLessThanOrEqual(requirements.maxFeedback);
    }
};

//elements by which we measure conformance.  these are specific instructions to append to the prompt
const genericConformanceElements = [
    {
        text: 'Your response must include at least 10 variables.',
        description: "include a minimum number of variables",
        response: {
            minVariables: 10
        }
    }, {
        text: 'Your response must include no more than 5 variables.',
        description: "include a maximum number of variables",
        response: {
            maxVariables: 5
        }
    }, {
        text: 'Your response must include at least 8 feedback loops.',
        description: "include a minimum number of feedback loops",
        response: {
            minFeedback: 8
        }
    }, {
        text: 'Your response must include no more than 4 feedback loops.',
        description: "include a maximum number of feedback loops",
        response: {
            maxFeedback: 4
        }
    }, {
        text: 'Your response must include no more than 4 feedback loops and no more than 5 variables.',
        description: "include a maximum number of feedback loops and a maximum number of variables",
        response: {
            maxFeedback: 4,
            maxVariables: 5
        }
    }, {
        text: 'Your response must include at least 6 feedback loops and at least 8 variables.',
        description: "include a minimum number of feedback loops and a minimum number of variables",
        response: {
            minFeedback: 6,
            minVariables: 8
        }
    }, {
        text: 'Your response must include no more than 4 feedback loops and at least 5 variables.',
        description: "include a maximum number of feedback loops and a minimum number of variables",
        response: {
            maxFeedback: 4,
            minVariables: 5
        }
    }, {
        text: 'Your response must include at least 6 feedback loops and no more than 15 variables.',
        description: "include a min number of feedback loops and a maximum number of variables",
        response: {
            minFeedback: 6,
            maxVariables: 15
        }
    }
];

const specificConformanceElements = {
    "Road Rage" : [
        {
            text: 'Your response must include the variables "Traffic Congestion", "Driver Stress" and "Accidents".',
            description: "include requested variables",
            response: { 
                variables: [
                    "Traffic Congestion",
                    "Driver Stress",
                    "Accidents"
                ]
            }
        }, 
    ],

    "American Revolution": [
        {
            text: 'Your response must include the variables "Taxation", "Anti-British Sentiment" and "Colonial Identity".',
            description: "include requested variables",
            response: { 
                variables: [
                    "Taxation",
                    "Anti-British Sentiment",
                    "Colonial Identity"
                ]
            }
        }, 
    ]
}

const generateConformanceTest = function(conformanceElement, specificCase) {
    return {
        prompt: cases[specificCase].prompt + " " + conformanceElement.text,
        problemStatement: cases[specificCase].problemStatement,
        backgroundKnowledge: cases[specificCase].backgroundKnowledge,
        description: conformanceElement.description,
        responseCheck: conformanceElement.response,
        case: specificCase
    };
};

let conformanceTests = [];
for (const specificCase in cases) {
    conformanceTests = conformanceTests.concat(genericConformanceElements.map((e)=>{
        return generateConformanceTest(e, specificCase);
    })).concat(specificConformanceElements[specificCase].map((e)=>{
        return generateConformanceTest(e, specificCase);
    }));
}

let llmsToTest = ['gpt-4o', 'gpt-4o-mini', 'gpt-4.5-preview', 'gemini-2.5-pro-preview', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash', 'o3-mini high', 'o3-mini medium', 'o1'];

//For quick tests
llmsToTest.splice(1);
//llmsToTest = [ 'o3-mini high']

for (const llm of llmsToTest) {
    describe(`${llm} | conformance testing |`, function() {
        for (const test of conformanceTests) {
            it("can conform to the instruction " + test.description + "| for the case " + test.case, async() => {
                const engine = new AdvancedEngine();
                const response = await engine.generate(test.prompt, {}, {underlyingModel: llm, problemStatement: test.problemStatement, backgroundKnowledge: test.backgroundKnowledge});
                compareRelationshipLists(response.model.relationships, test.responseCheck);
            })
        }
    });
}
