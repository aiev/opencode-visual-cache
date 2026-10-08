import assert from "node:assert/strict"
import test from "node:test"
import { estimateTokens } from "../src/core"
import { createDistributionCalculator, emptyDistribution } from "../src/panel/distribution"

test("distribution preserves text flags, files, task/subtask instructions, skill maxima and exact API usage", () => {
  const messages = [
    { id: "user", role: "user", system: "user system" },
    { id: "old", role: "assistant", parentID: "old-turn", tokens: { input: 5, output: 2, reasoning: 3 } },
    { id: "a", role: "assistant", parentID: "turn", tokens: { input: 10, output: 4, cache: { read: 20, write: 5 } } },
    { id: "b", role: "assistant", parentID: "turn", tokens: { input: 12, output: 6, reasoning: 2, cache: { read: 30, write: 8 } } },
    { id: "streaming", role: "assistant", parentID: "turn" },
  ]
  const parts: Record<string, any[]> = {
    user: [{ type: "text", text: "hello" }, { type: "text", text: "skip", synthetic: true },
      { type: "text", text: "skip", ignored: true }, { type: "file", source: { text: { value: "file text" } } }],
    old: [{ type: "step-finish", cost: 99 }],
    a: [{ type: "tool", tool: "task", state: { raw: "parameters", input: { prompt: "delegate" }, status: "completed", output: "result" } },
      { type: "tool", tool: "skill", state: { input: {}, status: "completed", output: "# Skill: example\nlong content" } },
      { type: "step-finish", cost: 0.1 }],
    b: [{ type: "subtask", prompt: "subtask instructions" },
      { type: "tool", tool: "skill", state: { status: "completed", metadata: { name: "example" }, output: "short" } },
      { type: "tool", tool: "shell", state: { status: "error", error: "failure" } }, { type: "step-finish", cost: 0.2 }],
    streaming: [],
  }
  const calculator = createDistributionCalculator()
  const result = calculator.calculate(messages, (id) => parts[id], "configured system")
  const e = estimateTokens
  assert.deepEqual(result.dist, { ...emptyDistribution(),
    system: e("configured system") + e("user system"), user: e("hello") + e("file text"),
    agent: e("delegate") + e("subtask instructions"), toolCall: e("parameters") + e("{}"),
    toolResult: e("result") + e("# Skill: example\nlong content") + e("short") + e("failure"),
    output: 12, reasoning: 5, apiInput: 50, apiOutput: 6, stepCount: 2, stepCost: 0.2,
  })
  assert.deepEqual(result.skills, [{ name: "example", tokens: e("# Skill: example\nlong content") }])
  assert.equal(result.hasData, true)
})

test("token-only changes reuse historical text estimation but update exact counters", () => {
  let estimates = 0
  const calculator = createDistributionCalculator((text) => { estimates++; return estimateTokens(text) })
  const message = { id: "a", role: "assistant", tokens: { input: 10, output: 2, reasoning: 0 } }
  const parts = [{ type: "tool", tool: "shell", state: { input: { command: "example" }, status: "completed", output: "large ".repeat(1000) } }]
  const first = calculator.calculate([message], () => parts)
  const previous = estimates
  message.tokens.output = 20
  message.tokens.reasoning = 5
  const next = calculator.calculate([message], () => parts)
  assert.equal(estimates, previous)
  assert.equal(next.dist.toolResult, first.dist.toolResult)
  assert.equal(next.dist.output, 20)
  assert.equal(next.dist.reasoning, 5)
})

test("in-place tool input, output and status changes invalidate semantic contributions", () => {
  const calculator = createDistributionCalculator()
  const message = { id: "a", role: "assistant" }
  const state = { input: { prompt: "before" }, status: "running", output: "", error: "failure" }
  const parts = [{ type: "tool", tool: "task", state }]
  assert.equal(calculator.calculate([message], () => parts).dist.toolResult, 0)
  state.input.prompt = "after with more instructions"
  state.status = "completed"; state.output = "success result"
  const done = calculator.calculate([message], () => parts)
  assert.equal(done.dist.agent, estimateTokens(state.input.prompt))
  assert.equal(done.dist.toolCall, estimateTokens(JSON.stringify(state.input)))
  assert.equal(done.dist.toolResult, estimateTokens(state.output))
  state.status = "error"
  assert.equal(calculator.calculate([message], () => parts).dist.toolResult, estimateTokens(state.error))
})

test("late hydration, removed messages and changed identities do not leave stale contributions", () => {
  const calculator = createDistributionCalculator()
  const message = { id: "a", role: "user" }
  assert.equal(calculator.calculate([message], () => []).hasData, false)
  assert.equal(calculator.calculate([message], () => [{ type: "text", text: "hydrated" }]).dist.user, estimateTokens("hydrated"))
  assert.deepEqual(calculator.calculate([], () => []).dist, emptyDistribution())
  assert.equal(calculator.calculate([message], () => [{ type: "text", text: "different" }]).dist.user, estimateTokens("different"))
  calculator.clear()
  assert.equal(calculator.calculate([message], () => { throw new Error("unavailable") }).hasData, false)
})

test("circular inputs and malformed optional parts do not crash statistics", () => {
  const input: any = {}; input.self = input
  const calculator = createDistributionCalculator()
  const result = calculator.calculate([{ id: "a", role: "assistant", tokens: { input: 1 } }], () =>
    [null, { type: "tool", tool: "shell", state: { input, status: "completed", output: "ok" } }])
  assert.equal(result.dist.toolCall, 0)
  assert.equal(result.dist.toolResult, estimateTokens("ok"))
})

test("non-text task prompts preserve the valid description fallback", () => {
  const calculator = createDistributionCalculator()
  const result = calculator.calculate([{ id: "a", role: "assistant" }], () => [
    { type: "tool", tool: "task", state: { input: { prompt: 42, description: "valid instructions" } } },
  ])
  assert.equal(result.dist.agent, estimateTokens("valid instructions"))
})

test("cached and uncached results agree across in-place edits, reorder, hydration and turn changes", () => {
  const cached = createDistributionCalculator()
  const messages: any[] = [
    { id: "u", role: "user", system: "system" },
    { id: "a", role: "assistant", parentID: "turn", tokens: { input: 3, output: 4, reasoning: 1 } },
    { id: "b", role: "assistant", parentID: "turn", tokens: { input: 5, output: 6 } },
  ]
  const parts: Record<string, any[]> = {
    u: [{ type: "text", text: "user" }],
    a: [{ type: "tool", tool: "skill", state: { input: {}, status: "completed", output: "# Skill: original\npayload" } }, { type: "step-finish", cost: 1 }],
    b: [],
  }
  for (let i = 0; i < 40; i++) {
    messages[1].tokens.output++
    parts.a[0].state.output = `# Skill: skill-${i % 3}\n${"payload ".repeat(i + 1)}`
    parts.a[0].state.input.update = i
    messages[2].parentID = i % 2 ? "other-turn" : "turn"
    parts.b = i % 3 ? [{ type: "step-finish", cost: i / 10 }, { type: "subtask", prompt: `instructions-${i}` }] : []
    parts.u[0].ignored = i % 2 === 0
    const order = i % 5 === 0 ? [messages[0], messages[2], messages[1]] : messages
    const read = (id: string) => parts[id]
    assert.deepEqual(cached.calculate(order, read, "configured"), createDistributionCalculator().calculate(order, read, "configured"))
  }
})
