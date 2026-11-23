# dsh-session-delete-easy · 会话永久删除

给 DeepSeek Harness 补上**删除会话**：侧边栏会话行的 `…` 菜单里多一项「删除会话」，确认后把这个会话的对话日志、工作区归属、归档/置顶状态和投影缓存**彻底删掉**。harness 自带的能力只能「归档」——归档会隐藏会话，但日志一直留在磁盘上。

## 安装

```bash
dsh plugin --profile web add dsh-session-delete-easy
```

装完重启 `dsh web`（桌面版在应用内「设置 → 插件」安装，然后退出重开）。安装后在任意会话行的 `…` 菜单里就能看到「删除会话」。

## 功能

- **侧边栏菜单项** —— 会话行 `…` 菜单里的「删除会话」，用内置删除操作的警示色；点了先弹确认框，确认才真删。
- **Agent 工具** —— `session_delete`（删一个会话）、`session_delete_list`（列出会话、能否立刻删、哪些还挂着待删标记）。
- **删除范围**

  | 清掉的东西 | 位置 |
  |---|---|
  | 对话日志（全部事件 + header） | `<会话根>/<工作区>/<会话id>/` |
  | 工作区归属 | 工作区记录里的 `sessionIds` |
  | 归档 / 置顶记录 | 工作区注册表的持久化状态 |
  | 投影缓存 | `session_projcache` 存储域 |
  | 空工作区目录 | 该工作区下最后一个会话被删时顺手清理，非空则保留 |

  全文检索索引（`session-query-sqlite`，默认 `:memory:`）会自己在下一次检索时对账，不用额外处理。

## 活会话怎么处理

harness 正在运行且仍持有某个会话时，那个会话的日志写句柄是打开的，而只有创建它 agent 的那一方能拆掉它——插件拿不到这个能力。直接在打开着的句柄下面删文件，下一次 append 会凭空造出一个没有 header 的日志。

所以活会话分两步：

1. **现在**：停掉它正在跑的工作（回合、子代理、后台 job、定时提醒），并归档隐藏；同时往它自己的日志目录里放一个 `.dsh-session-delete-pending` 标记文件。
2. **下次启动 harness**：启动扫描发现标记、确认该会话已经不是活会话，才真正删目录。

> 标记文件名刻意写成与包名无关的固定名，所以插件以后再改名，也不会让已经打了标记的会话失联（扫描另外兼容曾经的 `.dsh-session-erase-pending`）。

没有打开过的会话则一次调用直接删干净。

## 实测结果

在真实 harness 上用临时 subagent 会话（我自己造的测试会话，没有动任何真实会话）跑通：

| 场景 | 结果 |
|---|---|
| 未打开的会话 | 日志目录、投影缓存、工作区归属、归档/置顶一次性清除 |
| 活会话 | 报告 `pending-restart`；activity 汇总准确列出正在跑的 job 和回合，且 job 进程真的被杀掉；会话变归档隐藏 |
| 延迟删除 | 下次加载时扫到标记 → 确认非活 → 删日志/缓存/归档项，无残留标记 |
| 安全边界 | 非空工作区目录不删；目录名不等于会话 id 时拒绝执行 |

## 已知限制

- 删除**不可撤销**，没有回收站；要可逆请用 harness 自带的「归档」。
- 活会话的日志要等下次启动才真正消失，列表里是立刻隐藏的。
- 确认成功即关闭弹窗，反馈就是那一行消失。
- 插件的 UI 依赖 harness 的会话菜单插槽，harness 大版本改动可能导致菜单项位置变化。

## 可选：加进「设置 → 发现」的市场索引

本插件同时也提供一个**符合官方 plugin market index format 1** 的索引文件（`market/index.json`，已用官方校验器验证通过）。仓库推上去后，把它的 raw 地址填进 设置 → 发现 → 添加索引：

```
https://raw.githubusercontent.com/Yanis1024/dsh-session-delete-easy/main/market/index.json
```

## 和 `dsh-session-delete` 的关系

npm 上的 `dsh-session-delete` 是另一位作者（vtxf）的同名插件，功能相近，所以本插件叫 `dsh-session-delete-easy`。两者互不影响，任选其一；都装会看到两个删除菜单项。

## 配置

bundle 补丁只暴露一个可调项，写在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: session-delete-easy
  name: 'dsh-session-delete-easy'
  config:
    sweepDelayMs: 4000   # 启动后多久执行延迟删除扫描
```

## English

Permanent session deletion for DeepSeek Harness. The harness can only *archive* a session; this adds a **Delete session** row to the session menu (next to the built-in Archive), with a confirmation dialog, and removes the conversation log on disk, the workspace membership, the archive/pin state, and the projection checkpoint.

Install: `dsh plugin --profile web add dsh-session-delete-easy`, then restart `dsh web`.

A session the running harness still holds open is stopped and archived immediately, then erased on the next harness start (its log handle is owned by the running harness). It also registers the `session_delete` and `session_delete_list` agent tools. Deletion is permanent; use the built-in Archive when you need it reversible.

## License

MIT
