import { bind, ensureRuntime, failPayload } from './binder.ts'
import { orcaJson, record } from './orca-exec.ts'
import type { Binder } from './types.ts'

const AGENT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bantigravity\b|\bagy\b/i, 'antigravity'],
  [/\bclaude(?:[\s-]*code)?\b/i, 'claude'],
  [/\bcodex\b/i, 'codex'],
  [/\bcursor\b/i, 'cursor'],
  [/\bgrok\b|\bxai\b/i, 'grok'],
]

export async function withRuntime(
  signal: AbortSignal | undefined,
): Promise<{ binder: Binder } | { error: Record<string, unknown> }> {
  const bound = await bind({ signal })
  if (!bound.ok) return { error: failPayload(bound) }
  const live = await ensureRuntime(bound, signal)
  if (!live.ok) return { error: failPayload(live) }
  return { binder: live }
}

export function taskName(name: string | undefined, prompt: string): string {
  const given = name?.trim()
  if (given) return given.slice(0, 80)
  const slug = prompt
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || `dsh-${Date.now()}`
}

export function launchCommand(agent: string): string {
  if (agent === 'antigravity') return 'agy'
  return agent
}

export function agentsIn(text: string | undefined): string[] {
  if (!text) return []
  const found: string[] = []
  for (const [pattern, id] of AGENT_PATTERNS) {
    if (pattern.test(text) && !found.includes(id)) found.push(id)
  }
  return found
}

export function inferAgent(agent: string | undefined, prompt: string): string | undefined {
  const direct = agent?.trim()
  if (direct) {
    const named = agentsIn(direct)
    if (named.length === 1) return named[0]
    const compact = direct.toLowerCase().replace(/\s+/g, ' ')
    if (compact === 'agy') return 'antigravity'
  }
  const fromPrompt = agentsIn(prompt)
  if (fromPrompt.length === 1) return fromPrompt[0]
  return undefined
}

export function sessionCwd(exec: {
  agent?: { session?: { header?: { cwd?: string } } }
}): string | undefined {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.startsWith('/')) return cwd
  return undefined
}

export function absPathOf(repo: string | undefined, cwd: string | undefined): string | undefined {
  const raw = repo?.trim()
  if (raw) {
    if (raw.startsWith('path:')) {
      const path = raw.slice('path:'.length)
      return path.startsWith('/') ? path : undefined
    }
    if (raw.startsWith('/')) return raw
    return undefined
  }
  if (cwd?.startsWith('/')) return cwd
  return undefined
}

export function repoSelector(repo: string | undefined, cwd: string | undefined): string | undefined {
  const raw = repo?.trim()
  if (raw) {
    if (raw.startsWith('path:') || raw.startsWith('id:') || raw.startsWith('name:')) return raw
    if (raw.startsWith('/')) return `path:${raw}`
    return raw
  }
  if (cwd?.startsWith('/')) return `path:${cwd}`
  return undefined
}

export async function ensureRepo(
  cli: string,
  repo: string | undefined,
  cwd: string | undefined,
  signal?: AbortSignal,
): Promise<{ selector?: string }> {
  const abs = absPathOf(repo, cwd)
  if (abs) {
    await importPath(cli, abs, signal)
    return { selector: `path:${abs}` }
  }
  const selector = repoSelector(repo, cwd)
  return selector ? { selector } : {}
}

export function pickHandle(result: unknown): { agentId: string; runId: string } | { error: string } {
  const rec = record(result)
  const worktree = record(rec?.worktree)
  const agentId =
    (typeof worktree?.id === 'string' && worktree.id) ||
    (typeof rec?.worktreeId === 'string' && rec.worktreeId) ||
    ''
  const startup = record(rec?.startupTerminal)
  const runId =
    (typeof rec?.agentTerminalHandle === 'string' && rec.agentTerminalHandle) ||
    (typeof startup?.handle === 'string' && startup.handle) ||
    (typeof rec?.handle === 'string' && rec.handle) ||
    ''
  if (!agentId && !runId) return { error: 'orca launch returned no worktree or terminal id' }
  return { agentId: agentId || runId, runId: runId || agentId }
}

export async function importPath(
  cli: string,
  absPath: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const added = await orcaJson(cli, ['repo', 'add', '--path', absPath], { signal, timeoutMs: 30_000 })
  if (!added.ok) {
    return { ok: false, code: added.error.code, message: added.error.message }
  }
  const repo = record(added.result)
  const nested = record(repo?.repo) ?? repo
  return {
    ok: true,
    repoId: nested?.id ?? null,
    path: nested?.path ?? absPath,
    displayName: nested?.displayName ?? null,
  }
}
