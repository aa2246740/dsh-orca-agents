import { readdirSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { orcaJson, record } from './orca-exec.ts'

export type HookRunStatus = 'working' | 'done' | 'interrupted' | 'unknown'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function hookRunStatus(row: Record<string, unknown> | undefined): HookRunStatus {
  if (!row) return 'unknown'
  const agents = Array.isArray(row.agents) ? row.agents.filter(isRecord) : []
  if (agents.some((agent) => agent.interrupted === true)) return 'interrupted'
  if (agents.some((agent) => agent.state === 'done')) return 'done'
  if (agents.some((agent) => agent.state === 'working' || agent.state === 'blocked' || agent.state === 'waiting')) {
    return 'working'
  }
  return 'unknown'
}

function matchWorktree(row: Record<string, unknown>, selector: string): boolean {
  const id = String(row.worktreeId ?? '')
  const name = String(row.displayName ?? '')
  const path = String(row.path ?? '')
  return id === selector || name === selector || path === selector || id.endsWith(selector)
}

export function pickWorktree(
  rows: Record<string, unknown>[],
  selector: string,
): Record<string, unknown> | undefined {
  return rows.find((row) => matchWorktree(row, selector))
}

function worktreeRows(result: unknown): Record<string, unknown>[] {
  const rec = record(result)
  const list = rec?.worktrees
  if (!Array.isArray(list)) return []
  return list.filter(isRecord)
}

function peekFiles(absPath: unknown): string[] {
  if (typeof absPath !== 'string' || !absPath.startsWith('/')) return []
  try {
    return readdirSync(absPath).filter((name) => !name.startsWith('.')).slice(0, 24)
  } catch {
    return []
  }
}

export type HookWaitResult = {
  status: 'done' | 'interrupted' | 'timeout' | 'aborted' | 'gone'
  worktree: Record<string, unknown> | null
  files: string[]
  via: 'orca-agent-hooks'
}

export async function waitForHookDone(opts: {
  cli: string
  worktree: string
  signal?: AbortSignal
  timeoutMs?: number
  pollMs?: number
}): Promise<HookWaitResult> {
  const budget = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 1_800_000
  const pollMs = opts.pollMs && opts.pollMs > 0 ? opts.pollMs : 2_000
  const started = Date.now()
  let last: Record<string, unknown> | undefined
  while (!opts.signal?.aborted) {
    const ps = await orcaJson(opts.cli, ['worktree', 'ps'], { signal: opts.signal, timeoutMs: 30_000 })
    const rows = ps.ok ? worktreeRows(ps.result) : []
    last = pickWorktree(rows, opts.worktree)
    const status = hookRunStatus(last)
    if (status === 'done' || status === 'interrupted') {
      return {
        status,
        worktree: last ?? null,
        files: peekFiles(last?.path),
        via: 'orca-agent-hooks',
      }
    }
    if (!last && Date.now() - started > 15_000) {
      return { status: 'gone', worktree: null, files: [], via: 'orca-agent-hooks' }
    }
    if (Date.now() - started > budget) {
      return { status: 'timeout', worktree: last ?? null, files: peekFiles(last?.path), via: 'orca-agent-hooks' }
    }
    await sleep(pollMs, opts.signal)
  }
  return { status: 'aborted', worktree: last ?? null, files: peekFiles(last?.path), via: 'orca-agent-hooks' }
}

export async function ensureAgentHooks(
  cli: string,
  signal?: AbortSignal,
): Promise<{ enabled: boolean }> {
  const status = await orcaJson(cli, ['agent', 'hooks', 'status'], { signal, timeoutMs: 15_000 })
  const body = status.ok ? (record(status.result) ?? record(status)) : null
  if (body?.enabled === true) return { enabled: true }
  const turned = await orcaJson(cli, ['agent', 'hooks', 'on'], { signal, timeoutMs: 20_000 })
  return { enabled: turned.ok }
}

export function startHookWatch(
  ctx: Context,
  exec: { agent?: unknown },
  opts: { cli: string; worktree: string; label: string },
): string | undefined {
  let jobs: Context['jobs'] | undefined
  try {
    jobs = ctx.jobs
  } catch {
    return undefined
  }
  const owner = exec.agent
  if (jobs === undefined || owner === undefined) return undefined
  try {
    return jobs.start({
      kind: 'orca' as never,
      label: opts.label,
      owner: owner as never,
      run: () => {
        const ac = new AbortController()
        const done = waitForHookDone({
          cli: opts.cli,
          worktree: opts.worktree,
          signal: ac.signal,
        }).then((result) => {
          const failed = result.status === 'timeout' || result.status === 'gone' || result.status === 'aborted'
          return {
            status: (failed ? 'failed' : result.status === 'interrupted' ? 'killed' : 'completed') as
              | 'completed'
              | 'killed'
              | 'failed',
            detail: result.status,
            output: JSON.stringify(result, null, 2),
          }
        })
        return {
          cancel: () => ac.abort(),
          done,
        }
      },
    })
  } catch {
    return undefined
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
