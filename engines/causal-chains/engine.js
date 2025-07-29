import { promises as fs, statSync } from 'node:fs';
import {exec} from "child_process"
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'url';
import util from 'node:util';

const promiseExec = util.promisify(exec);

import {LLMWrapper} from "../../utils.js";
import logger from "../../logger.js";

const __filename = fileURLToPath(import.meta.url); // get the resolved path to the file
const __dirname = path.dirname(__filename); // get the name of the directory

class Engine {
    constructor() {
    }

    static DEFAULT_MODEL = 'o4-mini';

    static description() {
        return `This engine improves conformance to user instructions about feedback complexity by prompting the LLM to 
focus on chains of relationships, rather then individual links.`
    }

    static supportedModes() {
        // check that the ./causal-chains Go binary exists
        try {
            const stats =  statSync(`${__dirname}/causal-chains`);
            const isExecutable = !!(stats.mode & (fs.constants.S_IXUSR | fs.constants.S_IXGRP | fs.constants.S_IXOTH));

            if (isExecutable) {
                return ["cld"];
            }
        } catch (err) {
            logger.log("Error checking supporting modes on causal-chains...");
            logger.log(err);
            // fine to fallthrough to the return below
        }

        // couldn't find the binary, so we don't support anything
        return undefined;
    }

    additionalParameters() {
        const models = LLMWrapper.MODELS.filter(item => {
            // true if the value starts with "gpt", "o[0-9]", or contains "gemini"
            return /^(gpt|o\d)/.test(item.value) || item.value.includes('gemini');
        });

        return [
            {
                name: "apiKey",
                type: "string",
                required: false,
                uiElement: "password",
                saveForUser: "global",
                label: "OpenAI API Key",
                description: "Leave blank for the default, or your OpenAI API key, e.g. sk-proj-XXXXX",
            },
            {
                name: "googleKey",
                type: "string",
                required: false,
                uiElement: "password",
                saveForUser: "global",
                label: "Google API Key",
                description: "Leave blank for the default, or your Google API key (required for Gemini models)",
            },
            {
                name: "claudeKey",
                type: "string",
                required: false,
                uiElement: "password",
                saveForUser: "global",
                label: "Anthropic Claude API Key",
                description: "Leave blank for the default, or your Anthropic API key (required for Claude models)",
            },
            {
                name: "underlyingModel",
                type: "string",
                defaultValue: Engine.DEFAULT_MODEL,
                required: true,
                options: models,
                uiElement: "combobox",
                saveForUser: "local",
                label: "LLM Model",
                description: "The LLM model that you want to use to process your queries.",
            },
            {
                name: "problemStatement",
                type: "string",
                required: false,
                uiElement: "textarea",
                saveForUser: "local",
                label: "Problem Statement",
                description: "Description of a dynamic issue within the system you are studying that highlights an undesirable behavior over time.",
                minHeight: 50,
                maxHeight: 100,
            },
            {
                name: "backgroundKnowledge",
                type: "string",
                required: false,
                uiElement: "textarea",
                saveForUser: "local",
                label: "Background Knowledge",
                description: "Background information you want the LLM model to consider when generating a diagram for you",
                minHeight: 100,
            },
        ];
    }

    async generate(prompt, currentModel, parameters) {
        const input = {
            prompt: prompt,
            currentModel: currentModel,
            parameters: parameters,
        };

        let tempDir;
        try {
            tempDir = await fs.mkdtemp(path.join(tmpdir(), 'sd-ai-causal-chains-'));
            // get the absolute path to this temp file
            const inputPath = path.resolve(path.join(tempDir, 'data.json'));
            // logger.log(`input path is ${inputPath}`);
            await fs.writeFile(inputPath, JSON.stringify(input));
            const { stdout, stderr } = await promiseExec(`${__dirname}/causal-chains ${inputPath}`, {cwd: tempDir});
            return JSON.parse(stdout.toString());
        } catch (err) {
            logger.log(`causal-chains returned non-zero exit code: ${err}`);
            if (err.stderr) {
                return {
                 err: err.stderr.toString(),
                };
            } else {
                return {
                    err: err.toString()
                };
            }
        } finally {
            if (tempDir) {
                await fs.rm(tempDir, {recursive: true, force: true});
            }
        }
    }
}

export default Engine;
