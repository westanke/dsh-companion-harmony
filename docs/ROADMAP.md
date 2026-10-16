# 任务台账

> 本文件回答「接下来干什么」。**它不是愿望清单**——每条都要有验收判据。
> 状态更新与代码改动同批提交。

## 当前阶段：1.0.2 已打包，待上传 AGC

> 1.0.0 送审被 AGC 驳回（图标尺寸、名称与第三方相似、AI 内容标识等 7 条）；
> 1.0.1 因改名而作废、未上传；**1.0.2 为当前候选** —— 改名去品牌 + 换 `bundleName`
> （`com.dsh.westanke`）+ AI 生成内容显式标识，详见 `docs/PORT-MAP.md` 收尾十。

| 项 | 状态 |
|---|---|
| 代码 | 完成（531 用例全绿、`BUILD SUCCESSFUL`） |
| 打包 | 完成（`.app` 里外双签 + 真机 debug hap，均 `verify-app` → `Verify success`） |
| 上架材料 | 文案 ✅ / 截图 ✅（1.0.2 真机重拍 6 张）/ 图标 ✅（1024 分层）/ AI 标识证据 ✅ / 演示录屏 ✅ |
| 上传 AGC | 待用户操作 |
| git | 本轮改动待提交并推送双远端 |

候选产物（代码相同、只差签名来源）：
`dsh-companion-harmony-1.0.2-release-signed.app`（上架）·
`…-1.0.2-release-signed.hap`（`.app` 内层）·
`…-1.0.2-release-debugsigned.hap`（真机）·
`…-1.0.2-demo-walkthrough.mp4`（AGC 自测文件用）。
**1.0.0 / 1.0.1 产物全部作废。**

## 进行中（AGC 侧，非代码）

| # | 任务 | 说明 |
|---|---|---|
| 1 | AI 功能声明改正 | 「分发 > 版本信息 > AI 功能声明」勾选「涉及 AI 生成合成服务」 |
| 2 | 上传演示录屏 | 「应用审核信息 > 自测文件」上传 `…-1.0.2-demo-walkthrough.mp4` |
| 3 | 应用截图换新 | 换成 1.0.2 真机重拍的 6 张 |
| 4 | 实名认证口径 | 本应用自身不运营生成服务，走申诉说明或补手机号认证 —— **待用户拍板** |

> 已完成的坑 23 / 坑 24 真机复测与重出 `.app` 见 `docs/TESTING.md` 真机验收记录。

## 下一阶段

### 后续小修（上架后，视真机结果）

- 若真机暴露问题（补全面板手势、编辑器行高对齐等）→ 逐条修 + 补回归用例。
  已确证的表格列宽与 `/` 命令面板两项不再列入。
- 每条修复按 `AGENTS.md` §3 同步版本号与文档。

### 1.1.0（拆债）

**本轮已提前完成**：按 `TECH-DEBT.md` 在册 7 个文件**逐项拆分至「约 900 行」**，
对外接口与行为不变（`BUILD SUCCESSFUL` + `531 用例全绿`，用例数未降），7 文件全部退出台账。
详见 `docs/CHANGELOG.md` `[未发布]` 与 `docs/PORT-MAP.md` §1 新结构树。
4 个子 ViewModel 的**语义切分**（`ConnectionViewModel` / `ChatViewModel` / `FilesViewModel` /
`PluginsViewModel`）未做 —— 本轮拆的是**文件**（`HarnessViewModel` 继承链），不是**对象**。

| 优先 | 目标 | 判据 | 状态 |
|---|---|---|---|
| 高 | `core/HarnessViewModel.ts` 3 345 行 | 9 文件继承链，对外接口（`harnessVm()` / `harnessState()`）不变 | ✅ 已拆（最大 779 行）|
| 中 | `ui/ChatDetail.ets` 1 939 行 | 头部 / 输入区 / 三面板各自成文件，`ChatDetail` 只做编排 | ✅ 已拆 |
| 中 | `ui/ChatMessage.ets` 1 099 行 | 拆出 `MarkdownView` / `MessageParts` | ✅ 已拆 |
| 低 | 其余 4 个（`Models` / `ChatPresentation` / `FilesScreen` / `ChatScreen`） | 同上 | ✅ 已拆 |

同时清 `DEBT-003`（`ModelsScreen` 与 `ModelSheet` 合并去重、`DshClient` REST/WS 分层）。

## 待办池（未排期，每条注明触发条件）

| 任务 | 触发条件 |
|---|---|
| `scripts/docs-check.sh`（清 `DEBT-001`） | 文档条目数继续增长，人工对账开始出错时 |
| 引入 `code-linter`（清 `DEBT-002`） | 准备接收外部贡献，或线上出现低级缺陷时 |
| 平板专项适配与截图 | AGC 明确要求 16:10 素材；或平板测试暴露布局问题 |
| 英文界面（当前仅接口预留） | 有非中文用户诉求时 |
| 端到端自动化（真机 UI 测试） | 待验证清单长期靠人工复测、回归成本超过建脚本成本时 |

## 已完成

见 `docs/CHANGELOG.md`。**本文件只留"还没做的"**，做完即删行（避免两份记录互相矛盾）。
