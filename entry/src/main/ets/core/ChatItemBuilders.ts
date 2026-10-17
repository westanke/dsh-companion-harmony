/**
 * 聊天页呈现模型 —— **第四层：条目构造**（从 `ChatPresentation.ts` 拆出）。
 *
 * 从 `HistoryEntry` / `SessionEvent` 里把一条条 `ChatDisplayItem` 拼出来：
 * 用户消息与附件、助手正文、工具结果收尾、轮末收尾、以及交接图片的三段小逻辑。
 *
 * 一条不许违反的规矩：**判据要能分清「空串」与「没有」**（失败行的 `code` 空串是合法值，
 * 免费额度限流的 code 就是 `""`，界面要照原样显示那一格）。
 *
 * 拆分来龙去脉见 `ChatPresentation.ts` 文件头。
 */

import { HistoryEntry, SessionEvent } from './Models';
import { JsonAccess, JsonMap } from './JsonAccess';
import { isBlank, isNotBlank, trimText } from './TextPredicates';
import { ChatAttachment, ChatDisplayItem, ChatItemKind, ChatTurnFailure, HANDOFF_ATTACHMENT_PREFIX,
  HANDOFF_PREAMBLE_MARKER, HANDOFF_SOURCE_MARKER, HANDOFF_SOURCE_PATTERN } from './ChatPresentationTypes';
import { ChatJson } from './ChatJson';
import { ToolResultInfo, toolResultsByCallId } from './ChatToolFormat';
import { afterLast, afterLastOrEmpty, firstLine, kotlinLines, trimStartWs } from './ChatJson';
import { contentText, contentTextParts, contextLabel, toolItem } from './ChatToolItems';

export function oneEntryItems(entry: HistoryEntry, toolResults: Map<string, ToolResultInfo>): ChatDisplayItem[] {
  const type: string = entry.event.type;
  if (type === 'user/message') {
    return userItems(entry.event);
  }
  if (type === 'assistant/message') {
    return assistantItems(entry.event);
  }
  if (type === 'tool/call') {
    return [toolItem(entry, toolResults)];
  }
  // 历史里的 `turn/end` 失败帧。
  //
  // 为什么必须在历史里也渲染：失败发生后用户往往**先退出再进会话**，或者往下翻记录。
  // 实时帧只到一次，过了就没了；历史是唯一能把「这一轮失败了、失败原因是什么」
  // 长期留住的地方。
  if (type === 'turn/end') {
    const item: ChatDisplayItem | null = turnEndItem(entry.event);
    return item === null ? [] : [item];
  }
  return [];
}

/**
 * 历史里的 `turn/end` 帧 → 失败行；不是失败就返回 null（整条不渲染）。
 *
 * 判据与插件 `turnFailureOf` **同一套**：`reason.kind === 'error'`，
 * 或 `aborted` 且原因是退出登录。`max-tokens` 不在这里 —— 那是「回答被截断」，
 * 官方渲染成黄色警示而非失败，客户端按普通收尾处理，不误报。
 */
export function turnEndItem(event: SessionEvent): ChatDisplayItem | null {
  const data: JsonMap | null = event.dataMap();
  if (data === null) {
    return null;
  }
  const reason: JsonMap | null = ChatJson.obj(data, 'reason');
  if (reason === null) {
    return null;
  }

  let failure: ChatTurnFailure | null = null;
  const kind: string | null = ChatJson.str(reason, 'kind');
  if (kind === 'error') {
    // error 不是对象的兜底与插件 `turnFailureOf` 一致（`String(error)`）：
    // 内核偶尔会给一个字符串错误，那时消息本身就是信息，不能整条丢掉。
    const errorObj: JsonMap | null = ChatJson.obj(reason, 'error');
    let message: string | null = ChatJson.str(errorObj, 'message');
    if (message === null) {
      // 非对象形态：原语内容即信息（数字/布尔也照 contentOrNull 转字符串）。
      message = ChatJson.str(reason, 'error');
    }
    failure = new ChatTurnFailure(
      message === null ? '' : message,
      ChatJson.str(errorObj, 'code'),
      false,
    );
  } else if (kind === 'aborted') {
    const inner: JsonMap | null = ChatJson.obj(reason, 'reason');
    if (ChatJson.str(inner, 'kind') === 'hook'
      && ChatJson.str(inner, 'reason') === 'deepseek-account/signed-out') {
      failure = new ChatTurnFailure(
        // 文案由界面按 code 本地化；这里留空，免得纯逻辑层再写死一种语言。
        '',
        'ACCOUNT_SIGNED_OUT',
        true,
      );
    }
  }
  if (failure === null) {
    return null;
  }
  // message 为空（AUTH 被内核抹空）时仍然要显示 —— 那一行的标题与错误码就是信息。
  const code: string | null = failure.code;
  if (isBlank(failure.message) && (code === null || code.length === 0)) {
    return null;
  }
  return new ChatDisplayItem(`${event.seq}-turn-failure`, event.seq, ChatItemKind.FAILURE,
    null, '', false, [], [], [], failure, event.time);
}

export function userItems(event: SessionEvent): ChatDisplayItem[] {
  const data: JsonMap | null = event.dataMap();
  if (data === null) {
    return [];
  }
  const source: JsonMap | null = ChatJson.obj(data, 'source');
  const kind: string | null = ChatJson.str(source, 'kind');
  // 交接说明**只可能出现在用户消息里**（插件改写的是用户发的那条 content）。
  // 上下文注入的正文里时不时就引用着路径 —— 记忆库文本、README 示例、上一轮的工具输出，
  // 拿真实会话跑一遍就抓到了：不设这道闸，那些正文会被切碎，还会凭空多出几张读不到的假附件。
  const isUser: boolean = kind === 'user';
  const parts: string[] = contentTextParts(JsonAccess.raw(data, 'content'));

  const handoffPaths: string[] = [];
  if (isUser) {
    for (let i = 0; i < parts.length; i++) {
      const found: string[] = handoffPathsIn(parts[i]);
      for (let k = 0; k < found.length; k++) {
        if (handoffPaths.indexOf(found[k]) < 0) {
          handoffPaths.push(found[k]);
        }
      }
    }
  }

  // 按**行**摘而不是整条 part 摘：实测插件把说明放在独立 part 里，但万一哪天和用户
  // 正文同处一条 part，整条摘掉会把用户自己打的话一起吞了。
  let body: string;
  if (isUser) {
    const kept: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const stripped: string = stripHandoffLines(parts[i]);
      if (isNotBlank(stripped)) {
        kept.push(stripped);
      }
    }
    body = kept.join('\n\n');
  } else {
    body = contentText(JsonAccess.raw(data, 'content'));
  }

  const attachments: ChatAttachment[] = contentAttachments(JsonAccess.raw(data, 'content'));
  for (let i = 0; i < handoffPaths.length; i++) {
    attachments.push(handoffAttachment(handoffPaths[i]));
  }

  if (isUser) {
    // 判据是「有文字**或**有附件」。旧代码只判文字，于是「只发一张图、不打字」
    // 的消息会整条消失 —— 用户看到的正是「客户端里看不见图片」。
    if (isBlank(body) && attachments.length === 0) {
      return [];
    }
    return [new ChatDisplayItem(`${event.seq}-user`, event.seq, ChatItemKind.USER,
      null, body, false, attachments, [], [], null, event.time)];
  }
  return [new ChatDisplayItem(`${event.seq}-context`, event.seq, ChatItemKind.CONTEXT,
    contextLabel(source), body, false, attachments, [], [], null, event.time)];
}

/**
 * 从 content 数组里取出图片附件引用。
 *
 * 只认 `type == "image"`；`type == "file"` 的凭证（receiptId）指向的是一次上传的暂存区，
 * 与服务端持久化的附件存储不是同一套东西，硬接只会拿到 404。
 */
export function contentAttachments(content: Object | null): ChatAttachment[] {
  const parts: Object[] = Array.isArray(content) ? content as Object[] : [];
  const out: ChatAttachment[] = [];
  for (let i = 0; i < parts.length; i++) {
    const value: JsonMap | null = JsonAccess.asMap(parts[i]);
    if (value === null || ChatJson.str(value, 'type') !== 'image') {
      continue;
    }
    const attachment: JsonMap | null = ChatJson.obj(value, 'attachment');
    if (attachment === null) {
      continue;
    }
    const attachmentId: string | null = ChatJson.str(attachment, 'attachmentId');
    if (attachmentId === null || isBlank(attachmentId)) {
      continue;
    }
    const mediaType: string | null = ChatJson.str(attachment, 'mediaType');
    out.push(new ChatAttachment(
      attachmentId,
      mediaType === null ? '' : mediaType,
      ChatJson.int(attachment, 'width') ?? 0,
      ChatJson.int(attachment, 'height') ?? 0,
      ChatJson.int(attachment, 'bytes') ?? 0,
      ChatJson.str(attachment, 'name'),
    ));
  }
  return out;
}

/** 把交接说明的两行从一段正文里摘掉，其余原样保留。 */
export function stripHandoffLines(part: string): string {
  const lines: string[] = kotlinLines(part);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line: string = lines[i];
    if (line.indexOf(HANDOFF_SOURCE_MARKER) >= 0 || trimStartWs(line).startsWith(HANDOFF_PREAMBLE_MARKER)) {
      continue;
    }
    kept.push(line);
  }
  return trimText(kept.join('\n'));
}

/** 一条 text part 里出现的交接路径（正常是 0 或 1 条）。 */
export function handoffPathsIn(part: string): string[] {
  const out: string[] = [];
  // 每次调用都新建 RegExp 实例：全局正则带 lastIndex 状态，复用会漏匹配。
  const pattern: RegExp = new RegExp(HANDOFF_SOURCE_PATTERN.source, 'g');
  let match: RegExpExecArray | null = pattern.exec(part);
  while (match !== null) {
    const path: string = trimText(match[1]);
    if (isNotBlank(path)) {
      out.push(path);
    }
    match = pattern.exec(part);
  }
  return out;
}

/**
 * 把一条交接路径变成**可直接显示**的附件。
 *
 * 用 `handoff:<绝对路径>` 当 [ChatAttachment.attachmentId]：它同时是图片缓存的键、
 * 去重的键和「从哪读字节」的唯一依据 —— 路径本身就能定位文件，不必再引一张 id 表。
 */
export function handoffAttachment(path: string): ChatAttachment {
  let name: string = afterLast(path, '/');
  if (isBlank(name)) {
    name = path;
  }
  return new ChatAttachment(HANDOFF_ATTACHMENT_PREFIX + path, handoffMediaType(name),
    0, 0, 0, name, path);
}

export function handoffMediaType(name: string): string {
  const ext: string = afterLastOrEmpty(name, '.').toLowerCase();
  if (ext === 'png') {
    return 'image/png';
  }
  if (ext === 'jpg' || ext === 'jpeg') {
    return 'image/jpeg';
  }
  if (ext === 'webp') {
    return 'image/webp';
  }
  if (ext === 'gif') {
    return 'image/gif';
  }
  if (ext === 'bmp') {
    return 'image/bmp';
  }
  if (ext === 'heic') {
    return 'image/heic';
  }
  if (ext === 'heif') {
    return 'image/heif';
  }
  if (ext === 'avif') {
    return 'image/avif';
  }
  return '';
}

export function assistantItems(event: SessionEvent): ChatDisplayItem[] {
  const outer: JsonMap | null = event.dataMap();
  if (outer === null) {
    return [];
  }
  const message: JsonMap | null = ChatJson.obj(outer, 'message');
  const scope: JsonMap = message === null ? outer : message;
  const content: Object | null = JsonAccess.raw(scope, 'content');

  if (!Array.isArray(content)) {
    const text: string = contentText(content);
    if (isNotBlank(text)) {
      return [new ChatDisplayItem(`${event.seq}-assistant`, event.seq, ChatItemKind.ASSISTANT,
        null, text, false, [], [], [], null, event.time)];
    }
    return [];
  }

  const blocks: Object[] = content as Object[];
  const result: ChatDisplayItem[] = [];
  const prose: string[] = [];

  // 散文段连续累积、遇到非文本块就整段 flush —— 这样「思考-正文-思考」不会被拼成一条。
  for (let i = 0; i < blocks.length; i++) {
    const value: JsonMap | null = JsonAccess.asMap(blocks[i]);
    if (value === null) {
      continue;
    }
    const type: string | null = ChatJson.str(value, 'type');
    if (type === 'text') {
      const text: string | null = ChatJson.str(value, 'text');
      if (text !== null && isNotBlank(text)) {
        prose.push(text);
      }
    } else if (type === 'reasoning') {
      if (prose.length > 0) {
        result.push(new ChatDisplayItem(`${event.seq}-assistant-${result.length}`, event.seq,
          ChatItemKind.ASSISTANT, null, prose.join('\n\n'), false, [], [], [], null, event.time));
        prose.length = 0;
      }
      const reasoning: string | null = ChatJson.str(value, 'text');
      if (reasoning !== null && isNotBlank(reasoning)) {
        result.push(new ChatDisplayItem(`${event.seq}-reasoning-${result.length}`, event.seq,
          ChatItemKind.REASONING, null, reasoning, false, [], [], [], null, event.time));
      }
    }
  }
  if (prose.length > 0) {
    result.push(new ChatDisplayItem(`${event.seq}-assistant-${result.length}`, event.seq,
      ChatItemKind.ASSISTANT, null, prose.join('\n\n'), false, [], [], [], null, event.time));
  }
  return result;
}
