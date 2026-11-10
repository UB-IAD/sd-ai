import {
  loadEngineBriefs, buildManifest, buildAgents, parsePersona, loadPersonas, loadRegistrySnapshot, loadClientConfig, serializeManifest,
  validCommand, validArgs, buildCompatibility, protocolFor, PROTOCOL, BUILDERS, displayName, stripVersion, binFromPackageJson,
  binaryCommand, launchByPlatform, installFor, runtimeStep, validPinnedPackage, archiveStep, npmStep, checkInstall, validTemplate, hashMissingArchives, hashArchive, forgetArchiveHashes, learnedArchiveHash, resolveExtraPackages, versionForRange, resolveNodeRuntime, resolveInstalls,
} from '../../acp/buildManifest.js';

describe('ACP manifest', () => {
  test('personas come from this repo\'s own agent configs', () => {
    const personas = loadPersonas();
    const ids = personas.map(p => p.id);
    expect(ids).toEqual(expect.arrayContaining(['socrates', 'merlin', 'themis']));
    const socrates = personas.find(p => p.id === 'socrates');
    expect(socrates.name).toBe('Socrates');
    expect(socrates.role).toBe('Coach');
    expect(socrates.instructions).not.toMatch(/^---/);   // frontmatter is metadata, not prompt
  });

  test('personas that build from a causal loop diagram say delay marks are not DELAY functions', () => {
    const personas = loadPersonas();
    for (const id of ['merlin', 'socrates', 'athena_sfd', 'themis']) {
      expect(personas.find(p => p.id === id).instructions).toContain('never wrap a link in DELAY or SMTH just because it is marked');
    }
  });

  test('the quantitative brief carries the delay-mark translation rule', async () => {
    const briefs = await loadEngineBriefs();
    expect(briefs.quantitative).toContain('DELAYS AND DELAY MARKS');
  });

  test('parsePersona reads frontmatter and single-mode agents', () => {
    const p = parsePersona('athena_CLD.md', '---\nname: "Athena"\nrole: "Guide"\nsupported_modes:\n  - cld\n---\nBe helpful.\n');
    expect(p).toEqual({ id: 'athena_cld', name: 'Athena', role: 'Guide', description: '', mode: 'cld', instructions: 'Be helpful.' });
    expect(parsePersona('x.md', 'no frontmatter')).toBeNull();
  });

  test('commands and arguments follow the client launch rules', () => {
    for (const bad of ['/usr/bin/claude', 'a;b', 'a&&b', '`id`', '$(id)', 'a b', '', '-x', '../x', 'claude\n'])
      expect(validCommand(bad)).toBe(false);
    for (const good of ['claude-agent-acp', 'codex-acp', 'gemini', 'x.cmd']) expect(validCommand(good)).toBe(true);
    expect(validArgs(['--acp', 'serve'])).toBe(true);
    expect(validArgs(['& calc'])).toBe(false);
  });

  test('only the configured agents are enabled; the rest are listed switched off', () => {
    const registry = [
      { id: 'claude-acp', name: 'Claude Agent', distribution: { npx: { package: '@x/claude-agent-acp' } }, _npmBin: 'claude-agent-acp' },
      { id: 'goose', name: 'Goose', distribution: { binary: { 'darwin-aarch64': { cmd: './goose', args: ['acp'] } } } },
    ];
    const { agents } = buildAgents(registry, { goose: {} }, ['claude-acp']);
    expect(agents.find(a => a.id === 'claude-acp').enabled).toBe(true);
    expect(agents.find(a => a.id === 'goose').enabled).toBe(false);
    expect(buildAgents(registry, { goose: { enabled: true } }, []).agents.find(a => a.id === 'goose').enabled).toBe(true);
    expect(buildAgents(registry).agents.every(a => a.enabled)).toBe(true);
  });

  test('registry entries become launchable agents, with configured overrides', () => {
    const registry = [
      { id: 'claude-acp', name: 'Claude Agent', distribution: { npx: { package: '@x/claude-agent-acp@1.0.0' } }, _npmBin: 'claude-agent-acp' },
      { id: 'gemini', name: 'Gemini CLI', distribution: { npx: { package: '@google/gemini-cli@1', args: ['--acp'] } }, _npmBin: 'gemini' },
      { id: 'multi', name: 'Multi', distribution: { npx: { package: 'multi' } }, _npmBin: null },
      { id: 'bin', name: 'Bin ACP', distribution: { binary: { 'darwin-aarch64': { cmd: './bin-acp', args: ['acp'] } } } },
    ];
    const { agents, skipped } = buildAgents(registry, loadClientConfig().agentOverrides);
    expect(skipped).toEqual(['multi']);
    const claude = agents.find(a => a.id === 'claude');
    expect(claude.displayName).toBe('Claude');
    expect(claude.executableEnv).toEqual({ CLAUDE_CODE_EXECUTABLE: 'claude' });
    expect(agents.find(a => a.id === 'gemini').args).toEqual(['--acp']);
    expect(agents.find(a => a.id === 'bin')).toMatchObject({ command: 'bin-acp', displayName: 'Bin' });
  });

  test('a binary agent launched differently on a platform says so in commandByPlatform / argsByPlatform', () => {
    const agy = { id: 'antigravity-acp', name: 'Google Antigravity', distribution: { binary: {
      'darwin-aarch64': { cmd: './agy_acp_server.par' },
      'linux-x86_64': { cmd: './agy_acp_server.par', args: ['--uid='] },
      'windows-x86_64': { cmd: './agy_acp_server.exe' },
    } } };
    const cursor = { id: 'cursor', name: 'Cursor', distribution: { binary: {
      'darwin-aarch64': { cmd: './dist-package/cursor-agent' },
      'windows-x86_64': { cmd: './dist-package\\cursor-agent.cmd' },
    } } };
    const { agents } = buildAgents([agy, cursor]);
    expect(agents.find(a => a.id === 'antigravity-acp')).toMatchObject({
      command: 'agy_acp_server.par', commandByPlatform: { windows: 'agy_acp_server' },
      args: [], argsByPlatform: { linux: ['--uid='] },
    });
    // Same name everywhere once the Windows extension is gone: nothing to say.
    expect(agents.find(a => a.id === 'cursor').commandByPlatform).toBeUndefined();
    expect(agents.find(a => a.id === 'cursor').argsByPlatform).toBeUndefined();
    expect(binaryCommand('./bin\\devin.exe')).toBe('devin');
    expect(binaryCommand('./coco-1.0/cortex')).toBe('cortex');
    expect(launchByPlatform({ distribution: { npx: { package: 'x' } } })).toEqual({ commandByPlatform: {}, argsByPlatform: {} });
  });

  test('an npm agent installs as two generic steps: node, then npm', () => {
    const node = { version: '24.1.0', displayName: 'Node.js', archives: { 'darwin-aarch64': { url: 'https://nodejs.org/n.tar.gz', sha256: 'a'.repeat(64), bin: 'bin' } } };
    const installable = { 'claude-acp': { extraPackages: ['@anthropic-ai/claude-code@2.1.0'], env: { DISABLE_AUTOUPDATER: '1' } } };
    const claude = { id: 'claude-acp', name: 'Claude Agent', distribution: { npx: { package: '@x/claude-agent-acp@1.0.0' } }, _npmBin: 'claude-agent-acp' };
    const install = installFor(claude, installable, { node });
    expect(install.env).toEqual({ DISABLE_AUTOUPDATER: '1' });
    expect(install.steps[0]).toEqual({
      kind: 'download', label: 'Node.js 24.1.0 (from nodejs.org)', into: 'runtime', name: 'node', version: '24.1.0', strip: true,
      archives: { 'darwin-aarch64': { url: 'https://nodejs.org/n.tar.gz', sha256: 'a'.repeat(64), bin: 'bin' } },
    });
    const npm = install.steps[1];
    expect(npm).toMatchObject({ kind: 'run', program: '{runtime:node}/bin/node', path: ['{agent}/node_modules/.bin'],
                                label: '@x/claude-agent-acp 1.0.0, @anthropic-ai/claude-code 2.1.0 (from npmjs.com)' });
    expect(npm.args.slice(0, 4)).toEqual(['{runtime:node}/lib/node_modules/npm/bin/npm-cli.js', 'install', '--prefix', '{agent}']);
    expect(npm.args.slice(-2)).toEqual(['@x/claude-agent-acp@1.0.0', '@anthropic-ai/claude-code@2.1.0']);
    expect(npm.byPlatform.windows.program).toBe('{runtime:node}/node.exe');
    expect(npm.byPlatform.windows.args[0]).toBe('{runtime:node}/node_modules/npm/bin/npm-cli.js');
    // Not listed, no exact version, or a distribution not generated yet (uvx): no install.
    expect(installFor({ ...claude, id: 'other' }, installable, { node })).toBeUndefined();
    expect(installFor({ ...claude, distribution: { npx: { package: '@x/claude-agent-acp' } } }, installable, { node })).toBeUndefined();
    expect(installFor({ id: 'claude-acp', distribution: { uvx: { package: 'x==1.0' } } }, installable, { node })).toBeUndefined();
  });

  test('installs are checked as clients check them, or the build fails', () => {
    for (const bad of ['x', 'x@^1.0.0', 'x@latest', '@x/y@1', 'x@1.0.0 && rm', '@X/y@1.0.0']) expect(validPinnedPackage(bad)).toBe(false);
    for (const good of ['x@1.0.0', '@scope/name@1.2.3', '@scope/name@1.0.0-beta.2']) expect(validPinnedPackage(good)).toBe(true);
    for (const good of ['{agent}', '--cache={temp}/npm-cache', '{runtime:node}/bin/node', 'x==1.0']) expect(validTemplate(good)).toBe(true);
    for (const bad of ['{home}', '$HOME', 'a;b', '`id`', '%APPDATA%', '{agent']) expect(validTemplate(bad)).toBe(false);
    const run = { kind: 'run', label: 'x', program: '{agent}/bin/x', args: [] };
    expect(() => checkInstall({ steps: [run] }, 't')).not.toThrow();
    expect(() => checkInstall({ steps: [{ ...run, program: '/bin/sh' }] }, 't')).toThrow();
    expect(() => checkInstall({ steps: [{ ...run, program: '{temp}/x' }] }, 't')).toThrow();
    expect(() => checkInstall({ steps: [{ ...run, args: ['a;b'] }] }, 't')).toThrow();
    expect(() => checkInstall({ steps: [{ ...run, byPlatform: { windows: { program: 'C:/Windows/cmd.exe' } } }] }, 't')).toThrow();
    expect(() => checkInstall({ steps: [{ kind: 'flatpak', label: 'x' }] }, 't')).toThrow();
    const archive = { url: 'https://nodejs.org/n.tar.gz', sha256: 'a'.repeat(64), bin: 'bin' };
    expect(() => runtimeStep('node', { version: '24', archives: { 'darwin-aarch64': archive } })).toThrow();
    expect(() => runtimeStep('node', { version: '24.1.0', archives: { 'darwin-aarch64': { ...archive, url: 'http://x' } } })).toThrow();
    expect(() => runtimeStep('node', { version: '24.1.0', archives: { 'darwin-aarch64': { ...archive, sha256: 'abc' } } })).toThrow();
    expect(() => runtimeStep('node', { version: '24.1.0', archives: { 'darwin-aarch64': { ...archive, bin: '../x' } } })).toThrow();
    expect(() => runtimeStep('node', { version: '24.1.0', archives: { 'mars-z80': archive } })).toThrow();
    expect(() => runtimeStep('node', { version: '24.1.0', archives: {} })).toThrow();
  });

  test('a binary agent installs as one download, checksummed by the registry or pinned per url', () => {
    const sha = 'b'.repeat(64);
    const agent = { id: 'bin', name: 'Bin', version: '1.2.1', distribution: { binary: {
      'darwin-aarch64': { archive: 'https://x.test/mac.zip', cmd: './bin-acp' },
      'windows-x86_64': { archive: 'https://x.test/win.zip', cmd: './dist\\bin-acp.exe', sha256: 'c'.repeat(64) },
      'linux-x86_64': { archive: 'https://x.test/linux.zip', cmd: './bin-acp' },
    } } };
    expect(archiveStep(agent, { 'https://x.test/mac.zip': sha })).toEqual({ kind: 'download', label: 'Bin 1.2.1 (from x.test)', into: 'agent', archives: {
      'darwin-aarch64': { url: 'https://x.test/mac.zip', sha256: sha, bin: '' },
      'windows-x86_64': { url: 'https://x.test/win.zip', sha256: 'c'.repeat(64), bin: 'dist' },
    } });
    // Nothing checksummed (a new release, not yet pinned): no install.
    expect(archiveStep({ ...agent, distribution: { binary: { 'darwin-aarch64': agent.distribution.binary['darwin-aarch64'] } } })).toBeNull();
    expect(installFor(agent, { bin: { sha256: { 'https://x.test/mac.zip': sha } } }).steps.map(s => s.kind)).toEqual(['download']);
    expect(archiveStep({ distribution: { binary: { 'darwin-aarch64': { archive: 'http://x.test/a.zip', cmd: './a', sha256: sha } } } })).toBeNull();
    expect(archiveStep({ distribution: { binary: { 'darwin-aarch64': { archive: 'https://x.test/a.zip', cmd: '../a', sha256: sha } } } })).toBeNull();
  });

  test('a binary agent whose archives carry no checksum stays installable across releases: the server hashes them', async () => {
    forgetArchiveHashes();
    const agent = { id: 'agy', name: 'Agy', version: '9.0.0', distribution: { binary: {
      'darwin-aarch64': { archive: 'https://x.test/agy-9.0.0-mac.zip', cmd: './agy' },
      'windows-x86_64': { archive: 'https://x.test/agy-9.0.0-win.zip', cmd: './agy.exe' },
    } } };
    // A new release nobody has pinned: not installable until its archives are hashed.
    expect(archiveStep(agent, {})).toBeNull();
    const fetched = [];
    const learned = await hashMissingArchives([agent], { agy: {} }, { hash: async url => { fetched.push(url); return url.includes('mac') ? 'd'.repeat(64) : 'e'.repeat(64); } });
    expect(learned).toBe(2);
    expect(archiveStep(agent, {}).archives).toEqual({
      'darwin-aarch64': { url: 'https://x.test/agy-9.0.0-mac.zip', sha256: 'd'.repeat(64), bin: '' },
      'windows-x86_64': { url: 'https://x.test/agy-9.0.0-win.zip', sha256: 'e'.repeat(64), bin: '' },
    });
    // Each url is hashed once; agents that are not installable are never downloaded.
    expect(await hashMissingArchives([agent], { agy: {} }, { hash: async url => { fetched.push(url); return 'f'.repeat(64); } })).toBe(0);
    expect(await hashMissingArchives([{ ...agent, id: 'other' }], { agy: {} }, { hash: async url => { fetched.push(url); return 'f'.repeat(64); } })).toBe(0);
    expect(fetched).toHaveLength(2);
    // A hash pinned in the config wins; one that disagrees with what the server saw drops that target.
    expect(archiveStep(agent, { 'https://x.test/agy-9.0.0-mac.zip': 'd'.repeat(64) }).archives['darwin-aarch64'].sha256).toBe('d'.repeat(64));
    expect(Object.keys(archiveStep(agent, { 'https://x.test/agy-9.0.0-mac.zip': 'c'.repeat(64) }).archives)).toEqual(['windows-x86_64']);
    // One that cannot be fetched is tried again next time.
    forgetArchiveHashes();
    expect(await hashMissingArchives([agent], { agy: {} }, { hash: async () => { throw new Error('offline'); } })).toBe(0);
    expect(learnedArchiveHash('https://x.test/agy-9.0.0-mac.zip')).toBeUndefined();
    forgetArchiveHashes();
  });

  test('Claude Code follows the adapter: the version its Agent SDK was made for', async () => {
    const extra = { package: '@anthropic-ai/claude-code', versionFrom: { dependency: '@anthropic-ai/claude-agent-sdk', field: 'claudeCodeVersion' }, fallback: '2.1.0' };
    const npm = {
      'https://registry.npmjs.org/@agentclientprotocol%2Fclaude-agent-acp/0.90.0': { dependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.296' } },
      'https://registry.npmjs.org/@anthropic-ai%2Fclaude-agent-sdk/0.3.296': { claudeCodeVersion: '2.1.296' },
    };
    const fetchJsonImpl = async url => { if (!npm[url]) throw new Error('404 ' + url); return npm[url]; };
    expect(await resolveExtraPackages('@agentclientprotocol/claude-agent-acp@0.90.0', extra, { fetchJsonImpl })).toEqual(['@anthropic-ai/claude-code@2.1.296']);
    // Unreachable, or nothing exact to go on: the fallback.
    expect(await resolveExtraPackages('@agentclientprotocol/claude-agent-acp@0.91.0', extra, { fetchJsonImpl })).toEqual(['@anthropic-ai/claude-code@2.1.0']);
    npm['https://registry.npmjs.org/@anthropic-ai%2Fclaude-agent-sdk/0.3.296'] = { claudeCodeVersion: 'latest' };
    expect(await resolveExtraPackages('@agentclientprotocol/claude-agent-acp@0.90.0', extra, { fetchJsonImpl })).toEqual(['@anthropic-ai/claude-code@2.1.0']);
    expect(await resolveExtraPackages('x@1.0.0', 'y@2.0.0')).toEqual(['y@2.0.0']);
    // A range: the SDK npm would install today, pinned beside the Claude Code it was made for.
    npm['https://registry.npmjs.org/@agentclientprotocol%2Fclaude-agent-acp/0.92.0'] = { dependencies: { '@anthropic-ai/claude-agent-sdk': '^0.3.296' } };
    npm['https://registry.npmjs.org/@anthropic-ai%2Fclaude-agent-sdk'] = { versions: { '0.3.290': {}, '0.3.296': {}, '0.3.301': {}, '0.4.0': {}, '0.3.302-beta.1': {} } };
    npm['https://registry.npmjs.org/@anthropic-ai%2Fclaude-agent-sdk/0.3.301'] = { claudeCodeVersion: '2.1.301' };
    expect(await resolveExtraPackages('@agentclientprotocol/claude-agent-acp@0.92.0', extra, { fetchJsonImpl }))
      .toEqual(['@anthropic-ai/claude-agent-sdk@0.3.301', '@anthropic-ai/claude-code@2.1.301']);
  });

  test('a dependency range comes to the version npm would install', async () => {
    const versions = { versions: Object.fromEntries(['1.2.3', '1.2.9', '1.3.0', '2.0.0', '0.0.4', '0.0.5', '1.4.0-rc.1'].map(v => [v, {}])) };
    const impl = { fetchJsonImpl: async () => versions };
    expect(await versionForRange('p', '1.2.3', impl)).toBe('1.2.3');
    expect(await versionForRange('p', '=1.2.3', impl)).toBe('1.2.3');
    expect(await versionForRange('p', '^1.2.3', impl)).toBe('1.3.0');
    expect(await versionForRange('p', '~1.2.3', impl)).toBe('1.2.9');
    expect(await versionForRange('p', '^0.0.4', impl)).toBe('0.0.4');
    expect(await versionForRange('p', '^1.9.0', impl)).toBeUndefined();
    expect(await versionForRange('p', '>=1.0.0', impl)).toBeUndefined();
  });

  test('Node moves to the newest release of its line, checksums from its SHASUMS256.txt, or stays put', async () => {
    const runtime = { version: '24.1.0', track: { major: 24, dist: 'https://nodejs.org/dist/' }, archives: {
      'darwin-aarch64': { url: 'https://nodejs.org/dist/v24.1.0/node-v24.1.0-darwin-arm64.tar.gz', sha256: 'a'.repeat(64), bin: 'bin' },
      'windows-x86_64': { url: 'https://nodejs.org/dist/v24.1.0/node-v24.1.0-win-x64.zip', sha256: 'b'.repeat(64), bin: '' },
    } };
    const index = [{ version: 'v26.0.0' }, { version: 'v24.9.0' }, { version: 'v24.8.0' }];
    let sums = `${'c'.repeat(64)}  node-v24.9.0-darwin-arm64.tar.gz\n${'d'.repeat(64)}  node-v24.9.0-win-x64.zip\n`;
    const impl = { fetchJsonImpl: async () => index, fetchTextImpl: async () => sums };
    expect(await resolveNodeRuntime(runtime, impl)).toEqual({ ...runtime, version: '24.9.0', archives: {
      'darwin-aarch64': { url: 'https://nodejs.org/dist/v24.9.0/node-v24.9.0-darwin-arm64.tar.gz', sha256: 'c'.repeat(64), bin: 'bin' },
      'windows-x86_64': { url: 'https://nodejs.org/dist/v24.9.0/node-v24.9.0-win-x64.zip', sha256: 'd'.repeat(64), bin: '' },
    } });
    // A release missing one of the archives keeps the pinned one; so does no track.
    sums = `${'c'.repeat(64)}  node-v24.9.0-darwin-arm64.tar.gz\n`;
    expect(await resolveNodeRuntime(runtime, impl)).toBe(runtime);
    expect(await resolveNodeRuntime({ ...runtime, track: undefined }, impl)).toEqual({ ...runtime, track: undefined });
  });

  test('an archive hashed for one build counts as learned for every build that waited for it', async () => {
    forgetArchiveHashes();
    const url = 'https://example.com/agent-1.0.0.tar.gz';
    const registry = [{ id: 'bin', distribution: { binary: { 'darwin-aarch64': { archive: url, cmd: './agent' } } } }];
    let finish;
    let downloads = 0;
    const hash = () => { downloads++; return new Promise(resolve => { finish = resolve; }); };
    const first = hashMissingArchives(registry, { bin: {} }, { hash });
    const second = hashMissingArchives(registry, { bin: {} }, { hash });
    finish('e'.repeat(64));
    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(downloads).toBe(1);
    forgetArchiveHashes();
  });

  test('installs resolve before the build, and one that cannot be offered is reported', async () => {
    forgetArchiveHashes();
    const config = loadClientConfig();
    const registry = loadRegistrySnapshot();
    const offline = { fetchJsonImpl: async () => { throw new Error('offline'); }, fetchTextImpl: async () => { throw new Error('offline'); },
                      hash: async () => { throw new Error('offline'); } };
    const resolved = await resolveInstalls(registry, config, offline);
    // Offline: as configured.
    expect(resolved.runtimes.node.version).toBe(config.runtimes.node.version);
    expect(resolved.installable['claude-acp'].extraPackages).toEqual(['@anthropic-ai/claude-code@' + config.installable['claude-acp'].extraPackages[0].fallback]);
    // An installable binary agent on a release nobody has hashed or pinned is reported, not silently dropped.
    const moved = registry.map(a => a.id !== 'antigravity-acp' ? a : { ...a, distribution: { binary: Object.fromEntries(
      Object.entries(a.distribution.binary).map(([t, b]) => [t, { ...b, archive: b.archive.replace(/1\.2\.1/g, '9.9.9') }])) } });
    expect(buildAgents(moved, config.agentOverrides, config.enabledAgents, { installable: config.installable, runtimes: config.runtimes }).notInstallable)
      .toEqual(['antigravity-acp']);
    expect(buildAgents(registry, config.agentOverrides, config.enabledAgents, { installable: config.installable, runtimes: config.runtimes }).notInstallable)
      .toEqual([]);
  });

  test('hashArchive streams what the url serves into its sha256', async () => {
    const body = new TextEncoder().encode('archive bytes');
    const fakeFetch = async () => ({ ok: true, body: (async function* () { yield body.slice(0, 4); yield body.slice(4); })() });
    const { createHash } = await import('crypto');
    expect(await hashArchive('https://x.test/a.zip', { fetchImpl: fakeFetch })).toBe(createHash('sha256').update('archive bytes').digest('hex'));
    await expect(hashArchive('https://x.test/a.zip', { fetchImpl: async () => ({ ok: false, status: 404 }) })).rejects.toThrow('404');
  });

  test('the committed config makes Claude, Antigravity, Codex and Copilot installable, in generic steps only', () => {
    const manifest = buildManifest({ registry: loadRegistrySnapshot(), personas: [], config: loadClientConfig() });
    expect(manifest.agents.filter(a => a.install).map(a => a.id).sort()).toEqual(['antigravity-acp', 'claude', 'codex-acp', 'github-copilot-cli']);
    for (const id of ['codex-acp', 'github-copilot-cli'])
      expect(manifest.agents.find(a => a.id === id).install.steps.map(s => s.kind)).toEqual(['download', 'run']);
    const all = ['darwin-aarch64', 'darwin-x86_64', 'linux-aarch64', 'linux-x86_64', 'windows-aarch64', 'windows-x86_64'];
    const claude = manifest.agents.find(a => a.id === 'claude').install;
    expect(claude.steps.map(s => s.kind)).toEqual(['download', 'run']);
    expect(Object.keys(claude.steps[0].archives).sort()).toEqual(all);
    const agy = manifest.agents.find(a => a.id === 'antigravity-acp').install;
    expect(agy.steps.map(s => s.kind)).toEqual(['download']);
    expect(Object.keys(agy.steps[0].archives).sort()).toEqual(all);
  });

  test('helpers', () => {
    expect(displayName('Claude Agent')).toBe('Claude');
    expect(stripVersion('@scope/name@1.2.3')).toBe('@scope/name');
    expect(stripVersion('fast-agent-acp==0.10.1')).toBe('fast-agent-acp');
    expect(binFromPackageJson('p', { bin: { 'p-acp': 'x', other: 'y' } })).toBe('p-acp');
    expect(binFromPackageJson('p', { bin: { a: 'x', b: 'y' } })).toBeNull();
  });

  test('the committed snapshot builds a complete manifest whose serial grows', () => {
    const config = loadClientConfig();
    const registry = loadRegistrySnapshot();
    const earlier = buildManifest({ registry, personas: loadPersonas(), config, now: new Date('2026-01-01T00:00:00Z') });
    const later = buildManifest({ registry, personas: loadPersonas(), config, now: new Date('2026-01-02T00:00:00Z') });
    expect(later.serial).toBeGreaterThan(earlier.serial);
    expect(earlier.protocol).toBe(1);
    expect(earlier.compatibility).toEqual({ minProtocol: 1, minClientVersions: {}, message: '', url: '' });
    expect(earlier.defaultPersona).toBe('socrates');
    expect(earlier.agents.some(a => a.id === 'claude')).toBe(true);
    // Minimal: the manifest sets nothing in the agents' own settings and hides none of their choices
    // (bypass-permission modes included); each starts as the user configured it.
    expect(earlier.configOptions.defaults ?? {}).toEqual({});
    expect(earlier.configOptions.hide ?? {}).toEqual({});
    // The main assistants start in their own no-prompt mode; the rest as the user configured them.
    const modes = Object.fromEntries(earlier.agents.filter(a => a.configDefaults).map(a => [a.id, a.configDefaults.mode]));
    expect(modes).toEqual({
      claude: ['auto'], 'codex-acp': ['agent'], 'antigravity-acp': ['auto_edit'],
      'github-copilot-cli': ['https://agentclientprotocol.com/protocol/session-modes#autopilot', 'autopilot'],
    });
    expect(earlier.agents.filter(a => a.enabled).map(a => a.id).sort())
      .toEqual(['amp-acp', 'antigravity-acp', 'auggie', 'claude', 'cline', 'codex-acp', 'cursor', 'devin',
                'factory-droid', 'gemini', 'github-copilot-cli', 'glm-acp-agent', 'goose', 'junie', 'kilo', 'kimi',
                'minimax-code', 'mistral-vibe', 'opencode', 'qwen-code']);
  });

  test('the protocol is versioned and every supported protocol has a builder', () => {
    expect(BUILDERS[PROTOCOL]).toBeDefined();
    const registry = loadRegistrySnapshot();
    const manifest = buildManifest({ registry, personas: [], config: loadClientConfig() });
    // The envelope every client reads, whatever protocol the body is in.
    for (const key of ['protocol', 'serial', 'issuedAt', 'compatibility']) expect(manifest).toHaveProperty(key);
  });

  test('requests are answered in the protocol the client speaks', () => {
    expect(protocolFor(undefined, 1, [1])).toBe(1);        // first clients send none
    expect(protocolFor('1', 1, [1, 2])).toBe(1);
    expect(protocolFor('2', 1, [1, 2])).toBe(2);
    expect(protocolFor('9', 1, [1, 2])).toBe(2);           // a client newer than the server
    expect(protocolFor('1', 2, [1, 2])).toBe(2);           // cut off: the newest envelope says so
    expect(protocolFor('junk', 1, [1])).toBe(1);
  });

  test('clients can be cut off by protocol or by version', () => {
    expect(buildCompatibility({ minProtocol: 2, minClientVersions: { app: '4.3' }, message: 'Update', url: 'https://x' }))
      .toEqual({ minProtocol: 2, minClientVersions: { app: '4.3' }, message: 'Update', url: 'https://x' });
    expect(() => buildCompatibility({ minClientVersions: { app: 'latest' } })).toThrow();
    expect(buildCompatibility({ minProtocol: 0 }).minProtocol).toBe(1);
  });
});
