/**
 * 一条带序号的事件能不能接上上一条 —— 移植自源工程 `data/ChatSeqMonitor.kt`。
 *
 * 「断档」在这里有精确定义：**序号跳了**（`incoming > last + 1`）。
 * 重复与倒退**不算**断档 —— 那是去重该处理的事；把它们也判成断档会让每次重连
 * （服务端可能重发一小段）都触发一次全量重取，白烧流量。
 *
 * ## 为什么需要它
 *
 * WS 是「订阅之后才收得到」，而 REST 历史是「发请求那一刻的快照」。两者的时间差里
 * 发生的事件**谁都管不着** —— 除非客户端能自己发现「我漏了一段」。服务端在订阅时
 * 下发 `chat.session.snapshot`（带 `cursor`），这就是那个参照点。
 *
 * ## 两条判据为什么都是纯函数
 *
 * 它们决定了「要不要把整份历史重拉一遍」这个**代价不低**的动作：判错成 Resync 会让
 * 每次重连都白拉一份历史（用户看到的是列表无谓地闪一下）；判错成 Continue 会让用户
 * 永远看不到中间丢掉的那一段（**没有任何提示**，最坏的一种）。这两条都得有单测钉住。
 */

/** 判定结果：接得上 / 必须重取历史。 */
export enum SeqVerdict {
  /** 接得上：把这条事件正常并入。 */
  CONTINUE = 'CONTINUE',
  /** 接不上：历史与事件流之间有洞，应重取历史（resync）。 */
  RESYNC = 'RESYNC',
}

/**
 * 判定这条事件要不要触发 resync。
 *
 * - `incomingSeq === null`：这条事件本来就没有序号（流式 delta 不再带 `seq`），不参与判定；
 * - `lastSeq === null`：还没有起点（刚订阅、或刚 resync 完），先记下这条当起点；
 * - `incomingSeq <= lastSeq`：重复或倒退，交给去重，不算断档；
 * - 只有**严格跳号**才算断档。
 */
export function seqVerdict(lastSeq: number | null, incomingSeq: number | null): SeqVerdict {
  if (incomingSeq === null || lastSeq === null) {
    return SeqVerdict.CONTINUE;
  }
  if (incomingSeq <= lastSeq) {
    return SeqVerdict.CONTINUE;
  }
  return incomingSeq === lastSeq + 1 ? SeqVerdict.CONTINUE : SeqVerdict.RESYNC;
}

/**
 * 本地历史是否**落后于订阅基线**。
 *
 * 这是另一种断档 —— 不发生在事件流里，而发生在「REST 拉取」与「WS 订阅」之间：
 * 拉历史拿到 seq 到 100，订阅时服务端说基线在 140，那 101–140 就真的谁都没管。
 *
 * `localMaxSeq === null`（本地一条都没有）时返回 true：服务端已经有内容而本地是空的，
 * 正是最该立刻拉一次的情况。
 */
export function baselineBehind(localMaxSeq: number | null, cursor: number | null): boolean {
  if (cursor === null) {
    return false;
  }
  if (localMaxSeq === null) {
    return true;
  }
  return localMaxSeq < cursor;
}
