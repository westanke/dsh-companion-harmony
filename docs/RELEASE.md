# 发版流程

> 本文件收敛散在 `CHANGELOG.md`、`STATUS.md`、`AGENTS.md` 里的发版口径。
> **用户既定规矩优先于本文**——冲突时以用户当次指示为准。

## 顺序（不可倒）

```
① 改代码
② 改文档与版本号     ← module.json5 versionCode +1、CHANGELOG、STATUS
③ 校验               ← hvigorw assembleHap + cd test && npm test
④ 签名打包           ← 先签 hap → 组装 .app → 再签 .app（里外双签）
⑤ 回填真实数据       ← 体积与 SHA-256 写回 STATUS
⑥ git 提交（不推送不发布）
⑦ 等用户发话 → 推送 / tag / 发 Release
```

**为什么 ② 必须在 ③/④ 之前**：先打包再改文档，文档会描述一个不存在的状态。

## ② 必改清单

| 文件 | 改什么 |
|---|---|
| `entry/src/main/module.json5` | `versionCode` +1、`versionName` |
| `docs/CHANGELOG.md` | `[未发布]` 段整体挪到版本号下，补日期 |
| `docs/STATUS.md` | 日期、阶段、版本线 |
| `docs/TESTING.md` | 本轮用例数与门验结果 |

## ③ 校验

```bash
source ./_toolchain/env.sh
hvigorw assembleHap --no-daemon      # 构建
cd test && npm test                  # 全量单测
```

## ④ 签名打包

```bash
# 1. 签 hap
java -jar "$DEVECO_SDK_HOME/.../hap-sign-tool.jar" sign-app \
  -mode localSign -keyAlias dsh-companion-harmony -keyPwd dshharmony2026 \
  -appCertFile signing/<cert>.cer -profileFile signing/<profile>.p7b -profileSigned 1 \
  -inFile entry/build/default/outputs/default/entry-default-unsigned.hap \
  -signAlg SHA256withECDSA -keystoreFile signing/dsh-companion-harmony.p12 \
  -keystorePwd dshharmony2026 -outFile <signed>.hap -compatibleVersion 18 -signCode 1

# 2. 组装 .app（把 <signed>.hap 放进 entry-default/，zip -j 打包）
# 3. 再签 .app（同一套发布证书与 Profile）
```

> **真机调试包**用**调试证书 + 调试 Profile**（受设备白名单限制，`hdc` 可装）；
> **上架包**用**发布证书 + 发布 Profile**（白名单 0 条，`hdc` 装不了，必须走应用市场）。
> 两者**代码完全相同**，只差签名来源。

## ⑤ 回填真实数据

```bash
stat -c '%s' <产物>      # 字节数
sha256sum <产物>         # 摘要
```

把真实值写回 `docs/STATUS.md`。**不许抄上一版的数字**。

## ⑥ 提交纪律

- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)。
- **提交 ≠ 可发布**。对外区分「已合并」「已发布」「用户吃到了」三态。

## ⑦ 推送与发布（必须用户点头）

- 禁止 `--force`。
- 推送 / tag / 发 Release 必须用户明确同意。
