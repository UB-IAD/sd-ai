import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import util from 'node:util';
import logger from '../../utilities/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IMAGE_NAME = 'sd-ai-simlin-agent';

const promiseExecFile = util.promisify(execFile);

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

        let promptText = prompt;
        if (parameters.problemStatement) {
            promptText += `\n\nProblem Statement:\n${parameters.problemStatement}`;
        }
        if (parameters.backgroundKnowledge) {
            promptText += `\n\nBackground Knowledge:\n${parameters.backgroundKnowledge}`;
        }

        let tempDir;
        try {
            tempDir = await fs.mkdtemp(path.join(tmpdir(), 'sd-ai-simlin-agent-'));

            const inputPath = path.join(tempDir, 'input.sd.json');
            await fs.writeFile(inputPath, JSON.stringify(
                currentModel || { variables: [], relationships: [], specs: {} }
            ));

            const args = [
                'run', '--rm', '-i',
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
            if (!parsed.specs || typeof parsed.specs !== 'object') {
                return { err: 'output.json missing or invalid specs object' };
            }

            return {
                model: {
                    variables: parsed.variables,
                    relationships: parsed.relationships,
                    specs: parsed.specs
                },
                supportingInfo: {
                    explanation: parsed.explanation || '',
                    title: parsed.title || ''
                }
            };
        } catch (err) {
            logger.log(`simlin-agent Docker exited with code: ${err.status}`);
            if (err.stderr) {
                return { err: err.stderr.toString() };
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
