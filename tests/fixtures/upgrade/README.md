# 升级路径夹具(frozen fixtures)

这里的 JSON 文件是**历史版本应用真实写出的落盘形态快照**,用来把「升级不丢数据」变成
可执行断言(任务 T14)。

## 铁律

1. **不要为了让测试通过而改这些文件。** 它们代表**已经发布到用户机器上的字节**;
   改夹具等于篡改历史,测出来的「兼容」是假的。
2. **不要用脚本重新生成它们。** 必须由人手写/从旧版本产物拷贝,并在下方登记来源。
3. schema 演进时,正确做法是**加迁移器**(`createInstanceStore({ migrations })`),而不是改夹具。
   `tests/upgrade/upgrade-path.test.ts` 会在「升了 `REGISTRY_SCHEMA_VERSION` 却没配迁移链」时直接失败。
4. 新增夹具必须是**新文件**(如 `registry-v2.json`),旧文件永久保留。

## 清单

| 文件                      | 来源版本       | 内容                                                                                                                                                                                    | 登记时间   |
| ------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `registry-v1.json`        | 0.1.0          | `<userData>/registry/instances.json`,`schemaVersion: 1`,三种 transport 各一条                                                                                                           | 2026-09-16 |
| `registry-v1-legacy.json` | 0.1.x          | `schemaVersion: 1`,含 v1 下合法、v2 收紧后会被拒的历史值:方括号非 IPv6 主机 `[build.example.internal]`、含空格的 `dshVersion "0.1.5 rc1"`、以及合法 IPv6 方括号 `[::1]`(迁移须保持不变) | 2026-09-27 |
| `settings-v1.json`        | 0.1.0          | `<userData>/settings.json`,五个偏好字段全为**非默认值**(才能发现「升级后字段被重置」)                                                                                                   | 2026-09-16 |
| `settings-future.json`    | (假想更高版本) | 含未知字段 + 两个非法取值,验证前向兼容与逐字段收敛                                                                                                                                      | 2026-09-16 |

## 为什么 `settings-v1.json` 的每个值都必须是「非默认值」

`DEFAULT_SETTINGS` 是 `{language:'zh', theme:'system', tray:false, autoStart:false, notifications:true}`。
如果夹具里某个字段恰好等于默认值,那么「升级后该字段被静默重置为默认值」这个 bug
在断言下**不可见**。所以五个字段刻意全部取反于默认值。
