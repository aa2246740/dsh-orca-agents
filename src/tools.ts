import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { bind, failPayload } from './binder.ts'
import { orcaJson, record } from './orca-exec.ts'
import {
  ensureRepo,
  importPath,
  inferAgent,
  launchCommand,
  pickHandle,
  sessionCwd,
  taskName,
  withRuntime,
} from './infer.ts'
import { ensureAgentHooks, startHookWatch, waitForHookDone } from './watch.ts'
import { createFreshRepo, stayInPlace } from './fresh.ts'

const OBJECT_OUT = {
  schema: { type: 'object' as const, additionalProperties: true },
  render: (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value, null, 2) },
  ],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function worktreesOf(result: unknown): Record<string, unknown>[] {
  const rec = record(result)
  const list = rec?.worktrees
  if (!Array.isArray(list)) return []
  return list.filter(isRecord)
}

function projectRow(row: Record<string, unknown>): Record<string, unknown> {
  const agents = Array.isArray(row.agents) ? row.agents.filter(isRecord) : []
  const primary = agents[0]
  return {
    worktreeId: row.worktreeId ?? null,
    displayName: row.displayName ?? null,
    path: row.path ?? null,
    repo: row.repo ?? null,
    branch: row.branch ?? null,
    comment: row.comment ?? '',
    workspaceStatus: row.workspaceStatus ?? null,
    runStatus: primary?.state ?? row.status ?? null,
    interrupted: Boolean(primary?.interrupted),
    agentType: primary?.agentType ?? null,
    lastAssistantMessage: primary?.lastAssistantMessage ?? null,
    liveTerminalCount: row.liveTerminalCount ?? 0,
    lastActivityAt: row.lastActivityAt ?? null,
    agents: agents.map((agent) => ({
      paneKey: agent.paneKey ?? null,
      agentType: agent.agentType ?? null,
      state: agent.state ?? null,
      interrupted: Boolean(agent.interrupted),
      lastAssistantMessage: agent.lastAssistantMessage ?? null,
      prompt: agent.prompt ?? null,
    })),
  }
}

async function psRows(cli: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  const ps = await orcaJson(cli, ['worktree', 'ps'], { signal, timeoutMs: 30_000 })
  if (!ps.ok) return []
  return worktreesOf(ps.result).map(projectRow)
}

function findRow(
  rows: Record<string, unknown>[],
  selector: { worktree?: string; terminal?: string },
): Record<string, unknown> | undefined {
  const wt = selector.worktree?.trim()
  if (!wt) return undefined
  return rows.find((row) => {
    const id = String(row.worktreeId ?? '')
    const name = String(row.displayName ?? '')
    const path = String(row.path ?? '')
    return id === wt || name === wt || path === wt || id.endsWith(wt)
  })
}

function latestRow(rows: Record<string, unknown>[]): Record<string, unknown> | undefined {
  if (rows.length === 0) return undefined
  return [...rows].sort((a, b) => {
    const ta = Date.parse(String(a.lastActivityAt ?? '')) || 0
    const tb = Date.parse(String(b.lastActivityAt ?? '')) || 0
    return tb - ta
  })[0]
}

function pickRow(
  rows: Record<string, unknown>[],
  worktree?: string,
): Record<string, unknown> | undefined {
  return findRow(rows, { worktree }) ?? latestRow(rows)
}

function pickTerminalHandle(result: unknown): string | undefined {
  const rec = record(result)
  const list = rec?.terminals
  const rows = Array.isArray(list) ? list.filter(isRecord) : []
  const live = rows.filter((row) => row.orphaned !== true && typeof row.handle === 'string')
  const writable = live.find((row) => row.writable !== false)
  const picked = writable ?? live[0]
  return typeof picked?.handle === 'string' ? picked.handle : undefined
}

export function registerOrcaTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'orca_runtime_status',
    description:
      'See if the local Orca app is running. Launch already opens Orca. Call this only when you need to report version or drift. Users will not ask for this by name.',
    parameters: {},
    timeoutMs: 90_000,
    output: OBJECT_OUT,
    async execute(_args, exec) {
      const bound = await bind({ signal: exec.signal, force: true })
      if (!bound.ok) return failPayload(bound)
      const status = await orcaJson(bound.cli, ['status'], { signal: exec.signal, timeoutMs: 20_000 })
      if (!status.ok) {
        const opened = await orcaJson(bound.cli, ['open'], { signal: exec.signal, timeoutMs: 60_000 })
        if (!opened.ok) {
          return { ok: false, code: opened.error.code, message: opened.error.message, appVersion: bound.appVersion }
        }
      }
      const live = await bind({ signal: exec.signal, force: true })
      if (!live.ok) return failPayload(live)
      return {
        ok: true,
        appVersion: live.appVersion,
        capabilities: [...live.capabilities],
        drift: { missing: [] },
        guidesBound: true,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'orca_guides',
    description:
      'Print the version-matched Orca skill guide from the live binary (orca-cli or orchestration). Optional query keeps excerpts only.',
    parameters: {
      topic: {
        type: 'string',
        required: true,
        enum: ['orca-cli', 'orchestration'],
        description: 'Which bundled Orca guide to fetch.',
      },
      query: { type: 'string', description: 'Optional case-insensitive excerpt filter.' },
    },
    timeoutMs: 20_000,
    output: OBJECT_OUT,
    async execute(args, exec) {
      const bound = await bind({ signal: exec.signal })
      const cli = bound.cli
      const got = await orcaJson(cli, ['skills', 'get', args.topic], { signal: exec.signal, timeoutMs: 15_000 })
      if (!got.ok) return { ok: false, code: got.error.code, message: got.error.message }
      const body = record(got.result) ?? record(got)
      const markdown = typeof body?.markdown === 'string' ? body.markdown : String(got.result ?? '')
      const q = args.query?.trim().toLowerCase()
      if (!q) {
        return { ok: true, topic: args.topic, markdown, appVersion: bound.ok ? bound.appVersion : null }
      }
      const lines = markdown.split('\n')
      const hits: string[] = []
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].toLowerCase().includes(q)) {
          hits.push(lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 6)).join('\n'))
        }
        if (hits.length >= 12) break
      }
      return {
        ok: true,
        topic: args.topic,
        query: args.query,
        excerpts: hits,
        appVersion: bound.ok ? bound.appVersion : null,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'orca_project_import',
    description:
      'Register a local folder with Orca. Use when the user named a directory and it may not be in Orca yet. Users will not ask for this by name.',
    parameters: {
      path: { type: 'string', required: true, description: 'Folder the user mentioned, as an absolute path if they gave one.' },
    },
    timeoutMs: 45_000,
    output: OBJECT_OUT,
    async execute(args, exec) {
      const path = args.path.trim()
      if (!path.startsWith('/')) {
        return { ok: false, code: 'invalid_argument', message: 'path must be absolute' }
      }
      const ready = await withRuntime(exec.signal)
      if ('error' in ready) return ready.error
      return importPath(ready.binder.cli, path, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'orca_agent_launch',
    description:
      'Start Grok, Codex, Claude, Cursor, or Antigravity in a new empty Orca project. Use when the user says 用 Orca / 在 Orca 里 / 开一栏 / 让 grok 去做. Do not write into the current DSH folder. Omit repo and worktree unless they named a folder or said to stay in this folder. Returns immediately and starts a background watch on Orca agent Stop hooks.',
    parameters: {
      agent: {
        type: 'string',
        description: 'Who to start: grok, codex, claude, antigravity, or cursor. Infer from the sentence. Omit if the prompt already names one.',
      },
      prompt: { type: 'string', required: true, description: 'The user task, in their words. If they asked for a page or app, name the file to write.' },
      name: { type: 'string', description: 'Short label. Optional. Invented from the task if omitted.' },
      repo: {
        type: 'string',
        description: 'Folder they named. Absolute path, or omit to use the current DSH folder.',
      },
      supervise: {
        type: 'boolean',
        description: 'True only if they asked to watch, wait, or be told when it is done.',
      },
      worktree: {
        type: 'string',
        enum: ['new', 'current'],
        description: 'Ignored unless the user asked to stay in this folder. Default is a new empty project.',
      },
    },
    timeoutMs: 120_000,
    output: OBJECT_OUT,
    async execute(args, exec) {
      const ready = await withRuntime(exec.signal)
      if ('error' in ready) return ready.error
      const { cli, capabilities } = ready.binder
      const agent = inferAgent(args.agent, args.prompt)
      if (!agent) {
        return {
          ok: false,
          code: 'need_agent',
          message: 'Which worker should Orca start: grok, codex, claude, cursor, or antigravity?',
        }
      }
      const prompt = args.prompt
      const name = taskName(args.name, prompt)
      const supervise = args.supervise === true
      const stay = stayInPlace(prompt)
      let worktreeMode: 'current' | 'new' = stay ? 'current' : 'new'
      let repoFlag: string | undefined
      if (stay) {
        repoFlag = (await ensureRepo(cli, args.repo, sessionCwd(exec), exec.signal)).selector
      } else if (args.repo?.trim()) {
        repoFlag = (await ensureRepo(cli, args.repo, undefined, exec.signal)).selector
      } else {
        const fresh = createFreshRepo(name)
        await importPath(cli, fresh, exec.signal)
        repoFlag = `path:${fresh}`
      }
      const hooks = await ensureAgentHooks(cli, exec.signal)

      const watch = (payload: Record<string, unknown>) => {
        const worktree = String(payload.agentId ?? '')
        if (!worktree || worktree === 'active') return { ...payload, hooksEnabled: hooks.enabled }
        const jobId = startHookWatch(ctx, exec, {
          cli,
          worktree,
          label: `Orca ${agent} ${payload.name ?? worktree}`,
        })
        return jobId
          ? { ...payload, hooksEnabled: hooks.enabled, jobId, watch: 'orca-agent-hooks' }
          : { ...payload, hooksEnabled: hooks.enabled }
      }

      if (supervise && !capabilities.includes('orchestration.contract.v1')) {
        return {
          ok: false,
          code: 'orchestration_unavailable',
          message: 'Orca orchestration is not enabled. Turn on Settings → Experimental, then retry with supervise.',
        }
      }

      if (!supervise && worktreeMode === 'current') {
        const created = await orcaJson(
          cli,
          [
            'terminal',
            'create',
            '--worktree',
            'active',
            '--title',
            name,
            '--command',
            launchCommand(agent),
          ],
          { signal: exec.signal, timeoutMs: 60_000 },
        )
        if (created.ok) {
          const rec = record(created.result)
          const handle = typeof rec?.handle === 'string' ? rec.handle : ''
          if (handle && prompt) {
            await orcaJson(cli, ['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', '60000'], {
              signal: exec.signal,
              timeoutMs: 70_000,
            })
            const sent = await orcaJson(cli, ['terminal', 'send', '--terminal', handle, '--text', prompt, '--enter'], {
              signal: exec.signal,
              timeoutMs: 20_000,
            })
            if (!sent.ok) return { ok: false, code: sent.error.code, message: sent.error.message }
          }
          return watch({
            ok: true,
            inspect: 'orca',
            agent,
            name,
            agentId: typeof rec?.worktreeId === 'string' ? rec.worktreeId : 'active',
            runId: handle,
            supervise: false,
          })
        }
        worktreeMode = 'new'
      }

      if (!supervise) {
        const argv = ['worktree', 'create', '--name', name, '--no-parent', '--agent', agent, '--prompt', prompt]
        if (repoFlag) argv.push('--repo', repoFlag)
        const created = await orcaJson(cli, argv, { signal: exec.signal, timeoutMs: 90_000 })
        if (!created.ok) return { ok: false, code: created.error.code, message: created.error.message }
        const ids = pickHandle(created.result)
        if ('error' in ids) return { ok: false, code: 'orca_error', message: ids.error }
        return watch({ ok: true, inspect: 'orca', agent, name, supervise: false, ...ids })
      }

      const run = await orcaJson(cli, ['orchestration', 'run-create', '--objective', prompt], {
        signal: exec.signal,
        timeoutMs: 30_000,
      })
      if (!run.ok) return { ok: false, code: run.error.code, message: run.error.message }
      const runRec = record(run.result)
      const runId = typeof runRec?.id === 'string' ? runRec.id : typeof runRec?.runId === 'string' ? runRec.runId : ''

      const task = await orcaJson(cli, ['orchestration', 'task-create', '--spec', prompt], {
        signal: exec.signal,
        timeoutMs: 30_000,
      })
      if (!task.ok) return { ok: false, code: task.error.code, message: task.error.message }
      const taskRec = record(task.result)
      const taskId =
        (typeof taskRec?.id === 'string' && taskRec.id) ||
        (typeof taskRec?.taskId === 'string' && taskRec.taskId) ||
        ''
      if (!taskId) return { ok: false, code: 'orca_error', message: 'task-create returned no id' }

      const wtFlag = worktreeMode === 'current' ? 'current' : 'new-top-level'
      const workerArgs = [
        'orchestration',
        'worker-start',
        '--task',
        taskId,
        '--worktree',
        wtFlag,
        '--agent',
        agent,
        '--name',
        name,
      ]
      if (repoFlag) workerArgs.push('--repo', repoFlag)
      const worker = await orcaJson(cli, workerArgs, { signal: exec.signal, timeoutMs: 90_000 })
      if (!worker.ok) return { ok: false, code: worker.error.code, message: worker.error.message }
      const workerRec = record(worker.result)
      const dispatchId =
        (typeof workerRec?.dispatchId === 'string' && workerRec.dispatchId) ||
        (typeof record(workerRec?.dispatch)?.id === 'string' && String(record(workerRec?.dispatch)?.id)) ||
        ''
      const ids = pickHandle(worker.result)
      return watch({
        ok: true,
        inspect: 'orca',
        agent,
        name,
        supervise: true,
        runId: 'error' in ids ? dispatchId : ids.runId || dispatchId,
        agentId: 'error' in ids ? (typeof workerRec?.worktreeId === 'string' ? workerRec.worktreeId : runId) : ids.agentId,
        dispatchId,
        orchestrationRunId: runId,
        taskId,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'orca_agent_list',
    description: 'How the Orca workers are doing. Use when the user asks 怎么样了 / 好了没 / 进度. They will not name this tool.',
    parameters: {},
    timeoutMs: 30_000,
    output: OBJECT_OUT,
    async execute(_args, exec) {
      const ready = await withRuntime(exec.signal)
      if ('error' in ready) return ready.error
      const rows = await psRows(ready.binder.cli, exec.signal)
      return { ok: true, worktrees: rows }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'orca_agent_get',
    description: 'Show one Orca worker plus its live terminals. Use when the user asks about a named worker, or after list. They will not pass ids.',
    parameters: {
      worktree: {
        type: 'string',
        description: 'Name, id, or path they mentioned. Omit to use the latest worker.',
      },
    },
    timeoutMs: 30_000,
    output: OBJECT_OUT,
    async execute(args, exec) {
      const ready = await withRuntime(exec.signal)
      if ('error' in ready) return ready.error
      const { cli } = ready.binder
      const rows = await psRows(cli, exec.signal)
      const row = pickRow(rows, args.worktree)
      if (!row) return { ok: false, code: 'not_found', message: args.worktree ? `no worktree matching ${args.worktree}` : 'no Orca worktrees' }
      const selector = typeof row.worktreeId === 'string' ? `id:${row.worktreeId}` : args.worktree
      const shown = await orcaJson(cli, ['worktree', 'show', '--worktree', selector], {
        signal: exec.signal,
        timeoutMs: 20_000,
      })
      const terminals = await orcaJson(cli, ['terminal', 'list', '--worktree', selector], {
        signal: exec.signal,
        timeoutMs: 20_000,
      })
      return {
        ok: true,
        worktree: row,
        show: shown.ok ? shown.result : shown.error,
        terminals: terminals.ok ? terminals.result : terminals.error,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'orca_agent_followup',
    description:
      'Send a follow-up into an Orca worker. Use when the user says 再跟他说 / 补一句 / 改方向. They will not pass handles. Deliver even if the worker is still working; Orca queues it.',
    parameters: {
      text: { type: 'string', required: true, description: 'The extra instruction, in their words.' },
      worktree: { type: 'string', description: 'Name, id, or path they mentioned. Omit to use the latest worker.' },
      terminal: { type: 'string', description: 'Optional terminal handle. Omit and the tool finds it.' },
    },
    timeoutMs: 30_000,
    output: OBJECT_OUT,
    async execute(args, exec) {
      const ready = await withRuntime(exec.signal)
      if ('error' in ready) return ready.error
      const { cli } = ready.binder
      const rows = await psRows(cli, exec.signal)
      const row = pickRow(rows, args.worktree)
      if (!row) {
        return { ok: false, code: 'not_found', message: args.worktree ? `no worktree matching ${args.worktree}` : 'no Orca worktrees' }
      }
      let handle = args.terminal?.trim()
      if (!handle) {
        const selector = typeof row.worktreeId === 'string' ? `id:${row.worktreeId}` : String(row.displayName ?? '')
        const listed = await orcaJson(cli, ['terminal', 'list', '--worktree', selector], {
          signal: exec.signal,
          timeoutMs: 20_000,
        })
        handle = listed.ok ? pickTerminalHandle(listed.result) : undefined
      }
      if (!handle) {
        return { ok: false, code: 'not_found', message: 'no live terminal for that worker' }
      }
      const agents = Array.isArray(row.agents) ? row.agents : []
      const busy = agents.some((agent) => isRecord(agent) && agent.state === 'working')
      const sent = await orcaJson(
        cli,
        ['terminal', 'send', '--terminal', handle, '--text', args.text, '--enter'],
        { signal: exec.signal, timeoutMs: 20_000 },
      )
      if (!sent.ok) return { ok: false, code: sent.error.code, message: sent.error.message }
      return { ok: true, queued: busy, terminal: handle, worktree: row.worktreeId ?? null }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'orca_agent_cancel',
    description: 'Stop an Orca worker. Use when the user says 停 / 取消 / 打断. They will not pass handles.',
    parameters: {
      terminal: { type: 'string', description: 'Optional terminal handle. Omit and the tool finds it.' },
      worktree: { type: 'string', description: 'Name, id, or path they mentioned. Omit to use the latest worker.' },
      dispatch: { type: 'string', description: 'Optional orchestration dispatch id.' },
    },
    timeoutMs: 30_000,
    output: OBJECT_OUT,
    async execute(args, exec) {
      const ready = await withRuntime(exec.signal)
      if ('error' in ready) return ready.error
      const { cli } = ready.binder
      let handle = args.terminal?.trim()
      if (!handle) {
        const rows = await psRows(cli, exec.signal)
        const row = pickRow(rows, args.worktree)
        if (!row) {
          return { ok: false, code: 'not_found', message: args.worktree ? `no worktree matching ${args.worktree}` : 'no Orca worktrees' }
        }
        const selector = typeof row.worktreeId === 'string' ? `id:${row.worktreeId}` : String(row.displayName ?? '')
        const listed = await orcaJson(cli, ['terminal', 'list', '--worktree', selector], {
          signal: exec.signal,
          timeoutMs: 20_000,
        })
        handle = listed.ok ? pickTerminalHandle(listed.result) : undefined
      }
      if (!handle) {
        return { ok: false, code: 'not_found', message: 'no live terminal for that worker' }
      }
      const sent = await orcaJson(cli, ['terminal', 'send', '--terminal', handle, '--interrupt'], {
        signal: exec.signal,
        timeoutMs: 20_000,
      })
      if (!sent.ok) return { ok: false, code: sent.error.code, message: sent.error.message }
      if (args.dispatch?.trim()) {
        const stopped = await orcaJson(cli, ['orchestration', 'worker-stop', '--dispatch', args.dispatch.trim()], {
          signal: exec.signal,
          timeoutMs: 20_000,
        })
        if (!stopped.ok) {
          return { ok: true, interrupted: true, workerStop: { ok: false, message: stopped.error.message } }
        }
      }
      return { ok: true, interrupted: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'orca_agent_wait',
    description:
      'Block until an Orca worker finishes. Launch already starts a hook watcher; call this only if the user said 盯着 / 做完告诉我 and you must stay in the turn. Handoff waits on agents[].state from Orca agent Stop hooks. tui-idle is not success.',
    parameters: {
      supervise: { type: 'boolean', description: 'True when launch used supervise: true.' },
      worktree: { type: 'string', description: 'Name, id, or path. Omit to use the latest worker.' },
      timeoutMs: { type: 'number', description: 'Max wait in milliseconds. Default 900000.' },
    },
    timeoutMs: 910_000,
    output: OBJECT_OUT,
    async execute(args, exec) {
      const ready = await withRuntime(exec.signal)
      if ('error' in ready) return ready.error
      const { cli, capabilities } = ready.binder
      const budget = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 900_000
      if (args.supervise === true) {
        if (!capabilities.includes('orchestration.contract.v1')) {
          return {
            ok: false,
            code: 'orchestration_unavailable',
            message: 'Orca orchestration is not enabled. Turn on Settings → Experimental.',
          }
        }
        const checked = await orcaJson(
          cli,
          [
            'orchestration',
            'check',
            '--wait',
            '--types',
            'worker_done,escalation,question',
            '--timeout-ms',
            String(budget),
          ],
          { signal: exec.signal, timeoutMs: budget + 10_000 },
        )
        if (!checked.ok) return { ok: false, code: checked.error.code, message: checked.error.message }
        return { ok: true, status: 'mailbox', result: checked.result }
      }
      const rows = await psRows(cli, exec.signal)
      const row = pickRow(rows, args.worktree)
      const selector = typeof row?.worktreeId === 'string' ? row.worktreeId : args.worktree?.trim()
      if (!selector) {
        return { ok: false, code: 'not_found', message: args.worktree ? `no worktree matching ${args.worktree}` : 'no Orca worktrees' }
      }
      const waited = await waitForHookDone({
        cli,
        worktree: selector,
        signal: exec.signal,
        timeoutMs: budget,
      })
      if (waited.status === 'done' || waited.status === 'interrupted') {
        return { ok: true, ...waited }
      }
      return { ok: false, code: waited.status, message: `wait ended: ${waited.status}`, ...waited }
    },
  }))
}
