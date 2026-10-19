/**
 * Unit tests for bridge permission-broker.
 *
 * Tests cover:
 * - handlePermissionCallback: action parsing, chat validation, dedup
 * - Permission resolution via PermissionGateway
 * - Callback data parsing with colons in permId
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import {
  _testOnly,
  forwardPermissionRequest,
  handlePermissionCallback,
  handlePermissionCallbackDetailed,
  parsePermissionCallback,
} from '../../lib/bridge/permission-broker';
import type { BridgeStore, PermissionGateway, PermissionResolution } from '../../lib/bridge/host';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { OutboundMessage, SendResult } from '../../lib/bridge/types';

// ── Mock Store ──────────────────────────────────────────────

interface MockLink {
  permissionRequestId?: string;
  chatId: string;
  messageId: string;
  resolved: boolean;
  suggestions: string;
  toolName?: string;
  batchId?: string;
}

function createMockStore() {
  const links = new Map<string, MockLink>();

  return {
    links,
    getSetting: () => null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as any),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => null,
    createSession: () => ({ id: '1', working_directory: '', model: '' }),
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
    insertAuditLog: () => {},
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: (link: Omit<MockLink, 'resolved'>) => {
      links.set(link.permissionRequestId!, { ...link, resolved: false });
    },
    getPermissionLink: (id: string) => {
      return links.get(id) ?? null;
    },
    markPermissionLinkResolved: (id: string) => {
      const link = links.get(id);
      if (!link || link.resolved) return false;
      link.resolved = true;
      return true;
    },
    listPendingPermissionLinksByChat: (chatId: string) => {
      return [...links.values()].filter(l => l.chatId === chatId && !l.resolved);
    },
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

// ── Mock Permission Gateway ─────────────────────────────────

function createMockGateway() {
  const resolved: Array<{ id: string; resolution: PermissionResolution }> = [];
  return {
    resolved,
    resolvePendingPermission(id: string, resolution: PermissionResolution) {
      resolved.push({ id, resolution });
      return true;
    },
  };
}

type MockStore = ReturnType<typeof createMockStore>;
type MockGateway = ReturnType<typeof createMockGateway>;

function setupContext(store: MockStore, gateway: MockGateway) {
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  initBridgeContext({
    store: store as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() },
    permissions: gateway,
    lifecycle: {},
  });
}

// ── Tests ───────────────────────────────────────────────────

describe('permission-broker', () => {
  let store: MockStore;
  let gateway: MockGateway;

  beforeEach(() => {
    store = createMockStore();
    gateway = createMockGateway();
    setupContext(store, gateway);
  });

  it('returns false for non-perm callback data', () => {
    assert.equal(handlePermissionCallback('other:data', '123'), false);
  });

  it('returns false when permission link not found', () => {
    assert.equal(handlePermissionCallback('perm:allow:unknown-id', '123'), false);
  });

  it('rejects an unknown action without claiming the permission link', () => {
    store.links.set('perm-unknown', {
      chatId: '123',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    assert.equal(handlePermissionCallback('perm:bogus:perm-unknown', '123'), false);
    // Claiming the link before validating the action would strand the pending
    // promise until the 5-minute timeout and make the request unretryable.
    assert.equal(store.links.get('perm-unknown')!.resolved, false);
    assert.equal(gateway.resolved.length, 0);
  });

  it('returns false when chatId does not match', () => {
    store.links.set('perm-1', {
      chatId: '999',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    assert.equal(handlePermissionCallback('perm:allow:perm-1', '123'), false);
  });

  it('returns false when messageId does not match', () => {
    store.links.set('perm-1', {
      chatId: '123',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    assert.equal(handlePermissionCallback('perm:allow:perm-1', '123', 'wrong-msg'), false);
  });

  it('resolves allow action correctly', () => {
    store.links.set('perm-1', {
      chatId: '123',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    const result = handlePermissionCallback('perm:allow:perm-1', '123');
    assert.ok(result);
    assert.equal(gateway.resolved.length, 1);
    assert.equal(gateway.resolved[0].resolution.behavior, 'allow');
  });

  it('resolves deny action correctly', () => {
    store.links.set('perm-2', {
      chatId: '456',
      messageId: 'msg-2',
      resolved: false,
      suggestions: '',
    });

    const result = handlePermissionCallback('perm:deny:perm-2', '456');
    assert.ok(result);
    assert.equal(gateway.resolved[0].resolution.behavior, 'deny');

    // The message is model-facing: it has to rule out the workaround, or the
    // model reads the denial as "this tool is broken" and reaches the same
    // target with another one. Assert the instruction, not the exact copy.
    const message = gateway.resolved[0].resolution.message as string;
    assert.ok(
      message.includes('Do not try to achieve the same result with a different tool'),
      'deny message must forbid working around the refusal',
    );
    assert.ok(
      message.includes('say why instead of working around'),
      'deny message must leave the model a way to speak up',
    );
  });

  it('prevents duplicate resolution', () => {
    store.links.set('perm-3', {
      chatId: '123',
      messageId: 'msg-3',
      resolved: false,
      suggestions: '',
    });

    const first = handlePermissionCallback('perm:allow:perm-3', '123');
    assert.ok(first);

    const second = handlePermissionCallback('perm:allow:perm-3', '123');
    assert.equal(second, false);
    assert.equal(gateway.resolved.length, 1);
  });

  it('handles permId with colons', () => {
    store.links.set('perm:with:colons', {
      chatId: '123',
      messageId: 'msg-4',
      resolved: false,
      suggestions: '',
    });

    const result = handlePermissionCallback('perm:allow:perm:with:colons', '123');
    assert.ok(result);
    assert.equal(gateway.resolved[0].id, 'perm:with:colons');
  });

  it('allow_session passes suggestions as updatedPermissions', () => {
    const suggestions = JSON.stringify([{ type: 'allow', toolName: 'Bash' }]);
    store.links.set('perm-4', {
      chatId: '123',
      messageId: 'msg-5',
      resolved: false,
      suggestions,
    });

    const result = handlePermissionCallback('perm:allow_session:perm-4', '123');
    assert.ok(result);
    assert.equal(gateway.resolved[0].resolution.behavior, 'allow');
    assert.ok((gateway.resolved[0].resolution as any).updatedPermissions);
  });
});

// ── Feishu batch cards ──────────────────────────────────────

function createMockFeishuAdapter() {
  const sent: OutboundMessage[] = [];
  const updates: Array<{ messageId: string; message: OutboundMessage }> = [];
  let seq = 0;

  const adapter = {
    channelType: 'feishu',
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    consumeOne: async () => null,
    send: async (message: OutboundMessage): Promise<SendResult> => {
      sent.push(message);
      seq++;
      return { ok: true, messageId: `msg-${seq}` };
    },
    updateMessage: async (messageId: string, message: OutboundMessage): Promise<SendResult> => {
      updates.push({ messageId, message });
      return { ok: true, messageId };
    },
    validateConfig: () => null,
    isAuthorized: () => true,
  } as unknown as BaseChannelAdapter;

  return { adapter, sent, updates };
}

function settle(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('permission-broker - feishu batch cards', () => {
  let store: MockStore;
  let gateway: MockGateway;

  beforeEach(() => {
    _testOnly.resetBatchState();
    store = createMockStore();
    gateway = createMockGateway();
    setupContext(store, gateway);
  });

  it('sends a full card first, then one editable "还有 N 条" card', async () => {
    const { adapter, sent, updates } = createMockFeishuAdapter();
    const address = { channelType: 'feishu', chatId: 'batch-chat-1' };

    await forwardPermissionRequest(adapter, address, 'batch-p1', 'Bash', { command: 'ls' });
    assert.equal(sent.length, 1, 'first request is a full individual card');
    assert.equal(sent[0].inlineButtons![0][0].callbackData, 'perm:allow:batch-p1');
    assert.equal(sent[0].cardTitle, undefined, 'first card keeps the default title');

    const first = store.links.get('batch-p1')!;
    const batchId = first.batchId!;
    assert.ok(batchId, 'first link is stamped with a batch id');

    await forwardPermissionRequest(adapter, address, 'batch-p2', 'Edit', { file_path: '/tmp/a' });
    assert.equal(sent.length, 2, 'second request creates the batch card');
    assert.equal(sent[1].cardTitle, '还有 1 条待批准');
    assert.ok(sent[1].text.includes('还有 1 条待批准'));
    assert.deepEqual(
      sent[1].inlineButtons!.flat().map((btn) => btn.callbackData),
      [
        `perm:batch:${batchId}:allow`,
        `perm:batch:${batchId}:allow_session`,
        `perm:batch:${batchId}:deny`,
        `perm:batch:${batchId}:deny_stop`,
      ],
    );

    const second = store.links.get('batch-p2')!;
    assert.equal(second.batchId, batchId);
    assert.equal(second.messageId, 'msg-2', 'later links point at the batch card');

    await forwardPermissionRequest(adapter, address, 'batch-p3', 'Read', { file_path: '/tmp/b' });
    assert.equal(sent.length, 2, 'third request edits instead of sending');
    await settle();

    assert.ok(updates.length >= 1, 'batch card was edited');
    const latest = updates.at(-1)!;
    assert.equal(latest.messageId, 'msg-2');
    assert.equal(latest.message.cardTitle, '还有 2 条待批准');
    assert.equal(store.links.get('batch-p3')!.messageId, 'msg-2');
  });

  it('resolves every request in the batch and retires the card', async () => {
    const { adapter, updates } = createMockFeishuAdapter();
    const address = { channelType: 'feishu', chatId: 'batch-chat-2' };

    await forwardPermissionRequest(adapter, address, 'batch-q1', 'Bash', {});
    await forwardPermissionRequest(adapter, address, 'batch-q2', 'Edit', {});
    await forwardPermissionRequest(adapter, address, 'batch-q3', 'Read', {});
    await settle();

    const batchId = store.links.get('batch-q1')!.batchId!;
    const outcome = handlePermissionCallbackDetailed(
      `perm:batch:${batchId}:allow`,
      address.chatId,
      'msg-2',
    );

    assert.equal(outcome.handled, true);
    assert.equal(outcome.kind, 'batch');
    assert.equal(outcome.resolvedCount, 3);
    assert.equal(outcome.pendingCount, 3);
    assert.deepEqual(
      gateway.resolved.map((entry) => entry.id).sort(),
      ['batch-q1', 'batch-q2', 'batch-q3'],
    );
    assert.ok(store.links.get('batch-q1')!.resolved);
    assert.ok(store.links.get('batch-q2')!.resolved);
    assert.ok(store.links.get('batch-q3')!.resolved);

    await settle();
    const latest = updates.at(-1)!;
    assert.equal(latest.message.cardTitle, '本批请求已处理');
    assert.equal(latest.message.inlineButtons, undefined, 'resolved card has no buttons');
    assert.ok(
      updates.some((entry) =>
        entry.messageId === 'msg-1' && entry.message.cardTitle === '本批请求已处理',
      ),
      'the first full card is retired together with the batch',
    );
  });

  it('rejects a batch callback from the wrong message', async () => {
    const { adapter } = createMockFeishuAdapter();
    const address = { channelType: 'feishu', chatId: 'batch-chat-3' };

    await forwardPermissionRequest(adapter, address, 'batch-r1', 'Bash', {});
    await forwardPermissionRequest(adapter, address, 'batch-r2', 'Edit', {});
    const batchId = store.links.get('batch-r1')!.batchId!;

    const outcome = handlePermissionCallbackDetailed(
      `perm:batch:${batchId}:deny`,
      address.chatId,
      'some-other-message',
    );

    assert.equal(outcome.handled, false);
    assert.equal(gateway.resolved.length, 0);
    assert.equal(store.links.get('batch-r1')!.resolved, false);
    assert.equal(store.links.get('batch-r2')!.resolved, false);
  });

  it('does not let an old batch card resolve a newer batch', async () => {
    const { adapter } = createMockFeishuAdapter();
    const address = { channelType: 'feishu', chatId: 'batch-chat-4' };

    await forwardPermissionRequest(adapter, address, 'batch-s1', 'Bash', {});
    await forwardPermissionRequest(adapter, address, 'batch-s2', 'Edit', {});
    const oldBatchId = store.links.get('batch-s1')!.batchId!;

    const resolved = handlePermissionCallbackDetailed(
      `perm:batch:${oldBatchId}:allow`,
      address.chatId,
      'msg-2',
    );
    assert.equal(resolved.resolvedCount, 2);

    await forwardPermissionRequest(adapter, address, 'batch-s3', 'Read', {});
    const newBatchId = store.links.get('batch-s3')!.batchId!;
    assert.notEqual(newBatchId, oldBatchId);

    const stale = handlePermissionCallbackDetailed(
      `perm:batch:${oldBatchId}:allow`,
      address.chatId,
    );
    assert.equal(stale.handled, false);
    assert.equal(store.links.get('batch-s3')!.resolved, false);
  });

  it('serializes concurrent forwards into one full card and one batch card', async () => {
    const { adapter, sent } = createMockFeishuAdapter();
    const address = { channelType: 'feishu', chatId: 'batch-chat-5' };

    await Promise.all([
      forwardPermissionRequest(adapter, address, 'batch-t1', 'Bash', {}),
      forwardPermissionRequest(adapter, address, 'batch-t2', 'Edit', {}),
      forwardPermissionRequest(adapter, address, 'batch-t3', 'Read', {}),
      forwardPermissionRequest(adapter, address, 'batch-t4', 'Grep', {}),
    ]);
    await settle();

    assert.equal(sent.length, 2, 'one full card + one batch card, no per-request spam');
    const ids = ['batch-t1', 'batch-t2', 'batch-t3', 'batch-t4'].map(
      (id) => store.links.get(id)!.batchId,
    );
    assert.ok(ids.every((id) => id === ids[0]), 'all requests share one batch id');
    assert.equal(store.links.get('batch-t1')!.messageId, 'msg-1');
    for (const id of ['batch-t2', 'batch-t3', 'batch-t4']) {
      assert.equal(store.links.get(id)!.messageId, 'msg-2');
    }
  });

  it('allow_session all forwards each request suggestions', async () => {
    const { adapter } = createMockFeishuAdapter();
    const address = { channelType: 'feishu', chatId: 'batch-chat-6' };
    const suggestionsA = [{ type: 'allow', toolName: 'Bash' }];
    const suggestionsB = [{ type: 'allow', toolName: 'Edit' }];

    await forwardPermissionRequest(adapter, address, 'batch-u1', 'Bash', {}, 's1', suggestionsA);
    await forwardPermissionRequest(adapter, address, 'batch-u2', 'Edit', {}, 's1', suggestionsB);
    const batchId = store.links.get('batch-u1')!.batchId!;

    const outcome = handlePermissionCallbackDetailed(
      `perm:batch:${batchId}:allow_session`,
      address.chatId,
      'msg-2',
    );
    assert.equal(outcome.resolvedCount, 2);

    assert.deepEqual(
      gateway.resolved.map((entry) => entry.resolution.updatedPermissions),
      [suggestionsA, suggestionsB],
    );
  });

  it('deny_stop all denies the whole batch and reports the aborting action', async () => {
    const { adapter } = createMockFeishuAdapter();
    const address = { channelType: 'feishu', chatId: 'batch-chat-7' };

    await forwardPermissionRequest(adapter, address, 'batch-v1', 'Bash', {});
    await forwardPermissionRequest(adapter, address, 'batch-v2', 'Edit', {});
    const batchId = store.links.get('batch-v1')!.batchId!;

    const outcome = handlePermissionCallbackDetailed(
      `perm:batch:${batchId}:deny_stop`,
      address.chatId,
      'msg-2',
    );

    assert.equal(outcome.handled, true);
    assert.equal(outcome.action, 'deny_stop');
    assert.equal(outcome.resolvedCount, 2);
    assert.deepEqual(
      gateway.resolved.map((entry) => entry.resolution.behavior),
      ['deny', 'deny'],
    );
    assert.ok(
      gateway.resolved.every((entry) =>
        String(entry.resolution.message).includes('Do not try to achieve the same result'),
      ),
    );
  });

  it('parses deny_stop batch callbacks without confusing them with per-request ids', () => {
    const parsed = parsePermissionCallback('perm:batch:batch-123:deny_stop');
    assert.equal(parsed?.isBatch, true);
    assert.equal(parsed?.batchId, 'batch-123');
    assert.equal(parsed?.action, 'deny_stop');

    const individual = parsePermissionCallback('perm:allow:perm:with:colons');
    assert.equal(individual?.isBatch, false);
    assert.equal(individual?.permissionRequestId, 'perm:with:colons');
  });
});
