# 0007. E2E 双平台 + 隐藏模式与 keyring 处置

- 状态：已采纳
- 日期：2026-09 起逐步成型（ci.yml、DSH_HUB_E2E_HIDDEN、password-store 显式声明）

## 背景

Electron 应用的平台差异大（窗口管理、safeStorage 后端、路径分隔符、焦点行为），只在单平台跑 E2E 会漏掉一半问题——Windows CI 上的 PATH 分隔符断言失败就是实例。另有两类环境干扰：

1. 本机开发者边工作边跑 E2E：真实窗口弹出、抢焦点、打断工作流；
2. 无头环境的 safeStorage：探测不到桌面密钥环时 Chromium 回退 `basic_text`（非真加密），凭据保险库行为与真实桌面不一致，跨重启用例必挂。

## 决策

1. **CI 三 job**：Linux 全套（lint/typecheck/test/build/E2E）+ Windows 全套 + contract（对拍 dsh-auth-gateway 源码）。Linux E2E 经 `xvfb-run` + `dbus-run-session` 起 gnome-keyring，**缺 Secret Service 即失败**（不静默降级）；Windows 用 DPAPI，无需密钥环。
2. **显式声明 safeStorage 后端**：`DSH_HUB_E2E_PASSWORD_STORE=gnome-libsecret`，不让后端随 runner 桌面环境漂移。
3. **隐藏模式** `DSH_HUB_E2E_HIDDEN=1`：窗口从不显示、永不聚焦，供本机跑全量 E2E；焦点守卫对隐藏模式放行（生产路径守卫不变）。
4. **无头下载确认按拒绝处理**（`DSH_HUB_E2E_DECLINE_DOWNLOAD=1`），本地实例启动快速到达确定终态。

## 后果

- 平台回归在 push/PR 时即被拦截；本机可无干扰跑全量 E2E（约 2 分钟）；
- 代价：CI 时间与密钥环装配复杂度上升；密钥环启动脚本较长但失败即可见（打印 keyring 日志）。
