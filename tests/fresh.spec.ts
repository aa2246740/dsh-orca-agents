import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { createFreshRepo, stayInPlace } from '../src/fresh.ts'

test('stayInPlace is opt-in from human speech, not from worktree=current', () => {
  assert.equal(stayInPlace('帮我用 Orca 让 grok 做个天气网页'), false)
  assert.equal(stayInPlace('就在这个文件夹里改登录'), true)
  assert.equal(stayInPlace('不要新开，原地改'), true)
})

test('createFreshRepo is an empty git repo', () => {
  const dir = createFreshRepo(`iso-test-${Date.now().toString(36)}`)
  try {
    assert.ok(existsSync(join(dir, '.git')))
    const files = execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8' }).trim()
    assert.equal(files, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
