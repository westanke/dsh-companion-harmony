# 当前状态

- **日期**：2026-10-16
- **阶段**：1.0.0 已打包，待上架 AGC（release 构建，里外双签 `.app` 已产出）
- **版本**：1.0.0 / `versionCode` 1000000
- **bundleName**：`com.Deepseek_Harness_client.westanke`（AGC 调试 Profile 已绑定，不可改）
- **仓库**：[GitHub](https://github.com/westanke/dsh-companion-harmony)（`origin`，主）·
  [Gitee](https://gitee.com/westanke/dsh-companion-harmony)（`gitee`，镜像），两远端 `master` 同提交
- **兼容**：HarmonyOS 6.0 及以上（`compatibleSdkVersion` = 5.1.0(18)）
- **设备类型**：phone / tablet / 2in1
- **插件基线**：`dsh-remote-bridge` **≥ 2.0.4**（旧名 `dsh-workspace`）
- **最近验证**：`531 用例全绿`（`cd test && npm test`）+ `BUILD SUCCESSFUL`
- **真机**：已在 ICL-AL10（API 26，HarmonyOS 7.0）跑通 **release 构建**（调试证书签名安装）
- **发布产物**（2026-10-16 重出，已含坑 23 / 坑 24 修复，内外层均 `verify-app` 通过）：
  - `dsh-companion-harmony-1.0.0-release-signed.app`（里外双签，**上架 AGC 用**）
  - `dsh-companion-harmony-1.0.0-release-debugsigned.hap`（调试签名，**装真机用**）
  > 两者**代码完全相同**，只差签名来源；发布证书签的 hap 无法 `hdc install`（设备只信任调试证书）。
- **产物校验**（2026-10-16 09:40，`sha256sum` 实测回填）：

  | 产物 | 字节 | SHA-256 |
  |---|---|---|
  | `…-1.0.0-release-signed.app` | 435 175 | `12c2c8f2df0f11d328169453b746bf3df8ef3ece776ea364b8b2fe94665904de` |
  | `…-1.0.0-release-debugsigned.hap` | 1 261 281 | `428a02122ada3b434280fff609f9148173fdd882c917e0b66bd47076e2c69ec6` |
- **权限**：仅 `ohos.permission.INTERNET` + `GET_NETWORK_INFO`（`READ_PASTEBOARD` 已移除）
- **阻塞项**：**无**。表格列宽修复（坑 23）与 `/` 命令面板修复（坑 24）均已于 2026-10-16
  真机验收通过（见 PORT-MAP §7 第 24 / 25 条）
- **本轮改动**：7 个超长文件按「约 900 行」拆分完成（对外接口不变，用例数未降）；修复
  会话页 `/` 带不出 dsh 命令（坑 24：普通成员不被回写 → 改 `@Prop`）；双远端建仓；
  重出含修复的上架包
- **下一步**：重截上架截图第 3 张（表格已正常）→ 上传 `.app` 到 AGC
