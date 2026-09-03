import { spawn } from 'node:child_process'
import type { OrcaEnvelope } from './types.ts'

export type ExecResult = {
  stdout: string
  stderr: string
  code: number | null
}

export function resolveCli(): string {
  const fromEnv = process.env.ORCA_CLI_COMMAND
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return 'orca'
}

export async function runOrca(
  cli: string,
  args: readonly string[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ExecResult> {
  if (opts.signal?.aborted) {
    throw new Error('aborted')
  }
  const argv = args.includes('--json') || args.includes('--help') ? [...args] : [...args, '--json']
  return await new Promise((resolve, reject) => {
    const child = spawn(cli, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: opts.signal,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`timeout after ${opts.timeoutMs}ms`))
      }, opts.timeoutMs)
    }
    child.once('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.once('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
  })
}

export function parseJsonText(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('empty orca stdout')
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1))
    }
    throw new Error('orca stdout is not JSON')
  }
}

export function asEnvelope(raw: unknown): OrcaEnvelope {
  if (!raw || typeof raw !== 'object') {
    return { ok: true, result: raw }
  }
  const rec = raw as Record<string, unknown>
  if (rec.ok === true) return { ok: true, result: rec.result }
  if (rec.ok === false) {
    const err = rec.error
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>
      return {
        ok: false,
        error: {
          code: String(e.code ?? 'orca_error'),
          message: String(e.message ?? 'orca error'),
          data: e.data,
        },
      }
    }
    return { ok: false, error: { code: 'orca_error', message: String(rec.error ?? 'orca error') } }
  }
  return { ok: true, result: raw }
}

export async function orcaJson(
  cli: string,
  args: readonly string[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<OrcaEnvelope> {
  const ran = await runOrca(cli, args, opts)
  let raw: unknown
  try {
    raw = parseJsonText(ran.stdout)
  } catch (err) {
    const hint = ran.stderr.trim() || (err instanceof Error ? err.message : 'parse failed')
    return {
      ok: false,
      error: {
        code: ran.code === 0 ? 'invalid_runtime_response' : 'orca_unavailable',
        message: hint.slice(0, 2000),
      },
    }
  }
  const env = asEnvelope(raw)
  if (!env.ok) return env
  if (ran.code !== 0 && ran.code !== null) {
    return {
      ok: false,
      error: {
        code: 'orca_exit',
        message: ran.stderr.trim() || `orca exited ${ran.code}`,
      },
    }
  }
  return env
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
