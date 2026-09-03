import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STAY = /就在这|当前目录|这个文件夹|不要新开|原地改|就在这儿/

export function stayInPlace(prompt: string): boolean {
  return STAY.test(prompt)
}

export function createFreshRepo(name: string): string {
  const base = join(homedir(), 'orca', 'projects')
  mkdirSync(base, { recursive: true })
  const slug = name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `dsh-${Date.now().toString(36)}`
  let dir = join(base, slug)
  if (existsSync(dir)) dir = join(base, `${slug}-${Date.now().toString(36)}`)
  mkdirSync(dir, { recursive: true })
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'dsh-orca',
    GIT_AUTHOR_EMAIL: 'dsh-orca@local',
    GIT_COMMITTER_NAME: 'dsh-orca',
    GIT_COMMITTER_EMAIL: 'dsh-orca@local',
  }
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['commit', '--allow-empty', '-m', 'dsh dispatch'], { cwd: dir, stdio: 'ignore', env: gitEnv })
  return dir
}
