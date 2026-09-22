import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { satisfies } from 'semver'
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

test('Harness peers accept 0.1.5-rc.3 and exclude 0.1.7-alpha', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    peerDependencies?: Record<string, string>
  }
  const skill = pkg.peerDependencies?.['@deepseek-ai/dsh-skill']
  const tools = pkg.peerDependencies?.['@deepseek-ai/dsh-tools']
  const cordis = pkg.peerDependencies?.['@deepseek-ai/cordis']
  assert.equal(skill, '^0.1.5-rc.2')
  assert.equal(tools, '^0.1.5-rc.2')
  assert.equal(cordis, '4.0.2')
  assert.equal(satisfies('0.1.5-rc.3', '^0.1.5-rc.2'), true)
  assert.equal(satisfies('0.1.5-rc.3', '^0.1.2-rc.1'), false)
  assert.equal(satisfies('0.1.7-alpha.2', '^0.1.5-rc.2'), false)
  assert.equal(satisfies('0.1.7-alpha.2', skill ?? ''), false)
  assert.equal(satisfies('0.1.5-rc.3', tools ?? ''), true)
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
