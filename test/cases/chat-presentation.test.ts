import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatAttachment, ChatDelta, ChatItemKind, HANDOFF_ATTACHMENT_PREFIX, LiveChatState, chatDelta,
  chatTurnFailure, deliverablesOf, displayItemsOf, handoffPathOf, permissionSelectOf, todoItemsOf,
} from '../../entry/src/main/ets/core/ChatPresentation.ts';
import {
  ChatHistory, HistoryEntry, PermissionCatalog, PermissionOption, SessionEvent, TodoItem,
  WorkspaceEvent,
} from '../../entry/src/main/ets/core/Models.ts';
import { JsonAccess } from '../../entry/src/main/ets/core/JsonAccess.ts';

/**
 * 聊天页呈现模型的测试 —— 移植自原工程 `ChatPresentationTest.kt`。
 *
 * 为什么这份测试值得留：呈现模型是「服务端事件 → 界面能看到的一行行」之间唯一的接缝，
 * 它出的错在屏幕上全部表现为「少了一条 / 内容不对」，很难当场看出是哪一步错了。
 * 下面几条用例对应的全是**用户真机报过的 bug**（只发图的消息消失、限流后一直转圈、
 * 交接图变成一堆路径、上下文正文被切碎）。
 */

function entry(type: string, seq: number, dataJson: string, viewJson: string | null = null): HistoryEntry {
  const row: HistoryEntry = new HistoryEntry();
  const event: SessionEvent = new SessionEvent();
  event.type = type;
  event.seq = seq;
  event.time = seq;
  event.data = JsonAccess.parse(dataJson);
  row.event = event;
  row.view = viewJson === null ? null : JsonAccess.parse(viewJson);
  return row;
}

function history(events: HistoryEntry[], projectionsJson: string | null = null): ChatHistory {
  const value: ChatHistory = new ChatHistory();
  value.events = events;
  value.hasMore = false;
  value.projections = projectionsJson === null ? null : JsonAccess.parse(projectionsJson);
  return value;
}

function wsEvent(type: string, dataJson: string, time: number = 1): WorkspaceEvent {
  const event: WorkspaceEvent = new WorkspaceEvent();
  event.id = `${type}-${time}`;
  event.type = type;
  event.time = time;
  event.data = JsonAccess.parse(dataJson);
  return event;
}

test('只保留能读的对话行，协议生命周期事件一律丢掉', () => {
  const value: ChatHistory = history([
    entry('turn/start', 1, '{"turn":1}'),
    entry('user/message', 2,
      '{"content":[{"type":"text","text":"Build the feature"}],"source":{"kind":"user"}}'),
    entry('user/message', 3,
      '{"content":[{"type":"text","text":"Injected instructions"}],'
        + '"source":{"kind":"agent-instructions","changes":[{"path":"AGENTS.md"}]}}'),
    entry('assistant/message', 4,
      '{"turn":1,"step":1,"message":{"content":[{"type":"reasoning","text":"Inspect the repository"},'
        + '{"type":"tool-call","id":"call-1","name":"bash","arguments":"{}"},'
        + '{"type":"text","text":"The implementation is ready."}]}}'),
    entry('tool/call', 5,
      '{"turn":1,"step":1,"callId":"call-1","name":"bash",'
        + '"arguments":"{\\"command\\":\\"pnpm test\\",\\"description\\":\\"Run tests\\"}"}',
      '{"for":"call","view":{"card":"terminal","title":"pnpm test","description":"Run tests"}}'),
    entry('tool/call', 6,
      '{"turn":1,"step":1,"callId":"call-2","name":"mystery","arguments":"{raw protocol payload"}',
      '{"for":"call","view":{"title":"Safe host title"}}'),
    entry('step/end', 7, '{"turn":1,"step":1}'),
    entry('turn/end', 8, '{"turn":1,"reason":{"kind":"completed"}}'),
  ]);

  const items = displayItemsOf(value);

  // 连续两次工具调用合并成一行（与网页版同口径），TOOL 由两项变一项。
  assert.deepEqual(items.map((it) => it.kind), [
    ChatItemKind.USER,
    ChatItemKind.CONTEXT,
    ChatItemKind.REASONING,
    ChatItemKind.ASSISTANT,
    ChatItemKind.TOOL,
  ]);
  assert.equal(items[1].title, 'AGENTS.md');
  assert.equal(items[3].body, 'The implementation is ready.');

  // 标题是动作短语而不是 "Bash" 这类英文类别词；认不出的工具按自己的名字列出，不静默吞掉。
  assert.deepEqual(items[4].actions, ['执行了命令', 'mystery']);
  assert.equal(items[4].title, '执行了命令，mystery');
  // 合并后正文把每条都带上，展开时才看得到细节。
  assert.ok(items[4].body.indexOf('Run tests') >= 0);
  assert.ok(items[4].body.indexOf('Safe host title') >= 0);

  // 两条**安全断言**，与呈现方式无关，必须继续成立：
  // 坏掉的 arguments 原文不得进入界面；协议层字段名不得泄漏到正文里。
  for (let i = 0; i < items.length; i++) {
    assert.ok(items[i].body.indexOf('raw protocol payload') < 0);
    assert.ok(items[i].body.indexOf('turn/end') < 0);
    assert.ok(items[i].body.indexOf('sourceEventSeqs') < 0);
  }
});

test('稳定的增量帧被折叠成一条可读的实时助手消息', () => {
  const first = chatDelta(wsEvent('chat.message.delta',
    '{"sessionId":"session-1","turn":2,"step":1,"index":0,"kind":"text","text":"实时"}', 1));
  const second = chatDelta(wsEvent('chat.message.delta',
    '{"sessionId":"session-1","turn":2,"step":1,"index":0,"kind":"text","text":"输出"}', 2));
  assert.notEqual(first, null);
  assert.notEqual(second, null);

  const live: LiveChatState = new LiveChatState(first!.sessionId, first!.turn, first!.step)
    .append(first!)
    .append(second!);

  const rows = live.displayItems();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, '实时输出');
  assert.equal(rows[0].kind, ChatItemKind.ASSISTANT);
  assert.equal(rows[0].streaming, true);
  assert.equal(live.revision, 2);
});

test('turn/step 一变就整段换掉（上一段由 REST 历史补回来，避免重复显示）', () => {
  const state: LiveChatState = new LiveChatState('s', 1, 1)
    .append(new ChatDelta('s', 1, 1, 0, ChatItemKind.ASSISTANT, '第一段'))
    .append(new ChatDelta('s', 1, 2, 0, ChatItemKind.ASSISTANT, '第二段'));

  const rows = state.displayItems();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, '第二段');
});

test('同一段里换 kind 是整段替换，不把两种语义粘成一句', () => {
  const state: LiveChatState = new LiveChatState('s', 1, 1)
    .append(new ChatDelta('s', 1, 1, 0, ChatItemKind.REASONING, '想了想'))
    .append(new ChatDelta('s', 1, 1, 0, ChatItemKind.ASSISTANT, '答案'));

  const rows = state.displayItems();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, ChatItemKind.ASSISTANT);
  assert.equal(rows[0].body, '答案');
});

test('增量的 index 决定行序，乱序到达也按 index 排好', () => {
  const state: LiveChatState = new LiveChatState('s', 1, 1)
    .append(new ChatDelta('s', 1, 1, 2, ChatItemKind.ASSISTANT, '丙'))
    .append(new ChatDelta('s', 1, 1, 0, ChatItemKind.ASSISTANT, '甲'))
    .append(new ChatDelta('s', 1, 1, 1, ChatItemKind.REASONING, '乙'));

  const rows = state.displayItems();
  assert.deepEqual(rows.map((it) => it.body), ['甲', '乙', '丙']);
  assert.deepEqual(rows.map((it) => it.kind),
    [ChatItemKind.ASSISTANT, ChatItemKind.REASONING, ChatItemKind.ASSISTANT]);
});

test('空文本的增量块不产出显示项，但 revision 仍然递增', () => {
  const state: LiveChatState = new LiveChatState('s', 1, 1)
    .append(new ChatDelta('s', 1, 1, 0, ChatItemKind.ASSISTANT, ''));

  assert.equal(state.displayItems().length, 0);
  assert.equal(state.revision, 1);
});

test('增量帧缺字段或 kind 认不出时整帧丢掉，不猜', () => {
  // kind 既不是 text 也不是 reasoning。
  assert.equal(chatDelta(wsEvent('chat.message.delta',
    '{"sessionId":"s","turn":1,"step":1,"index":0,"kind":"tool-call","text":"x"}')), null);
  // 缺 text。
  assert.equal(chatDelta(wsEvent('chat.message.delta',
    '{"sessionId":"s","turn":1,"step":1,"index":0,"kind":"text"}')), null);
  // turn 是小数：intOrNull 口径下不算整数。
  assert.equal(chatDelta(wsEvent('chat.message.delta',
    '{"sessionId":"s","turn":1.5,"step":1,"index":0,"kind":"text","text":"x"}')), null);
  // 事件类型不是增量帧。
  assert.equal(chatDelta(wsEvent('chat.message.end', '{"sessionId":"s"}')), null);
});

test('待办与权限控件从会话投影里读出来', () => {
  const value: ChatHistory = history([], '{"values":{"todos":['
    + '{"content":"Inspect API","status":"completed"},'
    + '{"content":"Build UI","status":"in_progress"}],'
    + '"permissions":{"currentValue":"workspace-write","options":['
    + '{"value":"read-only","name":"Read Only"},'
    + '{"value":"workspace-write","name":"Workspace Write","description":"Write inside the workspace"},'
    + '{"value":"danger-full-access","name":"Full access"}]}}}');

  const todos: TodoItem[] = todoItemsOf(value);
  assert.deepEqual(todos.map((it) => it.content), ['Inspect API', 'Build UI']);
  assert.deepEqual(todos.map((it) => it.status), ['completed', 'in_progress']);

  const permissions = permissionSelectOf(value);
  assert.notEqual(permissions, null);
  assert.equal(permissions!.currentValue, 'workspace-write');
  assert.deepEqual(permissions!.options.map((it) => it.value),
    ['read-only', 'workspace-write', 'danger-full-access']);
  assert.equal(permissions!.options[1].description, 'Write inside the workspace');
});

test('权限档位：投影只给 currentValue 时，候选项从目录补（源工程 v2.2.44 的真缺陷）', () => {
  // 新版内核那条 wire 视图**只给 currentValue** —— 拿得到当前档位、列不出候选。
  // 源工程此前读投影 options，于是整条权限入口在真机上从不渲染。候选只能来自目录接口。
  const value: ChatHistory = history([],
    '{"values":{"permissions":{"currentValue":"workspace-write"}}}');
  const projectionOnly = permissionSelectOf(value);
  assert.notEqual(projectionOnly, null);
  assert.equal(projectionOnly!.currentValue, 'workspace-write');
  assert.deepEqual(projectionOnly!.options, [], '无目录时候选就是空（调用方仍要渲染只读标签）');

  const catalog = new PermissionCatalog([
    new PermissionOption('read-only', 'Read Only'),
    new PermissionOption('workspace-write', 'Workspace Write'),
    new PermissionOption('danger-full-access', 'Full access'),
  ], 'workspace-write');
  const merged = permissionSelectOf(value, catalog);
  assert.equal(merged!.currentValue, 'workspace-write');
  assert.deepEqual(merged!.options.map((it) => it.value),
    ['read-only', 'workspace-write', 'danger-full-access']);
});

test('权限档位：投影内联候选优先于目录（老 bridge 可能仍在投影里给）', () => {
  const value: ChatHistory = history([], '{"values":{"permissions":{"currentValue":"read-only",'
    + '"options":[{"value":"read-only"}]}}}');
  const catalog = new PermissionCatalog([new PermissionOption('workspace-write', '工作区写入')], 'read-only');
  const merged = permissionSelectOf(value, catalog);
  assert.deepEqual(merged!.options.map((it) => it.value), ['read-only'], '内联非空就不该被目录覆盖');
  assert.equal(merged!.options[0].name, 'read-only', '缺 name 时退回 value，不显示空白');
});

test('权限档位：投影形状漂移时按 currentValue → preset → sandbox 依次降级', () => {
  // 新版投影给 { preset, sandbox }，currentValue 直接消失 —— 内核不保证字段稳定，
  // 只能「读到什么算什么」。
  const byPreset: ChatHistory = history([],
    '{"values":{"permissions":{"preset":"read-only","sandbox":"workspace-write"}}}');
  assert.equal(permissionSelectOf(byPreset)!.currentValue, 'read-only', 'preset 优先于 sandbox');

  const bySandbox: ChatHistory = history([],
    '{"values":{"permissions":{"sandbox":"workspace-write"}}}');
  assert.equal(permissionSelectOf(bySandbox)!.currentValue, 'workspace-write');

  // 三者都没有 → 这条投影没有权限信息，返回 null（界面整条不渲染，而不是显示空档位）。
  const none: ChatHistory = history([], '{"values":{"permissions":{"approval":"on-request"}}}');
  assert.equal(permissionSelectOf(none), null);
});

test('投影缺失或形状不对时安静返回空，不抛异常', () => {
  assert.deepEqual(todoItemsOf(history([])), []);
  assert.equal(permissionSelectOf(history([])), null);
  // 内容为空白 / 缺 status 的待办项被跳过。
  const value: ChatHistory = history([], '{"values":{"todos":[{"content":"   ","status":"x"},'
    + '{"content":"没有状态"}]}}');
  assert.deepEqual(todoItemsOf(value), []);
  // 有 todos 但没 permissions，不会牵连 todos。
  const onlyTodos: ChatHistory = history([], '{"values":{"todos":[{"content":"A","status":"open"}]}}');
  assert.equal(todoItemsOf(onlyTodos).length, 1);
  assert.equal(permissionSelectOf(onlyTodos), null);
});

test('只有图片、一个字都没有的消息必须留下（用户真机报的 bug）', () => {
  const value: ChatHistory = history([entry('user/message', 7,
    '{"source":{"kind":"user"},"content":[{"type":"image","attachment":{'
      + '"attachmentId":"sha256:9759b45815c74eb5289a46074ad655a0",'
      + '"mediaType":"image/jpeg","width":1080,"height":2440,"bytes":143847,"name":"shot.jpg"}}]}')]);

  const items = displayItemsOf(value);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, ChatItemKind.USER);
  assert.equal(items[0].body, '');
  assert.equal(items[0].attachments.length, 1);
  assert.equal(items[0].attachments[0].attachmentId, 'sha256:9759b45815c74eb5289a46074ad655a0');
  assert.equal(items[0].attachments[0].mediaType, 'image/jpeg');
  assert.equal(items[0].attachments[0].width, 1080);
  assert.equal(items[0].attachments[0].bytes, 143847);
  assert.equal(items[0].attachments[0].name, 'shot.jpg');
});

test('既没文字也没附件的消息仍然丢掉（不能冒出一堆空气泡）', () => {
  const value: ChatHistory = history([entry('user/message', 8,
    '{"source":{"kind":"user"},"content":[{"type":"text","text":"   "}]}')]);
  assert.equal(displayItemsOf(value).length, 0);
});

test('file 部件（receiptId）不算附件：它不是服务端附件存储里的东西', () => {
  const value: ChatHistory = history([entry('user/message', 9,
    '{"source":{"kind":"user"},"content":[{"type":"text","text":"看附件"},'
      + '{"type":"file","receiptId":"receipt-abc"}]}')]);

  const items = displayItemsOf(value);
  assert.equal(items.length, 1);
  assert.equal(items[0].body, '看附件');
  assert.equal(items[0].attachments.length, 0);
});

test('交接图显示成附件而不是一行路径', () => {
  const path: string = '/media/wangke/OFFICE/workspace/.dsh-images/'
    + '24ddaa44f9ed8f8a509af39de29f04c9e2e9f068f826ee312867a877a2ec4ad2.jpg';
  const value: ChatHistory = history([entry('user/message', 30,
    '{"source":{"kind":"user"},"content":['
      + '{"type":"text","text":"测试一下 人类能看懂的图片识别"},'
      + '{"type":"text","text":"🖼️ 图片 1「274935.jpg」（当前模型不支持图片输入，已保存到工作目录 '
      + '.dsh-images/24ddaa….jpg）\\n[Image: source: ' + path + ']"}]}')]);

  const items = displayItemsOf(value);
  assert.equal(items.length, 1);
  assert.equal(items[0].body, '测试一下 人类能看懂的图片识别');
  assert.equal(items[0].attachments.length, 1);
  const attachment: ChatAttachment = items[0].attachments[0];
  assert.equal(attachment.attachmentId, HANDOFF_ATTACHMENT_PREFIX + path);
  assert.equal(attachment.handoffPath, path);
  assert.equal(attachment.mediaType, 'image/jpeg');
  assert.equal(attachment.name,
    '24ddaa44f9ed8f8a509af39de29f04c9e2e9f068f826ee312867a877a2ec4ad2.jpg');
});

test('只发图 + 说明整段摘掉：正文空但消息留下', () => {
  const path: string = '/root/.dsh-images/aa11bb22.jpg';
  const value: ChatHistory = history([entry('user/message', 31,
    '{"source":{"kind":"user"},"content":['
      + '{"type":"text","text":"🖼️ 图片 1「aa.jpg」（当前模型不支持图片输入，已保存到工作目录 '
      + '.dsh-images/aa11bb22.jpg）\\n[Image: source: ' + path + ']"}]}')]);

  const items = displayItemsOf(value);
  assert.equal(items.length, 1);
  assert.equal(items[0].body, '');
  assert.equal(items[0].attachments.length, 1);
  assert.equal(items[0].attachments[0].attachmentId, HANDOFF_ATTACHMENT_PREFIX + path);
});

test('说明与用户正文同处一条 part 时，只删那两行', () => {
  const path: string = '/root/.dsh-images/cc33.jpg';
  const value: ChatHistory = history([entry('user/message', 32,
    '{"source":{"kind":"user"},"content":['
      + '{"type":"text","text":"你看这个\\n[Image: source: ' + path + ']\\n后面的字还在"}]}')]);

  const items = displayItemsOf(value);
  assert.equal(items[0].body, '你看这个\n后面的字还在');
  assert.equal(items[0].attachments.length, 1);
});

test('同一张交接图被写两次只显示一次', () => {
  const path: string = '/root/.dsh-images/dd44.jpg';
  const value: ChatHistory = history([entry('user/message', 33,
    '{"source":{"kind":"user"},"content":['
      + '{"type":"text","text":"[Image: source: ' + path + ']"},'
      + '{"type":"text","text":"[Image: source: ' + path + ']"}]}')]);

  const items = displayItemsOf(value);
  assert.equal(items.length, 1);
  assert.equal(items[0].attachments.length, 1);
});

test('上下文注入的正文一个字都不动，哪怕它引用了路径', () => {
  const value: ChatHistory = history([entry('user/message', 34,
    '{"source":{"kind":"plugin"},"content":['
      + '{"type":"text","text":"示例：机器行写成 [Image: source: /root/.dsh-images/ff66.jpg] 这样"}]}')]);

  const items = displayItemsOf(value);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, ChatItemKind.CONTEXT);
  assert.equal(items[0].body, '示例：机器行写成 [Image: source: /root/.dsh-images/ff66.jpg] 这样');
  assert.equal(items[0].attachments.length, 0);
});

test('交接路径只认 handoff: 前缀', () => {
  assert.equal(handoffPathOf('handoff:/root/.dsh-images/ee55.jpg'), '/root/.dsh-images/ee55.jpg');
  assert.equal(handoffPathOf('sha256:9759b45815c74eb5289a46074ad655a0'), null);
  assert.equal(handoffPathOf('handoff:'), null);
  assert.equal(handoffPathOf(''), null);
});

test('历史里的 turn/end 失败帧要渲染出来（限流后一直转圈的 bug）', () => {
  const value: ChatHistory = history([
    entry('user/message', 2, '{"content":[{"type":"text","text":"帮我查一下"}],"source":{"kind":"user"}}'),
    entry('turn/end', 900, '{"turn":3,"reason":{"kind":"error","error":{"code":"",'
      + '"message":"您已达到免费用户的 API 速率限制。升级 Token Plan 即可解锁更高限额，继续不间断使用 API。'
      + ' (request id: 20261011054136674823028JzjiUYGm)","type":"AgnesAI_error"}}}'),
  ]);

  const failures = displayItemsOf(value).filter((it) => it.kind === ChatItemKind.FAILURE);
  assert.equal(failures.length, 1);
  const failure = failures[0].failure;
  assert.notEqual(failure, null);
  assert.equal(failure!.titleKey, 'turn_failed_title');
  assert.equal(failure!.stopped, false);
  assert.ok(failure!.message.indexOf('API 速率限制') >= 0);
  // 空串 code 必须**保留空串**：客户端要原样显示错误码那一格。
  assert.equal(failure!.code, '');
});

test('登出导致的停止标记为 stopped，而不是模型故障', () => {
  const value: ChatHistory = history([entry('turn/end', 901,
    '{"turn":4,"reason":{"kind":"aborted","reason":{"kind":"hook","reason":"deepseek-account/signed-out"}}}')]);

  const items = displayItemsOf(value);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, ChatItemKind.FAILURE);
  const failure = items[0].failure;
  assert.notEqual(failure, null);
  assert.equal(failure!.stopped, true);
  assert.equal(failure!.titleKey, 'turn_stopped_title');
  assert.equal(failure!.code, 'ACCOUNT_SIGNED_OUT');
});

test('正常 / 截断 / 用户取消 / 别的钩子，一条都不误报成失败', () => {
  const value: ChatHistory = history([
    entry('turn/end', 11, '{"turn":1,"reason":{"kind":"ok"}}'),
    entry('turn/end', 12, '{"turn":2,"reason":{"kind":"completed"}}'),
    entry('turn/end', 13, '{"turn":3,"reason":{"kind":"max-tokens"}}'),
    entry('turn/end', 14, '{"turn":4,"reason":{"kind":"aborted","reason":{"kind":"user"}}}'),
    entry('turn/end', 15,
      '{"turn":5,"reason":{"kind":"aborted","reason":{"kind":"hook","reason":"some-other-hook"}}}'),
    // 老帧没有 reason，也不算失败。
    entry('turn/end', 16, '{"turn":6}'),
  ]);

  const failures = displayItemsOf(value).filter((it) => it.kind === ChatItemKind.FAILURE);
  assert.equal(failures.length, 0);
});

test('实时失败帧解出的 message/code/stopped 与历史帧一致', () => {
  const frame = wsEvent('chat.turn.failed',
    '{"sessionId":"session-1","eventType":"turn/end","seq":900,'
      + '"failure":{"message":"您已达到免费用户的 API 速率限制。","code":""}}', 1234);

  const failure = chatTurnFailure(frame);
  assert.notEqual(failure, null);
  assert.equal(failure!.message, '您已达到免费用户的 API 速率限制。');
  assert.equal(failure!.code, '');
  assert.equal(failure!.stopped, false);

  // 事件类型对不上就安静返回 null（老插件只发 chat.turn.end，不能因此抽风）。
  assert.equal(chatTurnFailure(wsEvent('chat.turn.end', '{"sessionId":"s"}')), null);
  // 有 type 但没 failure 对象，也返回 null。
  assert.equal(chatTurnFailure(wsEvent('chat.turn.failed', '{"sessionId":"s"}')), null);
});

test('reason.error 不是对象时，字符串本身也是信息，不能整条丢掉', () => {
  const value: ChatHistory = history([entry('turn/end', 21,
    '{"turn":1,"reason":{"kind":"error","error":"模型服务连接被重置"}}')]);

  const items = displayItemsOf(value);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, ChatItemKind.FAILURE);
  assert.equal(items[0].failure!.message, '模型服务连接被重置');
  assert.equal(items[0].failure!.code, null);
});

test('失败帧的编号带 seq，同一会话多条失败不会撞 id', () => {
  const value: ChatHistory = history([
    entry('turn/end', 900, '{"turn":3,"reason":{"kind":"error","error":{"code":"A","message":"甲"}}}'),
    entry('turn/end', 901, '{"turn":4,"reason":{"kind":"error","error":{"code":"B","message":"乙"}}}'),
  ]);
  const failures = displayItemsOf(value);
  assert.equal(failures.length, 2);
  assert.equal(failures[0].id, '900-turn-failure');
  assert.equal(failures[1].id, '901-turn-failure');
  assert.equal(failures[0].seq, 900);
  assert.equal(failures[1].seq, 901);
});

test('显式交付的文件从 deliverables/presented 里读出来，后写的说明胜出', () => {
  const value: ChatHistory = history([
    entry('tool/call', 5, '{"callId":"c1","name":"present","arguments":"{}"}'),
    entry('deliverables/presented', 6,
      '{"files":[{"path":"/w/report.html","description":"给老板看的报告"},'
        + '{"path":"/w/data.csv","description":""}]}'),
    entry('deliverables/presented', 9,
      '{"files":[{"path":"/w/report.html","description":"修订版"}]}'),
    entry('deliverables/presented', 10, '{"files":[{"path":"  "},{"description":"没有路径"}]}'),
  ]);

  const files = deliverablesOf(value);
  assert.equal(files.length, 2);
  // 同一个路径保留**最后一次**的说明，但位置仍是首次出现处。
  assert.equal(files[0].path, '/w/report.html');
  assert.equal(files[0].description, '修订版');
  assert.equal(files[0].seq, 9);
  assert.equal(files[1].path, '/w/data.csv');
  // 空说明要**保留为空串**（"有文件、还没写说明"与"没这个文件"是两回事）。
  assert.equal(files[1].description, '');
  assert.equal(files[1].seq, 6);
});

test('没有交付事件时返回空列表', () => {
  assert.deepEqual(deliverablesOf(history([
    entry('user/message', 1, '{"content":[{"type":"text","text":"喂"}],"source":{"kind":"user"}}'),
  ])), []);
});
