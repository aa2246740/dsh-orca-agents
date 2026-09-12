import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('package declares an official dsh.bundle layer', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    main?: string
    scripts?: Record<string, string>
    files?: string[]
    dsh?: { bundle?: { patch?: string } }
  }
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.main, './lib/dsh-orca-agents.js')
  assert.equal(pkg.scripts?.prepare, undefined)
  assert.ok(pkg.files?.includes('lib'))
  assert.ok(pkg.files?.includes('cordis.patch.yml'))
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

test('README leads with the stock dsh plugin add command', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const lead = readme.slice(0, readme.indexOf('\n## '))
  assert.match(lead, /^# dsh-orca-agents\n\n```sh\ndsh plugin --profile web add github:aa2246740\/dsh-orca-agents\n```/)
  assert.match(lead, /pnpm/)
  assert.match(lead, /重启这个 Host/)
  assert.match(lead, /刷新页面/)
  assert.doesNotMatch(readme, /dshx|DSHX_HARNESS|my-plugins/i)
})
