# 0004. 发布策略：windows-unsigned、资产白名单、无自动发布流水线

- 状态：已采纳（决策 3 的「打 tag、建 Release 全部人工」口径已被 [0008](./0008-semi-automated-publish.md) 部分取代：改为人工发起的半自动脚本；其余决策继续有效）
- 日期：2026-09（v0.1.2 source-only）；2026-10-09 起 windows-unsigned（v0.1.3）；全文见 `docs/release-policy.md`

## 背景

桌面应用的公开分发绕不开两道门槛：Windows 代码签名（证书费用 + 签名流程）与 macOS 签名公证（Apple Developer Program + 公证凭据管理）。在两者就绪前，需要一个「诚实且可用」的分发方式——不假装已签名，也不因为没签名就不发。

## 决策

1. 分发模式由每版发布说明的「分发方式」小节**显式声明**，`scripts/release/lib.mjs` 校验：
   - `source-only`：仅 tag + 说明 + 源码归档；
   - `windows-unsigned`：附本地构建的**未签名** Windows NSIS 安装包 + `SHA256SUMS.txt`，说明里明示 SmartScreen 提示与校验方法。
2. **资产白名单**：任何模式都禁止上传 mac 二进制（未签名未公证）、`latest-*.yml`（不提供自动更新元数据）、`.blockmap`。
3. **仓库中不存在自动构建或上传二进制的发布流水线**：构建、打 tag、建 Release 全部人工，`release:check` 只做离线演练；操作口径见 `docs/release-runbook.md`。
4. 所有本地打包脚本必须带 `--publish never`；electron-builder 不配置 GitHub publish provider（机器校验）。

## 后果

- 用户清楚拿到的是什么：未签名包、如何校验、SmartScreen 会怎么提示；
- 恢复 mac 分发有明确门槛（Apple 开发者账号、受控构建机/CI Secret、公证凭据管理），见 policy 文末；
- 代价：每次发版人工步骤多（约 10 分钟），由 runbook 固化；自动化发布需先改本决策。
