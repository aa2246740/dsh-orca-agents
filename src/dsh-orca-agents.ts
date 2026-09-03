import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { orcaAgentsSkill } from './skill.ts'
import { registerOrcaTools } from './tools.ts'

export const name = 'dsh-orca-agents'
export const inject = ['tools', 'skills', 'jobs']

export function apply(ctx: Context) {
  console.log('[my-plugins/dsh-orca-agents] loaded')
  console.log('[my-plugins/dsh-orca-agents] nl-infer')
  registerOrcaTools(ctx)
  ctx.skills.register(orcaAgentsSkill(null))
}

void defineTool
