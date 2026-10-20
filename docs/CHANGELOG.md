# 变更日志

本文件记录 DSH 伴侣（HarmonyOS 原生版）的所有重要变更。

- 格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)
- 版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)
- 分组名称与 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)
  的类型对应：新增 `feat` / 变更 `refactor` / 修复 `fix` / 移除 `remove` / 文档 `docs`

## 写入约定

1. **每一次改动都在此追加**，不允许只改代码不记文档。
2. 尚未发版的改动先写进 `## [未发布]` 段；发版时把该段整体挪到对应版本号下并补日期。
3. 条目要写清**为什么**，而不只是**改了什么** —— 本工程是 Android → HarmonyOS 的移植，
   很多改动的理由来自平台差异，不写理由后来者会重复踩坑。
4. 移植过程中的逐模块对照与具体坑点另见 [PORT-MAP.md](./PORT-MAP.md)；
   本文件只记**面向版本**的变更，不重复其模块级细节。

---

## [未发布]

> 下一版尚未定内容的改动写在这里。

### 新增

- **追平源工程 v2.2.43–v2.2.46 的增量能力**（本轮进行中，数据层已落盘、界面接入随后）。
  源工程在本工程基线 v2.2.42 之后又推了 6 个提交；逐提交对照与取舍见
  [PARITY.md](./PARITY.md) 与 [PORT-MAP.md](./PORT-MAP.md)「收尾十四」。本轮先落**纯逻辑数据层**
  （可离线单测、无真机依赖）：
  - **工具调用专用块**（对标官方 Web 的 Read / Terminal / Diff，源 `a96f5e7`）：
    新增 `core/ToolBlocks.ts` 的 `toolBlockView()`，把 `read` / `read_image` / `bash` / `edit` / `write`
    投影成三种专用长相（文件+带行号正文 / 终端提示符+命令+输出 / 改动前后对照），其余工具回落 Generic。
    另含 `extractReadBody()`（剥 `<content>` 包装、判 `N: ` 行号前缀）与 `stripAnsiEscapes()`
    （手写扫描剥 CSI/OSC，**残缺序列不吞正文**）。
    **为什么解析单独成层**：口径与画法分开，口径才好用 `node --test` 钉住 —— 19 条用例专喂畸形输入
    （坏 JSON、非对象 arguments、缺 `<content>`、半截转义序列）。
    **铁律**：解析失败一律回落 Generic，专用块是增强不是依赖（源 `ChatToolBlocksTest.kt` 同款纪律）。
  - **正文里的已知文件名自动链接化**（源 `a344e3f`）：新增 `core/PathLinks.ts` 的 `linkifyKnownFiles()`。
    **为什么**：模型常在正文里以纯文本写「已落盘：xxx.md」，用户点它毫无反应
    （源工程 2026-10-19 真机反馈「会话中有个文件，我试了打不开」）。三条安全约束：
    **唯一文件名才替换**（同名多目录宁可点不开，也不能点错另一个目录的文件）、
    **不碰已有 Markdown 链接**（否则得到 `[[t](p)](p)`）、**只替换第一次出现**。
  - **Markdown autolink 尖括号剥除**（源 `a344e3f`）：`core/ChatLinkTarget.ts` 的 `classify()`
    先剥 `</abs/path>` 的壳再分类。**为什么**：不剥壳时 `<…>` 既不以 `/` 开头也无 scheme，
    会被判成相对路径，于是绝对路径又拼一次 cwd → 「翻倍路径」
    （源工程真机实测 `PATH resolve 失败 code=PATH_NOT_FOUND` 就是它）。
- **刻意未移植：Markdown 表格「紧贴上一行」的前导空行归一化**（源 `f02c5b9`）。
  **为什么**：源工程修的是第三方解析器 `org.intellij.markdown` 的 GFM 表格缺陷 ——
  表头紧贴上一行且中间无空行时不产出 `TABLE` 节点。本工程 `core/MarkdownLite.ts` 是**自研逐行解析**，
  判据为「本行含 `|` 且下一行是分隔行」，**天然不受该缺陷影响**：实测（表头紧贴标题行 / 紧贴段落 /
  文档开头 / 围栏内伪表格 / 列表项后）五种现场全部正常出表格块，故不引入该归一化，
  免得白白多一层文本改写（证据记在 PORT-MAP「收尾十四」）。

### 修复

- **修 AGC 上架检测驳回的稳定性崩溃：连接页「粘贴」按钮闪退**
  （真机原文 `TypeError: Cannot read property length of undefined`
  at `ConnectScreen.ts:993:1`，测试机 Mate 60 / HarmonyOS 6.1 / API 24，触发链是触摸事件）。
  **为什么崩**：`pasteboard.PasteData.getPrimaryText()` 的**类型声明是 `string`，
  运行时却会给 `undefined`**（剪贴板里没有文本记录、应用没有读权限、或只拿到一条空记录；
  设备日志在异常前一行还能看到框架自己的抱怨 `GetPrimaryText# Get GetPrimaryText failed`）。
  调用点写的是 `const text: string = readClipboardText(); if (text.length > 0)` ——
  类型声明让这一句在编译期「看起来没问题」，运行时 `undefined.length` 直接抛 TypeError。
  **真正致命的是后半段**：ArkUI 回调里的未捕获异常不是「这次操作失败」，而是
  **杀掉整个应用进程**（设备日志：`com.dsh.westanke is about to exit due to RuntimeError`
  → `Kill Reason:Js Error`），用户看到的就是闪退。
  **怎么修**：新增纯函数 `core/ClipboardText.ts` 的 `normalizePrimaryText()`，
  把「非字符串一律当没有文本」这件事从平台层挪出来；`platform/Clipboard.ets` 改走它，
  于是 `readClipboardText()` **保证返回字符串**，调用点那句 `text.length > 0` 天然安全。
  **为什么单独一个文件而不是就地写三行**：`platform/` 层按工程约定不做离线单测
  （它是唯一真跑在设备上的一层，见 TESTING「平台层自检」），判断留在那里就只能靠人眼保证；
  挪进 `core/` 后 6 条回归用例（含 `undefined` / `null` / 数字 / 对象）钉住了这个不变式 ——
  用例断言的是**返回值本身是字符串**，而不是「长度是 0」，因为崩的正是「先取 length」这一步。
  坑点原文见 [PORT-MAP.md](./PORT-MAP.md) 坑 41。

### 文档

- **README 新增「自己安装（应用尚未上架应用市场）」一节**（路线 A 自建自签 / 路线 B 交 UDID 代签）。
  **为什么加**：应用因上架审核受阻**目前拿不到市场分发渠道**，而这块空白此前只散落在
  `docs/RELEASE.md`（面向本机工具链的手工签名命令）与 `docs/STATUS.md`（面向内部的状态记录）里 ——
  外部的人拿到仓库后既不知道「为什么装不上」，也不知道「要提供什么才能装得上」。
  **写进去的三件事**：① 设备**只信任**市场签名与**白名单内调试证书签名**两类包，
  故源码 / 未签名 hap / 发布证书签的 hap 一律装不上（签名校验不过即拒装）；
  ② 开发者用 DevEco「自动签名」即可自助完成（连着的设备 UDID 会被自动登记，无需手工准备材料）；
  ③ 非开发者需**提供设备 UDID**（`hdc shell bm get --udid` 取，手机端先开 USB 调试），
  维护者在 AGC 加入调试 Profile 白名单后重签回发，对方 `hdc install -r` 安装。
  另如实写明两点限制：调试签名的包**受 Profile 有效期约束**（过期须重签重装），
  以及**换签名来源安装要先卸载旧包**——实机经验是这一步会**清掉设备上已保存的连接与配对数据**，
  需重新配对。
- **上架截图按 1.0.3 真机重拍**（`docs/screenshots/` 6 张 + AI 标识证据图）。
  **为什么重拍**：1.0.3 的界面已变（设置页新增「外观」组、会话级状态条合并），
  1.0.2 的旧图不再代表当前版本，继续用会让审核员看到与安装包不一致的界面。
  **怎么拍**：在装 1.0.3 调试签名包的 ICL-AL10 上由 `uitest` 驱动到目标页，
  `snapshot_display` 取 1080×2440 原图，再按 `crop(0,120,1080,2040)` 裁成
  1080×1920（9:16）；偏移 120 是对旧图逐偏移滑动比对实测得到的（0 字节差），
  AI 标识证据图保留 2440 原图不裁。详见 [STATUS.md](./STATUS.md)「上架材料」。

## [1.0.3] - 2026-10-17

> **本段由 `[未发布]` 段整体迁入**（按《写入约定》第 2 条）。
> 其中 **1.0.1 / 1.0.2 两版均未作为独立版本对外发布**（1.0.0 被驳回后改名重建应用；
> 1.0.1 随旧应用失效），因此那两版的条目与 1.0.3 的同批内容一并记在此处，保留为开发史而非抹掉。
>
> ⚠️ **2026-10-20 更正**：上句原先写的是「1.0.2 打包后未上传」，**这句是错的** ——
> 2026-10-20 收到的 AGC 上架检测反馈里带回了真机故障包，
> 其中 `Version:1.0.2` / `VersionCode:1000002`，说明 **1.0.2 确实已上传并进了审核**，
> 只是当时的文档没跟着更新。正是这轮检测报出了下面的稳定性崩溃。
>
> **1.0.2（2026-10-16）**：AGC 驳回「应用与第三方应用名称相似、无商标权属证明」，拿不到授权
> 只能**改名去品牌并更换 `bundleName`**（在 AGC 重建应用），同时补上 AI 生成内容显式标识。
> **1.0.1 未上传即作废** —— 它仍带旧 `bundleName` 与品牌名，且旧 Profile 已随旧应用失效；
> 下文 1.0.1 相关段落保留为历史记录，不再代表线上状态。
>
> **1.0.3**：追平 Android 源工程 v2.2.42 的一整批新能力（39 条），并**首次真机逐条验证**；
> `versionCode` 1000003 —— 与 1.0.2 不是同一个东西，必须换号（AGC 不接受同号重复上传）。
>
> **真机验收（2026-10-17）**：ICL-AL10（HarmonyOS 7.0.0.109）装调试签名包，逐项上机确认：
> ① 同调试签名**覆盖安装保住配对数据**（`wangke-PC` 仍「已连接」，局域网 / 虚拟网两地址俱在）；
> ② 会话列表「共 48 个会话」、进会话详情正文与**消息时间戳**（`12:50` / `12:51`）渲染正常；
> ③ **合并后的会话级状态条**（底部单条「内容由 AI 生成」）+ 工具行
> （`🔧 执行了命令 · <命令名> ›`）与「滚动到底部」按钮均在位；
> ④ 设置页**构建水印**行与**平台层自检**均渲染
> （`prefs:ok · aesgcm:ok · hosts:0 · send:queue · lang:zh-Hans-CN · tz:Asia/Shanghai`；
> `hosts:0` 是探针空表往返、**不是**真实主机库计数，符合设计）；
> ⑤ **主题三档**点「深色」即时整页转深色，重启后仍为 `dark`；**字号档**步进并落盘
> （`hdc` 直读 `dsh_settings` 偏好文件核对 `font_scale`）。
> **措辞纪律**：未上机的项不写成「真机通过」——本次仅覆盖上列条目，
> 39 条新能力中**其余项仍为「编译 + 单测通过，未逐条上机」**（见 `docs/STATUS.md`）。

### 新增

- **移植安卓 v2.2.42「A 批 + Whaleness 舒适度」里风险最低的四项**（源工程开发日志
  `docs/project/CHANGELOG-DEV.md` 的 2026-10-17 三批清单）。这四项的共同点是**只加不改**：
  不动既有数据流、不动与 AGC 合规相关的渲染位置，所以先做。
  1. **消息时间戳**（`core/ChatTimeLabel.ts` + `ui/ChatMessage.ets`）：用户/助手消息气泡内
     渲染一行次要色时间，三档粒度 —— 今天只给 `14:03`、今年给 `10月16日 14:03`、更早给
     `2024年10月16日 14:03`。**只挂用户/助手消息**，工具行与过程组不挂。
     **为什么要分档**：一律只显示时刻的话，翻到上周的会话会看到一串 `14:03`，用户分不清
     那是今天还是上个月 —— 时间戳的作用正是「知道这条是什么时候说的」。
     - **两处刻意偏离源工程的实现手段**（结果一致），都是为了让这条路永不抛异常：
       ① 不用 `Intl.DateTimeFormat` 而自己拼中/英两种形态 —— `Intl` 在预览器与部分设备上
       不可靠，而这条路上抛异常就是**整条消息渲染不出来**；② 不显式传时区，改用「实现与测试
       共用同一套本地时区」（源工程显式传 `TimeZone` 只是为了让纯 JVM 单测能拿固定结果）。
     - **落位照抄源工程第六/七/八修的结论**：时间戳放进**气泡的 Column 里**（不是气泡之外），
       且**不设全宽**。源工程为此被用户连续反馈五次 —— 前四版都在调 padding，直到发现
       「间距根本不是 padding 产的」，真凶是全宽 `Text` 的行高跨出 item 边界、压到下一条
       气泡顶上。`bottom = 8vp` 是第八修定下的最终值。
     - `ChatDisplayItem` 新增 `time` 字段，**用 `0` 而不是 `null` 表示「没有时间」**：
       与工程既有的「线上一律用原始取值、不做 enum ↔ 字符串转换」同源，也免去 ArkTS 里
       `null` 与 `undefined` 两种空值的纠缠。该字段同时是**过程组耗时摘要**的时间来源
       （B 批的 ① 直接复用它，无需再改数据层）。
  2. **失败行「重试上一轮」**（`core/ChatRetry.ts` + vm + `ui/MessageParts.ets` +
     `ui/ChatDetail.ets`）：模型故障（`stopped == false`）时失败行多一个按钮，把**最后一条
     带正文的用户消息**原样再发一次。
     - **为什么是「最后一条用户消息」而不是「这条失败行对应的那条」**：`ChatTurnFailure`
       里没有 turn/seq（内核只给失败摘要），拿不到精确归属；而失败行永远紧跟在触发它的
       用户消息之后，所以它就是。
     - **「任务已停止」那一支刻意不给按钮**：登出/主动停止是用户自己的动作，重试必然再失败
       一次 —— 一个点了只会再错一遍的按钮比没有按钮更糟。
     - 找不到可重试的消息时**静默不动**：这是用户主动点的动作，报一个他看不懂的错更糟。
  3. **字号缩放 0.8–1.5×**（`core/FontScale.ts` + `AppPreferences` + vm +
     `platform/Platform.ets` + 设置页）：设置页新增「外观」组，可单独放大/缩小本应用文字。
     - **「跟随系统字号」默认开**，且它不是把值设成 `1.0`，而是设成**当前系统档位**
       (`context.config.fontSizeScale`) —— 应用不该擅自把用户调大的系统字号缩回去。
     - **手动调档顺手关掉「跟随系统」**：否则用户调完发现没变化（被跟随覆盖），会以为功能坏了。
     - 步进器用 `−`/`＋` 两个按钮而不是 `Slider`：拖动每帧都会回调，而偏好写盘是同步的。
     - 非法值（`NaN`/`±Infinity`）回落 **1.0** 而不是区间端点 —— 端点会把「读坏了」伪装成
       「用户就是要最大字号」。
  4. **构建水印**（`core/BuildStamp.ets` + `scripts/build-stamp.sh` + `scripts/package.sh`）：
     设置页版本行显示 `v1.0.2 · 构建 e8c51f3`。
     - **为什么需要**：只有版本号不足以确认「用户装的是不是含这个修复的那个包」——
       同一版本号下可能出过好几个包，带上提交短哈希一句话就能对上。
     - **不用 hvigor 的 `buildProfileFields`**（源工程用 Gradle 注入 `BuildConfig` 的那条路）：
       它要靠 `import ... from 'BuildProfile'` 引生成模块，在**无法编译验证**的前提下引入一个
       新的模块解析方式，风险大于收益；改成生成一个普通 ArkTS 源文件，编译路径与其它
       `core/*.ts` 完全一样。
     - 值由 `scripts/build-stamp.sh` 在**出包前**重写（`scripts/package.sh` 的第一步），
       非 git 环境退化成空串（只显示版本号）—— 空串是**刻意设计的合法取值**，比显示一个
       猜的哈希诚实，也比让设置页崩掉合理。

- **移植安卓 v2.2.42「B 批：体感」的四项**（源工程真机反馈三 / 四修）。四项都只改
  **渲染表现**、不动数据流；B 批的第五项（状态条合并）改到了 AI 标识落位，属 AGC 合规，
  故单独列在「变更」段。
  1. **过程分组 + 组级耗时摘要**（`core/ChatDisplayGroups.ts` + `ui/ProcessGroupRow.ets`）：
     连续的过程项（上下文注入 / 思考 / 工具调用）收成一个可折叠组，组头一行摘要
     「耗时 1 分 12 秒 · 3 项上下文 · 5 次工具调用」。
     - **为什么**：一次工具密集的回合会在会话里留下十几行「运行了代码 / 读取了文件」，
       把助手正文冲得七零八落；收成一行后正文才始终是主角。
     - **只有消息类项会打断分组**（`USER` / `ASSISTANT` / `FAILURE`）：中间夹一条消息
       就说明确实是两段工作，硬并成一组会让「这一组干了什么」失去意义；而**失败行绝不能
       折进过程组** —— 它是用户唯一能看到「为什么失败」的地方。
     - **工具调用次数按「明细条数」计、不按行数**：`mergeToolRuns` 早已把相邻调用并成一行，
       直接数行会把「连续 5 次 bash」报成「1 次工具调用」，摘要就废了。
     - **组级耗时是墙钟跨度、取不到可信值就不显示**（`0` 表示没有时间，与
       `ChatDisplayItem.time` 同一约定）：两头缺一、时钟倒退（休眠恢复 / NTP 校时）、
       跨度为 0，三种都不印 —— 宁可少一段，也不要编一个数。
     - **只有 1 项的过程组按普通消息平铺**（`ProcessGroupRow.flatSingle`）：折一行只是让用户
       多一次点击才能看到本来就直接可见的内容。「值不值得折」是观感问题，所以这条判据放在
       界面层，数据层保持可测的纯粹规则。
     - **展开态存在父组件**（`ChatDetail.expandedGroups` + `@Prop`）：ArkUI 的 `List`
       会回收视口外的条目，组件自带的 `@State` 会跟着没；用户展开一组、往下滚两屏再滚回来
       会自己合上。源工程用 `rememberSaveable` 解决同一件事。又因过程组的 key 取了组内
       首项 id，列表 key 必须给过程组加 `process-` 前缀，否则「展开后那一项以消息身份出现」
       会与组本身撞 key（PORT-MAP 坑 29、坑 30）。
     - 判据抽成纯函数并单测：分组边界错了，真机上只表现为「有一段话不见了」，
       很难当场看出是哪一步错的。
  2. **表格「像一张表」**（`ui/MarkdownView.ets` 的 `tableView` / `cellSeparator`）：
     补上**外框一道边 + 圆角**、**表头深底**、**行间分隔线**、**列间竖线**。
     - **为什么**：前三版被连反馈三次「表格不像表」—— 根因是只有单元格文字、没有表的结构，
       截图里那些「证据 / 结果」行看起来就是普通文字行。**折行与表格感两个都要**，
       不是二选一，这是前三版反复的教训。
     - 列间竖线用「1vp 色块 + `alignSelf(Stretch)`」而不 `Divider().vertical(true)`：
       竖直 Divider 要显式给高，而每行高度由文字折行决定、算不出来；`Stretch` 让它自动
       长到行高（与引用块那条左边线同一套做法）。`alignSelf` 会覆盖 `alignItems`，
       所以文字一侧仍是顶对齐。
     - 表头下那条线用 **2vp** 而不是 1vp：它是「列名 / 数据」的分界，与行间线同粗会看不出来。
     - `clip(true)` 与圆角同时设：表头那块深底才会被裁进圆角，否则四个直角戳出边框。
  3. **代码块语法高亮**（`core/CodeHighlight.ts` + `ui/MarkdownView.ets` 的 `codeView`）：
     零依赖的 JSON 单遍扫描 + 多语言关键字规则，返回**半开区间** span 列表，界面按类别
     取系统色上色；同时补**语言标签 + 复制键**顶栏（复制的是原始代码文本）。
     - **为什么自己做**：工具参数与结果几乎全是 JSON，围栏块以 JSON / Shell / Kotlin 为主，
       为这几种语言引一套语法高亮依赖，换来的包体积与构建复杂度不划算。
     - **JSON 用字符扫描而不是正则**：正则要靠递归实现字符串重复组
       （`"(?:\\.|[^"\\])*"`），长串字面量会直接爆栈（源工程在 JVM 上实测 20 万字符即
       `StackOverflowError`）；块注释同理 —— 未闭合的懒惰匹配是 O(n²)，而流式输出出现
       半截块注释是常态。单遍扫描天然 O(n) 且无回溯。
     - **未闭合的字符串停在行尾**而不是串尾：不让一个落单的引号把后面几十行代码全吞进
       字符串（那会让整段失去高亮，比不着色更糟）。
     - **重叠显式消解**（字符串 > 注释 > 关键字/字面量 > 数字，同起点再比长度）：
       `"// 不是注释"` 里注释规则也会命中，若交给渲染层按添加顺序叠加，调一下规则先后
       颜色就悄悄变了。扫描全程无前视 / 后视断言，规避 ArkTS 引擎不支持断言导致的空白页。
     - **只加样式、不改字符**：分段拼起来逐字符等于原文 —— 界面按原文排版与复制，
       少一个字符，行号与剪贴板内容就全歪了。
     - **认不出的语言标签返回无样式、不抛异常**：围栏标签是模型写的自由文本，
       高亮失败绝不能连累消息渲染。空标签则先「猜一次」是否像 JSON。
     - **色板走系统色**（`sys.color.*`）而不是写死的十六进制：应用有浅色 / 深色 / 跟随
       系统三档主题，系统色会跟着换；写死一套，深色模式下必有一头读不清。
     - **语言为空也保留整条顶栏**（只空着标签）：顶栏高度若随语言有无上下跳，复制键会在
       消息之间错位，用户按肌肉记忆点下去会点到隔壁去（源工程原话）。
     - 缓存按「语言 + 原文」记忆（容量 8、满则整体清空），与源工程 `remember(code, language)`
       同语义：**只省「文本没变」的那次重算**（流式追加时每帧都得重算）。
  4. **滚动期冻结流式快照**（`ChatDetail.onScrollStarted` / `onScrollStopped` + `SCROLL_SETTLE_MS`）：
     手指在列表上时不再把每个新 token 灌进数据源，停手 **80ms** 后解冻（源工程
     `ui/ChatScrollFreeze.kt` 的对位实现）。
     - **为什么**：智能体流式输出时用户往上翻历史，每个 token 都会重建整份列表，
       手指下的滚动一顿一顿，而用户此刻压根不在看末尾。
     - **必须先存快照再上锁**：上锁之后取值就开始返回快照了，那时再取就取到上一份
       （首次滚动更是空表）。
     - **加了滚动代际校验**：源工程用 `LaunchedEffect(scrolling)`，换 key 会自动取消上次
       协程；ArkUI 的 `setTimeout` 没有取消机制，没有代际校验时，上一次的 80ms 定时器会在
       新一轮滑动中错误解冻 —— 表现是「刚滑两下，列表又跳了」。
     - **冻结只挡渲染数据源**：`atBottom` 与「跳到最新」仍读实时值，否则滚到底时按钮的
       显隐会跟着旧快照走。
     - 连带修：`listItemCount()`（自动滚动判据）改按**分组后**的行数算 —— 仍按扁平项数算会
       一直偏大，「看着到底了」的位置被算成「还差好几行」，自动跟随再也开不了火。

- **移植安卓 v2.2.42「C 批：客户端侧」的三项**（源工程真机反馈五 / 六修）。三项都是
  「源工程有、本工程没有」的**功能缺口**，所以放在体感项之后单独一批。
  1. **消息内图片全屏查看 + 保存**（`core/ImageSave.ts` + `ui/MessageParts.ets` +
     `ui/ChatDetail.ets`）：点消息里的缩略图打开**黑底全屏查看器**（居中满屏、右上 ✕、
     图片区点一下就关），底部一个「保存」。
     - **保存走系统「保存」面板，而不是写相册**：安卓侧用 `MediaStore`；鸿蒙等价的相册写入
       要 `ohos.permission.WRITE_IMAGEVIDEO`，**与 READ_PASTEBOARD 同一类受限权限**，
       普通应用声明会导致**安装失败**（本工程已因同类权限栽过一次，见 PORT-MAP 坑 26）。
       改用 `platform/Pickers.saveBytes`（零权限）：用户自己在面板里选位置、也能顺手改名，
       代价是「不会自动进相册」—— 这一点在按钮文案上写成「保存」而不是「存到相册」，
       不承诺做不到的事。
     - **取消不是失败**：面板返回 `CANCELLED` 时**不弹任何提示**。用户按了取消却收到一句
       「保存失败」，会以为哪里坏了（源工程同样把这两档分开）。
     - **失败必须可见**（源工程原话）：「保存」是个很少用的动作，用户点它时是**专门为了存下来**；
       静默失败会让他以为已经存上了，之后再也找不到那文件。
     - **文件名按魔数补扩展名**（`ImageSave.galleryFileName`）：会话里的图常常是工具落下的
       临时文件（`screenshot` / `img_0`），没有扩展名、或扩展名是错的（`*.txt`）；
       存到用户能看到的地方时，错的扩展名会让相册/预览器直接打不开。**已经带了合法图片
       扩展名就尊重原名**（用户或上游起的名字不该被改）；认不出格式（TIFF / SVG）也不动原名 ——
       宁可少补，也不要塞一个错的类型。
     - **查看器状态住在 `ChatDetail`**：`List` 会回收视口外的消息行，查看器若由 `AttachmentImage`
       自己持有，用户点开图再滑一下就会连带把查看器一起收走（与过程组展开态同一个坑，坑 29）。
     - **解码失败就不打开**：缩略图能画出来说明这张图曾经解得开，这里是二次保险；
       真解不开时打开只会得到一整屏黑，比「点了没反应」更难解释。
  2. **消息级分叉（`atSeq`）**（`core/ChatFork.ts` + `ui/ChatMessage.ets` +
     `ui/ChatDetail.ets`）：消息元信息那一行多一个「🔀 从这条分叉」，点后弹二次确认，
     确认即**从这一条**分出新的会话。
     - **只给用户消息、且 `seq > 0`**（源工程 `ChatForkPoint.kt` 的判据，逐条照搬）：
       分叉的真实场景几乎总是「这次提问的走向不对，从这儿重来」；每条消息都挂按钮会让
       消息流变得毛糙。而 `seq = 0` 不是内核认得的**事件序号**（只有历史项才有正 seq），
       传过去只会换回一个报错弹窗 —— 用户完全不知道自己做错了什么，所以宁可不显示入口。
     - **入口放在时间戳那一行、不新增一行**：分叉是次要动作，次要动作放次要位置；
       也不给单独的图标按钮，避免消息流满屏小图标。
     - **确认对话框住 `ChatDetail`**、`ChatMessageView` 只上报 `atSeq`：分叉会在电脑上**新建
       一个会话**（真实数据写入），点一下图标就生效是不行的；状态不住子组件的原因同坑 29（`List` 回收）。
     - 判据抽成纯函数并单测（`chat-fork.test.ts`）：它错了在真机上只表现为「某几条消息莫名
       多 / 少一个按钮」，当场看不出是哪一步错的。
  3. **已归档会话入口**（`ui/ArchivedSessionRow.ets` + `ui/ChatScreen.ets` +
     `HarnessState.archivedSessions` + `DshClient.sessions(archived)`）：
     会话列表标题右侧多一个「已归档 / 返回会话」切换，进入后列出服务端标记为归档的会话，
     底部一行**明说**「本插件暂不支持恢复归档，需在电脑端 WebUI 调整」。
     - **入口按能力位 `session-archive-list-v1` 守卫**：老 bridge 会**忽略** `archived` 参数
       并返回未归档列表，此时展示入口只会让用户看到一个「一条归档都没有」的**假结论** ——
       他会以为自己在电脑上归档的东西丢了。**能力位未知（读不到清单）一律不显示入口**，
       这是安全方向（`BridgeCapabilities.supportsArchiveListing`）。
     - **归档列表与活动列表分开存、不做本地过滤**：归档状态是服务端的事实，本地过滤只能
       过滤出「本机曾经拉过的那批」；而归档视图是**独立入口**，不是活动列表的一个筛选器。
     - **每次进视图都重拉、不缓存**：归档状态可能在电脑端被改过，缓存会让手机端长期显示
       过期结果，而用户不会想到「要重启应用才会更新」。代价是每次进视图多一次请求。
     - **界面明说不能恢复**（源工程刻意不做）：能力位只覆盖「列出」，取消归档在插件侧还没有实现。
       不写这一句，用户会一直找「恢复」按钮，最后只能当作是应用坏了。
     - **独立行组件、不复用 `SessionRow`**：那行的菜单（重命名 / 分叉 / 归档）对已归档会话
       要么无意义（再归档一次），要么本插件不支持；复用只会让用户点到无效项。归档会话**仍可打开**
       （归档 ≠ 不可读），所以 `ChatDetail.currentSession()` 会去 `archivedSessions` 里再找一次 ——
       否则头部标题会退化成 id 前 12 位，看起来像一条陌生会话。
     - 连带：新增 `core/BridgeCapabilities.ts`，把 `connection.ready` 自报的 `bridgeVersion` /
       `capabilities` 读进状态。**读不到一律算「未知」而不是「空清单」** —— 把未知当成「什么都缺」
       会弹出假警告，而假警告比没有警告更坏（它教会用户忽略警告）。

- **AI 生成内容显式标识**（《人工智能生成合成内容标识办法》显式标识要求；对应 AGC 驳回项
  「应用含 AI 生成文本内容，但未提交人工智能生成合成内容标识相关材料」）：
  助手消息正文下方固定渲染一行提示，中 / 英资源为 `ai_generated_notice` ＝
  「内容由 AI 生成」/「Content generated by AI」，样式取次要色 11fp，宽度跟随消息卡片。
  **只加在助手（AI）消息上**，用户自己的消息不加 —— 要标识的是生成内容，不是全部内容。
  落点 `ui/ChatMessage.ets` 助手消息分支。**该落点随后被 B 批 ⑤ 改为会话级常驻状态条**，
  见「变更」段 —— 标识**没有消失**，只是不再逐条重复。

- **移植安卓 v2.2.42「B 批：工程质量 + 三条文档门禁」**（源工程 `ArchitectureGuardTest.kt`、
  `docs/project/AGENTS.md` §4/§5）。这批一气做两件事：把**只活在文档里的纪律变成会红的断言**，
  以及补上本轮移植暴露出的**分层接缝**与**客户端侧数据管线**。逐项（每项都写「为什么」）：
  1. **架构纪律可执行门禁**（`test/cases/architecture-guard.test.ts`）：
     - ①**行数预算 900 + 台账登记**：超预算文件必须在 `docs/TECH-DEBT.md` 有「路径 + 记录行数 ≥ 实际行数」的表格行。
       **为什么现在才做**：纪律此前全靠人自觉，本轮移植把 `ChatDetail`(1207) / `SettingsScreen`(967)
       又撑过预算，正是因为**没有门禁**才拖到移植后才发现（见 `docs/TECH-DEBT.md`）。
     - ②**唯一网络边界**：只有 `platform/` 允许 `import` `@ohos.net.http` / `@ohos.net.webSocket`。
       判据取 **`import` 行**而不是裸符号 —— `core/` 下有多处**注释**解释这两条模块的错误码来源，
       取裸符号会把正确的注释判成违规（**这是收紧，不是放宽**）。
     - ③**`ui/` 不读偏好** + **会话展示单一出口**（`displayItemsOf` 全仓只许一份、且必须在 `core/`）。
       `ui/` 偏好判据**放行整行注释**（`SettingsScreen` 里有一行解释这条纪律的注释），行尾注释仍报错。
     - 每个用例开头跑「盘面自检」：扫到的文件数不足就**红**，杜绝「路径解析错、什么都没扫到、于是全绿」
       —— 那种假绿比没有门禁更坏，因为它冒充证据。
     - **刻意未移植两条**（已写进 `AGENTS.md` §8）：**坑位索引 ↔ 正文双向一致** —— 源工程正文标题与索引
       **同名**才可双向比对，本仓索引是**触发词**（「布局溢出系统手势区」）、正文是**编号**（「坑 13：…」），
       硬比对只会恒红或逼人删掉有检索价值的触发词；**`@patch` 五要素** —— 本仓全仓 0 处 `// @patch`，
       写成断言是永不触发的空转门禁。
  2. **中英资源一致性门禁**（`test/cases/strings-parity.test.ts`）：`base` 与 `en_US` 键集一一对应、
     同名键的 `%s`/`%d` 占位符一致、两边都无重复键。**为什么需要**：见「修复」段 —— 本轮暴露
     `base` 缺 12 个界面正在引用的键。门禁用 `readFileSync` **直读磁盘**（与 PORT-MAP 坑 28 同一教训：
     在 FUSE 挂载点上 `Grep` 会读到过期视图，直读才是真相）。
  3. **请求代际隔离**（`core/RequestGate.ts`）：切会话 / 重连 / 断开时 `invalidate()`，请求回来先问
     `isCurrent(token)` 再决定是否写状态。**为什么**：否则「切到会话 B 后、会话 A 的慢响应才回来」
     会把 A 的内容写进 B 的界面，真机上只表现为「偶尔跳回上一个会话」，肉眼回归永远抓不到。
     ArkTS 单线程，故 Kotlin 的 `AtomicInteger` 退化为普通 `number`。
  4. **目录事件去抖**（`core/EventDebouncer.ts` + `HarnessViewModelConnection`）：`file.*` 事件由
     「每来一帧发一次目录请求」压成「安静 500ms 后发一次」；去抖动作走可覆盖钩子 `refreshDirectoryNow()`，
     事件驱动与手动刷新同一条路径。**为什么**：agent 连续读写文件会打出事件风暴，每个事件拉一次目录
     会让文件页持续抖动并压垮连接。`TimerPort` 接缝（`after`/`cancel`）让时序语义在单测里可确定复现。
  5. **历史投影缓存 + 展示口径抽取**（`core/ChatVisibleItems.ts` + `ui/ChatDetail.ets`）：把原先内联在
     `ChatDetail` 的两条过滤口径（REASONING 一律剔除、CONTEXT 仅在开关打开时保留）抽成可测纯函数，
     并按 **history 对象引用相等**做缓存键 —— 流式追加时每帧都会重算，缓存只省「history 引用没变」的那次。
     另把 `ChatDetail` 的私有 `displayItems()` 改名 `renderItems()`：`displayItemsOf` 是 core 的**单一出口**，
     界面层同名方法会踩上「展示只由 core 产出」这条门禁。
  6. **断档检测 + 订阅基线**（`core/ChatSeqMonitor.ts` + `HarnessViewModelConnection`）：`chat.*` 事件
     严格跳号才判 `RESYNC`（重拉历史），**重复与倒退算去重、不算断档**；`chat.session.snapshot` 带
     `cursor`，落后本地最大 seq 才刷新。**为什么**：整份重拉代价不低，判据必须只在「真的缺了一段」时触发，
     否则每次重连都白拉一遍。序号序列**每会话各自独立**，故 `selectSession` 清空 `lastEventSeq` / `baselineCursor`。
  7. **执行统计面板**（`core/SessionStats.ts` + `ui/SessionStatsSheet.ets`）：会话头部菜单新增只读入口，
     展示用户轮次 / 助手回复 / 工具调用 / 事件总数 / 数据截至事件 #N。**刻意不显示 Token 用量与上下文占用**：
     这两项要内核提供，本仓读不到；面板底部**如实说明「读不到所以不显示」**，而不是显示一排猜的 0 或估算值。
  8. **执行轨迹页**（`core/Trajectory.ts` + `ui/TrajectoryScreen.ets`）：按 `turn` 分组、组内按 `seq` 排序，
     左侧时间轴 + 时间 / 耗时。**不做类型过滤**：认不出的类型留 `OTHER` 并**显示事件类型原名**，
     而不是笼统的「其他」——「这到底是什么」正是排查时要看的信息；组级耗时取不到可信值（时钟倒退 / 跨度为 0）就不印。
  9. **Clock 接缝：把「延迟测量」做成可注入的**（`core/ConnectionCoordinator.ts` +
     `test/cases/connection-coordinator.test.ts`）。对位源工程 B 批「Clock/Transport 接缝」，
     也正是源工程 `DEBT-007` 那条 flaky 的同一件事。
     - **为什么要做**：选路比较的正是**实测延迟**，而实测值是墙钟。源工程用真实延迟
       （`MockResponse.setBodyDelay`）造出「局域网 300ms vs 虚拟网 220ms」，机器一带编译负载，
       两次实测会**一起飘**，容差判定偶发红、单跑即绿。**flaky 测试比没有测试更坏** ——
       它教会人「红了先重跑一次」，于是真的回归也会被重跑掩盖。
     - **本工程换了更干净的路线**（结果一致、代价更低）：把**时钟本身**做成构造参数
       `clock: () => number`（默认 `defaultClock()` = `Date.now`），单测注入「手动推进的假时钟」，
       于是三条依赖**精确延迟比较**的用例（局域网在容差内胜出 / 超容差回退 / 并列取 preferred）
       **完全不等待真实时间**（亚毫秒级跑完、可确定复现）；而「并发」「挂死超时」「`close()` 立刻叫醒」
       三条仍走真实行为 —— 它们测的就是真实行为，替换掉反而失真。
     - **接缝的边界画得很清楚**：它只替换「**怎么读时间**」。超时、关闭、取消语义**仍由协调器负责** ——
       那些是「保证不挂死」的部分，被测试替身绕过去就等于把最有价值的保护测没了（见 PORT-MAP 坑 37）。
  10. **连接即重放**（`HarnessViewModelConnection.handleConnection`）。对位源工程 C 批。
     - 事件流**重连成功那一刻**（回调 `connected = true`）自动补拉断线期间错过的一切：
       当前会话历史 + 会话列表（`scheduleChatRefresh`）、待审批、待答问题、命令清单。
     - **为什么必须显式重取**：WS 是「订阅之后才收得到」，断线窗口里发生的事件**谁都管不着**；
       而「卡片没弹」与「本来就没有待审批」在屏幕上**长得一模一样** —— 只有主动重取才能区分。
       `resumeEvents`（熄屏恢复）复用同一条链，两处行为一致。
  11. **主题三档可选（跟随系统 / 浅色 / 深色）**（`core/ThemeMode.ts` + `AppPreferences.themeMode` +
     vm `setThemeMode` + `ui/SettingsScreen.ets` 的 `themeSelector` + `platform/Platform.ets` 的
     `applyAppThemeMode` + `ui/AppRuntime.ets`）。对位源工程 `data/InterfaceStyle`
     （Whaleness 舒适度「设置页外观选项合并」里的样式一档）。
     - 设置页「外观」组新增三枚并排药丸，与语言药丸复用同一个 `ChoicePill`（`@Prop selected` 才有得更新）。
     - **存的是线上取值**（`'system'` / `'light'` / `'dark'`）而不是枚举序数：源工程曾按 ordinal 存，
       升级后深浅色悄悄互换才改成存名字；本工程一开始就存字符串，**升级安全这一点是同一个结论**。
     - **认不出的取值一律回落「跟随系统」**而不是「浅色」：认不出通常意味着偏好被写坏或来自未来版本，
       此时交还给平台，最不容易让人误以为「这个 App 变样了」。
     - **取值在三处都做了归一化**（`ThemeMode` / 偏好 / 平台）：一个认不出的档位若原样传给
       `setColorMode`，平台会抛参数错误，而它抛在**点击回调**里 —— 表现为「点一下就闪退」。
     - 生效那一步在平台层（`applyAppThemeMode` → `application.setColorMode`）；`AppRuntime`
       按「与上次生效值不同才重设」去重 —— `setColorMode` / `setFontSizeScale` 两个系统级调用代价不小。
     - **连带修正一处过时注释**：`core/ThemeMode.ts` 文件头原写「安卓源工程只有『跟随系统』一档」，
       与源工程 v2.2.42 的 `data/InterfaceStyle` 三档事实不符，已改为「对位源工程 `data/InterfaceStyle`」。
  12. **外观 / 主题纯逻辑单测**（`test/cases/appearance-preferences.test.ts`，对位源工程
     `AppearancePreferencesTest.kt`）：覆盖 `normalizeFontScale` 的两条边界（上 / 下限收敛、区间内原样）、
     **非法值（NaN / ±Infinity）回落 1.0 而不是区间端点**（白屏防线）、`effectiveFontScale` 的两支、
     `formatFontScale` 固定一位小数且用点号、`normalizeThemeMode` 的三档判定与回落，
     以及 `AppPreferences` 的 `themeMode` / `fontScale` / `fontFollowsSystem` 读写往返与坏值不落盘。
     **为什么补**：它们取错值**不崩、只悄悄难看**（NaN 字号白屏、跟随系统写反导致双重放大、
     档位认不出深浅色互换），真机上只能靠「用户截图 + 我们猜」，而本质都是纯函数；源工程为此专立一个测试类，
     本仓此前只在 `app-preferences.test.ts` 里覆盖了发送模式与开关，**字号与主题没测**。

### 修复

- **设置页「完全跟随系统字号」那行的说明文字不随字号档更新**（真机复查 + 全仓同类审计，
  2026-10-17）。真机取证很直白：**同一帧**里步进器已经是 `1.3×`，紧挨着的那行说明仍写
  「应用字号 1.2×」—— 一屏之上两个控件互相打脸。此前的「点＋应自动关掉跟随系统」误判
  也源于同一处假象（功能其实是对的，落盘 `font_follows_system=false`）。
  - **根因**：`ui/SettingsScreen.ets` 的 `SwitchRow` 里，只有 `checked` 是 `@Prop`，
    `title` / `description` 是**普通成员**。ArkUI 重绘父组件时只回写带装饰器的成员
    （编译器生成的 `updateStateVars(params)` 参数只由 `@Prop` 收集），普通成员永远停在
    组件实例首帧值 —— 而 `description` 正是随字号档现算的动态值（`fontScaleDesc()`）。
    机制与坑 21 / 24 / 27 同源；**这次错在修补范围**：坑 27 以「组件」为审计单元修了
    `checked` 就收工，漏掉了同组件上的另外两个动态成员。详见 PORT-MAP 坑 40。
  - **修法**：`SwitchRow.title` / `description` 补 `@Prop`（`ResourceStr` 联合类型可作
    `@Prop`，`SettingRow.title` 早已如此）。
  - **同类审计（按「成员是下行数据 × 宿主实例存活 × 值会变」三元组，逐个调用点确认）**，
    本轮一并修掉三处**同一机制**的隐患：
    1. `ui/SessionRow.ets` 的 `session` / `selected` / `rowEnabled` 改 `@Prop`。本行由
       `ChatScreen` 用 `ForEach`（键 = `session.id`）渲染，**键里不含** `running` /
       `pendingInteraction` / 标题 ⇒ 刷新列表时实例被复用，状态点永不翻转、重命名后标题
       不变。`ui/ArchivedSessionRow.ets` 的 `session` / `title` / `selected` / `rowEnabled`
       同理。这是坑 21（`ModelRowView.selected`）的同型。
       **诚实标注**：`SessionRow` 的「改名后行标题即时刷新」这条路径**本轮未做真机取证** ——
       中文标题无法用 `uitest inputText` 输入、光标定位不可控，且改名会落到**用户真实会话**上
       （有打扰风险）。已上机取证的是**同一机制**的 `SwitchRow`（决定性的同帧跟随证据）。
       该路径的证据状态记为「**按机制推断已修，未上机**」，不写成「真机通过」。
    2. `ui/Components.ets` 的 `WarningBanner.message` 改 `@Prop`：多数调用点传常量，但
       `PluginsScreen.problemCount()` / `unavailableReason()` 与
       `SettingsScreen.bridgeVersionText()` 传的是**会变**的参数化文案，而警示条一旦出现
       就留在分支里。
    3. 审计同时**排除**了三类非缺陷，避免误改：函数成员（`@Prop` 深拷贝会连闭包拷坏，
       坑 24 已证）、组件私有字段（缓存 / `Scroller` / `fallback` 兜底对象）、
       `ForEach` 键里**已含**动态数据的子组件（键变即重建，如 `AttachmentImage` / `MarkdownView`）。
       拿不到真机时序证据的「分支内动态布尔」不入代码改动，只记账（`DEBT-004`）。
  - **验证口径**：在**同一个页面实例内**改档，看说明是否**同帧**跟随 —— 点「＋」后
    步进器 `1.4×` → `1.5×`，说明同步到「应用字号 1.5×」，落盘 `font_scale` 同步为 `1.5`
    （`hdc` 直读偏好文件核对）。**「退出再进来才一致」不算验证**，那只证明初始帧正确。

- **`entry/src/main/ets/platform/Platform.ets` 两处 ArkTS 违规**（本轮**首次真编译**抓出）。
  两处都在新写的主题 / 字号下发链上，**都是 ArkTS 与 Kotlin 的语法差异，且只有编译器能发现** ——
  静态审查看不出来，这正是「不在无编译环境里盲改」的理由：
  1. `probe.call(application, target)` 触犯 **`arkts-no-func-apply-call`**（ArkTS 禁止
     `Function.apply` / `Function.call`）。修法：**保留**运行时探测（低版本设备上该方法不存在），
     但探到之后走**方法调用** `application.setFontSizeScale(target)` —— 拿函数引用再调用不光编译不过，
     还会丢掉 `this`。
  2. `context.config.fontSizeScale` 报 **`Property 'config' does not exist on type 'Context'`** ——
     `config` 只声明在 `UIAbilityContext` 上，基类 `common.Context` 没有。修法：在平台层内部
     **显式收窄** `context as common.UIAbilityContext`，收窄只有一处、调用侧不受影响。
- **两条本批新写的用例自身写错**（`test/cases/chat-display-groups.test.ts` / `trajectory.test.ts`）。
  **实现没错，是对齐测试** —— 口径在实现的文件头与测试注释里都有明文：
  1. 六处断言把 `0` 当**起点时间戳**传（`new ProcessGroupSummary(0, 0, 0, 12000)`），而 `0` 在本协议里
     是「**没有时间**」的哨兵值（`ChatDisplayItem.time` 与 `durationMs()` 的口径）⇒ 耗时被整段吞掉，
     断言期待「耗时 12 秒」却拿到「3 次工具调用」。修法：起点改用 `1000` 等真实值，并把这条口径
     写进测试文件顶部注释，免得下次再犯。
  2. 轨迹用例假设「有编号的轮次在前、`UNKNOWN_TURN` 在后」，但实现按**升序**排，而 `UNKNOWN_TURN`
     取 `0`（正是为了不给「未知轮次」单开排序特例）⇒ 它排在最前。修法：改断言的顺序。
- **`entry/src/main/resources/base/element/string.json` 缺 33 个界面正在引用的文案键**（补齐后 `base` 392 键 ⇐ 昔 359 键）。
  **第 1 / 2 批的 21 条**（`archived_empty` / `archived_sessions_hint` / `bridge_outdated_warning` /
  `fork_confirm_*` / `fork_from_here` / `image_save_failed` / `image_saved` / `session_stats_*` /
  `show_active_sessions` / `show_archived_sessions` / `stats_*` / `trajectory_*`）
  **与第 3 / 4 批的 12 条**（`retry` / `build_stamp` / `appearance` / `font_scale_*` / `theme_*`）
  都只写进了 `en_US`。界面确实在引用它们
  （`ui/MessageParts.ets:339`、`ui/SettingsScreen.ets:471/491/493/658/660/668/676/677/944/951/958`）。
  **为什么算缺陷而不是新功能**：这些键的**界面引用**早在前几批就落盘了，缺的只是中文兜底文案本身，属移植
  遗漏 —— `base` 是默认语言，缺键时「重试上一轮」按钮、设置页「外观 / 主题」两组在中文界面会**取不到值**。
  **拖到现在才修的原因（也是本条的教训）**：当初对 `base` 的追加**压根没落到盘上**，而当时
  依据的 `Edit` 回显**说成功了** —— 盘上一直是 359 键（PORT-MAP 坑 35）。是新增的
  `test/cases/strings-parity.test.ts` 门禁在**首次真跑**时把它抓出来的：**这道门禁值它存在**。
  **修法**：不再靠逐条 `Edit`，改用一次性脚本（`node` 读两份 JSON → 按名合并 → **全表字母序重排** →
  写入前跑三项自检：待补键确实缺 / 清单无遗漏 / 占位符数量与 `en_US` 一致），写完再 `node` 复核计数：
  `base` 与 `en_US` 各 **392 键**、一一对应、且恢复字母序（脚本在 `/tmp`，一次性工具、不入库）。
- **`entry/src/main/resources/en_US/element/string.json` 字节级损坏修复**。该文件在
  `ai_generated_notice` 与 `command_*` / `workspace_files_*` 两处出现**字符插入/缺失型
  字节错乱**：`"vaiue":` 缺字母、多出一个 `"name": "a_lgenerated_notice"` 重复键、
  `"workspaceefiles_ewpty"` 之类的名字被塞进字符、`"value": "Zoom text out""` 多一个引号，
  文件尾部还残留一段错位片段（重复的四条 `workspace_files_*` 加一对多余的 `]`/`}`）。
  **为什么要修**：这不是排版问题 —— 重复键与未闭合的字符串会让 `restool` 直接解析失败，
  整包构建起不来；而英文界面下这些键（`available_commands`、八条 `command_*` 描述、
  工作目录四条）正是**内建斜杠命令面板**的全部文案，缺一条就有一处显示成空。
  **怎么修的**：中文 `base` 文件同位置完好，用作**键序与结构的权威对照**；英文取值以编译
  产物 `entry/build/default/intermediates/res/default/resources.index`（Restool 5.1.0.007
  索引，明文可读）里的一手原文为准。修复后文件恢复为单一 `]` / `}` 收尾，两处损坏区
  全部还原为正确的条目，并顺带补齐此前未落盘的外观组四条 + 主题组五条英文文案。

- **设置页点药丸选中高亮不动**（用户报「点『English』『插话发送』后图标不变化，但功能已启动」）。
  这是**两处缺失叠加**的死区，缺一不可：
  1. **本页 `st()` 漏读 `revision`** —— ArkUI 的增量更新**按元素（elmtId）登记依赖**，
     只有在该元素那次渲染里读过的状态才算它的依赖。全工程 12 个界面都按坑 12 在 `st()` 里
     读了一次 `revision`，**唯独 `SettingsScreen` 漏了**（它只在 `isEnglish()` 里读过，
     那是为语言药丸加的）→ 设置页除语言药丸外的**所有**动态节点一次也没登记过依赖，
     状态变了整页纹丝不动。修法：把这次读取补进 `st()`，一条链覆盖全部取状态的节点。
  2. **子组件成员是普通成员** —— 父组件重绘时 ArkUI 只回写带装饰器的成员（`updateStateVars`），
     故 `ChoicePill.selected` / `SwitchRow.checked` / `SettingRow.title|subtitle` /
     `StatusLabel.label|active` 一律改 `@Prop`（函数成员保持普通成员，加 `@Prop` 会把闭包拷坏）。
  另修：`choicePill` 原先是 `@Builder`（**按值传参的 `@Builder` 不会刷新**），改为
  `@Component` + `@Prop`；文件头「平台差异 1」原先只写「不共用带数组参数的 `@Builder`」，
  漏了「布尔 / 字符串这类按值参数同样会丢更新」—— 这处漏读的规则正是本次缺陷的根因。
  真机实测：改后点「排队 / 插话」当场重绘（截帧哈希前后不同、描述文案同步切到排队语义），
  而改前同一操作画面零变化。详见 PORT-MAP 坑 27。
- **会话页输入 `/` 带不出 dsh 命令**（源工程 Android 版正常）：`CommandSuggestions` 的
  `value` / `commands` 原为**普通成员**。命令面板所在分支在空输入时（`mentioning()` 为 false）
  就已存在、实例首帧即创建；ArkUI 重绘时**只回写带装饰器的成员**，普通成员永远停在首帧值 →
  `commandSuggestions('')` 恒为空 → 面板永不出现。`@` 面板能用纯属"切换分支时新建实例"的偶然。
  修法：两个补全面板的下行数据成员一律改 `@Prop`（函数成员 `onSelect` 保持普通成员）。
  机制级证据取自编译产物 `updateStateVars` 只收 `@Prop`，与既有坑 21 同源。详见 PORT-MAP 坑 24。
- `MentionSuggestions` 收 `FileEntry[]` 时 `entry.isDirectory()` 在 `@Prop` 深拷贝后仍可用
  （运行时 `deepCopyObjectInternal` 走 `Object.setPrototypeOf` 保原型）—— 顺带确证并写入文档。
- **真机验收（2026-10-16）**：release 构建 + 调试证书签名包装机后，上述两条修复均确认成立
  —— 输入 `/` 能带出 dsh 命令；Markdown 表格英文标识符整词折行（`bundleNam` / `e` 消失）。
  详见 `docs/TESTING.md` 真机验收记录、PORT-MAP §7 第 24 / 25 条。
- **上架审核驳回：应用图标是 216×216 单层图**。AGC 原文：「未正确配置单层图：应用图标单层图尺寸为
  216px\*216px，标准要求尺寸 1024px\*1024px 且需下载 HUAWEI DevEco Studio 5.0.5.315 或以上版本
  进行图标再处理」。**根因**：上一版把 1024×1024 的自绘源图**压成 216×216 单层图**铺进包内 4 处
  （`AppScope` 与 `entry` 的 `app_icon.png` / `startIcon.png`）—— 尺寸与「必须分层」两条都不符。
  **修法**：按源图「白色图形以覆盖率叠加在纯蓝底 `(30,90,200)`」的合成关系反解出透明度，拆成
  **前景图（透明 PNG）+ 背景图（纯色、不含透明像素）**，均为 1024×1024 正方形、无圆角、无内间距；
  `AppScope` 与 `entry` 刻意引用**不同资源名**（`app_layered_image` / `layered_image`），规避
  「同名资源被 AppScope 覆盖」的官方坑。启动页图标 `startWindowIcon` 仍为**独立的单层图**
  （官方「生成单层图标」正是为启动页产出 `icon_startwindow.png`，不要求分层）。
  真机核对：桌面图标为圆角方形、图形居中清晰、无裁切无硬直角。详见 PORT-MAP 坑 25。
- **版本递增至 1.0.1**（`versionCode` 1000000 → 1000001）：1.0.0 已上传 AGC 且被驳回，
  同 `versionCode` 重传会被平台拒（此前把 1.0.0 包的修复留作「同版本纠正」的写法据此作废）。

### 变更

- **状态条合并：思考条与「内容由 AI 生成」标识合成同一条**（B 批 ⑤，源工程真机反馈五修）。
  会话页消息区下方、输入区上方固定一条（网页版 `#thinkbar` 的位置）：
  **有思考内容时显示思考（可点开看全文），没有思考时才显示标识**。
  落点 `ui/ChatStatusBar.ets`（新）；`ui/ChatMessage.ets` 助手正文里那行 `ai_generated_notice`
  同时移除。
  - **为什么合并**：原来两者是并排的两行，思考一来就把标识挤上去，那一栏看着就散了；
    而那一栏只有一行多的空间，两条各占一行必然互相挤压。
  - **为什么让思考优先、标识补位**：思考只在流式期间存在，标识却是常驻的合规提示 ——
    让「短生命周期的运行状态」让位给「常驻标识」不划算，反过来才对。
  - **标识的合规依据**：《人工智能生成合成内容标识办法》第四条要求在生成合成内容或
    交互场景界面中添加「可以被用户明显感知到的**显式标识**」。做成会话级常驻条而不是
    逐条重复，是因为**长会话里同一句提示重复几十遍，用户根本不会读**；改成常驻一条之后
    「可以被用户明显感知」这条反而更成立。也不做成弹窗 / 一次性浮层：那会打断会话，
    且「已关闭不再提示」之后用户就再也看不到标识，更不合规。
  - ⚠️ **本次改动影响 AGC 已提交的「AI 标识证据」材料**：`docs/screenshots/ai-generated-label-evidence.png`
    截的是「逐条标识」的旧形态，**已过期**，须按新形态重截（改后标识位于状态条、
    只在无思考时出现）。审核口径若要求「生成中亦可见标识」，则需回退为两行并保留思考条 ——
    本条为源工程（Android v2.2.42）的选择，本工程照抄，风险如实记录在此。
  - 连带：`core/ChatThinkBar.ts` 新增 `thinkBarFullText()`（全文不截断）供展开态使用，
    `thinkBarText()` 保持原样（尾部 140 字符摘要）—— 两个形态都出自同一个折空白口径，
    否则展开后的第一行会与折叠态对不上，看起来像换了段文字。

- **应用改名去第三方品牌，并更换 `bundleName`**：`AppScope/app.json5` 的
  `bundleName` 由 `com.Deepseek_Harness_client.westanke` 改为 **`com.dsh.westanke`**；
  包内应用名统一为 **「DSH 伴侣」/「DSH Companion」**。
  为什么必须连 `bundleName` 一起改：AGC 把「与第三方应用名称相似」当作**应用身份**问题，
  只改显示名而保留含品牌字样的包名，复判仍会被认侵权；而 `bundleName` 与 AGC Profile 绑定、
  改不了，只能在 AGC **重建应用**，并重新签发调试 / 发布 Profile 与证书。
  连带同步（同一次提交）：
  - `entry/.../element/string.json`（中 / 英）：`app_name`、`EntryAbility_desc`、`module_desc`、
    `connect_title`（连接页标题由「连接 DeepSeek Harness」改为「连接服务端」）
  - `core/ErrorMessages.ts`：`err_signed_out` 去品牌（「已经退出服务端登录」/「Signed out of the server」）
  - `oh-package.json5`：描述去品牌
  为什么 UI 文案也要一起改：审核建议明确要求「修改应用名称时，请务必同步更新**应用介绍、
  应用内容及应用安装包的名称配置**」—— 三处口径不一致本身就会被判不合格。
- **签名材料整轮重签**（换 `bundleName` 的必然结果）：调试 / 发布证书与两份 Profile 全部由 AGC
  对新 bundleName 重新签发；密钥对沿用（不必换 `.p12`）。新文件名含空格与中文
  （`dsh伴侣-调试证书.cer`、`ds clientDebug.p7b` 等），命令行**必须加引号** ——
  详见 `signing/README.txt` 与 `docs/RELEASE.md` ④。
- **版本递增至 1.0.2**（`versionCode` 1000001 → 1000002）：换 `bundleName` 后属新应用、
  平台本无重复版本号约束，但产物会与旧包同名易混淆，故沿用递增序列。
- **重出上架材料**：6 张应用截图按 1.0.2 真机重拍（1080×1920，9:16），新增
  `docs/screenshots/ai-generated-label-evidence.png`（AI 标识证据）；新增录屏
  `dsh-companion-harmony-1.0.2-demo-walkthrough.mp4`（1080×2440，约 103 秒，
  遍历连接管理 / 会话浏览 / 交互操作 / 文件查看 —— 对应 AGC「需提供遍历使用的演示录屏」）。
- **演示录屏合规化重出（AGC 驳回「上传素材不符合要求」）**：原录屏**直接用了手机原生分辨率**
  （1080×2440，比值 `27:61`）且时长超限，AGC 原文「当前视频文件时长：136 秒，要求：15 秒至 120 秒；
  当前视频文件宽高比：120:271，要求：9:16」。以用户自录 `8c848cac…mp4`（720×1626 / 136.34s / 数字静音）
  为源，**一次 ffmpeg 转码**即达标：**模糊铺底 + 居中满高**（不裁掉任何界面元素，避免黑边）
  + **1.16 倍变速**（保住全部内容，117.4s 落在 15–120s 内），输出
  `dsh-companion-harmony-1.0.2-demo-9x16.mp4`（1080×1920 / 117.367s / 无音轨）。
  **为什么不裁切**：裁成 9:16 要砍 21% 高度，会话页顶部应用头与底部输入框二者必失其一 ——
  这两处正是演示要说明的能力。**为什么变速而不是剪尾**：整段是连续遍历叙事，剪头剪尾都会缺环节。
  判据与命令见 PORT-MAP 收尾十二；旧 `…-demo-walkthrough.mp4` 随之作废。
- **远端扩至三个并加自动同步链**：新增 `atomgit`（AtomGit）镜像；并在仓库内新增
  `.github/workflows/sync-from-mirrors.yml` —— 既然本机到 `github.com:443` 不稳
  （实测 `gnutls_handshake` 中断 / 连接超时），就**换个方向**：本地只推 Gitee / AtomGit，
  由 GitHub 服务器上的 Runner 定时把镜像**快进**拉回 GitHub（`--ff-only`，分叉则跳过、不强推）。
  AtomGit 仓库由 **AtomGit OpenAPI 创建**（`POST https://api.atomgit.com/api/v5/user/repos`，
  鉴权 `Authorization: Bearer <token>`）：公开仓 `westanke163/dsh-companion-harmony` 已建并推送。
  ⚠️ AtomGit 的账号名是 **`westanke163`**，与 GitHub / Gitee 的 `westanke` 不同 ——
  照抄 GitHub 用户名会得到不存在的仓库（`403 / project could not be found`），
  早先就因此误判成「仓库尚未创建」。接口与两个鉴权坑见 `docs/PORT-MAP.md` 收尾十一。
  **同步链的边界（实测踩到）**：`GITHUB_TOKEN` 天生不带 `workflows` 权限，**改动
  `.github/workflows/` 的提交，镜像链一律代推不了**，且会让整条链停摆；这类提交必须直推
  或走 REST 补推。workflow 里已加显式诊断，不许沉默（详见 PORT-MAP 收尾十一 坑 C、RELEASE.md ⑦）。
  **消除该边界（2026-10-16 用户「写凭据」授权后）**：往仓库 secret `SYNC_PAT` 写入带 `workflow`
  权限的令牌，并把 `actions/checkout` 改为 `token: ${{ secrets.SYNC_PAT || github.token }}` ——
  如此**含 workflow 改动的提交也能由镜像链自愈**，不再永久卡链；secret 缺失时退回默认令牌，
  仅 workflow 提交失败，退化温和。安全提示：本次写入的是 `gh` 的 OAuth 用户令牌，其 `repo`
  scope 为**账号级**，存进本仓 secrets 意味着本仓 Actions 可读写该账号所有仓库；更稳妥是改用
  仅限本仓的 fine-grained PAT，已向用户提示待其定夺。
  **端到端验证通过**（run `38902595071`）：一笔只推镜像、且含 workflow 改动的提交被 Runner 成功
  推回 GitHub（`a7f4ebb..7dd40c4 HEAD -> master`）—— 该动作在坑 C 里用 `GITHUB_TOKEN` 时会被拒，
  故 PAT 确已生效。
  本次这笔提交因 GitHub 主站不可达，改用 **GitHub REST API 复刻推送**
  （blob → tree → commit → ref，逐层 SHA 断言到与本地 `HEAD` 完全一致）补齐。
  复盘见 `docs/PORT-MAP.md` 收尾十一、`docs/RELEASE.md` ⑦。


- **重出 1.0.1 上架包**（`versionCode` 1000001）：`assembleApp -p buildMode=release` → 签内部 hap →
  组装 `.app` → 签外层，内外层 `verify-app` 均 `Verify success`；同批真机包（调试证书）一并重出。
  真机核对：设备上 `versionCode` 1000001 / `versionName` 1.0.1，桌面图标渲染正常。
- **按域拆分 7 个超长文件至「约 900 行/文件」**（原预算 1 000 行，本轮用户要求收紧到 900；
  对外接口与行为**完全不变**，仅做移动与机械改写 `private`→`protected`、`self` 类型标注）：
  - `core/Models.ts`(1542) → `Models.ts`(barrel) + `ModelsWire` / `ModelsFiles` / `ModelsChat` /
    `ModelsConfig` / `ModelsEvents`
  - `core/ChatPresentation.ts`(1456) → `ChatPresentation.ts`(barrel) + `ChatPresentationTypes` /
    `ChatJson` / `ChatEventParsers` / `ChatItemBuilders` / `ChatToolItems` / `ChatToolFormat`
  - `core/HarnessViewModel.ts`(3345) → 9 文件**继承链**（`HarnessTypes` / `HarnessHelpers` /
    `ViewModelBase` / `Catalog` / `Files` / `Sessions` / `Composer` / `Connection` / barrel 空壳）——
    ArkTS 跨文件共享私有状态**只有继承一条路且继承单向**，故必须按依赖排成一条链；
    构造末尾改用可覆盖钩子 `startRestore()` 打断最底层反向依赖，避免成环。
  - `ui/ChatMessage.ets`(1099) → `ChatMessage.ets` + `MarkdownView.ets` + `MessageParts.ets`
  - `ui/FilesScreen.ets`(1440) → `FilesLayout.ts` + `FileBrowser.ets` + `EditorPane.ets` + `FilesScreen.ets`
  - `ui/ChatScreen.ets`(1125) → `SessionRow.ets` + `SessionSheets.ets` + `ChatScreen.ets`
  - `ui/ChatDetail.ets`(1939) → `ChatDetailPanels.ets`（问答/审批/附件缩略图）+ 头部与输入区分拆
    （`ChatHeader.ets` / `ChatComposer.ets`，本轮完成）
- `@Prop` 深拷贝会在**保留原型**的前提下递归拷贝自有可枚举属性，故传类实例数组安全；
  而函数成员若被 `@Prop` 会连闭包一起拷坏 —— `ComposerSuggestions` 的修法据此只对数据成员加装饰器。

### 文档

- 纳入 git 管理：`git init` + 首笔提交，提交信息遵循
  [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)；
  `.gitignore` 保持 `signing/` 整体忽略（私钥绝不入库），`oh-package-lock.json` 改入版本库。
- 新增 [README.md](../README.md)：项目简介、构建 / 签名 / 测试命令、工程结构、文档索引。
- [PORT-MAP.md](./PORT-MAP.md) 补记本轮遗漏项：坑 23（表格列宽折断英文词）、**坑 24（`/` 命令
  面板根因：普通成员不被回写 + `@Prop` 保原型）**、收尾六
  （正式发布与上架：`.hap` / `.app` 双签、发布签名材料、图标改造、上架材料、git 管理）、
  待真机验证第 24 / 25 条；并修正坑 22 里过时的西文系数（0.55 → 0.60）与「README 尚未写」条目。
- §1 工程结构树里 `AppRuntime.ets` 的「跨分节导航请求」表述偏宽 —— 实际只有
  `requestFilesSection()` 一个、且仅通向文件分节，改为「跨分节跳转请求（当前仅文件分节）」；
  结构树同步反映本轮拆分后的新文件清单。
- 学习源工程 `dsh-companion` 的一线项目文档标准，落地 7 份文档：
  `AGENTS.md`（工程宪法）、`docs/README.md`（索引）、`docs/STATUS.md`（当前状态）、
  `docs/ARCHITECTURE.md`（架构）、`docs/RELEASE.md`（发版流程）、`docs/TESTING.md`（测试）、
  `docs/SECURITY.md`（安全）；根 `README.md` 文档索引同步更新。
- 引入债务台账制度：新增 `docs/TECH-DEBT.md`，行数预算 **800 行/文件**，按 2026-10-15
  基线登记 **10 个超预算文件**（最大 `core/HarnessViewModel.ts` 3 345 行）与 2 条结构性债务；
  `AGENTS.md` §4.2 立制、§8 同步，`docs/README.md` 挂索引。
- 行数预算由 800 **上调至 1 000**（理由：ArkTS 样板多于 Kotlin），在册文件 **10 → 7**；
  退出的 3 个文件（`GenUiCard` / `ModelsScreen` / `DshClient`）转入新增的 `DEBT-003` 继续跟踪。
- **行数预算再由 1 000 收紧至 900**（用户本轮要求「按照 900 行左右拆分」）；7 个在册文件本轮
  **全部拆到达标并退出台账**（当前实测最大 897 行 `GenUiCard.ets`）。
- 补齐源工程文档体系的其余四类：
  - `docs/PARITY.md` 能力对等矩阵（✅/🟡/🔵/⛔ 四态，22 项已验 / 20 项待验 / 4 项有意差异）
  - `docs/ROADMAP.md` 任务台账（阶段、进行中、1.0.1 / 1.1.0 拆债、待办池）
  - `docs/decisions/` 架构决策记录（索引 + 6 条 ADR，其中 **ADR-0005 记录了一次被推翻的决策**：
    Markdown 表格从「刻意不解析」改为「解析并原生渲染」，前案原文保留）
  - `artifacts/RELEASE_NOTES_v1.0.0.md` 发版说明（面向用户与审核）

### 变更

- **双远端托管**：新建公开仓 `westanke/dsh-companion-harmony` —— GitHub 为主（`origin`）、
  Gitee 为镜像（`gitee`），两远端 `master` 指向同一提交；根 `README.md` 补仓库链接。
  建仓踩到两坑（Gitee OpenAPI 的 `private=false` 被当**字符串真值** → 建出私有仓；
  **空仓**不允许转公开，须先推内容再改可见性），记入 PORT-MAP「收尾八」。
- **重出上架包**：10-15 产的 `…-signed.app` **早于坑 23 / 坑 24 修复**，内容已过期。
  按 `RELEASE.md` 重出并里外双签（内外层 `verify-app` 均 `Verify success`），覆盖
  `dsh-companion-harmony-1.0.0-release-signed.app`；同批真机包 `…-release-debugsigned.hap`
  一并更新。版本号**仍为 1.0.0** —— 该版本尚未上传 AGC，本次是纠正**未发布**的 1.0.0 包，
  故不递增 `versionCode`（`RELEASE.md` 的「每发版 +1」针对**已发布**版本；若已上传须改 1.0.1）。
  重出判据：`BUILD SUCCESSFUL` + `531/531`。

---

## [1.0.0] - 2026-10-15

首个正式版，也是 Android 版 DSH Companion 到 HarmonyOS（ArkTS / ArkUI）的完整移植。

### 新增

**功能模块（移植主体）**
- 连接管理：局域网 / 虚拟网 / 公网多地址并存与切换，配置导入与一次性配对码
- 会话：列表、详情、实时消息流、AI 思考过程、工具调用记录与待审批交互
- 工作区文件：浏览与编辑、会话内文件预览（HTML 结构预览、二进制降级）
- 模型与插件：供应商管理、会话模型切换、插件清单与启停
- 界面偏好：深色模式跟随系统主题、中文界面并预留英文接口
- 聊天页为 ArkUI 原生重写，不使用 WebView

**Markdown 渲染（会话正文）**
- 新增 GFM 表格解析与渲染：`MdBlockKind.TABLE` 块、`MdTable` 载体，列宽按内容估算
  （`markdownTableColumnWidths`），界面套横向 `Scroll` 兜住超宽表格。移植前表格整块
  退化成裸竖线文本，比窄表格更难读 —— 这是移植期口径的修正（早期版本刻意不画表格）。
- 新增分隔线（`MdBlockKind.HR`）解析与渲染。
- 行内标记补齐链接、图片、删除线与星号斜体；**刻意不认下划线系** —— `a_b_c`、
  `__init__` 这类会被正则吃坏，判断不出词边界。

**打包与发布**
- 产出 release 正式包，含 `.hap`（模块包，真机安装）与 `.app`（App Pack，上架用）。
- `.app` 采用**里外双签**：先签内部 `entry-default.hap`，组装后再签外层 `.app`。
  只签外层时内部 hap 签名缺失（`signature not found`），上架有被拒风险。
- 上架文案 [store-listing.md](./store-listing.md)：中英文各一份，含一句话简介与应用介绍。
- 应用介绍截图 6 张（1080×1920，9:16），见 `docs/screenshots/`。

**应用图标**
- 图标加入 `DSH` 字样以区别于其他产品，并同步进包内 4 处（`AppScope` 与 `entry`
  各自的 `app_icon.png`、`startIcon.png`）。
- 另出平台图标（1024×1024 PNG）供 AGC 使用；与包内图标同源、几何一致。

### 变更

- `SessionConfigSheet` 改为自订阅 `@StorageLink('dshRevision')` 并取 `cfg()` 快照，
  不再依赖父组件透传 `config` —— 父组件漏传时面板会显示旧值。
- 配置面板高度改用 `SheetSize.FIT_CONTENT`，消除底部大片留白。
- 表格列宽估算的字号来源统一：表头与正文**分别估算再取大**
  （`markdownTableColumnWidths` 新增 `headerFontSizeVp` 参数），渲染与估算共用
  `ChatMessage.headerCellSize()` 这一个出处。原先把表头字号硬编码在渲染处、估算按
  正文字号算，两处各写各的，长表头必然偏窄。
- 西文字宽系数由 0.55 提到 0.60，表格列宽普遍加宽约 9%（宁可略宽，也不让单词被折断）。

### 修复

- **模型列表中点击模型无响应**：`ModelRowView.selected` 与 `AgentPresetRow.selected` /
  `rowEnabled` 由普通成员改为 `@Prop`。`ForEach` 的键不含选中态，键不变则复用组件
  实例，普通成员永远停在首次渲染值。
- **会话详情侧滑 / 返回键直接退出应用**：`Index.onBackPress` 改为退回会话列表。
- **表格里的长英文标识符被在词内折断**（真机表现为 `bundleNam` / `e`）：西文字宽系数
  原为 0.55，与系统比例字体的实际字宽（0.55~0.58 em）贴边，估出的列宽恰好比渲染宽度
  窄几个像素，`Text` 便在词内强制断开。
- 表格块的 `ForEach` 键改为编入表头与各行文字 —— 原键只含长度，而表格块的 `text` 恒为
  空串，流式更新期间键不变，表格一直停在第一帧。

### 移除

- 调试期取证日志：`ModelSheet` 2 处、`HarnessViewModel.selectModel` 1 处。
- 已被正式包取代的 debug 构建包。

---

## 版本对应

| 版本 | 日期 | 说明 |
|---|---|---|
| 1.0.0 | 2026-10-15 | 首个正式版 |
