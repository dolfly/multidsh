# 0009. E2E 数据目录隔离

- 状态：已采纳
- 日期：2026-10-19

## 背景

E2E 启动的是真实的 Electron 应用，数据目录由 `DSH_HUB_DATA_DIR` 决定；没有注入时应用会落到真实 userData（macOS 为 `~/Library/Application Support/dsh-hub-desktop`），那里存着用户保存的实例清单、凭据保险库和偏好设置。

此前各 spec 各自手写 `hub-data/e2e-*` 路径、各自拼启动环境。隔离只靠约定：漏写一次就会读写真实数据目录，而用例仍然全绿，没有任何断言会失败。这类污染还会误导排障——把失败归因到「真实 userData 残留」，进而去清真实目录。

## 决策

1. E2E 数据目录只能经 `tests/e2e/data-dir.ts` 的 `e2eDataDir()` / `e2eEnv()` 解析，且必须落在仓库 `hub-data/` 下；越界直接抛错，让用例在启动前就失败。
2. 每个 `electron.launch({ env })` 都用 `e2eEnv()` 注入 `DSH_HUB_DATA_DIR`；注入发生在最后，`env` 里的同名键无法覆盖它。额外开关（`HOME`、`PATH`、插件行为开关等）由调用方传入，值为 `undefined` 的键会从结果里删除。
3. `tests/e2e/data-dir.test.ts` 提供静态守卫：每个 spec 必须用 `e2eDataDir()` 声明数据目录、不再手写 `hub-data` 路径、每个 `electron.launch` 必须带 `env: e2eEnv(...)`、不得出现真实 userData 路径或 `homedir()` 当数据目录。
4. Playwright 只收集 `*.spec.ts`（`testMatch`）；同目录下的 Vitest 守卫用例不会被 Playwright 以 CJS 加载器拉起。
5. 怀疑残留污染时只删 `hub-data/` 下该 spec 自己的目录；真实数据目录不得清理或写入（规则见 `AGENTS.md`）。

## 被否决的备选

- **只写进文档**：规则无法证伪，漏写时依旧静默污染，且下一次排障还会照着错误经验去清真实目录。
- **在 globalSetup 里比对真实目录指纹**：用户在本机同时开着应用时（AGENTS 允许「边工作边跑 E2E」）会产生假阳性，而且只能事后发现，拦不住已经发生的写入。
- **给应用加测试专用路径开关**：真实数据目录仍然可达，等于让产品代码为测试让步；`DSH_HUB_DATA_DIR` 已经覆盖这个需求。
- **靠 `beforeAll` 各自删目录**：删的是各 spec 自己解析出的路径，解析错时同样删错，不构成机制。

## 后果

- 新增或改动 spec 漏了隔离时，`pnpm test` 阶段就红，且错误信息直接指向该文件与行号；真实数据不再可能被测试路径命中。
- `hub-data/` 按 spec 分目录，重跑时各 spec 自己清理，互不干扰。
- 代价：新增 spec 必须走 helper；数据目录不再能随手写表达式拼出来。
