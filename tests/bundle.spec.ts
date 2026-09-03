import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('package declares an official dsh.bundle layer', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    main?: string
    dsh?: { bundle?: { patch?: string } }
  }
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.main, './lib/dsh-orca-agents.js')
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id:\s*dsh-orca-agents/)
  assert.match(patch, /name:\s*dsh-orca-agents/)
  assert.doesNotMatch(patch, /\/Users\//)
})

test('published entry is compiled javascript', () => {
  assert.equal(existsSync(join(root, 'lib/dsh-orca-agents.js')), true)
  const js = readFileSync(join(root, 'lib/dsh-orca-agents.js'), 'utf8')
  assert.match(js, /\[my-plugins\/dsh-orca-agents\] loaded/)
  assert.match(js, /\bapply\b/)
  assert.match(js, /\binject\b/)
})
