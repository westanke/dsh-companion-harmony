/**
 * 聊天页呈现模型 —— **第三层：事件 → 显示项**（从 `ChatPresentation.ts` 拆出）。
 *
 * 本文件只装**对外的解析入口**（公共 API 的一部分）：`chatDelta`、`chatTurnFailure`、
 * `displayItemsOf`、`todoItemsOf`、`permissionSelectOf`、`deliverablesOf`、`handoffPathOf`。
 * 具体的"某类条目怎么长出来"在 `ChatItemBuilders.ts` / `ChatToolItems.ts` / `ChatToolFormat.ts`。
 *
 * 拆分来龙去脉见 `ChatPresentation.ts` 文件头。
 */

import { ChatHistory, PermissionCatalog, PermissionOption, PermissionSelect, SessionEvent, TodoItem,
  WorkspaceEvent } from './Models';
import { JsonAccess, JsonMap } from './JsonAccess';
import { isBlank, isNotBlank } from './TextPredicates';
import { ChatJson } from './ChatJson';
import { ChatAttachment, ChatDeliverable, ChatDelta, ChatDisplayItem, ChatItemKind, ChatTurnFailure,
  HANDOFF_ATTACHMENT_PREFIX } from './ChatPresentationTypes';
import { oneEntryItems } from './ChatItemBuilders';
import { mergeToolRuns } from './ChatToolItems';
import { ToolResultInfo, toolResultsByCallId } from './ChatToolFormat';

// ---------------------------------------------------------------------------
// 事件 → 显示项
// ---------------------------------------------------------------------------

/**
 * 从 `chat.message.delta` 帧里取出增量。
 *
 * `kind` 只认 `text`（→ ASSISTANT）与 `reasoning`（→ REASONING），其余整帧丢掉；
 * 五个必填字段（sessionId/turn/step/index/text）缺一个就返回 null，绝不填默认值猜。
 */
export function chatDelta(event: WorkspaceEvent): ChatDelta | null {
  if (event.type !== 'chat.message.delta') {
    return null;
  }
  const value: JsonMap | null = event.dataMap();
  if (value === null) {
    return null;
  }
  const kindText: string | null = ChatJson.str(value, 'kind');
  let kind: ChatItemKind;
  if (kindText === 'text') {
    kind = ChatItemKind.ASSISTANT;
  } else if (kindText === 'reasoning') {
    kind = ChatItemKind.REASONING;
  } else {
    return null;
  }
  const sessionId: string | null = ChatJson.str(value, 'sessionId');
  const turn: number | null = ChatJson.int(value, 'turn');
  const step: number | null = ChatJson.int(value, 'step');
  const index: number | null = ChatJson.int(value, 'index');
  const text: string | null = ChatJson.str(value, 'text');
  if (sessionId === null || turn === null || step === null || index === null || text === null) {
    return null;
  }
  return new ChatDelta(sessionId, turn, step, index, kind, text);
}

/**
 * 从 `chat.turn.failed` 帧里取出失败详情。
 *
 * 判据是 **type 精确等于** `chat.turn.failed`（插件 `normalizeDshEvent` 专门为
 * `turn/end` + `reason.kind === 'error'` 发的那帧），不是「任何带 failure 的帧」。
 * 这样做的好处是：插件没升级、老服务端只发普通 `chat.turn.end` 时，这里安静返回
 * null，客户端仍旧走原来的收尾路径，不会因为一个新字段抽风。
 */
export function chatTurnFailure(event: WorkspaceEvent): ChatTurnFailure | null {
  if (event.type !== 'chat.turn.failed') {
    return null;
  }
  const value: JsonMap | null = event.dataMap();
  if (value === null) {
    return null;
  }
  const failure: JsonMap | null = ChatJson.obj(value, 'failure');
  if (failure === null) {
    return null;
  }
  const message: string | null = ChatJson.str(failure, 'message');
  return new ChatTurnFailure(
    message === null ? '' : message,
    // 注意：空串 code 要**留空串**，不能退回 null。免费额度限流的 code 就是 ""，
    // 而界面要照原样显示「错误码：」后面那一格。
    ChatJson.str(failure, 'code'),
    ChatJson.bool(failure, 'stopped') === true,
  );
}

/** 对应 Kotlin 扩展函数 `ChatHistory.displayItems()`。 */
export function displayItemsOf(history: ChatHistory): ChatDisplayItem[] {
  // 先按 callId 把 tool/result 建成索引，再逐条渲染：
  // 结果的 callId 藏在 `data.message.toolCallId` 里，配对要跨事件 ——
  // 单看一条 entry 是配不上的（这正是以前 tool/result 整类被丢掉的原因）。
  const results: Map<string, ToolResultInfo> = toolResultsByCallId(history.events);
  const items: ChatDisplayItem[] = [];
  for (let i = 0; i < history.events.length; i++) {
    const one: ChatDisplayItem[] = oneEntryItems(history.events[i], results);
    for (let k = 0; k < one.length; k++) {
      items.push(one[k]);
    }
  }
  return mergeToolRuns(items);
}

/** 对应 Kotlin 扩展函数 `ChatHistory.todoItems()`。 */
export function todoItemsOf(history: ChatHistory): TodoItem[] {
  const projections: JsonMap | null = JsonAccess.asMap(history.projections);
  const values: JsonMap | null = ChatJson.obj(projections, 'values');
  if (values === null) {
    return [];
  }
  const raw: Object[] = ChatJson.arr(values, 'todos');
  const out: TodoItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item: JsonMap | null = JsonAccess.asMap(raw[i]);
    if (item === null) {
      continue;
    }
    const content: string | null = ChatJson.str(item, 'content');
    if (content === null || isBlank(content)) {
      continue;
    }
    const status: string | null = ChatJson.str(item, 'status');
    if (status === null) {
      continue;
    }
    out.push(TodoItem.fromJson(item));
  }
  return out;
}

/**
 * 对应 Kotlin 扩展函数 `ChatHistory.permissionSelect(catalog)`。
 *
 * ## 投影形状会漂移，只能「读到什么算什么」
 *
 * 内核 `permissions` 投影的形状随版本变：旧版给 `currentValue` / `options`，
 * 新版给 `{ preset, sandbox, approval, seeded }`，`currentValue` 直接消失。
 * wire schema 由内核定义，本仓不能要求上游保持某个字段，所以依次降级取值：
 * `currentValue` → `preset` → `sandbox`，三者都没有才认为是「这条投影没有权限信息」。
 *
 * ## 为什么候选项要接 `catalog`
 *
 * 同一版本内核把预设清单挪到了独立的远程服务上，投影里那条 wire 视图**只给
 * `currentValue`** —— 于是「投影内联 options」这条路实测恒为空，界面就会拿不到候选、
 * **整条权限入口都不渲染**（源工程 v2.2.44 真机验收时看到的正是这个症状）。
 * 所以候选项按「投影内联优先、为空才用目录」的顺序取：
 * 老 bridge 可能仍在内联（那种情况不该被目录覆盖），新 bridge 则靠目录兜住。
 *
 * `catalog` 默认 `null` 是**刻意的**：调用方还没有目录（未连接、老 bridge 404）时，
 * 行为与移植前完全一致 —— 拿得到当前档位就返回，只是候选为空。
 */
export function permissionSelectOf(history: ChatHistory,
    catalog: PermissionCatalog | null = null): PermissionSelect | null {
  const projections: JsonMap | null = JsonAccess.asMap(history.projections);
  const values: JsonMap | null = ChatJson.obj(projections, 'values');
  if (values === null) {
    return null;
  }
  const raw: JsonMap | null = ChatJson.obj(values, 'permissions');
  if (raw === null) {
    return null;
  }
  const currentValue: string | null = ChatJson.str(raw, 'currentValue')
    ?? ChatJson.str(raw, 'preset')
    ?? ChatJson.str(raw, 'sandbox');
  if (currentValue === null) {
    return null;
  }
  const options: PermissionOption[] = [];
  const entries: Object[] = ChatJson.arr(raw, 'options');
  for (let i = 0; i < entries.length; i++) {
    const option: JsonMap | null = JsonAccess.asMap(entries[i]);
    if (option === null) {
      continue;
    }
    const value: string | null = ChatJson.str(option, 'value');
    if (value === null) {
      continue;
    }
    // 名字缺失时**退回 value 本身**（源工程同款）：档位有值无名的场景下，
    // 界面上显示 `workspace-write` 也比显示一片空白强。
    const name: string | null = ChatJson.str(option, 'name') ?? value;
    options.push(new PermissionOption(value, name, ChatJson.str(option, 'description')));
  }
  if (options.length === 0 && catalog !== null) {
    for (let i = 0; i < catalog.options.length; i++) {
      options.push(catalog.options[i]);
    }
  }
  return new PermissionSelect(options, currentValue);
}

/**
 * 取出会话里被显式交付的文件。
 *
 * 与 `SessionFileRefs` 是**两回事**：那个是从工具参数里嗅「提到过哪些路径」（带一堆
 * 刻意的取舍与白名单），这个读的是内核明说的「这是我给你的东西」，可靠度高得多、还带说明。
 *
 * 为什么以前客户端里看不到交付物：`displayItems` 只认 user/message、assistant/message、
 * tool/call 三类，`deliverables/presented` 落到兜底分支被整类丢掉。于是用户问
 * 「我要你写的报告呢、你打好的包呢」—— 数据一直在日志里，就是没人读。
 *
 * 同一个路径出现多次时保留**最后一次**的说明（后写的更新）。
 */
export function deliverablesOf(history: ChatHistory): ChatDeliverable[] {
  // Map 保持插入顺序：后写覆盖值，但键的位置仍是首次出现的位置。
  const out: Map<string, ChatDeliverable> = new Map();
  for (let i = 0; i < history.events.length; i++) {
    const event: SessionEvent = history.events[i].event;
    if (event.type !== 'deliverables/presented') {
      continue;
    }
    const data: JsonMap | null = event.dataMap();
    if (data === null) {
      continue;
    }
    const files: Object[] = JsonAccess.arr(data, 'files');
    for (let k = 0; k < files.length; k++) {
      const file: JsonMap | null = JsonAccess.asMap(files[k]);
      if (file === null) {
        continue;
      }
      const path: string | null = ChatJson.str(file, 'path');
      if (path === null || isBlank(path)) {
        continue;
      }
      out.set(path, new ChatDeliverable(path, ChatJson.str(file, 'description'), event.seq));
    }
  }
  const list: ChatDeliverable[] = [];
  out.forEach((value: ChatDeliverable): void => {
    list.push(value);
  });
  return list;
}

/**
 * 从附件 id 里解出交接路径；不是交接附件就返回 `null`。
 *
 * 界面只把 [ChatAttachment.attachmentId] 传给 ViewModel，于是「这个 id 是工作区路径、
 * 还是附件存储里的哈希」这个判据必须在两端共用同一份实现 —— 放这里，单测能直接钉住。
 */
export function handoffPathOf(attachmentId: string): string | null {
  if (!attachmentId.startsWith(HANDOFF_ATTACHMENT_PREFIX)) {
    return null;
  }
  const path: string = attachmentId.substring(HANDOFF_ATTACHMENT_PREFIX.length);
  return isNotBlank(path) ? path : null;
}
