/**
 * A closed-option judge for the evals, shared by the categories that need one.
 *
 * It is the same call the existing judge-graded categories make inline (modelScoping,
 * policyGuidance, modelBuildingSteps): the configured eval model, structured output against a zod
 * schema. Two conventions come with it:
 *   - extract, don't grade. A category asks the judge only what the engine *said*, choosing from
 *     options the category supplies; the category's own code compares that with the answer key,
 *     which the judge is never shown.
 *   - one judge call per response. Categories split a response into one test per criterion
 *     (sibling tests share one engine generation), and those siblings share one judge reading
 *     through this cache, as policyGuidance's judgeResultCache does.
 *
 * @module utilities/judge
 */

import { LLMWrapper } from '../../utilities/LLMWrapper.js';

const cache = new Map();

/** How many times a judge call is tried before its failure is reported. */
export const JUDGE_ATTEMPTS = 3;

let reader = null;

/**
 * Replace the eval model with a function of the schema (and messages) for every reading, or put the
 * eval model back with null. The null-agent floors use it to read every answer as the most
 * assertive or the most noncommittal one; nothing else should.
 * @param {function(import('zod').ZodType, Array<Object>): Object|null} fn
 */
export const setReader = function(fn) {
    reader = fn;
    cache.clear();
};

/**
 * Ask the eval model to extract structured facts from a response.
 *
 * @param {string} cacheKey Identifies the reading; tests that would ask the same question of the
 *   same response pass the same key and share one call. A failed call is not cached.
 * @param {Array<{role: string, content: string}>} messages The judge prompt
 * @param {import('zod').ZodType} schema The structured output the judge must return
 * @returns {Promise<Object>} The parsed reading
 */
export const extract = async function(cacheKey, messages, schema) {
    if (!cache.has(cacheKey)) {
        const reading = (async () => {
            if (reader) return reader(schema, messages);
            // A provider error or a malformed reply is retried: a judge failure should be rare enough
            // that it never decides a test.
            let lastError;
            for (let attempt = 1; attempt <= JUDGE_ATTEMPTS; attempt++) {
                try {
                    const llm = new LLMWrapper({ underlyingModel: LLMWrapper.EVAL_MODEL });
                    const { underlyingModel } = llm.getLLMParameters();
                    const response = await llm.createChatCompletion(messages, underlyingModel, schema);
                    return JSON.parse(response.content);
                } catch (error) {
                    lastError = error;
                }
            }
            throw lastError;
        })();
        cache.set(cacheKey, reading);
        reading.catch(() => cache.delete(cacheKey));
    }
    return cache.get(cacheKey);
};

/**
 * Forget every cached reading. For tests.
 */
export const clearJudgeCache = function() {
    cache.clear();
};
