# dsh-companion 移植映射表（Android → 鸿蒙 ArkTS）

> 本文件是移植过程中的「防丢失笔记」：每读完一个源文件就先把关键契约写进来，再继续。
> 源工程只读：`/media/wangke/OFFICE/workspace/dsh-companion`（Android / Kotlin / Compose）。
> 目标工程：`/media/wangke/OFFICE/TRae_work/dsh-companion-harmony`（HarmonyOS 6+ / ArkTS / ArkUI）。
> 上游许可 AGPL-3.0，归属保留 Hakunm（上游）与 westanke（fork）。

---

## 0. 工程与工具链现状

- 工具链装在 `/media/wangke/OFFICE/TRae_work/_toolchain`，环境文件 `_toolchain/env.sh`：
  - JDK 17（清华 Adoptium），Node 20.19.5（npmmirror），Command Line Tools 5.1.0.840（华为云镜像，含 hvigor/ohpm/hdc/SDK）。
- 编译目标：`compatibleSdkVersion = 5.1.0(18)`（HarmonyOS SDK 5.1 / API 18），在鸿蒙 6 / 7 上向前兼容。
- **第一道闸门**：空 `entry` 工程跑通 `hvigorw assembleHap`，产出未签名 HAP；通过前不写业务代码。
- 签名：暂无华为开发者账号 → **只出 unsigned HAP**，`build-profile.json5` 的 `signingConfigs` 保持空数组
  （其上写了**注释模板**，证书到位后照填即可；构建日志里的 `WARN: No signingConfig` 是预期输出）。
- **第二道闸门**：`scripts/package.sh`（构建 + 单测 + 归集到 `dist/`），实测产出
  `dist/entry-default-unsigned.hap`（2.4 MiB）。

## 1. 工程结构（已落地，与初稿不同，以本文件为准）

```
dsh-companion-harmony/
├── docs/PORT-MAP.md
├── LICENSE  NOTICE    ← 许可证与归属（AGPL-3.0 逐字复制自上游；NOTICE 见 §7「收尾二」）
├── scripts/package.sh ← 打包脚本：双闸门 + 归集 HAP 到 dist/（自己 source 工具链 env.sh）
├── dist/              ← 打包产物（未签名 HAP + LICENSE + NOTICE），由 scripts/package.sh 生成
├── AppScope/  entry/  build-profile.json5  hvigorfile.ts  oh-package.json5  hvigor/
├── package.json     ← 只为 node/tsx 声明 "type": "module"（见 §1b 第四个坑），hvigor 不读它
├── entry/src/main/ets/
│   ├── core/        ← ★纯逻辑层（原 data/ 包）：全部写成 .ts，不 import 任何 @ohos（已 49 个模块）
│   │   ├── JsonAccess.ts  EndpointUrl.ts  ConnectionModels.ts  Codec.ts
│   │   ├── HostStore.ts  ConnectionShare.ts  DshClient.ts  ChatContentParts.ts
│   │   ├── ConnectionCoordinator.ts  TextPredicates.ts  ErrorMessages.ts  ComposerSendPolicy.ts
│   │   ├── MentionQuery.ts  ChatLinkTarget.ts  ConnectionStorage.ts  AppPreferences.ts
│   │   ├── PreviewKind.ts  HtmlPreview.ts  SessionFileRefs.ts  NetworkFailureMapping.ts
│   │   ├── GenUiBlocks.ts  ChatThinkBar.ts  ComposerPill.ts  FileFormat.ts  QuestionAnswers.ts
│   │   └── MarkdownLite.ts  ComposerSuggestions.ts  ← 后两只是本工程特有（源工程无此文件：
│   │      ArkUI 无 Markdown 渲染器，自备块级切分；补全面板判据要单测，故从 UI 抽出）
│   │   ── 以下为**按域拆分后的模块族**（barrel 转发导出，保对外名字不变；每文件 ≤ 900 行）：
│   │   ├── Models.ts(barrel) ← ModelsWire / ModelsFiles / ModelsChat / ModelsConfig / ModelsEvents
│   │   ├── ChatPresentation.ts(barrel) ← ChatPresentationTypes / ChatJson / ChatEventParsers /
│   │   │     ChatItemBuilders / ChatToolItems / ChatToolFormat
│   │   └── HarnessViewModel.ts(barrel+空壳) ← **继承链**（单向，不可乱序）：
│   │         HarnessTypes → HarnessHelpers → ViewModelBase → { Catalog, Files, Composer }
│   │         → Sessions → Connection（构造末尾用可覆盖钩子 startRestore() 打断成环）
│   ├── platform/    ← ★平台能力（已落地 10 个）：Platform.ets 为总装，其余为单项实现
│   │   ├── Platform.ets           createHarnessDeps() / platformSelfCheckText() / 时区 / 语言
│   │   ├── PrefsStore.ets         KeyValueStore → @ohos.data.preferences（同步族）
│   │   ├── Crypto.ets             SHA-256 + AES-256-GCM（cryptoFramework 同步族）
│   │   ├── HttpTransport.ets      HttpTransport → @ohos.net.http
│   │   ├── WebSocketTransport.ets WebSocketTransport → @ohos.net.webSocket
│   │   ├── Timers.ets             TimerBridge → setTimeout/clearTimeout
│   │   ├── Clipboard.ets          复制正文 / 读剪贴板（含 READ_PASTEBOARD 授权）
│   │   ├── Pickers.ets            相册/文件选择器（对位 GetContent / OpenDocument，零权限）
│   │   ├── ImageCodec.ets         原始字节 → PixelMap（ArkUI 的 Image 只认 PixelMap）
│   │   └── ExternalOpen.ets       外链 → startAbility（对位 ACTION_VIEW）
│   ├── ui/          ← ★ArkUI 页面与组件（已落地 25 个）：全部 .ets（`FilesLayout.ts` 除外）
│   │   ├── AppRuntime.ets         唯一 vm 实例 + AppStorage(revision) 桥 + 跨分节跳转请求（当前仅文件分节：requestFilesSection）+ 前后台事件流开关
│   │   ├── Components.ets         BrandMark / WarningBanner / StatusLabel / endpointKindLabel
│   │   │                          + BinaryFilePreview（供会话文件表与文件页共用）
│   │   ├── AppShell.ets           主界面外壳：抽屉 + 五个分节（源 App.kt 的 ConnectedApp）
│   │   ├── ChatScreen.ets         会话分节：装配（会话列表 + 新建会话 + 工作区管理），拆出下两行
│   │   ├── SessionRow.ets         会话列表行（拆自 `ChatScreen.ets`）
│   │   ├── SessionSheets.ets      新建会话 + 工作区管理两个面板（拆自 `ChatScreen.ets`）
│   │   ├── ChatDetail.ets         聊天详情**装配层**：待办/消息流/问答/思考条/审批区 + 装配下三行
│   │   ├── ChatHeader.ets         头部 + 三个面板宿主（会话文件/会话配置/完整访问）（拆自 `ChatDetail.ets`）
│   │   ├── ChatComposer.ets       输入药丸 + `@`/`/` 补全面板（拆自 `ChatDetail.ets`）
│   │   ├── ChatDetailPanels.ets   叶子零件：QuestionCard / ApprovalPanel / AttachmentThumb（拆自 `ChatDetail.ets`）
│   │   ├── ChatMessage.ets        消息条目：正文/工具行/失败行/附件/GenUi 卡片（拆出下两行）
│   │   ├── MarkdownView.ets       Markdown 块渲染 + 表格（拆自 `ChatMessage.ets`）
│   │   ├── MessageParts.ets       消息零件（拆自 `ChatMessage.ets`）
│   │   ├── ComposerSuggestions.ets `@` 文件补全 + `/` 命令补全两个面板（源 ChatScreen.kt 2139–2326）
│   │   ├── GenUiCard.ets          dsh-ui 卡片渲染（源 GenUiCard.kt 604 行）
│   │   ├── FilesScreen.ets        文件分节：装配（授权根 + 新建/移动/回收站三面板），拆出下三行
│   │   ├── FilesLayout.ts         文件页纯布局常量（拆自 `FilesScreen.ets`）
│   │   ├── FileBrowser.ets        目录浏览（拆自 `FilesScreen.ets`）
│   │   ├── EditorPane.ets         行号编辑器 + Markdown 源码/预览（拆自 `FilesScreen.ets`）
│   │   ├── PluginsScreen.ets      插件分节：清单/四种状态徽章/启停确认/检查更新
│   │   ├── ModelsScreen.ets       模型分节：供应商列表 + 编辑面板 + 新建自定义供应商
│   │   ├── SettingsScreen.ets     设置分节：连接/设备权限/语言/发送方式/三个开关/关于/断开
│   │   ├── SessionFilesSheet.ets  会话文件列表 + 详情（HTML 结构预览、二进制降级）
│   │   ├── ModelSheet.ets         会话配置面板：Agent 预设 + 模型分组 + 思考强度
│   │   └── ConnectScreen.ets      连接页（源 ConnectScreen.kt 711 行）
│   ├── entryability/EntryAbility.ets   ← onForeground/onBackground 接 pause/resumeHarnessEvents
│   └── pages/Index.ets    ← 应用根页：连接页 ⟺ !connectGate || !connected；主界面接 AppShell
└── test/            ← ★node:test + tsx 单测（独立 package.json，不参与 HAP 构建）
    ├── package.json  tsconfig.json
    └── cases/*.test.ts   ← 直接 import ../../entry/src/main/ets/core/*.ts
```

**为什么不是独立 common/ 模块**：跨模块相对导入不被 hvigor 支持，做成 HAR/HSP 会引入
模块类型配置复杂度。而 `.ts` 文件（非 `.ets`）既能被 ArkTS 编译进 HAP，又能被 node 直接运行
——已实测验证。所以纯逻辑放 `entry/src/main/ets/core/*.ts`，UI 放 `.ets`，单测在 `test/` 里
用 tsx 直接引用同一份源码。**收益：零重复、单次构建、可离线单测。**

**ArkTS 严格模式约束（已实测）**：`Record<string, Object>` 索引、`typeof`、`Array.isArray`、
`??`、模板字符串、`class`、`enum`、`Map` 均可用；禁止 `any`/动态对象 → 一切 JSON 走 `JsonAccess`。

**构建验证（已通过）**：`cd 工程根 && source _toolchain/env.sh && hvigorw assembleHap --no-daemon` →
`entry/build/default/outputs/default/entry-default-unsigned.hap`。
**单测验证（已通过）**：`cd test && npm test`（node --import tsx --test cases/*.test.ts），
当前 **29 个测试文件 531 用例全绿**（详见 §7 末尾的分文件统计）。

**重要：ArkTS 只编译「被入口可达」的文件。** 新写的 `core/*.ts` 若无人 import 就不会被类型检查；
早期曾用 `core/Probe.ts`（由 `pages/Index.ets` import）当编译探针把新模块都引用一遍。
**现已删除**：五个分节 UI 全部落地后，从 `pages/Index.ets` 出发做 import 可达闭包，结论是
**49 个 core 模块 100% 可达**（脚本枚举 import 并沿相对路径遍历），探针不再是任何模块的唯一引用者。

**字节类型统一用 `Uint8Array`**（ArkTS 支持，且与 preferences/HUKS/cryptoFramework 的入参一致）。
**纯逻辑里不做平台调用**：SHA-256 经 `CryptoBridge` 注入（ArkTS 用 `@ohos.security.cryptoFramework`，
node 用 `node:crypto`）；UTF-8 与 Base64 在 `core/Codec.ts` 里手写实现（两端行为完全一致，
也便于对照 Kotlin 的 `Base64.getEncoder()/getUrlEncoder()` 语义）。

---

## 1b. 工具链现状

- `/media/wangke/OFFICE/TRae_work/_toolchain/env.sh`（source 后 hvigorw/ohpm/hdc/java/node 可用）。
- 已装：JDK17(17.0.20.1) / Node20.19.5 / command-line-tools 5.1.0.840（hvigor5.18.5、ohpm5.1.3、hdc3.1.0e、
  HarmonyOS SDK 5.1.0 Release / API 18）。**UOS(glibc2.28) 兼容，无 GLIBC 报错。**
- 坑记录：`/` 分区仅 20G，解压务必直接落到 OFFICE 盘，**不要用 /tmp**（曾因 /tmp 满导致解压截断）。
  hdc 实际路径：`command-line-tools/sdk/default/openharmony/toolchains/hdc`。
- **坑记录（写注释时的两个致命陷阱，实测踩过，会报 80+ 条莫名其妙的语法错误）**：
  1. 块注释里**绝不能出现字符序列 `*/`**。写「`res/values*/strings.xml`」这种带 `*` 的路径时，
     那个 `*/` 会**提前终止注释**，后面整段"注释"变成代码 —— 报错却是「Module declaration names
     may only use quoted strings」「Unterminated template literal」这类毫不相干的提示，极难往这上面想。
     同理 `**/x` 这种 glob 也别直接写进注释。**要写就写成 `res/values/` 与 `res/values-en/`。**
  2. 注释里也**不要写 `$r('...')` 这种资源引用字面量**：ArkTS 会扫描原文（含注释）找资源引用，
     于是报「Unknown resource name 'x'」。要提就写成「`$r` 加字面量资源名」。
- **坑记录（第三个，实测踩过）**：类字段**不能叫 `arguments`**。ArkTS 报
  `Binding arguments in strict mode`（`10505001`），因为类体按 JS 严格模式求值，
  而严格模式禁用 `arguments` 这个标识符。语义不变换个名字即可 —— 本工程里叫
  `ToolCallDetail.argumentsJson`。同类高危名还有 `eval` / `caller` / `callee`。

- **坑记录（第四个，实测踩过，且最隐蔽）**：**`entry/` 下必须有一只 `package.json` 声明
  `"type": "module"`，否则 `instanceof` 会莫名其妙全假**。现象：单测里
  `new DshApiException(404,'PATH_NOT_FOUND','missing')` 抛给 `HarnessViewModel` 之后，
  `error instanceof DshApiException` 却是 `false` —— 于是 `messageOf` 走到「未知异常」兜底分支，
  把原始英文串 `missing` 甩给用户，6 个用例挂掉（期望中文文案，实际原文）。
  根因：`test/` 有 `package.json`（`type: module`）所以测试文件按 ESM 载入；而
  `entry/src/main/ets/` 全树**没有任何 package.json**，tsx 便把这些 `.ts` 当 **CJS** 载入。
  两个格式各有一份模块缓存，同一个文件被判成两个模块实例 → 类对象不同 → `instanceof` 假。
  修法：在**工程根**放一只 `package.json`，内容只要 `"type": "module"`。已验证跨模块
  `instanceof` 与枚举比较全部恢复。（hvigor 构建读的是 `oh-package.json5`，与本文件无关 —— 
  加完再跑 `assembleHap` 仍是 BUILD SUCCESSFUL。）
  > 排查手法值得复用：先 `console.log(error.constructor.name)` 确认「名字对但 instanceof 假」，
  > 再临时导出一个 `__dbgClasses()` 把本模块看到的类对象抛出来对比 `===`。
  > 一旦 `===` 为 false 而 `name` 相同，就是模块重复实例化，别再怀疑实现逻辑。

- **坑记录（第五个，实测踩过）**：**`@Entry`/`@Component` 的 `build()` 里不能有任何局部变量声明**
  （`const` / `let` 都不行）。写了会报
  `In an '@Entry' decorated component, the 'build' method can have only one root node`，
  且行号指向 `build()` 的**第一行**（不是出错的那一行），很容易往「根节点多余」上想。
  根因：ArkUI 要对 `build()` 做 UI 语法转换，它要求函数体是一个**单一根容器调用**，
  前面插一条声明就把这个前提打破了。
  > 影响：想在 build 里「读一下某个状态以登记依赖」时，**不能**用 `const x = this.someState;`。
  > 正确做法二选一：① 把读取**内联进表达式**（`Text(this.state >= 0 ? f() : f())`）；
  > ② 放进**方法体**（`private label(): string { const v = this.state; ... }` 再从 build 调用它）。
  > 本工程用的是②（见 `ui/ConnectScreen.ets` 的 `languageLabel()`）。
- **坑记录（第六个）**：`@ohos.abilityAccessCtrl` 的 `PermissionRequestResult` 是**具名导出**，
  不是默认导出对象（`abilityAccessCtrl`）的成员。写 `abilityAccessCtrl.PermissionRequestResult`
  会报 `Namespace ... has no exported member`。要从 `@kit.AbilityKit` **具名导入**：
  `import { abilityAccessCtrl, PermissionRequestResult } from '@kit.AbilityKit';`

- **坑记录（第七个，实测踩过，与第三个同类但报错不同）**：`@Component` 的字段**不能与 ArkUI 基类
  上的通用属性方法重名**。本工程把 `SessionRow` 的可用性字段取名 `enabled`，报的是
  `Property 'enabled' in type 'SessionRow' is not assignable to the same property in base type
  'CustomComponent'. Type 'boolean' is not assignable to type '(value: boolean) => CommonAttribute'`
  （`10505001`）—— 提示里能看到基类**方法签名**，一眼就能认出是重名而不是类型写错。
  修法：改名（本工程 `rowEnabled`）。高危名清单（`CustomComponent` 通用属性）：
  `enabled` / `visible` / `width` / `height` / `size` / `padding` / `margin` / `border` /
  `opacity` / `id` / `key` / `clip` / `position` / `align` / `onClick` / **`scale`** —— 组件字段一律避开这些词。
  > `scale` 是本轮新踩到的：`MarkdownView.scale` 与 `NumberedTextEditor.scale` 都报
  > `Type 'number' is not assignable to type '{ (value: ScaleOptions): CommonAttribute; ... }'`。
  > 改名为 `textScale`（两个组件的字段与调用点一起改）。**判据：想给的字段名如果念起来像
  > 一个"属性"（宽度/缩放/透明度/可见性），先怀疑它是不是 ArkUI 通用属性名。**
  > 与第三个坑（`arguments`）的区别：那个是**JS 严格模式**禁用标识符，这个是**基类已有同名成员**
  > （`@Component` 生成的类继承 `CustomComponent`，属性被方法覆盖）。两者都只在编译期暴露。

- **坑记录（第八个，实测踩过，是第五个坑的"变体"）**：`@Builder` 里**不能对"返回可空值的方法"做
  两次调用的窄化**。写 `if (genUiTitle(node) !== null && genUiTitle(node).length > 0)` 会报
  `Object is possibly 'null'`（`10605999`）—— 编译器**不认为**两次独立调用返回同一个值，
  第一处判空对第二处无效。而第五个坑又不允许在这里插 `const`。修法：把「可空取值」包成
  **返回非空值的方法**（本工程在 `ui/GenUiCard.ets` 里加了 `titleOf/labelOf/currentOf/deltaOf`，
  做法与既有的 `codeOf/promptOf` 一致）。同一文件的 9 处报错全是这一个根因。
  > 记住这条判据：**`@Builder` 里凡是「先判 null 再用值」的写法，都要有对应的方法把值非空化。**

- **坑记录（第九个，实测踩过，两条零散但都会卡住编译）**：
  1. **`List` 没有 `space` 属性**（`Property 'space' does not exist on type 'ListAttribute'`，`10505001`）。
     源工程 `LazyColumn` 的 `Arrangement.spacedBy(5.dp)` 没有直接对位物，改由**条目自身的下外边距**给
     （`ui/ChatDetail.ets` 在 `ListItem` 里包一层 `Column().margin({bottom:5})`）。顺带一提：
     **通用属性不能直接挂在自定义组件实例上**，包一层容器同时也是为了这个。
  2. **枚举成员是下划线式大写**：`EnterKeyType.NewLine` 不存在，正确的是 `EnterKeyType.NEW_LINE`
     （报错会提示 `Did you mean 'NEW_LINE'?`，照提示改即可）。同族还有 `EnterKeyType.Send/Go/Search/Next/Previous/Done`。

- **坑记录（第十个，实测踩过）**：**`PinchGesture` 是"值"，不是"类型"**。
  SDK 里写的是 `declare const PinchGesture: PinchGestureInterface;`，所以
  `private pinch(): PinchGesture` 报 `'PinchGesture' refers to a value, but is being used as a
  type here. Did you mean 'typeof PinchGesture'?`。**照提示改成 `typeof PinchGesture` 同样是错的**
  （那是构造器类型，链式 `.onActionUpdate()` 的返回值根本不是它）。
  正确写法是把返回类型写成 **接口名 `PinchGestureInterface`**
  （同族：`TapGestureInterface` / `LongPressGestureInterface` / `PanGestureInterface` /
  `SwipeGestureInterface` / `RotationGestureInterface` / `GestureGroupInterface`）。
  > 通用判据：ArkUI 里这些 `XxxGesture` / `XxxContainer` 大多是 `declare const` 出来的**工厂值**，
  > 想标注类型就得用 `XxxInterface` 或 `XxxAttribute` 这类**接口名**。

- **坑记录（第十一个，实测踩过）**：**全局 `@Builder` 不接受尾随 lambda 形式的子内容**。
  想写「一行骨架 + 尾巴由调用方填」这种组件（源工程里满页都是 `SettingRow` / `SwitchRow` 这类
  带 `content: @Composable () -> Unit` 的写法），**只能写成 `@Component` + `@BuilderParam`**：
  全局 `@Builder function Foo(..., trailing: () => void)` 会报
  `'trailing()' does not meet UI component syntax`（`10905204`）。
  本工程在 `ui/SettingsScreen.ets` 的 `SettingRow` 上踩到，改法是
  `@Component struct SettingRow { @BuilderParam trailing: () => void = this.noTrailing; @Builder noTrailing() {} }`，
  调用点从 `SettingRow(a, b, c, lambda)` 变成 `SettingRow({...}) { StatusLabel({...}) }`。
  > 无尾巴那些行（作者、版本）直接 `SettingRow({...})` 即可 —— `@BuilderParam` 的默认值会兜住。

- **坑记录（第十二个，实测踩过，且是「声明了但没生效」这类最阴的一种）**：
  **`@StorageLink` 只声明、不在 `build` 期间读它 = 该组件收不到任何更新。**
  ArkUI 的状态依赖是**读时登记**的：编译器把每个 `build()` 的方法体包在
  `ViewStackProcessor.StartGetAccessRecordingFor(elmtId)` … `StopGetAccessRecording()` 之间
  （可直接在 SDK 的 `ets-loader/lib/process_custom_component.js` 里查到这两条插入语句），
  只有**在这段窗口内被读到**的状态才会记成该元素的依赖。因此
  `@StorageLink('dshRevision') revision: number = 0;` 这一行如果从头到尾没被读过，
  它**不会**让组件在 vm 更新时重绘 —— 编译不报错、单测全过，真机上却是「点了没反应 / 数据不刷新」。
  本工程一次扫出 **7 个结构**（`AppShell` / `ChatScreen` / `ChatDetail` / `ModelsScreen` /
  `PluginsScreen` / `FilesScreen` 内的 `FileBrowser`+`EditorPane`+`FilesScreen`）中招，
  另有 1 个（`FileBrowser`）连 `@StorageLink` 都没写。
  > **判据**：写完 `@StorageLink` 后，必须能在同一个组件的渲染路径里指出「读它的那一行」。
  > 本工程统一把这次读取放进 `st()`（所有取 vm 状态的路径都经它），这样
  > 「读 vm 状态」与「读 revision」被绑成同一件事，新增组件不会漏。
  > 注意这里**必须用第五个坑给的②**（把读取放进方法体），不能在 `build()` 里插
  > `const rev = this.revision;` —— 那会立刻触发「build 只能有一个根节点」那条报错。
  > 反向排查也简单：写个脚本找「声明了 `@StorageLink('dshRevision')` 但全文再无 `this.revision`」的结构。

  > 同族陷阱（同一个根因，容易混）：**`@Watch` 也不登记依赖**。`@Watch` 只在被监视的值变化时
  > 回调一次，回调里做的状态写入才是驱动重绘的东西（本工程 `AppShell.onVmChanged` /
  > `onFilesRevealRequested` 因此都直接写 `@State`）。

---

## 2. 网络层契约（源：`data/DshClient.kt`，653 行）

### 2.1 端点总表（全部挂在基地址根上，**不带任何前缀**）

| 方法 | 路径 | 鉴权 | 请求体 | 响应 |
|---|---|---|---|---|
| GET | `healthz` | 否 | — | `HealthView{ok,version,pluginVersion?}` |
| POST | `pairings/exchange` | 否 | `{code,deviceName}` | `PairingResult{token,device}` |
| GET | `devices/self` | 是 | — | `DeviceView{id,name,scopes,rootIds}` |
| GET | `roots` | 是 | — | `{items:[RootView{id,label,createdAt}]}` |
| GET | `roots/{rootId}/entries?path=&cursor=` | 是 | — | `DirectoryPage{path,entries,nextCursor?}` |
| GET | `roots/{rootId}/content?path=` | 是 | — | 字节流 + 头 `ETag` / `Content-Type` |
| PUT | `roots/{rootId}/content?path=` | 是 | 字节流 | 响应头 `ETag`；`If-Match: <etag>`，无 etag 时 `If-None-Match: *` |
| POST | `roots/{rootId}/entries` | 是 | `{path,kind:file\|directory}` | 空 |
| PATCH | `roots/{rootId}/entries` | 是 | `{path,destinationPath}` | 空 |
| DELETE | `roots/{rootId}/entries?path=` | 是 | — | 空（软删进回收站） |
| GET | `trash` | 是 | — | `{items:[TrashEntry...]}` |
| POST | `trash/{id}/restore` | 是 | 空体 | 空 |
| GET | `roots/resolve?path=` | 是 | — | `ResolvedPath{rootId,path,kind,size?,modifiedAt,contentType?}` |
| GET | `chat/sessions` | 是 | — | `{items:[ChatSession...]}` |
| GET | `chat/workspaces` | 是 | — | `{items:[ChatWorkspace...]}` |
| POST | `chat/workspaces` | 是 | `{rootId,path}` | `{workspace}` |
| PATCH | `chat/workspaces/{id}` | 是 | `{title}` | `{workspace}` |
| DELETE | `chat/workspaces/{id}` | 是 | — | 空 |
| GET | `chat/agent-presets` | 是 | — | `{items:[AgentPreset...]}` |
| PUT | `chat/sessions/{id}/agent-preset` | 是 | `{agentPreset}` | `{agentPreset}` |
| GET | `chat/sessions/{id}/models` | 是 | — | `SessionModels{current,routable,groups,failures}` |
| PUT | `chat/sessions/{id}/model` | 是 | `ModelSelection{provider,model,reasoningEffort?}` | `{selected}` |
| POST | `chat/sessions` | 是 | `{workspaceId,agentPreset?,clientRequestId}` | `{session:{id,agentPreset?}}` |
| PATCH | `chat/sessions/{id}` | 是 | `{title}` | `{title,seq}` |
| POST | `chat/sessions/{id}/fork` | 是 | `{atSeq?}` | `{sessionId}` |
| POST | `chat/sessions/{id}/archive` | 是 | 空体 | 空 |
| GET | `chat/sessions/{id}/messages?beforeSeq=&maxMessages=` | 是 | — | `ChatHistory{events,hasMore,projections?}` |
| GET | `chat/sessions/{id}/approvals` | 是 | — | `{items:[PendingApproval...]}` |
| POST | `chat/sessions/{id}/approvals/{aid}/decision` | 是 | `{outcome:"allowed-once"\|"rejected"}` | 空 |
| GET | `chat/sessions/{id}/questions` | 是 | — | `{items:[PendingQuestionSet...]}` |
| POST | `chat/sessions/{id}/questions/{callId}/answer` | 是 | `{answers:[{id,selected[],custom}]}` | 空 |
| GET | `chat/sessions/{id}/commands` | 是 | — | `{items:[CommandDescriptor...]}` |
| POST | `chat/sessions/{id}/commands` | 是 | `{line}` | `{execution:{commandId,result}}` |
| POST | `chat/sessions/{id}/messages` | 是 | 见 2.3 | 空 |
| POST | `chat/sessions/{id}/attachments` | 是 | `{name,data}`（见 2.3） | `UploadedAttachment{receiptId,name}` |
| POST | `chat/runs/{sessionId}/cancel` | 是 | 空体 | 空 |
| GET | `attachments/{attachmentId}?sessionId=` | 是 | — | 字节流（会话历史图片） |
| GET | `settings/providers` | 是 | — | `ProviderSettings{...}` |
| PATCH | `settings/providers/{id}` | 是 | `ProviderPatch` | `ProviderSettings` |
| POST | `settings/providers` | 是 | `CustomProviderCreate` | `ProviderSettings` |
| POST | `settings/providers/{id}/discover` | 是 | `{baseURL?,api?,apiKey?}` | `{models:[ProviderModel...]}` |
| GET | `settings/plugins` | 是 | — | `PluginInventory{...}` |
| GET | `settings/plugins?checkUpdates=1` | 是 | — | 同上（慢，仅用户主动查更新时走） |
| PATCH | `settings/plugins` | 是 | `{name,loaded}` | `PluginToggleResult{...,restartRequired:true}` |
| WS | `events` | 是 | — | 推 `WorkspaceEvent{id,type,time,data}` |

> ⚠️ `chat/sessions/{id}/questions` 的 GET 会走服务端 `resolveAgent(...,resume)`，
> 对**冷**会话调用会把 Agent 拉活 → **只能对当前打开的会话调用**，禁止遍历会话列表。

### 2.2 请求约定

- 鉴权头：`Authorization: Bearer <token>`；`Accept: application/json`；
  `Accept-Language: <当前界面语言，BCP-47，如 zh-CN / en>`（随每个请求出海；从未设置时按 `zh-CN`）。
- 超时：**连接 15s / 读 45s / 写 45s**，WebSocket `pingInterval = 20s`。
- WebSocket：请求 URL 用**同源 `http://`/`https://`**，由底层做协议升级；**不要**提前改写成 `ws://`/`wss://`。
- WS 重连退避：`delay = (1 << retries) 封顶 30s`，即 **1、2、4、8、16、30、30…** 秒。重连后状态恢复**始终靠 REST**。
- `normalizeEndpoint(value)`：去首尾空白与尾斜杠；必须以 `http(s)://` 开头（否则抛错）；
  若 `encodedPath` 去掉尾斜杠后**不以 `/api/v1` 结尾**，则追加 `/api/v1`。
  > 陷阱：地址**千万不要带 `/dsh-workspace-api` 前缀**（那是 DSH Web 在 3080 上的挂载面，只绑 127.0.0.1）。
  > 3090 是插件远程监听端口，路由直接挂在根上。
- 空体请求：GET/HEAD **绝不能带 body**；POST/PUT 零长度体补 `{}`。
- 图片内联：`{type:"image",mediaType,data(svg base64 标准字母表),name?}`；
  文件：先 `POST .../attachments` 换 `receiptId`，消息里引用 `{type:"file",receiptId}`。

### 2.3 发消息体（源：`data/ChatContentParts.kt`）

两种形状（纯文本走旧的 `{"text":...}`，带附件才用 `content` 数组）：

```json
{ "text": "...", "mode": "queue" | "steer", "clientTimeZone": "Asia/Shanghai", "clientRequestId": "<uuid>" }
{ "content": [ {type:"text",text}, {type:"image",...}, {type:"file",receiptId} ],
  "mode": "queue"|"steer", "clientTimeZone": "...", "clientRequestId": "<uuid>" }
```

- `mode`：运行中「排队」=`queue`、运行中「插话」=`steer`。
- `clientTimeZone`：本机时区 id。
- 附件体积**发送前**拦截：图片 **8 MiB** / 文件 **24 MiB**。

### 2.4 错误处理

- 非 2xx 解析 `{error:{code,message,requestId?}}` → `DshApiException(status, code, message)`。
- `UNRESOLVABLE_CODES`（均属「正常结果」而非故障，`resolvePath` 返回 null）：
  `PATH_OUTSIDE_ROOTS` / `PATH_NOT_ABSOLUTE` / `PATH_NOT_FILE` / `PATH_NOT_FOUND`。
  **其余 404 必须抛出**（`ROUTE_NOT_FOUND` = 插件版本过旧，应提示升级插件）。
- 问答 409：`QUESTION_REPLY_QUEUED`（答复已在队列）/ `QUESTION_NOT_PENDING`（该问题已不作答）→ 翻成人话。

---

## 3. 连接层契约（源：`data/ConnectionModels.kt`，227 行）

- `Host{id,displayName,endpoints[],preferredEndpointId?,credential?,createdAt,updatedAt}`
- `Endpoint{id,label,baseUrl,kind,enabled,lastLatencyMs?,lastCheckedAt?,lastError?}`
- `Credential{kind,secret,deviceId?,deviceName?,scopes[],issuedAt,expiresAt?}`
  （`isExpired()`：`expiresAt != null && expiresAt <= now`）
- `EndpointKind`：`LAN / VIRTUAL_NET / WAN / UNKNOWN`；`infer(baseUrl)` 规则：
  - `localhost` / `127.0.0.1` / `::1` / `*.local` → LAN
  - `10.x`、`192.168.x`、`172.16–31.x`、`169.254.x` → LAN
  - `100.64–127.x`（CGNAT，Tailscale/BeyondTunnel）→ VIRTUAL_NET
  - 其余合法 IPv4 → WAN；域名/非法 → UNKNOWN
- `Endpoint.create(label,baseUrl,id)`：baseUrl 先 `normalizeEndpoint` 再去掉 `/api/v1`。

### 3.1 选路规则 `EndpointSelection.rank`（四级排序键，测试须一致）

1. 只保留 `ok && latencyMs != null` 的探活；全失败 → 整体失败，返回全部失败原因供诊断面板。
2. 主键：延迟升序。
3. **局域网近似即优先**：`LAN_LATENCY_TOLERANCE = 1.5` —— LAN 地址延迟 ≤ 最快地址 × 1.5 时并入第 0 档（排前）。
4. 并列：`preferredEndpointId` 优先，其次 `lastCheckedAt`（null 视为 `Long.MIN_VALUE`）。

### 3.2 探活与连接（源：`data/ConnectionCoordinator.kt`）

- `probeTimeoutMs = 1500`（每个地址**独立**计时、独立超时）。
- `probeAll(host)`：并发探 `host.activeEndpoints`（`enabled && baseUrl` 非空白），顺序与之一致。
- 探活动作：`health()`（未鉴权）。超时 → `EndpointProbe.failure(id,"timeout after 1500ms")`。
- `connect(host)`：探活 → `rank().firstOrNull()` → 构造 `DshClient`；全不可达返回
  `Result.failure(DshConnectionException(probes))`。
- `close()` 语义：置 `closed`、叫醒在途探活（`closedSignal.complete`）、取消 probeScope；
  此后新调用 `check(!closed)` 快速失败。**不**中断在途阻塞 HTTP（OkHttp 无 `Call.cancel()` 暴露）。
- 关键原因：协程取消**打不断**卡在 socket 读的阻塞调用，所以必须用「独立 scope + 只给 `await()` 设 deadline」。

### 3.3 `ActiveConnection{host, endpoint, client, probes}`

---

## 4. 配置导入契约（源：`data/ConnectionShare.kt`，309 行）

线格式：`DSH1:<Base64URL(UTF-8 JSON)>`（URL-safe、**无填充**）。长度预算 **≤ 600 字符**。

JSON：`{displayName, endpoints:[{label,baseUrl}], token?, deviceName?, scopes?}`

- **不写** `Endpoint.id` / 探活历史 / `kind` / `enabled`（本机状态，换机无意义；解码端宽容接受）。
- `token`/`deviceName` 为 null → 不写键；`scopes` 空 → 不写。
- baseUrl 统一归一为**不含** `/api/v1` 的基地址。
- **不加密**：文本即凭据载体（内含设备令牌），安全边界由「发给谁」决定。

`encode` 会校验：至少一个地址 + 每地址 http(s) 且有主机名，否则抛 `IllegalArgumentException`
（唯一故意抛异常处：生成端人还在电脑前，能立刻改）。

`decode` 容错（真实粘贴环境，任何非法输入返回 **null 绝不抛**）：
1. `clean`：去掉**所有**空白（含微信换行、邮件折行、全角空格、nbsp）与零宽字符/BOM（`\uFEFF \u200B \u200C \u200D \u2060`）。
2. `stripPrefix`：前缀大小写不敏感、**允许出现在全段任意位置**（`indexOf(PREFIX, ignoreCase=true)`），找不到就当整段是 Base64。
3. `decodeBase64`：先只保留字母表字符（`A-Za-z0-9 + / - _ =`）→ 长度 `%4==1` 直接判死 → 补 `=`
   → 先 URL-safe 再标准字母表。
4. `parseWire`：先原样解析，失败则截最外层 `{...}` 再试。
5. `isUsable`：至少一地址 + 每地址去掉 `/api/v1` 后是 http/https 且有主机名。

`buildHost(payload,idFactory)`：Host id 由 idFactory 生成一次；地址 id 沿用 payload 的，空则 `<hostId>-ep{n}`；
每地址**重新推断 kind**、清空探活历史；`preferredEndpointId = null`；token 非空时建 `DEVICE_TOKEN` 凭据；
时间取当前。`displayName` 空 → 回退 `"电脑"`。

---

## 5. 多主机持久化（源：`data/HostStore.kt`，238 行）

- 抽象：`KeyValueStore{getString,putString,remove,clear}`、`SecretBox{encrypt,decrypt}`（便于测试）。
- 落盘键：`KEY_HOSTS = "hosts_v1"`、`KEY_HOSTS_CORRUPT = "hosts_v1_corrupt"`。
- 格式：整份 `List<Host>`（含 secret）JSON → `SecretBox` 加密 → Base64（标准字母表）落盘。**明文绝不落盘**。
- `loadHosts()` 遇坏数据（非法 Base64 / 解密失败 / JSON 损坏）→ 返回**空列表绝不抛**；原值保留在
  `hosts_v1`，并另存副本到 `hosts_v1_corrupt`（不静默清空）。
- `upsert(host)`：同 id 保留**原 createdAt**，刷新 updatedAt 为 clock()；新 host 且 createdAt=0 时补当前时间。
- `markPreferred(hostId, endpointId?)`：只改选路偏好，**不改 updatedAt**。
- `migrateLegacy(endpoint, token)`：地址空 → 返回 null 且**不写任何东西**；
  id 由地址 SHA-256 派生（`legacy-<sha256前16>` / `legacy-ep-<...>`），保证幂等；
  displayName 取主机名；只建一个 Endpoint，preferred=该地址；复用已有凭据 issuedAt。
- 照搬平台映射：`SharedPreferences → @ohos.data.preferences`；`Android Keystore AES-GCM → HUKS/Asset Store`。

---

## 6. 平台能力映射表

| Android | 鸿蒙 ArkTS | 落地情况 |
|---|---|---|
| OkHttp（REST） | `@ohos.net.http` | ✅ `platform/HttpTransport.ets`；`expectDataType=ARRAY_BUFFER` 统一收字节，响应头键转小写 |
| OkHttp WebSocket | `@ohos.net.webSocket` | ✅ `platform/WebSocketTransport.ets`；URL 保持 http(s) 不改写；`onDown` 自带一次性闸 |
| SharedPreferences | `@ohos.data.preferences` | ✅ `platform/PrefsStore.ets`；**走同步族**（`getPreferencesSync`/`putSync`/`deleteSync`）以匹配 core 的同步契约 |
| Android Keystore AES-GCM | HUKS / Asset Store | ⚠️ **降级**：`platform/Crypto.ets` 用 `cryptoFramework` 同步族（AES-256-GCM）+ 密钥存独立偏好文件 `dsh_keys`。HUKS 只有异步 API，与 core 同步契约冲突；升级路径见下 |
| Java `MessageDigest("SHA-256")` | `cryptoFramework.createMd('SHA256')` | ✅ `Sha256Bridge`（`updateSync`/`digestSync`）；`HostStore.stableId` 取前 16 位，故必须稳定输出 |
| 剪贴板 | `@ohos.pasteboard` | ⏳ 待 UI 层建（连接页「粘贴分享串」用） |
| 震动 | `@ohos.vibrator` | ⏳ 待 UI 层建 |
| 文件选择 | `@ohos.file.picker` | ⏳ 待 UI 层建 |
| 应用私有目录 | `@ohos.file.fs` + `context.filesDir/cacheDir` | ⏳ 待 UI 层建（附件读写、预览） |
| 深色/浅色主题 | ArkUI 跟随系统 `colorMode`；系统导航条按 `colorMode` 显式设色 | ✅ 已建成（见「收尾五」→ 系统导航条随主题设色） |
| 多语言 | `resources/string.json`（zh 默认）+ `resources/en_US/string.json` 预留 | ⏳ 待 UI 层建（core 侧的双语文案表已就绪） |
| `Date.now()` / UUID / 系统时区与区域 | `Date.now` / `util.generateRandomUUID` / `i18n.System.getSystemLocale` / `i18n.getTimeZone().getID()` | ✅ `platform/Platform.ets` |

### 6.1 平台层三个**有意的**取舍（都要能被看到，不许沉默）

1. **`PATCH` 方法缺口**：本工程 SDK（API 18）的 `http.RequestMethod` 枚举**没有 PATCH**
   （只有 OPTIONS/GET/HEAD/POST/PUT/DELETE/TRACE/CONNECT），而 DSH 服务端把「重命名会话」
   「移动文件」「开关插件」全放在 PATCH 上。`HttpTransport.ets` 里用
   `'PATCH' as http.RequestMethod` 把字符串塞进枚举 —— 枚举值是字符串，NetStack 对非标准方法
   走 `CURLOPT_CUSTOMREQUEST`，运行期确实发得出去。**待真机验证一次 PATCH 端点**；
   日后 SDK 补上枚举应改回 `http.RequestMethod.PATCH`。
2. **无独立写超时**：`HttpRequestOptions` 只有 `connectTimeout`/`readTimeout`，core 的
   `writeTimeoutMs`（45s）在这层被忽略 —— 平台能力差异，不是漏写。
3. **密钥安全降级**：当前用「独立偏好文件存 AES 密钥」，弱于 Android Keystore（拿到沙箱读权限
   即可解出密钥）。升级路径只有一步：把 `Crypto.ets` 的 `loadOrCreateKeyBytes` 换成
   「HUKS 生成 + 启动时 `exportKeyItem` 导出到内存」，`AesGcmSecretBox` 不动。
   先这么做的理由：HUKS 的可导出标志要在真机上验证，而当前阶段目标是**先把核心链路跑通**。

---

## 7. 待办 / 未读清单（每读完一个补一节）

- [x] `JsonAccess.ts`（新建）、`EndpointUrl.ts`（新建）
- [x] `data/ConnectionModels.kt` → `core/ConnectionModels.ts`（含 EndpointSelection.rank）
- [x] `data/ConnectionShare.kt`、`data/HostStore.kt`、`data/ConnectionCoordinator.kt`（contract 已读）
- [x] `core/Codec.ts`（新建：UTF-8 + Base64 手写实现）、`core/HostStore.ts`、`core/ConnectionShare.ts`（§4/§5 契约已落地）
- [x] `core/Models.ts`（源 `data/Models.kt` 544 行；DshClient 的返回类型全靠它）。落地要点：
  - 全部类型 **缺键 / 显式 null / 类型不符 → 默认值，绝不抛**（`JsonAccess` 唯一入口）。
  - 出站请求体统一走 `WireBuilder`：**null 字段一律省略**（对齐 kotlinx `encodeDefaults = false`）；
    `QuestionAnswer.custom` 为空时不写 `custom` 键。
  - 嵌套数组**必须传 `JsonMap[]`（对象映射数组）**，绝不能传已序列化字符串——否则会被二次转义
    （`ProviderModel.toMap()` / `PromptPart.toMapArray()` 就是为此存在）。
  - `PromptPart` 用「单一扁平类 + `type` 分派」而不是三个子类（规避 ArkTS 继承覆盖语法歧义），
    编码时**只写该形态字段**；`fromJson` 对未知/缺失 `type` 返回 null，不猜形态。
  - 两个刻意保留的「三态/可空」语义：`PluginEntry.updateAvailable`（null ≠ false）、
    `PluginInventory.profile/profilePath`（服务端会显式发 null）。
- [x] `core/DshClient.ts`（契约见 §2；`HttpTransport`/`WebSocketTransport`/`TimerBridge` 三个注入点，
  逻辑层只做 URL 拼装/鉴权头/错误映射/退避；全部端点方法已落地）。落地要点：
  - 端点全部挂在根上（不带前缀），路径段与查询参数均 `encodeURIComponent`（`attachmentId` 的冒号 → `%3A`）。
  - `Authorization: Bearer`、`Accept: application/json`、`Accept-Language` 只加在**需要鉴权**的请求上；
    `healthz` / `pairings/exchange` 走裸请求（`GET 绝不带 body`、零长度 POST/PUT/PATCH 体补 `{}`）。
  - `resolvePath` 只把 `UNRESOLVABLE_CODES` 当 `null`，其余 404 一律抛 `DshApiException`。
  - WS：URL 用同源 `http(s)`，退避 `min(1<<min(retries,5), 30)` 秒 → 1/2/4/8/16/30/30…；同一次尝试
    `onDown` 只处理一次（平台层会先 onError 再 onClose）；连上一次即清零 retries。
  - 与方法数无关的分层：所有 `getJson/postJson/patchJson/putJson/postUnit/patchUnit` 私有方法统一走
    `send(method,url,body,headers)`，头由 `authHeaders()/jsonBodyHeaders()` 组装。
- [x] `core/ChatContentParts.ts`（源 `data/ChatContentParts.kt`）。落地要点：
  - **只有单个非空 text part 才走旧格式** `{"text":...}`；其余走 `{"content":[...]}`；
    空白 part 先剔除，剔完为空则抛 `EMPTY_CONTENT`（本地拦住，不发必被拒的空 prompt）。
  - 图片内联 base64 用**标准字母表**（`+ / =`，非 URL-safe）；图片 8 MiB / 文件 24 MiB 上限。
  - `readAtMost(limit, source, chunk)` 最多读 `limit+1` 字节：`<=limit` 才算读完，
    `>limit` 说明被截断必须拒绝 —— 多读的那一字节正是为此存在（大小可能是 -1 的内容提供者）。
- [x] `core/ConnectionCoordinator.ts`（源 `data/ConnectionCoordinator.kt`）。落地要点：
  - `probeTimeoutMs=1500`，每地址**独立** deadline；整批并发（`transport.request` 是同步发起，
    所以 `probeAll` 返回时所有请求都已在路上）。
  - `withDeadline` 用 `Promise.race([attempt, timeout, closed])`：超时 → `null`（翻成
    `timeout after Nms`）；完成 → 透传；`close()` → reject `CLOSED_MESSAGE`。
  - **JS 无协程**，所以不需要上游的 `closedSignal` 补丁；但 `close()` 必须主动 reject 在途等待，
    否则光取消定时器只会让等待方永远挂着（等于泄漏）。
  - `connect` 复用 `EndpointSelection.rank`，不另写排序；不改写主机记录（落盘归 `HostStore`）。
- [x] `core/ErrorMessages.ts`（源 `data/ErrorMessages.kt` + `res/values*/strings.xml` 的错误文案段）。落地要点：
  - 与安卓的结构差异（有意）：安卓只返回 `@StringRes` id，正文在 `strings.xml`；ArkTS 取资源只认
    **编译期字面量资源名**，运行期拼 key 再拼资源名行不通。故约定：**出错文案（按错误码查的表）在 core，
    界面文案（按钮/标签）走资源系统**；中英两列都写在这里（英文是可直接用的正文，不是占位）。
  - `normalizeErrorCode` 照抄 `substringAfterLast('/')` 语义（`A/B/` → 空串而非 null）；空白判定用
    `TextPredicates.trimText`（Kotlin 口径），不用 JS `trim()`。
  - `localizedErrorText(code, lang)` **认不出返回 null**（调用方保留服务端原文）；兜底那条把**原始**码
    填进 `%1$s`（不是归一化后的），界面上看到的与用户能贴出来的一字不差。
  - 网络层按**类别**查表（`NetworkFailureKind`：timeout/unreachable/refused/reset/other），
    由平台层把 `@ohos.net.http` 的数字错误码翻成类别；另有 `allEndpointsUnreachableText` 专供
    `DshConnectionException`（它不是服务端返回的码）。
- [x] `core/TextPredicates.ts`（新建，MentionQuery / ComposerSendPolicy / 后续表现层共用）。落地要点：
  - Kotlin `Char.isWhitespace()` = `isWhitespace || isSpaceChar`，与 JS `\s` **只差 U+FEFF**；
    这里写成显式区间判定，别"顺手优化"成 `/\s/`（会把 U+FEFF 的差异引回来）。
  - 提供 `trimText`（Kotlin `trim()`）、`trimChar/trimStartChar/trimEndChar`（`trim(vararg chars)` 单字符形态：
    给了字符就**只按该字符**比对，不再按空白）。
- [x] `core/ComposerSendPolicy.ts`（源 `data/ComposerSendPolicy.kt`）。落地要点：
  - 用 `SEND_MODE_QUEUE/'queue'`、`SEND_MODE_STEER/'steer'` 字符串常量，不做 enum↔字符串来回转换
    （`mode` 一路进请求体，全链路就是线上取值）。
  - **空闲一律 queue**（`steer` 没有可插话的轮次），即使 `preferred=steer` 且按了备用组合键。
- [x] `core/MentionQuery.ts`（源 `data/MentionQuery.kt`）。落地要点：
  - `absolute()` 是**换前缀**不是「cwd + 相对路径」：`entryPath` 相对授权根、工作目录只是它的一段前缀；
    前缀按整段比对（`ws` 不误配 `wsx/`），对不上就**退回 entryPath 本身**，绝不硬拼错的绝对路径。
  - `cwdRelative` 为空串是**合法值**（工作目录就是授权根本身），不能当成「没有工作目录」。
- [x] `core/ChatLinkTarget.ts`（源 `data/ChatLinkTarget.kt`）。落地要点：
  - 单一扁平类 + `kind` 判别（同 `PromptPart` 的处理，规避 ArkTS 继承歧义）；
    不支持时 `path` 保留**原始**串（含首尾空白），理由是排查时看到的就是用户点的那一串。
  - 判定顺序：先排 `//`（协议相对 URL 是网页）→ `#`（锚点）→ `/`（唯一认得的服务端绝对路径形态）
    → 再认 scheme。
- [x] `data/SecureConnectionStore.kt`、`AndroidConnectionStorage.kt`、`AppPreferences.kt`
  → `core/ConnectionStorage.ts` + `core/AppPreferences.ts`。落地要点：
  - 原 `AndroidConnectionStorage.kt` 里三种东西按「能否脱离系统」拆开：`SharedPreferencesKeyValueStore`
    与 `KeystoreSecretBox` 是纯平台（鸿蒙侧分别换成 `@ohos.data.preferences` 与 HUKS/Asset 实现注入点），
    **只有 `LegacyConnectionMigration` 搬进 core**（它只依赖注入的 KeyValueStore/SecretBox/HostStore）。
  - `SecureConnectionStore` **不重建**：单连接时代的遗留类，原仓库里已无调用点（grep 只有定义处）；
    只保留它写过的三个键名 `endpoint`/`token_iv`/`token_ciphertext`（迁移要用）。
  - 迁移**幂等**（成功后清旧键，第二次因「键已无」返回 null）、**绝不抛异常**（Base64 非法/解密失败/
    HostStore 拒绝都只返回 null）。IV 需手工拼回密文头部，所以 `GCM_IV_LENGTH=12` 是硬约定。
    旧键的 Base64 走**标准字母表**（对齐 `android.util.Base64.NO_WRAP`），不是 URL-safe。
  - 上游 `migrate` 的 `idFactory` 参数从未被使用（Host id 由地址摘要派生），移植时直接丢掉，不留死参数。
  - `AppPreferences` 只做「读带兜底、写归一」两件事：键缺失/值损坏/值认不出 → 回落默认，**绝不抛**。
    布尔按 `'true'`/`'false'` 字符串落盘（`KeyValueStore` 只有字符串读写）。
    `busySendMode` 直接存**线上取值**（`'queue'`/`'steer'`），不存安卓那套大写枚举名；写入非法值按
    `'queue'` 落盘（偏好是本 App 新装即默认，无旧数据互通问题）。
- [x] `core/ChatPresentation.ts`（源 `data/ChatPresentation.kt` 825 行）。落地要点：
  - **聊天页唯一的移植接缝**：界面只读 `ChatDisplayItem[]`，不直接读事件。契约：
    `displayItemsOf(history)` / `todoItemsOf` / `permissionSelectOf` / `deliverablesOf` /
    `chatDelta(event)` / `chatTurnFailure(event)` / `handoffPathOf(id)`，外加 `LiveChatState`。
  - **三态语义要分清**：`ChatTurnFailure.code` 空串是**合法值**（免费额度限流的 code 就是 `""`），
    界面那一格要照原样显示，不能当缺失；`ToolCallDetail.result` 的 `null`（还没有结果）
    与 `''`（有结果但没文字）也是两回事，各有单测钉住。
  - 资源 id 的差异（同 ErrorMessages 口径）：Kotlin 返回 `@StringRes Int`，这里返回
    **字符串 key**（`turn_failed_title` / `turn_stopped_title`），界面按 key switch 到字面量资源名。
  - 「认得出」三处判据照抄上游：`turn/end` 的失败仅认 `reason.kind==='error'`，或
    `aborted` + `reason.kind==='hook' && reason.reason==='deepseek-account/signed-out'`；
    `max-tokens` **不算失败**（官方口径是黄色警示）。误报比漏报更伤。
  - 交接说明（`[Image: source: <绝对路径>]`）**只在 `source.kind==='user'` 的消息里摘**，
    其余上下文一律不动（否则上下文正文被切碎、还凭空多出读不到的假附件）；
    摘的是**行**不是整条 part（万一与用户正文同 part，别把用户的话一起吞了）。
    确认换成 `handoff:<路径>` 的附件，附件名只取路径尾段。
  - 工具行：连续 TOOL 合并成一行（动作短语并集、>4 种收尾加「等」），但 `tools` 明细**逐条全留**；
    合并只动 `id`/`title`/`body`，故 `ChatDisplayItem.withMerged` 只开这几个字段。
  - `ToolCallDetail` 字段名是 `argumentsJson` 而非 `arguments`（ArkTS 严格模式，见 §1b 坑 3）。
  - 取值语义按 kotlinx 复刻（`ChatJson`）：`contentOrNull` 对数字/布尔原语也给字符串；
    `intOrNull` 只认 **int32 内的整数**（`1.5` / `1e12` → null，不像 JS `Number()` 那样悄悄接受）。
  - 工具结果的时间差为负（时钟倒退）→ **不显示**（`null`），不编一个 0 或负数。
  - `formatToolDuration` 刻意不进资源系统（ms/s/m/h 是通用单位）；边界全在单测里钉住。
  - `prettyToolArguments` 缩进用 4 空格（对齐 kotlinx `prettyPrint`）；坏 JSON **原样返回**。
- [x] `core/PreviewKind.ts`（源 `data/PreviewKind.kt` 261 行）+ `core/HtmlPreview.ts`（源 235 行）
  + `core/SessionFileRefs.ts`（源 180 行）+ `core/GenUiBlocks.ts`（源 341 行）。落地要点：
  - **PreviewKind**：判据链「扩展名 → contentType → 兜底」。扩展名取法用「最后一个点必须在
    最后一个斜杠之后」的显式判据（上游踩过坑：裸文件名 `README.md` 被当成「扩展名 = README.md」→ 静默
    退化成源码预览）。图片/PDF 扩展名**从二进制集合里挪出来**，否则二进制判定在前会永远抢命中。
    魔数只做**升级**（SOURCE/BINARY 两档遇到图片头才升 IMAGE），且不推翻名字已明确给出的
    MARKDOWN/HTML 意图。BMP 要求 DIB 头长度属已知集合、HEIF/AVIF 要求 `ftyp` 主品牌已知，
    免得「BM…」「有 ftyp」把文本误判成图片。字节/像素上限（24MiB/32MiB/12MP/100 页）集中在这里，
    加载路径与提示文案共用同一份真值。
  - **HtmlPreview**：替代 WebView 的**纯文本结构抽取**（无 JS/无网络/无样式）。`script`/`style`
    连标签带内容整段丢弃。`pre`/`code` 嵌套时**只认自己这一个标签的闭合**（上游 bug：把两者都放
    进 stops → `<pre><code>` 里代码块整个抽不出来）。`readTextUntil` 遇到非停止标签补**一个空格**
    （防文字粘连），代码块 `collapseWhitespace=false` 保留换行缩进。实体只还原常见五项 + 数字/十六进制；
    `toIntOrNull(radix)` 显式实现（不用 JS `parseInt`，它会在非法字符处停下并返回已解析部分）。
  - **SessionFileRefs**：绝对路径判定（`/` 开头或 Windows 盘符）。采集只认 `meta.diffs[]`（兼容顶层
    `diffs[]`）与三处工具参数形态里的 `file_path`；**bash/pwsh/run_code 整体跳过**（误报会训练用户
    忽略面板）；兜底的 `path` 键**只在 FILE_PATH_TOOLS 上采信**（grep/glob 的 path 是搜索目录）。
    工具名按 `substringAfterLast('/')` 取末段再小写。全程不抛：畸形事件/坏参数/类型不对一律跳过。
  - **GenUiBlocks**：三段式「切分 → 解析 → 分发」。四条硬规则：必须有**闭合**围栏才切（流式中间态
    整段按原文保留、一字不动）、只认**行首**围栏头、围栏内容原样透传、空内容不切。`isGenUiInfo`
    判据是「标记里**含有** `dsh-ui`」而非精确前缀（` ```json dsh-ui ` 也认），但 ` ```dsh-ui-bad `
    不认。`SUPPORTED` 只列真渲染得了的类型，未知 type 丢弃。诊断 `diagnoseGenUi` 三态分开报：
    纯文字=正常 / dsh-ui 围栏未闭合=流式输出中（**不报故障**）/ 无标记裸 ```=真故障（如实报数量）。
    `fenceScan` 带 `insideFence` 状态（裸 ``` 二义：在里面是闭合、在外面是开头）。
- [x] `HarnessViewModel.kt`(2277) → `core/HarnessViewModel.ts` ← 全部业务动作。落地要点：
  - **平台能力全走注入**（`HarnessDeps`）：`hostStore`/`preferences`/`coordinator`/`legacyKeyValueStore`/
    `legacySecretBox`/`now`/`newId`/`languageTag`/`timers`。core 不 import 任何 `@ohos.*`，因此可在 node 里直测。
  - **文件读写用平台读好的 `Uint8Array`** 替代 InputStream/OutputStream：`attachImage`/`attachFile`/
    `upload`/`replaceSelected`/`downloadSelected(): Promise<Uint8Array>`；体积闸按 `bytes.length` 比
    `ChatContentParts.MAX_*_BYTES`，超限用源里同一套提示文案。
  - **无 StateFlow**：`HarnessState` 是普通 class（字段默认值与源逐字对应），`update(fn)` 就地改 + `revision++`
    + 通知监听者；`subscribe(listener)` 返回退订函数。`HarnessState.copyFrom` 取代 Kotlin `copy()` 的
    「部分字段覆盖」语义（`connectHostInternal` 成功路径把快照整份接管再逐字段覆盖）。
  - **`sendMessage` 同步闸**：任务要求「同步取走并清空 `pendingAttachments`」在任何 `await` 之前，
    但纯文本双击时 attachments 已空、text 非空 → 仍会二次发送；故**额外新增** `private sending`
    （首行判断并置起、`finally` 复位）。理由注释照抄：按钮禁用状态要等下一次重组才生效。
  - **400ms 去抖**用注入 `timers.schedule/cancel`；句柄 push 进 `timerHandles`，`dispose()` 统一取消
    （Kotlin 靠 `viewModelScope` 自动取消）。`dispose()` 替代 `onCleared()`：取消定时器、关事件订阅、`coordinator.close()`。
  - **`messageOf` 三层映射**：服务端错误 → `localizedErrorText`；`DshConnectionException` → `allEndpointsUnreachableText`；
    网络层 → `NetworkException(kind,detail)` → `networkErrorText`。安卓那 7 个 IOException 分支**有意收敛成一条**。
  - **`COMMAND_NAME` 加 `^...$` 锚点**：Kotlin 用 `matchEntire`（整串匹配），JS `RegExp.test` 是子串匹配，
    不加锚点会让 `Compact`/`1bad` 误判为真。锚点是忠实还原，不是收紧。
  - 顶层纯函数同名导出：`isHostCommandLine`/`removeQuestion`/`isToolResultFrame`/`markSessionStopped`，
    另导出 `QUESTION_REFRESH_EVENTS`/`COMMAND_NAME` 与兜底码 `CONFIG_INVALID`/`LAST_ENDPOINT`/`PLUGIN_TOO_OLD`/
    `FILE_TOO_LARGE`/`BINARY_FILE`/`COMMAND_FAILED`。
  - **保留全部中文解释性注释**：为何不用 bash 解析、cwd 空串合法、立刻本地置位 not-running、
    防重复提交不能靠禁用按钮、断开不清主机、熄屏只关事件流、草稿要还回输入区、400ms 是去抖不是轮询。
- [x] **平台层 `entry/src/main/ets/platform/`（本轮落地，6 个文件）**。落地要点：
  - **为什么能保持 core 的同步契约**：`HostStore`/`AppPreferences` 的 `getString`/`putString` 是同步签名
    （当初为可离线单测而定），`SecretBox`/`CryptoBridge` 同理。而 preferences 与 cryptoFramework
    默认都是 Promise 风格 —— **幸好两者的 API 10/12 起都有同步族**：
    `getPreferencesSync`/`hasSync`/`getSync`/`putSync`/`deleteSync`/`clearSync`/`flushSync`，
    以及 `Md.updateSync/digestSync`、`SymKeyGenerator.convertKeySync`、`Cipher.initSync/doFinalSync`、
    `Random.generateRandomSync`。**已逐条在 SDK 的 `.d.ts` 里核对存在**。于是 core 一行未改，438 用例不受影响。
  - `PrefsStore` 三条不变量：**读不抛**（键缺失/值类型不符 → null）、**写不抛**（偏好丢了不影响可用性）、
    `putString(key, null)` 表示删除（不是写空串）。写后立即 `flushSync`，避免进程被杀丢设置。
  - `Crypto`：密文格式 `IV(12) || GCM 密文(含 16B authTag)`，每次加密新取 IV（GCM 硬要求）；
    `HostStore` 里密文是 Base64 存的，所以这里进出都是 `Uint8Array`，Base64 由 core 的 `Codec` 负责。
  - `HttpTransport`：错误码先查 `NetworkFailureMapping`（那张表在 core，**可离线单测**）→ 抛 `NetworkException`；
    响应统一 `ARRAY_BUFFER`（文本与二进制下载同一路径）；响应头键转小写（`HttpResponse.header` 的前提）。
    `Uint8Array → ArrayBuffer` 只在视图正好覆盖整个 buffer 时复用，否则拷贝 —— core 的
    `slice`/`readAtMost` 常产出大 buffer 的片段，直接交 `buffer` 会把多余字节也发出去（附件上传尤其致命）。
  - `WebSocketTransport`：`onDown` 自带「恰好一次」闸（平台层可能先报 error 再报 close）；
    **主动 `close()` 后丢弃全部回调** —— 那是用户的选择，不该再被报成一次掉线；重连由 core 的
    `EventsChannel` 负责（1/2/4/8/16/30s），故本层不持有跨次状态。
  - `Platform.ets` 是**唯一总装点**：`createHarnessDeps(context)` 一次性把 10 项能力注入 core；
    另提供 `platformSelfCheckText(context)` —— **平台层是唯一无法离线单测的一层**，所以自检是真机冒烟：
    真跑一遍偏好读写 + 真生成密钥 + 真跑 AES-GCM 往返 + 主机库往返，结论打在连接页上（用户截图即现场）。
    自检项跑完即删临时键/临时密钥，不污染真实数据。
  - 已知偏差与取舍见 **§6.1**（PATCH 枚举缺口、无独立写超时、密钥安全降级到偏好文件）。
- [x] **UI 起步（本轮落地连接页 + 运行时桥 + 共享组件 + 中英资源）**。落地要点：
  - `ui/AppRuntime.ets` 是**唯一的 vm 实例与 ArkUI 桥**：core 的 `HarnessViewModel` 刻意不依赖
    `@Observed`/`@State`（否则那 438 个单测就没法在 node 下跑），所以这里把 vm 的 `revision`
    写进 `AppStorage`，页面用 `@StorageLink('dshRevision')` 订阅 → 任何 `update()` 自动重绘。
    组件里读 `vm.state.xxx` 永远是**最新值**（同一个对象原地改），不需要深拷贝。
    前后台策略对位源工程：`pauseEvents()` **只关事件流**（连接与已加载数据都保留），
    `resumeEvents()` 回来时重新订阅并按需补齐。
  - `ui/ConnectScreen.ets`（源 711 行 → 本工程约 640 行）：**三条不许简化的行为**
    ① 两条连接方式默认都收起且互斥（用户原话：「默认不要展开，我需要那个我自己点击」）；
    ② 「测试连接」**不放行**连接页（只探活不建连）；放行只发生在「连接 / 配对 / 导入」；
    ③ 「进入应用」与「连接这台电脑」**不能共用一个启用条件** —— 共用 `busy` 的后果是
    自动重连成功后只要后台还有请求在跑，「进入应用」就是灰的，而连接页没有第二个入口。
  - `pages/Index.ets`（源 `App.kt` 369 行的判据部分）：`显示连接页 ⟺ !connectGate || !connected`。
    三个反直觉点：**不能只看 `connected`**（冷启动自动重连成功时它已是 true，而用户还没点头）；
    `connectGate` 必须是**进程级**的（`HarnessState` 在 disconnect 时会整份重建，把门闩放进去会被冲掉，
    表现是「刚进主界面又被弹回连接页」）；**不要把 `restoring` 排在前面**（自动重连要探活全部地址
    可能好几秒，先渲染转圈会让用户看不到连接页）。
  - 资源：`resources/base` 为**中文**（default），`resources/en_US` 为**英文预留**，两文件键集完全对齐。
    新增 `reason_clipboard`（剪贴板授权理由，模块清单里要用）。主题全部走 `sys.color.ohos_id_color_*`
    语义色 → 深浅色随手机自动切换，本工程不维护第二套色板。
- [x] **UI 续一：`AppShell` + 会话列表（本轮落地）**。落地要点：
  - `ui/AppShell.ets`（源 `App.kt` 369 行的 `ConnectedApp` / `NavigationPanel` 两块）。三个取舍照抄：
    ① **默认分节按 `scopes` 选**（有 `chat.read` 进会话、否则有 `files.read` 进文件、否则进设置）——
    设备只授权文件时，硬编码「默认会话」会让用户一进来就看见一个空会话页；
    ② **模型页与设置页永远可进**（`sectionEnabled` 恒 true）—— 写成「要 `settings.read`」看似正确，
    实则会让「为什么没有模型页」这个问题永远不可达；
    ③ **插件页要 `settings.read`**（它读的就是 `settings/plugins`）。
    抽屉用 `SideBarContainer`，宽窄屏判据 840vp（`onAreaChange` 跟踪），对位源工程 `BoxWithConstraints`
    + `ModalNavigationDrawer`。`state.error` 走系统 toast 后在 `reportErrorIfAny()` 里立刻 `clearError()` ——
    不清的话同一句话会在每次重绘时反复弹。
  - `ui/ChatScreen.ets`（源 ChatScreen.kt 里 `SessionPane` / `SessionRow` / `NewSessionSheet` /
    `WorkspaceManagementSheet` / `RenameDialog` 五块，3619 行中的约 400 行）。四件事照抄：
    ① 行标题回退链 `title ?? workspaceTitle ?? (cwd 为空时取 id 前 12 位)`，**只对 null 回退**；
    ② `chat.write` 只挡「新建会话 / 管理工作区」两个入口，列表本身只看 `chat.read`；
    ③ 新建会话面板的「已有工作区 / 新建工作区」互斥，后者靠 `workspacePickerDirectory != null` 才允许提交；
    ④ 重命名 / 归档 / 移除工作区都要二次确认（改的是电脑上的真实数据）。
  - **两处有意差异（都是为了少一层 API 风险，写进文件头了）**：
    ① 三个面板合成**一个 `bindSheet` + `sheetKind` 分发**（源工程是两个 ModalBottomSheet 加一个
    重命名 AlertDialog）—— `bindSheet` 在同一组件上挂多个面板的行为与版本相关，`CustomDialog` 又要把
    输入框状态在两个组件间搬运；合成一个后 `renameDraft` 只存在于本组件。
    ② 三处下拉用 `bindMenu` 的**数据形式**（`MenuElement[]`）而不是自绘弹层 —— 完全避开
    `CustomBuilder` 传参约定，代价是工作区/预设菜单的副标题并进同一行文字。
  - `pages/Index.ets` 的 `mainPlaceholder()` 已删除，主界面改接 `AppShell()`；`ChatScreen({ wide })`
    由 `AppShell` 把宽窄屏判据传下去（列表与详情并排 / 列表↔详情两种走法）。
  - `core/Probe.ts` **本轮已删除**：模型页、插件页、设置页补齐后，可达闭包已覆盖全部 core 模块
    （见 §1 的说明），探针完成了它的历史使命。`pages/Index.ets` 里对 `probe()` 的调用一并删掉。
  - 资源又补 18 键（会话行/新建面板/工作区管理三段），base 与 en_US **键集仍完全对齐**。
- [x] **UI 续二：聊天详情页（本轮落地，源 ChatScreen.kt 3619 行里约 1100 行）**。新增 7 个文件：
  `core/MarkdownLite.ts` + `platform/Pickers.ets` + `platform/ImageCodec.ets` + `platform/ExternalOpen.ets`
  + `ui/ChatMessage.ets` + `ui/SessionFilesSheet.ets` + `ui/ModelSheet.ets` + `ui/ChatDetail.ets`。
  - **`core/MarkdownLite.ts` 是移植时新增的替代实现，源工程没有对应文件**：原工程助手正文交给
    Android 专有的 `com.mikepenz.markdown.m3` 渲染，ArkUI 侧 `@ohos.*` **没有任何 Markdown 解析能力**。
    本模块只做**块级切分**（标题/有序无序列表/引用/代码块/**表格**/**分隔线**/段落），行内标记交给既有的
    `GenUiBlocks.inlineMarkup` 剥掉。两处刻意不做：**段落内不把换行并成空格**（中文一行一句很常见）、
    **不做嵌套**。最容易写反的两条已钉单测：代码块内容**原样透传**（`# 注释` / `- diff 行` 不会被二次解释）、
    **有序列表必须以 1 开头**（否则 `20260101.5 亿`、`37. 版本号` 会被误判成列表）。
    「表格画不画」的口径已改，见坑 22（早期刻意不画 → 真机反馈后改为「能画就画、画不下横向滚」）。
  - **`platform/Pickers.ets`**：对位 Android 的 `GetContent` / `OpenDocument`。用系统选择器
    （`photoAccessHelper.PhotoViewPicker` + `picker.DocumentViewPicker`，**不用**已废弃的 `@ohos.file.picker.PhotoViewPicker`）
    → **零权限**（返回临时 URI，`fs.openSync` 可直接打开）。三个设计点：读盘前先看 `statSync().size`
    早退（防 200MB 原图先读进内存再判超限）、**取消与失败分两档**（`CANCELLED` 单独一档，取消不弹提示）、
    `readSync` 只取真正读到的字节。
  - **`platform/ImageCodec.ets`**：ArkUI 的 `Image()` **不接受原始字节**（只认 PixelMap / 资源字符串），
    所以这一步必经。长边限 1024px（聊天图显示宽上限 260vp × 3 倍密度 ≈ 780px）。**关键**：把 `bytes`
    的那一段单独 `slice` 出来再交给解码器，否则视图之外的字节也会被喂进去。解码失败返回 null 不抛错。
  - **`platform/ExternalOpen.ets`**：对位 `Intent(ACTION_VIEW, uri)`，走
    `startAbility({action:'ohos.want.action.viewData', entities:['entity.system.browsable'], uri})`。
  - `ui/ChatMessage.ets`（源 2430–3050）：三处平台差异写在文件头 —— ① Markdown 自备；② 图片先解码；
    ③ **复制手势只能用双击**（`TapGesture({count:2})`）：给整条消息挂长按会被外层吃掉、文本选择的
    手柄弹不出来（源工程注释里记过一次同样的翻车）。三处照抄：用户消息文字可为空（只发图不打字正常）、
    `failed` 时**折叠态也要显示红色「失败」**、`result == null`（还没有结果）与 `result == ""`（结果为空）
    是两种状态且文案不同。**必须**把 `:bytes` / `:fail` / `:loading` 编进 `ForEach` 键，
    否则字节到达时键不变、ArkUI 跳过重建、图片永远显示加载中（"看起来最像后端没返回"的坑）。
  - `ui/SessionFilesSheet.ets`（源 890–1285）：两条判据照抄 —— ① 列表**优先用 `deliverables`**、
    没有才退回正则扫出来的引用；② 详情页**分支顺序一字不改**（`loading → outsideRoots → failure →
    directory → 二进制预览 → tooLarge → preview==null → 空 → 按类型渲染`），因为 `outsideRoots`
    必须排在 `failure` 前（前者是服务端正常判定、不是错误，混进错误分支会变红警告）。
    两处平台差异：不画表格、**PDF 不内嵌渲染**（ArkUI 无 PDF 组件）→ 走「字节已取到 + 提示去文件页」，
    用新键 `session_file_pdf_unsupported` **如实标注为功能降级**。
  - `ui/ModelSheet.ets`（源 3056–3255）：三条判据照抄 —— ① Agent 只在 `session.blank == true` 时可改，
    并**用一句话说明为什么不能点**；② **切换模型时把思考强度一起重置成该模型默认值**
    （否则从支持高强度的模型切走会发出对方不认识的 effort）；③ 思考强度只在选中模型下展开。
    平台差异：`FlowRow` → `Flex({wrap: FlexWrap.Wrap})`；选中底色不靠底色单独承担语义（深色模式下
    容器色缺失会看不出选没选）→ 另加 `✓`。**`modelSelected` 必须 provider 与 model 都比** ——
    实测有 `deepseek-chat` 在两个 provider 下同名，只比 id 会同时给两行打勾。
  - `ui/ChatDetail.ets`：`ChatDetail` + `ConversationHeader` + `TodoPanel` + `ApprovalPanel` +
    `QuestionCard` + `Composer` + `ChatThinkBar` + `ApprovalLoading`。文件头写清五处平台差异
    （三个面板合成一个 `bindSheet` + `sheetKind`；全访问二次确认从 `AlertDialog` 换成底部面板，
    因为 ArkUI 的系统弹窗装不下「我已了解」勾选框；`⋯` 菜单用 `MenuElement[]` 数据形式并把权限档位
    **压平**进同一级菜单；自动滚底的判据自己算条目数（ArkUI 的 `List` 没有 `layoutInfo.totalItemsCount`，
    只有 `onScrollIndex` 的起止下标）；图片缩略图先解码）与五条照抄判据（**标题链用完整 id** 而不是
    列表行的前 12 位；审批只顶掉输入区、问答不顶；审批四态分派顺序；`canSteer` 三条同时成立；
    默认发送模式来自 `resolveSendMode`、占位符走 `composerHint` 三态）。
  - `ui/ChatScreen.ets` 的 `detailPane()` 已整体换成 `ChatDetail({wide, onBack})`（含删掉旧的 52vp
    头部行与 `chat_detail_todo` 占位、清掉不再使用的 `selectedTitle()`）—— 详情页**自带** `ConversationHeader`，
    在上面再叠一层标题就会出现「两个标题 + 两个返回键」。
  - 资源又补 **48 键**（本轮四批：详情页/审批/问答/输入区 43 键 + `session_file_partial` +
    `session_file_pdf_unsupported` / `session_file_open_directory` + `awaiting_approval` / `approval_loading`），
    base 与 en_US **各 226 键、键集仍完全对齐**。占位符一律从安卓的 `%1$s`/`%1$d` 改写成 ArkUI 的 `%s`/`%d`。
- [x] **UI 续三·文件页（本轮落地，源 `ui/FilesScreen.kt` 749 行）**。新增 1 个大文件 +
  3 处对既有文件的增强，并把文件分节真正接进 `AppShell`：
  - **`ui/FilesScreen.ets`（新建）**：`FilesScreen` + `FileBrowser` + `FileRow` + `EditorPane` +
    `NumberedTextEditor` + `EmptyState`。四条照抄判据写在文件头：**权限分工是三个不同的 scope**
    （进分节要 `files.read`；新建/上传/重命名移动/替换要 `files.write`；删进回收站/恢复要 `files.delete`，
    三者不可互相顶替）／「没根目录」`no_roots` 与「目录是空的」`empty_directory` 是两种状态／
    **文件名跑马灯而不是截断**（源工程注释写明：这里的文件名又长又前缀雷同，截断后判断不出是哪个文件）／
    **保存按钮三条闸门**（`text != null` && `entry.writable` && `files.write`）。
    四处平台差异：三个系统对话框（新建/重命名移动/回收站）合成一个 `bindSheet` + `sheetKind`／
    跑马灯用 `TextOverflow.MARQUEE`／**双指缩放用 `PinchGesture`**（`event.scale` 是**从手势开始算的累计值**
    → `onActionStart` 必须记基准 `pinchBase`，否则每帧在「基准 × 累计」上打滑）／
    `NumberedTextEditor` 的**行号栏与 `TextArea` 并排放在同一个 `Scroll` 里**，靠两边 `lineHeight`
    完全一致来对齐（源工程靠读另一个 `Scroll` 的 offset 做偏移，ArkUI 拿不到 → 从根上绕开）。
    **一处已知代价写进文件头**：`TextArea` 自动折行，所以按「最长行字符数」算宽度（横向滚动）并设
    `LONGEST_LINE_CHAR_CAP = 400` 上限；超过上限的超长单行仍会折行、行号在那一段错位
    （不设上限时一份压缩 JSON 会把宽度撑到布局算不出来）。
  - **`ui/Components.ets`**：新增导出 `BinaryFilePreview`（对位源 `Components.kt`），把原先
    `SessionFilesSheet.ets` 的私有 struct 抽成公共组件，并把源工程有、而前一版缺失的
    「跳过预览时同时显示实际大小与上限」补齐。字段用布尔量 `showDownload` 而不是可空回调，
    避开 ArkTS 对可空函数字段的类型纠结。
  - **`ui/ChatMessage.ets`**：`MarkdownView` 新增 `textScale`（供文件页 Markdown 预览跟随缩放按钮，
    对位 `fileMarkdownTypography(scale)`）；聊天正文一律 `1`。
  - **`platform/Pickers.ets`**：新增 `SaveOutcome` + `saveBytes()`（下载＝先取字节再走系统保存面板）。
    **取消与写失败必须分两档** —— 否则用户按「取消」会看到一个「保存失败」。
    `fs.writeSync` 只写 `bytes.buffer.slice(byteOffset, byteOffset + byteLength)` 那一段。
  - **`ui/AppShell.ets`**：`mainContent()` 增加 `MainSection.Files → FilesScreen({ wide })` 分支
    （原先落在 `sectionPlaceholder` 上），新增 `import { FilesScreen }`，并删掉占位注释里
    「FilesScreen 尚未移植」的说法。
  - 资源又补 **26 键**（文件页），base 与 en_US **各 252 键、键集仍完全对齐**。
  - 本轮新踩两个 ArkTS 坑并记入 §1b：**坑 7 补 `scale`**（组件字段不能叫 `scale`，是通用属性方法名）、
    **坑 10**（`PinchGesture` 是 `declare const` 的**值**，标注类型要用接口名 `PinchGestureInterface`）。
- [x] **UI 续五·模型页 + 设置页（本轮落地）**。新增 2 个文件，并把 `AppShell` 的五个分节全部接通
  （占位 builder 连同 `section_todo` 一起删掉）：
  - **`ui/ModelsScreen.ets`（新建，源 `ui/ModelsScreen.kt` 463 行）**：`ModelsScreen` + `ProviderRow` +
    `ProviderEditor` + `CustomProviderEditor`。五条判据照抄源工程：**`settings.read` 是准入、
    `settings.write` 才是可改**／**`canEdit` 三条件同时成立**（`settings.write` && `providerSettings.writable`
    && `provider.configurable` —— 内置供应商的 baseURL 由 DSH 自己管，不给改）／
    **点开编辑之前先 `clearDiscoveredModels()`**（否则在新供应商里会看到上一个供应商发现的模型，
    一按「使用发现结果」就写错模型）／**`provider_secret_note` 必须显示**（少了它，用户会以为
    「凭据已配置」能点开看密钥，然后找不到）／**改动模型列表要区分「继承」与「覆盖」**
    （`modelsInherited` 为真且用户没动过 → patch 里不带 `models`，保持继承；写成「总是提交当前列表」
    会让所有继承供应商统统变成硬覆盖，用户以后在电脑上改模型目录、手机上再也跟不上）。
    四处平台差异：两个 `ModalBottomSheet`（编辑 / 新建）合成一个 `bindSheet` + `sheetKind`（取
    `SheetSize.LARGE`：十来个输入框 `MEDIUM` 装不下）／协议候选用 `bindMenu(MenuElement[])`／
    密码框 `InputType.Password`、地址栏 `InputType.URL`／`OutlinedTextField` 的
    `label`/`supportingText` 没有对应概念，字段名改成输入框上方的 `Text`、提示句进 `placeholder`，
    校验失败用 `.border({color: warning})`（ArkUI 的 `TextInput` 没有 `isError`）。
  - **`ui/SettingsScreen.ets`（新建，源 `ui/SettingsScreen.kt` 321 行）**：`SettingsScreen` +
    `SettingRow` + `SwitchRow` + `SettingsHeading` + `scopeLabel`。五条判据照抄源工程：
    **语言走「应用级语言」而不是自制开关**（`i18n.System.setAppPreferredLanguage` 对位
    `AppCompatDelegate.setApplicationLocales`；选项上写**语言自己的名字**而不是译文 ——
    看不懂当前界面语言的人得靠母语名字才能找到自己那一项）／
    **三个开关一律读 `state` 而不是直接读偏好存储**（源工程注释记过这个坑：读
    `SharedPreferences` 不是 Compose 状态，改了不触发重组 → **点了开关不动、得再点别的才跳**）／
    **认不出的 scope 保留原文**（与 core 错误码表同一原则）／**`http://` 要出警告条**／
    **断开键用错误色**（它是破坏性操作，用普通按钮色会和「刷新」看起来一样顺手）。
    三处平台差异：`SingleChoiceSegmentedButtonRow`（语言、发送方式）→ 两个并排药丸按钮，
    且**两个选择题各写一个 `@Builder`**（不共用带数组参数的：ArkUI 的 `@Builder` 只对
    「按引用传递」的对象参数可靠）／`FlowRow` → `Flex({wrap: FlexWrap.Wrap})`（地址药丸、权限药丸）／
    `BuildConfig.VERSION_NAME` → `bundleManager.getBundleInfoForSelfSync().versionName`
    （取不到显示 `v?` 而不是崩）。
  - **`ui/AppShell.ets`**：`Models → ModelsScreen()`、`Settings → SettingsScreen()`，
    并删掉已无用的 `sectionPlaceholder()` 与 `app.string.section_todo` 的引用。
  - **`pages/Index.ets`**：删掉闲置的 `selfCheck` 字段与 `platformSelfCheckText` 的导入
    （它的落点已按原计划挪进设置页），文件头补一句「五个分节全部落地」。
  - **一处本工程特有的补充（源工程没有）**：设置页「关于」下面多了 **「平台层自检」**
    ——`prefs` / `aesgcm` / `hoststore` 三项同步往返的结论，可点「重新自检」重跑。
    理由：平台层是唯一无法离线单测的一层，这个结论正是「待真机验证」里那几条的一手证据，
    而 `pages/Index.ets` 早在第一轮就把这个落点写下了。
  - 资源两次共补 **35 键**（模型页 29 + 设置页 35，其中 1 键已存在即跳过），
    并**删掉本工程特有的 `section_todo`**（分节占位已不存在，留着是死键）。
    本轮末再删死键 `chat_detail_todo`（详情页早已落地，占位文案的读者没了）。
    最终 base 与 en_US **各 346 键、键集与顺序完全一致**。
  - **本轮踩到一个 ArkUI 语法坑（已修，记入 §1b 第十一个）**：全局 `@Builder` **不接受尾随 lambda**
    形式的子内容（`'trailing()' does not meet UI component syntax`）；`SettingRow` 因此改成
    `@Component` + `@BuilderParam`。
- [x] **UI 续四·插件页（本轮落地，源 `ui/PluginsScreen.kt` 464 行）**。新增 1 个文件并接进 `AppShell`：
  - **`ui/PluginsScreen.ets`（新建）**：`PluginsScreen` + `PluginRow`。四条判据照抄源工程：
    **四种插件状态必须都认得**（`loaded` / `runtime-provided` / `installed-not-loaded` /
    `declared-missing`，未知取值走兜底徽章而不在解码层抛错 —— 否则一台健康的机器会冒出一排「状态未知」）／
    **启停不直接在开关上执行**（改 profile 的 package.json 是有后果的操作：写坏了 dsh 下次起不来，
    所以先弹一句确认、让用户看清要动的是哪个插件）／**不能启停的原因要说出来**（官方包 / 声明缺失 / 没装，
    否则用户会去找一个根本不存在的开关）／**更新提示三态**（只在 `updateAvailable === true &&
    latestVersion !== null` 时显示「有新版本 x」；`updateAvailable === null` 什么都不显示 ——
    显示「已是最新」是撒谎，显示「未知」是噪音）。
    判据 1 的落地细节：徽章五档 `stateKind()`，`runtime-provided` 单独给文案「随 DSH 运行时提供」而不是
    「版本未知」（官方包不在 profile 的 node_modules 里，报未知会制造假警报）。
    三处平台差异：`Switch` → `Toggle({type: ToggleType.Switch})` + 通用属性 `.enabled()`／
    确认弹窗走系统 `showAlertDialog`（本页只有一个弹窗、内容就是「标题 + 一句话 + 两个按钮」，
    与源工程 `AlertDialog` 结构一致，不必像详情页/文件页那样合成 `bindSheet`）／
    `widthIn(max=720.dp)` → `constraintSize({maxWidth: 720})` + 外层 `Column.alignItems(Center)`。
    另外两处刻意的取舍：**「检查更新」放在概览卡里而不是顶栏**（它是重活：每个包一次 registry 请求，
    清单会从毫秒级变成好几秒，与顶栏那个「刷新」不是一类动作）；**无写权限时不画一个点了会失败的开关**
    （页面顶部那条 `WarningBanner` 已经说明缺什么）。
  - **`ui/AppShell.ets`**：`mainContent()` 增加 `MainSection.Plugins → PluginsScreen()` 分支 +
    `import { PluginsScreen }`。
  - 资源又补 **33 键**（插件页），base 与 en_US **各 285 键、键集与顺序完全一致**。
  - **本轮踩到一个资源层的坑（已修，记在此处）**：`string.json` 里出现了 74 个键**重复两次**，
    构建直接报 `Resource 'think' conflict`。重复块的值与首次出现处**逐字相同**（脚本核对过），
    所以按「保留首次出现」去重即可，不会丢数据。**教训：往 `string.json` 手工追加键之前先跑一遍
    JSON.parse + 重名检测**（一行 node 脚本即可），否则这个错要等到构建期才炸、报的还是某个
    与本次改动无关的旧键名（`think`），很容易查错方向。
- [x] **收尾一·删除编译探针 + 修复资源文件的字符级损坏（本轮落地）**。
  - **删除 `core/Probe.ts`**：先做可达性判定（脚本从 `pages/Index.ets` 出发枚举 import、沿相对路径做闭包），
    结论「29 个 core 模块 100% 可达」→ 探针不再是任何模块的唯一引用者，连同 `pages/Index.ets` 里的
    `import { probe }` 与 `probe()` 调用一起删除。删后 `BUILD SUCCESSFUL` + 488 用例全绿。
  - **修复 `string.json` 的字符级损坏**：模型页/设置页那两批新键（以及 en_US 的 `binary_file` 一处）
    出现**随机字符被吞**的损坏（`provider_secret_note`→`previderesecrtimiste`、`active`→`acr,ve`、
    en 的 `binary_file`→`ry_file`），base 与 en_US 的尾部数十行已无法 `JSON.parse`。
    修复数据源按可信度排序：
    ① **最后一次成功构建的 `entry/build/.../res/default/ResourceTable.txt` 与 `ids_map/id_defined.json`
       仍留有全部 347 个正确**键名**（值是二进制 `resources.index`，读不出来）——拿它当权威键表；
    ② 只读安卓工程的 `values/strings.xml` + `values-en/strings.xml` 提供 60 个键的中英原文；
    ③ **头部未损坏的键一律保留原措辞**（本工程对安卓原文做过改写，如 `%1$d`→`%d`、
       `endpoint_count` = 「%d 个地址」；若用安卓原文整体覆盖，这些改写会被冲掉）；
    ④ 4 个本工程特有键（`platform_self_check_*` 三键 + `web_chat_footnote_port`）手写。
    **占位符必须归一化**：安卓 `%1$s`/`%1$d` → 本工程约定的 `%s`/`%d`，否则 `$r(id, arg)` 喂不进去
    （`credential_reference`、`discovered_models` 两个键踩到）。
    **定序**：整体按 `ResourceTable.txt` 的顺序（字母序）重排，base 与 en_US 因此**键集与顺序完全一致**、
    无重复、无空值。
  - **教训（接在插件页那条资源坑之后）**：`string.json` 出现**字符级**损坏时，`JSON.parse` 会在第一个
    畸形位置中断，但**损坏点之前的键值通常完好**，且损坏条目里**往往只有名字被啃、值还在**（或反之）。
    所以正确做法是**先抢救骨架再补缺**——把「名字能解析、且在权威键表里」的条目收集起来当骨架，
    只用可信源补缺失键——**不要整份重写**，否则会把没坏的改写一并冲掉。
- [x] **收尾二·签名占位 + 打包脚本 + AGPL-3.0 LICENSE/NOTICE（本轮落地）**。
  - **签名占位**：`build-profile.json5` 的 `signingConfigs` **保持空数组**，但在其上写了一段
    **注释模板**（`certpath` / `storePassword` / `keyAlias` / `keyPassword` / `profile` / `storeFile` /
    `signAlg`，以及「口令用 DevEco Studio 录入才写成加密串、手写明文可能被拒」的提醒）。
    理由：暂无华为开发者账号，**硬填假证书只会让构建失败或产出装不上的包**；
    空配置下那条 `WARN: No signingConfig` 因此是**预期输出**，不是缺陷。
    证书到位后按模板填，`hvigorw assembleHap` 自动产出已签名 HAP，打包脚本无需改动。
  - **打包脚本 `scripts/package.sh`**：跑双闸门（`hvigorw assembleHap` + `test/` 下的 `npm test`）
    并把产物归集到 `dist/`。三个刻意的取舍：
    ① **自己 `source ../_toolchain/env.sh`**（按脚本位置推导绝对路径），所以从任何目录调用都能跑，
       不吃调用者的环境变量；
    ② **不硬编码产物名**，而是 glob `outputs/default/*.hap` 全量归集 —— 这样**签名材料补齐后脚本零改动**
       （产物会从 `entry-default-unsigned.hap` 变成签名 HAP）；
    ③ `--no-test` 可跳过测试（只改文案时想快一点），默认仍然是**必须先过测试**；
    ④ 归集时**把 `LICENSE` 与 `NOTICE` 一并拷进 `dist/`** —— 对一个「下载即分发」的产物来说，
       许可证留在仓库里是不够的（AGPL-3.0 要求许可证随分发物给出）。
    实测：`BUILD SUCCESSFUL` + 488 用例全绿 → `dist/`（`entry-default-unsigned.hap` 2.4 MiB + LICENSE + NOTICE）。
  - **`LICENSE`**：从只读源工程**逐字复制** AGPL-3.0 全文（661 行，字节一致），未做任何改动。
  - **`NOTICE`（新建，本工程特有）**：四段 —— ① **归属**（上游原始项目 `Hakunm/dsh-android-app`、
    所对照的 fork `westanke/dsh-companion`、本工程维护者 `Github@westanke`、许可证 AGPL-3.0 未改动）；
    ② **修改声明**（Kotlin→ArkTS、Compose→ArkUI、Android→HarmonyOS，起始 2026-10，
    差异逐条见本文件）；③ **上游 NOTICE 原样保留**；④ **明确说明本移植版未引入上游那两项第三方资源**
    —— DeepSeek logo 图形（本工程的 `BrandMark` 是纯文字字形「DSH」，全工程只有两个自绘占位图标）
    与 multiplatform-markdown-renderer（本工程用自研 `MarkdownLite` 做块级切分，未用任何第三方
    Markdown 库）—— 因此**不附带 `THIRD_PARTY_LICENSES/` 目录**，并写明「后续若引入第三方资源必须补齐」。
    另注一句：`test/package.json` 里的 `tsx` / `typescript` 只用于构建机离线单测，不进 HAP。
  - **为什么 NOTICE 要写「不适用」而不是照抄上游那一节**：照抄会**声明本工程打包了它其实没有的东西**，
    既误导用户也削弱归属声明的可信度。正确做法是保留上游署名（AGPL 要求保留通告）、
    同时**说清本工程的实际组成**。这条判据与 config/插件页那批「不许沉默」是同一条。
- [x] **收尾三·跨分节导航 + 三处「不重绘/不刷新」缺陷（本轮落地）**。这一轮发现的都是
  **只有在真机上才会显形**的问题，但根因都能静态证实，因此当场修掉并写进 §1b 坑 12：
  - **缺口 3「打开目录」补上**（原先错接在 `openSessionFile` 上，点目录不会切分节）：
    - `SessionFilesSheet.onOpenDirectory` 的签名从 `(path: string)` 改成
      **`(rootId: string, path: string)`** —— 交出**已经解析好的**授权根与相对路径，而不是原始绝对路径。
      理由：面板里已经有 `open.resolved`（就是 `roots/resolve` 的产物），让上层拿绝对路径再解析一遍
      是白跑一次网络请求，且两处结果可能不一致（目录被移动过）。
      配套加了三个**返回非空值**的方法 `resolvedRoot()` / `resolvedPath()` / `isDirectory()`
      （避免在 `@Builder` 里对可空值做两次调用的窄化 —— 那正是 §1b 坑 8）。
    - 新增 `HarnessViewModel.revealDirectory(rootId, path)`：写 `selectedRootId` / `currentPath`
      **并且真的调用 `loadDirectory`**。两件事缺一不可 —— `roots/resolve` 只回答「这是个目录」，
      不给目录内容；只改路径不读列表，用户切过去看到的是上一目录的旧列表，比不切还糟。
    - 新增 `AppRuntime.requestFilesSection()`：在 `AppStorage` 里写一个**递增序号**
      （键 `dshFilesRevealSeq`）。用序号而非路径，是因为路径已经在 vm 的 state 上，
      再传一份就有两份真相；而且**同一目录连点两次**也要能触发（比路径的话第二次会被当成没变化）。
    - `AppShell` 新增 `@StorageLink('dshFilesRevealSeq') @Watch('onFilesRevealRequested')`：
      收到即切到 `MainSection.Files` 并收起抽屉。这是**子页请求父页改状态**在本工程里的走法
      （子页拿不到外壳的局部 `@State`，又没有路由参数）。
    - `ChatDetail` 的接线：**先 `requestFilesSection()` 再 `revealDirectory()`** —— 顺序反过来，
      外壳切过去时列表还没读回来，用户看到的是「点了目录却停在原地」。面板同时 `sheetOpen = false`。
    - 新增 3 个单测（空参数早退且**不产生 state.error**、正常路径写入并真的读到列表且路径归一化、
      读失败落成 `state.error` 而不向调用方抛）—— core 这一半可离线测，分节切换那一半只能真机验。
  - **缺陷 A（§1b 坑 12 的引子）**：`FileBrowser` 是**唯一**读了 vm 状态却**没有** `@StorageLink` 的结构
    （它由 `FilesScreen` 用四个回调构造，没有数据型入参，父组件重建时 ArkUI 不会连带重绘它）。
    少了订阅，点目录/点「上一级」/切授权根都只改 vm 状态而**列表一动不动**，界面看起来像点击失灵。
  - **缺陷 B（同一个坑，范围更大）**：补上 `@StorageLink` 后再扫一遍，发现 **14 个结构里有 7 个
    声明了 `@StorageLink('dshRevision')` 却从头到尾没读过它**（`AppShell` / `ChatScreen` / `ChatDetail` /
    `ChatScreen` 的 `FileBrowser`+`EditorPane`+`FilesScreen` / `ModelsScreen` / `PluginsScreen`）。
    只声明不读 = 依赖没登记 = 那些页面**收不到任何 vm 更新**（会话列表不动、插件页永远停在首次加载）。
    修法：**把「读一次 revision」放进每个结构的 `st()`**。为什么放这里而不是各 `build()` 里加一行 ——
    所有渲染路径取 vm 状态都经 `st()`（包括 `doc()` 这类间接 getter），因此
    「读 vm 状态」与「读 revision」被绑成了同一件事：只要一个组件在渲染时真的读了 vm 状态，
    它就一定登记了依赖；反之它也没东西可重绘。
  - **缺陷 C（顺手发现的真实偏差）**：`AppShell.syncSectionFromScopes()` 只在 `aboutToAppear` 调了一次，
    而它的注释与源工程 `remember(scopes)` 都写的是「**scopes 变化时重算**」——
    冷启动时 `device` 还是 null，等拿到设备信息时**不会**自动切到会话页，用户会莫名停在设置页。
    修法：新增 `@StorageLink('dshRevision') @Watch('onVmChanged')`（同一个装饰器同时干报错与重算两件事），
    并加 `syncSectionIfScopesChanged()`：**只在 scopes 的值真的变了才重算**（拼快照串比较）。
    若每次 revision 变化都重算，用户手动切到设置页后任何一次无关后台刷新都会把他弹回会话页。
- [x] **收尾四·`@` 文件补全与 `/` 命令补全两个面板（本轮落地，此前是唯一剩下的 UI 缺口）**。
  源工程 `ui/ChatScreen.kt` 的 `MentionSuggestions`（2139–2255）与 `commandSuggestions`
  + `CommandSuggestions`（2264–2326）。这一轮的**判据全在 core、UI 只负责画**：
  - **新增 `core/ComposerSuggestions.ts`**（30 个 core 模块里的新一只）。三个导出：
    `mentionMatches`（名字包含、大小写不敏感、**目录优先**、最多 50 条）、
    `commandSuggestions`（**整行以斜杠开头且斜杠后无空白**、前缀匹配、最多 5 条）、
    `composerOverlayActive`（上面两条的"或"，供外层手势判据用）。
    **关键取舍**：过滤跑在完整 `entries` 上、**先排序后截断** —— 先截断的话 60 个文件会把
    唯一那个目录挤出候选，用户就永远没法「`@` 文件夹再往里选」。
    `removePrefix("/")` 只去**一个**斜杠，所以 `//x` 的查询串是 `/x`（Kotlin 语义，不是 `replace`）。
  - **新增 `ui/ComposerSuggestions.ets`**：两块 `@Component`（`MentionSuggestions` /
    `CommandSuggestions`）。三处照抄源工程：① 候选 `List` **必须可滚动**（不可滚时手势会传到
    外层抽屉，这正是源工程加"面板开着就关抽屉手势"那道保险的起因）；② 列表上限 264vp
    （面板贴在输入框上方，铺满整屏会把对话顶没）；③ 命令描述的顺序是
    「本地化文案 → 服务端描述 → `参数：xxx`」，认不出的命令名原样退回服务端描述。
    **`@` 插入的是绝对路径**（`absolute(cwdAbsolute, cwd, entry.path)`），目录补 `/` **不加空格**
    （还要继续往里选），文件补一个空格把这个词结束掉。
  - **接线在 `ChatDetail.ets`**：`@State @Watch('onMessageChanged') message` 承担源工程
    `LaunchedEffect(composerOverlayActive)` 的角色（值变了就 `vm.setComposerOverlay(...)`）；
    面板渲染在输入药丸**上方**的同一个 `Column` 里，`@` 提及活跃则画提及面板、否则画命令面板
    （**两者互斥**，万一将来判据放宽则**斜杠优先**，避免两个列表叠在一起）。
    选中回填：`@` 走 `MentionQuery.applySelection`（**只替换提及词那一段** —— 用户很可能已经写了
    半句「帮我看看 @xxx」，整行替换会把前半句吃掉）；`/` 走整行替换（面板本来只在整行是命令时出现）。
    `aboutToDisappear` 里清一次 `setComposerOverlay(false)`：面板随页面消失，但状态留在 vm 上会
    让外层抽屉手势一直失效（用户只会觉得「抽屉划不开」，比误触更难发现）。
  - **新增 21 条单测**（`test/cases/composer-suggestions.test.ts`）：重点全在"什么时候**不**列"上 ——
    `entries === null` ≠ 空目录、不按路径只按名字过滤、大小写不敏感、目录优先且截断不会挤掉目录、
    `//x` 只去一个斜杠、斜杠后空白（含全角 `\u3000`）即收起、有前缀但无匹配时不算"面板开着"。
  - **资源键 12 个**（base 与 en_US 同序追加）：`available_commands` / `workspace_files` 系列 4 键
    / `command_*_description` 6 键（compact/export/feedback/goal/permission/plan）/ `command_input_hint`。
    这次**没有用编辑器逐字改**，而是先写脚本（`JSON.parse` 读 → 追加 → 重新序列化）——
    见下方「收尾四的一点补充」。
  - 同步更新：`ChatDetail.ets` 文件头差异表新增**第 6 条** —— 源工程「面板开着 → 关闭抽屉手势」
    这半截在本工程**没有对应 API**（`SideBarContainer` 没有等价的"禁用手势"属性），
    `setComposerOverlay` 记下的状态只作记录；挡误触靠面板内部的可滚动 `List`。
  - **收尾四的一点补充（资源文件又一次被外部改动，这次的修法升级了）**：本轮跑完
    JSON.parse + 重名检测之后，`en_US/element/string.json` 尾部**再次**出现字符级损坏
    （与「收尾一」同一个现象：随机字符被吞、从某行起无法 `JSON.parse`），
    base 一侧则被**还原成了改动前的样子**。这次没有手工抢救，改为**脚本法**：
    ① base 侧仍能完整 `JSON.parse` → 直接解析 → 追加缺键 → 用 `JSON.stringify` 整体重写；
    ② en_US 侧从**最后一个完好键块的结尾**截断（找 `"value": "Zoom text out"` 那个块的 `}`），
       把这段合法前缀补上收尾括号后 `JSON.parse`，再追加同一批键；
    ③ 写完立刻二次校验（键数 358 = 358、键集与顺序完全一致、新键均在位）。
    **判据不变，只是手段更硬**：`string.json` 一旦出现字符级损坏，`JSON.parse` 一定在第一个畸形处中断，
    **但损坏点之前通常完好** —— 先抢救骨架、再补缺，**不要整份重写**。
    ①③ 两步必须连跑（写完立刻校验），否则下一次外部改动进来又无从判断是"我改坏了"还是"它又坏了"。
- [x] **本轮明确未移植（都是"看得见"的缺口，不许沉默）**，见下方「已知缺口」小节
  —— 五条现已逐条落实（1 补全面板 / 2 二次确认 / 3 打开目录 / 4 三个平台文件待真机 / 5 webChat 开关照留 + 显式说明）。
- [x] 签名占位（`build-profile.json5` 注释模板）+ 打包脚本（`scripts/package.sh`）
  + AGPL-3.0 LICENSE / NOTICE —— 见上方「收尾二」。
- [x] 移植文档收尾：本文件 §7 已按轮次记录完毕；`README.md` 与 `docs/CHANGELOG.md` 已写（见「收尾六」）
- [ ] 测试：`src/test/` 25 个类 / 273 用例（优先 HostStoreTest、ConnectionShareTest、ConnectionCoordinatorTest、DshClientTest）
  - 已移植：`endpoint-url.test.ts`、`connection-models.test.ts`、`host-store.test.ts`、`connection-share.test.ts`
    （35 用例）→ `models` / `dsh-client` / `chat-content-parts` / `connection-coordinator`（136 用例）
    → `text-predicates` / `error-messages` / `composer-send-policy` / `mention-query` /
    `chat-link-target`（73 用例）→ `connection-storage` / `app-preferences`（21 用例）
    → `chat-presentation` 26 用例、`tool-call-detail` 18 用例
    → `preview-kind` 14 用例、`html-preview` 16 用例、`session-file-refs` 14 用例、`gen-ui-blocks` 23 用例
    → `harness-view-model` **86 用例**（四个纯函数、`HarnessState` 默认值、假 deps 下跑通配对/连接/
    发送双击/历史/审批/问答两道闸/偏好落盘恢复/断开保留主机，以及 `toastText` 26 个 key 的英文列完整性）
    → **`network-failure-mapping` 11 用例**（NetStack 错误码逐码归类、认不出就 OTHER、
    四张表两两不相交且都在 2300xxx 域内）
    → `markdown-lite` 15 用例 → `composer-suggestions` 21 用例（补全面板）
    → `markdown-lite` 补表格/分隔线解析与列宽共 19 条（坑 22、23）
    → **现已 29 个测试文件 531 用例，全绿**（另含 `revealDirectory` +3）。
  - **本轮顺手修掉一个测试基建缺陷**：`instanceof` 跨模块全假（六个用例挂掉），根因与修法见 §1b 第四个坑。
    这类问题会**伪装成业务逻辑 bug**（看起来像「错误分类没实现」），实际是模块被判成两份。
  - 「英文列完整性」这类**沉默回归**要主动测：逐码断言 `localizedErrorText(code,'en') !== (code,'zh')`，
    否则英文漏一条会静默回退中文，肉眼根本看不出来。

### 已知缺口（原「本轮明确未移植」，现已逐条落实 —— 见各条标注；用户要求「不许沉默」）

1. **`MentionSuggestions`（`@` 文件补全）与 `CommandSuggestions`（`/` 命令补全）两个补全面板**
   —— **已补齐**（见 §7「收尾四」）：判据在 `core/ComposerSuggestions.ts`（21 条单测），
   面板在 `ui/ComposerSuggestions.ets`，接线在 `ChatDetail.ets`。
   剩下只能真机验的部分：面板里 `List` 滚动能否真的吃掉手势（不传到外层抽屉）、
   `absolute(cwdAbsolute, cwd, path)` 拼出的路径在真机上是不是服务端认的绝对路径。
2. **`PendingApproval.risk == "full-access"` 时点「允许一次」的二次确认** —— **已实现**，
   从 `AlertDialog` 换成了底部面板（见 `ui/ChatDetail.ets` 文件头差异 2），勾选闸门与文案照抄。
3. **「打开目录」入口** —— **已补上**（见 §7「收尾三」）：`onOpenDirectory` 交出已解析好的
   `(rootId, path)`，`HarnessViewModel.revealDirectory` 读好目录，`AppRuntime.requestFilesSection()`
   往 `AppStorage` 发一个递增序号，`AppShell` 用 `@StorageLink + @Watch` 收到后切到文件分节。
   剩下只能真机验的部分：分节切换 + `bindSheet` 同时关闭时的动画是否打架。
4. **`Pickers.ets` / `ImageCodec.ets` / `ExternalOpen.ets` 三个平台文件已编入、但未在真机跑过** ——
   它们依赖系统选择器与解码器，只能等真机验证（见「待真机验证」）。
5. **设置页的 `useWebChat` 开关在本移植版里不影响界面** —— **UI 已落地**（`ui/SettingsScreen.ets`），
   但本工程的聊天页是 ArkUI 原生实现、没有内置网页版，所以拨它看不出变化。
   处理方式：**开关照留 + 页面上一句显式说明**（`web_chat_footnote_port`），
   而不是把开关藏起来让用户以为「电脑端有这个设置、手机上没有」。
   `showContext` / `genUiDebug` 两个开关则**真的生效**（分别被详情页与 `ChatMessageView` 读用）。

### 待真机验证（累积，无设备时不许说成「跑通了」）

构建通过 ≠ 真机可用。下面每一条都只能等设备：

1. **`PATCH` 端点是否真发得出去**（见 §6.1 第 1 条：SDK 枚举缺 PATCH，靠字符串转型绕过）。
2. **剪贴板降级后的两件事**（原「`READ_PASTEBOARD` 授权弹窗」**已作废** —— 该权限是受限权限、
   声明了连包都装不上，已删除并降级，见下方「收尾五」）：
   ① 连接页那个「粘贴」按钮读到空串时是否真的弹出提示（而不是点了没反应）；
   ② 长按输入框能否走系统粘贴把 `DSH1:` 配置贴进来（系统粘贴不经过应用权限）。
3. **`SideBarContainer` 抽屉手势**（窄屏拉出会话列表）。
4. **系统选择器**：`photoAccessHelper.PhotoViewPicker` 与 `picker.DocumentViewPicker` 的返回值形态、
   临时 URI 能否被 `fs.openSync` 直接打开（`Pickers.ets` 的整条读盘路径）。
5. **图片解码**：`image.createImageSource` 能否吃下选择器给的各种格式，以及长边 1024 的实际内存表现
   （`ImageCodec.ets`）。
6. **`startAbility` 打开外链**（`ExternalOpen.ets`）。
7. **双击复制**与文本选择长按会不会互相打架（`ChatMessage.ets` 文件头差异 3 的实测）。
8. **自动跟随滚动**在真机上是否真的贴底（ArkUI 的 `onScrollIndex` 报的 `end` 与
   `listItemCount()` 的算值是否一致 —— 这是自算条目数方案的唯一验证点）。
9. **文件页行号编辑器**（`NumberedTextEditor`）：① 行号栏与 `TextArea` 的 `lineHeight`
   在真机上是否真的逐行对齐（缩放档位 0.75–2.5 之间各试一档）；② 超过
   `LONGEST_LINE_CHAR_CAP = 400` 的超长单行折行时，错位有多严重、是否可接受。
10. **双指缩放**（`PinchGesture` 的 `event.scale` 确实是"从手势开始算的累计值"这一假设）
    与 **`TextOverflow.MARQUEE` 跑马灯**（是否真的只在溢出时才滚）。
11. **下载的保存面板**（`Pickers.saveBytes` → `documentPicker.save`）：返回的 URI 能否
    `fs.openSync(READ_WRITE|CREATE)` 直接打开并写入；用户取消时返回的形态是不是空数组。
12. **模型的 `bindSheet` 面板高度**（`SheetSize.LARGE`）：十来个输入框 + 键盘顶起来之后，
    底部那个「保存供应商」按钮会不会被键盘盖住（源工程是自己算的屏高比例，ArkUI 只有三档）。
13. **协议选择的 `bindMenu`** 在面板（`bindSheet`）里能不能正常弹出 —— 菜单挂在一个
    Sheet 内部的组件上，是「浮层套浮层」的场景，只能真机看。
14. **设置页的发送方式 / 语言药丸**：`Toggle` 与药丸按钮在系统深色模式下的对比度
    （用的是 `foreground_contrary` 白字压在 `emphasize` 上）。
15. **§1b 坑 12 的修复是否真的生效**（本轮动手的最重要一条）：会话页/详情页/插件页/模型页
    在 vm 更新后是否真的重绘 —— 具体看「后台刷新时抽屉里的设备名与在线状态会不会跟着变」
    与「插件页从加载中切到清单」这两处。这是纯运行时行为，静态检查只能证明"读到了"，
    证明不了框架确实按预期登记了依赖。
16. **跨分节导航**（会话附件面板点「打开目录」）：能否切到文件分节并**已定位到该目录**
    （而不是停在旧目录），以及切页动画与 Sheet 关闭是否打架。
17. **冷启动自动重连后自动切到会话页**（缺陷 C 的修复）：连上后拿到 `scopes` 时是否真的从
    设置页切到会话页，而不是要用户手动点。
18. **`@` 补全面板的三件事**：① 面板里的 `List` 滚动/点击是否真的消费掉手势（源工程加"面板开着
    就关抽屉手势"那道保险，在本工程没有等价 API，只能靠这个 `List` 挡）；② `entries` 是否在
    打开面板时真的被读回来（`mentionEntries` 三态：null+未失败 = 还在读、null+失败 = 读不到、
    空数组 = 空目录 —— 真机上要看这三种文案是否各自出现）；③ 选中后插入的**绝对路径**是否
    被服务端认（尤其老服务端不给 `cwdAbsolute` 时的降级路径）。
19. **`/` 命令面板**：① 命令清单是否真的来自服务端（`state.commands`）、描述三段的回退顺序在真机上
    对不对；② 打完参数（斜杠后有空白）面板是否立刻收起、且**收起后不再吃抽屉手势**。
20. **输入药丸上方的面板布局**：面板贴在输入框上方时，`List` 的 264vp 上限与软键盘顶起的位置
    会不会互相打架（键盘弹出后输入框上移，面板是否跟着上移而不是被挡住）。
21. **会话配置面板的模型清单**（坑 14 修复的复测）：打开面板后所有 provider 标题与模型行是否
    **依次向下排**（dump 里各自 `origBounds` 互不相同），而不是继续叠在同一处；`List` 能否滚到
    最后一个 provider。**需要应用先连上 harness**（面板要有 `selectedSession` + `sessionModels`
    才有内容 —— 装包重启后连接态不持久，设备侧「已保存的电脑」为空时会停在连接页）。
22. **系统导航条随主题**（本轮新增）：把系统切到深色模式后，导航条是否为**黑底白图标**且与页面背景一致；
    切回浅色是否恢复白底黑图标 —— 这条专门验证 `onConfigurationUpdate` 里那次重调真的生效
    （浅色路径已实测无回归，见「收尾五」→ 系统导航条随主题设色）。
23. **主机持久化**（坑 15 修复的复测）：重新配对 → 确认「已保存的电脑」出现该主机 →
    **进一次设置页**（旧行为就是在这里清空的）→ 回连接页主机仍在 → 杀进程重开（或
    `hdc install -r` 重装）→ 主机仍在并自动走冷启动重连。全程不丢 = 修复成立。
24. **表格列宽不折断英文单词**（坑 23 修复的复测）：打开含英文标识符的 Markdown 表格
    （如 `bundleName`），确认该词**整词折行**、不被断成 `bundleNam` / `e`；同时确认长表格
    横向滚动仍可用、列宽未溢出屏幕。
    ✅ **已验（2026-10-16，用户真机确认「正确」）**：release 构建 + 调试证书签名包装机后，
    表格内英文标识符整词折行，词内断行缺陷消失。
25. **`/` 命令面板能出得来**（坑 24 修复的复测，用户报告的 bug）：连上 harness 后，在会话页
    输入框只打一个 `/`，面板是否**立刻列出服务端命令**（`state.commands`）；再补打前缀（如
    `/doc`）确认候选被过滤；打完参数（斜杠后有空白）确认面板**立刻收起**。这是**首要复测项**
    —— 修复前该面板**从不出现**，`@` 面板却正常，正是「实例先于数据存在 + 普通成员不回写」的
    典型症状。按键口诀（坑 21 / 坑 24）：**实例先于数据存在的入参，一律 `@Prop`。**
    ✅ **已验（2026-10-16，用户真机确认「是」）**：输入 `/` 能带出 dsh 命令（`state.commands`），
    面板出现正常 —— 坑 24 的修法在真机成立。
26. **分层图标在真机桌面上渲染正常**（坑 25 修复的复测）：装 1.0.1 后回桌面，图标应为**圆角方形**、
    图形居中清晰、**无裁切 / 无硬直角 / 无白边**；若看到硬直的方形四角，说明分层未生效（系统没做遮罩）。
    ✅ **已验（2026-10-16）**：装 1.0.1（`versionCode` 1000001）后 `snapshot_display` 截屏核对，
    桌面图标为圆角方形、图形居中清晰、无裁切无硬直角；`bm dump` 中 `iconPath` 已解析为
    `$media:app_layered_image`、`iconId` 已分配。

27. **改名后应用信息一致**（坑 26 的复测）：装 1.0.2 后确认 —— `bm dump -n com.dsh.westanke`
    能查到应用、`versionCode` 1000002；桌面图标下的应用名、应用内标题、连接页标题三处口径一致
    （「DSH 伴侣」/「连接服务端」），且**全应用无第三方品牌字样**。
    ✅ **已验（2026-10-16）**：`bm dump` 实测 `bundleName` = `com.dsh.westanke`、`versionCode` 1000002；
    界面树 dump 核对标题「DSH 伴侣」、连接页「连接服务端」；资源 / 配置 / 源码中 `grep -i deepseek`
    已无品牌残留（会话标题等**服务端返回的数据**不在此列）。
28. **AI 生成内容显式标识真机可见**（本轮新增）：助手消息底部是否固定出现「内容由 AI 生成」；
    用户自己发的消息**不应**出现该标识。
    ✅ **已验（2026-10-16）**：真机截屏 `docs/screenshots/ai-generated-label-evidence.png`
    确认助手消息底部渲染该行、用户消息未出现。
29. **设置页药丸选中态即时刷新**（坑 27 修复的复测）：点「中文/English」与「排队发送/插话发送」，
    选中高亮与下方描述文案应**当场**跟着变，不许等到离开页面再回来才正确。
    ✅ **已验（2026-10-16）**：真机实测 —— 修复后点「排队发送」当场重绘（前后截帧 MD5 不同、
    描述文案同步切到排队语义）；修复前同一操作**前后截帧 MD5 完全相同**（画面零变化），
    而离开设置页再回来时状态却是对的 —— 正是「状态已变、界面不重绘」。

### 收尾五：真机接入与首次装包（2026-10-15）

设备：ICL-AL10 / OpenHarmony-7.0.0.105 / API 26 / UDID `EC96…68DB7`。
`compatibleSdkVersion 5.1.0(18)` 作为最低兼容版本，装在 API 26 上是预期可行的（已实测通过）。

**已达成**：签名 HAP 装进真机并启动 —— `hdc install` 返回 `install bundle successfully`，
`aa dump -a` 里 `com.Deepseek_Harness_client.westanke:entry:EntryAbility` 为 `state #FOREGROUND`，
中文界面正常渲染。**但上表 20 条一条都没验完**：装包成功 ≠ 功能可用。

四个坑（不记下来下次必然重踩）：

1. **Linux 侧：hdc 认不到设备 = USB 节点权限，不是手机的问题**。
   手机进调试模式后 PID `12d1:5000`、`product=HDC Device`、接口类别 255（Vendor Specific），
   但节点 `/dev/bus/usb/003/0xx` 是 `root root 0664` —— 当前用户**只有读权限**，
   而通信要**写权限**（`openSync(path,'r+')` 直接 `EACCES`），于是 `hdc list targets` 恒为 `[Empty]`。
   旧模式的节点（`12d1:1101`）带 `plugdev` + ACL，所以此前"看着像通的"。
   处置：临时 `sudo chmod 666 /dev/bus/usb/003/0xx`；持久写 udev 规则
   `SUBSYSTEM=="usb", ATTR{idVendor}=="12d1", ATTR{idProduct}=="5000", MODE="0666"`
   —— **按 vendor/product 匹配，不要按节点号**（重插线节点号会变）。
2. **手机侧的两步 + 一个反直觉点**：① 开发者选项里打开「USB 调试」；
   ② **解锁屏幕**才看得到「是否允许 USB 调试」弹窗（不点就一直是 `Unauthorized`）。
   反直觉点：**锁屏状态下 `aa start` 起不来**（会打印一串与真实原因无关的提示，
   其中还有"检查是否处于开发者模式"，**别被它带偏**）；解锁后同一条命令立刻成功。
3. **签名：hvigor 拒收明文口令，只能手工签**。
   `signingConfigs` 里填明文 → `00303116 Configuration Error: The length of the
   storePassword or keyPassword field ... is less than 32`（它要的是 DevEco Studio 写入的
   **加密串**；本机只装命令行工具、没装 DevEco，生成不了）。
   因此 `signingConfigs` **保持空数组**（`hvigorw assembleHap` 仍出未签名 HAP、WARN 照旧、
   双闸门基线不受影响），签名改用 SDK 自带的 `hap-sign-tool.jar`（吃明文，官方 CI 路子）：
   `sign-app -mode localSign -signAlg SHA256withECDSA -profileSigned 1 -signCode 1
    -compatibleVersion 18 -appCertFile <证书链> -profileFile <p7b> -inFile <未签名 hap> …`
   → `entry-default-signed.hap` → `hdc install -r`。
   **`-compatibleVersion` 必填**（输入为 hap 时），取 `compatibleSdkVersion` 的 18。
4. **`bundleName` 必须与调试 Profile 一致**：Profile 是 AGC 签过的 PKCS#7，**改不了**。
   本工程因此把 `AppScope/app.json5` 的 `bundleName` 对齐成 AGC 侧那个
   `com.Deepseek_Harness_client.westanke`（**不是**上游 Android 的
   `io.github.hakunm.deepseekharness`）。不一致时签名阶段即报错，装不上。

**待真机验证第 2 条：权限侧的结论提前拿到了**。`ohos.permission.READ_PASTEBOARD` 是
**受限权限**（system_basic 级、需 ACL 加白）：普通应用声明它 **连包都装不上**，实测
`9568329 install failed due to grant request permissions failed`。
所以「一键读剪贴板」对普通应用这条路不存在。按「降级 + 不许沉默」处置：删掉该权限声明、
`platform/Clipboard.ets` 改为读不到就返回空串、连接页「粘贴」按钮**在空串时弹提示**
（`clipboard_empty` 文案改为「读不到剪贴板内容，可长按输入框用系统粘贴」）；写（复制）不受影响。
`reason_clipboard` 资源键保留在原地（记录"申请过、因受限被拒"这件事，将来若拿到 ACL 批准可恢复）。

**`en_US/string.json` 第三次字符级损坏 —— 这次是新形态**：不是尾部截断，而是
**两份版本在字符级交叠**（`"namee" :c "caommand_ctompact_pdescription"` /
`"vaalue": "Compact older conversatgion history"e"` 这种），并在中间插进一对提前闭合的 `]`/`}`。
损坏只在尾部（约 14 行、9 个区段、5 个键：`command_compact_description` / `_export_` /
`_feedback_` / `_goal_` / `command_input_hint`）。
**新手法（比「收尾一」的抢救法更硬）**：值**不从残缺文本里猜**，而是从**上一次成功构建留下的
编译产物**里取一手原文 —— `entry/build/default/intermediates/res/default/resources.index`
（`strings -n 3 resources.index | grep -B1 -x <键名>`：索引里"值在前、名在后"的相邻对就是该键的原文），
键序则以 `base/element/string.json` 为准（两文件键序一致是既有约定）。修复方式是**定点替换那一段、
不整份重写**，改完立刻 `JSON.parse` + 键数 358 + 键序逐项比对 base。
**推论：`entry/build/**/resources.index` 要当成"资源的手写副本"珍惜** —— 它是 `string.json`
被写坏之后唯一还能读出一手英文原文的地方；**不要随手 clean**。同样适用于其他被外部反复改动的资源。

**坑 13：底部那半条"输入框消失"——根因是布局，不是避让区（2026-10-15 用户报告 + 真机实测定位）**

现象：会话页看不到输入框与发送键；改过一轮后输入框出来了，但 `＋`/`➤` 仍不可见，底部还有白色手势条浮在上层。

`uitest dumpLayout` 实测（屏高 2440px、密度 3.12，所以 1vp = 3.12px）：
- `ChatScreen` 根 Column 的 **`origBounds` 高 2232px = 父级整高（2231px）**，而它被排在 56vp 顶栏**之后**
  → 整体下移 174px、末 87px 溢出父容器，可见部分正好落进底部系统手势区。
- 于是输入药丸被压在 `y2349..2440`：输入框只剩 22vp（自身声明 44vp 都保不住），
  `＋`/`➤` 声明 `34×34vp` 实测只有 106×**39**px（≈12.5vp 高）。
- 修法：`ChatScreen` 根 Column 的 `.height('100%')` → **`.layoutWeight(1)`**。
- 修后实测：输入框 `[158,2195][921,2333]` = **44vp** ✓；`＋` `[40,2226][146,2332]` = **34×34vp** ✓；
  `➤` `[933,2226][1040,2332]` ✓；且**不再有任何应用节点触到 2440**（触底的只剩窗口根 `[root][0,122][1080,2440]`）。
  截屏确认三件套可见、输入框占位文案正常。

**规则（新增，写 UI 时照这个来）**：`Column` 里**排在兄弟节点之后**的子节点用 `layoutWeight(1)`，
**不要写 `height('100%')`** —— 后者取的是**父级整高**，会因为前面的兄弟（顶栏/标题）而整体溢出。
`ChatDetail` 根布局写 `height('100%')` 是**对的**，因为它的父级已由 `layoutWeight(1)` 定死了高度。

**顺带两条教训**：
1. 我先加的 `bottomInset`（`aboutToAppear` 里读 `getWindowAvoidArea(TYPE_NAVIGATION_INDICATOR)`、
   读不到退回 30vp）是**症状补丁，根因修好后整段撤回** —— 页面根本来就留了那 87px，
   再叠一层只会多出一段空隙。**避让区读到 0 时，先怀疑"是不是有东西溢出了"，不要自己补 padding。**
2. 那条"白色手势条"是**系统导航条本身**（应用内容已不再压进去 = 已修好）。用户随后要求
   「按主题设它的颜色」——**已在 `EntryAbility` 落地**，见下方「系统导航条随主题设色」。
3. 定位手法可复用：`dumpLayout` 的 JSON 里 **`bounds` 是被窗口裁过的、`origBounds` 才是布局真值**
   —— 判断"是否溢出父容器"要看 `origBounds`（本例 `[0,296][1080,2528]` vs 父级底边 2353）。

**坑 14：会话配置面板里"模型挤成一堆"——`ListItem` 是单子节点容器（2026-10-15 用户报告 + 真机实测定位）**

现象（用户原话）：会话页选模型，结果模型挤到一堆了。

`uitest dumpLayout` 实测（同一手法：只认 `origBounds`）：
- 模型块那个 `ListItem` 整块只有 395px 高（`[124,1098][956,1493]`）；
- 它内部**每一个** provider 标题的 `origBounds` 都是 `[124,1284][956,1332]`，
  **每一条**模型行的 `origBounds` 都是 `[161,1268][919,1323]` —— 二十多条完全重合。
- 对照同一面板里的 `agentBlock()`：四行 Agent 预设的 y 坐标是 526 / 647 / 760 / 873，
  各不相同 = 正常。

根因：`ModelSheet.ets` 的 `modelBlock()` 在 `else` 分支里把 `ForEach` **裸放**进了 `ListItem`。
`ListItem` 是**单子节点**容器 —— 给它挂多个子节点时它们会被**层叠到同一位置**，不是依次向下排。

修法：给 `modelBlock()` 的 `else` 分支外层包 `Column(){…}.width('100%').alignItems(HorizontalAlign.Start)`
（**只在这一处**；已全量排查 `ui/` 下所有 `ListItem() { … }`，其余都是单子节点）。

**规则（新增）**：`@Builder` 里凡是会产出**多个**子节点的（`ForEach`、并列的 `if/else` 展开、
连续多个组件），被 `ListItem` 之类单子节点容器调用时，**必须自己先包一层 `Column`**。
判据同样用 dump：**多个节点的 `origBounds` 完全重合 = 被层叠了**。

**坑 15：「已保存的电脑」为空、连接不持久 —— 设置页自检把主机库清空了（2026-10-15 用户报告）**

现象（用户原话）：设备端"已保存的电脑"为空 —— 未持久化保存。

根因不在存储层（`PrefsStore` / `HostStore` / `Crypto.ets` 的链路都是通的），而在
**`platformSelfCheckText()` 自己**：它的第 3 步「主机库往返」直接对**真实的**
`dsh_connection` 偏好调了 `hostStore.saveHosts([])`，把用户配对成功写入的 `hosts_v1`
**整个覆盖成空列表**。而这个自检在**设置页 `aboutToAppear` 就跑一次** ——
于是时间线是：配对成功 → 某次进了设置页（看自检结论/改设置）→ 主机列表被清成空 →
重启后 `restoreConnection()` 读到空 → 停在连接页、「已保存的电脑」为空。
存储层无辜，凶手是冒烟测试本身。

修法：自检第 3 步改用**独立的偏好文件 `dsh_selfcheck`**（存储与密钥都在这个文件里，
跑完 `clear()`），从此与 `dsh_connection` / `dsh_keys` / 真实 `hosts_v1` 完全隔离；
顺带删掉了自检里 `createHarnessDeps(context)` 的整套装配（那会白建一遍 HTTP/WS 实例）。

**规则（新增，两条）**：
1. **任何自检/演示/示例代码不得碰真实数据文件** —— 要写盘就开独立文件，跑完清掉。
   「只写一次、马上读回来」不是免责理由，写的那个键可能正是用户的全部数据。
2. `aboutToAppear` 里跑的任何东西都等于「每次进这个页面都会执行」——
   把它当生产路径看，不要当调试脚手架看。

**代价说明**：被覆盖掉的旧主机数据无法恢复（`saveHosts([])` 是原地覆盖，
损坏隔离那份 `hosts_v1_corrupt` 只在"读失败"时才写，覆盖不属于读失败）——
需要重新配对一次。

**坑 16：「已保存的电脑」读不出来的真凶 —— GCM 解密没传 authTag，initSync 直接 401（2026-10-15）**

坑 15 修完自检清库后用户仍报「还是没有已保存的电脑」。这次不猜，直接读沙箱取证 +
写临时诊断（`logConnectionDiagnosis`，只打长度/布尔不打明文）随包跑：

```
diag: prefs len=1156      ← 偏好读取正常，密文一直在
diag: b64 ok len=867      ← Base64 解码正常
diag: decrypt FAIL code=401 msg=failed to cipher init.
```

`401` 发生在 **initSync（cipher init）阶段**，还没碰到数据 —— 而 GCM 解密参数里的
`authTag` 传的是空。结论：`Crypto.ets` 的 `decrypt()` 原注释「cryptoFramework 从密文尾部
切 tag」是**想当然的错误假设** —— 鸿蒙 cryptoFramework 的 GCM **解密方向必须把 authTag
显式传入 `GcmParamsSpec`**（从密文尾部切 16 字节传入，doFinal 只吃密文本体），
传空在 init 就报 401。

时间线全部对上：配对时**加密**方向空 tag 是对的（tag 由 doFinal 生成输出），所以写入成功、
当下能连；之后任何一次**读盘恢复**（重启/重装后的 restoreConnection）解密必炸 →
走容错返回空列表 → 「已保存的电脑为空」。**解密从来没在真机上成功过**，
自检的 `aesgcm:ok` 也没真正验证过解密方向。

修法：`decrypt()` 显式切 tag；`makeGcmSpec(iv, aad, tag)` 三参化（加密传空、解密传实 tag）。
修完同一份沙箱密文诊断全绿（`decrypt ok plainLen=815 → parse ok → host[0] ok eps=2`），
**被"清空"的旧主机 wangke-PC 直接复活** —— 密文一直都在，只是解不开。

规则：对平台 API「文档没写的便利假设」一律先做最小实验再写进注释；本条与坑 15 是
**两颗独立的雷**（自检清库 + 解密必炸），症状相同、根因不同。

**坑 17：NetStack 的 `webSocket.connect` 只认 ws:// —— 喂 http:// 直接 `ParseUrl failed`（2026-10-15）**

真机日志：NETSTACK 反复 `websocket ParseUrl failed`。`WebSocketTransport.ets` 早先注释声称
「NetStack 接收 http(s) URL 并自行完成协议升级，本层绝不做 ws:// 改写」—— 又一个想当然。
实际 NetStack 只认 `ws://` / `wss://` scheme。修法：本层加 `toWsUrl()`（http→ws、https→wss），
core 依旧传同源 http(s)。与坑 16 同类教训：**平台行为的假设必须真机最小实验**。

**坑 18：「探测不完、连接点不了」—— ConnectScreen 漏读 revision，整页定格（2026-10-15 用户报告）**

现象：连接页永远停在「正在探测 N 个地址…」，按钮像点不动。真机插桩却显示 vm 侧
**2 秒就 connect done**（探测 1.5s 由 utun0 黑洞吃满 deadline，局域网秒过）—— vm 正常、
UI 定格，典型的坑 12 变体：`ConnectScreen.st()` 直接 `return harnessState() ?? fallback`，
**没读 revision** —— `@StorageLink` 只声明不读，ArkUI 不登记依赖，整页从不重绘。
（AppShell / ChatScreen 都写了防这个的恒真比较，唯独 ConnectScreen 漏了。）

连带修的两处：
1. `loadSnapshot` 七连串行改**并行**（互不依赖的请求同时发，entries 因依赖 roots 放第二波）
   —— 快照段从 7 次往返和变成一次最慢往返，真机实测 583ms。
2. `connectHostInternal` 的**后半段（currentDevice / loadSnapshot）原来没有就地收口**：
   这两步抛异常时 `connecting` 不会被复位（外层 launchOperation / restoreConnection 的
   兜底不碰连接态），UI 就永久停在探测行。现在 try/catch 就地复位 `connecting` 与
   `connected` 并报错；成功路径同样显式清 `restoring`。

修复后真机验证（插桩 + dump）：`connect start → probed → device ok → snapshot ok → done`
全程 2.0s；连接页实时显示「局域网 ✓ / 虚拟网 不可达 / 已连接 / 进入应用」。
**规则**：新增页面一律照抄 `AppShell.st()` 的写法（声明即读）；UI 停格类问题先看
「vm 到底走到没有」（插桩）再动 UI —— 本例 vm 全对，改 vm 只会白费。

**坑 19：「进入应用」点了不进下一页 + 「删除」点了没反应 —— 两颗同族但独立的雷（2026-10-15 用户报告）**

用户一次报了两个症状，根因**互不相同**，只是症状都表现为「点了没反应」：

**19a. `passConnectGate()` 只改字段、不通知 → 切页判据永不重算。**
`Index.showConnect()` 读的是 `vm.connectGate`，而界面重绘只靠 `revision`（`AppStorage`
的 `dshRevision` 键）。源工程里它是 `MutableStateFlow`，赋值天然通知订阅者（Compose 重组）；
移植成普通字段后**通知语义丢了** —— 门闩已放行、界面纹丝不动。修法：赋值后
`this.update((_s) => {})`（恒等变换，只为触发一次 `revision++` + `notifyListeners()`）。
**教训**：从 `StateFlow` / `LiveData` 移植到普通字段时，凡是「被界面读到的字段」都必须
补一次显式通知 —— 这是坑 12 的同一家族，不要等用户报才想起。

**19b. `busy` 抄了 `true`、没抄收尾 `false` → 删除按钮永久禁用。**
🗑 的判据是 `.enabled(!state.busy && !state.connecting)`。源工程 `launchOperation`
**结束时一定 `busy = false`**（2107 行），连接成功里的 `busy = true` 只是中间瞬间；
而 ArkTS 版根本没有 `launchOperation`，`restoreConnection` 是**直接** `await
connectHostInternal(chosen)` —— 于是冷启动自动重连成功后 `busy = true` 无人复位，
按钮全灰（连接页 🗑、主界面每个会话行的 `rowEnabled` 都含 `!busy`）。

更值得记的是：**源工程自己踩过同一个坑并写进了注释**（[ConnectScreen.kt 382-388]）：
「此前两者共用 `enabled`，于是自动重连成功后只要后台还有一次请求在跑（loadSnapshot、
会话刷新都算 busy），按钮就是灰的……真机截图里那个灰掉的『进入应用』就是这个」。
它把「进入应用」在 `isActive` 时放宽为**只看端点非空、忽略 busy** —— 这个放宽我抄对了
（ArkTS 版 `connectButtonEnabled` 在 `isActive` 时已放行），但 🗑 那条 `busy` 没收到尾。
修法：`connectHostInternal` 结尾（`connectEvents` 之后）显式 `busy = false` —— 此刻设备信息、
快照、事件流都已到位，`busy` 的语义「有请求在跑」不再成立。

**真机验证**：「进入应用」点击后进入主界面（顶栏「会话」、**「共 44 个会话」**、列表有数据）；
🗑 点击后正常弹出确认框「删除「wangke-PC」？」，点「知道了」取消后主机完整保留。

**调试方法论补充：锁屏会让 `uitest uiInput` 静默失败。** 中途两次点击「没反应」，查
hilog 得 `uitest/IPCObjectProxy: IMultimodalInputConnect ... operation not permitted`
—— 不是应用问题，是**手机闲置锁屏后系统拒绝模拟点击**。先 `hdc shell power-shell wakeup`
唤醒再点（本例唤醒后点击立即成功）。**别把「输入注入被拒」误判成「应用不响应」**。

**坑 20：真机三条反馈的收口 —— 面板留白 / 返回拦截 / 深色（2026-10-15）**

用户一次报三条，逐条实测。

**20a. 会话配置面板下方大片留白** —— `ChatDetail.sheetHeight()` 原返回 `SheetSize.LARGE`
（近全屏），而面板内容（Agent 预设 + 各 provider 模型清单）长度随 provider 数浮动，
只有一个 provider 时就空出近半屏。源工程 Compose 的 `ModalBottomSheet` **默认按内容自适应
高度**，`SheetSize.FIT_CONTENT` 才是对位写法。真机复测：面板按内容撑开、行距均匀
（Agnes 系 6 个模型依次向下：2.5-flash / 3.0-flash / image-2.1 / image-2.5 / video-2.5 /
video-v2.0，无重叠、无留白）。

**20b. 会话页侧滑直接退出应用** —— 窄屏下会话详情是整页，侧滑即系统返回手势；而本工程的
分节切换**不是路由栈**（无 Navigation / NavPathStack），系统无从得知「还能往回退一步」，
于是直接退到桌面。修法：`Index.ets` 加 `onBackPress()` —— 详情开着（`selectedSessionId
!= null`）就 `selectSession(null)` 并 `return true` 消费掉这次返回，否则 `return false`
交还系统。真机验证：详情页注入返回键 → 回到「共 44 个会话」列表，**未退出应用**。
（`selectSession(null)` 只清会话相关状态、不动连接与事件流，退回是即时的。）

**20c. 深色模式「未关联成功」—— 实为正常，是我读错了枚举值。**
真机日志 `onConfigurationUpdate colorMode=0` + 截图（全黑底 / 白字 / 深色卡片 /
**黑色导航条**）证明深色**已生效**。误判源于两点：
① 拿了一张**浅色时刻**的旧截图当深色证据；
② **`ConfigurationConstant.ColorMode` 枚举值容易记反** ——
`COLOR_MODE_DARK = 0`、`COLOR_MODE_LIGHT = 1`、`COLOR_MODE_NOT_SET = -1`，
所以日志里 `colorMode=0` 是**深色**，不是「0 = 未设置」。**别再按 0/1 直觉读它。**
配套改动（保留，均为正向）：`onCreate` 里 `setColorMode(COLOR_MODE_NOT_SET)` 显式声明
跟随系统；`onForeground` 补刷一次导航条配色（系统深浅色很可能是在应用处于**后台**时被
切换的，那种时序下 `onConfigurationUpdate` 不保证回调）。

**调试方法论（新增）**：`uitest uiInput swipe` 注入的是**应用层触摸**，**不会触发系统返回
手势** —— 验返回行为要用 `uitest uiInput keyEvent Back`（它与手势导航走同一个
`onBackPress` 回调）。与坑 19 的锁屏拒注入合起来即：
「注入失败 ≠ 应用不响应；注入成功 ≠ 走到了预期路径」。

**坑 21：「模型点击无响应」三层伪装 —— 逐层取证才见真凶（2026-10-15 用户报告）**

用户报「模型列表中模型点击无响应」。真机取证一层层剥开，**每层表象都指向不同结论**，
真凶在第三层：

1. **第一层——实测证明不是它**：`onClick` 没问题。插桩日志 `[DSH] pickModel
   agnes-ai-cn:agnes-2.5-flash` 每次点击都正常打出。
2. **第二层——实测证明也不是它**：`vm.selectModel` 与「面板不重绘」都没问题。
   日志显示服务端切换确实成功（`selectModel -> {"current":{"model":"agnes-2.5-flash"...}}`），
   面板 `cfg()` 也确实重算了（`sheet cfg recompute rev=21 → 22 → 24` 递增）——
   **revision 送到了、快照也算过了**。
3. **真凶**：`ModelRowView.selected` 是**普通成员**。`ForEach` 的键
   `${group.id}:${model.id}` **不含选中态** → 键不变 → ArkUI **复用组件实例** →
   普通成员**永远停在首次渲染的值** → 勾号纹丝不动。

**修法**：`ModelRowView` 的 `selected` / `current` 改 `@Prop`；同因把 `AgentPresetRow`
的 `selected` / `rowEnabled` 一并改 `@Prop`（它有个完全相同的隐患，只是用户还没撞上）。
真机验证：点 `agnes-2.5-flash`，勾号由 y=1542 移到 **y=1278（即该行）** ✓。

**规则（新增，重要）**：`ForEach` 渲染的**子组件**，凡「会随父状态变化」的入参
**一律 `@Prop`**。口诀：**键里没有的信息，不能靠普通成员传。**

**中途两次走错路，要记住**：①我先后怀疑 `connectGate` / `busy`（坑 19）、「面板不重绘」、
「`@Prop` 没生效」——**都不是**，原因是没有先做「分层定位」就拿假设去改代码；
②差点认定「revision 没送达」而重写订阅机制，加一行 `rev` 日志 5 分钟就证伪了。
**教训：先分层取证（点击 → vm → 快照 → 渲染），再动手；每层都要有日志或坐标这类硬证据。**

**坑 22：会话页 Markdown 渲染 —— 表格整块裸文本、链接显示成 `[文字](链接)`（2026-10-15 用户报告）**

用户原话：「会话页中的 MD 渲染 问题很大 尤其表格类」。真机 dump 里一张 Markdown 表格的节点文本
直接是 `'| 坑 | 说明 |\n|---|---|\n| 证书类型…'`，链接也是 `[signing/…](…)` 裸文本。

**根因**（`core/MarkdownLite.ts`）：块类型只有 6 种 —— **没有 TABLE、也没有 HR（分隔线）**，
表格因此整块落进 `PARAGRAPH` 分支，`inlineMarkup` 只剥 `**`/`` ` `` 后原样显示。
早期注释里「不解析表格」的理由（手机上没有可读的宽表格）被真机反馈推翻：会话里表格并不少见，
竖线裸文本比窄表格难读得多。**口径已改为：能画就画，画不下就横向滚。**

**修法**：① `MdBlockKind` 加 `TABLE` / `HR`；② GFM 表格解析的**硬闸门是「下一行必须是分隔行」** ——
少了它会吃掉 `a | b` 这类正文（命令行管道、竖线分隔）；③ 新增 `markdownTableColumnWidths` 按内容估列宽
（全角 1 / 半角 0.60，夹在 `64–240vp`；半角系数初版为 0.55，**后被坑 23 修正**），且**必须先过 `inlineMarkup` 再估**，否则 `[文字](很长的链接)`
会把列宽直接顶到上限；④ 渲染套一层横向 `Scroll`，列宽必须显式 `width()` —— 无界约束下 `Divider`
会塌成 0 宽（与 dsh-ui 卡片 `tableView` 同一个坑）；⑤ `inlineMarkup` 补剥链接/图片/删除线/星号斜体，
**刻意不认下划线系标记**（`a_b_c`、`__init__` 会被吃坏，正则判断不出词边界）。

**`ForEach` 键的坑（坑 21 规则的第 2 例）**：表格块的 `text` 是空串，沿用
「`${index}:${kind}:${text.length}`」会让流式更新期间键不变、组件不重建，表格永远停在第一帧。
表格必须把表头与各行的实际文字编进键（`MarkdownView.keyOf`）。

**验证**：真机走「文件 → `官方基准-复刻差距诊断.md` → Markdown 预览」这条确定路径（与聊天页共用
`MarkdownView`），截图可见表头浅底 + 表头分割线 + 列宽按内容分配 + 长单元格折行 ✓；
块引用左侧竖条、标题分级同屏可见无回归。

**坑 23：表格里的长英文标识符被在词内折断（坑 22 的续修，2026-10-15 用户报告）**

坑 22 落地后复查截图，发现表格第一列的 `bundleName` 被渲染成 `bundleNam` / `e` 两行。用户原话：
「在图上发现一个真实渲染瑕疵…改」。**注意这是独立的一颗雷**：它不在解析、也不在渲染结构，
纯粹在**列宽估算**。

**根因两条叠加**：

1. `charWidthUnit` 西文系数取 `0.55`，而系统比例字体的小写字母平均约 `0.55~0.58 em` —— 估出的
   列宽恰好比实际渲染宽度**窄几个像素**，`Text` 便在词内强制断开。**贴边到被反噬**。
2. 表头按 `14vp` 渲染，但 `markdownTableColumnWidths` 一律按正文 `13vp` 估 —— 长表头那格必然偏窄。

**修法**：① 西文系数提到 `0.60`（约 8% 余量）；② `markdownTableColumnWidths` 加 `headerFontSizeVp`
参数，**表头与正文分别估算再取大**（不传时按正文处理，旧调用不受影响）；③ 顺手消掉隐患本身 ——
`14` 原先硬编码在渲染处、估算处又是另一套，抽出 `ChatMessage.headerCellSize()`，**渲染与估算共用
同一个出处**，以后改字号只动一处。

**代价（要记住）**：系数提高后所有表格列宽普遍**加宽约 9%**，宽表更容易触发横向滚动。这是
「宁可略宽也不断词」的取舍换来的。

**验证**：单测 3 条（长英文标识符列宽足以不折词 / 表头字号更大时按表头估 / 不传表头字号时按正文处理），
`BUILD SUCCESSFUL` + `531 用例全绿`；**真机已验**（2026-10-16 用户确认表格英文标识符整词折行，见 §7「待真机验证」第 24 条）。

**坑 24：会话页输入 `/` 带不出 dsh 命令（2026-10-15 用户报告，源工程 Android 版正常）**

用户原话：「会话页"/"无法带出 dsh命令，源目录 APP 是正常的」。`@` 文件补全能用，唯独 `/` 命令面板
**从不出现**。这是**平台语义坑**，不是逻辑坑：判据 `core/ComposerSuggestions.ts` 本身正确
（`commandSuggestions` 要求整行以 `/` 开头、斜杠后无空白、按前缀匹配，`COMMAND_LIMIT = 5`），
真机上前端就是拿不到最新输入。

**根因（ArkUI 独有，Kotlin/Compose 无此问题）**：`CommandSuggestions` 的 `value` / `commands`
原本是**普通成员**。而命令面板所在的分支 —— 空输入时 `mentioning()` 为 false —— **从页面加载起就
存在，其实例在首帧即被创建**。父组件每次重绘时，ArkUI 只回写**带装饰器**的成员，**普通成员被跳过**，
永远停在首帧值 → `commandSuggestions('')` 恒为空 → 面板永不出现。
`@` 面板能成立纯属偶然：它是「切换分支」时**新建**的实例，恰好拿到当时的输入，并非普通成员也能更新。

**硬证据（编译产物即规范）**：`entry/build/…/esmodule/debug/entry/src/main/ets/ui/ComposerSuggestions.ts`
里编译器生成的 `updateStateVars(params)` **参数只由 `@Prop` 收集**：
```
343:    updateStateVars(params: CommandSuggestions_Params) {
344:        this.__value.reset(params.value);
345:        this.__commands.reset(params.commands);
```
普通成员根本不在 `params` 里 —— 这就是「不回写」的机制级证据，与坑 21 同源。

**修法**：两个面板的下行数据成员一律改 `@Prop`（`value` / `entries` / `failed` / `cwd` /
`cwdAbsolute` / `commands`）；**函数成员（`onSelect`）保持普通成员** —— 它不随父状态变化，
且 `@Prop` 深拷贝会连原型一起拷、把闭包语义改坏。

**顺带确证的第二个结论（`@Prop` 深拷贝保原型）**：`MentionSuggestions` 收 `FileEntry[]`，
若深拷贝丢掉原型，`entry.isDirectory()` 会在渲染时炸。运行时 `libace_compatible.so` 的
`deepCopyObjectInternal` → `getDeepCopyOfObjectRecursive` 明确走
`Object.setPrototypeOf(copy, Object.getPrototypeOf(obj))` + `Object.keys` 递归 ——
**方法随原型保留**，故 `@Prop` 传类实例数组安全。（`Object.keys` 只遍历自有可枚举属性，
原型上的方法本就该留在原型里。）

**规则（与坑 21 合并成一条口诀）**：**键里没有的信息（`ForEach`）与实例先于数据存在的信息（条件分支），
都不能靠普通成员传 —— 一律 `@Prop`/`@Link`。判据就是编译产物里 `updateStateVars` 收没收它。**

**验证**：`BUILD SUCCESSFUL` + `531 用例全绿`；**真机已验**（2026-10-16 用户确认输入 `/` 能带出 dsh 命令，见 §7「待真机验证」第 25 条）。

**坑 25：上架审核驳回 —— 应用图标必须是 1024×1024 的「分层资源」（2026-10-16，AGC 审核退回）**

AGC 审核原文（同一条出现两次，对应 10-15 的两次送审记录）：

> 未正确配置单层图：应用图标单层图尺寸为 216px\*216px，标准要求尺寸 1024px\*1024px，
> 且需下载 HUAWEI DevEco Studio 5.0.5.315 或以上版本进行图标再处理。

**根因**：上一版把 1024×1024 的自绘源图**压成 216×216 的单层图**铺进包内 4 处
（`AppScope` 与 `entry` 各自的 `app_icon.png` / `startIcon.png`）。**两条都不合规**：尺寸不对，
而且根本没分层。

**规范（一手来源：官方 UX 文档「图标资源规范」与「多平台图标资源规格」）**：图标资源
**必须为分层资源**、尺寸**必须 1024×1024px**、**必须为正方形**（无需圆角，系统自动生成遮罩裁切）、
PNG 格式，且**背景图不允许含有透明像素**。手机 / 折叠屏 / 平板 / 电脑 / 智慧屏**全部**是
「双层 + 正方形 + 1024×1024 + PNG」。官方原话：「请在 Hap 包中正确预置图标资源，否则将无法通过
上架检查。」

**分层资源怎么写**（命令行工程，无 DevEco Studio GUI）：

```
entry/src/main/resources/base/media/
├── foreground.png          # 前景层：图形本身，带透明通道
├── background.png          # 背景层：纯色底板，**不含任何透明像素**
└── layered_image.json      # 引用两层
```

```json
{
  "layered-image": {
    "background": "$media:background",
    "foreground": "$media:foreground"
  }
}
```

再在配置里把 `icon` 指向该 JSON 的**资源名**（`$media:layered_image`）。`AppScope` 侧同理
（本次用 `app_layered_image.json` + `app_foreground.png` / `app_background.png`）。

> ⚠️ **`AppScope` 与 entry 的资源不能同名** —— 同名时 entry 的资源会被 AppScope 的**同名资源覆盖**
> （官方文档「图标配置完成后不生效」条目）。故刻意起不同名：AppScope 用
> `app_layered_image` / `app_foreground` / `app_background`，entry 用
> `layered_image` / `foreground` / `background`。
> 另：`startWindowIcon`（启动页图标）**不是分层资源**，用独立的单层图（官方「生成单层图标」产出的
> `icon_startwindow.png` 正是给启动页的），故 `startIcon` 保持单层 PNG 不动。

**本次拆分前景/背景的做法**（源图是「蓝底 + 白图形」的**已合成**图，需反解）：实测源图底色为纯
`(30,90,200)`、白图形占 26.7%，且**整图满足「白色以覆盖率 c 叠加在纯蓝底上」** —— 对任意通道有
`C = c*255 + (1-c)*BG`。取**跨度最大的 R 通道**反解 `c = (R-30)/225`（实测最大重建误差仅 30，
只出现在个别比底色更深的蓝像素上）。于是：

- **背景图** = 纯 `(30,90,200)` 铺满 1024×1024，**全不透明**（合规）；
- **前景图** = 白色、`alpha = clamp(c)`，其余透明。
- 白卡片内部的蓝条与「DSH」字样是通过**透明孔洞**露出背景层的蓝；因两层蓝同色，合成后与原图
  **肉眼无差**。

**验证**：真机桌面图标为圆角方形、图形居中清晰、无裁切无硬直角（`snapshot_display` 截屏核对）；
`bm dump` 中 `iconPath` 已解析为 `$media:app_layered_image` / `$media:layered_image`、`iconId` 已分配。

**上架前自检（补进 `docs/RELEASE.md`）**：图标必须**分层 + 1024×1024 正方形**，且**背景层不含透明
像素**；用 `unzip` 看包内是否同时存在前景 / 背景两张图与 `layered_image.json`，别只看「有张图标」。

**系统导航条随主题设色（2026-10-15 用户要求，已落地）**

实现（`entryability/EntryAbility.ets`）：`onWindowStageCreate` 里 `windowStage.getMainWindowSync()`
存下主窗口引用，按 `this.context.config.colorMode` 调 `setWindowSystemBarProperties`
（`navigationBarColor` + `navigationBarContentColor`）；`onConfigurationUpdate` 里重调以响应系统主题切换；
`colorMode` 为 `COLOR_MODE_NOT_SET` 时按浅色兜底。取值与页面背景
`sys.color.ohos_id_color_background` 一致：浅色白底黑图标、深色黑底白图标。

两个**必须记下**的点：
1. `setWindowSystemBarProperties` 一旦调用过，这条导航条就**不再由系统自动跟随主题** ——
   所以 `onConfigurationUpdate` 里的那次重调不是可有可无的优化，缺了它切深色后导航条会停在浅色上。
2. **只设导航条、不动状态栏**：状态栏当前无不匹配（应用内容未延伸到状态栏区域，dump 里
   WindowScene 的 bounds 自 y=122 起），顺手改它只会把上一轮刚修好的避让问题引回来。

验证状态：浅色路径已实测（截屏采样导航条为 `#FFFFFF`，与页面背景一致，无回归）；
**深色路径需要手动把系统切到深色模式再验一次**（见 §7「待真机验证」）。

**坑 26：上架驳回「应用名称与第三方应用相似」—— 改名必须连 `bundleName` 一起换（2026-10-16，AGC 审核退回）**

**AGC 原文**：①「应用与『DeepSeek』应用的名称相似（其他语言端应用的名称：Deepseek Harness 客户端），
但未提供相关授权或商标权属证明，可能导致用户产生混淆、误认或不适宜的联想」；
②「修改应用名称时，请务必同步更新**应用介绍、应用内容及应用安装包的名称配置**」。

**处置**：拿不到授权 → 按建议①**删除与其它应用相同或相似的内容**，即彻底去品牌：
包内应用名「DeepSeek Harness」→「**DSH 伴侣**」/「DSH Companion」；
`bundleName` `com.Deepseek_Harness_client.westanke` → **`com.dsh.westanke`**。

**为什么 `bundleName` 也非改不可**：包名里的 `Deepseek` 同样构成「应用身份」，
只改显示名、复判时仍会被认侵权；而 AGC 侧 Profile 与 `bundleName` 绑定、**不可修改**，
所以只能在 AGC **新建一个应用**（新 `bundleName`），再据此**重新签发**调试 / 发布 Profile 与证书
（密钥对 `.p12` 可沿用，不必换）。新 Profile 的 `bundle-name` 必须是 `com.dsh.westanke`，
否则 `hap-sign-tool` 直接拒绝签名。

**连带必须同改的五处**（漏一处就是「三处口径不一致」，本身就是不合格项）：
1. `AppScope/app.json5` 的 `bundleName`
2. `AppScope` 与 `entry` 两侧 `element/string.json` 的 `app_name`（中 / 英）
3. `entry` 侧 `EntryAbility_desc` / `module_desc` / `connect_title`
   （连接页标题「连接 DeepSeek Harness」→「连接服务端」）
4. `core/ErrorMessages.ts` 的 `err_signed_out`（「已经退出 DeepSeek 登录」→「已经退出服务端登录」）
5. `oh-package.json5` 的描述

**还有一处最易忽略：用户数据里的品牌字样。** 会话标题、插件名、工作区路径都由服务端返回，
截图 / 录屏里一旦出现第三方产品名，同样属于「应用内容相似」。出图后必须逐张复核、
滚动或换图规避 —— 本轮的 `01-sessions` 就是为此重拍了两次（首版可见
「Whaleness：DeepSeek Harness 的第三…」一行）。

**验证**：见 §7 第 27 / 28 条（1.0.2 真机 `versionCode` 1000002、界面口径一致）。

**坑 27：设置页点药丸「功能生效但选中高亮不动」—— 依赖登记漏了一个元素 + 子组件成员没装饰器（2026-10-16，用户真机反馈）**

**现象**（用户原话）：「设置中的 English 插话发送 点击后 图标不变化，但是 功能已启动」。
即偏好确实被写进去、功能确实切换了，只是**界面不动**；离开设置页再回来又是对的。

**真机取证**：点「排队发送」前后各截一帧 → **两帧 MD5 完全相同**（画面零变化）；
切到别的分节再回设置页，Queue 已是选中态。⇒ 确认是「状态已变、UI 未重绘」，不是点击没生效。

**两个根因，缺一不可**（这也是它难查的原因：两处都缺才出症状，补任一处都只是「好一半」）：

1. **`SettingsScreen.st()` 漏读 `revision`**（主因）。ArkUI 的增量更新**按元素（elmtId）登记依赖**：
   编译器把每个 UI 元素的创建包在 `StartGetAccessRecordingFor(elmtId)`…`StopGetAccessRecording()`
   之间，**只有在那个元素的那次渲染里读到的状态**才成为它的依赖；状态变更时也只重跑登记过的元素。
   所以「在 build 里读过一次 `@StorageLink`」不等于整页登记 —— 只等于**读到它的那几个元素**登记了。
   全工程 12 个界面都按**坑 12** 在 `st()` 里读一次 `revision`（为的就是让每个经 `st()` 取值的节点
   都登记上），**唯独 `SettingsScreen` 漏了**：它只在 `isEnglish()` 里读过（那是为语言药丸加的）
   → 语言药丸能刷新，**其余所有动态节点一次也没登记过** → 发送方式药丸、开关、状态字全部冻在首帧。
   **修法**：`const rev: number = this.revision;` 补进 `st()`，一条链覆盖全部取状态的节点。
2. **子组件下行数据是普通成员**。父组件重绘时 ArkUI 只回写带装饰器的成员（编译产物
   `updateStateVars` 只收 `@Prop`，同**坑21 / 坑24**），普通成员停在首帧值。故 `ChoicePill.selected`、
   `SwitchRow.checked`、`SettingRow.title` / `subtitle`、`StatusLabel.label` / `active` 一律改 `@Prop`。
   **函数成员不能加 `@Prop`**（会把闭包一起深拷贝坏掉，坑 24 已证）—— `onTap` / `onCheckedChange`
   保持普通成员。

**附带修掉的一处旧注释漏读**：原先 `choicePill` 是 `@Builder`，文件头「平台差异 1」只写了
「两个选择题各写一个 `@Builder`，不共用一个带**数组参数**的 `@Builder`」—— 只防了「数组 + 回调」
这一种传法。**按值传参的 `@Builder` 对布尔 / 字符串同样不会刷新**（`selected` 就死在这一条上），
故改为 `@Component` + `@Prop`。这条漏读的规则正是坑 27 的另一半。

**教训**：凡是「数据从 vm 流到某个 UI 元素」的路径，要问两句 ——
① 这个元素**自己**读到状态了吗（没读到就没依赖，参考坑 12）？
② 中间隔着子组件吗，那个成员是 `@Prop` 吗（隔了就要装饰器，参考坑 21 / 24）？

**坑 28：资源文件在 FUSE 挂载点上的字节级损坏 —— `Read` 是真相、`Grep` 会骗人（2026-10-17）**

**症状**：`entry/src/main/resources/en_US/element/string.json` 读出来出现**字符插入/缺失型**
错乱 —— `"vaiue"`（`value` 少个字母）、多一个 `"name": "a_lgenerated_notice"` 的**重复键**、
`"workspaceefiles_ewpty"`（名字被塞进字符）、`"value": "Zoom text out""`（多一个引号），
文件尾部还残留一段错位片段（重复的四条 `workspace_files_*` + 一对多余的 `]` / `}`）。

**怎么确认这是「磁盘上的字节」而不是读缓存骗人**：拿最干净的一处（`ai_generated_notice`
那两条重复键）试一次 `Edit` —— 若 Edit 能**精确匹配**这段乱码并改写成功，就说明磁盘字节与
读出的字符**逐字相同**，损坏是真的。本次匹配成功，故后续修复一律按「读到的就是磁盘上的」处理。

**为什么它「只坏了被我编辑过的地方」**：两处损坏区（`ai_generated_notice` 与
`command_*` / `workspace_files_*` 尾部）恰好都是**上一次用文本插入改过的地方**。
所以这是**写入路径**的问题，不是文件内容本身的问题 —— 排查时应先问「这段最近被改过吗」，
而不是怀疑整个文件。

**关键教训（这是工具层的，与坑 12 的「读依赖」不是一回事）**：
- 在这台机器的 FUSE 挂载点上，**`Grep` 报的行数与内容可能是过期的**（ripgrep 拿到的是旧的
  `stat` 尺寸，看到的是一份被截断的视图），而 **`Read` 读到的是当前真实内容**。两者冲突时
  **以 `Read` 为准**。本轮就出现过「Grep 说 1440 行、找不到新键；Read 说 1488 行、新键在」的分歧。
- 因此**不能用 `Grep` 验证刚完成的编辑**，必须回读复核。修完之后 Grep 又能对上了，所以这不是
  「Grep 永久坏了」，而是**写入后的一段时间窗口内**它读到旧尺寸。

**修复路线（可复用）**：
1. **中文 `base` 文件是键序与结构的权威对照** —— 它同位置完好（两侧本应逐键对应）。先读出
   base 的对应段落，得到「这里应当有哪些键、按什么顺序」。
2. **英文取值以编译产物里的一手原文为准**：`entry/build/default/intermediates/res/default/
   resources.index`（Restool 5.1.0.007 的索引，**明文可读**）保留了构建时从源文件读到的英文串
   —— `restool` 的产物反过来成了源文件被写坏时的**唯一可靠副本**（与 memory 里记的
   「resources.index 是恢复一手原文的唯一可靠来源」是同一条经验）。
3. 用 `Read`（**不要用 Grep**）在「最后一个干净锚点」处回读、核对、再改；改完**再 Read 复核**。

**为什么必须修而不能「先放着」**：重复键与未闭合字符串会让 `restool` 解析失败、**整包构建
起不来**；而且这些键（斜杠命令面板的全部文案 + 工作目录四条）在英文界面下缺一条就是一处空白。

**坑 29：过程组的展开态不能存在组内 —— `List` 会回收视口外的条目（2026-10-17，本轮 B 批 ①）**

**症状（预期会踩的坑，本轮提前规避，真机待复测）**：把「过程组是否展开」做成
`ProcessGroupRow` 自己的 `@State`，一旦这一组被滚出屏幕再滚回来，展开态**凭空复位**；
更糟的是滚动过程中 `ForEach` 复用出的新实例带着旧的 `@State`，出现「同一组一会儿开一会儿关」。

**根因**：ArkUI 的 `List` 对**视口外**条目做回收复用（源工程 Compose 的 `LazyColumn` 同理）。
`@State` 是**组件实例**级的，条目被回收后实例与其状态一起消失。源工程用的是
`rememberSaveable`（会话级保存，跨重组与回收都在），所以那边天然不会有这个问题。

**修复**：展开态上移到**父组件** `ChatDetail.expandedGroups: string[]`，
通过 `@Prop expanded` 下行、`onToggle` 回调上行。父组件在 `List` 之外、不参与回收，
所以状态天然是会话级的 —— 与源工程 `rememberSaveable` 的语义对齐。
`expandedGroups` 用**数组**而不是 `Set`：ArkUI 的 `@State` 对 `Set` 的变更检测不进入
重绘（内置容器只认 `Array` 的增删与整体重赋值），数组的「重建再赋值」才是能触发刷新的写法。

**教训**：凡是「条目自己的临时 UI 状态」（展开/选中/输入框内容）都要问一句
**这条目会不会被滚出屏幕**。会 → 状态不能住条目里，必须住到不参与回收的那一层。

**坑 30：过程组的两条「身份」陷阱 —— 列表 key 会撞、`setTimeout` 无法取消（2026-10-17，本轮 B 批 ①④）**

**陷阱一：过程组的 id 取组内首项 id，会与「展开后那一条」撞 key。**
源工程 `ChatDisplayEntry` 的 `processGroup` 用**组内首项的 id** 作组 id，这是刻意的
（这样「同一批过程项」永远算出同一个 id，重组不会导致组件重建）。但在 ArkUI 这边有个
源工程没有的连带：**单项的过程组会被平铺**（`flatSingle()`），平铺后那一条**以消息身份**
出现在列表里，它的 `ForEach` key 若直接用 `item.id`，就与「组」的 key 一模一样 ——
`List` 会认为两者是同一条目，出现错位与状态串味。

**修复**：过程组的 key 统一加 `process-` 前缀（`chatDisplayEntryKey(entry)`），
前缀只加在**列表 key**上、不改组内数据；组内 `ForEach` 仍按 `item.id` 编 key。
两条 key 空间彼此隔离，平铺与成组两种形态不再互相干扰。

**陷阱二：`setTimeout` 没有取消机制，滚动冻结的解冻回调可能「迟到」。**
源工程 `ChatScrollFreeze.kt` 用 `LaunchedEffect` 起一个 `delay(80)` 协程，**协程随 key 变化
自动取消**：滚动再次开始时，上一次「停手后解冻」的定时器会被连带取消，不会迟到。
ArkUI 的 `setTimeout` **没有等价的取消语义** —— 用户快速反复滑动时，前几次滑动留下的
80ms 定时器仍会在各自到期时触发，与后续滑动交错，出现「还在滑，列表却已经解冻并跳了一下」。

**修复**：加一个 `scrollGeneration: number`，每次 `onScrollStart` 自增并把当前代际号
封进闭包；`onScrollStopped` 的 `setTimeout` 到期时**先比对代际号**，不是最新一代就直接返回。
另外 `onScrollStart` 里的动作顺序必须是**先快照、后上锁**：先 `frozenItems = computeDisplayItems()`
再置 `scrollSettled = false`；反过来会在「上锁」与「快照」之间留出一帧，那一帧里列表已经
冻结但冻结的是空数据。

**教训**：从 Compose/协程迁到 ArkUI 时，「定时器 + 可取消」是一类**结构性缺失**，
不是写法问题。凡源工程靠 `LaunchedEffect` / `rememberUpdatedState` / 协程作用域拿到的
「随状态变化自动作废」，在 ArkUI 都要显式做一遍（代际号 / 令牌 / 显式 clear）。

**坑 31：ArkUI 的全屏态要用 `bindContentCover` —— 自绘浮层拿不到系统返回键（2026-10-17，本轮 C 批 ①）**

图片全屏查看器（`ui/ChatDetail.ets` 的 `imageViewer()`）用
`.bindContentCover(isShow, builder, { modalTransition, onDisappear })`：它是一个**盖住整页**
的系统级模态，返回键与底部手势区都由系统接管。自绘浮层（`Stack` + 绝对定位铺满）做不到
这两件事 —— 用户按返回键会**直接退出应用**，而不是关掉查看器。源工程用 `Dialog` 拿到的
正是这套系统行为。

两条连带：

- **`isShow` 走单向**：用户用系统返回键关掉模态时**不会**回写标志位，必须靠 `onDisappear`
  复位（与 `bindSheet` 同一个坑，见 `ui/ChatHeader.ets` / `ui/ChatScreen.ets`）。不复位的话
  标志会留在 `true`，下一次再置 `true` 就不再触发。
- **「点空白关闭」不要挂在整页上**：那样点底部「保存」时事件会先冒到父级、把查看器关掉。
  只把该手势挂在图片区即可（右上 ✕ 与图片区两条路都通）。

**坑 32：鸿蒙「写相册」是受限权限 —— 图片保存改走零权限的系统面板（2026-10-17，本轮 C 批 ①）**

源工程的 `MediaStore` 写入（`saveToGallery`）在鸿蒙的对位是
`ohos.permission.WRITE_IMAGEVIDEO`，**与 `READ_PASTEBOARD` 同一类受限权限**：普通应用
一旦声明，安装就会被系统拒绝（本工程已因同类权限栽过一次，见坑 26）。所以改走
`platform/Pickers.saveBytes` —— 系统「保存」面板返回一个已授权的 URI，`fs` 直接写，
**零权限**。代价是「不会自动进相册」，因此文案写成「保存」而不是「存到相册」：
不承诺做不到的事。

面板的**三档结果必须分开处置**（`SaveOutcome.SAVED` / `CANCELLED` / `FAILED`）：

- 取消 → **静默**。用户主动按取消，却收到一句「保存失败」，会以为哪里坏了；
- 失败 → **必须给提示**。保存是个很少用的动作，用户点它时是专门为了存下来，
  静默失败会让他以为已经存上了。

混成一个布尔量就必然在「取消」那一档误报。

**坑 33：能力位「未知」不等于「缺失」—— 未知时一律按「不显示 / 不警告」处理（2026-10-17，本轮 C 批 ③）**

服务端在 `connection.ready` 自报 `bridgeVersion` 与 `capabilities`；旧插件不报这些字段，
于是客户端读到的是**没有**。此时必须按**未知**处理（`core/BridgeCapabilities.ts` 里的
`parseBridgeCapabilities` 返回 `null`），**不能**当成「空清单」：

- 当成空清单 → 每个稍旧的服务端都弹出「插件过旧」的**假警告**。假警告比没有警告更坏 ——
  它教会用户忽略警告；
- 同理，清单为空数组也要读成未知：真实服务端不会声明「我一条能力都没有」，空数组只可能
  来自字段被误删/降级。

**能力位守卫必须放在发请求之前**：老 bridge 会**忽略** `archived=true` 并照常返回未归档列表，
于是「请求成功、列表为空」会被读成「一条归档都没有」这个**假结论** —— 用户会以为自己在
电脑上归档的东西丢了。所以 `loadArchivedSessions()` 第一句就是 `supportsArchiveListing()`
不通过直接 `return`，界面入口同样由它把关（能力位未知时**不显示入口**）。

**坑 34：消息级动作的确认框与状态也必须住父组件（2026-10-17，本轮 C 批 ①②）**

分叉确认（`ChatDetail.confirmFork`）与图片查看器（`ChatDetail.viewerBytes` /
`viewerPixelMap`）的状态都落在 `ChatDetail`，子组件（`ChatMessageView` /
`AttachmentImage`）只**上报参数**（`atSeq`、字节 + 文件名），不自己持有状态。

原因与坑 29 完全相同：`List` 会回收视口外的消息行。状态若住子组件，用户点开一张图、
往下滑两屏再滑回来，查看器就自己关掉了（消息行被回收时连同它的 `@State` 一起没）。

**坑 35：`resources/base` 的资源文件在本机写入会被覆盖 —— 关键条目最终集中在文件尾部（2026-10-17，本轮 C 批）**

本轮往 `entry/src/main/resources/base/element/string.json` 追加 10 条新文案
（`archived_empty` / `archived_sessions_hint` / `fork_confirm_action` / `fork_confirm_body` /
`fork_confirm_title` / `fork_from_here` / `image_save_failed` / `image_saved` /
`show_active_sessions` / `show_archived_sessions`）时，观察到**连续写入互相覆盖**：
每次写入后能读到的只有最后一次写进去的那几条，前几次的会消失；而 `en_US` 侧同一批改动
**全部保留**。

**处置**：把这批新条目**一次性**写进同一次编辑、并锚在文件**尾部**
（`workspace_files_unavailable` 之后），写入后逐条 `Read` 复核，确认各出现一次、
无重复键（重复键会让 `restool` 直接解析失败，见坑 28 同类的字节级事故）。

**2026-10-17（第 4 批）追加观察 —— 本坑没消失，且暴露了一个真实缺陷，还揭示了更深一层机制**：
移植第 1/2 批把文案只写进 `en_US`，`base` 侧的追加**被同一机制覆盖丢失**，导致 `base` **缺了 33 个
界面正在引用的键**（第 1/2 批 21 条 + 第 3/4 批 12 条，清单见 `docs/CHANGELOG.md` 修复段）。

**更深一层：本文件在本机 `Edit` 里有两条独立故障叠加。**
①**文件末尾检索不到** —— `Read` 明明是真相（尾部确有内容），`Edit` 对尾部锚点却报
「String to replace not found」；实验中只有 `etag_conflict` 一带能稳定命中。
②**每次 `Edit` 都从冻结的原始快照重写整文件** —— 同一个锚点分两次写，**第二次会把第一次写入的整段丢掉**
（实测：先写 12 条 → 再写 21 条，结果是「只有 21 条、12 条全没」）。所以 33 条必须
**在同一次编辑里一次写全**，并锚在 `etag_conflict` 之后。
**这两点都是坑 28「读写视图都滞后」的更深一层，不是新坑。**

**2026-10-17（真跑一回合后的事实核对 —— 上面描述的那次「33 条追加」从未落到盘上）**：
真跑 `strings-parity` 门禁时实测 `base` 只有 **359 键**（`en_US` 392 键），那批文案始终只躺在 `en_US` 里。
所以「33 条挤在 `etag_conflict` 之后」这句话**当初就是工具回显造成的假象**，不是盘上状态 —— 与坑 28 同源。
**定论：本机写入回显不足以作为「写成功了」的证据，资源文件只认读盘复核（`Read` / `node`）。**

**修法（已完成）**：不再用 `Edit` 逐条搬，改用一个**一次性脚本**（读两份 JSON → 按名合并 →
**全表字母序重排** → 写入前跑三项自检：待补键确实缺 / 清单无遗漏 / 占位符数量与 `en_US` 一致），
写完再 `node` 读盘复核计数 ⇒ `base` / `en_US` 各 **392 键**、一一对应、且恢复字母序。
脚本与日志放 `/tmp`（一次性工具，不入库）。

> 关于上文那条②「同一锚点分两次写会丢掉前一次」：本轮**复现不了它作为「丢数据」的原因** ——
> 真相更简单、也更该警惕：**那两次写入都没有生效**，只是回显说生效了。
> 两种解释都指向同一条纪律：**改完必须读盘复核，且复核要走与写入不同的通道**。

**教训**：资源文件的写入**不能只看工具回显**，必须 `Read` 复核 —— 与坑 28 同源：
本机 FUSE 挂载点上，读写视图都会滞后，回显说「成功」不等于盘上真的变了。

**坑 36：把「只活在文档里的纪律」变成会红的断言时，门禁自己必须先「自检盘面」（2026-10-17，本轮 B 批）**

对位源工程 `ArchitectureGuardTest.kt`：本仓新增 `test/cases/architecture-guard.test.ts`
（行数预算 + 台账登记 / 唯一网络边界 / `ui/` 不读偏好 / 会话展示单一出口）与
`test/cases/strings-parity.test.ts`（中英键集与占位符一致）。三条踩过或差点踩的判据细节：

1. **门禁最可怕的失败不是「太严」，是「路径解析错、什么都没扫到、于是全绿」** —— 那比没有门禁
   更坏，因为它**冒充证据**。所以每个用例开头先跑「盘面自检」：扫到的文件数 / 命中数低于阈值就
   **直接红**，绝不静默跳过。
2. **判据取「符号」还是「字面串」，取决于它会不会恒绿**：源工程原打算按 `getSharedPreferences(`
   字面串扫，但本仓 `ui/` 下该字面串**零命中**（恒绿的空转断言），故改取 `PrefsStore` /
   `SharedPreferences` / `@ohos.data.preferences` **符号**；同理网络边界取 **`import` 行**而不是
   裸符号 —— `core/` 下有多处**注释**在解释 `@ohos.net.http` 的错误码来源，取裸符号会把正确的
   注释判成违规。**放行整行注释、行尾注释仍报错**：宁可让人把说明挪到独立一行，也不要在
   「行内注释剥离」这种半吊子解析上漏掉真实代码。
3. **门禁读真相、不读工具回显**：两条门禁都用 `readFileSync` **直读磁盘**（与坑 28 同一教训：
   FUSE 上 `Grep` 会读到过期视图）。这也是「中英资源门禁」能抓出 `base` 缺 12 键的原因。
4. **三条刻意不引入的文档门禁**（已写进 `AGENTS.md` §8）：①**坑位索引 ↔ 正文双向一致** ——
   源工程正文标题与索引**同名**才可双向比对，本仓索引是**触发词**（「布局溢出系统手势区」）、
   正文是**编号**（「坑 13：…」），硬比对只会恒红或逼人删掉有检索价值的触发词；②**`@patch` 五要素**
   —— 本仓全仓 0 处 `// @patch`，写成断言是永不触发的空转门禁；③**「测试数字多处一致」** ——
   本轮用例总数待跑测后回填，此刻引入即恒红，**留待跑测后连同真实数字一起做**。

**坑 37：接缝只替换「最容易飘的那一维」，保命逻辑不许被替身绕过（2026-10-17，本轮 B 批 + 收口）**

对位源工程 B 批「Clock/Transport 接缝」（源工程 `DEBT-007`：`ConnectionCoordinatorTest` 一条
延迟容差用例偶发红、单跑即绿）。病根是选路比较的**实测延迟来自墙钟** —— 源工程用真实延迟
（`MockResponse.setBodyDelay`）造「局域网 300ms vs 虚拟网 220ms」，机器带编译负载时两次实测
**一起飘**，1.5× 容差判定就偶发翻面。

源工程的修法是加 `measureOverride: (suspend (DshClient) -> ProbeOutcome)?` 构造参数
（默认 null = 原墙钟实现，原逻辑逐字搬进 `probeWithWallClock`）。**本仓换成更干净的一维**：
`ConnectionCoordinator` 的构造参数加 `clock: () => number`（默认 `defaultClock()`，即 `Date.now`），
单测注入「手动推进的假时钟」（`test/cases/connection-coordinator.test.ts` 的 `rig()`），
于是那三条依赖精确延迟比较的用例**完全不等待真实时间** —— 而且因为延迟本身就由假时钟决定，
连「同时在建的微任务调度抖动」也一并消掉，比源工程注入 `measureOverride` 更彻底。

**接缝边界（这一条是坑，不是实现细节）**：接缝只替换「**怎么读时间**」。
**超时、关闭、取消语义仍由协调器负责** —— 那些是「保证不挂死」的部分（挂死地址到点即返回、
`close()` 立刻叫醒在途探活、关闭后不再新建客户端），被测试替身绕过去就等于把最有价值的保护测没了。
源工程原文也有同一句：接缝的边界画得很清楚，它只替换「怎么测这一次」。

**2026-10-17（收口）两处一并补记**：

- **连接即重放**落在 `HarnessViewModelConnection.handleConnection`：`connected = true` 时
  自动 `scheduleChatRefresh()` + 拉待审批 / 待答问题 / 命令清单。与 `resumeEvents`（熄屏恢复）同一链。
  判据理由见 `docs/CHANGELOG.md` 新增条目 10。
- **主题三档**（对位源工程 `data/InterfaceStyle`）：落点 `core/ThemeMode.ts` / `AppPreferences.themeMode` /
  vm `setThemeMode` / `ui/SettingsScreen.ets` 的 `themeSelector` / `platform/Platform.ets` 的
  `applyAppThemeMode` / `ui/AppRuntime.ets`。**平台侧陷阱**：`ConfigurationConstant.ColorMode` 三个枚举
  值容易记反（`COLOR_MODE_DARK = 0`、`COLOR_MODE_LIGHT = 1`、`COLOR_MODE_NOT_SET = -1`），
  且**认不出的档位若原样传给 `setColorMode`，平台会在点击回调里抛参数错误 ⇒ 表现为「点一下就闪退」**，
  所以取值在 `ThemeMode` / 偏好 / 平台**三处都归一化**。枚举记反那条与 `EntryAbility` 的
  `onConfigurationUpdate` 同源（见上文 §4 深浅色一节）。

**坑 38：`/tmp` 被写满自动清除，会让「直连 Shell」整条通道失效 —— 要横向换通道，不要纵向重试（2026-10-17，本轮收口）**

现象：`Shell` 工具任何命令（哪怕 `pwd`）都返回
`unexpect error: transport exception: entity not found: No such file or directory (os error 2)`，
而同一时刻 `Read` / `Glob` / `Edit` 全部正常。根因**不在被执行的命令**：这个工具宿主把每个作业
落在 `/tmp/trae-agent-toolhost-<uid>/jobs/` 下，`/tmp` 被写满后由系统清空，宿主的作业目录连同
`cwd` 一起被删，于是它去 `chdir` 一个**已经不存在的目录**，`os error 2` 就是这个 `chdir` 报的。

**处置：不要原地重跑同一通道** —— 纵向重试三次的结果逐字相同（同一个坏宿主）。**横向换通道**即可：
在 `code_mode` 的 `Exec` 里写 `await tools.Shell({ command, cwd })`，它从**另一个宿主**起 shell，
作业目录是新建的，一次即通（回包 `file_path` 仍指向 `…/jobs/`，但目录存在）。
**同源教训**：工具报错先判「是命令错还是通道错」—— 若**任何命令都失败**、而**读类工具正常**，
就是通道错，换通道，别去改命令。这与坑 28（`Grep` 读 FUSE 过期视图，改用 `readFileSync` 直读）
是同一种病：**故障在通道层、不在你要做的事上**。

**附带一条纪律**：`cmd | tail` 这类管道会**吃掉退出码**（拿到的是 `tail` 的 0），
判「编译/测试到底成没成」要写成 `cmd > /tmp/log 2>&1; echo "EXIT=$?"`，
或直接 grep 权威标志（`BUILD SUCCESSFUL` / `tests N / fail 0`），别信管道末尾的退出码。

**坑 39：两处 ArkTS 编译期语法差异，静态审查看不出来、只有真编译才报（2026-10-17，本轮收口）**

本轮首次把代码送上真编译，立刻抓出两处**写的时候完全不觉得有问题**的违规 —— 记下来备查：

1. **`arkts-no-func-apply-call`：禁 `Function.apply` / `Function.call`**（报
   `At Platform.ets:240:11`）。起因是 `applyAppFontScale` 里要做**运行时存在性探测**
   —— 低版本设备上 `ApplicationContext.setFontSizeScale` 可能不存在（编译期有声明 ≠ 真机一定有，
   同坑 28 的教训）。当时的写法是把方法取出来再 `probe.call(application, target)`，
   结果直接编译不过；而**就算能过也仍是错的**：`as object` 取出函数再调用会**丢掉 `this`**。
   正解是「探测 + 方法语法」两步分开：
   ```ts
   if (typeof (application as object)['setFontSizeScale'] !== 'function') { return; }
   application.setFontSizeScale(target);   // 方法调用，this 正确
   ```
2. **`config` 只声明在 `UIAbilityContext` 上，不在基类 `Context` 上**（报
   `Property 'config' does not exist on type 'Context'`）。`systemFontScale(context)` 里
   直接 `context.config.fontSizeScale` 编不过 —— 基类 `Context` 没有 `config`。正解是在平台层
   内部**显式收窄**：`const uiContext: common.UIAbilityContext = context as common.UIAbilityContext;`
   再读 `uiContext.config.fontSizeScale`。**注意该字段本身是「可选」**（`Configuration.fontSizeScale?: number`），
   所以取值前必须判空并回落 `1.0` —— 这台设备没上报档位时，当成「用户就是要 1.0×」是唯一安全解。

**教训**：ArkTS 的编译期约束（`arkts-no-*` 一族）**静态读代码抓不到**，它们不是「风格问题」，
是**硬编译错**。凡涉及 `Function.call/apply`、`obj['key']` 动态取函数、跨基类读衍生类字段这类
「绕一下就能写」的写法，都要预料到编译会翻脸 —— **能真编译时，务必先编译再谈其它**；
本轮若继续只靠 `Read` 静态审查，这两处会一路带到真机白屏。

**坑 40：`@Prop` 的审计单元是「成员」不是「组件」—— 同一页上修了开关却漏了说明（2026-10-17，真机复查 + 全仓审计）**

真机取证很直白：设置页**同一帧**里步进器已经是 `1.3×`，紧挨着的那行说明仍写「应用字号 1.2×」——
一屏之上两个控件互相打脸。机制与坑 21 / 24 / 27 完全同源，**错的是修补的范围**：

- 坑 27 的审计单元是**组件**：点到了 `SwitchRow`，就把 `checked` 改成 `@Prop`，收工。
- 而 `title` / `description` 是同一个组件上的**另外两个成员**，同样是下行数据；
  `description` 更是随字号档现算的动态值（`fontScaleDesc()`）。普通成员不参与
  `updateStateVars(params)`，于是它永远停在首帧那条文案上。

**修法**：`SwitchRow.title` / `description` 补 `@Prop`。（`ResourceStr` 是联合类型也能作 `@Prop`
—— `SettingRow.title` 早就这么写、编译器认。）

**验证口径（关键）**：必须在**同一个页面实例内**改档，看说明文字是否**同帧**跟随：
点「＋」→ 步进器 `1.4×` → `1.5×`，说明同步到「应用字号 1.5×」，落盘 `font_scale` 同步为 `1.5`。
「退出再进来才一致」**不算**验证 —— 那只能证明初始帧正确，证明不了更新路径。

**全仓审计（判据三元组：成员是下行数据 × 宿主实例存活 × 值会变；逐个调用点确认）**：

| 结论 | 对象 | 硬证据 |
|---|---|---|
| 本轮新修 | `SwitchRow.title` / `description` | 上述真机同帧复验 |
| 本轮新修 | `SessionRow.session` / `selected` / `rowEnabled` | `ForEach` 键 = `session.id`，**键里不含** `running` / `pendingInteraction` / 标题 —— 坑 21 同型；`ArchivedSessionRow` 的 `session` / `title` / `selected` / `rowEnabled` 同理 |
| 本轮新修 | `WarningBanner.message` | 三个调用点传的是**会变**的参数化文案（`PluginsScreen.problemCount()` / `unavailableReason()`、`SettingsScreen.bridgeVersionText()`），而警示条一旦出现就留在分支里 |
| 已合格 | `StatusLabel.label` / `active`、`SettingRow.title` / `subtitle`、`ChoicePill.selected`、`ProcessGroupRow.expanded`、`ChatStatusBar.rawThinking`、`ModelRowView` / `AgentPresetRow`、两个补全面板 | 坑 21 / 24 / 27 已修 |
| **不是**缺陷 | 全部函数成员（`onSelect` / `onTap` / `onCheckedChange` …） | `@Prop` 深拷贝会连闭包一起拷坏（坑 24 已证），它们也不随父状态变化 |
| **不是**缺陷 | 组件私有字段（缓存 / `Scroller` / `fallback` 兜底对象） | 不是父侧下行数据 |
| **不是**缺陷 | `ForEach` 键里**已含**该动态数据的子组件 | 键变即重建实例，自然自愈：`AttachmentImage` 的键含 `bytes` / `fail`，`MarkdownView` 的块键含正文长度（坑 22） |
| 记账待查 | `QuestionCard.answered` / `ApprovalPanel.submitting` 等**分支内**动态布尔 | 卡片随分支出现/消失，只在「出现期间值又变」时才暴露；本轮无真机证据，登记在 `docs/TECH-DEBT.md` |

**教训（口诀升级）**：坑 21 的口诀是「键里没有的信息，不能靠普通成员传」。本轮再补一条 ——
**审计的最小单元是「成员」，不是「组件」**：一个组件上只要漏了一个动态成员，
整条链路就还是死的。以组件为单位打勾，会精确地漏掉「只改了一半」这种情形。

### UI 迭代顺序（已全部走完）

连接页（并发探活 / DSH1 导入 / 手动配对）→ 会话列表 → 聊天页（以 ChatPresentation 为接缝，
逐组件：消息列表 / 输入药丸 / 思考条 / 工具行 / dsh-ui 卡片 / 审批面板 / 问答卡片 / 附件）
→ 文件页 → 插件页 → 模型页 → 设置页。**五个分节与连接页均已接通**（`AppShell.sectionPlaceholder`
与 `app.string.section_todo` 已删除，不再有任何「尚未移植」的分节占位）。

剩下的不是新页面，而是收尾：签名占位（已落地）→ 打包脚本（已落地）→ LICENSE/NOTICE（已落地）
→ 跨分节导航（已落地）→ `@`/`/` 补全面板（已落地）→ 真机接入与首次装包（已落地，见「收尾五」）。

**UI 层已无明确缺口**：上一轮记下的「唯一剩下的 UI 缺口 = `@`/`/` 补全面板」已在本轮补齐（见「收尾四」）。
§7 末尾的「待真机验证」清单是**唯一剩下的工作**。**设备已接入**（见「收尾五」：签名包已装、
已启动、`aa dump` 确认前台），所以这些条目现在**可以逐条跑了** —— 但仍**不许**因为
"装上了、界面出来了"就说成「跑通了」：装包成功只证明签名/权限/ABI 这一层没问题，
证明不了选择器能弹、手势不打架、路径被服务端认。

### 收尾六：正式发布与上架（2026-10-15）

**打包产物链路**（`.hap` 与 `.app` 是两种东西，别混）：

| 产物 | 用途 | 备注 |
|---|---|---|
| `entry-default-unsigned.hap` | hvigor 原始产出 | 未签名 |
| `…-debugsigned.hap` | 装真机（`hdc`） | 调试证书 + 调试 Profile，**受设备白名单限制** |
| `…-release-signed.hap` | 装真机 / 备用 | 发布证书 + 发布 Profile |
| `…-signed.app` | **上架 AGC 用** | App Pack；AGC **不收** `.hap` |

**注意**：真机上「release 构建 + 调试证书」与上架包**代码完全相同**，只差签名来源 ——
发布证书签的包 `hdc install` 会被拒（`code:9568322 signature verification failed
due to not trusted app source`），因为设备只信任 AGC 调试证书。所以真机复验用调试签名那份，
上架用发布签名那份，**不要以为两者内容不同**。

**踩过的两个坑**：

1. **AGC 只收 `.app`**：传 `.hap` 会被退回「您所上传的软件包不是 HarmonyOS 应用后缀 .app」。
2. **`.app` 必须里外双签**：只签外层时内部 `entry-default.hap` 仍是 `signature not found`，
   上架有被拒风险。正确顺序 —— **先签 hap → 组装 `.app` → 再签 `.app`**，两层都要验签通过。

**签名材料**：发布证书 `*.cer`（含完整链：叶子 → 中间 CA → 根 CA）+ 发布 Profile `*.p7b`
（`type: release`、**设备白名单 0 条**）+ 密钥库 `*.p12`。三者必须配套。
调试 Profile 带设备白名单，签出来的包装不了任意设备，也过不了上架。

**图标**：应用图标加入 `DSH` 字样以区别于其他产品，并**同步进包内 4 处**
（`AppScope` 与 `entry` 各自的 `app_icon.png`、`startIcon.png`）—— 平台要求「应用图标必须与包内
图标一致」，只改交付文件会造成不一致。另出 1024×1024 平台图标（AGC 规格：216 或 1024）。
原图仅 216×216，放大 4.74 倍会发虚，故按实测几何**矢量重绘**（4 倍超采样）并逐像素校验与原图一致。

**上架材料**：`docs/store-listing.md`（中英文文案：一句话简介 ≤17 字 + 应用介绍）、
`docs/screenshots/`（6 张介绍截图，1080×1920 严格 9:16）。真机原生截图是 1080×2440（约 9:20），
与要求不符，故**裁掉底部 520px**、保留状态栏与顶栏。

**版本库管理（2026-10-15 纳入 git）**：

- `git init` + 首笔 `feat:` 提交；提交信息遵循 Conventional Commits
- `docs/CHANGELOG.md`：Keep a Changelog 1.1.0 格式 + SemVer 2.0.0；**每次改动先追加 `[未发布]` 段**
- `README.md`：项目简介、构建/签名/测试命令、工程结构、文档索引
- `.gitignore` 关键策略：**`signing/` 整体忽略**（私钥 `.p12` 绝不入库）、构建产物与包扩展名兜底、
  `oh-package-lock.json` 改入版本库以锁定依赖环境

### 收尾七：按域拆分 7 个超长文件（2026-10-15 用户要求）

用户原话：「现在对行数超的 按照 900 行左右拆分，拆分不能影响原功能」。
把 `TECH-DEBT.md` 在册的 7 个文件拆到 **每个 ≤ 900 行**（原预算 1 000，本轮收紧到 900），
**对外接口与行为完全不变**：判据 `BUILD SUCCESSFUL` + **531 用例全绿**（用例数未降）。

**Split 后的文件清单与行数** 见 §1 结构树；每个原文件 → 产物 → 最大行数的对照见
`docs/TECH-DEBT.md` 的「在册文件 → 清账记录」表。

**ArkTS 拆分踩到的四个坑（都不是逻辑问题，是平台/工具链问题）**：

1. **跨文件共享私有状态只有「继承」一条路，且继承单向。** 拆 ViewModel 不能靠「组合 + 传
   `this`」，因为 `private` 成员跨文件不可见。于是 `HarnessViewModel` 被拆成一条**继承链**：
   `HarnessViewModelBase` → `Catalog` → `Files` → `Sessions` → `Composer` → `Connection`，
   中间层按依赖拓扑排。**顺序不能乱**，乱了就是「用了父类里没有的成员」。
   两处机械改写：类内 `private` → `protected`；方法体内 `const self: HarnessViewModel = this;`
   → 各自文件自己的类名（否则类型不符）。
2. **构造末尾不能反向依赖最后一层，会成环。** 基类构造里原本 `restoreConnection()` 直接调用
   —— 但 `restoreConnection` 在 `Connection` 层（最底层）。改成**可覆盖钩子**：基类构造调用
   `this.startRestore()`（空实现），`Connection` 层覆盖它去调 `restoreConnection()`。
   与 Kotlin 的 `init { restoreConnection() }` 语义等价。
3. **`export { X } from './Y'` 转发导出可保 barrel 对外名字不变**；但 **interface / 纯类型
   必须用 `export type { X }` 再导出** —— 用 `export {}` 的话，ArkTS 编译能过，而 **node 侧
   （tsx/esbuild）运行期**会报 `does not provide an export named 'X'`，直接把整个测试文件
   加载失败（实测用例数从 531 掉到 443）。这是「编译期绿、运行期炸」的典型，必须记住。
4. **本工作区 Edit 工具偶发「改动不落盘」**；每次编辑后都用 `grep` / 逐行复核，必要时改用
   python 脚本切片改写（拆分本身即用切片脚本，不手抄，保证搬走的成员体**逐字节命中**）。

**字节保持性核验**：用 git 原文行多重集比对各拆分文件，所有「丢失」行**全部可解释**为上述
机械改写（import 重排、加 `export` / `protected`、`self` 类型标注、调用点改写），**零无法解释的丢失**。
`ui/ChatDetail.ets` 拆分另用脚本核验：括号配平、搬走成员逐字节命中、父组件无残留/缺失成员、
无悬空 `this.xxx(` 调用、两个新文件 import 无未用符号。

**顺带清理**：`ChatDetail.ets` 拆分后残留 25 个已随搬移变为无用的 import，本轮一并删除
（拆分产物，非原有代码；不影响功能）。

### 收尾八：多远端托管与重出上架包（2026-10-16 用户要求）

用户原话：「在 Gitee/GitHub 你建仓，写好各种文档，本地提交，出包，提交等流程，我的 Gitee/GitHub
信息本地应该有」。

**远端（同一 `master`，每个远端各一份）**：

| 远端 | 地址 | 角色 |
|---|---|---|
| `origin` | `https://github.com/westanke/dsh-companion-harmony` | 主（`master` 跟踪它） |
| `gitee` | `https://gitee.com/westanke/dsh-companion-harmony.git` | 镜像（国内访问） |
| `atomgit` | `https://atomgit.com/westanke163/dsh-companion-harmony.git` | 镜像（国内；**账号名与 GitHub / Gitee 不同**） |

> AtomGit 已于收尾十一补入；因 github.com 不稳定，另立「镜像 → GitHub」自动同步链，详见收尾十一。
> ⚠️ AtomGit 账号是 **`westanke163`**，而 GitHub / Gitee 是 `westanke` —— 照抄 GitHub 用户名
> 会得到一个不存在的仓库（表现为 `403 / project could not be found`，极易误判成「仓库没建」）。

三个远端 `master` 指向同一提交 —— 推送后必须**逐远端 `git ls-remote --heads <r> master` 核验**，
不能只看本地 `HEAD`（本地与远端不一致时 `git log` 是自欺）。

**建仓踩到的两个坑**：

1. **Gitee OpenAPI 的 `private=false` 会被当成真值**。用 `-d "private=false"`（form 编码）建出来的
   是**私有仓** —— 表单值是字符串，Gitee 侧判非空即 `true`。建仓后必须回查 `private` 字段确认，
   别只看创建成功的返回。补救：**先推内容再改可见性** —— Gitee 对**空仓**调 `PATCH ... private=false`
   会返回 `400 Bad Request`（空仓不允许转公开），推完第一笔再改就成功。
2. **建仓后两个远端都要显式验证可达**：`gh repo create --source=. --remote=origin --push` 会把
   upstream 设为 `origin/master`；再用 `git push -u gitee master` 会把 upstream **改写成 `gitee/master`**。
   若希望 GitHub 为主，需显式 `git branch -u origin/master master` 改回来。

**重出上架包**：10-15 打的 `…-signed.app` 早于坑 23 / 坑 24 两条修复，**内容已过期**。本轮按
`RELEASE.md` 流程重出（`assembleApp -p buildMode=release` → 签内部 hap → 组装 `.app` → 签外层），
内外层均 `verify-app` → `Verify success`。产物：

| 文件 | 用途 |
|---|---|
| `dsh-companion-harmony-1.0.0-release-signed.app` | 上架 AGC（发布证书，里外双签） |
| `dsh-companion-harmony-1.0.0-release-debugsigned.hap` | 真机安装（调试证书） |

> **两层内容完全相同**，只差签名来源（见上「收尾六」的注意事项）。
> 版本号**仍为 1.0.0**：该版本**尚未上传 AGC**，本次是把「未发布的 1.0.0 包」纠正为含修复的版本，
> 故不递增 `versionCode`（`RELEASE.md` 的「每发版 +1」针对的是**已发布**版本）。
> 若 1.0.0 已上传 AGC，则必须改 `module.json5` 的 `versionCode` 1000000 → 1000001、`versionName` → 1.0.1
> 后重出（AGC 拒绝重复的 `versionCode`）。
> **注（2026-10-16 补充）**：审核报告的存在证明 1.0.0 **确已上传**，上述条件成立 —— 已按此改为
> **1.0.1** 并重出，详见下「收尾九」。

### 收尾九：按 AGC 审核意见修图标并重出 1.0.1（2026-10-16）

用户原话：「`/media/wangke/OFFICE/TRae_work/5d1dadb5bf0644a59d1905884fc80720.zip` 上架审核报告，
审核未通过，共检测出错误问题 7 个」。

**报告实际内容**：zip 内是两份 `…_dataPackage_7.1.1.4.3_dataPackage.zip`，各含一个同名 txt，内容
**完全相同** —— 对应 10-15 的**两次送审**记录；去重后**只有 1 条问题**（应用图标 216×216 单层图，
见坑 25）。随包附带的 `…_app_icon.png` 取样实测 216×216，与报告描述一致。

> ⚠️ 报告里只拆出 **1 条**，而用户说「**7 个**」—— 差 6 条未在 zip 中体现。**已向用户确认**是否另有
> 报告或在 AGC 网页上看到更多条目；**未答复前不得臆测补修**（猜错会再把包送驳回一次）。

**修复内容**：①图标改 1024×1024 **分层**（坑 25）；②版本号 1.0.0 → **1.0.1**（`versionCode` 1000001）
—— 「收尾八」里写的「若已上传则必须升版」条件成立：审核报告的存在本身即证明 **1.0.0 确已上传**，
故此前把 1.0.0 包的修复留作「同版本纠正」的写法**据此作废**（同 `versionCode` 重传会被平台拒）。

**重出流程与产物**（同「收尾八」，只换版本号）：

| 文件 | 用途 |
|---|---|
| `dsh-companion-harmony-1.0.1-release-signed.app` | 上架 AGC（发布证书，里外双签） |
| `dsh-companion-harmony-1.0.1-release-debugsigned.hap` | 真机安装（调试证书） |

三个产物（外层 `.app` / 内部 hap / 真机 hap）`verify-app` 均 `Verify success`；真机核对
`versionCode` 1000001 / `versionName` 1.0.1，桌面图标渲染正常（见 §7 第 26 条）。

### 收尾十：去品牌改名 + 换 bundleName + AI 标识 + 重出上架材料（2026-10-16）

**起因**：AGC 驳回 7 条。其中「应用名称与第三方应用相似且无授权」是**身份级**问题（见坑 26），
「AI 生成文本内容未提交标识材料」是**内容级**问题（本轮补代码）。

**代码侧**：
1. `ui/ChatMessage.ets` 助手消息分支底部新增一行 `$r('app.string.ai_generated_notice')`
   （「内容由 AI 生成」/「Content generated by AI」，次要色 11fp）—— 显式标识落点。
2. 改名去品牌，清单见坑 26（`app.json5` + 两侧资源 + `ErrorMessages.ts` + `oh-package.json5`）。

**签名侧**：AGC 新建应用 → 重新签发调试 / 发布证书与 Profile。
`build-profile.json5` 的 `signingConfigs` **仍保持空数组**（hvigor 拒收明文口令这条结论不变），
但注释已更新为新的中文 / 含空格材料名，并强调**命令行必须加引号**。

**上架材料重出**：
- 6 张应用截图（1080×1920，9:16），1.0.2 真机重拍；旧 6 张已删（`01-connect.png` 带旧品牌标题）
- `ai-generated-label-evidence.png`（1080×2440 原图）—— 对应「AI 生成内容显式标识」审核项
- `dsh-companion-harmony-1.0.2-demo-walkthrough.mp4`（1080×2440，约 103 秒）—— 对应
  「需提供遍历使用的演示录屏」审核项

| 文件 | 用途 |
|---|---|
| `dsh-companion-harmony-1.0.2-release-signed.app` | 上架 AGC（发布证书，里外双签） |
| `dsh-companion-harmony-1.0.2-release-signed.hap` | `.app` 内层（发布证书） |
| `dsh-companion-harmony-1.0.2-release-debugsigned.hap` | 真机安装（调试证书） |
| `dsh-companion-harmony-1.0.2-demo-walkthrough.mp4` | AGC「自测文件」演示录屏 |

**判据**：`BUILD SUCCESSFUL` + `531/531` + 三个包 `verify-app` 均 `Verify success` +
真机 `versionCode` 1000002。

> **1.0.0 / 1.0.1 的包全部作废**：1.0.0 图标为 216×216 单层图；1.0.1 仍带旧 `bundleName`
> 与品牌名，且旧 Profile 已随旧应用失效。

**演示录屏的录制口径**（下次复用照此做，不必再摸索）：
- 设备**没有** `screenrecord` / `rec`，系统录屏应用 `com.huawei.hmos.screenrecorder`
  不允许 `aa start` 调起（权限被拒）→ 只能**抓帧合成**。
- 抓帧与 UI 操作**可并发**：`hdc shell` 里跑 `while` 循环 `snapshot_display`，同时另开
  `uitest uiInput click/swipe` 驱动界面；实测约 **3 fps**，成片再用
  `ffmpeg -framerate 2.9 -i f_%04d.jpeg -vf fps=15` 升到 15 fps。
- 坐标口径：`uitest uiInput click x y` 用**屏幕物理像素**（本机 1080×2440），不是 vp。
- 三个坑：① 中文用 `inputText` 直接送（实测可送「你好」）；② `keyEvent Back` 可收键盘；
  ③ **通知横幅会抢掉同一坐标**（☰ 在 63,209，横幅也在顶部）—— 点错就跳到别的应用，
  故拍摄前先把应用拉回前台，并在每次 ☰ 前留足等待。

### 收尾十一：AtomGit 镜像与「镜像 → GitHub」自动同步链（2026-10-16 用户要求）

用户原话：「推双端，另外也要推atomgit，github网络访问问题多，可否让github同步atomgit和gitee」。

**问题**：本机到 `github.com:443` 不稳 —— `git push` 先报
`gnutls_handshake() failed: The TLS connection was non-properly terminated`，改 `-c http.version=HTTP/1.1`
重试后又 `Failed to connect to github.com port 443: Connection timed out`；但同一时刻
`api.github.com` 返回 200、`ssh.github.com:443` 可达、本机**无任何代理端口**。
即「GitHub 主站被断、API 通」，与 `RELEASE.md` ⑦ 记的一致。

**解法一（常规）：镜像 → GitHub 的单向自动同步链**。新增
`.github/workflows/sync-from-mirrors.yml` —— Runner 跑在 **GitHub 服务器上**（出网正常，能访问
`gitee.com` / `atomgit.com`），定时（每 30 分钟）或手动 `workflow_dispatch` 触发，
逐镜像 `git fetch` → `git merge --ff-only` → `git push origin master`。
- 方向是**镜像补齐 GitHub**，非双向；GitHub 上新增的提交不会反向推回镜像。
- **只做快进**：镜像与 GitHub 分叉时跳过并报错，**绝不强推**（GitHub 上可能有镜像没有的提交）。
- **默认 workflow 权限是 `read`**（本仓实测 `default_workflow_permissions: read`），故 workflow 里
  必须显式 `permissions: contents: write`，否则 `GITHUB_TOKEN` 推不回去。仓库 Actions 已启用
  （`enabled: true` / `allowed_actions: all`）、仓库 public。
- 不可达 / 不存在的镜像由 `git ls-remote` 预检后跳过，因此 AtomGit 仓库尚未建好也不影响 Gitee 同步。

**实测（2026-10-16，`workflow_dispatch` 手动触发 run `38896654332`）**：
`✓ 逐个镜像快进并推回 GitHub` —— 日志显示 `===== 镜像 gitee =====` →
`From https://gitee.com/westanke/dsh-companion-harmony` 拉取成功 → `Already up to date` →
`完成：gitee → GitHub 已快进到 88b254e`；`===== 镜像 atomgit =====` → `跳过：仓库不可达或还不存在`。
- **即「GitHub 侧 Runner 能正常访问 gitee 并回补」已成立**。

- **坑 C（2026-10-16 实测踩到，且会永久卡住整条链）：`GITHUB_TOKEN` 改不了 workflow 文件。**
  run `38901422594` 从 Gitee 拉到了含 `.github/workflows/sync-from-mirrors.yml` 改动的新提交，
  推回 GitHub 时被拒，原文：
  `! [remote rejected] HEAD -> master (refusing to allow a GitHub App to create or update workflow
  .github/workflows/sync-from-mirrors.yml without 'workflows' permission)`。
  **这不是网络问题、也不是 `contents` 权限不够** —— 即使把仓库默认 workflow 权限提到 `write` 也没用：
  `GITHUB_TOKEN` 天生不带 `workflows` 权限，`--force` 同样无效。
  所以**凡是改动 `.github/workflows/` 的提交，镜像链一律代推不了**，只能用直推或 REST 补推
  （用户令牌带 `workflow` scope 即可；本账号 `gh auth status` 确有该 scope，故 REST 补推能改 workflow）。
  **更麻烦的是它会一直卡下去**：后续每次快进都包含那个 workflow 提交 → **整条链停摆**，
  且会被误当成偶发网络抖动而反复重试。故 workflow 里加了显式诊断：推回失败时若发现
  待推送区间含 `.github/workflows/`，就打出上述结论与处置办法 —— **不许沉默**。
  **加固（2026-10-16 用户「写凭据」授权后已执行）**：把带 `workflow` 权限的 PAT 写进仓库 secret
  `SYNC_PAT`（`gh secret set SYNC_PAT`，`gh secret list` 可见），并让 `actions/checkout` 用它检出：
  `token: ${{ secrets.SYNC_PAT || github.token }}`。表达式带 `|| github.token` 兜底 ——
  secret 缺失时退回默认令牌，普通提交照样能推、只有 workflow 提交失败，退化得比整条链挂掉温和。
  至此**含 workflow 改动的提交也能由镜像链自愈**，坑 C 的「永久停摆」被消除。
  安全提示：本条写入的是 `gh` 的 OAuth 用户令牌，其 `repo` scope 是**账号级**的，
  存进本仓 secrets 意味着本仓 Actions 可读写该账号**所有**仓库；更稳妥是改用**仅限本仓的
  fine-grained PAT**（需在网页创建），已向用户提示待其定夺。
  **端到端验证（2026-10-16，run `38902595071`）**：特地做一笔**只推镜像**、且含 workflow 改动的
  提交（`7dd40c4`），再 `gh workflow run` 手动触发本链。日志关键行：
  `Updating a7f4ebb..7dd40c4` → `Fast-forward` → `.github/workflows/sync-from-mirrors.yml | 4 ++++`
  → `To https://github.com/... a7f4ebb..7dd40c4  HEAD -> master` → `完成：gitee → GitHub 已快进到 7dd40c4`。
  **同一动作在坑 C 里用 `GITHUB_TOKEN` 时是被拒的**，此处成功即证 PAT 生效、坑 C 已闭环。
  事后三端（本地 / GitHub / Gitee / AtomGit）`master` 同为 `7dd40c4`。

**解法二（应急）：GitHub REST API 补推**（Actions 未跑或不可用时手动补齐）。本次已实测跑通
（本地 `e8977be` 经 API 补齐后，GitHub / Gitee / 本地三方 SHA 一致），两个坑记下：
- **坑 A：提交信息必须取原始字节**。`git log --format=%B` 经 shell 命令替换会**吃掉结尾换行**，
  复刻出的 commit SHA 与本地差一字节、对不上 —— 首次就栽在这里（tree SHA 一致、commit SHA 不一致）。
  改用 `git cat-file commit HEAD` 取 `\n\n` 之后的全部字节。
- **坑 B：三层 SHA 都要断言**。blob SHA 由内容决定、天然可比；tree / commit SHA 需逐层与
  `git rev-parse` 期望值比对，**commit SHA 必须等于本地 `HEAD`** 才能 `PATCH ref`，否则就分叉了。
  最后回查 `<远端> master` 是否等于本地 `HEAD`。

**AtomGit 建仓（2026-10-16，用户要求「你自己建」）—— 用它的 OpenAPI，不必登录网页**：

- **API 宿主与鉴权**：`https://api.atomgit.com`（**不是** `atomgit.com`，后者是网页/仓库地址）；
  鉴权头是 **`Authorization: Bearer <token>`** —— 注意**不是** Gitea 风格的 `token <t>`，
  用错会得到 `401 UNAUTHORIZED / "token not found"`（一个会让人误以为 token 失效的假象）。
  token 取自本地 `~/.git-credentials` 的 atomgit 条目（与 `git push` 用的是同一个），
  不必再让用户登录或另发令牌。
- **建仓接口**：`POST /api/v5/user/repos`，JSON 体 `{name, private: false, auto_init: false, description}`。
  返回体里 `private: false` / `public: true` 即公开仓。**已实测创建**
  `westanke163/dsh-companion-harmony`（仓库 id `11090856`，`default_branch` = `master`）。
  判别可用：`GET /api/v5/user/repos` 列自己的仓、`GET /api/v5/repos/<owner>/<repo>` 查单个。
- **仓库地址族**（注意 AtomGit 自己的账号名是 **`westanke163`**，与 GitHub / Gitee 的 `westanke` **不同**）：
  网页 `https://atomgit.com/westanke163/dsh-companion-harmony`、
  clone `https://atomgit.com/westanke163/dsh-companion-harmony.git`。
- **推送**：`git remote add atomgit <clone 地址>` → `git push -u atomgit master`。
  推完**要记得把上游改回** `origin/master`（`git branch --set-upstream-to=origin/master master`），
  否则 `git push -u` 会把 `master` 的跟踪分支悄悄改成 `atomgit/master`，
  与「`origin` 是主」的约定不符。三端核验：`git ls-remote --heads <r> master` 逐个等于本地 `HEAD`。

### 收尾十二：演示录屏合规化（时长 + 宽高比）（2026-10-16 用户要求）

AGC 驳回「自测文件」里上传的演示录屏，原文：

> 上传素材不符合要求，请重新上传。
> 当前视频文件时长：136 秒，要求：15 秒至 120 秒。
> 当前视频文件宽高比：120:271，要求：9:16。

源为用户自录 `8c848cac491bdc15f947b0022293e1ce.mp4`。**两个指标各差一点，但都属硬约束**。

**探测（先量后动，别猜）**：`ffprobe -show_entries stream=width,height,duration` 得 `720×1626`、`136.34s`。
- `720/1626 = 0.4428`，约简正是 `120:271` —— AGC 报的比值就是把宽高约分后的结果，故**判据可直接用宽/高比**。
- 分辨率仅 720 宽（远低于 1080），后续按 1080×1920 出片时**必然有放大**，属可接受范围。
- 音轨是 **数字静音**（`ffmpeg -af volumedetect` 报 `mean_volume: -91.0 dB`）—— 录制时没录到声音，
  故输出直接 `-an` 去掉音轨，不必补音乐（也避开版权与「AI 生成」标识的新麻烦）。
- 检查源帧时间戳（`ffprobe -show_entries packet=pts_time`）：**无同刻重复帧**，间隔以 0.016s（60fps）与更大间隔混合
  —— 即**变帧率**：静止时低、动效突发时 60fps。故强制输出 30fps 时 `drop` 数很大是**正常降采样**，不是丢内容、也不会卡。

**关键决策：加边而不是裁切。** 直觉（也是先想到的）是把超高的画面裁成 9:16 ——
`720×1626` 裁到 `720×1280` 要**砍掉 346px（21%）**。但**实测抽帧一看就不能裁**：
会话页（`-ss 60`）顶部是状态栏 + 应用头（DSH 伴侣 / 会话），底部是输入框（「运行中… 发送即排队」+ 发送键），
这 21% 无论切上还是切下都会**丢掉演示的关键界面元素**，而演示录屏恰恰要靠这些说明能力。
**故改为「模糊铺底 + 居中满高」**：前景按高度缩到 1920（宽度自然得 850），左右各 115px 用
**该帧自身放大模糊压暗**填满 —— 既不裁内容、又不是黑边（黑边观感差且显得没做处理）。

**时长处理：变速而不是剪尾。** 需砍 16.34s。整段是一条连续的遍历叙事（连接管理 → 会话浏览 → 抽屉 →
设置），剪尾会缺收束、剪头会缺开场。**1.16 倍变速**（`setpts=PTS/1.16`）保住全部内容，
`136.34/1.16 ≈ 117.4s` 落在 15–120s 内且留有余量；UI 演示快 16% 不影响可读性。
（注：因无音轨，**不需要** `atempo` 配平音频。）

**一条命令（实测产出即最终交付物）**：

```
ffmpeg -i <源>.mp4 -filter_complex "\
[0:v]setpts=PTS/1.16,split=2[a][b];\
[a]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,gblur=sigma=6,\
   scale=1080:1920:flags=bicubic,eq=brightness=-0.10:saturation=1.05[bg];\
[b]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos[fg];\
[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]" \
 -map "[v]" -an -c:v libx264 -preset fast -crf 20 -profile:v high -level 4.0 \
 -r 30 -movflags +faststart -y dsh-companion-harmony-1.0.2-demo-9x16.mp4
```

要点与坑：
- **背景走「小尺寸模糊再放大」**（`scale=270:480` → `gblur` → `scale=1080:1920`）而不是直接在大图上
  `gblur`：直接模糊 1080×1920 代价极高（实测 `gblur` 全尺寸会拖到不可接受），小图糊完再放大视觉等价。
- `force_original_aspect_ratio=increase`（铺满）与 `=decrease`（装下）各用一次：前者给背景、后者给前景。
- `-ss` 抽帧核对构图时**不要用 `fps` 滤镜做静止段分析**：本文件的变帧率 + 容器时间戳在该滤镜下会
  产出**远超真实帧数**的重复帧（实测得出「总长 3329s」的假数据），会把人带偏；判断静止请用
  `ffprobe -show_entries packet=pts_time` 看真实时间戳间隔。
- 产物体积 37.4MB / 117.367s，比源（27.4MB / 136.34s）大 —— 因为分辨率从 720×1626 提到 1080×1920，
  属预期，不是参数没调好。

**验收判据（转完必须复量，别凭感觉）**：`ffprobe` 必须同时满足
`width=1080 & height=1920`（比值 9:16）与 `duration ≤ 120`（本次 117.367）。
旧产物 `…-1.0.2-demo-walkthrough.mp4`（1080×2440，比值 `27:61`）**同样不合格，已作废**。

**教训**：上一版录屏是**直接拿手机原生分辨率录的**（1080×2440），手机屏天生比 9:16 更修长，
**不处理就一定不合格** —— 出片前先把 `width/height` 与 `duration` 量一遍，
别等提交到 AGC 再被打回。

---

### 收尾十三：修 AGC 稳定性驳回 —— 剪贴板读到 `undefined` 把应用整进程杀掉（2026-10-20）

**驳回原文（用户转来的 AGC 上架检测，测试机 Mate 60 / HarmonyOS 6.1 / API 6.1.1(24)）**：

```
测试步骤：1. 应用在运行中存在 JsCrash 异常的问题，
         原因：Generated by HiviewDFX@OpenHarmony___
               at anonymous (entry|entry|1.0.0|src/main/ets/ui/ConnectScreen.ts:993:1).
```

抓到的故障包（`8fefb357…zip`）里信息比上面这一行多得多，逐条读下来才有结论：

| 字段 | 值 | 用处 |
|---|---|---|
| `Version:1.0.2` / `VersionCode:1000002` | —— | 被检测的是 **1.0.2**，不是 1.0.3 |
| `Error message` | `Cannot read property length of undefined` | 是「对 `undefined` 取 `.length`」，不是空指针别的形态 |
| `HybridStack` 里 | `TouchEventTarget::HandleMultiContainerEvent` → `PipelineContext::OnTouchEvent` | **由触摸触发**，不是流式回调、不是定时器 |
| `HiLog` 异常前一行 | `PBJS: GetPrimaryText# Get GetPrimaryText failed` | 框架自己在抱怨「拿不到主文本」 |
| `HiLog` 末尾 | `com.dsh.westanke is about to exit due to RuntimeError` → `Kill Reason:Js Error` | 结局是**进程被杀**，所以用户观感就是闪退 |

**坑 41：平台 API 的「类型声明」不等于「运行时实际给什么」—— `getPrimaryText()` 声明 `string`，实到给 `undefined`**

`pasteboard.PasteData.getPrimaryText()` 在 ArkTS 里签名是 `(): string`。照着签名写代码，
下面这句在**编译期**完全合法、看不出一丝问题：

```ts
const text: string = readClipboardText();   // 实到拿到 undefined
if (text.length > 0) { ... }                // ← 抛 TypeError
```

运行时它并不保证给字符串：剪贴板里没有文本记录（复制的是图片/文件）、应用没有读权限、
或系统只返回一条空记录时，它给回的是 `undefined`（**没抛错，就是安静地给错值**，
这也是为什么 `try/catch` 兜不住 —— 异常根本没发生）。

三个「为什么这坑值得单独记」：

1. **编译期门禁对它无效**。`text.length` 是 `string` 上的正常操作，类型检查、lint、
   单测若照着声明的类型写夹具（传 `''`、传 `'内容'`）全都不会红。**只有真机 + 真实剪贴板状态**才暴露。
2. **代价被平台放大了**。同样一个 `undefined`，在普通 JS 里顶多是这次点击没反应；
   在 ArkUI 里回调内未捕获异常会 **kill 掉整个进程**（日志原文
   `about to exit due to RuntimeError` / `Kill Reason:Js Error`）。**「这次操作失败」与「应用闪退」
   之间只差有没有人兜住**——所以每个平台返回值进业务判断前都值得过一道归一。
3. **兜法不能顺着类型声明写**。写成「`if (raw === undefined)`」或依赖类型收窄，
   等于承认「声明是对的，undefined 不可能来」，日后有人顺手删掉这条分支时看不出删错了；
   所以判据取 **运行时 `typeof raw !== 'string'`**，并把这段逻辑放进 `core/ClipboardText.ts`
   的 `normalizePrimaryText()` —— `platform/` 层按工程约定不做离线单测（见 §6.1 与
   TESTING「平台层自检」），留在那里就只能靠人眼保证「修好了」。

**改动落点**：`core/ClipboardText.ts`（新，纯函数 `normalizePrimaryText`，含 6 条回归用例
`test/cases/clipboard-text.test.ts`）+ `platform/Clipboard.ets`（`readClipboardText()` 改走它，
**保证返回字符串**）。全仓只有 `ConnectScreen.ets` 一个调用点（粘贴按钮），一处覆盖全部路径。

**逐行对齐的取证方式**（值得复用）：栈里的 `ConnectScreen.ts:993:1` 指的是**编译产物**的行号，
不是源文件行号 —— 源文件只有 788 行，看到 993 不要以为对不上就放弃。编译中间产物留在

```
entry/build/default/cache/default/default@CompileArkTS/esmodule/release/entry/src/main/ets/ui/ConnectScreen.ts
```

直接读它第 993 行，那里就是粘贴按钮的 `onClick` 回调体（`readClipboardText()` → `text.length`），
与源文件 `ConnectScreen.ets:598` 那唯一一处调用点对上 —— **这条链把「猜」变成了「对上了」**。

### 收尾十四：对标源 v2.2.43–v2.2.46 增量移植（2026-10-20，进行中）

源工程在本工程基线（tag `v2.2.42` / commit `e1b8c13`）之后又推了 6 个提交。逐提交对照与处置：

| 源提交 | 标题 | 处置 |
| --- | --- | --- |
| `a96f5e7` | 工具调用专用块 + 权限档位 Pill | **已完成**：工具块数据层 + 界面接入（`core/ToolBlocks.ts` + `ui/ToolBlockBody.ets`）；权限档位 Pill 走独立候选目录接口（见下「本轮已完成」6，坑 47） |
| `a344e3f` | 会话页九条交互整改 + 权限档位打通 + 文件链接可打开 | 文件链接部分**已端到端移植**（`core/PathLinks.ts` + `core/InlineSegments.ts` + `ui/InlineText.ets` + 渲染 / 点击接入 + `ChatLinkTarget.classify` 剥壳，见「本轮已完成」5）；权限档位打通见 6；其余九条交互整改随后 |
| `9863579` | 存量改动（错误文案 / 截断提示 / 连接导入面板 / 偏好 / 设置页 / 诊断基建） | 随后（用户可见项优先） |
| `e609b04` | 后台任务面板（会话 ⋯ 菜单 →「后台任务」） | **已完成**：`core/JobViews.ts` + `core/DshClient.ts` 三端点 + `core/HarnessViewModelJobs.ts`（继承链第 7 层）+ `ui/JobsSheet.ets` + `ui/ChatHeader.ets` 入口（能力位 `job-list-v1` 守卫）。见「本轮已完成」7、坑 50、坑 51 |
| `f02c5b9` | 表格紧贴上一行被渲染成竖线纯文本 | **刻意未移植**（见坑 43） |
| `bfa9aed` | 补三组回归用例（发送键三态 / 正文文件链接化 / autolink 尖括号） | 判据已并入本轮新增用例 |

**本轮已完成**（全部离线可验，未上真机）：

1. `core/ToolBlocks.ts`（新）+ `test/cases/tool-blocks.test.ts` 19 例 —— 工具调用专用块投影。
2. `core/PathLinks.ts`（新）+ `test/cases/path-links.test.ts` 11 例 —— 正文已知文件名链接化。
3. `core/ChatLinkTarget.ts` 补 Markdown autolink 尖括号剥壳 + `chat-link-target.test.ts` 补 4 例。
4. `ui/ToolBlockBody.ets`（新）+ `ui/MessageParts.ets` 分派 —— 专用块的**界面接入**（见坑 44、坑 45）。
5. `core/InlineSegments.ts`（新）+ `ui/InlineText.ets`（新）+ `test/cases/inline-segments.test.ts` 13 例
   —— 正文文件链接化的**渲染接入**：切分（`[文字](目标)` → 普通文字 / 链接）→ 渲染（`Text` + 逐段 `Span`）
   → 点击分流（服务端路径开文件面板 / `http(s)` 外部浏览器 / 相对路径拼 cwd / 其余提示不支持）；
   候选清单取自 `sessionFileList`（与「本会话的文件」面板同一出处）并跟随投影缓存。见坑 46。
6. **权限档位 Pill** —— `core/ModelsConfig.ts` 的 `PermissionCatalog` + `core/DshClient.ts` 的
   `permissionPresets()`（**404 容忍**）+ `HarnessViewModelConnection.loadSnapshot` 连接时拉取一次
   （**失败自己吞掉、不连坐整条连接，也不擦掉已有目录**）+ `permissionSelectOf(history, catalog)`
   （内联 options 优先，缺失才用目录兜底；档位名走 `currentValue` → `preset` → `sandbox` 降级）
   + `ui/ChatHeader.ets` 顶栏小胶囊与 ⋯ 菜单标题行修复（**候选为空也照渲染**）。见坑 47。
7. **后台任务面板**（源 `e609b04`，需 bridge ≥ 2.4.3）—— `core/JobViews.ts`（新，wire 类型 +
   `isJobLive` / `jobDurationText` / `killWasRequested` 三个纯函数）、
   `core/DshClient.ts` 的 `sessionJobs()` / `jobOutput()` / `killJob()`（会话维度三条路由，
   信封是 `{jobs:[…]}` 而非别处的 `{items:[…]}`）、`core/HarnessViewModelJobs.ts`（新，
   继承链第 7 层，`openJobsPanel` / `closeJobsPanel` / `loadJobs` / `killJob` / `toggleJobOutput`）、
   `ui/JobsSheet.ets`（新，面板）、`ui/ChatHeader.ets`（`SHEET_JOBS` + ⋯ 菜单项 + 关闭即清状态）、
   `core/HarnessTypes.ts`（`JobsPanelState` 进共享状态）、`core/BridgeCapabilities.ts`
   （`job-list-v1` 能力位守卫，`supportsJobListing()`）。**入口按能力位守卫**：读不到能力位一律不显示。
   **行为判据**：`already-finished` ≠ `requested` 两种反馈文案；`lossy` 必须亮出来；
   清单读失败不擦旧清单也不谎报「没有任务」；「存活中」用白名单判（见 `isJobLive` 注释）。
   **v1 不实时推送**（REST 一帧 + 刷新按钮）。
   本轮还顺带把 `DshClient` 的传输层拆成 `core/DshTransport.ts`（**行数预算**所致，对外接口零变化），
   并修掉四处 POST 端点的双份基地址（坑 50）。新增 `test/cases/jobs-panel.test.ts`（24 例）
   与 `dsh-client.test.ts` 的后台任务 10 例。
8. **真机体感三修（接线层，2026-10-20）** —— 用户真机反馈驱动，**不属于源工程增量**，
   三条都是「编译绿 + 纯逻辑单测绿，但界面不对」的接线缺陷：
   ① **会话文件面板拿到过期状态快照**（点文件只弹路径、再点一次才出内容）——
   `ui/SessionFilesSheet.ets` 改为自订阅（`@StorageLink('dshRevision')` + `harnessState()`），
   父组件 `ChatHeader.sheetContent()` 只传回调；详情态去掉 `@State kind`（改每帧现算，
   避免图片/PDF 在字节到位后被当文本渲染）。见坑 52。
   ② **同面板下方大留白** —— 两层都要改：列表 `.height('72%')` 改
   `constraintSize({ maxHeight: 420 })`，**外加**宿主根容器去掉 `.height('100%')`
   （只改内层时真机依旧贴满，见坑 53）。
   ③ **连接页失败时一片「连接」** —— 新增 `ui/ErrorText.ets` 抽出 `localErrorText()`，
   `ui/ConnectScreen.ets` 接上与 `AppShell` 同一套的报错（`@Watch` + `lastReported` +
   `clearError()`）；主机按钮加第三档「重试连接」（`connect_retry`）。见坑 54。
   ④ **思考条展开后没有收回入口** —— 标题行常驻 + `⌄`/`⌃` 箭头，`onClick` 只挂标题行。见坑 55。
   新增 `test/cases/ui-wiring-guard.test.ts`（4 例源码形状门禁）。
   **真机（2026-10-20，`a709c2c` + 根容器修复包）**：①②④ 均已验通 ——
   文件详情**首次点击即出内容**（33.2 KiB `text/plain` 正文直接渲染）；列表面板从贴满屏收缩到
   内容高度（标题从 y=171 移到 y=730，列表按 420vp 上限内部滚动、下方无空白）；
   思考条展开后标题行仍在、箭头翻成 `⌃`、正文限高 720px（240vp），再点收回。
   ③ 的断网三档与失败报错另见 TESTING 真机验收表。

**坑 42：ArkTS 没有判别联合类型 ——「四种长相」只能用单类 + `kind` 字段承载**

源工程用 `sealed interface ToolBlockView` + 四个 `data class`，`when (view)` 里靠类型收窄分支。
ArkTS 严格模式下既没有 sealed 也没有收窄，于是 `ToolBlocks.ts` 用**单类 + `ToolBlockKind` 判别字段**：
不适用当前形态的字段留默认值，表现层先看 `kind` 再取值。看着不如四个类「干净」，
但在 ArkTS 里拆成四个类反而要写四组空判 —— 这是语言约束下的取舍，不是设计疏忽。

**坑 43：对照移植前先分清「源工程修的是第三方库的缺陷，还是它自己的缺陷」**

`f02c5b9` 修的是第三方解析器 `org.intellij.markdown` 的行为：**表头紧贴上一行且中间无空行时
不产出 `TABLE` 节点**，于是整块被当普通段落渲染成竖线纯文本。本工程 `core/MarkdownLite.ts` 是
**自研逐行解析**，表格判据是「本行含 `|` 且下一行是分隔行」（`markdownBlocks()`），
**根本不需要前导空行**。实测五种现场（表头紧贴 `**标题**` / 紧贴段落 / 文档开头 / 围栏内伪表格 /
列表项后）：本工程全部正常产出表格块，故**不移植**该归一化 —— 移植了也只是白多一层文本改写。

> 判据：两类工程**依赖面不同**（源用第三方 Markdown 库 + WebView，本工程自研），
> 第三方库的坑在本工程**可能根本不存在**。凡是「绕第三方库缺陷」的补丁，先在本工程实测复现，
> 复现不了就不移植 —— 否则会把一份无用的复杂度背进来。

**坑 44：ArkUI 的 `build()` / `@Builder` 方法体里不允许声明局部变量（实测编译失败）**

想照搬「先算一次、多处复用」的常规写法时踩的：在 `ToolCallDetailBlock.build()` 顶部写

```typescript
build() {
  const view: ToolBlockView = toolBlockView(this.tool);   // ← 这里
  Column() {
```

`hvigorw assembleHap` 直接 `CompileArkTS` 失败：

```
Unexpected token (Note that you need plugins to import files that are not JavaScript)
ERROR: In an '@Entry' decorated component, the 'build' method can have only one root node,
which must be a container component.
```

**报错信息误导**：它说「@Entry 组件只能有一个根节点」，但当时的组件根本不是 `@Entry`，
根节点也只有一个 —— 真正的原因是 `build()` 方法体**只接受 UI 描述**，任何前置语句都被当成语法错误。
放在 `@Builder` 方法体里同样不行。

三条出路，按推荐度：

1. **抽成子组件 + `@Prop`**（本轮采用）：父组件在**构造参数**里投影一次
   （`ToolBlockBody({ view: toolBlockView(this.tool), failed: this.tool.failed })`），
   子组件成员里便有一份现成的值 —— 构造参数位置是允许表达式的，方法调用、三元都行。
2. **把计算放进 `private` 方法**，在 UI 描述里按需调用（`this.viewKind()`），
   代价是同一处会重复解析（本项目 arguments 只有几十字节，可接受）。
3. 塞进普通成员 —— **不行**（只在构造时赋一次，父组件重绘不回写，见坑 40）。

**坑 45：`@Builder` 的参数从哪来，决定了能不能用**

同一次尝试里还想让 `@Builder` 收一个 `ToolBlockView` 参数（`this.readBlock(view)`）。
与坑 44 叠加后，唯一稳定的传值位置就是**组件构造参数**；把值从「局部变量」搬到「组件成员」后，
所有 `@Builder` 改成无参、内部直接读 `this.view.xxx`，问题一并消失。
代价是 `ui/MessageParts.ets` 里那个非导出的 `ToolTextBlock` 必须改成 `export` 才能被新组件复用
（跨文件复用下位组件时，循环 import 在本工程实测可用：`ToolBlockBody.ets` 与
`MessageParts.ets` 互相 import，`hvigorw` 编译无报错）。

**坑 46：把「可点链接」塞进正文 —— `Span` + `Text` 的两条边界**

要在同一段正文里混排「普通文字 + 可点链接」，`Text()` 里放多个 `Span()` 是本工程选的路子
（`ui/InlineText.ets`）。两条边界是实测撞出来的：

1. **`Span` 只承担「这一段文字长什么样」**（颜色、下划线装饰），字号 / 行高 / 字重统一设在
   **外层 `Text`** 上、由各 `Span` 继承 —— 逐段重复设置只会得到「某一段忘了设、字号跟隔壁不一样」。
2. **`fontSize` / `lineHeight` / `fontWeight` 是 `Text` 独有属性、不是通用属性**，
   于是它们**写不到自定义组件实例上**：`InlineText({...}).fontSize(16)` 这种链式写法拿不到效果，
   样式只能**当构造入参**传进去（`ui/InlineText.ets` 因此把 `fontSize` / `fontWeight` / `lineHeight`
   都开成入参）。反过来，**通用属性是能写在组件实例上的** —— 用户气泡的底色 / 内边距 / 圆角
   正是挂在 `InlineText` 实例上、落到它根节点的 `Text` 上的。

   由此还有一条**按处不同**的宽度约定：组件**刻意不自带** `width('100%')` ——
   正文段落（要占满行宽）在调用处显式设 `100%`，**用户气泡不设**（设了气泡会从「贴着文字」
   变成「整条色带」）。

   另：`lineHeight` 传 `0` 表示「这一处不设」，`build()` 为此分了两条几乎相同的链 ——
   ArkUI 里属性**没有「可选」这一说**，要么设、要么靠 `if` 分支绕开，而「设成 0」与「不设」不是一回事。

**坑 47：权限档位的候选项不在投影里 —— 只给 `currentValue` 就得另开目录接口，且老 bridge 的 404 必须容忍**

会话投影里的 `permissions` **只带 `currentValue`**（当前档位）**、列不出候选**。
想给用户一个能切档的界面，光知道「现在是哪个档」远远不够 —— 候选项在**另一个独立接口**
`GET /chat/permission-presets`（bridge ≥ 2.4.2，内核 `permissionPresets.catalog()`）。

三条纪律，缺一条界面就会出现「看着像故障」的表现：

1. **404 `ROUTE_NOT_FOUND` 必须容忍**：老 bridge 没有这个路由，抛出去会被渲染成一次**连接失败**，
   而实际只是「服务端版本稍旧」。`DshClient.permissionPresets()` 因此只把这一种错误吞成 `null`，
   **其余错误照抛**（不能一律吞 —— 那会把真故障也咽掉）。
2. **拉取失败不连坐整条连接**：该请求在 `loadSnapshot` 里**自己 catch 成 null**，不进全局 error ——
   权限目录取不到不该让整页连不上。
3. **失败不许擦掉旧目录**：`st.permissionCatalog = catalog !== null ? catalog : this.state.permissionCatalog;`
   —— 重连时这一次恰好取不到就把它清空，用户会看到「权限入口点都点不了」，而其实只是这一次请求失败。

另一条相关的**投影形状漂移**：档位名按 `currentValue` → `preset` → `sandbox` 三级降级取，
三者皆无才认定「没有档位」—— bridge 换字段名的窗口期，界面仍显示得出来（同坑 33「未知 ≠ 缺失」的口径）。

**坑 48：测试桩少一个方法不是「少测一条」，而是同步抛 `TypeError`、连坐整条链**

给 `DshClient` 加了 `permissionPresets()` 之后，`harness-view-model.test.ts` 里的替身 `FakeClient`
没跟着加，跑测时**22 条用例一起红**，而且红的全是不相干的用例（会话列表、命令清单…）。

原因：`loadSnapshot` 里写的是 `api.permissionPresets().catch((): null => null)` ——
当替身上**根本没有这个方法**时，`api.permissionPresets()` 是**同步**抛 `TypeError` 的，
**压根不进 Promise 链**，`.catch()` 接不住，异常直接冲出 `connect()`，把所有下游用例一起带崩。

两条教训：

1. **替身是被测对象的影子，接口一变必须同步改桩**；默认值要挑「最弱的那个合法行为」——
   `FakeClient.permissionPresets()` 默认返回 `null`（= 老 bridge），这样「404 / 旧版本必须容忍」
   这条纪律正好被钉在**默认路径**上，而不是靠某个特例用例。
2. 看到 `.catch()` 不要默认「这里的所有失败都被接住了」—— 它**只接 Promise 里的拒绝**，
   接不住「方法不存在」「this 为空」这类**同步**异常。这类错误在真机上只会表现为「一进页面就崩」，
   在单测里则表现为「一片红、且跟改动点看不出关系」。

**坑 49：注入式点击驱动不了 ArkUI 弹窗（`bindMenu`）里的 `Option` 项 —— 「点不动」≠「功能坏了」**

2026-10-20 真机验收顶栏权限胶囊时踩到这里。用 `uitest uiInput click`（按 `dumpLayout` 取的
`Option` 节点 bounds 中心点）和原生 `uinput -T -c` 各点了几次「工作区写入」，现象**完全一致**：
**弹窗关掉了，但档位没切** —— 看起来就像「点击落在空白处 / 胶囊没接通」。

但同一时刻从**服务端两侧取证**（bridge 审计库 `chat.command.execute` + 会话事件流
`command/run` → `permission/preset` → `sandbox/mode` → `command/done(success)`）能看到：
**切换命令确实发出去了、也成功了**。而 `Option` 节点在 `dumpLayout` 里 `enabled=true`、
坐标与实屏截图逐点吻合 —— 说明**不是**布局或接线问题。

判定：这是**注入式点击与 ArkUI 弹窗的交互局限** —— 带 dismiss 语义的浮层
（`DropdownMenu` / `bindMenu` 这类）把「外部注入的点击」优先当作「点在浮层外面」处理，
于是**先关菜单、后不派发**。注入式点击对**主窗口内的控件**（按钮、胶囊本体、返回键、列表行）
有效，对**弹窗里的项**不成立。

纪律：
- 真机验收弹窗类交互时**不能只用注入点击下结论**：要么改用「人手点」，要么像本例一样
  **从服务端侧面取证**（命令是否真的落地），别让「界面没变」直接等于「代码没生效」。
- 「点不动」与「功能坏了」在屏幕上长得一样，在服务端日志里一眼可分 ——
  既不要把工具局限写成代码缺陷，也不要把真实缺陷用「工具不行」糊过去。

**坑 50：`postJson` 吃相对路径、`postJsonUrl` 吃完整 URL —— 名字太像，喂错会拼出双份基地址**

`DshClient` 里有成对的两个后缀：

| 方法 | 参数含义 | 行为 |
| --- | --- | --- |
| `postJson(relative)` | 相对路径（如 `chat/sessions`） | 内部**自己**拼 `this.base` |
| `postJsonUrl(fullUrl)` | **完整 URL**（`pathUrl(...)` 的返回值） | 直接用，不再拼 |

两者只差一个 `Url`，语义却相反。本工程原有四处写成
`this.postJson(this.pathUrl([...]), body, true)` —— 参数是**完整 URL**，交给只认相对路径的那个方法，
最终请求打到了：

```
http://192.168.1.126:3090/api/v1/api/v1/chat/sessions/s1/fork
                                ^^^^^^^^^ 双份 `/api/v1`
```

受害的四个端点：**消息级分叉**（`fork`）、**`/` 命令执行**（`commands`）、**上传附件**（`attachments`）、
**模型发现**（`settings/providers/{id}/discover`）。真机表现是「分叉会话失败 / 命令跑了没反应 /
上传失败」，错误码是 **404 `ROUTE_NOT_FOUND`** —— 与「服务端版本太老、没有这个功能」**长得一模一样**，
于是很容易被误判成插件过旧（本工程已有单独一条「老 bridge 404 必须容忍」的纪律，见坑 47，
正是这些 404 让那条纪律变得更有迷惑性：**真 404 与拼错 URL 的 404 在响应里都是 `ROUTE_NOT_FOUND`**）。

**为什么这次才被发现**：写后台任务三个端点时，IDE 补全把 `postJson` / `postJsonUrl` 并列摆在眼前，
顺手实测了一遍各端点的**最终 URL** 才发现（新写的 `killJob` 差点照着旧写法再复制一遍）。

纪律：
- **新写端点先打印一次最终 URL**（`node` 里给一个假 transport 就行，几秒钟的事），
  别只靠「编译过了」——这条错法**类型完全合法**，编译器一个字都不会说。
- 回归用例钉住不变式：`test/cases/dsh-client.test.ts` 里那条
  「后台任务三个端点的 URL 都只有一份基地址」断言每个请求 URL 里 `'/api/v1'` 恰好出现 **1** 次。
  要加新端点时，把该端点也丢进这类断言。

**坑 51：`export { … } from './x'` 转发**纯类型** —— ESM 运行时会抛「does not provide an export named …」**

拆分 `DshClient.ts` 时，为了让 `platform/` 层那句 `import { HttpTransport } from '../core/DshClient'`
一个字都不用改，第一版写成一个大 `export { … }` 把接口也一起转发了：

```typescript
// ❌ 接口混在值转发里
export { HttpRequest, HttpResponse, HttpTransport, TimerBridge, DshClientDeps } from './DshTransport';
```

`hvigorw assembleHap` **编译通过**，但 `cd test && npm test` 立刻报

```
SyntaxError: The requested module '../entry/src/main/ets/core/DshClient.ts'
does not provide an export named 'HttpTransport'
```

因为 `HttpTransport` / `TimerBridge` / `DshClientDeps` / `WebSocketTransport` / `WebSocketCallbacks` /
`EventSocketHandle` / `EventsSubscription` 都是**纯类型**（`interface`），
在 ESM 里**根本没有运行时存在** —— 转发它们等于向运行时索要一个不存在的绑定。

**修法**：值与类型分两条出口，类型走 `export type`：

```typescript
// ✅ 类与常量走值转发，接口走类型转发
export { HttpRequest, HttpResponse, EventsChannel, CONNECT_TIMEOUT_MS } from './DshTransport';
export type { HttpTransport, WebSocketTransport, TimerBridge, DshClientDeps } from './DshTransport';
```

> 顺带一条：**ArkTS 编译绿不代表能跑**。类型转发这类问题只在**运行时**暴露 ——
> 而本工程的离线单测是 node + tsx，正好会当场撞上。所以「拆完编译通过」之后**必须跑一次 `npm test`**。

**坑 52：`bindSheet` 的 content builder 不随 vm 重绘 —— 面板靠「父组件传状态」必然停在首帧**

真机反馈：点会话正文里的文件名，弹出的面板**只有路径、没有内容**；关掉再点一次（或再点另一条）
才显示内容。

**根因是两件事叠在一起**：

1. `openSessionFile`（`core/HarnessViewModelSessions.ts`）是**两段式**的 —— 先同步放进一个
   `loading=true` 的 `SessionFileOpen` 占位（只带 `sessionId` + `requestedPath`），
   异步 `loadSessionFile` 回来后**整体换成**一个新实例（带 `resolved` / `preview` / `bytes`）。
2. 面板 `SessionFilesSheet` 把 `history` / `open` / `sessionId` 声明成**普通成员**，
   由 `ChatHeader.sheetContent()` 往下传。而 **`bindSheet` 的 content builder 不会因为
   vm 的一次 `update()` 重新执行** —— 它只在面板打开时构建一次。于是面板手里那份参数
   永久停在「打开那一帧」，也就是**第一段的占位**。异步结果换了新实例，面板看不见。

「第二次就好了」是因为关掉面板会销毁组件、再点重建时重新收值（此时状态里已是成品）。

**修法：面板自订阅，父组件只传回调。**

```typescript
@Component
export struct SessionFilesSheet {
  @StorageLink('dshRevision') revision: number = 0;
  private fallback: HarnessState = new HarnessState();
  private st(): HarnessState {
    const rev: number = this.revision;            // 读一次，登记依赖
    return rev >= 0 ? (harnessState() ?? this.fallback) : this.fallback;
  }
}
```

`SessionFileList` / `SessionFileDetail` 同样自订阅（详情态还额外**每帧现算** `kind`：
原先在 `aboutToAppear()` 里算一次，挂载时 `resolved` 还是 `null`，算出来永远是「按后缀」那支，
图片/PDF 会在字节到位后被当文本渲染）。

> **详情态别用 `@Prop open`**：`@Prop` 会**深拷贝**整个对象，而 `open.bytes` 是 `Uint8Array`
> —— 深拷贝出来的东西不再是真 TypedArray，`BinaryFilePreview` 会直接坏掉。
> 自订阅之后"现读引用"一次拷贝都没有，正好也避开这个坑（与坑 12「@Prop 深拷贝保原型」同一根源）。

**判据**：`test/cases/ui-wiring-guard.test.ts` 第一条 —— FIT_CONTENT 面板必须带
`@StorageLink('dshRevision')`，且 `SessionFilesSheet` 里**不许再出现**
`history:` / `open:` / `sessionId:` 这三个普通成员声明。

**坑 53：`SheetSize.FIT_CONTENT` 面板里写百分比 / `height('100%')` —— 按整屏算，面板被撑满**

文件面板列表原先写 `.height('72%')`（照抄源工程 `fillMaxHeight(0.72f)` 的比例），
面板本身走 `SheetSize.FIT_CONTENT`。真机表现：**弹窗很高、内容挤在上方、下面一大片留白**。

原因：`FIT_CONTENT` 的语义是「内容多高、面板多高」——此时**没有确定的父高度**给百分比当参照，
`'72%'` 只能退回按**整屏**算，于是面板被撑到贴满，条目只有三五个时下方全空。

**修法（两处，缺一不可）**：

1. 列表：`constraintSize({ maxHeight: 420 })` —— 条目多时列表在面板内部滚动，
   条目少时只占内容那么高。`JobsSheet` 用的是同一手法（`JOB_LIST_MAX_HEIGHT_VP`）。
2. **面板宿主根容器**（`ChatHeader.sheetContent()` 最外层 `Column`）去掉 `.height('100%')`。
   这一句在 2026-10-20 真机上被逮到：只改内层时面板依旧贴满屏幕，因为
   `FIT_CONTENT` 量的是**根容器**的高度，根容器 100% 就等于「内容 = 整屏」。

> 规律：**FIT_CONTENT 里只写"内容自身需要的尺寸"**，上限用 `constraintSize`；
> 百分比 / 100% 高度只适用于父高度确定的地方（这类面板里没有）。
> 形状门禁 `ui-wiring-guard` 第 2 例两处都查（面板内部 + 宿主根容器），
> 免得下次又只修内层。

**坑 54：`state.error` 只在 `AppShell` 里报 —— 而 `AppShell` 连上之后才挂载**

真机反馈：启动首屏网络不可达，界面上**到处都是「连接」**，点完看不出刚失败过。

`connectHostInternal` 失败会把错误写进 `state.error`，写是写了；但显示它的逻辑
（`localError` + `reportErrorIfAny` + `toast`）只写在 `ui/AppShell.ets` 里，而
`pages/Index.ets` 在 `!connectGate || !connected` 时**根本不挂载 AppShell**。
于是未连接时这条错误**没有任何听众**：标题、按钮、配对按钮全还写着「连接」，
用户点一下、等两秒、回到同一屏同样的字 —— 只能怀疑自己没点上。

源工程的做法是把 Snackbar 挂在**顶层**（`App.kt`），连接页与主界面**两处都看得见**；
移植时只保留了主界面那一处。

**修法**：`ui/ErrorText.ets` 抽出 `localErrorText()` 供两处共用（错误码 → 人话，
认不出原样返回），连接页接同一套：

```
@StorageLink('dshRevision') @Watch('onVmChanged') revision
  → reportErrorIfAny(): 未连接 + state.error != null → toast(不重复) → vm.clearError()
```

> 三个要点缺一不可：**`@Watch`**（否则 vm 更新走不到）、**`lastReported`**（否则每次重绘重弹）、
> **`clearError()`**（否则同一句错误永远挂在状态里）。判据见
> `test/cases/ui-wiring-guard.test.ts` 第三条。
>
> 另外按「**失败前后必须看得出区别**」的原则，主机卡片按钮加了第三档文案：
> 当前选中主机**探活全失败**时写「重试连接」（`connect_retry`），其余写「连接」，
> 已连接写「进入应用」。三档判据见 `ConnectScreen.hostButtonText()`。

**坑 55：展开态把「可点的标题行」整行换掉 —— 界面上再没有收回入口**

真机反馈：点开「思考过程」之后找不到收回的按钮。

`ui/ChatStatusBar.ets` 原先写成 `if (expanded) { 全文 } else { 标题行 }` ——
展开后标题行（转圈 + 摘要 + 整行点击区）整个消失，屏幕上只剩一片文字。
**能点的地方还在**（外层 `Column` 上挂了 `onClick`），但**没有任何视觉凭据**告诉用户
「这可以点」，于是等于没有收回入口。

源工程 `ChatThinkBar` 的写法是：`Row`（标题行）**常驻**，`if (expanded) { Text(全文) }`
接在它**下面**，行尾带一个 `ExpandMore` 箭头。

**修法**：标题行常在 + 行尾方向箭头（`⌄` 折叠 / `⌃` 展开）+ 全文接在下面；
`onClick` 从整列收紧到**标题行**（源工程同样只给 `Row` 加 `clickable`）——
否则用户在全文里拖动滚动会被当成点击，手一滑就把刚展开的内容收回去。

> 通用规律：**任何「展开 / 收起」都必须让触发它的那个控件在两种状态下都还在**，
> 并且带一个能看出当前朝向的指示（箭头 / 勾 / 计数）。只保留"同一片区域还能点"，
> 用户不会把它当成按钮。

判据见 `test/cases/ui-wiring-guard.test.ts` 第四条：标题行必须在 `if (this.expanded)`
之前、两种箭头都在、`onClick` 排在展开分支之前。

