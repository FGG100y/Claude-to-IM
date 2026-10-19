/**
 * Unit tests for Feishu permission card rendering.
 *
 * The adapter delegates card layout to these pure builders; the broker owns
 * the callback semantics. Batch cards must opt into `update_multi` so Feishu
 * lets the bot patch the card as the pending count grows.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFinalCardJson,
  buildPermissionActionCard,
  buildPermissionButtonCard,
  buildToolProgressMarkdown,
} from '../../lib/bridge/markdown/feishu';
import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter';
import type { ToolCallInfo } from '../../lib/bridge/types';

function tool(
  id: string,
  name: string,
  status: ToolCallInfo['status'],
  extra: Partial<ToolCallInfo> = {},
): ToolCallInfo {
  return { id, name, status, ...extra };
}

describe('feishu permission cards', () => {
  it('individual card keeps per-request callbacks', () => {
    const card = JSON.parse(buildPermissionButtonCard('Prompt', 'perm-1', 'chat-1'));

    assert.equal(card.config.update_multi, true, 'cards must be patchable');
    assert.equal(card.header.title.content, 'Permission Required');

    const callbacks = card.body.elements
      .filter((element: any) => element.tag === 'column_set')
      .flatMap((element: any) => element.columns)
      .map((column: any) => column.elements[0].value.callback_data);

    assert.deepEqual(callbacks, [
      'perm:allow:perm-1',
      'perm:allow_session:perm-1',
      'perm:deny:perm-1',
      'perm:deny_stop:perm-1',
    ]);

    const buttonTypes = card.body.elements
      .filter((element: any) => element.tag === 'column_set')
      .flatMap((element: any) => element.columns)
      .map((column: any) => column.elements[0].type);
    assert.deepEqual(buttonTypes, ['primary', 'default', 'danger', 'danger']);
  });

  it('batch card renders the four bulk actions and its title', () => {
    const card = JSON.parse(buildPermissionActionCard(
      '还有 2 条待批准',
      [
        [
          { text: 'Allow all', callbackData: 'perm:batch:b-1:allow' },
          { text: 'Allow session all', callbackData: 'perm:batch:b-1:allow_session' },
          { text: 'Deny all', callbackData: 'perm:batch:b-1:deny' },
        ],
        [
          { text: 'Deny all & stop', callbackData: 'perm:batch:b-1:deny_stop' },
        ],
      ],
      'chat-1',
      {
        title: '还有 2 条待批准',
        template: 'orange',
        expiryNote: 'expires in 5 minutes',
      },
    ));

    assert.equal(card.header.title.content, '还有 2 条待批准');
    assert.equal(card.header.template, 'orange');
    assert.equal(card.config.update_multi, true);

    const buttons = card.body.elements
      .filter((element: any) => element.tag === 'column_set')
      .flatMap((element: any) => element.columns)
      .map((column: any) => column.elements[0]);

    assert.deepEqual(
      buttons.map((button: any) => button.text.content),
      ['Allow all', 'Allow session all', 'Deny all', 'Deny all & stop'],
    );
    assert.deepEqual(
      buttons.map((button: any) => button.value.callback_data),
      [
        'perm:batch:b-1:allow',
        'perm:batch:b-1:allow_session',
        'perm:batch:b-1:deny',
        'perm:batch:b-1:deny_stop',
      ],
    );
    assert.equal(buttons[0].type, 'primary');
    assert.equal(buttons[1].type, 'default');
    assert.equal(buttons[2].type, 'danger');
    assert.equal(buttons[3].type, 'danger');
  });

  it('resolved batch card can be rendered without buttons', () => {
    const card = JSON.parse(buildPermissionActionCard(
      '本批请求已处理',
      [],
      'chat-1',
      { title: '本批请求已处理', showButtons: false },
    ));

    assert.equal(card.header.title.content, '本批请求已处理');
    assert.equal(
      card.body.elements.filter((element: any) => element.tag === 'column_set').length,
      0,
    );
  });

  it('adapter patches the batch card in place', async () => {
    const adapter = new FeishuAdapter();
    let captured: any;
    (adapter as any).restClient = {
      im: {
        message: {
          patch: async (payload: any) => {
            captured = payload;
            return { code: 0, msg: 'success', data: { message_id: 'msg-9' } };
          },
        },
      },
    };

    const result = await adapter.updateMessage('msg-9', {
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '<b>还有 2 条待批准</b>',
      parseMode: 'HTML',
      cardTitle: '还有 2 条待批准',
      inlineButtons: [
        [
          { text: 'Allow all', callbackData: 'perm:batch:b-9:allow' },
          { text: 'Allow session all', callbackData: 'perm:batch:b-9:allow_session' },
          { text: 'Deny all', callbackData: 'perm:batch:b-9:deny' },
        ],
        [
          { text: 'Deny all & stop', callbackData: 'perm:batch:b-9:deny_stop' },
        ],
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(captured.path.message_id, 'msg-9');

    const card = JSON.parse(captured.data.content);
    assert.equal(card.config.update_multi, true, 'patch requires update_multi');
    assert.equal(card.header.title.content, '还有 2 条待批准');
    assert.ok(
      card.body.elements.some((element: any) =>
        element.tag === 'markdown' && element.content.includes('**还有 2 条待批准**'),
      ),
      'HTML from the broker is converted to card markdown',
    );

    const callbacks = card.body.elements
      .filter((element: any) => element.tag === 'column_set')
      .flatMap((element: any) => element.columns)
      .map((column: any) => column.elements[0].value.callback_data);
    assert.deepEqual(callbacks, [
      'perm:batch:b-9:allow',
      'perm:batch:b-9:allow_session',
      'perm:batch:b-9:deny',
      'perm:batch:b-9:deny_stop',
    ]);
  });
});

describe('feishu tool progress summary', () => {
  it('collapses many successful calls into one count and no tool names', () => {
    const tools = Array.from({ length: 30 }, (_, index) =>
      tool(`search-${index}`, 'WebSearch', 'complete'),
    );

    const summary = buildToolProgressMarkdown(tools);
    assert.equal(summary, '✅ 已完成 30 次工具调用');
    assert.ok(!summary.includes('WebSearch'), 'successful tool names should not be listed');
  });

  it('groups running calls by tool name', () => {
    const summary = buildToolProgressMarkdown([
      tool('1', 'WebSearch', 'running'),
      tool('2', 'WebSearch', 'running'),
      tool('3', 'WebFetch', 'running'),
      tool('4', 'Bash', 'complete'),
    ]);

    assert.ok(summary.includes('🔄 进行中：WebSearch ×2 · WebFetch ×1'));
    assert.ok(summary.includes('✅ 已完成 1 次工具调用'));
  });

  it('shows what failed and why, capped at three details', () => {
    const errors: ToolCallInfo[] = [
      tool('1', 'Bash', 'error', {
        inputSummary: 'rm -rf /tmp/x',
        errorKind: 'denied',
        errorMessage: 'The user declined this action',
      }),
      tool('2', 'WebFetch', 'error', {
        inputSummary: 'https://example.com/private',
        errorKind: 'tool_error',
        errorMessage: 'HTTP 403',
      }),
      tool('3', 'Read', 'error', {
        inputSummary: '/home/user/.ssh/id_rsa',
        errorKind: 'timeout',
        errorMessage: 'Permission request timed out',
      }),
      tool('4', 'Bash', 'error', {
        inputSummary: 'curl secret',
        errorKind: 'policy',
        errorMessage: 'blocked by policy',
      }),
      tool('5', 'Bash', 'error', {
        inputSummary: 'cat /etc/shadow',
        errorKind: 'denied',
        errorMessage: 'permission denied',
      }),
    ];

    const summary = buildToolProgressMarkdown(errors);
    assert.ok(summary.includes('…另有 2 条失败未展开'));
    assert.ok(summary.includes('❌ Read `/home/user/.ssh/id_rsa` — 权限超时'));
    assert.ok(summary.includes('❌ Bash `curl secret` — 策略拒绝'));
    assert.ok(summary.includes('❌ Bash `cat /etc/shadow` — 用户拒绝'));
    assert.ok(!summary.includes('rm -rf /tmp/x'), 'older failures are folded away');
    assert.ok(!summary.includes('https://example.com/private'), 'older failures are folded away');
  });

  it('renders a final card with the summary as a separate notation element', () => {
    const card = JSON.parse(buildFinalCardJson(
      '答案正文',
      [tool('1', 'Bash', 'error', {
        inputSummary: 'cat /etc/shadow',
        errorKind: 'denied',
        errorMessage: 'permission denied',
      })],
      { status: 'completed', elapsed: '3s' },
    ));

    const markdown = card.body.elements.filter((element: any) => element.tag === 'markdown');
    assert.ok(markdown.some((element: any) => element.content === '答案正文'));
    assert.ok(markdown.some((element: any) =>
      element.text_size === 'notation'
      && element.content.includes('❌ Bash `cat /etc/shadow` — 用户拒绝'),
    ));
  });
});

describe('feishu adapter health', () => {
  it('reports WS readyState instead of only the adapter running flag', () => {
    const adapter = new FeishuAdapter();
    (adapter as any).running = true;
    (adapter as any).wsClient = {
      wsConfig: { getWSInstance: () => ({ readyState: 1 }) },
    };

    const health = adapter.getHealth();
    assert.equal(health.connected, true);
    assert.equal(health.detail, 'ws-readyState=1');

    (adapter as any).wsClient = {
      wsConfig: { getWSInstance: () => ({ readyState: 3 }) },
    };
    assert.equal(adapter.getHealth().connected, false);
  });
});
