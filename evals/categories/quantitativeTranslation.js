/**
 * Returns the description for this category
 * @returns {string} The description describing this category
 */
export const description = () => {
    return `The quantitative causal translation test evaluates an LLM’s ability to convert quantitative stock-and-flow 
model descriptions with gibberish variables into simulating models by identifying underlying causal relationships 
involving fixed, proportional, and interdependent flows.`;
} 

import pluralize from 'pluralize';
import numberToWords from 'number-to-words';
import utils from '../../utilities/utils.js';

//generic prompt and problem statement used for all tests
const prompt = "Please give me a model which includes all causal relationships in the background information.";
const problemStatement = "I'm trying to do causal discovery, and extract every cause and effect relationship from the information I give you.";

//random variable names to pick from
const nouns = utils.evalsGibberishNouns;

const generateTest = function(name, timeUnit, stocks) {
    // Generate more natural, story-like descriptions
    const contexts = [
        "In my business", "At the facility", "In our organization", "During operations", 
        "At the warehouse", "In the system", "Throughout the process"
    ];
    
    const initialDescriptions = [
        "we begin with", "there are initially", "we start the period with", 
        "the baseline inventory shows", "our records indicate", "we have on hand"
    ];
    
    const inflowDescriptions = [
        "gets replenished by", "receives new additions of", "grows through incoming",
        "benefits from", "increases due to", "gains from", "is enhanced by"
    ];
    
    const outflowDescriptions = [
        "experiences losses of", "has outgoing", "loses", "decreases by",
        "is reduced through", "suffers depletion of", "gets diminished by"
    ];

    let english = contexts[Math.floor(Math.random() * contexts.length)] + ", ";
    
    stocks.forEach((stock, index) => {
        if (index > 0) english += " Meanwhile, ";
        
        const initialDesc = initialDescriptions[Math.floor(Math.random() * initialDescriptions.length)];
        let stockEnglish = initialDesc + " " + numberToWords.toWords(stock.initialValue) + " " + pluralize(stock.name) + ". ";

        if (stock.inflows) {
            stock.inflows.forEach((f)=> {
                const inflowDesc = inflowDescriptions[Math.floor(Math.random() * inflowDescriptions.length)];
                let flowEnglish = "Every " + timeUnit + ", this inventory " + inflowDesc + " ";
                
                if ("fixed" in f) {
                    flowEnglish += "exactly " + numberToWords.toWords(f.fixed) + " new " + pluralize(stock.name);
                } else {
                    const percentage = (f.rate * 100);
                    if (f.of !== stock.name) {
                        flowEnglish += `${percentage}% of the current ${pluralize(f.of)} count`;
                    } else {
                        flowEnglish += `${percentage}% growth relative to its current size`;
                    }
                }
                flowEnglish += ". ";
                stockEnglish += flowEnglish;
            });
        }

        if (stock.outflows) {
            stock.outflows.forEach((f)=> {
                const outflowDesc = outflowDescriptions[Math.floor(Math.random() * outflowDescriptions.length)];
                let flowEnglish = "Simultaneously, each " + timeUnit + " the stock " + outflowDesc + " ";
                
                if ("fixed" in f) {
                    flowEnglish += "a constant " + numberToWords.toWords(f.fixed) + " " + pluralize(stock.name);
                } else {
                    const percentage = (f.rate * 100);
                    if (f.of !== stock.name) {
                        flowEnglish += `${percentage}% of whatever ${pluralize(f.of)} are currently available`;
                    } else {
                        flowEnglish += `${percentage}% of its current amount`;
                    }
                }
                flowEnglish += ". ";
                stockEnglish += flowEnglish;
            });
        }

        english += stockEnglish;
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

const extractFlow = function(flowSpec, possibleNames,  generatedModel) {
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
            // Check that the equation has multiplication AND contains the rate value
            const hasMultiplication = variable.equation.includes("*");
            const rateString = flowSpec.rate.toString();
            const hasRate = variable.equation.includes(rateString);
            
            if (hasMultiplication && hasRate) {
                return true;
            }
            
            // If variable has multiplication but not the rate directly,
            // check if any of the causes have an equation equal to the rate
            if (hasMultiplication && !hasRate) {
                //filter all of the relationships to find the relationships where the to is the current variable
                const causeVariableNames = (generatedModel.relationships || []).filter(r => 
                    r.to === variable.name
                ).map(r => r.from); //map those relationships into an array of from variable names (these are the causes)
                
                //take the cause variable names and turn them into full causeVariables
                const causeVariables = causeVariableNames.map(name => {
                    return (generatedModel.variables || []).find(v => v.name === name);
                }).filter(v => v !== undefined); // Filter out any undefined variables
                
                //check that one of the cause variables has an equation which is the rate
                return causeVariables.some(cause => cause && cause.equation === rateString);
            }
            
            return false;
        } else { //then its fixed!
            return variable.equation.includes(flowSpec.fixed.toString()); //otherwise look for the number in the equation
        }
    })
};

const compareNames = function(aiName, groundTruthName) {
    const value =  aiName.toLowerCase().includes(groundTruthName.toLowerCase());
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

    if (!generatedModel.specs?.timeUnits || !compareNames(generatedModel.specs.timeUnits, groundTruth.timeUnit)) {
        failures.push({
            type: "Incorrect time unit discovered",
            details: "Incorrect time unit discovered. Expected " + (generatedModel.specs?.timeUnits || "undefined") + " to be " + groundTruth.timeUnit
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

        if (groundTruthStock.inflows) {
            if (!aiStock.inflows || aiStock.inflows.length != groundTruthStock.inflows.length) {
                failures.push({
                    type: "Incorrect number of inflows discovered",
                    details: "Incorrect number of inflows discovered. Expected " + (aiStock.inflows?.length || 0) + " to be " + groundTruthStock.inflows.length
                });
            } else {
                groundTruthStock.inflows.forEach((f) => {
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

        if (groundTruthStock.outflows) {
            if (!aiStock.outflows || aiStock.outflows.length != groundTruthStock.outflows.length) {
                failures.push({
                    type: "Incorrect number of outflows discovered",
                    details: "Incorrect number of outflows discovered. Expected " + (aiStock.outflows?.length || 0) + " to be " + groundTruthStock.outflows.length
                });
            } else {
                groundTruthStock.outflows.forEach((f) => {
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
    "threeStock": [
        generateTest("Extract a three stock linear chain", "month", [
            { 
                name: nouns[6], 
                initialValue: 50,
                inflows: [
                    { fixed: 10 }
                ], 
                outflows: [
                    { rate: 0.2, of: nouns[6] }
                ]
            }, { 
                name: nouns[7], 
                initialValue: 75,
                inflows: [
                    { rate: 0.2, of: nouns[6] }
                ], 
                outflows: [
                    { fixed: 8 }
                ]
            }, { 
                name: nouns[8], 
                initialValue: 120,
                inflows: [
                    { fixed: 8 }
                ], 
                outflows: [
                    { rate: 0.1, of: nouns[8] }
                ]
            }
        ]),
        generateTest("Extract a three stock feedback system", "day", [
            { 
                name: nouns[13], 
                initialValue: 35,
                inflows: [
                    { rate: 0.3, of: nouns[15] }
                ], 
                outflows: [
                    { rate: 0.2, of: nouns[13] }
                ]
            }, { 
                name: nouns[14], 
                initialValue: 90,
                inflows: [
                    { rate: 0.2, of: nouns[13] }
                ], 
                outflows: [
                    { fixed: 12 }
                ]
            }, { 
                name: nouns[15], 
                initialValue: 45,
                inflows: [
                    { fixed: 12 }
                ], 
                outflows: [
                    { rate: 0.3, of: nouns[15] }
                ]
            }
        ]),
        generateTest("Extract a three stock convergent system", "quarter", [
            { 
                name: nouns[20], 
                initialValue: 110,
                inflows: [
                    { rate: 0.06, of: nouns[20] }
                ], 
                outflows: [
                    { fixed: 18 }
                ]
            }, { 
                name: nouns[21], 
                initialValue: 70,
                inflows: [
                    { fixed: 25 }
                ], 
                outflows: [
                    { rate: 0.35, of: nouns[21] }
                ]
            }, { 
                name: nouns[22], 
                initialValue: 95,
                inflows: [
                    { fixed: 18 },
                    { rate: 0.35, of: nouns[21] }
                ], 
                outflows: [
                    { rate: 0.22, of: nouns[22] }
                ]
            }
        ])
    ],
    "fourStock": [
        generateTest("Extract a four stock system with mixed flows", "week", [
            { 
                name: nouns[9], 
                initialValue: 25,
                inflows: [
                    { rate: 0.15, of: nouns[10] }
                ], 
                outflows: [
                    { fixed: 3 }
                ]
            }, { 
                name: nouns[10], 
                initialValue: 40,
                inflows: [
                    { fixed: 5 }
                ], 
                outflows: [
                    { rate: 0.25, of: nouns[10] }
                ]
            }, { 
                name: nouns[11], 
                initialValue: 80,
                inflows: [
                    { rate: 0.1, of: nouns[10] }
                ], 
                outflows: [
                    { rate: 0.05, of: nouns[12] }
                ]
            }, { 
                name: nouns[12], 
                initialValue: 60,
                inflows: [
                    { fixed: 7 }
                ], 
                outflows: [
                    { rate: 0.08, of: nouns[12] }
                ]
            }
        ]),
        generateTest("Extract a four stock branching system", "hour", [
            { 
                name: nouns[16], 
                initialValue: 150,
                inflows: [
                    { fixed: 20 }
                ], 
                outflows: [
                    { rate: 0.4, of: nouns[16] },
                    { rate: 0.1, of: nouns[16] }
                ]
            }, { 
                name: nouns[17], 
                initialValue: 30,
                inflows: [
                    { rate: 0.4, of: nouns[16] }
                ], 
                outflows: [
                    { fixed: 5 }
                ]
            }, { 
                name: nouns[18], 
                initialValue: 65,
                inflows: [
                    { rate: 0.1, of: nouns[16] }
                ], 
                outflows: [
                    { rate: 0.12, of: nouns[19] }
                ]
            }, { 
                name: nouns[19], 
                initialValue: 85,
                inflows: [
                    { fixed: 15 }
                ], 
                outflows: [
                    { rate: 0.18, of: nouns[19] }
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