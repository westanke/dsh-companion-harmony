# ADR-0004：手动签名（`hap-sign-tool`），`signingConfigs` 留空

- 状态：已采纳
- 日期：2026-10-15

## 背景

`hvigor` 的签名配置要求口令以 **DevEco Studio 加密串**形式出现（`signingConfigs` 里的
`keyPwd` / `storePwd` 不是明文，而是 IDE 生成并托管的一串密文）。本工程在无 DevEco
环境的 Linux 命令行下构建，无法产出这种密文。

## 决策

**`signingConfigs` 保持空数组**（构建产出未签名 hap），签名在构建之后用
`hap-sign-tool.jar` **手动完成**。

## 理由

1. 命令行无法生成 DevEco 加密串——写明文进去 hvigor 直接拒绝，写占位符会误导后来者。
2. 手动签名的**可控性更强**：调试证书与发布证书的切换只是换参数，
   不必改工程配置、不会把凭据写进版本库。
3. `signing/` 整体在 `.gitignore` 内，私钥不随代码分发。

## 后果

- **代价**：每次出包必须记得**补一次签名**，忘记则产出未签名包（装不上、上不了架）。
  已把它写进 `docs/RELEASE.md` 与 `AGENTS.md` §2，并做成固定命令。
- **代价**：上架要额外一步"组装 `.app` 并再签"——`.app` 内部的 hap **必须已签名**，
  否则是半签状态，很可能被 AGC 拒（已实测：初版只签外壳，内部 hap
  `signature not found`）。
- **收益**：`signingConfigs` 为空是**预期状态而非配置缺失**，这一点必须写进文档，
  否则后来者会以为工程配错了。
