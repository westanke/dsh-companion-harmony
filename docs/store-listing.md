# DSH 伴侣 · 应用商店文案（AGC）

> 用途：AGC「版本发布」页的「一句话简介（小编推荐）」与「应用介绍」两个字段。
> 硬约束：一句话简介 **≤ 17 字**（按字符计，空格与英文字母各算 1）；应用介绍 **≤ 8000 字**。
> 记录时间：2026-10-15

---

## 一、中文（简体）

### 一句话简介（13 / 17）

```text
远程连接你的 DSH 助手
```

### 应用介绍

```text
DSH 伴侣是一款连接你自己部署的 DeepSeek Harness 服务的移动端客户端，把运行在电脑上的 AI 会话搬到手机上，让你不必守在电脑前，也能查看进度、继续对话、处理审批。

为什么需要它
DeepSeek Harness 运行在电脑上，人一离开座位就断了联系：进度看不到、审批点不了、会话接不上。本应用把「配置导入」作为主要连接方式——在电脑上生成一行文本，通过任意聊天工具发给自己，到了外面粘贴进应用即可完成配对，不需要人和电脑处在同一网络。

主要功能
· 连接管理：可同时保存局域网、虚拟网、公网等多个地址，按需切换
· 会话浏览：查看历史会话、实时消息流、AI 的思考过程与工具调用记录
· 交互操作：提问、回复、处理待审批操作、回答 AI 的追问
· 文件查看：浏览与编辑工作区文件，在应用内预览 HTML、图片等文件
· 模型与插件：管理模型供应商、切换会话所用模型、启停插件
· 界面偏好：支持深色模式并跟随系统主题，界面为中文

使用前提
本应用是 DeepSeek Harness 的插件客户端，需要连接你自己部署的 DeepSeek Harness 服务端（并安装 dsh-remote-bridge 插件）后才能使用。请先在电脑上完成服务端部署，再通过配置导入或配对码连接。

服务端插件安装命令：
dsh plugin --profile web add dsh-remote-bridge
```

---

## 二、English

### Tagline (13 / 17 characters)

```text
DSH on the go
```

### App description

```text
DSH Companion is a mobile client for your own self-hosted DeepSeek Harness. It brings AI sessions running on your computer to your phone, so you can follow progress, continue conversations, and handle approvals without staying at your desk.

Why it is needed
DeepSeek Harness runs on your computer, so once you leave your desk you are cut off: you cannot see progress, cannot act on approvals, and cannot pick up a session. This app uses config import as its main connection method — generate a single line of text on your computer, send it to yourself through any chat app, and paste it into the app when you are out. Your phone and computer do not need to be on the same network.

Key features
- Connection management: keep several addresses (LAN, VPN, public network) at once and switch between them
- Session browsing: view past sessions, the live message stream, the AI's reasoning and tool-call records
- Interaction: ask questions, reply, handle pending approvals, and answer the AI's follow-up questions
- File viewing: browse and edit workspace files, and preview HTML, images and other files in the app
- Models and plugins: manage model providers, switch the model a session uses, enable or disable plugins
- Look and preferences: dark mode that follows the system theme; Chinese user interface

Requirements
This app is a plugin client for DeepSeek Harness. It works only with your own self-hosted DeepSeek Harness server with the dsh-remote-bridge plugin installed. Deploy the server on your computer first, then connect by config import or a pairing code.

Server plugin installation command
dsh plugin --profile web add dsh-remote-bridge
```

---

## 三、填写须知

### 3.1 一句话简介为什么用缩写

「远程连接你的 Deepseek Harness助手」实测 **25 个字符**，超出 17 的硬上限，提交会被打回。
英文的「Your own DeepSeek Harness」为 **24 个字符**，同样超限。
因此两版均改用 `DSH` 缩写，保留「远程连接 / on the go」的核心卖点。

若将来平台放宽字数，可换回：

- 中文：`远程连接你的 DeepSeek Harness`（19 字符，仍超 17，需平台放宽）
- 英文：`Your own DeepSeek Harness`（24 字符）

### 3.2 品牌写法

统一为官方写法，避免商标与规范问题：

- `DeepSeek`（大写 S，非 `Deepseek`）
- `Harness` 首字母大写
- 应用名中的 `DSH` 全大写

### 3.3 服务端插件版本

本应用需要服务端安装 `dsh-remote-bridge` 插件（旧名 `dsh-workspace`），
版本 **不低于 2.0.4** —— 低于该版本缺少路径解析接口，会话内文件功能会失效。

安装命令：

```bash
dsh plugin --profile web add dsh-remote-bridge
```

### 3.4 审核要点

1. **必须写明「需自建服务端」**。本应用是客户端，审核员打开后若无服务端可连，
   会被判「功能不可用」而驳回。「使用前提」段落即为此而写，不要删除。
2. **避免绝对化用语**（最、第一、永久）、不写「免费」、不做竞品对比、不出现「测试版 / 内测」字样。
3. **可能需要提供可访问环境**：审核阶段如需连通验证，需临时开放一个服务端或提供演示地址。

### 3.5 AGC 其余必填材料

| 材料 | 状态 / 说明 |
|---|---|
| 应用图标 | 1024×1024 PNG，已备 |
| 应用截图 | 已备 6 张（1080×1920，9:16，见 `docs/screenshots/`）；平板截图待定 |
| 应用分类 | 建议「工具 - 效率」 |
| 隐私政策 | 需可公开访问的 URL；可写「不收集个人信息、不向第三方共享」 |
| 权限说明 | `INTERNET`、`GET_NETWORK_INFO`，均为基础权限 |
