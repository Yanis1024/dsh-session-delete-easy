# dsh-session-delete-easy · 会话永久删除

给 DeepSeek Harness 补上**删除会话**：侧边栏会话行的 `…` 菜单里多一项「删除会话」，确认后把这个会话的对话日志、工作区归属、归档/置顶状态和投影缓存**彻底删掉**。harness 自带的能力只能「归档」——归档会隐藏会话，但日志一直留在磁盘上。

## 安装（同事照这个做）

插件已发布到 npm：**`dsh-session-delete-easy`**。全程在 DeepSeek Harness 图形界面里完成，**不需要命令行**。装完都要**退出并重开 DeepSeek Harness**，然后在任意会话行的 `…` 菜单里就能看到「删除会话」。

### 方式 A：知道包名，直接装（最稳）

1. 设置 → **插件** → **添加插件**
2. **包名或地址** 填 `dsh-session-delete-easy`
3. **安装源** 选 **npm 官方源**（`registry.npmjs.org`）
   - 公司网络访问 npmjs 慢或不通时，改选 **中国大陆镜像源**（`registry.npmmirror.com`）
   - ⚠️ **不要留「默认安装源」**：它走本机 `~/.npmrc`（通常是 npmmirror），镜像还没同步到新版本时会报「未找到相关插件」，而且**不会自动兜底到官方源**
4. 点安装 → 完成后退出并重开 DeepSeek Harness

### 方式 B：在「发现」里搜索后安装

1. 设置 → **插件** → **实验性插件**（更多）→ 启用 **插件市场 / 发现** 组合包
   （`@deepseek-ai/dsh-experimental-plugin-market-bundle`）→ 重启 DeepSeek Harness
2. 打开 **插件页 → 「发现」标签**
3. **管理索引源 → 添加索引 URL**，按你的网络**二选一**：

   | 你的网络 | 索引 URL |
   |---|---|
   | npmjs 能通 | `https://cdn.jsdelivr.net/gh/Yanis1024/dsh-session-delete-easy@main/market/index.json` |
   | npmjs 不通（走国内镜像） | `https://cdn.jsdelivr.net/gh/Yanis1024/dsh-session-delete-easy@main/market/index-npmmirror.json` |

   > **仓库还没推上去时**，可以直接用 npm 上那份索引（同样是 jsDelivr、同样国内可达，**完全不经过 GitHub**）：
   > `https://cdn.jsdelivr.net/npm/dsh-session-delete-easy/market/index.json`
   > 它 pin 的是 `registry.npmjs.org`；npmjs 打不开的同事请走上面的「方式 A + 中国大陆镜像源」。

   > 两份索引内容相同，**只有安装源不同**：前者 pin `registry.npmjs.org`，后者 pin `registry.npmmirror.com`。索引里 pin 的源就是「从发现页安装」时 pnpm 要问的源——所以**选错那份就会装不上**（市场不会自动兜底到另一个源）。
   >
   > 用 jsDelivr 而不是 `raw.githubusercontent.com`：前者国内基本可达，后者经常打不开（连图标都会退化成默认图）。
4. 在「发现」里搜 `delete` 或 `会话` → 找到「**会话永久删除**」→ 安装 → 重启 DeepSeek Harness

### 团队省事：让 profile 自带索引源（可选）

前提是该 profile 已启用上面的市场组合包。在 profile 的 `cordis.patch.yml` 里加一段，同事就不用手动添加索引了：

```yaml
- id: plugin-market
  config:
    indexes:
      - https://cdn.jsdelivr.net/gh/Yanis1024/dsh-session-delete-easy@main/market/index.json
```

`indexes` 是 volatile 字段，改完不用重挂插件。

### 命令行等价物（可选，给作者 / CI 用）

```bash
dsh plugin --profile web add dsh-session-delete-easy
```

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

## 发版流程（维护者）

1. 改完代码，升 `package.json` 里的 `version`
2. 发布到 npm。本仓库作者用的是 npm 12 的**暂存发布**——因为账号 2FA 只有安全密钥（WebAuthn），
   普通 `npm publish` 要的是一串数字 OTP，安全密钥给不出来，而 `npm stage publish`
   把 2FA 推迟到「批准」那一步：

   ```bash
   npx npm@12 stage publish        # 上传到暂存区（这一步不需要 OTP）
   # 再打开 https://www.npmjs.com/settings/<你的用户名>/staged-packages
   # 点 Approve + 安全密钥/passkey —— 这才是"人在现场"的 2FA 证明
   ```

3. **重新生成两份市场索引**（不要手改索引文件，版本/时间一律从 npm registry 取，避免漂移）：

   ```bash
   npm run market:build      # 生成 market/index.json 与 market/index-npmmirror.json
   npm run market:validate   # 用 DeepSeek Harness 自带的官方校验器 parseMarketIndex 校验
   ```

   - `publishTimestamp` 必须是 **Unix 秒**（`Date.parse(published)/1000` 取整），**不是毫秒**
   - `versions` 按 SemVer 降序；`0.0.0-stage` 这种暂存占位版本会被自动剔除
   - 标题/描述/分类写在 `market/meta.json`；图标自动生成 jsDelivr 地址
   - 两份索引只有 `versions[].source.registry` 不同（npmjs / npmmirror）

4. 提交并推送本仓库（索引放在仓库里，jsDelivr 从仓库读）
5. **立刻 purge jsDelivr 缓存**，否则同事那边最长要等缓存过期才看到新版本：

   ```bash
   curl https://purge.jsdelivr.net/gh/Yanis1024/dsh-session-delete-easy@main/market/index.json
   curl https://purge.jsdelivr.net/gh/Yanis1024/dsh-session-delete-easy@main/market/index-npmmirror.json
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

Install from the DeepSeek Harness GUI: **Settings → Plugins → Add plugin**, package name `dsh-session-delete-easy`, install source **npm official registry** (`registry.npmjs.org`) — or the **China mainland mirror** (`registry.npmmirror.com`) if npmjs is unreachable — then quit and reopen the app. There is also a marketplace index for the **Discover** tab (enable the experimental plugin-market bundle first); see the Chinese section above for the two index URLs and the `plugin-market` profile snippet. CLI equivalent: `dsh plugin --profile web add dsh-session-delete-easy`.

A session the running harness still holds open is stopped and archived immediately, then erased on the next harness start (its log handle is owned by the running harness). It also registers the `session_delete` and `session_delete_list` agent tools. Deletion is permanent; use the built-in Archive when you need it reversible.

## License

MIT
