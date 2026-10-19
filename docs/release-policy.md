# 发布策略

## 当前策略

公开 Release 的分发模式由发布说明的「分发方式」小节显式声明，`scripts/release/lib.mjs` 的 `DISTRIBUTION_MODES` 校验：

- `source-only`：只有 Git tag、Release Note 和 GitHub 自动生成的 `Source code (zip)` / `Source code (tar.gz)`。
- `windows-unsigned`：在 `source-only` 基础上，附带本地构建的 **未签名** Windows NSIS 安装包（`DSH-Hub-Setup-<版本>.exe`）与其校验清单 `SHA256SUMS.txt`。

无论哪种模式，公开 Release **都不上传** macOS 二进制（`.app`、`.dmg`、`.zip`）、自动更新元数据（`latest-*.yml`）与差分中间产物（`.blockmap`）；`scripts/release/lib.mjs` 做形态白名单校验，发布说明声明越界资产会被 `pnpm test` 与 `pnpm release:check` 拒绝。仓库中不存在自动构建或上传二进制的发布流水线：构建始终人工，推 tag、建 Draft、上传资产与发布由 `pnpm release:publish` 半自动执行——人工显式发起、逐步幂等、发布停点可控（决策依据见 `docs/adr/0008-semi-automated-publish.md`）。

关于未签名 Windows 安装包：产物未经代码签名，Windows 首次运行会触发 SmartScreen「未知发布者」提示（点「更多信息 → 仍要运行」可继续）。发布说明必须明示这一点并提供 `SHA256SUMS.txt` 供手工校验完整性。

macOS 二进制在完成签名与公证前仍不公开分发（见下方门槛）。

## 本地构建

以下命令供开发、本机验证、受控测试与发布打包使用：

```bash
pnpm dist
pnpm dist:mac
pnpm dist:mac:zip
pnpm dist:win
pnpm dist:win:local   # mac 上交叉构建 Windows 包
```

所有命令带 `--publish never`。`pnpm dist:mac` 默认只生成未封装的 `.app` 目录；需要 zip 验证时使用 `pnpm dist:mac:zip`。macOS 产物不是官方发布物，不得作为 GitHub Release 资产。

## 发布流程

发布前运行：

```bash
CI=true pnpm release:check -- --pre
```

演练按发布说明声明的分发模式输出对应的收口步骤。构建完成后，推 tag、建 Draft、上传资产与核验由脚本半自动执行（构建本身不在脚本职责内，人工完成）：

```bash
pnpm release:publish                   # 幂等：停在 Draft 并完成资产白名单核验
pnpm release:publish -- --dry-run      # 预演，不执行任何变更
```

确认 Draft 符合分发模式的资产清单后，二选一发布：

```bash
pnpm release:publish -- --publish      # PATCH draft=false make_latest=true 并复核 Latest
```

或在网页点 **Publish release**（自动迁移 "Latest" 徽标）。手动走 API 时必须带 `make_latest="true"`，否则徽标会留在更早的版本上。逐步命令、人工兜底命令与失败恢复见 `docs/release-runbook.md`。

## 恢复 macOS 二进制发布的门槛

恢复 macOS 二进制资产进入公开 Release，必须经独立变更重新评估本策略，并满足以下全部条件：

1. 有效的 Apple Developer Program 成员资格。
2. Developer ID Application 证书及私钥仅安装在受控构建机或安全注入 CI Secret。
3. Apple notarization 凭据或 API key 仅存于系统钥匙串或 CI Secret，绝不进入仓库、日志或 Release Note。
4. 已完成 notarization 和 staple。
5. 已验证签名、公证和可执行性：

   ```bash
   codesign --verify --deep --strict --verbose=2 <App>.app
   spctl --assess --type execute --verbose=4 <App>.app
   xcrun stapler validate <App>.app
   ```

6. 已在干净 macOS 机器完成下载、安装与启动验证。
7. 已明确支持的架构，并对每种分发包完成测试。
8. 安装包、`latest-*.yml` 和校验和通过字节一致性验证。

满足条件后应同时恢复 mac 发布配置、签名/公证流水线、二进制 Release Note 契约和相关验证；在此之前不得预置 GitHub publish provider。

## Windows 代码签名（可选升级）

当前 Windows 安装包未签名，仅以 `SHA256SUMS.txt` 提供完整性校验。日后取得 OV/EV 代码签名证书后，可对安装包做 Authenticode 签名并通过 SmartScreen 验证，再将发布说明的 Windows 安装包替换为签名版本。
