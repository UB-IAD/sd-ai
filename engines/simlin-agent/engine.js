import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import util from 'node:util';
import logger from '../../utilities/logger.js';

const IMAGE_NAME = 'sd-ai-simlin-agent';

const promiseExecFile = util.promisify(execFile);

// podman's rootless mode remaps UIDs, so volume mounts are inaccessible
// to the non-root container user without --userns=keep-id
const usesPodman = (() => {
    try {
        const result = spawnSync('docker', ['--version'], { encoding: 'utf8' });
        return result.stdout?.includes('podman');
    } catch {
        return false;
    }
})();

class SimlinAgentEngine {
    constructor() {}

    static description() {
        return 'Agentic SFD builder using Claude Code with simlin tools in Docker';
    }

    static link() {
        return null;
    }

    static supportedModes() {
        try {
            const result = spawnSync('docker', ['image', 'inspect', IMAGE_NAME], {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
            });
            if (result.status === 0) {
                return ['sfd'];
            }
        } catch (err) {
            logger.log('Error checking simlin-agent Docker image:');
            logger.log(err);
        }
        return undefined;
    }

    additionalParameters() {
        return [
            {
                name: 'anthropicKey',
                type: 'string',
                required: true,
                uiElement: 'password',
                saveForUser: 'global',
                label: 'Anthropic API Key',
                description: 'API key for Claude (used by the agent inside Docker)'
            },
            {
                name: 'underlyingModel',
                type: 'string',
                required: false,
                uiElement: 'combobox',
                saveForUser: 'local',
                label: 'Model',
                description: 'Claude model for the agent to use',
                defaultValue: 'claude-opus-4-6',
                options: [
                    { label: 'Claude Opus 4.6', value: 'claude-opus-4-6' },
                    { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' }
                ]
            },
            {
                name: 'problemStatement',
                type: 'string',
                required: false,
                uiElement: 'textarea',
                saveForUser: 'local',
                label: 'Problem Statement',
                description: 'Context about the modeling problem',
                minHeight: 100,
                maxHeight: 300
            },
            {
                name: 'backgroundKnowledge',
                type: 'string',
                required: false,
                uiElement: 'textarea',
                saveForUser: 'local',
                label: 'Background Knowledge',
                description: 'Domain knowledge to include in the prompt',
                minHeight: 100,
                maxHeight: 300
            }
        ];
    }

    async generate(prompt, currentModel, parameters) {
        const anthropicKey = parameters.anthropicKey || process.env.ANTHROPIC_API_KEY;
        if (!anthropicKey) {
            return { err: 'Missing anthropicKey parameter (set via request or ANTHROPIC_API_KEY env var)' };
        }

        const model = parameters.underlyingModel || 'claude-opus-4-6';

        let promptText = `## Task\n\n${prompt}`;
        if (parameters.problemStatement) {
            promptText += `\n\nProblem Statement:\n${parameters.problemStatement}`;
        }
        if (parameters.backgroundKnowledge) {
            promptText += `\n\nBackground Knowledge:\n${parameters.backgroundKnowledge}`;
        }
        promptText += `\n\n## Input\n\n`;
        promptText += `The current model is at /workspace/input.sd.json. `;
        promptText += `If it is empty or minimal, build a new model from scratch. `;
        promptText += `If it is populated, iterate on or fix it.\n\n`;
        promptText += `## Output\n\n`;
        promptText += `Write your final model to /workspace/output.json in SD-JSON format.\n\n`;
        promptText += `IMPORTANT: if the task asks you to provide an explanation or description, `;
        promptText += `write it to /workspace/explanation.txt as plain text.`;

        let tempDir;
        try {
            tempDir = await fs.mkdtemp(path.join(tmpdir(), 'sd-ai-simlin-agent-'));

            const inputPath = path.join(tempDir, 'input.sd.json');
            await fs.writeFile(inputPath, JSON.stringify(
                currentModel || { variables: [], relationships: [], specs: {} }
            ));

            const args = [
                'run', '--rm', '-i',
                ...(usesPodman ? ['--userns=keep-id'] : []),
                '-v', `${tempDir}:/workspace`,
                '-e', `ANTHROPIC_API_KEY=${anthropicKey}`,
                IMAGE_NAME,
                '--model', model
            ];

            const promise = promiseExecFile('docker', args, {
                maxBuffer: 10 * 1024 * 1024,
                timeout: 10 * 60 * 1000
            });
            promise.child.stdin.write(promptText);
            promise.child.stdin.end();

            await promise;

            const outputPath = path.join(tempDir, 'output.json');
            let outputData;
            try {
                outputData = await fs.readFile(outputPath, 'utf8');
            } catch {
                return { err: 'Agent did not produce output.json' };
            }

            let parsed;
            try {
                parsed = JSON.parse(outputData);
            } catch {
                return { err: 'output.json is not valid JSON' };
            }

            if (!parsed.variables || !Array.isArray(parsed.variables)) {
                return { err: 'output.json missing or invalid variables array' };
            }
            if (!parsed.relationships || !Array.isArray(parsed.relationships)) {
                return { err: 'output.json missing or invalid relationships array' };
            }
            if (!parsed.specs || typeof parsed.specs !== 'object' || Array.isArray(parsed.specs)) {
                return { err: 'output.json missing or invalid specs object' };
            }

            let explanation = '';
            try {
                explanation = await fs.readFile(path.join(tempDir, 'explanation.txt'), 'utf8');
            } catch {
                // explanation.txt is optional
            }

            return {
                model: {
                    variables: parsed.variables,
                    relationships: parsed.relationships,
                    specs: parsed.specs
                },
                supportingInfo: {
                    explanation: explanation || parsed.explanation || '',
                    title: parsed.title || ''
                }
            };
        } catch (err) {
            logger.log(`simlin-agent Docker error (exit code ${err.code}): ${err.message}`);
            if (err.stderr) {
                return { err: err.stderr };
            }
            return { err: err.toString() };
        } finally {
            if (tempDir) {
                await fs.rm(tempDir, { recursive: true, force: true });
            }
        }
    }
}

export default SimlinAgentEngine;
