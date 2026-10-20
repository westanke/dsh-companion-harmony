/**
 * 服务端在 `connection.ready` 里自报的版本与能力位 —— 移植自源工程
 * `data/BridgeCapabilities.kt`（逐条对应）。
 *
 * 为什么客户端要读它：服务端「能做哪些事」是**运行时事实**，而安装文档里那句
 * 「要求 bridge ≥ 2.x」只是给用户看的安装门槛。二者不能混为一谈 —— 用户完全可能
 * 连着一台旧插件，然后遇到「功能静默不工作」：审批卡片不弹，界面上看起来与
 * 「本来就没有待审批」**一模一样**。
 *
 * 本文件只做「读出来、判得了」两件事；「缺能力位时弹警告」那条界面路径
 * 属于第 4 批（服务端能力位探测），这里先把判据与状态位备好。
 */

import { JsonAccess, JsonMap } from './JsonAccess';

/** 服务端自报的版本与能力位。 */
export class BridgeCapabilities {
  /** 服务端自报的插件版本；仅用于诊断展示，**不作为功能判据**。 */
  bridgeVersion: string | null;
  capabilities: Set<string>;

  constructor(bridgeVersion: string | null, capabilities: Set<string>) {
    this.bridgeVersion = bridgeVersion;
    this.capabilities = capabilities;
  }
}

/**
 * 本 App **依赖**的能力位：缺了就会出现「功能静默不工作」的那些。
 *
 * 只列这类，不列全部：能力位是给特性探测用的，把「锦上添花」也算进必需项
 * 会让每个稍旧的服务端都弹出警告，警告一多就没人看了。
 *
 * **这两个名字是跨仓契约**：服务端 `capabilities.spec.ts` 里有一条对应的钉子，
 * 防止那边把它们当死代码删掉 —— 那样会让这里对**所有用户**误报「插件过旧」。
 */
export const REQUIRED_CAPABILITIES: string[] = ['approvals-v1', 'questions-v1'];

/** 「列出已归档会话」的能力位名。 */
export const ARCHIVE_LIST_CAPABILITY: string = 'session-archive-list-v1';

/**
 * 从 `connection.ready` 的 `data` 里读出能力清单。
 *
 * 读不到就返回 **null（未知）**，而不是「空清单」。两种情况一律算未知：
 *
 * - 字段缺失（旧服务端根本不报）；
 * - 清单为空数组。
 *
 * 为什么空数组也算未知：服务端在现实里不会声明「我一条能力都没有」，真实的空数组
 * 只可能来自字段被误删/降级；而把它当成「什么都缺」会让调用方弹出**假警告** ——
 * 假警告比没有警告更坏，它教会用户忽略警告。代价是「服务端明确说自己没能力」
 * 这一（不存在的）情形被读成未知，结果是不提示，方向上是安全的。
 *
 * 调用方一律按「null → 不提示、不降级」处理。
 */
export function parseBridgeCapabilities(data: JsonMap | null): BridgeCapabilities | null {
  if (data === null) {
    return null;
  }
  const version: string | null = JsonAccess.str(data, 'bridgeVersion');
  const declared: Object[] = JsonAccess.arr(data, 'capabilities');
  const capabilities: Set<string> = new Set<string>();
  for (let i = 0; i < declared.length; i++) {
    const item: Object = declared[i];
    // `typeof item !== 'string'` 这一层不是多余的：`42` 也能进数组，
    // 只看「是不是标量」会把它读成能力名 `"42"`，于是一个数字错位就能让清单里
    // 多出一条永远不会匹配的假能力位（源工程实测被单测抓过一次）。
    if (typeof item === 'string') {
      capabilities.add(item as string);
    }
  }
  if (capabilities.size === 0) {
    return null;
  }
  return new BridgeCapabilities(version, capabilities);
}

/**
 * 服务端是否支持「列出已归档会话」（能力位 `session-archive-list-v1`）。
 *
 * 读不到能力清单时返回 **false**（不显示入口）——这是安全方向：老 bridge 会忽略
 * `archived` 参数并返回未归档列表，若此时展示入口，用户只会看到「一条归档都没有」
 * 这个**假结论**。
 */
export function supportsArchiveListing(capabilities: Set<string> | null): boolean {
  return capabilities !== null && capabilities.has(ARCHIVE_LIST_CAPABILITY);
}

/** 「后台任务面板」的能力位名。 */
export const JOB_LIST_CAPABILITY: string = 'job-list-v1';

/**
 * 服务端是否支持「后台任务」面板（能力位 `job-list-v1` / `job-kill-v1` /
 * `job-output-v1`，bridge ≥ 2.4.3）。
 *
 * **为什么只查 `job-list-v1` 一个**：三个能力位在服务端 `capabilities.ts` 里
 * **同批声明、同批发布**，不存在「只有 list 没有 kill」的中间态 —— 逐个都查只会把
 * 判据写长，语义没有任何变化。哪天服务端真的拆开发布了，再把判据拆细不迟
 * （到时候这条注释就是提示）。
 *
 * 读不到能力清单时返回 **false**（不显示入口）——这是安全方向：老 bridge 上
 * 这个路由是 404，显示了入口只会让用户点进去看报错。
 */
export function supportsJobListing(capabilities: Set<string> | null): boolean {
  return capabilities !== null && capabilities.has(JOB_LIST_CAPABILITY);
}

/**
 * 本 App 依赖、但服务端**没有声明**的能力位；空数组 = 没缺。
 *
 * 注意调用方必须先确认「拿到了能力清单」（[parseBridgeCapabilities] 返回非 null），
 * 否则旧服务端会被判成「什么都缺」。
 */
export function missingRequiredCapabilities(capabilities: Set<string>): string[] {
  const missing: string[] = [];
  for (let i = 0; i < REQUIRED_CAPABILITIES.length; i++) {
    const name: string = REQUIRED_CAPABILITIES[i];
    if (!capabilities.has(name)) {
      missing.push(name);
    }
  }
  return missing;
}
