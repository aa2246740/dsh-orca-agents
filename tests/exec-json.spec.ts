import assert from 'node:assert/strict'
import { test } from 'node:test'
import { asEnvelope, parseJsonText } from '../src/orca-exec.ts'

test('parseJsonText ignores leading noise', () => {
  const raw = parseJsonText('warn\n{"ok":true,"result":{"a":1}}\n')
  const env = asEnvelope(raw)
  assert.equal(env.ok, true)
  if (env.ok) assert.deepEqual(env.result, { a: 1 })
})

test('keepalive-shaped objects without ok stay as result', () => {
  const env = asEnvelope({ name: 'orca-cli', markdown: '# hi' })
  assert.equal(env.ok, true)
  if (env.ok) {
    const rec = env.result as { name: string }
    assert.equal(rec.name, 'orca-cli')
  }
})
