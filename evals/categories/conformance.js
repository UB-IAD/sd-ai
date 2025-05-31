const cases = {
  "American Revolution": {
    prompt: "Using your knowledge of how the American Revolution started and the additional information I have given you, please give me a feedback-based explanation for how the American Revolution came about.",
    problemStatement: "I am trying to understand how the American Revolution started. I'd like to know what caused hostilities to break out.",
    backgroundKnowledge: `The American Revolution was caused by a number of factors, including:
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
The colonists developed a stronger sense of American identity`,
    mainTopics: "American Revolution",
    depth: 1
  },
  "Road Rage": {
    prompt: "Using your knowledge of how road rage happens and the additional information I have given you, please give me a feedback-based explanation for how road rage incidents might change in the future.",
    problemStatement: "I am trying to understand how road rage happens. I'd like to know what causes road rage in society.",
    backgroundKnowledge: `Road rage, defined as aggressive driving behavior caused by anger and frustration, can be triggered by various factors: 
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
Distracted Driving: Using a phone, texting, or eating while driving can increase the risk of accidents and provoke anger.`,
    mainTopics: "Road Rage",
    depth: 1
  }
};

const extractVariables = (list) => {
  const set = new Set();
  for (const r of list) {
    set.add(r.from);
    set.add(r.to);
  }
  return set;
};

const countLoops = (list) => {
  const graph = {};
  for (const r of list) {
    if (!graph[r.from]) graph[r.from] = [];
    graph[r.from].push(r.to);
  }

  let count = 0;
  const visited = new Set();
  const recStack = new Set();

  function dfs(v) {
    visited.add(v);
    recStack.add(v);
    for (const n of graph[v] || []) {
      if (!visited.has(n)) {
        if (dfs(n)) return true;
      } else if (recStack.has(n)) {
        count++;
        return true;
      }
    }
    recStack.delete(v);
    return false;
  }

  for (const node of Object.keys(graph)) {
    if (!visited.has(node)) dfs(node);
  }

  return count;
};

const genericConformanceElements = [
  {
    text: 'Your response must include at least 10 variables.',
    name: "include a minimum number of variables",
    expectations: { minVariables: 10 }
  },
  {
    text: 'Your response must include no more than 5 variables.',
    name: "include a maximum number of variables",
    expectations: { maxVariables: 5 }
  },
  {
    text: 'Your response must include at least 8 feedback loops.',
    name: "include a minimum number of feedback loops",
    expectations: { minFeedback: 8 }
  },
  {
    text: 'Your response must include no more than 4 feedback loops.',
    name: "include a maximum number of feedback loops",
    expectations: { maxFeedback: 4 }
  },
  {
    text: 'Your response must include no more than 4 feedback loops and no more than 5 variables.',
    name: "include a maximum number of feedback loops and a maximum number of variables",
    expectations: { maxFeedback: 4, maxVariables: 5 }
  },
  {
    text: 'Your response must include at least 6 feedback loops and at least 8 variables.',
    name: "include a minimum number of feedback loops and a minimum number of variables",
    expectations: { minFeedback: 6, minVariables: 8 }
  },
  {
    text: 'Your response must include no more than 4 feedback loops and at least 5 variables.',
    name: "include a maximum number of feedback loops and a minimum number of variables",
    expectations: { maxFeedback: 4, minVariables: 5 }
  },
  {
    text: 'Your response must include at least 6 feedback loops and no more than 15 variables.',
    name: "include a min number of feedback loops and a maximum number of variables",
    expectations: { minFeedback: 6, maxVariables: 15 }
  }
];

const specificConformanceElements = {
  "Road Rage": {
    text: 'Your response must include the variables "Traffic Congestion", "Driver Stress" and "Accidents".',
    name: "include requested variables",
    expectations: {
      variables: ["traffic congestion", "driver stress", "accidents"]
    }
  },
  "American Revolution": {
    text: 'Your response must include the variables "Taxation", "Anti-British Sentiment" and "Colonial Identity".',
    name: "include requested variables",
    expectations: {
      variables: ["taxation", "anti-british sentiment", "colonial cdentity"]
    }
  }
};

const generateConformanceTest = function(conformanceElement, specificCase) {
  const c = cases[specificCase];
  return {
    name: conformanceElement.name + " for " + specificCase,
    prompt: c.prompt + " " + conformanceElement.text,
    additionalParameters: {
      problemStatement: c.problemStatement,
      backgroundKnowledge: c.backgroundKnowledge,
      mainTopics: c.mainTopics,
      depth: c.depth
    },
    expectations: conformanceElement.expectations,
  };
};

export const evaluate = (fromAI, requirements) => {
  const vars = extractVariables(fromAI);
  const loops = countLoops(fromAI);
  const fails = [];

  if (requirements.variables) {
    for (const v of requirements.variables) {
      if (!vars.has(v)) {
        fails.push({
          type: "Missing required variable",
          details: `Missing ${v}; present: ${Array.from(vars).join(", ")}`
        });
      }
    }
  }

  if (requirements.minVariables && vars.size < requirements.minVariables) {
    fails.push({
      type: "Too few variables",
      details: `Found ${vars.size} variables: ${Array.from(vars).join(", ")}`
    });
  }

  if (requirements.maxVariables && vars.size > requirements.maxVariables) {
    fails.push({
      type: "Too many variables",
      details: `Found ${vars.size} variables: ${Array.from(vars).join(", ")}`
    });
  }

  if (requirements.minFeedback && loops < requirements.minFeedback) {
    fails.push({
      type: "Too few feedback loops",
      details: `Only ${loops} feedback loops found`
    });
  }

  if (requirements.maxFeedback && loops > requirements.maxFeedback) {
    fails.push({
      type: "Too many feedback loops",
      details: `Found ${loops} feedback loops`
    });
  }

  return fails;
};

export const groups = {
  genericConformance: genericConformanceElements.flatMap(e =>
    Object.keys(cases).map(c => generateConformanceTest(e, c))
  ),
  specificConformance: Object.keys(cases).map(c =>
    generateConformanceTest(specificConformanceElements[c], c)
  )
};
