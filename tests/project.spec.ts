import assert from 'node:assert/strict'
import { test } from 'node:test'
import { absPathOf, inferAgent, repoSelector, sessionCwd, taskName } from '../src/infer.ts'

test('inferAgent reads grok from a human sentence', () => {
  assert.equal(inferAgent(undefined, '帮我用 Orca 让 grok 做个上海天气网页'), 'grok')
})

test('inferAgent normalizes Claude Code and agy', () => {
  assert.equal(inferAgent('Claude Code', 'fix login'), 'claude')
  assert.equal(inferAgent('agy', 'do it'), 'antigravity')
})

test('inferAgent stays unset when no worker is named', () => {
  assert.equal(inferAgent(undefined, '用 Orca 做个天气网页'), undefined)
})

test('inferAgent prefers the explicit agent over a prompt mention', () => {
  assert.equal(inferAgent('codex', 'not grok this time'), 'codex')
})

test('repoSelector uses the DSH folder when repo is omitted', () => {
  assert.equal(repoSelector(undefined, '/tmp/example-proj'), 'path:/tmp/example-proj')
  assert.equal(absPathOf(undefined, '/tmp/example-proj'), '/tmp/example-proj')
  assert.equal(repoSelector('id:abc', '/tmp/example-proj'), 'id:abc')
  assert.equal(absPathOf('id:abc', '/tmp/example-proj'), undefined)
})

test('sessionCwd reads the DSH session header', () => {
  assert.equal(
    sessionCwd({ agent: { session: { header: { cwd: '/tmp/ws' } } } }),
    '/tmp/ws',
  )
  assert.equal(sessionCwd({}), undefined)
})

test('taskName keeps Chinese slugs', () => {
  const name = taskName(undefined, '帮我用 Orca 让 grok 做个上海天气网页')
  assert.match(name, /上海天气/)
  assert.ok(!name.startsWith('dsh-'))
})
