# 0005. 插件生效判定与 dsh 同口径（只看 HMR）

- 状态：已采纳（取代早期「替换已装包无条件需重启」的实现）
- 日期：2026-10-18（提交 81ae116）

## 背景

hub 曾把「替换已装包」（升级/重装）判成无条件 `restart-required`，理由是「Node 模块缓存无法换模块代」。核对 dsh 源码后发现该前提不成立：

- `dsh-hmr` 的 `ModuleFiles` 按磁盘身份（inode/size/mtime）记录已加载的 `file:` 模块，文件变化即判定 stale 并**热重载新模块代**；
- dsh 自身的 `change()` 只在 `ownerContext.get("hmr") === undefined` 或 reconcile 报出 `restartReason` 时才返回 `restart-required`，否则 `applied`。

也就是说 dsh 对「换包」与「装新包」是同一套判据：**有 HMR 即热生效**。hub 的旧口径比 dsh 严，造成「dsh 认为不用重启、hub 却弹重启提示」的体验分裂。

## 决策

`install` / `upgrade` / `remove` / `setEnabled` 的 `application` 字段统一走 `defaultApplication(hmr)`：

- `hmrAvailable(profileDir, bundles)` = 用户层 patch 未显式关闭 HMR **且**（profile 名为 web 或 bundles 含 `@deepseek-ai/dsh-web-app`）；
- HMR 可用 → `applied`（无需重启）；不可用 → `restart-required`，提示文案只解释「该实例未启用热更新」，不提「替换包」。

## 后果

- hub 与 dsh CLI、dsh web 的 Plugins 面板对同一操作给出一致的重启结论；
- 判定集中在 `defaultApplication` 一个函数，后续 dsh 语义变化只改一处；
- 「是否 HMR」的启发式（profile 名 / web-app bundle）在未知场景按无 HMR 保守处理——宁可多提示一次重启，不可误报「已生效」。
