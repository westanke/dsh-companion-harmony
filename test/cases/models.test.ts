import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentPreset, ChatHistory, ChatSession, CommandDescriptor, CommandResult, CreatedSession,
  DirectoryPage, DshApiException, FileEntry, HealthView, HistoryEntry, ModelSelection,
  PairingResult, PendingQuestionSet, PluginEntry, PluginInventory, PluginToggleRequest,
  PromptPart, ProviderModel, ProviderPatch, ProviderSettings, QuestionAnswer,
  QuestionAnswerRequest, ResolvedPath, RootView, SessionEvent, SessionModels,
  UploadedAttachment, WorkspaceEvent, QUESTION_STATE_CONTINUED,
} from '../../entry/src/main/ets/core/Models.ts';
import { JsonAccess, type JsonMap } from '../../entry/src/main/ets/core/JsonAccess.ts';

function m(text: string): JsonMap | null {
  return JsonAccess.asMap(JsonAccess.parse(text));
}

/** 取请求体 JSON 里的键集合，便于断言「某键是否出现」。 */
function keys(text: string): string[] {
  return Object.keys(JSON.parse(text) as Record<string, unknown>).sort();
}

// --- 宽容解码总原则 ---------------------------------------------------------

test('Models：空 map / null / 类型不符一律退化为默认值，绝不抛异常', () => {
  assert.equal(HealthView.fromJson(null).ok, false);
  assert.equal(HealthView.fromJson(null).version, '');
  assert.equal(HealthView.fromJson(null).pluginVersion, null);
  assert.deepEqual(RootView.fromJson(null), new RootView());
  assert.equal(ChatSession.fromJson(m('{}')).cwd, '');
  assert.equal(ChatSession.fromJson(m('{"running":"yes"}')).running, false, '类型不符退默认');
  assert.deepEqual(DirectoryPage.fromJson(null).entries, []);
  assert.equal(SessionModels.fromJson(null).routable, false);
  assert.deepEqual(ProviderSettings.fromJson(null).providers, []);
  assert.equal(PluginInventory.fromJson(null).available, false);
});

test('Models：HealthView 正常解码，pluginVersion 缺失为 null', () => {
  const health = HealthView.fromJson(m('{"ok":true,"version":"2.3.5"}'));
  assert.equal(health.ok, true);
  assert.equal(health.version, '2.3.5');
  assert.equal(health.pluginVersion, null);

  const withPlugin = HealthView.fromJson(m('{"ok":true,"version":"v","pluginVersion":"0.4.5"}'));
  assert.equal(withPlugin.pluginVersion, '0.4.5');
});

// --- 会话 -------------------------------------------------------------------

test('ChatSession：空 cwd 是合法值必须保留，cwdAbsolute 缺失为 null', () => {
  const atRoot = ChatSession.fromJson(m('{"id":"s1","rootId":"r1","cwd":"","updatedAt":1,"running":true,"blank":false}'));
  assert.equal(atRoot.cwd, '', '空 cwd 表示工作目录就是授权根，不能当「没有工作目录」丢掉');
  assert.equal(atRoot.cwdAbsolute, null);
  assert.equal(atRoot.running, true);
  assert.equal(atRoot.title, null);

  const absolute = ChatSession.fromJson(m('{"id":"s2","cwd":"sub","cwdAbsolute":"/home/u/proj/sub"}'));
  assert.equal(absolute.cwdAbsolute, '/home/u/proj/sub');
});

test('FileEntry / DirectoryPage：目录与文件、分页游标', () => {
  const page = DirectoryPage.fromJson(m(`{
    "path": "sub",
    "entries": [
      {"name":"a.txt","path":"sub/a.txt","kind":"file","size":12,"modifiedAt":1.5,"writable":true},
      {"name":"d","path":"sub/d","kind":"directory","size":0,"modifiedAt":0,"writable":false}
    ],
    "nextCursor": "c2"
  }`));
  assert.equal(page.path, 'sub');
  assert.equal(page.entries.length, 2);
  assert.equal(page.entries[0].isDirectory(), false);
  assert.equal(page.entries[1].isDirectory(), true);
  assert.equal(page.entries[0].modifiedAt, 1.5);
  assert.equal(page.nextCursor, 'c2');
  assert.equal(DirectoryPage.fromJson(m('{"entries":[]}')).nextCursor, null);
  assert.equal(FileEntry.fromJson(m('{"kind":"directory"}')).isDirectory(), true);
});

test('ResolvedPath：服务端显式发送的 size/contentType 为 null 时必须解析成 null', () => {
  const dir = ResolvedPath.fromJson(m('{"rootId":"r","path":"p","kind":"directory","size":null,"modifiedAt":0,"contentType":null}'));
  assert.equal(dir.size, null);
  assert.equal(dir.contentType, null);
  assert.equal(dir.kind, 'directory');

  const file = ResolvedPath.fromJson(m('{"rootId":"r","path":"p","kind":"file","size":42,"contentType":"text/plain"}'));
  assert.equal(file.size, 42);
  assert.equal(file.contentType, 'text/plain');
});

test('AgentPreset：缺失 trust 退回 "system"（那次线上事故的回归测试）', () => {
  const preset = AgentPreset.fromJson(m('{"id":"p1","name":"默认"}'));
  assert.equal(preset.trust, 'system');
  assert.equal(preset.available, true);
  assert.equal(preset.isDefault, false);
});

test('CreatedSession / PairingResult：嵌套对象与可选字段', () => {
  assert.equal(CreatedSession.fromJson(m('{"id":"s1"}')).agentPreset, null);
  const pairing = PairingResult.fromJson(m('{"token":"tok","device":{"id":"d1","name":"Pixel","scopes":["files.read"],"rootIds":["r1"]}}'));
  assert.equal(pairing.token, 'tok');
  assert.equal(pairing.device.name, 'Pixel');
  assert.deepEqual(pairing.device.scopes, ['files.read']);
  assert.deepEqual(pairing.device.rootIds, ['r1']);
  assert.equal(PairingResult.fromJson(m('{"token":"t"}')).device.id, '');
});

// --- 插件 -------------------------------------------------------------------

test('PluginEntry：updateAvailable 三态，null 不等于 false', () => {
  const notChecked = PluginEntry.fromJson(m('{"name":"a"}'));
  assert.equal(notChecked.updateAvailable, null, 'null 表示「没查／查不到」');
  const upToDate = PluginEntry.fromJson(m('{"name":"a","updateAvailable":false}'));
  assert.equal(upToDate.updateAvailable, false, 'false 表示「已是最新」');
  const hasNew = PluginEntry.fromJson(m('{"name":"a","updateAvailable":true,"latestVersion":"1.2.3"}'));
  assert.equal(hasNew.updateAvailable, true);
  assert.equal(hasNew.latestVersion, '1.2.3');
  assert.equal(notChecked.toggleable, false);
});

test('PluginInventory：profile/profilePath 显式为 null 时不得让整页解码失败', () => {
  const inv = PluginInventory.fromJson(m('{"profile":null,"profilePath":null,"available":false,"reason":"PROFILE_UNKNOWN"}'));
  assert.equal(inv.profile, null);
  assert.equal(inv.profilePath, null);
  assert.equal(inv.reason, 'PROFILE_UNKNOWN');
  assert.deepEqual(inv.items, []);
});

test('PluginToggleRequest：请求体形状固定为 {name,loaded}', () => {
  const body = JSON.parse(new PluginToggleRequest('my-plugin', true).toJsonString());
  assert.deepEqual(body, { name: 'my-plugin', loaded: true });
});

// --- 模型与供应商 -----------------------------------------------------------

test('ModelSelection：reasoningEffort 为 null 时不写该键', () => {
  assert.deepEqual(JSON.parse(new ModelSelection('p', 'm').toJsonString()), { provider: 'p', model: 'm' });
  assert.deepEqual(
    JSON.parse(new ModelSelection('p', 'm', 'high').toJsonString()),
    { provider: 'p', model: 'm', reasoningEffort: 'high' },
  );
  assert.deepEqual(
    ModelSelection.fromJson(m('{"provider":"a","model":"b"}')),
    new ModelSelection('a', 'b', null),
  );
});

test('SessionModels：current 缺失也能解出，groups/failures 默认空数组', () => {
  const models = SessionModels.fromJson(m('{"current":{"provider":"p","model":"m"},"routable":true,"groups":[{"id":"g","name":"G","models":[{"id":"m1","name":"M1"}]}],"failures":[{"provider":"x","message":"boom"}]}'));
  assert.equal(models.current.provider, 'p');
  assert.equal(models.routable, true);
  assert.equal(models.groups[0].models[0].name, 'M1');
  assert.equal(models.failures[0].message, 'boom');
  assert.deepEqual(SessionModels.fromJson(m('{}')).failures, []);
});

test('ProviderSettings：revisionByNamespace 收敛成 Map 并可按命名空间取值', () => {
  const settings = ProviderSettings.fromJson(m('{"writable":true,"revisionByNamespace":{"openai":3,"anthropic":7},"providers":[]}'));
  assert.equal(settings.revision('openai'), 3);
  assert.equal(settings.revision('anthropic'), 7);
  assert.equal(settings.revision('missing'), null);
  assert.equal(settings.customProvider.available, false);
  assert.equal(settings.revisionByNamespace.size, 2);
});

test('ProviderPatch：未指定字段完全不出现在请求体（不是发 null）', () => {
  const empty = new ProviderPatch();
  assert.deepEqual(JSON.parse(empty.toJsonString()), {});

  const patch = new ProviderPatch();
  patch.displayName = '新名字';
  patch.expectedRevision = 4;
  assert.deepEqual(JSON.parse(patch.toJsonString()), { displayName: '新名字', expectedRevision: 4 });

  const withModels = new ProviderPatch();
  const model = new ProviderModel();
  model.id = 'm1';
  withModels.models = [model];
  const parsed = JSON.parse(withModels.toJsonString()) as { models: Record<string, unknown>[] };
  assert.deepEqual(parsed.models, [{ id: 'm1' }], '模型项里的 null 字段同样省略');
});

// --- 问答 -------------------------------------------------------------------

test('QuestionAnswer：custom 为空时请求体里没有 custom 键', () => {
  const body = JSON.parse(new QuestionAnswerRequest([QuestionAnswer.create('q1', ['A', 'B'])]).toJsonString());
  assert.deepEqual(body, { answers: [{ id: 'q1', selected: ['A', 'B'] }] });
  assert.equal('custom' in (body as { answers: Record<string, unknown>[] }).answers[0], false,
    '不得发 "custom": null 让服务端去猜');
});

test('QuestionAnswer：custom 非空时按原样带上', () => {
  const body = JSON.parse(new QuestionAnswerRequest([QuestionAnswer.create('q1', [], '自己写')]).toJsonString());
  assert.deepEqual(body, { answers: [{ id: 'q1', selected: [], custom: '自己写' }] });
  assert.deepEqual(keys(new QuestionAnswerRequest([]).toJsonString()), ['answers']);
});

test('PendingQuestionSet：只认 continued 才可作答；viaBridge 缺省 false', () => {
  const set = PendingQuestionSet.fromJson(m('{"callId":"c1","state":"continued","questions":[{"id":"q1","question":"选哪个？","options":[{"label":"A"},{"label":"B","description":"第二个"}],"multiSelect":true}]}'));
  assert.equal(set.isAnswerable(), true);
  assert.equal(set.viaBridge, false);
  const q = set.questions[0];
  assert.equal(q.multiSelect, true);
  assert.equal(q.isFreeText(), false);
  assert.deepEqual(q.options.map((o) => o.label), ['A', 'B']);
  assert.equal(q.options[1].description, '第二个');
  assert.equal(set.state === QUESTION_STATE_CONTINUED, true);

  const open = PendingQuestionSet.fromJson(m('{"callId":"c2","state":"open","questions":[]}'));
  assert.equal(open.isAnswerable(), false, 'open 是前台阻塞态，远程答不了');

  const free = PendingQuestionSet.fromJson(m('{"callId":"c3","state":"continued","questions":[{"id":"q","question":"随便说"}],"viaBridge":true}'));
  assert.equal(free.questions[0].isFreeText(), true);
  assert.equal(free.viaBridge, true);
});

// --- 消息内容（判别联合） ---------------------------------------------------

test('PromptPart：三种形态只写自己该有的字段，不夹带其它键', () => {
  assert.deepEqual(JSON.parse(PromptPart.text('你好').toJsonString()), { type: 'text', text: '你好' });
  assert.deepEqual(JSON.parse(PromptPart.file('rc1').toJsonString()), { type: 'file', receiptId: 'rc1' });
  assert.deepEqual(
    JSON.parse(PromptPart.image('image/png', 'AAAA').toJsonString()),
    { type: 'image', mediaType: 'image/png', data: 'AAAA' },
  );
  assert.deepEqual(
    JSON.parse(PromptPart.image('image/svg+xml', 'BBBB', 'logo.svg').toJsonString()),
    { type: 'image', mediaType: 'image/svg+xml', data: 'BBBB', name: 'logo.svg' },
  );
});

test('PromptPart：encodeArray 形状与往返解码', () => {
  const raw = PromptPart.encodeArray([PromptPart.text('a'), PromptPart.file('rc')]);
  assert.deepEqual(JSON.parse(raw), [{ type: 'text', text: 'a' }, { type: 'file', receiptId: 'rc' }]);
  assert.equal(PromptPart.encodeArray([]), '[]');

  const image = PromptPart.fromJson(m('{"type":"image","mediaType":"image/webp","data":"x","name":"n"}'));
  assert.equal(image?.type, 'image');
  assert.equal(image?.mediaType, 'image/webp');
  assert.equal(image?.name, 'n');
  assert.equal(PromptPart.fromJson(m('{"type":"file","receiptId":"r"}'))?.receiptId, 'r');
  assert.deepEqual(
    PromptPart.fromJson(m('{"type":"text","text":"hi"}'))?.toJsonString(),
    PromptPart.text('hi').toJsonString(),
  );
});

test('PromptPart：未知/缺失 type 返回 null，不猜形态', () => {
  assert.equal(PromptPart.fromJson(m('{"type":"video"}')), null);
  assert.equal(PromptPart.fromJson(m('{}')), null);
  assert.equal(PromptPart.fromJson(m('{"text":"bare"}')), null);
  assert.equal(PromptPart.fromJson(null), null);
});

test('UploadedAttachment：字段缺失退化为空串，不让可选字段打挂上传流程', () => {
  const up = UploadedAttachment.fromJson(m('{"receiptId":"r1"}'));
  assert.equal(up.receiptId, 'r1');
  assert.equal(up.name, '');
});

// --- 事件与历史 -------------------------------------------------------------

test('SessionEvent：sourceEventSeqs 过滤非数字；非对象载荷取值返回 null', () => {
  const event = SessionEvent.fromJson(m('{"type":"tool","seq":3,"time":99,"data":{"a":1},"sourceEventSeqs":[1,"x",2,null]}'));
  assert.equal(event.seq, 3);
  assert.deepEqual(event.sourceEventSeqs, [1, 2]);
  assert.equal(event.dataMap()?.a, 1);
  assert.equal(event.surfaceOp, null);

  const scalar = SessionEvent.fromJson(m('{"type":"t","data":"纯文本"}'));
  assert.equal(scalar.data, '纯文本');
  assert.equal(scalar.dataMap(), null, '非对象载荷取值返回 null');
});

test('ChatHistory：events 为 HistoryEntry（event + 可选 view）', () => {
  const history = ChatHistory.fromJson(m('{"events":[{"event":{"type":"a","seq":1,"time":2,"data":{}},"view":{"v":1}}],"hasMore":true,"projections":{"p":1}}'));
  assert.equal(history.events.length, 1);
  assert.equal(history.events[0].event.type, 'a');
  assert.equal(JsonAccess.asMap(history.events[0].view)?.v, 1);
  assert.equal(history.hasMore, true);
  assert.equal(JsonAccess.asMap(history.projections)?.p, 1);
  assert.equal(HistoryEntry.fromJson(m('{"event":{"type":"b","seq":2,"time":3}}')).view, null);
});

test('WorkspaceEvent：文本帧解析失败返回 null 而不是抛异常', () => {
  const frame = WorkspaceEvent.fromJsonText('{"id":"e1","type":"session.status","time":5,"data":{"s":"x"}}');
  assert.equal(frame?.type, 'session.status');
  assert.equal(frame?.dataMap()?.s, 'x');
  assert.equal(WorkspaceEvent.fromJsonText('{坏 JSON'), null);
  assert.equal(WorkspaceEvent.fromJsonText('123'), null);
});

test('CommandResult / CommandDescriptor：可选字段与嵌套 input', () => {
  const result = CommandResult.fromJson(m('{"kind":"text"}'));
  assert.equal(result.kind, 'text');
  assert.equal(result.text, null);
  assert.equal(result.sourceEventSeq, null);

  const desc = CommandDescriptor.fromJson(m('{"name":"/help","description":"帮助","input":{"hint":"参数"}}'));
  assert.equal(desc.input?.hint, '参数');
  assert.equal(CommandDescriptor.fromJson(m('{"name":"/x","description":"d"}')).input, null);
});

// --- 错误 -------------------------------------------------------------------

test('DshApiException：保留 status/code/message，且是 Error 的实例', () => {
  const err = new DshApiException(404, 'ROUTE_NOT_FOUND', '插件版本过旧');
  assert.equal(err.status, 404);
  assert.equal(err.code, 'ROUTE_NOT_FOUND');
  assert.equal(err.message, '插件版本过旧');
  assert.equal(err instanceof Error, true);
});
