/**
 * Unit tests for turn cancellation and the per-session queue.
 *
 * The incident these cover: a normal message queued behind a long turn, then
 * `/stop` was issued. The queued message used to start a fresh turn after the
 * abort, making it look like the agent restarted itself.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import type { BridgeStore, PermissionGateway } from '../../lib/bridge/host';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { ChannelBinding, InboundMessage, OutboundMessage, SendResult } from '../../lib/bridge/types';

const SESSION_ID = 'session-stop-queue';
const CHAT_ID = 'chat-stop-queue';

function createStore() {
  const audit: any[] = [];
  const binding: ChannelBinding = {
    id: 'binding-1',
    channelType: 'feishu',
    chatId: CHAT_ID,
    codepilotSessionId: SESSION_ID,
    sdkSessionId: 'sdk-1',
    workingDirectory: '/tmp',
    model: '',
    mode: 'code',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const store = {
    audit,
    getSetting: () => null,
    getChannelBinding: () => binding,
    upsertChannelBinding: () => binding,
    updateChannelBinding: () => {},
    listChannelBindings: () => [binding],
    getSession: () => null,
    createSession: () => ({ id: SESSION_ID, working_directory: '/tmp', model: '' }),
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: (entry: any) => { audit.push(entry); },
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: () => {},
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
  return store;
}

function createAdapter() {
  const sent: OutboundMessage[] = [];
  const adapter = {
    channelType: 'feishu',
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    consumeOne: async () => null,
    send: async (message: OutboundMessage): Promise<SendResult> => {
      sent.push(message);
      return { ok: true, messageId: `out-${sent.length}` };
    },
    validateConfig: () => null,
    isAuthorized: () => true,
    acknowledgeUpdate: () => {},
  } as unknown as BaseChannelAdapter;
  return { adapter, sent };
}

type TestStore = ReturnType<typeof createStore>;

function setup(store: TestStore) {
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  initBridgeContext({
    store: store as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() },
    permissions: { resolvePendingPermission: () => false } as PermissionGateway,
    lifecycle: {},
  });
}

function inbound(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    address: { channelType: 'feishu', chatId: CHAT_ID, userId: 'ou_user' },
    text,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('bridge-manager stop and queue', () => {
  let store: TestStore;
  let adapter: BaseChannelAdapter;
  let sent: OutboundMessage[];
  let manager: typeof import('../../lib/bridge/bridge-manager')['_testOnly'];

  beforeEach(async () => {
    store = createStore();
    setup(store);
    const created = createAdapter();
    adapter = created.adapter;
    sent = created.sent;

    const mod = await import('../../lib/bridge/bridge-manager');
    manager = mod._testOnly;
    const state = manager.getState();
    state.activeTasks.clear();
    state.activeTaskStartedAt.clear();
    state.sessionEpochs.clear();
    state.queuedTurns.clear();
    state.sessionLocks.clear();
  });

  it('normalizes full-width slash and zero-width characters for commands', () => {
    assert.equal(manager.normalizeCommandText('／stop'), '/stop');
    assert.equal(manager.normalizeCommandText('\u200B/stop'), '/stop');
    assert.equal(manager.normalizeCommandText('   /stop  '), '/stop');
  });

  it('summarizes tool inputs and redacts obvious secrets', () => {
    const summary = manager.summarizeToolInput('Bash', {
      command: 'curl --token supersecret -H "Authorization: Bearer abc123" https://example.com',
    });
    assert.ok(summary?.includes('curl'));
    assert.ok(!summary?.includes('supersecret'), 'token value must be redacted');
    assert.ok(!summary?.includes('abc123'), 'authorization value must be redacted');

    assert.equal(
      manager.summarizeToolInput('WebFetch', { url: 'https://example.com/a' }),
      'https://example.com/a',
    );
    assert.equal(
      manager.summarizeToolInput('Read', { file_path: '/tmp/secret.txt' }),
      '/tmp/secret.txt',
    );
  });

  it('classifies denied and timed-out tool results', () => {
    assert.equal(
      manager.classifyToolFailure('The user declined this action from their chat client.', true)?.kind,
      'denied',
    );
    assert.equal(
      manager.classifyToolFailure('Permission request timed out', true)?.kind,
      'timeout',
    );
    assert.equal(
      manager.classifyToolFailure('HTTP 403 Forbidden', true)?.kind,
      'tool_error',
    );
    assert.equal(manager.classifyToolFailure('ok', false), undefined);
  });

  it('/stop aborts the active turn, bumps the epoch, and reports queued messages', async () => {
    const state = manager.getState();
    const controller = new AbortController();
    state.activeTasks.set(SESSION_ID, controller);
    state.activeTaskStartedAt.set(SESSION_ID, Date.now() - 5_000);
    state.queuedTurns.set(SESSION_ID, 2);
    state.sessionEpochs.set(SESSION_ID, 3);

    await manager.handleMessage(adapter, inbound('/stop'));

    assert.equal(controller.signal.aborted, true);
    assert.equal(state.activeTasks.has(SESSION_ID), false);
    assert.equal(state.sessionEpochs.get(SESSION_ID), 4);
    assert.ok(
      sent.some((message) => message.text.includes('Cancelled 2 queued message(s)')),
      'the stop confirmation should mention the dropped queue',
    );
    assert.equal(store.audit.some((entry) => entry.summary?.includes('[CMD] /stop')), true);
  });

  it('drops a queued message whose epoch was invalidated by /stop', async () => {
    const state = manager.getState();
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    state.sessionLocks.set(SESSION_ID, blocker);

    manager.queueRegularTurn(adapter, inbound('好了，报告进展'));
    assert.equal(state.queuedTurns.get(SESSION_ID), 1);

    // This is what /stop does before aborting the active turn.
    state.sessionEpochs.set(SESSION_ID, 1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(state.queuedTurns.get(SESSION_ID), 0);
    assert.ok(
      sent.some((message) => message.text.includes('Queued message cancelled')),
      'the cancelled message must be acknowledged, not silently run',
    );
    assert.ok(
      store.audit.some((entry) => entry.summary?.includes('[DROPPED]')),
      'dropped queued messages must be audited',
    );
  });

  it('rejects a message when the session queue is full', async () => {
    const state = manager.getState();
    state.queuedTurns.set(SESSION_ID, 3);

    manager.queueRegularTurn(adapter, inbound('another message'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(state.queuedTurns.get(SESSION_ID), 3);
    assert.ok(
      sent.some((message) => message.text.includes('queue full')),
      'overflow should be rejected with guidance',
    );
  });
});
