import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

export function orcaAgentsSkill(appVersion: string | null): SkillRegistration {
  const versionLine = appVersion ? `Orca ${appVersion}` : ''
  return {
    name: 'orca-agents',
    description:
      'Dispatch a coding job to the local Orca app. Trigger on 用 Orca / 在 Orca 里 / 开一栏 / 让 grok/codex/claude/agy/cursor 去做, and on 怎么样了 / 好了没 / 再跟他说 / 盯着做完. Natural language is enough. Users will not name tools, ids, or handles.',
    source: 'bundled',
    provider: 'dsh-orca-agents',
    invocation: { modelInvocable: true, userInvocable: true },
    content: `# Orca Agents

Users talk like people. Infer the worker and the job from the sentence.

Examples that mean dispatch:

- 用 Orca 让 grok 做个天气网页
- 帮我在 Orca 里开个 Codex 改登录
- 让 Claude 单独开一栏做这个
- Orca 里那个工人怎么样了
- 再跟他说一声别改数据库
- 盯着做完告诉我

Workers run in the Orca app. Write nothing yourself. Do not use ade_launch.

## What to do

Dispatch, and they did not say 盯着 / 做完告诉我 / 等结果: call \`orca_agent_launch\` once.
- Infer \`agent\` from grok, Codex, Claude, agy, Cursor. If the sentence already names one, you may omit \`agent\`.
- \`prompt\` is their task in their words. If they asked for a page or app, name the file to write (for example \`index.html\`).
- Omit \`repo\` and \`worktree\`. The tool makes a new empty Orca project. Do not send the current DSH folder. Only pass worktree current if they said 就在这个文件夹里改.
- \`supervise\` false.
Launch returns immediately and starts a background watch on Orca agent Stop hooks (\`agents[].state\`). Tell them it is running in Orca. Do not tell them to keep asking 好了没. Do not poll. When a background job notice arrives, read \`job_output\` and tell them it finished, with the path and files.

怎么样了 / 好了没: \`orca_agent_list\`, or \`orca_agent_get\` if they named a worker. If it is still working, the hook watcher will wake you; say that.

补一句 / 改方向: \`orca_agent_followup\` with their words. Omit \`terminal\` and \`worktree\` unless they named one.

盯着 / 做完告诉我 in this same turn: launch already watches; you may also call \`orca_agent_wait\` if you must stay in the turn.

If they named no worker, ask one short question: grok, Codex, Claude, Cursor, or Antigravity.

${versionLine}
`,
  }
}
