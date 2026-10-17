# 测试

## 命令

```bash
cd test && npm test
```

## 用例数演进

| 版本 | 用例数 | 门验结果 |
|---|---|---|
| 1.0.0 | 531 | 全绿 |
| 1.0.2 | 531 | 全绿（改名去品牌 + AI 生成内容标识，未增删用例） |
| 1.0.3 | 684 | **全绿**（第 1–5 批移植补齐 + Clock 接缝 + 主题三档 + 外观单测；43 个用例文件） |

> 数字随代码变化，**勿当常量引用**。
>
> **2026-10-17（未出包）**：新增**五个**用例文件 ——
> `cases/chat-display-groups.test.ts`、`cases/code-highlight.test.ts`
> （对位源工程 `ChatDisplayGroupsTest.kt` / `ChatCodeHighlightTest.kt`），
> 以及第 3 批随功能一起落地的 `cases/chat-fork.test.ts`（6 例）、
> `cases/bridge-capabilities.test.ts`（15 例）、`cases/image-save.test.ts`（17 例）
> —— 后三个分别对位源工程的 `ChatForkPointTest.kt`、`BridgeCapabilitiesTest.kt`、
> `ChatImageViewerTest.kt`。
>
> **2026-10-17（未出包，第 4 批）**：再新增**八个**用例文件 ——
> 功能侧六个：`cases/request-gate.test.ts`、`cases/event-debouncer.test.ts`、
> `cases/chat-seq-monitor.test.ts`、`cases/session-stats.test.ts`、`cases/trajectory.test.ts`、
> `cases/chat-visible-items.test.ts`（分别对位源工程 `RequestGateTest.kt` / `EventDebouncerTest.kt` /
> `ChatSeqMonitorTest.kt` / 统计与轨迹的纯函数 / 展示口径纯函数）；工程侧两条**文档门禁**：
> `cases/architecture-guard.test.ts`（行数预算 + 台账登记 / 唯一网络边界 / `ui/` 不读偏好 /
> 会话展示单一出口）、`cases/strings-parity.test.ts`（中英键与占位符一致）。
> 门禁读的是**真实源码树与真实资源文件**（`readFileSync` 直读磁盘，与坑 28 同一教训：
> FUSE 上 `Grep` 会读过期视图），每个用例开头跑「盘面自检」，扫到的文件数不足即红 ——
> 杜绝「路径解析错、什么都没扫到、于是全绿」那种**冒充证据**的假绿。
>
> **为什么这三条判据要单独测**：它们错了在真机上都不**报错**，只表现为
> 「某几条消息莫名多 / 少一个按钮」（分叉）、「弹一个假的『能力缺失』警告或
> 展示一条空的归档列表」（能力位）、「存下来的图预览器打不开」（文件名扩展名）——
> 都是当场看不出是哪一步错的那种错。用例里刻意收进了真实魔数字节
> （PNG / JPEG / GIF / HEIF）与 `42` / `true` / `null` 这类脏 JSON，
> 就是为了把「静默走错分支」这条路径钉死。
>
> **2026-10-17（工具链恢复后首跑）实测 684 例、43 个用例文件**，回填如下（数字是 `node --test`
> 自己报的，不是预估）。首跑 **4 条红**，全部修掉后**全绿** ——
> 两条是**用例自身写错**（把哨兵值 `0` 当真实起点时间戳，见 `chat-display-groups.test.ts` /
> `trajectory.test.ts` 内注释），两条是**门禁抓出的真缺陷**：`strings-parity.test.ts` 报
> `base` 只有 359 键、`en_US` 有 392 键 —— 即 33 个界面引用键的**中文取值从未落盘过**
> （此前只写了英文、中文那批是工具回显造成的假象，详见 PORT-MAP 收尾）。修法是读盘补齐
> `base/element/string.json`，另加编译产出的 `BUILD SUCCESSFUL` 与未签名 HAP 见 STATUS。
> **首跑见红正说明门禁不是摆设**：若它一开始就是绿的，那反而是「路径解析错、什么都没扫到」。
>
> **2026-10-17（未出包，收口）**：再补**一个**用例文件 ——
> `cases/appearance-preferences.test.ts`（对位源工程 `AppearancePreferencesTest.kt`）：
> `normalizeFontScale` 的两条边界与非法值兜底、`effectiveFontScale` 的两支、`formatFontScale`
> 的固定一位小数、`normalizeThemeMode` 的三档判定与回落，以及 `AppPreferences` 的
> `themeMode` / `fontScale` / `fontFollowsSystem` 读写往返。**为什么补**：这几条都是
> 「取错值不崩、只悄悄难看」的纯函数（NaN 字号白屏、跟随系统写反导致双重放大、档位认不出
> 深浅色互换），源工程为它们专门立了一个测试类；本仓此前只在 `app-preferences.test.ts` 里
> 覆盖了发送模式与开关，**字号与主题没测**。

## 真机验收记录

| 日期 | 项 | 结果 |
|---|---|---|
| 2026-10-16 | 表格列宽不断英文词（坑 23 复测） | ✅ 整词折行，`bundleNam`/`e` 缺陷消失 |
| 2026-10-16 | 会话页 `/` 带出 dsh 命令（坑 24 复测） | ✅ 输入 `/` 即带出 `state.commands` |
| 2026-10-16 | 改名去品牌后应用信息（1.0.2） | ✅ 标题「DSH 伴侣」、连接页「连接服务端」，`bm dump -n com.dsh.westanke` 报 `versionCode` 1000002 |
| 2026-10-16 | AI 生成内容显式标识（1.0.2） | ✅ 助手消息底部固定显示「内容由 AI 生成」，证据见 `docs/screenshots/ai-generated-label-evidence.png` |
| 2026-10-16 | 设置页药丸选中态即时刷新（坑 27 复测） | ✅ 点「排队 / 插话发送」当场重绘（前后截帧 MD5 不同、描述文案同步切换）；修复前同一操作两帧 MD5 **完全相同** |
| 2026-10-17 | 同调试签名**覆盖安装保住配对数据**（1.0.3） | ✅ `wangke-PC` 仍「已连接」，局域网 / 虚拟网两地址俱在 |
| 2026-10-17 | 消息时间戳渲染（`core/ChatTimeLabel.ts`） | ✅ 用户/助手气泡内显示 `12:50` / `12:51` |
| 2026-10-17 | 会话级状态条合并（思考条 + AI 标识） | ✅ 底部**单条**「内容由 AI 生成」在位 |
| 2026-10-17 | 工具行 + 「滚动到底部」按钮 | ✅ `🔧 执行了命令 · <命令名> ›` 与滚动到底按钮在位 |
| 2026-10-17 | 构建水印 + 平台层自检（设置页） | ✅ 水印行与 `prefs:ok · aesgcm:ok · hosts:0 · send:queue · lang:zh-Hans-CN · tz:Asia/Shanghai` 均渲染（`hosts:0` 是探针空表往返，非真实主机数，符合设计） |
| 2026-10-17 | 主题三档即时 + 持久化 | ✅ 点「深色」即时整页转深，重启后仍为 `dark` |
| 2026-10-17 | 字号档步进 + 落盘 | ✅ 步进器同帧更新、`hdc` 直读 `dsh_settings` 偏好核对 `font_scale` |
| 2026-10-17 | **设置页说明文字随字号档同帧更新（坑 40 复测）** | ✅ 同页实例内点「＋」，步进器 `1.4×` → `1.5×`、说明**同帧**跟到「应用字号 1.5×」；修复前同帧里步进器 `1.3×` 而说明仍写 `1.2×`（互相打脸） |
| 2026-10-17 | 会话列表渲染（坑 40 修复**无回归**） | ✅ 共 48 个会话正常渲染、设置页正常 |

> 装机形态：release 构建 + 调试证书签名（`appProvisionType=debug` / `debug=false`）。
>
> **2026-10-17 上机的是**：上表 9 条（其中只有 3 条是新增能力项，其余是状态条 / 时间戳等
> 渲染表现）。**39 条新能力中未上机的项仍记为「编译 + 单测通过，未逐条上机」** —— 不写成
> 「真机通过」。`SessionRow` 的「改名后行标题即时刷新」路径**本轮未上机**（中文标题无法用
> `uitest inputText` 输入、且改名会落到用户真实会话上），按机制推断已修，见 CHANGELOG 诚实标注。

## 纪律

- 修 bug 必须带回归用例。
- 测试文件命名与被测模块对应，夹具集中在 `test/cases/`。
- 不许为凑数加空断言测试。
- **单测绿 ≠ 行为对**：手势、键盘、表格渲染、表格列宽、断流重连一律真机确认。
