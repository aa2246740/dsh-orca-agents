import { REQUIRED_COMMANDS, type Binder } from './types.ts'
import { orcaJson, parseJsonText, record, resolveCli, runOrca } from './orca-exec.ts'

type Cache = { key: string; binder: Binder }

let cache: Cache | null = null

export function commandNamesFromAgentContext(raw: unknown): string[] {
  const rec = record(raw)
  const result = rec && rec.ok === true ? rec.result : raw
  const body = record(result) ?? rec
  const commands = body?.commands
  if (!Array.isArray(commands)) return []
  const names: string[] = []
  for (const item of commands) {
    const row = record(item)
    if (typeof row?.command === 'string') names.push(row.command)
  }
  return names
}

export function missingRequired(commandSet: ReadonlySet<string>): string[] {
  return REQUIRED_COMMANDS.filter((name) => !commandSet.has(name))
}

export async function bind(opts: { signal?: AbortSignal; force?: boolean } = {}): Promise<Binder> {
  const cli = resolveCli()
  if (cache && !opts.force && cache.binder.cli === cli && cache.binder.ok) {
    return cache.binder
  }

  let commandSet = new Set<string>()
  let schemaVersion = '0'
  try {
    const ctxRun = await runOrca(cli, ['agent-context', '--json'], { signal: opts.signal, timeoutMs: 15_000 })
    const ctxRaw = parseJsonText(ctxRun.stdout)
    const ctxBody = record(ctxRaw)
    schemaVersion = String(ctxBody?.schemaVersion ?? '1')
    commandSet = new Set(commandNamesFromAgentContext(ctxRaw))
  } catch (err) {
    const binder: Binder = {
      ok: false,
      code: 'orca_unavailable',
      message: err instanceof Error ? err.message : 'orca agent-context failed',
      missing: [...REQUIRED_COMMANDS],
      appVersion: null,
      cli,
    }
    cache = { key: cli, binder }
    return binder
  }

  const missing = missingRequired(commandSet)
  if (missing.length > 0) {
    const binder: Binder = {
      ok: false,
      code: 'orca_cli_drift',
      message: `Orca CLI is missing required commands: ${missing.join(', ')}`,
      missing,
      appVersion: null,
      cli,
    }
    cache = { key: cli, binder }
    return binder
  }

  let appVersion: string | null = null
  let capabilities: string[] = []
  const status = await orcaJson(cli, ['status'], { signal: opts.signal, timeoutMs: 20_000 })
  if (status.ok) {
    const result = record(status.result)
    const runtime = record(result?.runtime)
    if (typeof runtime?.appVersion === 'string') appVersion = runtime.appVersion
    if (Array.isArray(runtime?.capabilities)) {
      capabilities = runtime.capabilities.filter((item): item is string => typeof item === 'string')
    }
  }

  const binder: Binder = {
    ok: true,
    cli,
    appVersion,
    capabilities,
    commandSet,
  }
  cache = { key: `${cli}:${appVersion}:${schemaVersion}`, binder }
  return binder
}

export async function ensureRuntime(binder: Binder, signal?: AbortSignal): Promise<Binder> {
  if (!binder.ok) return binder
  const status = await orcaJson(binder.cli, ['status'], { signal, timeoutMs: 20_000 })
  if (status.ok) {
    const result = record(status.result)
    const runtime = record(result?.runtime)
    const reachable = runtime?.reachable === true || record(result?.app)?.running === true
    if (reachable) return binder
  }
  const opened = await orcaJson(binder.cli, ['open'], { signal, timeoutMs: 60_000 })
  if (!opened.ok) {
    return {
      ok: false,
      code: 'orca_unavailable',
      message: opened.error.message,
      missing: [],
      appVersion: binder.appVersion,
      cli: binder.cli,
    }
  }
  return bind({ signal, force: true })
}

export function failPayload(binder: Extract<Binder, { ok: false }>): Record<string, unknown> {
  return {
    ok: false,
    code: binder.code,
    message: binder.message,
    missing: [...binder.missing],
    appVersion: binder.appVersion,
  }
}
