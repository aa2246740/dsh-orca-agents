# dsh-orca-agents

DSH 对话里的 Agent 当调度器，本机 [Orca](https://orca.computer) 当执行面：新建空项目，派 Grok / Codex / Claude / Cursor / Antigravity，盯 Orca Stop hook，干完叫醒 DSH。

工人跑在 Orca 里，不跑在 DSH 的终端里。

```text
你 ──说话──► DSH Agent
                 │  这个插件
                 ▼
            orca CLI  ──►  Orca.app
                              └── 隔离 worktree 里的 grok/codex/…
```

人只要说「用 Orca 让 grok 做个天气网页」。不用报工具名、路径、handle。

## 需要什么

同一台机器上：

1. Orca 桌面，终端里 `orca status --json` 能通。测过 1.4.193。
2. DSH Web 和官方 `dsh` CLI，能执行 `dsh plugin add`。
3. 至少一种工人：`grok` / `codex` / `claude` / `cursor` / `agy`，Orca 认得出。
4. 本机 git 命令。派活会 `git init` 空项目。不要 GitHub 账号，也不要 remote。

监督路径「盯着做完告诉我」才用 Orca Settings → Experimental。普通派活不用。

## 安装

```sh
dsh plugin --profile web add github:aa2246740/dsh-orca-agents
```

本地目录或 tarball 也可以：

```sh
dsh plugin --profile web add ./dsh-orca-agents
dsh plugin --profile web add ./dsh-orca-agents-0.2.0.tgz
```

`dsh.bundle` 是开机捕获的。装完重启一次 DSH。新开会话再说。不要再往 profile 的 `cordis.patch.yml` 手写同一条 insert，会重复挂载。

```sh
dsh plugin --profile web remove dsh-orca-agents
```

## 行为

- 默认在 `~/orca/projects/<名字>` 建空 git 仓库，再开隔离 worktree。不会把当前 DSH 目录拷进去。
- 只有你说「就在这个文件夹里改」才原地做。
- 派完立刻返回。Orca agent Stop hook 把工人标成 `done` 之后，DSH 后台 job 会叫醒这一轮。
- 插件会尝试 `orca agent hooks on`。

插件只在本机调 `orca` CLI。不要提交 DSH 会话导出、截图、`.env`、Orca worktree。

## 许可

MIT
