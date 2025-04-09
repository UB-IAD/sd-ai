import pluralize from 'pluralize';

//generic prompt and problem statement used for all tests
const prompt = "Please find all causal relationships in the background information.";
const problemStatement = "I'm trying to do causal discovery, and extract every cause and effect relationship from the information I give you.";

//random variable names to pick from
let nouns = [ "frimbulator",  "whatajig", "balack", "whoziewhat", "funkado", "maxabizer", "marticatene", "reflupper", "exeminte", "oc", "proptimatire", "priary", "houtal", "poval", "auspong", "dominitoxing", "outrance", "illigent", "yelb", "traze", "pablanksill", "posistorather", "crypteral", "oclate", "reveforly", "yoffa", "buwheal", "geyflorrin", "ih", "aferraron", "paffling", "pershipfulty", "copyring", "dickstonyx", "bellignorance", "hashtockle", "succupserva", "relity", "hazmick", "ku", "obvia", "unliescatice", "gissorm", "phildiscals", "loopnova", "hoza", "arinterpord", "burgination", "perstablintome", "memostorer", "baxtoy", "hensologic", "estintant", "perfecton", "raez", "younjuring"];

//polarity = "+" or "-""
//polarityStart = "up" or "down"
const generateCausalRelationship = function(fromRaw, toRaw, polarity, polarityStart) {
    if (["+", "-"].indexOf(polarity) < 0)
        throw new Error("Invalid polarity must be + or - you supplied " + polarity);

    if (["up", "down"].indexOf(polarityStart) < 0)
        throw new Error("Invalid polarityStart must be up or down you supplied " + polarityStart);

    const from = pluralize(fromRaw);
    const to = pluralize(toRaw);

    let mod1,mod2 = "";
    if (polarity === "+") {
        if (polarityStart === "up") {
            mod1 = "more";
            mod2 = "more";
        } else if (polarityStart === "down") {
            mod1 = "less";
            mod2 = "fewer";
        }
    } else if (polarity === "-") {
        if (polarityStart === "up") {
            mod1 = "more";
            mod2 = "fewer";
        } else if (polarityStart === "down") {
            mod1 = "less";
            mod2 = "more";
        }
    } 

    return { 
        english: "The " + mod1 + " " + from + " there are, the " + mod2 + " " + to + " there are.",
        relationship: {from: from, to: to, polarity: polarity}
    };
};

const generateFeedbackLoop = function(variables, polarity) {
    let causalText = '';
    let relationships = [];

    for (let i=0; i < variables.length; ++i) {
        let relationshipPolarity = "+"
        if (i == 0 && polarity === "-") {
            relationshipPolarity = "-"; //if this is balancing always make the first relationship the one negative relationship
        }
        let next = i+1;
        if (next >= variables.length)
            next = 0;
        const resp = generateCausalRelationship(variables[i], variables[next], relationshipPolarity, i % 2 ? "up" : "down");
        relationships.push(resp.relationship);
        causalText += " " + resp.english;
    }
    
    return {
        english: causalText.trim(),
        relationships: relationships
    };
};

const generateSingleRelationshipTest = function(description, fromRaw, toRaw, polarity, polarityStart) {
    const result = generateCausalRelationship(fromRaw, toRaw, polarity, polarityStart);
    return {
        prompt: prompt,
        problemStatement: problemStatement,
        backgroundKnowledge: result.english,
        description: description,
        expectedRelationships: [result.relationship]
    };
};

const generateSingleFeedbackLoopTest = function(offset, numVars, polarity) {
    if (["+", "-"].indexOf(polarity) < 0)
        throw "Invalid polarity must be + or - you supplied " + polarity;

    if (offset + numVars >= nouns.length) {
        throw "Bad variable selection -- you'd select past the end of the list of variables";
    }
    
    const kind = polarity === "+" ? "reinforcing" : "balancing";
    const variables = nouns.slice(offset, offset+numVars);
    const response = generateFeedbackLoop(variables, polarity);
    return {
        prompt: prompt,
        problemStatement: problemStatement,
        description: "extract a " + kind + " feedback loop with " + numVars + " variables",
        expectedRelationships: response.relationships,
        backgroundKnowledge: response.english
    }
};

const generateSingleFeedbackLoopTests = function(minNumVars, maxNumVars, polarity) {
    let cases = [];
    for (let i=minNumVars; i <= maxNumVars; ++i) {
        cases.push(generateSingleFeedbackLoopTest(i, i, polarity));
    }
    return cases;
};

const generateMultipleFeedbackLoopTest = function(polarityVec, numVarsVec) {
    if (polarityVec.length != numVarsVec.length)
        throw "Invalid specification to generateMultipleFeedbackLoopTest polarityVec and numVarsVec must be equal length";

    let causalText = "";
    let relationships = [];

    let offset = 0;
    for (let loop=0; loop < polarityVec.length; ++loop) {
        const variables = nouns.slice(offset, offset + numVarsVec[loop]);
        offset += numVarsVec[loop] - 1;

        let response = generateFeedbackLoop(variables, polarityVec[loop]);
        causalText += " " + response.english;
        relationships = relationships.concat(response.relationships);
    }

    return {
        prompt: prompt,
        problemStatement: problemStatement,
        description: "extract " + polarityVec.length + " feedback loops with [" + polarityVec.join(", ") + "] polarities",
        expectedRelationships: relationships,
        backgroundKnowledge: causalText.trim(),
    }
};

export const groups = {
    "singleRelationshipTests": [
        generateSingleRelationshipTest("extract a reinforcing relationship up", nouns[0], nouns[1], "+", "up"),
        generateSingleRelationshipTest("extract a reinforcing relationship down", nouns[0], nouns[1], "+", "down"),
        generateSingleRelationshipTest("extract a balancing relationship up", nouns[0], nouns[1], "-", "up"),
        generateSingleRelationshipTest("extract a balancing relationship down", nouns[0], nouns[1], "-", "down")
    ],
    "singleFeedbackLoopTests": [
        //7 feedback loops from size 2 to size 8 with positive polarity
        ...generateSingleFeedbackLoopTests(2, 8, "+"),
        ...generateSingleFeedbackLoopTests(2, 8, "-")
    ],
    "multipleFeedbackLoopTests": [
        //two feedback loops both positive, with 3 and 6 variables
        generateMultipleFeedbackLoopTest(["+", "+"], [3,6]),
        generateMultipleFeedbackLoopTest(["-", "+"], [3,6]),
        generateMultipleFeedbackLoopTest(["+", "+", "-"], [5,2,4]),
        generateMultipleFeedbackLoopTest(["-", "-", "+"], [5,2,4]),
        generateMultipleFeedbackLoopTest(["-", "+", "+", "+", "-"], [3,5,6,2,6]),
        generateMultipleFeedbackLoopTest(["-", "+", "+", "-", "-"], [3,5,6,2,6])
    ]
}