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

const generateSingleRelationshipTest = function(name, fromRaw, toRaw, polarity, polarityStart) {
    const result = generateCausalRelationship(fromRaw, toRaw, polarity, polarityStart);
    return {
        name: name,
        prompt: prompt,
        additionalParameters: {
            problemStatement: problemStatement,
            backgroundKnowledge: result.english,
        },
        expectations: [result.relationship]
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
        name: "extract a " + kind + " feedback loop with " + numVars + " variables",
        prompt: prompt,
        additionalParameters: {
            problemStatement: problemStatement,
            backgroundKnowledge: response.english
        },
        expectations: response.relationships,
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
        name: "extract " + polarityVec.length + " feedback loops with [" + polarityVec.join(", ") + "] polarities",
        prompt: prompt,
        additionalParameters: {
            problemStatement: problemStatement,
            backgroundKnowledge: causalText.trim(),
        },
        expectations: relationships,
    }
};

export const evaluate = function(generatedResponse, groundTruth) {
    const fromAI = generatedResponse.model?.relationships || [];
    const failures = [];
    
    const stringifyRelationship = function(r) {
        return r.from + " --> (" + r.polarity + ") " + r.to;
    };

    const comparator = function(a, b) {
        if ( a.textRepresentation < b.textRepresentation ){
            return -1;
        }
        if ( a.textRepresentation > b.textRepresentation ){
            return 1;
        }
        return 0;
    };

    const relationshipEqualityComparatorGenerator = function(a) {
        return (b) => {
            return (a.from.toLowerCase() === b.from.toLowerCase() && 
                a.to.toLowerCase() === b.to.toLowerCase()); 
        };
    };

    const cleanedSortedAI = fromAI.map((r)=> {
        delete r.reasoning; //these attributes aren't in ground truth
        delete r.polarityReasoning; //these attributes aren't in ground truth
        r.textRepresentation = stringifyRelationship(r);
        return r;
    }).sort(comparator);

    const sortedGroundTruth = groundTruth.map((r)=> {
        r.textRepresentation = stringifyRelationship(r);
        return r;
    }).sort(comparator);

    const removed = sortedGroundTruth.filter((element) => { return !cleanedSortedAI.some(relationshipEqualityComparatorGenerator(element))});
    const added = cleanedSortedAI.filter((element) => { return !sortedGroundTruth.some(relationshipEqualityComparatorGenerator(element))});

    const addedStr = added.map((r)=>{return r.textRepresentation}).join(", ");
    const removedStr = removed.map((r)=>{return r.textRepresentation}).join(", ");
    const groundTruthStr = sortedGroundTruth.map((r)=>{return r.textRepresentation}).join(", ");

    if (added.length > 0) {
        failures.push({
            type: "Fake relationships found",
            details: "Fake relationships found\n" + addedStr + "\nGround Truth\n" + groundTruthStr
        });
    }
    
    if (removed.length > 0) {
        failures.push({
            type: "Real relationships not found",
            details: "Real relationships not found\n" + removedStr + "\nGround Truth\n" + groundTruthStr
        });
    }

    for (const groundTruthRelationship of sortedGroundTruth) {
        let aiRelationship = cleanedSortedAI.find(relationshipEqualityComparatorGenerator(groundTruthRelationship));
        if (aiRelationship && aiRelationship.polarity !== groundTruthRelationship.polarity) {
            failures.push({
                type: "Incorrect polarity discovered",
                details: "Incorrect polarity discovered. Expected " + aiRelationship.polarity + " to be " + groundTruthRelationship.polarity
            });
        }
    }

    return failures 
};


export const groups = {
    "singleRelationship": [
        generateSingleRelationshipTest("extract a reinforcing relationship up", nouns[0], nouns[1], "+", "up"),
        generateSingleRelationshipTest("extract a reinforcing relationship down", nouns[0], nouns[1], "+", "down"),
        generateSingleRelationshipTest("extract a balancing relationship up", nouns[0], nouns[1], "-", "up"),
        generateSingleRelationshipTest("extract a balancing relationship down", nouns[0], nouns[1], "-", "down")
    ],
    "singleFeedbackLoop": [
        //7 feedback loops from size 2 to size 8 with positive polarity
        ...generateSingleFeedbackLoopTests(2, 8, "+"),
        ...generateSingleFeedbackLoopTests(2, 8, "-")
    ],
    "multipleFeedbackLoops": [
        //two feedback loops both positive, with 3 and 6 variables
        generateMultipleFeedbackLoopTest(["+", "+"], [3,6]),
        generateMultipleFeedbackLoopTest(["-", "+"], [3,6]),
        generateMultipleFeedbackLoopTest(["+", "+", "-"], [5,2,4]),
        generateMultipleFeedbackLoopTest(["-", "-", "+"], [5,2,4]),
        generateMultipleFeedbackLoopTest(["-", "+", "+", "+", "-"], [3,5,6,2,6]),
        generateMultipleFeedbackLoopTest(["-", "+", "+", "-", "-"], [3,5,6,2,6])
    ]
}