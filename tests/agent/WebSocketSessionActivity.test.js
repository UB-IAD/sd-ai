/**
 * Regression guard: a session that is in use must not be reaped by the inactivity sweep.
 *
 * `sessionTimeout` is an inactivity timeout, but nothing on the chat path refreshed
 * `lastActivity`: #onMessage and #dispatch never touched it, and the orchestrator's own
 * getSession calls run in the worker, against the worker's SessionManager instance
 * (disableCleanup: true) rather than the instance that sweeps. The field kept its creation
 * value, so the timeout acted as a hard cap on total session lifetime and killed live
 * conversations at 30-35 minutes with their sockets open and their workers still running.
 *
 * Two kinds of activity have to reach the reaping instance, and they arrive differently:
 *   - traffic, in either direction, which is what `touch` covers; and
 *   - a client-side tool call, which is silent in both directions for as long as it runs
 *     and so is covered by an explicit hold instead.
 *
 * WorkerSpawner is mocked, as in WebSocketAuthGate.test.js: these tests are about the
 * bookkeeping, and a real worker would make them slow and flaky.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';

const fakeWorkers = [];
function makeFakeWorker() {
  const worker = new EventEmitter();
  worker.connected = true;
  worker.kill = jest.fn(() => worker.emit('exit', 0, 'SIGKILL'));
  // Exits on request, so the teardown path in cleanupStaleSessions doesn't sit out its
  // SIGKILL fallback on every test that reaps a session.
  worker.send = jest.fn((msg) => { if (msg?.type === 'shutdown') setImmediate(() => worker.emit('exit', 0, null)); });
  worker.pid = undefined;
  fakeWorkers.push(worker);
  return worker;
}

class FakeSandboxUnavailableError extends Error {}

jest.unstable_mockModule('../../agent/WorkerSpawner.js', () => ({
  WorkerSpawner: {
    CONTAINER_SESSION_PATH: '/session',
    spawn: jest.fn(async () => makeFakeWorker()),
  },
  SandboxUnavailableError: FakeSandboxUnavailableError,
}));

const { WebSocketHandler } = await import('../../agent/WebSocket.js');
const { SessionManager } = await import('../../agent/utilities/SessionManager.js');

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
  }

  send(payload) { this.sent.push(JSON.parse(payload)); }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 3; }

  async receive(message) {
    this.emit('message', Buffer.from(JSON.stringify(message)));
    await new Promise(resolve => setImmediate(resolve));
  }
}

// Long enough for the mocked spawn promise to settle and its relay to be wired up.
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

describe('session activity', () => {
  let sessionManager;
  let ws;
  let sessionId;

  beforeEach(() => {
    process.env.AUTHENTICATION_KEY = 'the-key';
    // Tight inactivity, roomy age: what is under test is the inactivity rule.
    sessionManager = new SessionManager({
      maxSessionAge: 60_000,
      sessionTimeout: 60,
      disableCleanup: true,
    });
    ws = new FakeWebSocket();
    new WebSocketHandler(ws, sessionManager);
    sessionId = ws.sent.find(m => m.type === 'session_created').sessionId;
  });

  afterEach(() => {
    delete process.env.AUTHENTICATION_KEY;
    sessionManager.shutdown();
    fakeWorkers.length = 0;
  });

  const initialize = () => ws.receive({
    type: 'initialize_session',
    sessionId,
    authenticationKey: 'the-key',
    clientProduct: 'test', clientVersion: '1.0', clientId: 'c1',
    mode: 'cld', model: {}, tools: [],
  });

  const lastActivity = () => sessionManager.sessions.get(sessionId).lastActivity;
  const deadlines = () => sessionManager.sessions.get(sessionId).clientToolDeadlines;

  describe('traffic', () => {
    it('counts a client message as activity', async () => {
      await initialize();
      const before = lastActivity();

      await new Promise(r => setTimeout(r, 20));
      await ws.receive({ type: 'chat', sessionId, message: 'hello' });

      expect(lastActivity()).toBeGreaterThan(before);
    });

    it('counts worker traffic as activity, with the client silent', async () => {
      // The half that matters for a long agent turn: the client sends one message and then
      // waits for minutes while the worker streams. Touching only on inbound client
      // messages would still let a single slow turn age past the timeout mid-flight.
      await initialize();
      await settle();
      const before = lastActivity();

      await new Promise(r => setTimeout(r, 20));
      fakeWorkers[0].emit('message', { type: 'worker_error', error: 'still going' });
      await settle();

      expect(lastActivity()).toBeGreaterThan(before);
    });

    it('does not count a frame that was refused before initialization', async () => {
      // The hold on an unauthenticated socket has to stay bounded: a client that has not
      // presented the key cannot keep its session record alive by talking.
      const before = lastActivity();

      await new Promise(r => setTimeout(r, 20));
      await ws.receive({ type: 'chat', sessionId, message: 'too early' });

      expect(lastActivity()).toBe(before);
    });

    it('does not count a frame that failed validation', async () => {
      await initialize();
      const before = lastActivity();

      await new Promise(r => setTimeout(r, 20));
      await ws.receive({ type: 'not_a_real_message_type', sessionId });

      expect(lastActivity()).toBe(before);
    });
  });

  describe('client tool calls', () => {
    // What the worker sends when a tool the client owns is invoked; `timeout` is the tool's
    // own declared timeout, which DynamicToolProvider puts on the wire.
    const toolRequest = (timeout) => ({
      type: 'to_client',
      message: { type: 'tool_call_request', sessionId, callId: 'call_1', toolName: 'slow_tool', arguments: {}, timeout },
    });

    it('holds the session open for as long as the tool asked for', async () => {
      await initialize();
      await settle();

      fakeWorkers[0].emit('message', toolRequest(30_000));
      await settle();

      expect(deadlines().get('call_1')).toBeGreaterThan(Date.now() + 30_000);

      // Silence in both directions for several times the inactivity timeout — which is
      // precisely what a client running a slow tool looks like from here.
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 50));
        await sessionManager.cleanupStaleSessions();
        expect(sessionManager.sessions.has(sessionId)).toBe(true);
      }
    });

    it('releases the hold when the client answers', async () => {
      await initialize();
      await settle();
      fakeWorkers[0].emit('message', toolRequest(30_000));
      await settle();

      await ws.receive({ type: 'tool_call_response', sessionId, callId: 'call_1', result: 'done' });

      // Released rather than left to lapse: a tool that declares thirty seconds and returns
      // in one must not keep the session alive for the other twenty-nine.
      expect(deadlines().size).toBe(0);

      await new Promise(r => setTimeout(r, 100));
      await sessionManager.cleanupStaleSessions();
      expect(sessionManager.sessions.has(sessionId)).toBe(false);
    });

    it('takes no hold when the request was never sent to the client', async () => {
      // A closed socket means no client is running anything, whatever the worker thinks.
      await initialize();
      await settle();
      ws.readyState = 3;

      fakeWorkers[0].emit('message', toolRequest(30_000));
      await settle();

      expect(deadlines().size).toBe(0);
    });
  });
});
