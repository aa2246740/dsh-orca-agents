import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hookRunStatus, pickWorktree } from '../src/watch.ts'

test('hookRunStatus reads Orca Stop-hook done', () => {
  assert.equal(hookRunStatus({ agents: [{ state: 'done' }] }), 'done')
  assert.equal(hookRunStatus({ agents: [{ state: 'working' }] }), 'working')
  assert.equal(hookRunStatus({ agents: [{ state: 'done', interrupted: true }] }), 'interrupted')
  assert.equal(hookRunStatus({ agents: [] }), 'unknown')
})

test('pickWorktree matches name, id, or path', () => {
  const rows = [
    { worktreeId: 'abc::/tmp/a', displayName: 'demo-page', path: '/tmp/a' },
    { worktreeId: 'def::/tmp/b', displayName: 'other', path: '/tmp/b' },
  ]
  assert.equal(pickWorktree(rows, 'demo-page')?.path, '/tmp/a')
  assert.equal(pickWorktree(rows, '/tmp/b')?.displayName, 'other')
})
