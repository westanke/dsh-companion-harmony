# 当前状态

- **日期**：2026-10-15
- **阶段**：1.0.0 已打包，待上架 AGC（release 构建，里外双签 `.app` 已产出）
- **版本**：1.0.0 / `versionCode` 1000000
- **bundleName**：`com.Deepseek_Harness_client.westanke`（AGC 调试 Profile 已绑定，不可改）
- **兼容**：HarmonyOS 6.0 及以上（`compatibleSdkVersion` = 5.1.0(18)）
- **设备类型**：phone / tablet / 2in1
- **插件基线**：`dsh-remote-bridge` **≥ 2.0.4**（旧名 `dsh-workspace`）
- **最近验证**：`531 用例全绿`（`cd test && npm test`）+ `BUILD SUCCESSFUL`
- **真机**：已在 ICL-AL10（API 26，HarmonyOS 7.0）跑通 **release 构建**（调试证书签名安装）
- **发布产物**：
  - `dsh-companion-harmony-1.0.0-release-signed.app`（里外双签，上架用）
  - `dsh-companion-harmony-1.0.0-release-signed.hap`（发布签名，备用）
  - `dsh-companion-harmony-1.0.0-release-debugsigned.hap`（调试签名，装真机）
- **权限**：仅 `ohos.permission.INTERNET` + `GET_NETWORK_INFO`（`READ_PASTEBOARD` 已移除）
- **阻塞项**：表格列宽修复（坑 23）、`/` 命令面板修复（坑 24）已改代码、未真机验收（设备已断开）
- **本轮改动**：7 个超长文件按「约 900 行」拆分完成（对外接口不变，用例数未降）；修复
  会话页 `/` 带不出 dsh 命令（坑 24：普通成员不被回写 → 改 `@Prop`）
- **下一步**：真机复测坑 23 / 坑 24 → 重截上架截图第 3 张 → 按需重出 `.app`；文档同步（本轮已做）
