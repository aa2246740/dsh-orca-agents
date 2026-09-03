import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-orca-agents'
export const inject = ['tools', 'skills', 'jobs']

export async function apply(ctx: Context) {
  const stamp = Date.now()
  const [{ registerOrcaTools }, { orcaAgentsSkill }] = await Promise.all([
    import(`./tools.ts?nl=${stamp}`),
    import(`./skill.ts?nl=${stamp}`),
  ])
  console.log('[my-plugins/dsh-orca-agents] loaded')
  console.log('[my-plugins/dsh-orca-agents] nl-infer')
  registerOrcaTools(ctx)
  ctx.skills.register(orcaAgentsSkill(null))
}
