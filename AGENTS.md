# AGENTS.md — dsh-companion-harmony 工程宪法

> 本文件是每次会话**必然读到**的那份约定。规矩写在这里，不靠记忆、不靠口头。
> 借鉴自源工程 `dsh-companion`（Android）的 `AGENTS.md` 制度，按 HarmonyOS 移植版裁剪，
> 详见第 8 节。
>
> **体积纪律**：本文件只写**命令、契约、触发词与铁律**；
> 「说不清、要摆证据」的内容一律进 `docs/`，这里只留指针。

---

## 0. 一分钟上手

| 我想… | 先读 |
|---|---|
| 知道现在到哪了 | `docs/STATUS.md` |
| 知道某能力有没有、差什么 | `docs/PORT-MAP.md` §4 移植对照表 |
| 改代码前避坑 | `docs/PORT-MAP.md` §6 坑位（名字 = 锚点） |
| 发版 / 签名 | `docs/RELEASE.md` |
| 为什么这么设计 | `docs/ARCHITECTURE.md` |
| 这次改了什么 | `docs/CHANGELOG.md`（`[未发布]` 段） |
| 测试口径 | `docs/TESTING.md` |
| 上架文案 / 截图 | `docs/store-listing.md` / `docs/screenshots/` |

> **每轮开工先读 `docs/STATUS.md`**。本应用是 `dsh-remote-bridge` 插件客户端，
> **不自带任何 DSH 能力**；发现能力不足时先在插件侧加接口，再接入本应用。

---

## 1. 本项目是什么（一句话与边界）

- **定位**：DeepSeek Harness 的 HarmonyOS **原生客户端**（ArkTS / ArkUI），**不使用 WebView**。
- **与谁配**：服务端插件 `dsh-remote-bridge`（**≥ 2.0.4**，旧名 `dsh-workspace`）。
- **兼容**：HarmonyOS 6.0 及以上（`compatibleSdkVersion` = 5.1.0(18)）。
- **不做什么**：不跑内核、不代理官方 WebUI、不打包 Ubuntu。

---

## 2. 命令（本地唯一可信口径）

```bash
source ./_toolchain/env.sh
hvigorw assembleHap --no-daemon     # 构建（改 .ets 后先 touch 对应文件，否则 UP-TO-DATE）
cd test && npm test                 # 单元测试（当前 531 用例，随代码变化勿当常量）
```

**签名必须手动签**（hvigor 拒明文口令，`signingConfigs` 保持空数组）：

```bash
java -jar "$DEVECO_SDK_HOME/default/openharmony/toolchains/lib/hap-sign-tool.jar" sign-app \
  -mode localSign -keyAlias dsh-companion-harmony -keyPwd dshharmony2026 \
  -appCertFile signing/<cert>.cer -profileFile signing/<profile>.p7b -profileSigned 1 \
  -inFile entry/build/default/outputs/default/entry-default-unsigned.hap \
  -signAlg SHA256withECDSA -keystoreFile signing/dsh-companion-harmony.p12 \
  -keystorePwd dshharmony2026 -outFile <signed>.hap -compatibleVersion 18 -signCode 1
```

> 真机调试用**调试证书 + 调试 Profile**（受设备白名单限制）；
> 上架用**发布证书 + 发布 Profile**，先签 hap → 组装 `.app` → 再签 `.app`（里外双签）。
> 完整流程见 `docs/RELEASE.md`。

---

## 3. 版本与文档同步（最高频失分点）

| 改动 | 必须同步 |
|---|---|
| `versionCode` / `versionName` | `entry/src/main/module.json5` + `docs/CHANGELOG.md` + `docs/STATUS.md` |
| 测试用例数 | `docs/TESTING.md` |
| 发布产物 / 体积 / SHA-256 | `docs/STATUS.md` + `docs/RELEASE.md` |
| 上架文案 / 截图 | `docs/store-listing.md` / `docs/screenshots/` |

**铁律**：改代码 → 改文档与版本号 → 校验 → 打包。**顺序不可倒**——
先打包再改文档，文档会描述一个不存在的状态。

---

## 4. 架构纪律

### 4.1 分层与依赖方向

```
core/   ← 纯逻辑（可单测）：MarkdownLite / SecureConnectionStore / ChatPresentation ...
ui/     ← 只消费 HarnessState，调 HarnessViewModel 动作；不持有协议或权限决策
```

- **`DshClient` 是唯一网络边界**（ArkHTTP REST + WebSocket），阻塞 IO 只在 worker 线程。
- ArkUI 表现层**不得**自己发网络请求或直读偏好当状态。
- 会话展示走 `ChatPresentation` 单一出口；`step/end`、`turn/end`、token 序列不渲染为聊天卡片。
- **不使用 WebView**——聊天与 HTML 预览均为原生渲染，避免不可信文件取得执行权。

### 4.2 债务台账（只许收紧）

`ARCHITECTURE.md` 是散文，**不构成门禁**。本项目沿用源工程的「债务台账」制度：

- 台账放 `docs/TECH-DEBT.md`，每条含：位置、为什么是债、清账阶段。
- **只许收紧**：条目对应的债务消失，同一提交里删掉该条目（自证非空转）。
- **上调必须带理由**：单文件超过行数预算时，只许带理由在同一提交里上调，且必须在下一阶段拆回。
- 当前行数预算：**1 000 行/文件**（由 800 上调，理由见 `TECH-DEBT.md`：ArkTS 样板多于 Kotlin）。
  基线测量日 2026-10-15，**7 个文件在册**（`HarnessViewModel.ts` 3 345 为最大一笔）。
  > 这些是**已登记的债，不是许可**。新增超预算文件必须先入台账再写码。

---

## 5. 测试纪律

- 修 bug 必须带回归用例（`docs/TESTING.md` 记录演进）。
- 测试文件命名与被测模块对应，夹具集中在 `test/cases/`。
- **单测绿 ≠ 行为对**：手势、键盘、表格渲染、列宽一律真机确认。

---

## 6. 对外表述纪律

- **「已合并」≠「已发布」≠「用户吃到了」**，三态必须分清。
- 禁止 `push` / `release` / `tag` 未经用户明确同意；本地 commit、构建、测试、写文档可直接做。

---

## 7. 坑位索引（名字 = 触发词 = 锚点）

正文在 `docs/PORT-MAP.md` §6，动手前按名字读对应条目。**不看就改 = 重踩。**

- `调试 Profile bundleName 必须一致`
- `剪贴板权限 system_basic`
- `hdc 设备识别 udev`
- `锁屏下 aa start 无法拉起`
- `hvigor 拒明文口令`
- `布局溢出系统手势区`
- `资源被构建写坏`
- `ForEach 键不含选中态`
- `表格列宽估算贴边`

> 新坑位：名字加进上面清单 + 原文写进 `docs/PORT-MAP.md` §6 并补 `### 同名` 锚点。

---

## 8. 制度来源与差异

借鉴 `dsh-companion`（Android）的 `AGENTS.md` 制度，按本项目裁剪：

| 借鉴项 | 本项目 |
|---|---|
| 工程宪法 + 文档路由表 | 保留，命令换为 hvigor / hap-sign-tool |
| 债务台账（TECH-DEBT） | **已立账**：`docs/TECH-DEBT.md`，行数预算 1 000 行/文件，7 文件在册 |
| 能力对等矩阵（PARITY） | **已建立**：`docs/PARITY.md`（能力 / 插件 API / 本工程 / 状态） |
| 任务台账（ROADMAP） | **已建立**：`docs/ROADMAP.md`（阶段、进行中、待办池） |
| 架构决策记录（ADR） | **已建立**：`docs/decisions/`（一事一文件） |
| 发版说明 | **已建立**：`artifacts/RELEASE_NOTES_<版本>.md` |
| 坑位索引 | 保留，内容为 HarmonyOS 特有坑 |
| `@patch` 四要素 | 暂未引入 |

**刻意没抄的**：CDP 探针体系（本项目无 WebUI 宿主）、README 双站对账（当前仅中文）。
