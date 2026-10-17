/**
 * 请求代际闸门：让**过期的请求结果**写不回状态 —— 移植自源工程 `data/RequestGate.kt`。
 *
 * ## 它挡的是什么
 *
 * 界面上有几个异步加载（历史、模型列表、命令、审批…），每个都要一次网络往返。
 * 用户切会话是瞬时的，而请求不是 —— 于是会出现这样的时序：
 *
 * 1. 在会话 A 里点了「刷新历史」，请求发出；
 * 2. 用户立刻切到会话 B，B 的请求发出；
 * 3. **A 的响应先回来**，把 B 的状态覆盖成 A 的历史。
 *
 * 用户看到的症状是「切过去又跳回来」，或者更糟 —— 看到的是**另一个会话的内容**
 * 而标题写着 B。这类 bug 难复现（要卡在特定时序上），但一旦出现就很吓人。
 *
 * ## 与源工程的唯一差别：没有原子性
 *
 * Kotlin 侧用 `AtomicInteger`，因为它的 ViewModel 方法与协程分属不同线程。ArkTS 的
 * 单线程事件循环里，一次 `await` 之间不会有别的回调插进来执行到这一行 ——
 * 一个普通 `number` 字段就够，加锁反而让人以为这里有并发。
 *
 * ## 用法
 *
 * 加载任务在**开始时**领一个号（`current()`），回来时先问 `isCurrent()`；
 * 对不上就整块丢弃，不写状态。每次「上下文切换」（换会话、换主机、断开连接）
 * 调一次 `invalidate()`。
 *
 * 只丢弃、不取消：取消要拿到每个 in-flight promise 的句柄，复杂度远高于收益 ——
 * 一个已经在飞的网络请求，让它跑完再扔掉结果是最省事的正确做法。
 */
export class RequestGate {
  private generation: number = 0;

  /** 当前代际。加载任务在开始时领号。 */
  current(): number {
    return this.generation;
  }

  /** 作废此前发出的所有号（上下文切换时调用），返回新的代际号。 */
  invalidate(): number {
    this.generation += 1;
    return this.generation;
  }

  /** 这个号还是当前代际吗（对不上 = 结果属于上一个上下文，必须丢弃）。 */
  isCurrent(token: number): boolean {
    return token === this.generation;
  }
}
