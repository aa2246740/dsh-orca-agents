# dsh-orca-agents

DSH 对话里的 Agent 当调度器，本机 [Orca](https://orca.computer) 当执行面：新建空项目、派 Grok / Codex / Claude / Cursor / Antigravity、盯 Orca Stop hook、干完叫醒 DSH。

工人跑在 Orca 里，不跑在 DSH 的终端里。

```text
你 ──说话──► DSH Agent
                 │  这个插件（defineTool + skill）
                 ▼
            orca CLI  ──►  Orca.app
                              └── 隔离 worktree 里的 grok/codex/…
```

人只要说「用 Orca 让 grok 做个天气网页」。不用报工具名、路径、handle。

## 你需要什么

同一台机器上：

1. **Orca 桌面**，终端里 `orca status --json` 能通（测过 1.4.193）
2. **DSH Web**（能加载 profile 插件，Harness / Local Build 均可）
3. **这个插件** 挂进 DSH 的 web profile
4. **至少一种工人**：`grok` / `codex` / `claude` / `cursor` / `agy`，Orca 认得出
5. **git**（默认会建空项目）

不需要：orcaBot MCP、dsh-ade、自己会写 `orca worktree create`。

监督路径（「盯着做完告诉我」）才用 Orca Settings → Experimental。普通派活不用。

## 安装

插件是 DSH 的 server tool 插件，不是 Orca skill。

```sh
git clone https://github.com/aa2246740/dsh-orca-agents.git
```

在 DSH web profile（通常 `~/.dsh/profiles/web`）加上依赖，并写入 watched patch：

`package.json`：

```json
"dsh-orca-agents": "link:/absolute/path/to/dsh-orca-agents"
```

`cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-orca-agents
      name: dsh-orca-agents
```

新开一个 DSH 会话。说：

> 用 Orca 让 grok 做个天气网页

若本机有 dshx：`dshx check dsh-orca-agents`，再按 `activation-plan --change patch` 热挂。不要为这个插件重启 DSH。

## 行为

- 默认在 `~/orca/projects/<名字>` 建**空 git 仓库**，再开隔离 worktree。不会把当前 DSH 目录拷进去。
- 只有你说「就在这个文件夹里改」才原地做。
- 派完立刻返回。Orca agent Stop hook 把工人标成 `done` 之后，DSH 后台 job 会叫醒这一轮。
- 插件会尝试 `orca agent hooks on`。

## 隐私

插件只在本机调 `orca` CLI，不把对话发到仓库作者或其它服务器。公开仓库只含源码。不要提交 DSH 会话导出、截图、`.env`、Orca worktree。

## 许可

MIT
