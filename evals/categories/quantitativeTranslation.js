import pluralize from 'pluralize';
import numberToWords from 'number-to-words';

//generic prompt and problem statement used for all tests
const prompt = "Please give me a model which includes all causal relationships in the background information.";
const problemStatement = "I'm trying to do causal discovery, and extract every cause and effect relationship from the information I give you.";

//random variable names to pick from
const nouns = [ "frimbulator",  "whatajig", "balack", "whoziewhat", "funkado", "maxabizer", "marticatene", "reflupper", "exeminte", "oc", "proptimatire", "priary", "houtal", "poval", "auspong", "dominitoxing", "outrance", "illigent", "yelb", "traze", "pablanksill", "posistorather", "crypteral", "oclate", "reveforly", "yoffa", "buwheal", "geyflorrin", "ih", "aferraron", "paffling", "pershipfulty", "copyring", "dickstonyx", "bellignorance", "hashtockle", "succupserva", "relity", "hazmick", "ku", "obvia", "unliescatice", "gissorm", "phildiscals", "loopnova", "hoza", "arinterpord", "burgination", "perstablintome", "memostorer", "baxtoy", "hensologic", "estintant", "perfecton", "raez", "younjuring"];

const generateTest = function(name, timeUnit, stocks) {
    let english = "";
    stocks.forEach((stock) => {
        let stockEnglish = "I start with " + numberToWords.toWords(stock.initialValue) + " " + pluralize(stock.name) + ".";

        if (stock.inflows) {
            stock.inflows.forEach((f)=> {
                let flowEnglish = "Each " + timeUnit + " ";
                if ("fixed" in f) {
                    flowEnglish += numberToWords.toWords(f.fixed) + " " + pluralize(stock.name) + " are added to my collection of " + pluralize(stock.name) + ".";
                } else {
                    flowEnglish += "my collection of " + pluralize(stock.name) + " increases by " + (f.rate * 100) + "%";

                    if (f.of !== stock.name)
                        flowEnglish += " of how ever many " + f.of + " I currently have";

                    flowEnglish += ".";
                }

                stockEnglish += " " + flowEnglish;
            });
        }

        if (stock.outflows) {
            stock.outflows.forEach((f)=> {
                let flowEnglish = "Each " + timeUnit + " ";
                if ("fixed" in f) {
                    flowEnglish += numberToWords.toWords(f.fixed) + " " + pluralize(stock.name) + " are removed from my collection of " + pluralize(stock.name) + ".";
                } else {
                    flowEnglish += "my collection of " + pluralize(stock.name) + " decreases by " + (f.rate * 100) + "%";

                    if (f.of !== stock.name)
                        flowEnglish += " of how ever many " + f.of + " I currently have";

                    flowEnglish += ".";
                }

                stockEnglish += " " + flowEnglish;
            });
        }

        english += " " + stockEnglish;
    });

    return {
        name: name,
        prompt: prompt,
        additionalParameters: {
            problemStatement: problemStatement,
            backgroundKnowledge: english.trim(),
        },
        expectations: {
            timeUnit: timeUnit,
            stocks: stocks
        }
    };
};

const extractStocks = function(generatedModel) {
    return (generatedModel.variables || []).filter((variable) => {
        return variable.type === 'stock';
    });
};

const extractFlow = function(flowSpec, possibleNames,  generataedModel) {
    return (generatedModel.variables || []).find((variable) => {
        if (variable.type !== 'flow')
            return false;

        let foundName = false;
        for (const possibleName of possibleNames) {
            if (possibleName.toLowerCase() === variable.name.toLowerCase()) {
                foundName = true;
                break;
            }
        }

        if (!foundName)
            return false;
        
        //if we are looking for a rate... 
        if (flowSpec.rate) {
            return variable.equation.includes("*"); //look for something with a * in its equation
        } else { //then its fixed!
            return variable.equation.includes(flowSpec.fixed); //otherwise look for the number in the equation
        }
    })
};

const compareNames = function(aiName, groundTruthName) {
    const value =  aiName.toLowerCase().includes(groundTruthName.toLowerCase());
    //console.log("Comparing names... " + aiName + " " + groundTruthName + " " + value);
    return value;
};

export const evaluate = function(generatedResponse, groundTruth) {
    const generatedModel = generatedResponse?.model || {};
    const groundTruthStocks = groundTruth.stocks;

    const comparator = function(a, b) {
        if ( a.name < b.name ){
            return -1;
        }
        if ( a.name > b.name ){
            return 1;
        }
        return 0;
    };

    const stockEqualityGTComparatorGenerator = function(groundTruth) {
        return (ai) => {
            return compareNames(ai.name, groundTruth.name);
        };
    };

    const stockEqualityAIComparatorGenerator = function(ai) {
        return (groundTruth) => {
            return compareNames(ai.name, groundTruth.name);
        };
    };

    const failures = []; //type, details
    const stocks = extractStocks(generatedModel); //get all the stocks

    const sortedAIStocks = stocks.sort(comparator); //sort for comparison purposes by name
    const sortedTruthStocks = groundTruthStocks.sort(comparator);

    const removed = sortedTruthStocks.filter((element) => { return !sortedAIStocks.some(stockEqualityGTComparatorGenerator(element))});
    const added = sortedAIStocks.filter((element) => { return !sortedTruthStocks.some(stockEqualityAIComparatorGenerator(element))});

    const addedStr = added.map((r)=>{return r.name}).join(", ");
    const removedStr = removed.map((r)=>{return r.name}).join(", ");
    const groundTruthStr = sortedTruthStocks.map((r)=>{return r.name}).join(", ");

    if (!compareNames(generatedModel.specs.timeUnits, groundTruth.timeUnit)) {
        failures.push({
            type: "Incorrect time unit discovered",
            details: "Incorrect time unit discovered. Expected " + generatedModel.specs.timeUnits + " to be " + groundTruth.timeUnit
        });
    }

    if (added.length > 0) {
        failures.push({
            type: "Fake stock found",
            details: "Fake stock found\n" + addedStr + "\nGround Truth Stocks Are\n" + groundTruthStr
        });
    }
    
    if (removed.length > 0) {
        failures.push({
            type: "Real stocks not found",
            details: "Real stocks not found\n" + removedStr + "\nGround Truth Stocks Are\n" + groundTruthStr
        });
    }

    for (const groundTruthStock of sortedTruthStocks) {
        let aiStock = sortedAIStocks.find(stockEqualityGTComparatorGenerator(groundTruthStock));
        if (!aiStock)
            continue; //some error in the test itself

        if (aiStock.equation !== groundTruthStock.initialValue.toString()) {
            failures.push({
                type: "Incorrect initial value discovered",
                details: "Incorrect initial value discovered. Expected " + aiStock.equation + " to be " + groundTruthStock.initialValue.toString()
            });
        }

        if (groundTruth.inflows) {
            if (aiStock.inflows.length != groundTruthStock.inflows.length) {
                failures.push({
                    type: "Incorrect number of inflows discovered",
                    details: "Incorrect number of inflows discovered. Expected " + aiStock.inflows.length + " to be " + groundTruthStock.inflows.length
                });
            } else {
                groundTruth.inflows.forEach((f) => {
                    const foundFlow = extractFlow(f, aiStock.inflows, generatedModel);
                    if (!foundFlow) {
                        failures.push({
                            type: "Failed to find flow matching specification",
                            details: "Failed to find flow matching specification. Expected to find a flow with specification " + JSON.stringify(f)
                        });
                    }
                });
            }
        }

        if (groundTruth.outflows) {
            if (aiStock.outflows.length != groundTruthStock.outflows.length) {
                failures.push({
                    type: "Incorrect number of outflows discovered",
                    details: "Incorrect number of outflows discovered. Expected " + aiStock.outflows.length + " to be " + groundTruthStock.outflows.length
                });
            } else {
                groundTruth.outflows.forEach((f) => {
                    const foundFlow = extractFlow(f, aiStock.outflows, generatedModel);
                    if (!foundFlow) {
                        failures.push({
                            type: "Failed to find flow matching specification",
                            details: "Failed to find flow matching specification. Expected to find a flow with specification " + JSON.stringify(f)
                        });
                    }
                });
            }
        }
    }

    return failures 
};

export const groups = {
    "singleStock": [
        generateTest("Extract a single stock with one flow", "day", [
            { 
                name: nouns[0], 
                initialValue: 20,
                inflows: [
                    { rate: 0.02, of: nouns[0] }
                ]
            }
        ]),
        generateTest("Extract a single stock with two flows", "week", [
            { 
                name: nouns[0], 
                initialValue: 100,
                inflows: [
                    { rate: 0.05, of: nouns[0] }
                ], 
                outflows: [
                    { fixed: 5 }
                ]
            }
        ])
    ], 
    "twoStock": [
        generateTest("Extract a two stock system", "year", [
            { 
                name: nouns[1], 
                initialValue: 100,
                inflows: [
                    { rate: 0.05, of: nouns[1] }
                ], 
                outflows: [
                    { rate: 3, of: nouns[2] }
                ]
            }, { 
                name: nouns[2], 
                initialValue: 200,
                inflows: [
                    { rate: 0.05, of: nouns[1] }
                ], 
                outflows: [
                    { rate: 0.03, of: nouns[2] }
                ]
            }
        ])
    ], 
     "fiveStock": [
        generateTest("Extract a five stock system", "year", [
            { 
                name: nouns[1], 
                initialValue: 100,
                inflows: [
                    { rate: 0.05, of: nouns[1] }
                ], 
                outflows: [
                    { fixed: 3 }
                ]
            }, { 
                name: nouns[2], 
                initialValue: 200,
                inflows: [
                    { rate: 0.05, of: nouns[1] }
                ], 
                outflows: [
                    { rate: 0.03, of: nouns[2] }
                ]
            }, { 
                name: nouns[3], 
                initialValue: 200,
                inflows: [
                    { rate: 0.05, of: nouns[2] }
                ], 
                outflows: [
                    { rate: 0.03, of: nouns[3] }
                ]
            }, { 
                name: nouns[4], 
                initialValue: 12,
                inflows: [
                    { rate: 0.05, of: nouns[3] }
                ], 
                outflows: [
                    { rate: 0.03, of: nouns[5] }
                ]
            }, { 
                name: nouns[5], 
                initialValue: 88,
                inflows: [
                    { rate: 0.05, of: nouns[4] }
                ], 
                outflows: [
                    { rate: 0.03, of: nouns[3] }
                ]
            }
        ])
    ]
};