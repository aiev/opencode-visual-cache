import assert from "node:assert/strict"
import test from "node:test"
import { createPanelApi } from "../src/v2/v2-panel-api"
import type { Context } from "../src/v2/types"

test("V2 adapter retains real aggregates and mutable parts, model and turn semantics", () => {
  const state = { status: "running", input: { command: "fixture" }, content: [{ type: "text", text: "before" }] }
  const messages = [
    { id: "a", type: "assistant", finish: "tool-calls", cost: 1, model: { providerID: "provider", id: "model" }, content: [{ type: "tool", name: "shell", state }] },
    { id: "b", type: "assistant", finish: "stop", cost: 2 },
    { id: "c", type: "assistant", finish: "stop" },
  ]
  const aggregate = { id: "sid", tokens: { input: 1000, cache: { read: 2000 } }, cost: 3 }
  const api = createPanelApi({ data: { session: { get: () => aggregate, message: { list: () => messages } } },
    renderer: {} } as unknown as Context)
  assert.deepEqual(api.state.session.get("sid")?.tokens, aggregate.tokens)
  assert.equal(api.state.session.get("sid")?.cost, 3)
  const rows = api.state.session.messages("sid")
  assert.equal(rows[0].parentID, rows[1].parentID)
  assert.notEqual(rows[1].parentID, rows[2].parentID)
  assert.equal(rows[0].providerID, "provider")
  assert.equal(api.state.part("a")[0].state.output, "before")
  state.content[0].text = "after"
  state.status = "completed"
  assert.equal(api.state.part("a")[0].state.output, "after")
  assert.equal(api.state.part("a")[0].state.status, "completed")
  assert.deepEqual(api.state.part("a")[1], { type: "step-finish", cost: 1 })
})

test("real V2 events preserve ownership and unsubscribe every bridge listener", () => {
  const listeners = new Map<string, (e: unknown) => void>()
  const api = createPanelApi({ data: { on: (type: string, cb: (e: unknown) => void) => {
    listeners.set(type, cb); return () => listeners.delete(type)
  } }, renderer: {} } as unknown as Context)
  const events: any[] = []
  const unsub = api.event.on("message.updated", (e) => events.push(e))
  listeners.get("session.step.ended")!({ data: { sessionID: "foreign" } })
  assert.equal(events[0].scope, "global")
  assert.equal(events[0].data.sessionID, "foreign")
  unsub()
  assert.equal(listeners.size, 0)
})
