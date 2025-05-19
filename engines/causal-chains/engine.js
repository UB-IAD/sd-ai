import * as fs from 'fs';
import {execSync} from "child_process"
import path from 'path';
import {tmpdir} from 'os';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url); // get the resolved path to the file
const __dirname = path.dirname(__filename); // get the name of the directory

class Engine {
    constructor() {
    }

    additionalParameters() {
        return [
            {
                name: "apiKey",
                type: "string",
                required: true,
                uiElement: "password",
                saveForUser: "global",
                label: "API Key",
                description: "Leave blank for the default, or your Open AI key, e.g. sk-proj-XXXXX",
            },
            {
                name: "underlyingModel",
                type: "string",
                required: true,
                uiElement: "lineedit",
                saveForUser: "global",
                label: "Model Name",
                description: "Leave blank for the default, or specify a specific a specific model to use like 'o4-mini'.",
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
            tempDir = fs.mkdtempSync(path.join(tmpdir(), 'sd-ai-causal-chains-'));
            // get the absolute path to this temp file
            const inputPath = path.resolve(path.join(tempDir, 'data.json'));
            // console.log(`input path is ${inputPath}`);
            fs.writeFileSync(inputPath, JSON.stringify(input));
            const result = execSync(`${__dirname}/causal-chains ${inputPath}`, {cwd: tempDir});

            return JSON.parse(result.toString());
        } catch (err) {
            console.log(`causal-chains returned non-zero exit code: ${err.status}`);
            return {
                err: err.stderr.toString(),
            };
        } finally {
            // if (tempDir) {
            //     fs.rmSync(tempDir, {recursive: true, force: true});
            //
        }
    }
}

export default Engine;
