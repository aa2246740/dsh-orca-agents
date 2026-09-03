import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commandNamesFromAgentContext, missingRequired } from '../src/binder.ts'

test('missing worktree create is drift', () => {
  const names = commandNamesFromAgentContext({
    schemaVersion: 1,
    commands: [{ command: 'status' }, { command: 'open' }],
  })
  const missing = missingRequired(new Set(names))
  assert.ok(missing.includes('worktree create'))
})

test('reads commands from runtime envelope', () => {
  const names = commandNamesFromAgentContext({
    ok: true,
    result: { schemaVersion: 1, commands: [{ command: 'worktree create' }] },
  })
  assert.deepEqual(names, ['worktree create'])
})
