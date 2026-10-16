# DSH 伴侣（HarmonyOS 版）

把运行在电脑上的 [DeepSeek Harness](https://github.com/hakunm/deepseek-harness)
带到手机上：连接自建服务端，随时随地查看会话进度、继续对话、处理审批。

> 本仓库是 Android 版 DSH Companion 的 HarmonyOS 原生移植（ArkTS / ArkUI），
> 不使用 WebView，聊天页为原生重写。

**仓库**：[GitHub](https://github.com/westanke/dsh-companion-harmony) ·
[Gitee](https://gitee.com/westanke/dsh-companion-harmony) ·
[AtomGit](https://atomgit.com/westanke163/dsh-companion-harmony)（镜像，内容同源）

> GitHub 主站国内常不可达，仓库内 `.github/workflows/sync-from-mirrors.yml` 会由 GitHub 侧的
> Runner 定时把 Gitee / AtomGit 镜像**快进回补**到 GitHub（详见 `docs/RELEASE.md` ⑦）。

## 功能

- **连接管理**：局域网 / 虚拟网 / 公网多地址并存与切换，配置导入与一次性配对码
- **会话**：列表、详情、实时消息流、AI 思考过程、工具调用记录与待审批交互
- **工作区文件**：浏览与编辑、会话内文件预览（HTML 结构预览、二进制降级）
- **模型与插件**：供应商管理、会话模型切换、插件清单与启停
- **Markdown 渲染**：标题 / 列表 / 引用 / 代码块 / GFM 表格 / 分隔线，行内样式
- **界面**：深色模式跟随系统主题，中文界面（预留英文接口）

## 环境要求

- HarmonyOS 6.0 及以上（`compatibleSdkVersion` = 5.1.0(18)）
- 构建：`hvigorw`（DevEco Studio 或独立工具链）
- 签名：`hap-sign-tool.jar`（hvigor 拒明文口令，需手动签名）
- 真机调试：`hdc`

## 快速开始

### 构建

```bash
source ./_toolchain/env.sh
hvigorw assembleHap --no-daemon
```

产物：`entry/build/default/outputs/default/entry-default-unsigned.hap`

### 签名与安装

```bash
# 调试签名：需在 AGC 绑定设备 UDID 的调试证书与 Profile
java -jar "$DEVECO_SDK_HOME/default/openharmony/toolchains/lib/hap-sign-tool.jar" sign-app \
  -mode localSign -keyAlias <alias> -keyPwd <pwd> \
  -appCertFile signing/<cert>.cer -profileFile signing/<profile>.p7b -profileSigned 1 \
  -inFile entry/build/default/outputs/default/entry-default-unsigned.hap \
  -signAlg SHA256withECDSA \
  -keystoreFile signing/<keystore>.p12 -keystorePwd <pwd> \
  -outFile entry/build/default/outputs/default/entry-default-signed.hap \
  -compatibleVersion 18 -signCode 1

# 安装
hdc install -r entry/build/default/outputs/default/entry-default-signed.hap
```

### 运行单元测试

```bash
cd test && npm test
```

## 工程结构

```
dsh-companion-harmony/
├── entry/src/main/ets/
│   ├── core/        # 纯逻辑（可单元测试）：Markdown 解析、连接存储、会话模型等
│   └── ui/          # ArkUI 页面与组件
├── test/            # 单元测试（jest，独立 npm 项目）
├── signing/         # 签名材料（不含密钥，.gitignore 已排除）
└── docs/
    ├── PORT-MAP.md       # Android → HarmonyOS 移植对照与坑点
    ├── CHANGELOG.md      # 变更日志（Keep a Changelog）
    ├── store-listing.md  # 中英文上架文案
    └── screenshots/      # 上架截图（1080×1920）
```

## 文档

- [AGENTS.md](AGENTS.md) — 工程宪法（命令、契约、铁律、坑位索引），每会话必读
- [docs/README.md](docs/README.md) — 文档索引
- [docs/STATUS.md](docs/STATUS.md) — 当前状态
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构
- [docs/RELEASE.md](docs/RELEASE.md) — 发版流程与签名
- [docs/TESTING.md](docs/TESTING.md) — 测试记录
- [docs/SECURITY.md](docs/SECURITY.md) — 安全
- [docs/PORT-MAP.md](docs/PORT-MAP.md) — 移植对照与坑点
- [docs/PARITY.md](docs/PARITY.md) — 能力对等矩阵
- [docs/ROADMAP.md](docs/ROADMAP.md) — 任务台账
- [docs/TECH-DEBT.md](docs/TECH-DEBT.md) — 技术债务台账
- [docs/decisions/](docs/decisions/) — 架构决策记录（ADR）
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — 变更日志
- [docs/store-listing.md](docs/store-listing.md) — 上架文案（中英文）
- [artifacts/RELEASE_NOTES_v1.0.0.md](artifacts/RELEASE_NOTES_v1.0.0.md) — 1.0.0 发版说明

## 开发约定

- 核心逻辑放 `core/`，必须配套单元测试；UI 放 `ui/`
- 每次改动先在 `docs/CHANGELOG.md` 的 `## [未发布]` 段追加条目
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)

## 许可

见 [LICENSE](./LICENSE)。
