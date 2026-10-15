# 架构决策记录（ADR）

一件事一个文件，**决策当时写**，不事后补。被推翻的决策不删——改状态为「已推翻」并指向取代它的那条，
**保留原文**：知道"当初为什么不这么做"比只看现状更有价值。

## 索引

| 编号 | 决策 | 状态 |
|---|---|---|
| [ADR-0001](ADR-0001-arkui-native-over-webview.md) | 聊天页用 ArkUI 原生重写，不用 WebView | 已采纳 |
| [ADR-0002](ADR-0002-core-logic-extracted-and-unit-tested.md) | 判据抽到 `core/` 并单测 | 已采纳 |
| [ADR-0003](ADR-0003-compatible-sdk-5-1-0-18.md) | `compatibleSdkVersion` = 5.1.0(18) | 已采纳 |
| [ADR-0004](ADR-0004-manual-signing-via-hap-sign-tool.md) | 手动签名（`hap-sign-tool`），`signingConfigs` 留空 | 已采纳 |
| [ADR-0005](ADR-0005-markdown-tables-from-skip-to-parse.md) | Markdown 表格：从「刻意不解析」改为「解析并原生渲染」 | **已推翻（取代 ADR-0005 原案）** |
| [ADR-0006](ADR-0006-chinese-first-english-interface-reserved.md) | 中文为主，英文接口预留 | 已采纳 |

## 何时该写一条 ADR

满足任一条即写：

- 决策**影响多个模块**，且后来者可能想改回去；
- 决策**看起来是错的**（如故意放弃某能力），需要留下理由；
- 决策**推翻了先前一条**（改状态 + 新写一条，不删旧的）；
- 决策源于**平台硬限制**（如权限、SDK 枚举缺失）。

**不必写**：局部的命名、格式、单文件内部实现——那些看代码即可。

## 模板

```markdown
# ADR-000N：标题

- 状态：已采纳 | 已推翻（被 ADR-000M 取代）
- 日期：YYYY-MM-DD

## 背景
当时面对什么约束、有哪些候选方案。

## 决策
选了哪个，用一句话说清。

## 理由
为什么是它——**这是全文件最重要的部分**。

## 后果
要接受什么代价、留下了什么债（可指向 `TECH-DEBT.md`）。
```
