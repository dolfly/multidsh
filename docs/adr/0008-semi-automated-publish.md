# 0008. 半自动发布脚本（publish.mjs）：人工发起、逐步幂等、停点可控

- 状态：已采纳
- 日期：2026-10-19
- 取代关系：部分取代 [0004](./0004-release-windows-unsigned.md) 决策 3 的「打 tag、建 Release 全部人工」口径；0004 的分发模式、资产白名单、「无自动发布流水线」与 `--publish never` 约束全部继续有效

## 背景

v0.1.5 按 `docs/release-runbook.md` 全人工走通发布约 10 分钟，其中推 tag、建 Draft、传资产、PATCH 发布是一段**机械且易错**的命令序列：忘了带 `make_latest` 会丢 Latest 徽标，资产清单手点核对会漏。工程计划 R3 提出用脚本固化这段序列（此前拍板是「先人工走 0.1.6，仍觉繁琐再立项」；0.1.5 实操后确认该段值得固化）。

## 决策

1. 新增 `scripts/release/publish.mjs`（`pnpm release:publish`）：发布说明校验 → 本地资产校验（含 sha256 与清单比对）→ 前置确认（main / 工作树 / origin 同步）→ 推 tag → 建/更新 Draft → 远端资产白名单**精确集合**核验 →（`--publish`）`PATCH draft=false make_latest=true` 并复核 Latest 指向。
2. **不负责构建**：构建依赖本机环境，仍人工执行；脚本只校验产物就绪。
3. **不是流水线**：由人显式发起，仓库依旧不存在自动构建或上传二进制的 CI 发布流程；`--dry-run` 只打印变更动作，供发布前预演。
4. **逐步幂等**：各步已存在则跳过或更新（tag 一致跳过、Draft 说明与资产 `--clobber` 覆盖），可中断重跑；已发布的 Release 一律拒绝改动（纠错发 patch 版本，见 runbook §6）。
5. 默认**停在 Draft**，由人在网页确认资产后再 `--publish` 或点网页按钮——机器核验与人眼确认各做一次。

## 被否决的备选

- **维持全人工**：序列易错（Latest 徽标事故是真实风险）且每次发版重复，runbook 文本无法防手误。
- **GitHub Actions 自动发布**：与 0004「无自动发布流水线」冲突，Windows exe 构建依赖本机环境，须独立评估，不在本决策范围。

## 后果

- 发布从「照文档敲命令」变为「跑脚本 + 网页目视确认」，幂等可重跑；
- 决策逻辑（tag/Draft/资产判定）做成纯函数进 `pnpm test`，误动作面由测试与 `--dry-run` 双重收窄；
- 代价：脚本本身成为发布路径的一部分，其回归由 `tests/upgrade/release-publish.test.ts` 与 `release:check` 覆盖，修脚本须过全量门禁。
