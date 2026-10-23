# inbox —— 同步实现需求信箱（给 trae）

> 本目录是 **lead（对标找差距）→ trae（写代码对齐）** 的单向交接信箱。
> 制度与 dsh-desktop 仓 `docs/project/inbox/`（lead → workbuddy）同构，2026-01-23 立。

## 分工

| 角色 | 职责 |
|---|---|
| **lead**（DeepSeek Harness 助手） | 盯着 Android 源工程 `dsh-companion` 与桥 `dsh-remote-bridge`：新功能 / 新端点 / 新事件出现时，**核对鸿蒙端差距**、写清需求与验收，投到本目录 |
| **trae** | 读本目录通知，按 `AGENTS.md` 工程宪法在鸿蒙仓**写代码对齐**；改代码 → 改文档与版本号 → 校验 → 打包，顺序不可倒 |

## 通知从哪来（触发条件）

1. Android 版 **dsh-companion** 出现用户可见新功能或行为变更（新版本、未发版提交也算）；
2. **dsh-remote-bridge** 增加 REST 端点 / WS 事件 / 投影字段（`openapi` / `asyncapi` 是协议准绳）。

lead 每发现一类增量就投一份通知，文件名：`YYYY-MM-DD-<主题短横线>.md`。

## 通知必含（自包含，trae 不必回头追问）

- **背景**：源侧改了什么、为什么
- **源提交 / 版本**：Android 仓 commit hash + 版本号；桥侧版本与协议位置
- **差距**：对照 `docs/PARITY.md` 与 `docs/PORT-MAP.md`，鸿蒙端现状是什么、缺什么
- **需求与验收判据**：要做成什么样、纯函数回归用例、`cd test && npm test` 全绿
- **门禁**：`AGENTS.md` §3 文档/版本同步、§4 架构纪律（core 纯逻辑可单测 / ui 只消费状态 / DshClient 唯一网络边界）、900 行/文件预算
- **同步文档**：完成后要更新 `PARITY.md`（状态标记）、`CHANGELOG.md` `[未发布]`、`STATUS.md`、必要时 `PORT-MAP.md` 坑位

## trae 处理后

- 实现并自测通过后，可在通知文件末尾追加「已实现：<commit hash> + 日期」一节，或直接在 `CHANGELOG.md` 落账后删除通知；
- 「已提交」≠「已打包」≠「已上架」，三态按 `AGENTS.md` §6 分清；未经用户明确同意不 push / 不 tag / 不发 Release。
