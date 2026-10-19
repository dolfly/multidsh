# 发布 Runbook（windows-unsigned）

> 本文是发布的**操作口径**：策略与门槛见 [release-policy.md](./release-policy.md)，
> 机器校验见 `pnpm release:check`（离线演练，输出本文对应的收口步骤）；发布执行见 §4 的 `pnpm release:publish`。
> 每次发布按本文逐步执行；流程变化须回写本文，不留口头版本。
> 最近一次完整走通：v0.1.5（2026-10-19）。

## 0. 前置

- Node 22+、pnpm；`git` 与 `gh` 可用（本机 `api.github.com` 需走代理时：`export HTTPS_PROXY=http://127.0.0.1:7897`，`gh` 不读系统 PAC）。
- 构建机要求：
  - **Windows 包在 mac 上交叉构建**（`pnpm dist:win:local`）——electron-builder 自行下载 Windows 版 Electron（`-c.electronDist=` 置空），NSIS 用统一 bundle 的 **arm64 原生 makensis**（`electron-builder.yml` 的 `toolsets.nsis: "1.2.1"`；legacy 3.0.4.1 的 mac 端 makensis 只有 x86_64，未装 Rosetta 的 Apple Silicon 上 spawn EBADCPU 失败）。
  - 构建需访问 GitHub Releases 下载 NSIS bundle 与 win-codesign 工具链：网络受限时 `ELECTRON_GET_USE_PROXY=true HTTPS_PROXY=… pnpm dist:win:local`。
- 本地有推送 origin 的权限；发布说明已评审。

## 1. 门禁与演练

```bash
CI=true pnpm typecheck && CI=true pnpm lint && CI=true pnpm test
DSH_HUB_E2E_HIDDEN=1 CI=true pnpm test:e2e   # 本机边工作边跑；Linux CI 无需 HIDDEN
CI=true pnpm release:check -- --pre
```

演练全绿（PASS/SKIP，无 FAIL）才继续；SKIP 的「HEAD 处于 tag」属预期（发布时才打标签）。

## 2. 版本与发布说明

1. `package.json` 的 `version` 改为目标版本（纯 semver，无 `SNAPSHOT`）。
2. 新增 `docs/releases/v<version>.md`，沿用上一版结构：
   - 一级标题 `# DSH Hub v<version>`、「- 发布日期: YYYY-MM-DD」、「## 分发方式」必须是 `- \`windows-unsigned\``、「## 产物」声明 `DSH-Hub-Setup-<version>.exe` 与 `SHA256SUMS.txt`；
   - 占位符（TODO/待填等）会被 `pnpm test` 拒绝。
3. 提交：`chore: 版本升至 <version> 并添加发布说明`。
4. 再跑一次 `CI=true pnpm test`（发布说明格式由 `tests/upgrade/release-metadata.test.ts` 校验）。

## 3. 构建与校验

```bash
pnpm dist:win:local                                  # Windows 版 Electron + NSIS bundle 需联网
mkdir -p dist/upload && cp dist/DSH-Hub-Setup-<version>.exe dist/upload/
node scripts/release/checksums.mjs dist/upload       # 生成 dist/upload/SHA256SUMS.txt
shasum -a 256 dist/DSH-Hub-Setup-<version>.exe       # 与 SHA256SUMS.txt 第一列比对
```

产物量级参考：v0.1.5 的 exe 为 109,745,019 字节（与 0.1.4 同量级；显著偏离要查因）。

## 4. 半自动发布（推 tag → Draft → 资产核验）

```bash
pnpm release:publish                   # 幂等，可中断重跑
pnpm release:publish -- --dry-run      # 预演：远端查询照常，变更动作只打印不执行
```

脚本（`scripts/release/publish.mjs`）按序执行并逐步打印日志：

1. 发布说明校验：与 `package.json` 版本一致、可解析、无占位符；
2. 本地资产校验：`windows-unsigned` 要求 `dist/upload/` 的安装包与 `SHA256SUMS.txt` 齐全，且实测 sha256 与清单一致；`source-only` 无资产；
3. 前置确认：当前在 main、工作树干净、本地 main 与 origin/main 同步；
4. 推 tag：本地缺失则建于 HEAD；远端缺失则推送，已存在必须与本地一致；
5. 建 Draft 或更新已有 Draft（说明与资产幂等覆盖；已发布的 Release 直接拒绝）；
6. 远端资产白名单核验：与「分发方式」声明的集合**精确一致**（多传少传都拒绝）。

标签必须打在 main 的发布提交上（Source code 归档才有源码语义）——由第 3 步保证。
脚本**不负责构建**（构建仍按 §3 人工执行），也不属于流水线：由人显式发起，策略依据见 `docs/adr/0008-semi-automated-publish.md`。

脚本不可用时的等价人工命令（兜底）：

```bash
git tag -a v<version> -m "DSH Hub <version>"
git push origin v<version>
gh release create v<version> --draft \
  --title "DSH Hub <version>" \
  --notes-file docs/releases/v<version>.md \
  dist/upload/DSH-Hub-Setup-<version>.exe dist/upload/SHA256SUMS.txt
```

## 5. 核验 Draft 并发布

核验 Draft 资产（脚本第 6 步已核验；网页上再目视确认一次）：

```bash
gh api "repos/xbzbing/dsh-hub-desktop/releases?per_page=5" \
  --jq '.[] | select(.tag_name=="v<version>") | {draft, assets: [.assets[].name]}'
```

禁止出现：mac 产物（`.dmg`/`.zip`/`.app`）、`latest-*.yml`、`.blockmap`（见 release-policy 资产白名单）。

确认无误后发布，二选一：

```bash
pnpm release:publish -- --publish   # PATCH draft=false make_latest=true，脚本复核 Latest 指向本 tag
```

或优先用网页上的 **Publish release** 按钮（自动迁移 "Latest" 徽标）。若手动走 API，必须带 `make_latest`：

```bash
gh api -X PATCH "repos/xbzbing/dsh-hub-desktop/releases/<id>" -F draft=false -F make_latest=true
```

核验：

```bash
gh release list --limit 4          # 新版本应带 Latest
gh release view v<version> --json assets,url
```

## 6. 幂等与失败恢复

| 断点 | 处理 |
| --- | --- |
| 构建失败 | 直接重跑；`dist/` 可整体删除重建，不影响仓库 |
| tag 已存在（同版本重发） | 作废 tag：`git tag -d v<version> && git push origin :refs/tags/v<version>`，回到 §4（**破坏性**，确认无人引用后才做） |
| Draft 已存在、资产传错 | 重跑 `pnpm release:publish` 幂等覆盖（`--clobber`）；多余资产 `gh release delete-asset` |
| 已 Publish 后发现致命问题 | 不要删 Release 重发同版本号；发 patch 版本 |
| npm 工具链下载失败（NSIS/win-codesign） | `ELECTRON_GET_USE_PROXY=true HTTPS_PROXY=…` 重跑；已缓存的部分在 `~/Library/Caches/electron-builder/` |

## 7. 发布后

- 在 Release 页人工点开 exe 与 `SHA256SUMS.txt` 各下载一次，确认可下载、大小一致。
- 若本版含行为变更，确认 README / 关键文档无过期表述。
- 本 runbook 与实际执行出现偏差时：以实际为准并回写本文（同一 PR）。
