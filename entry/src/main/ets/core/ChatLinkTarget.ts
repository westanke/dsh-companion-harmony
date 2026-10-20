/**
 * 一条 Markdown 链接点了之后应该发生什么 —— 移植自原工程 `data/ChatLinkTarget.kt`。
 *
 * 抽成纯函数是因为「点错东西」的代价不对称：把 `mailto:` 当成文件路径去解析，用户会看到
 * 一个莫名其妙的「路径不存在」；把相对路径猜成绝对路径，可能打开**另一个**文件。
 * 所以这里的原则是**只处理能确定的，其余一律明确告知不支持**，绝不猜。
 *
 * 用单一扁平类而不是继承：ArkTS 严格模式下类继承容易撞上语法歧义（见 `PromptPart` 的同款
 * 处理），所以这里用 `kind` 判别 + 只填对应形态的字段。
 */

import { trimText } from './TextPredicates';

/** 一条链接的三种去向。 */
export enum ChatLinkTargetKind {
  /** 服务端绝对路径。交给 `roots/resolve` 解析成「授权根 + 相对路径」。 */
  SERVER_PATH = 'server-path',
  /** 普通网页。交给系统浏览器。 */
  WEB = 'web',
  /** 无法在本机安全处理的目标（相对路径、锚点、mailto、其他 scheme）。 */
  UNSUPPORTED = 'unsupported',
}

/**
 * 「不支持」的原因。
 *
 * 用枚举而不是拼好的文案，是为了让界面侧自己决定怎么本地化，也让测试断言的是**分类结果**
 * 而不是某一句中文。
 */
export enum ChatLinkReason {
  /** 相对路径：服务端只接受绝对路径，且相对路径的基准是服务端的 cwd，语义不确定。 */
  RELATIVE_PATH = 'relative-path',
  /** 空串或纯空白。 */
  EMPTY = 'empty',
  /** 页内锚点。 */
  ANCHOR = 'anchor',
  /** 其他 scheme（mailto:、tel:、data: …）。 */
  UNKNOWN_SCHEME = 'unknown-scheme',
}

/**
 * 分类结果。
 *
 * - [SERVER_PATH]：`path` 是服务端绝对路径，`reason` 为 null；
 * - [WEB]：`path` 是网页地址，`reason` 为 null；
 * - [UNSUPPORTED]：`path` 是**原始**目标（保留原文供排查），`reason` 说明为什么不支持。
 */
export class ChatLinkTarget {
  readonly kind: ChatLinkTargetKind;
  readonly path: string;
  readonly reason: ChatLinkReason | null;

  constructor(kind: ChatLinkTargetKind, path: string, reason: ChatLinkReason | null) {
    this.kind = kind;
    this.path = path;
    this.reason = reason;
  }

  static serverPath(path: string): ChatLinkTarget {
    return new ChatLinkTarget(ChatLinkTargetKind.SERVER_PATH, path, null);
  }

  static web(url: string): ChatLinkTarget {
    return new ChatLinkTarget(ChatLinkTargetKind.WEB, url, null);
  }

  static unsupported(raw: string, reason: ChatLinkReason): ChatLinkTarget {
    return new ChatLinkTarget(ChatLinkTargetKind.UNSUPPORTED, raw, reason);
  }

  isUnsupported(): boolean {
    return this.kind === ChatLinkTargetKind.UNSUPPORTED;
  }

  /**
   * 分类一个 Markdown 链接目标。
   *
   * 判定顺序有讲究：**先认绝对路径，再认 scheme**。
   * 因为 `//example.com/x` 这种协议相对 URL 以 `/` 开头但它是网页而不是服务端路径；
   * 而 `file:///abs/path` 虽然带 scheme，我们也不当本地文件处理（手机与服务端不是同一台
   * 机器，「本地文件」这个概念在远程场景下没有意义）。
   */
  static classify(raw: string): ChatLinkTarget {
    // **先剥 Markdown autolink 的尖括号**（源 v2.2.44 `a344e3f` 补的）：
    // `[text](</abs/path>)` 是 CommonMark 允许的写法（路径含空格/特殊字符时常用），
    // 模型也真的这么写。不剥的话 `<...>` 既不以 `/` 开头、也没有 scheme，
    // 会被一路判成**相对路径** —— 于是绝对路径又被拼了一次 cwd，得到
    // `/media/wangke/OFFICE/workspace/</media/wangke/.../x.md>` 这种翻倍路径。
    let target: string = trimText(raw);
    if (target.length >= 2 && target.startsWith('<') && target.endsWith('>')) {
      target = trimText(target.substring(1, target.length - 1));
    }
    if (target.length === 0) {
      return ChatLinkTarget.unsupported(raw, ChatLinkReason.EMPTY);
    }

    // 协议相对 URL（//host/path）是网页，不是服务端路径。必须先排掉。
    if (target.startsWith('//')) {
      return ChatLinkTarget.web(`https:${target}`);
    }

    if (target.startsWith('#')) {
      return ChatLinkTarget.unsupported(raw, ChatLinkReason.ANCHOR);
    }

    if (target.startsWith('/')) {
      // 以 / 开头且不是 //，就是我们唯一认得的服务端绝对路径形态。
      return ChatLinkTarget.serverPath(target);
    }

    const colon: number = target.indexOf(':');
    const scheme: string = (colon >= 0 ? target.substring(0, colon) : '').toLowerCase();
    if (scheme === 'http' || scheme === 'https') {
      return ChatLinkTarget.web(target);
    }
    if (scheme.length === 0) {
      return ChatLinkTarget.unsupported(raw, ChatLinkReason.RELATIVE_PATH);
    }
    return ChatLinkTarget.unsupported(raw, ChatLinkReason.UNKNOWN_SCHEME);
  }
}
