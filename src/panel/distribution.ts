import { estimateTokens, num, type TokenDist } from "../core"

export const emptyDistribution = (): TokenDist => ({
  system: 0, user: 0, agent: 0, toolCall: 0, toolResult: 0,
  output: 0, reasoning: 0, apiOutput: 0, apiInput: 0, stepCost: 0, stepCount: 0,
})
export type SkillUsage = { name: string; tokens: number }
type Contribution = Pick<TokenDist, "user" | "agent" | "toolCall" | "toolResult"> & { skill?: SkillUsage }
type CachedPart = { signature: readonly unknown[]; value: Contribution }
const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i])

/** Cache semantic inputs, never just object identity: host stores mutate in place.
 * Retains only the currently loaded messages and their current parts. */
export function createDistributionCalculator(estimate = estimateTokens) {
  const cache = new Map<string, CachedPart[]>()
  const text = (value: unknown) => typeof value === "string" ? value : ""
  const contribution = (part: Record<string, any>, role: string, previous?: CachedPart): CachedPart => {
    let user = "", agent = "", input = "", result = "", skillName: string | undefined
    if (role === "user") {
      if (part.type === "text" && !part.synthetic && !part.ignored) user = part.text ?? ""
      else if (part.type === "file") user = part.source?.text?.value ?? ""
    } else if (role === "assistant") {
      if (part.type === "tool") {
        const state = part.state ?? {}
        try { input = state.raw ?? (state.input != null ? JSON.stringify(state.input) : "") } catch {}
        if (part.tool === "task") agent = text(state.input?.prompt) || text(state.input?.description)
        if (state.status === "completed") result = state.output ?? ""
        else if (state.status === "error") result = state.error ?? ""
        if (part.tool === "skill" && state.status === "completed") {
          skillName = typeof state.metadata?.name === "string" ? state.metadata.name : undefined
          if (skillName === undefined && typeof result === "string") {
            skillName = result.match(/^#{1,2}\s*Skill:\s*(.+)/m)?.[1]?.trim()
          }
        }
      } else if (part.type === "subtask") agent = part.prompt || part.description || ""
    }
    user = text(user); agent = text(agent); input = text(input); result = text(result)
    const signature = [user, agent, input, result, skillName]
    if (previous && same(previous.signature, signature)) return previous
    const resultTokens = result ? estimate(result) : 0
    return { signature, value: {
      user: user ? estimate(user) : 0, agent: agent ? estimate(agent) : 0,
      toolCall: input ? estimate(input) : 0, toolResult: resultTokens,
      ...(skillName !== undefined ? { skill: { name: skillName, tokens: resultTokens } } : {}),
    } }
  }
  return {
    clear: () => cache.clear(),
    calculate(messages: readonly Record<string, any>[], readParts: (id: string) => readonly any[], systemPrompt = "") {
      const dist = emptyDistribution()
      const skills = new Map<string, SkillUsage>()
      const loaded = new Set<string>()
      const partsByMessage = new Map<string, readonly any[]>()
      if (systemPrompt) dist.system = estimate(systemPrompt)
      for (const message of messages) {
        if (message.role !== "user" && message.role !== "assistant") continue
        const id = String(message.id)
        loaded.add(id)
        if (message.role === "user" && typeof message.system === "string") dist.system += estimate(message.system)
        if (message.role === "assistant") {
          dist.output += num(message.tokens?.output)
          dist.reasoning += num(message.tokens?.reasoning)
        }
        let parts: readonly any[] = []
        try { parts = readParts(id) ?? [] } catch {}
        if (!Array.isArray(parts)) parts = []
        partsByMessage.set(id, parts)
        const previous = cache.get(id)
        const next = parts.map((part, index) => contribution(part ?? {}, message.role, previous?.[index]))
        cache.set(id, next)
        for (const { value } of next) {
          dist.user += value.user; dist.agent += value.agent
          dist.toolCall += value.toolCall; dist.toolResult += value.toolResult
          if (value.skill) {
            const old = skills.get(value.skill.name)
            if (!old || old.tokens < value.skill.tokens) skills.set(value.skill.name, value.skill)
          }
        }
      }
      for (const id of cache.keys()) if (!loaded.has(id)) cache.delete(id)
      const last = [...messages].reverse().find((m) => m.role === "assistant" &&
        num(m.tokens?.input) + num(m.tokens?.cache?.read) + num(m.tokens?.cache?.write) > 0)
      dist.apiInput = num(last?.tokens?.input) + num(last?.tokens?.cache?.read) + num(last?.tokens?.cache?.write)
      dist.apiOutput = num(last?.tokens?.output)
      if (last) {
        let lastCost: number | undefined
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (message.role !== "assistant") continue
          if (message.parentID !== last.parentID) break
          for (const part of partsByMessage.get(String(message.id)) ?? []) {
            if (part?.type !== "step-finish") continue
            dist.stepCount++
            if (lastCost === undefined && typeof part.cost === "number" && Number.isFinite(part.cost)) lastCost = part.cost
          }
        }
        dist.stepCost = lastCost ?? 0
      }
      return { dist, skills: [...skills.values()], hasData:
        dist.system + dist.user + dist.agent + dist.toolCall + dist.toolResult > 0 ||
        dist.apiOutput > 0 || dist.apiInput > 0 || dist.reasoning > 0 }
    },
  }
}
