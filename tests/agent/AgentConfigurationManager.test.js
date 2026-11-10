import { AgentConfigurationManager } from '../../agent/utilities/AgentConfigurationManager.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('AgentConfigurationManager', () => {
  let configManager;

  beforeEach(() => {
    const configPath = path.join(__dirname, '../../agent/config/socrates.md');
    configManager = new AgentConfigurationManager({ path: configPath });
  });

  describe('constructor', () => {
    it('should load config from MD file via path option', () => {
      expect(configManager.config).toBeDefined();
      expect(configManager.config.agent).toBeDefined();
      expect(configManager.config.agent.name).toMatch(/^Socrates/);
    });

    it('should throw error for non-existent config file', () => {
      expect(() => {
        new AgentConfigurationManager({ path: '/non/existent/path.md' });
      }).toThrow();
    });

    it('should load config from markdownContent option', () => {
      const md = `---\nname: "TestAgent"\nagent_mode: sdk\nsupported_modes:\n  - sfd\nsupported_providers:\n  - anthropic\n---\n## Instructions\nDo things.\n`;
      const mgr = new AgentConfigurationManager({ markdownContent: md });
      expect(mgr.config.agent.name).toBe('TestAgent');
      expect(mgr.configPath).toBeNull();
    });

    it('should throw for markdownContent missing required frontmatter fields', () => {
      const md = `---\nname: "NoMode"\n---\n## Instructions\nDo things.\n`;
      expect(() => new AgentConfigurationManager({ markdownContent: md })).toThrow(/agent_mode/);
    });
  });

  describe('canWriteToLocalSandbox', () => {
    const withFrontmatter = extraLines =>
      new AgentConfigurationManager({
        markdownContent: `---\nname: "TestAgent"\nagent_mode: sdk\n${extraLines}---\n## Instructions\nDo things.\n`
      });

    it('denies the sandbox write tools when the field is absent', () => {
      // Opt-in, not opt-out. Silence is a denial.
      expect(withFrontmatter('').canWriteToLocalSandbox()).toBe(false);
    });

    it('grants them only for an explicit true', () => {
      expect(withFrontmatter('can_write_to_local_sandbox: true\n').canWriteToLocalSandbox()).toBe(true);
      expect(withFrontmatter('can_write_to_local_sandbox: false\n').canWriteToLocalSandbox()).toBe(false);
    });

    it('reads true as a boolean rather than the string "true"', () => {
      // The YAML parser used to hand back every unquoted scalar as a string, which
      // against a strict `=== true` would deny an agent that plainly asked for the
      // grant — and against a `!== false` check would grant one that refused it.
      expect(withFrontmatter('can_write_to_local_sandbox: true\n').metadata.can_write_to_local_sandbox).toBe(true);
      expect(withFrontmatter('can_write_to_local_sandbox: false\n').metadata.can_write_to_local_sandbox).toBe(false);
    });

    it('matches what the shipped agent definitions declare', () => {
      const load = name => new AgentConfigurationManager({
        path: path.join(__dirname, `../../agent/config/${name}.md`)
      }).canWriteToLocalSandbox();

      expect(load('merlin')).toBe(true);
      expect(load('themis')).toBe(false);
      expect(load('socrates')).toBe(false);
      expect(load('athena_CLD')).toBe(false);
      expect(load('athena_SFD')).toBe(false);
    });
  });

  describe('frontmatter parsing', () => {
    it('ignores whole-line comments instead of storing them as keys', () => {
      const mgr = new AgentConfigurationManager({
        markdownContent: `---\nname: "TestAgent"\nagent_mode: sdk\n# supported_providers:\n#   - anthropic\n---\n## Body\n`
      });
      expect(mgr.metadata.supported_providers).toBeUndefined();
      expect(Object.keys(mgr.metadata).some(k => k.startsWith('#'))).toBe(false);
      expect(mgr.metadata.name).toBe('TestAgent');
    });

    it('still parses numbers and arrays as before', () => {
      const mgr = new AgentConfigurationManager({
        markdownContent: `---\nname: "TestAgent"\nagent_mode: sdk\nmax_iterations: 42\nsupported_modes:\n  - sfd\n  - cld\n---\n## Body\n`
      });
      expect(mgr.getMaxIterations()).toBe(42);
      expect(mgr.metadata.supported_modes).toEqual(['sfd', 'cld']);
    });
  });

  describe('buildSystemPrompt', () => {
    it('should build system prompt with model type context', () => {
      const mode = 'cld';

      const prompt = configManager.buildSystemPrompt(mode);

      expect(prompt).toContain('CLD');
      expect(prompt).toContain('Causal Loop Diagram');
    });

    it('should include SFD context when model type is sfd', () => {
      const prompt = configManager.buildSystemPrompt('sfd');

      expect(prompt).toContain('SFD');
      expect(prompt).toContain('Stock Flow Diagram');
    });

    it('gives delay-mark guidance to CLD sessions only', () => {
      expect(configManager.buildSystemPrompt('cld')).toContain('CLD Delay Marks');
      expect(configManager.buildSystemPrompt('sfd')).not.toContain('CLD Delay Marks');
    });

    it('should include universal instructions', () => {
      const prompt = configManager.buildSystemPrompt('sfd');

      expect(prompt).toContain('CRITICAL: Text Generation');
      expect(prompt).toContain('NEVER use emojis');
      expect(prompt).toContain('Feedback Loop Analysis');
    });
  });
});
