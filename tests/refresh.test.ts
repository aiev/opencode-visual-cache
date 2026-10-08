import assert from "node:assert/strict"
import test from "node:test"
import { createCoalescedTask, isViewedSessionEvent } from "../src/panel/refresh"

test("event filtering respects viewed/override session and preserves host-scoped V1 events", () => {
  assert.equal(isViewedSessionEvent({ scope: "global", data: { sessionID: "foreign" } }, "viewed"), false)
  assert.equal(isViewedSessionEvent({ scope: "global" }, "viewed"), false)
  assert.equal(isViewedSessionEvent({ scope: "global", data: { sessionID: "child" } }, "child"), true)
  assert.equal(isViewedSessionEvent({ properties: { part: { sessionID: "foreign" } } }, "viewed"), false)
  assert.equal(isViewedSessionEvent({ scope: "session" }, "viewed"), true)
  assert.equal(isViewedSessionEvent({}, "viewed"), true)
})

test("bursts coalesce to their latest value without starving a continuous stream", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const task = createCoalescedTask(100)
  const published: number[] = []
  task.schedule(() => published.push(1))
  t.mock.timers.tick(80)
  task.schedule(() => published.push(2))
  t.mock.timers.tick(20)
  assert.deepEqual(published, [2])
  task.schedule(() => published.push(3))
  t.mock.timers.tick(100)
  assert.deepEqual(published, [2, 3])
})

test("cancel drops stale work, flush publishes once and timers cannot survive disposal", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const task = createCoalescedTask()
  let runs = 0
  task.schedule(() => { runs++ }); task.cancel()
  t.mock.timers.tick(200); assert.equal(runs, 0)
  task.schedule(() => { runs++ }); task.flush()
  t.mock.timers.tick(200); assert.equal(runs, 1)
})
