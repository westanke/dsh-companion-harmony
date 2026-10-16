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

### 收尾八：双远端托管与重出上架包（2026-10-16 用户要求）

用户原话：「在 Gitee/GitHub 你建仓，写好各种文档，本地提交，出包，提交等流程，我的 Gitee/GitHub
信息本地应该有」。

**双远端（同一 `master`，两个远端各一份）**：

| 远端 | 地址 | 角色 |
|---|---|---|
| `origin` | `https://github.com/westanke/dsh-companion-harmony` | 主（`master` 跟踪它） |
| `gitee` | `https://gitee.com/westanke/dsh-companion-harmony.git` | 镜像（国内访问） |

两个远端 `master` 指向同一提交 —— 推送后必须**逐远端 `git ls-remote --heads <r> master` 核验**，
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
