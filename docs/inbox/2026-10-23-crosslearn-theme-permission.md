# 横向互鉴补充需求：多配色主题 / 新建会话即选权限档位

- 日期：2026-10-23
- 提出方：lead（对标找差距，不写鸿蒙实现）
- 执行方：trae
- 状态：**待实现**（实现并自测通过后，按 inbox README 在文末回填「已实现：<hash> + 日期」，或落 CHANGELOG 后删本单）
- 依据：[`../../../../../workspace/对齐台账/三端功能互鉴清单.md`](/media/wangke/OFFICE/workspace/对齐台账/三端功能互鉴清单.md)（lead 2026-10-23 逐端读码的横向互鉴矩阵）
- 本批性质：**横向互鉴**，不是追平安卓新功能——这两项是「桌面/安卓有、鸿蒙缺或弱」。
- 基线：鸿蒙 1.0.3（versionCode 1000003）；与本目录 `2026-10-23-v2.2.47-to-v2.2.52-gap.md`（7 个开发项）**不重叠**，那批 P0/P1 优先，本单可排其后。

> 路径说明：本单参照实现给的是跨仓绝对路径。安卓仓 `/media/wangke/OFFICE/workspace/dsh-companion/...`；桌面仓 `/media/wangke/OFFICE/workspace/2026-10-21-19-27-23/dsh-desktop/...`。

---

## 共同门禁（每项都过）

1. 架构纪律（AGENTS §4）：**core 纯逻辑可 node 单测 / ui 只消费状态 / DshClient 唯一网络边界**；
2. 新增纯函数（配色选择/档位判定）进 `core/` 并补 node 用例，`cd test && npm test` 全绿（当前 1013 条，只增不减）；
3. 900 行/文件预算；改代码 → 改文档与版本号 → 校验 → 打包，顺序不可倒；
4. 同步 `docs/PARITY.md`（状态标记）、`CHANGELOG.md` `[未发布]`、`STATUS.md`，必要时 `PORT-MAP.md`；
5. 未经用户明确同意不 push / 不 tag / 不发 Release；文件落盘即视为送达（lead 不 commit 本仓）。

---

## H1 · 多配色主题（P1，鸿蒙当前最急的外观短板）

### 差距
- 鸿蒙现状：`core/ThemeMode.ts`（43 行）只有 **3 档明暗模式** `system / light / dark`，**颜色只有一套**——切换模式只改明暗，没有可选配色；颜色值目前散落在多个 `.ets`（AppShell / SessionRow / ChatComposer / ChatDetail / FileBrowser / SettingsScreen 等内联 `Color(...)`）。
- 桌面：**5 套配色** Sand/Porcelain/Moss/Abyss/Dusk（`ui/Theme.kt:84-184`，`ThemeChoices` 注册表 :212，"新增主题只加一个 object，UI 不用动"）。
- 安卓：**4 套**（PAPER + 3 套新主题），每套含 light+dark 两份约 30 个角色色，集中在 `ui/theme/ThemePalettes.kt`。

### 参照实现
- 桌面注册表式：`/media/wangke/OFFICE/workspace/2026-10-21-19-27-23/dsh-desktop/src/main/kotlin/io/github/westanke/dshdesktop/ui/Theme.kt`
- 安卓色板 + 无障碍：`/media/wangke/OFFICE/workspace/dsh-companion/app/src/main/java/io/github/westanke/dshcompanion/ui/theme/ThemePalettes.kt`、`Theme.kt`
- 鸿蒙现状：`entry/src/main/ets/core/ThemeMode.ts`

### 实现要点
1. **先收口颜色再上多配色**（否则 N 套色要改 N×散落处）：把散在各 `.ets` 的内联色值收敛到一个集中的配色 token/色板模块（与 ThemeMode 配合：选的"配色"× 系统/强制明暗"模式"二维决定最终色）。这一步本身就值得做。
2. 提供至少 **3–4 套命名配色**，每套含浅色与深色两份（可直接移植桌面 5 套或安卓 4 套的色值，注意 ArkUI 的颜色 API 与 Compose 不同，只搬**色值与角色语义**，不搬代码）。
3. **对比度达标**：学安卓 ThemePalettes.kt 的做法——关键色对按 WCAG 2.1 相对亮度公式核算，正文/图标色对 ≥ 4.5:1；安卓为此写了断言（AppThemeTest），鸿蒙应在 node 用例里放一个**纯函数的对比度计算 + 每套色板关键色对阈值断言**（亮度公式不依赖 UI，天然可进 core 单测）。
4. 选择持久化进 `core/AppPreferences.ts`（与现有 fontScale/themeMode 同处），设置页「外观」区（`SettingsScreen.ets:486` 现有"字号/主题"分组）加配色选择；默认配色对未升级用户**零视觉漂移**（学安卓 PAPER "逐字段等于旧值"的零漂移承诺）。
5. 默认值与回退：认不出的配色 id 回落默认（沿用 ThemeMode.normalizeThemeMode 的兜底风格）。

### 验收
- 至少 3 套配色 × 浅/深可切换、重启保持、跟随系统明暗生效；
- 老用户升级后默认配色与现状逐色一致（零漂移）；
- 色板对比度纯函数用例随 `npm test` 跑，关键色对 ≥ 4.5:1；
- PARITY / CHANGELOG / STATUS 同步。

---

## H2 · 新建会话即选权限档位（P2）

### 差距
- 鸿蒙新建会话 `core/HarnessViewModelSessions.ts:317 createSession(workspaceId, preset)` 的第二个参数是 **agentPreset（Agent 预设），不是权限档位**；`ui/ChatScreen.ets` 的 NewSessionSheet（:63 `presetId` / :316 调 createSession）选的也是 Agent 预设。
- 但权限档的**数据通路鸿蒙已经有了**：`core/DshClient.ts:607 permissionPresets()`（`GET chat/permission-presets`，bridge ≥ 2.4.2，返回 PermissionCatalog）、投影 `permissions` 只给 `currentValue`；会话内切权限档的 UI 也已存在于 `ui/ChatHeader.ets` / `ui/ChatDetail.ets`。
- 缺的只是：**新建会话时让用户选一个权限档，建完自动切过去**，不用建完再进会话手动 `/permission`。桌面第二批 P3、安卓都已对齐此项。

### 参照实现（安卓的关键决策：建完再切，不造新端点）
- `/media/wangke/OFFICE/workspace/dsh-companion/app/src/main/java/io/github/westanke/dshcompanion/HarnessSessionsViewModel.kt:333`
  `createSession(workspaceId, preset, permission="")`：先 `api.createSession(...)`（:334，**创建接口不带权限参数**），成功后 `applyPermissionPreset(created.id, permission)`（:361）；
- `applyPermissionPreset(sessionId, permission)`（:371）与 `selectPermissionPreset(preset)`（:606）：复用**会话内切权限档的同一条通路**（发 `/permission <preset>` 或对应 command），空 permission 不发任何东西；
- 新建工作区再建会话那条路径（:421/438）同一套机制；
- 安卓 picker：`ui/chat/ChatPermissionPresetPicker.kt`，且明确与"会话中手动 `/permission`"是同一套机制。

### 实现要点
1. **不要改创建会话的网络请求**（内核 createSession 不收权限档）；照安卓"建完再切"：`createSession` 成功拿到 id 后，若用户选了非空权限档，调现有会话内切档通路应用一次；空选不发。
2. NewSessionSheet 在现有 Agent 预设选择**之外**加一个权限档选择；候选项只来自 `permissionPresets()` 目录，**目录为 null（老桥 < 2.4.2 / 无能力）时不显示该选择器**（沿用现有能力降级，不许按桥版本号猜、不许给一排拨了没反应的控件）。
3. 默认选中"不指定"（保持现状行为），避免改变用户既有默认；scope 不足 / 只读时按现有权限 UI 的降级处理。
4. 档位判定与"是否该发 apply"做成 core 纯函数（如 `shouldApplyPermission(permission): boolean`、空串/空白不发），补 node 用例；选择态留在 ui/ViewModel，网络仍只经 DshClient。

### 验收
- 新建会话选权限档后，进入会话该档已生效（投影 currentValue 正确）；选"不指定"行为与现状一致；
- 老桥无 permission-presets 能力时选择器不出现、不报错；
- 纯函数用例进 `npm test`；PARITY / CHANGELOG / STATUS 同步。

---

## 实现回执（trae 回填）

| 项 | 状态 | commit | 日期 | 备注 |
|---|---|---|---|---|
| H1 多配色 | ✅ 已实现（待上机） | — | 2026-10-23 | 四套配色 × 明暗 + WCAG 对比度纯函数（948 用例全绿）+ 散落色值收口；默认 PAPER 零漂移；设置页四档选择 + 持久化 |
| H2 新建选权限档 | ✅ 已实现（待上机） | — | 2026-10-23 | 建完再切（不改创建请求）+ `shouldApplyPermission` 纯函数 + 老桥无目录时不渲染选择器；20 条 node 用例 |
