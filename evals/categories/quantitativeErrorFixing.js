/**
 * Returns the description for this category
 * @returns {string} The description describing this category
 */
export const description = () => {
    return `The quantitative error fixing test evaluates an engine's ability to identify and fix formulation errors
in system dynamics models. The engine is given a model with known errors and must generate a corrected model
along with an explanation of the errors, why they were errors, and how they were fixed.`;
}

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import utils from '../../utilities/utils.js';
import { LLMWrapper } from '../../utilities/LLMWrapper.js';
import { z } from 'zod';
import { validateEvaluationResult } from '../evaluationSchema.js';
import { compareNames, findVariable, equationMatchesThroughHelpers } from '../utilities/modelDiff.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const prompt = `Please analyze the given model for formulation errors. Please take into account the style of existing formulations i.e. pipeline delays vs. exponential delays etc. If the given model contains formulation errors please fix each formulation error you identify and generate an explanation that contains a listing of all errors, why they were an error, and how you fixed them.  Do not add any new variables, or change the name of any existing variables.  Do not add new feedback mechanisms to this model.  Correcting an erroneous equation may require it to reference different existing variables than it does now, and may leave a variable that existed only because of the error unused; both are allowed.`;

/**
 * Generate a test case for a COVID-19 model with errors
 * @param {string} name - The name of the test case
 * @param {string} errorFileName - The filename of the error model (without path)
 * @returns {object} Test case object
 */
const generateCovidTest = function(name, errorFileName, errorExplanations) {
    // Load the correct model
    const correctModelPath = path.join(__dirname, 'quantitativeErrorFixingData', 'covid_correct.json');
    const correctModel = JSON.parse(fs.readFileSync(correctModelPath, 'utf8'));

    // Load the error model
    const errorModelPath = path.join(__dirname, 'quantitativeErrorFixingData', errorFileName);
    const errorModel = JSON.parse(fs.readFileSync(errorModelPath, 'utf8'));

    // Define problem statement
    const problemStatement = "I'm building a COVID-19 epidemiological model and I need to ensure the formulations I have given you are correct.";

    return {
        name: name,
        prompt: prompt,
        currentModel: errorModel.model,
        additionalParameters: {
            problemStatement: problemStatement
        },
        expectations: {
            correctModel: correctModel.model,
            errorExplanations: errorExplanations        
        }
    };
};

/**
 * Check if error explanations are present in the generated explanation using LLM
 * @param {string} explanation - The generated explanation text
 * @param {Array} errorExplanations - Array of expected error explanations
 * @returns {Array} Array of failures for errors not explained
 */
const checkErrorExplanations = async function(explanation, errorExplanations) {
    const failures = [];

    if (!explanation) {
        failures.push({
            type: "Missing explanation",
            details: "The response should include an explanation of the errors found and how they were fixed"
        });
        return failures;
    }

    // Create LLMWrapper instance configured for evaluation purposes
    const llm = new LLMWrapper({
        underlyingModel: LLMWrapper.EVAL_MODEL
    });

    try {
        // Build a list of all expected errors
        const errorList = errorExplanations.map((expectedError, index) => {
            const errorName = expectedError.name.replace(/_/g, ' ');
            return `${index + 1}. The model had an error in the variable "${errorName}". The error was: ${expectedError.problem}`;
        }).join('\n');

        const messages = [
            {
                role: 'system',
                content: 'Your job is to determine which errors from a given list are explained in the provided text. You will be given an explanation text from a model debugging session, and a numbered list of expected errors. For each error in the list, determine if it is clearly identified and explained in the text.'
            },
            {
                role: 'user',
                content: `Here is the explanation to analyze:\n\n${explanation}\n\nBased on the explanation above, which of the following errors are identified and explained?\n\n${errorList}`
            }
        ];

        // Define structured output schema using Zod
        const structuredOutputSchema = z.object({
            explainedErrorNumbers: z.array(z.number()).describe('Array of error numbers (1-indexed) that are clearly identified and explained in the text')
        });

        // Get LLM parameters
        const { underlyingModel } = llm.getLLMParameters();

        // Call the LLM with structured output
        const response = await llm.createChatCompletion(
            messages,
            underlyingModel,
            structuredOutputSchema
        );

        // Parse the structured response
        let explainedErrors = [];
        try {
            const parsedContent = JSON.parse(response.content);
            explainedErrors = parsedContent.explainedErrorNumbers || [];
        } catch (parseError) {
            failures.push({
                type: "Evaluation error",
                details: `Error parsing LLM structured output: ${parseError.message}. Response was: ${response.content}`
            });
        }

        // Check which errors were not explained
        errorExplanations.forEach((expectedError, index) => {
            const errorNumber = index + 1;
            if (!explainedErrors.includes(errorNumber)) {
                const errorName = expectedError.name.replace(/_/g, ' ');
                failures.push({
                    type: "Error not explained",
                    details: `The explanation should identify and explain the error in "${errorName}": ${expectedError.problem}`
                });
            }
        });
    } catch (error) {
        failures.push({
            type: "Evaluation error",
            details: `Error checking error explanations: ${error.message}`
        });
    }

    return failures;
};

/**
 * Evaluate the generated model against the correct model
 */
export const evaluate = async function(generatedResponse, groundTruth) {
    const generatedModel = generatedResponse?.model || {};
    const correctModel = groundTruth.correctModel;

    const failures = [];

    // Check if the model exists
    if (!generatedModel || !generatedModel.variables) {
        failures.push({
            type: "Model structure missing",
            details: "The generated response does not contain a valid model structure with variables"
        });
        return validateEvaluationResult(failures);
    }

    const generatedVars = generatedModel.variables || [];
    const correctVars = correctModel.variables || [];

    // Check that all correct variables are present
    for (const correctVar of correctVars) {
        const generatedVar = findVariable(generatedVars, correctVar.name);

        if (!generatedVar) {
            failures.push({
                type: "Missing variable",
                details: `Variable "${correctVar.name}" is missing from the generated model`
            });
            continue;
        }

        // Check type consistency
        if (generatedVar.type !== correctVar.type) {
            failures.push({
                type: "Incorrect variable type",
                details: `Variable "${correctVar.name}" should be type "${correctVar.type}" but is "${generatedVar.type}"`
            });
            continue;
        }


        // Check equation correctness for variables with equations
        if (correctVar.equation) {
            if (!equationMatchesThroughHelpers(generatedVar, correctVar, generatedVars, correctVars)) {
                failures.push({
                    type: "Incorrect equation",
                    details: `Variable "${correctVar.name}" has incorrect equation.\nExpected: ${correctVar.equation}\nGot: ${generatedVar.equation}`
                });
                continue;
            }
        }

        // For stocks, check inflows and outflows
        if (correctVar.type === 'stock') {
            const correctInflows = correctVar.inflows || [];
            const generatedInflows = generatedVar.inflows || [];

            for (const inflow of correctInflows) {
                if (!generatedInflows.some(i => compareNames(i, inflow))) {
                    failures.push({
                        type: "Missing inflow",
                        details: `Stock "${correctVar.name}" is missing inflow "${inflow}"`
                    });
                }
            }

            const correctOutflows = correctVar.outflows || [];
            const generatedOutflows = generatedVar.outflows || [];

            for (const outflow of correctOutflows) {
                if (!generatedOutflows.some(o => compareNames(o, outflow))) {
                    failures.push({
                        type: "Missing outflow",
                        details: `Stock "${correctVar.name}" is missing outflow "${outflow}"`
                    });
                }
            }
        }

        // Check units consistency
        if (correctVar.units && generatedVar.units !== correctVar.units) {
            failures.push({
                type: "Incorrect units",
                details: `Variable "${correctVar.name}" should have units "${correctVar.units}" but has "${generatedVar.units}"`
            });
            continue;
        }
    }

    // Check if explanation mentions the expected errors using LLM
    const errorExplanations = groundTruth.errorExplanations || [];
    if (errorExplanations.length > 0 && failures.length === 0) {
        const explanation = generatedResponse?.supportingInfo?.explanation || '';
        const explanationFailures = await checkErrorExplanations(explanation, errorExplanations);
        failures.push(...explanationFailures);
    }

    return validateEvaluationResult(failures);
};

/**
 * Returns the methodology for this category: how its tests are built and run, what the evaluator
 * checks, and how those checks combine into a verdict. Each `criteria[].name` is the exact failure
 * `type` {@link evaluate} records when that criterion is not met. Rendered by the documentation
 * site on every test page.
 * @returns {{howItWorks: Array<string>, criteria: Array<{name: string, description: string}>, scoring: string}}
 */
export const methodology = () => ({
    howItWorks: [
        `Debugging someone else's formulations is ordinary modeling work, and it is testable because the correct model can be written down first. A single correct COVID epidemiological model is the reference; each test hands the engine a copy of it with specific formulation errors injected, and asks for the errors to be found, fixed, and explained — what was wrong, why it was wrong, and how it was fixed.`,
        `The prompt is deliberately constraining: respect the existing formulation style (pipeline versus exponential delays and so on), add no variables, rename nothing, and add no new feedback mechanisms; an erroneous equation may be rewired to reference different existing variables. Without that, an engine could "fix" the model by rebuilding it, and the repair could not be told apart from a rewrite.`,
        `The three groups are the three families of injected error: delay formulations, lookup (graphical function) formulations, and sum/aggregation formulations. Each test's expectations carry both the correct model and the list of errors that were injected, each naming a variable and stating the problem with it.`,
        `Grading compares the returned model against the correct model variable by variable. Every variable in the correct model must be present, with the same type; where the correct variable has an equation, the returned equation must match; stocks must retain every inflow and outflow the correct model gives them; and where the correct variable declares units, the returned units must match. Variable and flow names are compared ignoring case and whitespace, so formatting differences are not treated as errors.`,
        `Equations are compared textually, because an equation's form is part of what this category measures: DELAY3(Infection, tau) and Exposed/tau compute similar things, and only one of them is the pipeline delay the prompt asked to preserve. Whitespace and case are ignored, and four allowances keep bookkeeping out of the score — the same number written two ways (1.7e+07 and 17000000) counts as equal, so does safe division (//) for plain division (/), so does a plain sum whose terms are listed in a different order, and so does an equation that only names a helper auxiliary the correct model lacks, which is compared through that helper's equation.`,
        `Only if the model is entirely correct does grading go on to the explanation. The engine's explanation and a numbered list of the injected errors go to a fixed judge model (the configured eval model, independent of the engine under test) in a structured-output call that returns which errors the text identifies and explains — exact wording is not required, but the variable must be named and the nature of the error explained. A silent repair therefore does not pass: the engine has to be able to say what was wrong.`
    ],
    criteria: [
        { name: 'Model structure missing', description: 'The response carried no model with variables, so there is nothing to compare against the correct model.' },
        { name: 'Missing variable', description: 'A variable the correct model contains is absent from the returned model. Recorded once per variable.' },
        { name: 'Incorrect variable type', description: 'A variable came back as the wrong kind — a stock turned into an auxiliary, say. Recorded once per variable.' },
        { name: 'Incorrect equation', description: 'A variable’s equation does not match the correct model’s, quoting both. This is where an unfixed error, or a fix that broke something else, shows up.' },
        { name: 'Missing inflow', description: 'A stock lost an inflow the correct model gives it. Recorded once per flow.' },
        { name: 'Missing outflow', description: 'A stock lost an outflow the correct model gives it. Recorded once per flow.' },
        { name: 'Incorrect units', description: 'A variable’s units do not match the correct model’s.' },
        { name: 'Missing explanation', description: 'The model came back correct but with no explanation text to assess.' },
        { name: 'Error not explained', description: 'An injected error was not identified and explained in the engine’s prose. Recorded once per error the judge did not find, naming the variable and the problem.' },
        { name: 'Evaluation error', description: 'The judge call or the parsing of its structured output failed. Recorded as a failure rather than passed silently, so a broken judge never reads as a good answer.' }
    ],
    scoring: `The model must match the correct model and the explanation must account for every injected error; any single failure fails the test. Structural checks run first and per variable, so one badly-handled variable reports its first problem and moves on. The explanation is only judged when the model is fully correct — a test that fails structurally reports structural failures alone, and the absence of explanation failures there does not mean the explanation was good.`
});

export const groups = {
    "covidDelayErrors": [
        generateCovidTest("COVID-19 delay error 1", "COVID_delay_err1.json",
            [
                { name: "total_incubation", problem: "Should use DELAY3 with the 'Infection' flow as input, not the 'Exposed population' stock divided by a time constant."}
            ]
        ),
        generateCovidTest("COVID-19 delay error 2", "COVID_delay_err2.json",
            [
                { name: "developing_symptoms", problem: "Should use the flows 'Incubation + Influx of presymptomatic infectious people from abroad' as input to DELAY3, not the stock 'Presymptomatic infectious' divided by a time constant."}
            ]
        ),
        generateCovidTest("COVID-19 delay error 4", "COVID_delay_err4.json",
            [
                { name: "recovery_without_symptoms", problem: "Should use DELAY3 with the 'Asymptomatic incubation' flow as input, not the 'Asymptomatic infectious' stock divided by a time constant."}
            ]
        )
    ],
    "covidLookupErrors": [
        generateCovidTest("COVID-19 lookup error 1", "COVID_lookup_err1.json",
            [
                { name: "influx_of_presymptomatic_infectious_people_from_abroad", problem: "The graphical function should use TIME as an input, not DT (DT)."}
            ]
        ),
        generateCovidTest("COVID-19 lookup error 2", "COVID_lookup_err2.json",
            [
                { name: "social_distancing_measures", problem: "The graphical function should use TIME as an input, not DT (DT)."}
            ]
        )
    ],
    "covidSumErrors": [
        generateCovidTest("COVID-19 sum error 1", "COVID_sum_err1.json",
            [
                { name: "total_population", problem: "Total population should be an auxiliary/converter variable that sums the population stocks, not a stock."}
            ]
        ),
        generateCovidTest("COVID-19 sum error 2", "COVID_sum_err2.json",
            [
                { name: "infectious_population", problem: "Infectious population should be an auxiliary/converter variable that sums the three infectious stocks, not a stock."}
            ]
        )
    ]
};
