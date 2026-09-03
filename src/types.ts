export type OrcaEnvelope =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string; data?: unknown } }

export type Binder =
  | {
      ok: true
      cli: string
      appVersion: string | null
      capabilities: readonly string[]
      commandSet: ReadonlySet<string>
    }
  | {
      ok: false
      code: 'orca_unavailable' | 'orca_cli_drift'
      message: string
      missing: readonly string[]
      appVersion: string | null
      cli: string
    }

export type LaunchMode = 'handoff' | 'supervise'

export type AgentHandle = {
  agentId: string
  runId: string
  inspect: 'orca'
  agent: string
}

export const REQUIRED_COMMANDS = [
  'open',
  'status',
  'repo add',
  'project setup-existing-folder',
  'worktree create',
  'worktree ps',
  'worktree show',
  'terminal create',
  'terminal send',
  'terminal wait',
  'terminal list',
  'orchestration run-create',
  'orchestration task-create',
  'orchestration worker-start',
  'orchestration check',
  'orchestration worker-stop',
  'skills get',
  'agent-context',
] as const
