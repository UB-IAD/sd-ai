import { SessionManager } from '../../agent/utilities/SessionManager.js';
import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomBytes } from 'crypto';

describe('SessionManager', () => {
  let sessionManager;

  beforeEach(() => {
    sessionManager = new SessionManager();
  });

  afterEach(() => {
    sessionManager.shutdown();
  });

  describe('initializeSession', () => {
    it('should create a new session with CLD model type', () => {
      const mode = 'cld';
      const model = { variables: [], relationships: [] };
      const tools = [];
      const context = { description: 'Test context' };

      const sessionId = sessionManager.createSession(null); // null WebSocket for testing
      sessionManager.initializeSession(sessionId, mode, model, tools, context, 'test-client');

      const session = sessionManager.getSession(sessionId);
      expect(session).toBeDefined();
      expect(session.mode).toBe('cld');
      expect(session.clientModel).toEqual(model);
      expect(session.context).toEqual(context);
      expect(session.conversationContext).toEqual([]);
    });

    it('should create a new session with SFD model type', () => {
      const mode = 'sfd';
      const model = { variables: [] };

      const sessionId = sessionManager.createSession(null);
      sessionManager.initializeSession(sessionId, mode, model, [], {}, '');

      const session = sessionManager.getSession(sessionId);
      expect(session.mode).toBe('sfd');
    });

    it('should create temp folder for session', () => {
      const sessionId = sessionManager.createSession(null);
      sessionManager.initializeSession(sessionId, 'cld', {}, [], {}, '');

      const session = sessionManager.getSession(sessionId);
      expect(session.tempDir).toBeDefined();
      expect(fs.existsSync(session.tempDir)).toBe(true);
    });

    it('should throw error for invalid model type', () => {
      const sessionId = sessionManager.createSession(null);
      expect(() => {
        sessionManager.initializeSession(sessionId, 'invalid', {}, [], {}, '');
      }).toThrow();
    });
  });

  describe('getSession', () => {
    it('should return session if exists', () => {
      const sessionId = sessionManager.createSession(null);
      sessionManager.initializeSession(sessionId, 'cld', {}, [], {}, '');

      const session = sessionManager.getSession(sessionId);
      expect(session).toBeDefined();
      expect(session.mode).toBe('cld');
    });

    it('should return undefined for non-existent session', () => {
      const session = sessionManager.getSession('non-existent');
      expect(session).toBeUndefined();
    });
  });

  describe('updateClientModel', () => {
    it('should update the client model', () => {
      const sessionId = sessionManager.createSession(null);
      sessionManager.initializeSession(sessionId, 'sfd', {}, [], {}, '');

      const newModel = { variables: [{ name: 'Stock1', type: 'stock' }] };
      sessionManager.updateClientModel(sessionId, newModel);

      const session = sessionManager.getSession(sessionId);
      expect(session.clientModel).toEqual(newModel);
    });

    it('should not throw error for non-existent session', () => {
      expect(() => {
        sessionManager.updateClientModel('non-existent', {});
      }).not.toThrow();
    });

    // Unit consistency is decided authoritatively by the client's engine and
    // delivered in the model's unitWarnings field. The agent must never
    // fabricate warnings, so the issues summary reports exactly what the engine
    // said — and nothing when the engine did not report a unit check at all.
    it('reports engine unit warnings verbatim when present', () => {
      const sessionId = sessionManager.createSession(null);
      sessionManager.initializeSession(sessionId, 'sfd', {}, [], {}, '');

      const model = { variables: [{ name: 'Stock1', type: 'stock' }], unitWarnings: ['mood_net_flow: smiles/week/Days is inconsistent'] };
      const { issues } = sessionManager.updateClientModel(sessionId, model);

      expect(issues).toContain('mood_net_flow: smiles/week/Days is inconsistent');
      expect(issues).toContain("simulation engine's unit checker");
    });

    it('reports a positive "no unit warnings" signal when the engine array is present but empty', () => {
      const sessionId = sessionManager.createSession(null);
      sessionManager.initializeSession(sessionId, 'sfd', {}, [], {}, '');

      const model = { variables: [{ name: 'Stock1', type: 'stock' }], unitWarnings: [] };
      const { issues } = sessionManager.updateClientModel(sessionId, model);

      expect(issues).toContain('NO unit warnings');
    });

    it('stays silent about units when the engine reported no unit check (field absent)', () => {
      const sessionId = sessionManager.createSession(null);
      sessionManager.initializeSession(sessionId, 'sfd', {}, [], {}, '');

      const model = { variables: [{ name: 'Stock1', type: 'stock' }] };
      const { issues } = sessionManager.updateClientModel(sessionId, model);

      // No unitWarnings field and no errors => nothing to report.
      expect(issues).toBeNull();
    });

    it('drops the cached token count so the next reader measures the new model', () => {
      const sessionId = sessionManager.createSession(null);
      sessionManager.initializeSession(sessionId, 'sfd', {}, [], {}, '');

      const small = sessionManager.getModelTokenCount(sessionId);
      sessionManager.updateClientModel(sessionId, {
        variables: Array.from({ length: 50 }, (_, i) => ({ name: `stock_${i}`, type: 'stock', equation: '100' }))
      });

      expect(sessionManager.getModelTokenCount(sessionId)).toBeGreaterThan(small);
    });
  });

  describe('onModelChange', () => {
    // The tool list that follows the model hangs off this. The case it exists for is
    // the one no server-side caller can announce: the host application inserting an
    // assembly through a client tool, which reaches the server only as a new model.
    it('notifies listeners on every model change, whatever made it', () => {
      const sessionId = sessionManager.createSession(null);
      sessionManager.initializeSession(sessionId, 'sfd', {}, [], {}, '');

      let calls = 0;
      sessionManager.onModelChange(sessionId, () => calls++);

      sessionManager.updateClientModel(sessionId, { variables: [{ name: 'a', type: 'stock' }] });
      sessionManager.updateClientModel(sessionId, { variables: [{ name: 'b', type: 'stock' }] });

      expect(calls).toBe(2);
    });

    it('keeps going when a listener throws, and stops after unsubscribe', () => {
      const sessionId = sessionManager.createSession(null);
      sessionManager.initializeSession(sessionId, 'sfd', {}, [], {}, '');

      const seen = [];
      sessionManager.onModelChange(sessionId, () => { throw new Error('listener blew up'); });
      const unsubscribe = sessionManager.onModelChange(sessionId, () => seen.push('second'));

      expect(() => sessionManager.updateClientModel(sessionId, { variables: [] })).not.toThrow();
      expect(seen).toEqual(['second']);

      unsubscribe();
      sessionManager.updateClientModel(sessionId, { variables: [] });
      expect(seen).toEqual(['second']);
    });

    it('forgets a deleted session\'s listeners rather than holding its orchestrator', async () => {
      const sessionId = sessionManager.createSession(null);
      sessionManager.initializeSession(sessionId, 'sfd', {}, [], {}, '');
      sessionManager.onModelChange(sessionId, () => {});

      await sessionManager.deleteSession(sessionId);

      expect(sessionManager.modelChangeListeners.has(sessionId)).toBe(false);
    });
  });

  describe('conversation history', () => {
    let testSessionId;

    beforeEach(() => {
      testSessionId = sessionManager.createSession(null);
      sessionManager.initializeSession(testSessionId, 'cld', {}, [], {}, '');
    });

    it('should add messages to conversation history', () => {
      sessionManager.addToConversationHistory(testSessionId, {
        role: 'user',
        content: 'Hello'
      });

      const history = sessionManager.getConversationContext(testSessionId);
      expect(history).toHaveLength(1);
      expect(history[0].role).toBe('user');
      expect(history[0].content).toBe('Hello');
    });

    it('should maintain conversation order', () => {
      sessionManager.addToConversationHistory(testSessionId, {
        role: 'user',
        content: 'First'
      });
      sessionManager.addToConversationHistory(testSessionId, {
        role: 'assistant',
        content: 'Second'
      });

      const history = sessionManager.getConversationContext(testSessionId);
      expect(history).toHaveLength(2);
      expect(history[0].content).toBe('First');
      expect(history[1].content).toBe('Second');
    });

    it('trims overflow in place so a running agent loop keeps a live reference', () => {
      // Manual agent loops capture this array once and use it for every API
      // call. If truncation swapped in a new array, the loop's copy would go
      // stale: queued user turns added via addToConversationHistory would never
      // reach the request, and the loop would re-enter still ending on an
      // assistant turn.
      const loopMessages = sessionManager.getConversationContext(testSessionId);
      const max = sessionManager.maxConversationHistory;

      for (let i = 0; i < max + 5; i++) {
        sessionManager.addToConversationHistory(testSessionId, { role: 'user', content: `msg ${i}` });
      }

      expect(sessionManager.getConversationContext(testSessionId)).toBe(loopMessages);
      expect(loopMessages).toHaveLength(max);
      expect(loopMessages[loopMessages.length - 1].content).toBe(`msg ${max + 4}`);
      expect(loopMessages[0].content).toBe('msg 5');
    });

    // ── safe trim boundaries ────────────────────────────────────────────────
    //
    // The trim cuts the head of an array that is usually mid-tool-sequence: a
    // long or restored session sits pinned at the cap, so every append trims one
    // message and would otherwise leave the history opening on a dangling
    // tool_result or an assistant turn — which every provider rejects.

    const toolUseTurn = (id) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 't', input: {} }] });
    const toolResultTurn = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'r' }] });
    const addAll = (sessionId, mgr, msgs) => msgs.forEach(m => mgr.addToConversationHistory(sessionId, m));

    it('advances the cut past a dangling tool_result so the history opens on a real user turn', () => {
      sessionManager.maxConversationHistory = 10;
      const context = sessionManager.getConversationContext(testSessionId);

      // Cutting exactly the 1-message overflow would leave index 0 = the
      // assistant tool_use's orphaned tool_result partner.
      addAll(testSessionId, sessionManager, [
        { role: 'user', content: 'q' },
        toolUseTurn('tu_1'),
        toolResultTurn('tu_1'),
        ...Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: `filler ${i}` })),
      ]);

      expect(context).toHaveLength(8);
      expect(context[0]).toEqual({ role: 'user', content: 'filler 0' });
      expect(context.some(m => Array.isArray(m.content))).toBe(false);
    });

    it('advances the cut past a dangling Gemini functionResponse', () => {
      sessionManager.maxConversationHistory = 10;
      const context = sessionManager.getConversationContext(testSessionId);

      addAll(testSessionId, sessionManager, [
        { role: 'user', parts: [{ text: 'q' }] },
        { role: 'model', parts: [{ functionCall: { name: 't', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: 't', response: {} } }] },
        ...Array.from({ length: 8 }, (_, i) => ({ role: 'user', parts: [{ text: `filler ${i}` }] })),
      ]);

      expect(context).toHaveLength(8);
      expect(context[0].parts[0].text).toBe('filler 0');
      expect(context.some(m => m.parts.some(p => p.functionResponse || p.functionCall))).toBe(false);
    });

    it('skips the trim entirely when no safe boundary exists', () => {
      sessionManager.maxConversationHistory = 10;
      const context = sessionManager.getConversationContext(testSessionId);

      // One unbroken tool sequence: every candidate cut point is an assistant
      // turn or an orphaned tool_result. Holding the extra messages is correct —
      // the token-based summarizer trims these with pairing intact.
      addAll(testSessionId, sessionManager, [
        { role: 'user', content: 'q' },
        ...Array.from({ length: 10 }, (_, i) =>
          (i % 2 === 0 ? toolUseTurn(`tu_${i}`) : toolResultTurn(`tu_${i - 1}`))),
      ]);

      expect(context).toHaveLength(11);
      expect(context[0]).toEqual({ role: 'user', content: 'q' });
    });

    it('skips the trim when the nearest safe boundary would gut the history', () => {
      sessionManager.maxConversationHistory = 10;
      const context = sessionManager.getConversationContext(testSessionId);

      // First safe start is index 7, which would retain only 4 of 11 messages —
      // below the half-cap floor, so the soft memory guard stands down.
      addAll(testSessionId, sessionManager, [
        { role: 'user', content: 'q' },
        ...Array.from({ length: 6 }, (_, i) =>
          (i % 2 === 0 ? toolUseTurn(`tu_${i}`) : toolResultTurn(`tu_${i - 1}`))),
        ...Array.from({ length: 4 }, (_, i) => ({ role: 'user', content: `filler ${i}` })),
      ]);

      expect(context).toHaveLength(11);
      expect(context[0]).toEqual({ role: 'user', content: 'q' });
    });
  });

  describe('deleteSession', () => {
    it('should remove session and clean up temp folder', () => {
      const sessionId = sessionManager.createSession(null);
      sessionManager.initializeSession(sessionId, 'cld', {}, [], {}, '');

      const session = sessionManager.getSession(sessionId);
      const tempFolder = session.tempDir;
      expect(fs.existsSync(tempFolder)).toBe(true);

      sessionManager.deleteSession(sessionId);

      expect(sessionManager.getSession(sessionId)).toBeUndefined();
      expect(fs.existsSync(tempFolder)).toBe(false);
    });

    it('should not throw error for non-existent session', () => {
      expect(() => {
        sessionManager.deleteSession('non-existent');
      }).not.toThrow();
    });
  });

  describe('attachedFiles (RAG metadata)', () => {
    it('adds, retrieves, and removes attached file metadata', () => {
      const sessionId = sessionManager.createSession(null);
      sessionManager.initializeSession(sessionId, 'cld', {}, [], {}, 'client');

      expect(sessionManager.getAttachedFiles(sessionId)).toEqual([]);

      sessionManager.addAttachedFile(sessionId, { fileId: 'f1', name: 'a.txt', status: 'ready' });
      sessionManager.addAttachedFile(sessionId, { fileId: 'f2', name: 'b.txt', status: 'processing' });
      expect(sessionManager.getAttachedFiles(sessionId)).toHaveLength(2);

      // Re-adding the same fileId replaces (updates status)
      sessionManager.addAttachedFile(sessionId, { fileId: 'f2', name: 'b.txt', status: 'ready' });
      expect(sessionManager.getAttachedFiles(sessionId)).toHaveLength(2);
      expect(sessionManager.getAttachedFiles(sessionId).find(f => f.fileId === 'f2').status).toBe('ready');

      expect(sessionManager.removeAttachedFile(sessionId, 'f1')).toBe(true);
      expect(sessionManager.removeAttachedFile(sessionId, 'nope')).toBe(false);
      expect(sessionManager.getAttachedFiles(sessionId)).toHaveLength(1);
    });

    it('clears attached files on deleteSession', () => {
      const sessionId = sessionManager.createSession(null);
      sessionManager.initializeSession(sessionId, 'cld', {}, [], {}, 'client');
      sessionManager.addAttachedFile(sessionId, { fileId: 'f1', name: 'a.txt', status: 'ready' });
      sessionManager.deleteSession(sessionId);
      expect(sessionManager.getAttachedFiles(sessionId)).toEqual([]);
    });
  });

  describe('shutdown', () => {
    it('should clean up all sessions', () => {
      const sessionId1 = sessionManager.createSession(null);
      sessionManager.initializeSession(sessionId1, 'cld', {}, [], {}, '');

      const sessionId2 = sessionManager.createSession(null);
      sessionManager.initializeSession(sessionId2, 'sfd', {}, [], {}, '');

      const session1 = sessionManager.getSession(sessionId1);
      const session2 = sessionManager.getSession(sessionId2);
      const temp1 = session1.tempDir;
      const temp2 = session2.tempDir;

      sessionManager.shutdown();

      expect(sessionManager.getSession(sessionId1)).toBeUndefined();
      expect(sessionManager.getSession(sessionId2)).toBeUndefined();
      expect(fs.existsSync(temp1)).toBe(false);
      expect(fs.existsSync(temp2)).toBe(false);
    });
  });

  describe('getSessionTempDir', () => {
    it('should return temp folder path for session', () => {
      const sessionId = sessionManager.createSession(null);
      sessionManager.initializeSession(sessionId, 'cld', {}, [], {}, '');

      const tempFolder = sessionManager.getSessionTempDir(sessionId);
      expect(tempFolder).toBeDefined();
      expect(fs.existsSync(tempFolder)).toBe(true);
    });

    it('should return undefined for non-existent session', () => {
      const tempFolder = sessionManager.getSessionTempDir('non-existent');
      expect(tempFolder).toBeUndefined();
    });
  });

  describe('setWorkerTeardown', () => {
    it('initializes workerTeardown to null on new sessions', () => {
      const sessionId = sessionManager.createSession(null);
      // Bypass getSession() so we don't touch lastActivity in assertions
      // that other tests might extend.
      expect(sessionManager.sessions.get(sessionId).workerTeardown).toBeNull();
    });

    it('installs a teardown hook on the session', () => {
      const sessionId = sessionManager.createSession(null);
      const teardown = () => Promise.resolve();
      sessionManager.setWorkerTeardown(sessionId, teardown);
      expect(sessionManager.sessions.get(sessionId).workerTeardown).toBe(teardown);
    });

    it('is a no-op for an unknown session id', () => {
      expect(() => sessionManager.setWorkerTeardown('nope', () => Promise.resolve())).not.toThrow();
    });
  });

  describe('cleanupStaleSessions', () => {
    // Drive cleanup manually with tight timeouts so we don't depend on the
    // 5-minute interval timer. Isolate the temp base so other parallel test
    // suites' SessionManager.shutdown() (which calls cleanupOrphanedTempDirs)
    // can't reap our session dir as an "orphan".
    let sm;
    let tempBasePath;

    beforeEach(() => {
      tempBasePath = path.join(os.tmpdir(), `sm-cleanup-${randomBytes(8).toString('hex')}`);
      sm = new SessionManager({
        maxSessionAge: 50,
        sessionTimeout: 50,
        disableCleanup: true,
        tempBasePath,
      });
    });

    afterEach(() => {
      sm.shutdown();
      try { fs.rmSync(tempBasePath, { recursive: true, force: true }); } catch { /* already gone */ }
    });

    it('leaves fresh sessions alone', async () => {
      const sessionId = sm.createSession(null);
      sm.initializeSession(sessionId, 'cld', {}, [], {}, '');

      await sm.cleanupStaleSessions();

      expect(sm.sessions.has(sessionId)).toBe(true);
    });

    it('removes sessions that have exceeded the inactivity timeout', async () => {
      const sessionId = sm.createSession(null);
      sm.initializeSession(sessionId, 'cld', {}, [], {}, '');
      const tempDir = sm.sessions.get(sessionId).tempDir;

      await new Promise((r) => setTimeout(r, 80));
      await sm.cleanupStaleSessions();

      expect(sm.sessions.has(sessionId)).toBe(false);
      expect(fs.existsSync(tempDir)).toBe(false);
    });

    it('keeps a session that is being used, however long it stays quiet-free', async () => {
      // This is an INACTIVITY timeout, but nothing on the chat path refreshed lastActivity:
      // WebSocket's #onMessage and #dispatch never touched it, and the orchestrator's own
      // getSession calls run inside the worker, against the worker's SessionManager instance
      // (constructed with disableCleanup: true), so they never reached the instance that reaps.
      // The field stayed at its creation value and the timeout behaved as a hard cap on total
      // session lifetime. On 2026-09-09 that killed four live Stella conversations at 32 to 35
      // minutes of age, each with its socket open and its worker still running, leaving the
      // client waiting for a reply that would never arrive.
      // Its own manager: the shared one in this block sets maxSessionAge to 50ms as well, and
      // that limit reaps on age no matter how active a session is - which is a different rule and
      // the correct behaviour. What is under test here is the inactivity timer alone, so age is
      // given plenty of room and only the timeout is tight.
      const base = path.join(os.tmpdir(), `sm-active-${randomBytes(8).toString('hex')}`);
      const active = new SessionManager({
        maxSessionAge: 60_000,
        sessionTimeout: 50,
        disableCleanup: true,
        tempBasePath: base,
      });
      try {
        const sessionId = active.createSession(null);
        active.initializeSession(sessionId, 'cld', {}, [], {}, '');

        // Several times older than the inactivity timeout, but in use throughout.
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 40));
          expect(active.touch(sessionId)).toBe(true);
          await active.cleanupStaleSessions();
          expect(active.sessions.has(sessionId)).toBe(true);
        }

        // And once it really does fall quiet, it is still reaped.
        await new Promise((r) => setTimeout(r, 80));
        await active.cleanupStaleSessions();
        expect(active.sessions.has(sessionId)).toBe(false);
      } finally {
        active.shutdown();
        try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* already gone */ }
      }
    });

    it('still reaps a session that never falls quiet, once it passes maxSessionAge', async () => {
      // The other half of the rule, and the one that stops `touch` from being a way to make a
      // session immortal. A client that keeps talking - or a worker that keeps streaming a single
      // runaway turn - holds the inactivity timer off indefinitely, so `maxSessionAge` is the only
      // thing left bounding the session. It is measured from `createdAt`, which `touch` must never
      // move.
      //
      // Nothing else in this file would notice if that stopped holding: make `touch` refresh
      // `createdAt` too, or make the sweep skip sessions with recent activity, and every other
      // test here still passes while a stuck session lives forever.
      //
      // The mirror image of the test above. There, age had all the room and only the inactivity
      // timer was tight; here the inactivity timer has all the room, so a kill can only have come
      // from age.
      const base = path.join(os.tmpdir(), `sm-maxage-${randomBytes(8).toString('hex')}`);
      const busy = new SessionManager({
        maxSessionAge: 80,
        sessionTimeout: 60_000,
        disableCleanup: true,
        tempBasePath: base,
      });
      try {
        const sessionId = busy.createSession(null);
        busy.initializeSession(sessionId, 'cld', {}, [], {}, '');
        const createdAt = busy.sessions.get(sessionId).createdAt;

        let reaped = false;
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 20));

          // Busy right up to the moment of the sweep, every time.
          expect(busy.touch(sessionId)).toBe(true);
          expect(busy.sessions.get(sessionId).createdAt).toBe(createdAt);

          await busy.cleanupStaleSessions();
          if (!busy.sessions.has(sessionId)) { reaped = true; break; }
        }

        expect(reaped).toBe(true);
      } finally {
        busy.shutdown();
        try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* already gone */ }
      }
    });

    it('keeps a session whose client is still running a tool', async () => {
      // The gap `touch` alone leaves. A long agent turn is covered because the worker streams
      // while it thinks, but a long *client* turn is silent in both directions: the request goes
      // out, the client works, and nothing is sent until it answers. A tool slower than
      // sessionTimeout was therefore reaped mid-call, and the client's answer arrived for a
      // session that no longer existed.
      const base = path.join(os.tmpdir(), `sm-tool-${randomBytes(8).toString('hex')}`);
      const busy = new SessionManager({
        maxSessionAge: 60_000,
        sessionTimeout: 50,
        disableCleanup: true,
        tempBasePath: base,
      });
      try {
        const sessionId = busy.createSession(null);
        busy.initializeSession(sessionId, 'cld', {}, [], {}, '');

        // A tool that has asked for far longer than the inactivity timeout allows.
        expect(busy.startClientToolCall(sessionId, 'call_1', 30_000)).toBe(true);

        // Silence from both sides throughout — which is exactly what running a tool looks like.
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 40));
          await busy.cleanupStaleSessions();
          expect(busy.sessions.has(sessionId)).toBe(true);
        }

        // The answer ends the hold, and from then on the session is only as alive as its traffic.
        expect(busy.finishClientToolCall(sessionId, 'call_1')).toBe(true);
        await new Promise((r) => setTimeout(r, 80));
        await busy.cleanupStaleSessions();
        expect(busy.sessions.has(sessionId)).toBe(false);
      } finally {
        busy.shutdown();
        try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* already gone */ }
      }
    });

    it('stops protecting a client tool call that blew through its own timeout', async () => {
      // The hold is the tool's declared timeout plus a grace, not an open-ended "a call is
      // outstanding" flag. A client that never answers must not pin the session: past the
      // deadline the worker has already given up and moved on, so the sweep gets its say back.
      const base = path.join(os.tmpdir(), `sm-toolexp-${randomBytes(8).toString('hex')}`);
      const busy = new SessionManager({
        maxSessionAge: 60_000,
        sessionTimeout: 50,
        disableCleanup: true,
        tempBasePath: base,
      });
      try {
        const sessionId = busy.createSession(null);
        busy.initializeSession(sessionId, 'cld', {}, [], {}, '');

        // Already past its deadline, grace included — the client is never going to answer.
        busy.startClientToolCall(sessionId, 'call_1', 10);
        busy.sessions.get(sessionId).clientToolDeadlines.set('call_1', Date.now() - 1);

        await new Promise((r) => setTimeout(r, 80));
        await busy.cleanupStaleSessions();

        expect(busy.sessions.has(sessionId)).toBe(false);
      } finally {
        busy.shutdown();
        try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* already gone */ }
      }
    });

    it('reaps a session at maxSessionAge even mid-tool-call', async () => {
      // The backstop is unconditional: a client tool holds off the inactivity rule and nothing
      // else. Otherwise a tool declaring a long enough timeout would outrank the only limit that
      // is not refreshable.
      const base = path.join(os.tmpdir(), `sm-toolage-${randomBytes(8).toString('hex')}`);
      const busy = new SessionManager({
        maxSessionAge: 60,
        sessionTimeout: 60_000,
        disableCleanup: true,
        tempBasePath: base,
      });
      try {
        const sessionId = busy.createSession(null);
        busy.initializeSession(sessionId, 'cld', {}, [], {}, '');
        busy.startClientToolCall(sessionId, 'call_1', 60_000);

        await new Promise((r) => setTimeout(r, 90));
        await busy.cleanupStaleSessions();

        expect(busy.sessions.has(sessionId)).toBe(false);
      } finally {
        busy.shutdown();
        try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* already gone */ }
      }
    });

    it('refuses to hold a session open for a tool call with no usable timeout', () => {
      const sessionId = sm.createSession(null);
      expect(sm.startClientToolCall(sessionId, 'call_1', undefined)).toBe(false);
      expect(sm.startClientToolCall(sessionId, 'call_2', 0)).toBe(false);
      expect(sm.startClientToolCall(sessionId, 'call_3', -1)).toBe(false);
      expect(sm.sessions.get(sessionId).clientToolDeadlines.size).toBe(0);
    });

    it('client tool bookkeeping is a no-op for an unknown session', () => {
      expect(sm.startClientToolCall('sess_does_not_exist', 'call_1', 30_000)).toBe(false);
      expect(sm.finishClientToolCall('sess_does_not_exist', 'call_1')).toBe(false);
    });

    it('touch reports whether the session exists', () => {
      const sessionId = sm.createSession(null);
      expect(sm.touch(sessionId)).toBe(true);
      expect(sm.touch('sess_does_not_exist')).toBe(false);
    });

    it('awaits workerTeardown before deleting the session or its temp dir', async () => {
      // This is the bug-fix invariant: when a worker is running, the host must
      // keep the bind-mount source alive until the worker has actually exited.
      const sessionId = sm.createSession(null);
      sm.initializeSession(sessionId, 'cld', {}, [], {}, '');
      const tempDir = sm.sessions.get(sessionId).tempDir;

      let dirExistedWhenTeardownCalled = null;
      let sessionStillRegisteredAtTeardown = null;
      let releaseTeardown;
      const teardownGate = new Promise((resolve) => { releaseTeardown = resolve; });

      sm.setWorkerTeardown(sessionId, () => {
        dirExistedWhenTeardownCalled = fs.existsSync(tempDir);
        sessionStillRegisteredAtTeardown = sm.sessions.has(sessionId);
        return teardownGate;
      });

      await new Promise((r) => setTimeout(r, 80));

      const cleanupPromise = sm.cleanupStaleSessions();

      // Let the cleanup loop reach the await on our teardown gate.
      await new Promise((r) => setImmediate(r));

      // Mid-teardown: dir + session must still be present, otherwise a live
      // worker would observe its `/session` bind mount yanked.
      expect(sm.sessions.has(sessionId)).toBe(true);
      expect(fs.existsSync(tempDir)).toBe(true);

      releaseTeardown();
      await cleanupPromise;

      expect(dirExistedWhenTeardownCalled).toBe(true);
      expect(sessionStillRegisteredAtTeardown).toBe(true);
      expect(sm.sessions.has(sessionId)).toBe(false);
      expect(fs.existsSync(tempDir)).toBe(false);
    });

    it('still deletes the session if workerTeardown rejects', async () => {
      const sessionId = sm.createSession(null);
      sm.initializeSession(sessionId, 'cld', {}, [], {}, '');
      const tempDir = sm.sessions.get(sessionId).tempDir;

      sm.setWorkerTeardown(sessionId, () => Promise.reject(new Error('worker exit failed')));

      await new Promise((r) => setTimeout(r, 80));
      await sm.cleanupStaleSessions();

      expect(sm.sessions.has(sessionId)).toBe(false);
      expect(fs.existsSync(tempDir)).toBe(false);
    });

    it('closes the WebSocket if it is still open', async () => {
      const ws = { readyState: 1, close: jest.fn() };
      const sessionId = sm.createSession(ws);
      sm.initializeSession(sessionId, 'cld', {}, [], {}, '');

      await new Promise((r) => setTimeout(r, 80));
      await sm.cleanupStaleSessions();

      expect(ws.close).toHaveBeenCalledWith(1000, 'Session timeout');
    });

    it('does not call ws.close if the WebSocket is already closed', async () => {
      const ws = { readyState: 3, close: jest.fn() };
      const sessionId = sm.createSession(ws);
      sm.initializeSession(sessionId, 'cld', {}, [], {}, '');

      await new Promise((r) => setTimeout(r, 80));
      await sm.cleanupStaleSessions();

      expect(ws.close).not.toHaveBeenCalled();
      // Session should still be removed.
      expect(sm.sessions.has(sessionId)).toBe(false);
    });

    it('skips sessions removed concurrently while awaiting another teardown', async () => {
      // If a session gets deleted out from under us (e.g. WS close handler
      // fires while we are awaiting a slow teardown for a different session),
      // cleanupStaleSessions must not call deleteSession on it again.
      const sessionA = sm.createSession(null);
      sm.initializeSession(sessionA, 'cld', {}, [], {}, '');
      const sessionB = sm.createSession(null);
      sm.initializeSession(sessionB, 'cld', {}, [], {}, '');
      const tempA = sm.sessions.get(sessionA).tempDir;
      const tempB = sm.sessions.get(sessionB).tempDir;

      let releaseA;
      const aGate = new Promise((resolve) => { releaseA = resolve; });
      sm.setWorkerTeardown(sessionA, () => aGate);

      const deleteSpy = jest.spyOn(sm, 'deleteSession');

      await new Promise((r) => setTimeout(r, 80));
      const cleanupPromise = sm.cleanupStaleSessions();

      // Drop into the await on sessionA's teardown.
      await new Promise((r) => setImmediate(r));

      // Simulate a concurrent WS close removing session B.
      sm.deleteSession(sessionB);
      expect(fs.existsSync(tempB)).toBe(false);

      releaseA();
      await cleanupPromise;

      // sessionB should have only been deleted once (the concurrent removal).
      const bDeletes = deleteSpy.mock.calls.filter(([id]) => id === sessionB).length;
      expect(bDeletes).toBe(1);
      // sessionA still got cleaned up after its teardown resolved.
      expect(sm.sessions.has(sessionA)).toBe(false);
      expect(fs.existsSync(tempA)).toBe(false);

      deleteSpy.mockRestore();
    });
  });
});
