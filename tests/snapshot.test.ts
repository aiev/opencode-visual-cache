import assert from "node:assert/strict"
import test from "node:test"
import { emptyDistribution } from "../src/panel/distribution"
import type { PanelApi } from "../src/panel/panel-api"
import { createSnapshotWriter, readDistributionSnapshot } from "../src/panel/snapshot"

function fixture(initial?: unknown) {
  let value = initial
  const writes: any[] = []
  const kv: PanelApi["kv"] = { ready: true, get: <T>() => value as T, set: (_key, next) => { value = next; writes.push(next) } }
  return { kv, writes }
}

test("snapshots are session-owned; legacy, foreign and invalid values cannot contaminate a view", () => {
  const dist = { ...emptyDistribution(), user: 10 }
  for (const initial of [dist, { version: 1, sessionID: "other", dist },
    { version: 1, sessionID: "viewed", dist: { ...dist, apiInput: NaN } }]) {
    assert.equal(readDistributionSnapshot(fixture(initial).kv, "viewed"), undefined)
  }
  assert.deepEqual(readDistributionSnapshot(fixture({ version: 1, sessionID: "viewed", dist }).kv, "viewed"), dist)
})

test("unchanged snapshots do not write; bursts save only their newest value", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const dist = emptyDistribution()
  const f = fixture({ version: 1, sessionID: "a", dist })
  const writer = createSnapshotWriter(f.kv)
  writer.schedule("a", dist); t.mock.timers.tick(250)
  assert.equal(f.writes.length, 0)
  writer.schedule("a", { ...dist, output: 1 })
  writer.schedule("a", { ...dist, output: 2 })
  t.mock.timers.tick(250)
  assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0].dist.output, 2)
})

test("switching sessions flushes the previous snapshot; teardown flushes the latest once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture()
  const writer = createSnapshotWriter(f.kv)
  const dist = emptyDistribution()
  writer.schedule("a", { ...dist, user: 1 })
  writer.schedule("b", { ...dist, user: 2 })
  assert.equal(f.writes[0].sessionID, "a")
  writer.flush(); t.mock.timers.tick(500)
  assert.equal(f.writes.length, 2)
  assert.equal(f.writes[1].sessionID, "b")
})

test("storage failures stay non-critical and a subsequent refresh can retry", async () => {
  const f = fixture()
  const set = f.kv.set
  const writer = createSnapshotWriter(f.kv)
  f.kv.set = () => { throw new Error("sync failure") }
  writer.schedule("a", emptyDistribution()); writer.flush()
  f.kv.set = () => Promise.reject(new Error("failed"))
  writer.schedule("a", emptyDistribution()); writer.flush()
  await Promise.resolve(); await Promise.resolve()
  f.kv.set = set
  writer.schedule("a", emptyDistribution()); writer.flush()
  assert.equal(f.writes.length, 1)
})

test("slow async writes are serialized and only the newest waiting snapshot is retained", async () => {
  const f = fixture()
  const completed: any[] = [], releases: Array<() => void> = []
  const set = f.kv.set
  f.kv.set = (_key, snapshot) => new Promise<void>((resolve) => {
    releases.push(() => { set(_key, snapshot); completed.push(snapshot); resolve() })
  })
  const writer = createSnapshotWriter(f.kv)
  writer.schedule("a", { ...emptyDistribution(), output: 1 }); writer.flush()
  writer.schedule("b", { ...emptyDistribution(), output: 2 }); writer.flush()
  writer.schedule("c", { ...emptyDistribution(), output: 3 }); writer.flush()
  assert.equal(releases.length, 1, "a second storage write cannot race the first")
  releases.shift()!()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(releases.length, 1)
  releases.shift()!()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(completed.map((snapshot) => snapshot.sessionID), ["a", "c"])
  assert.equal(readDistributionSnapshot(f.kv, "c")?.output, 3)
})

test("an identical refresh while an async save is in flight does not duplicate the write", async () => {
  const f = fixture()
  const set = f.kv.set
  let calls = 0, release!: () => void
  f.kv.set = (key, value) => {
    calls++
    return new Promise<void>((resolve) => { release = () => { set(key, value); resolve() } })
  }
  const writer = createSnapshotWriter(f.kv)
  const dist = { ...emptyDistribution(), output: 1 }
  writer.schedule("a", dist); writer.flush()
  writer.schedule("a", dist); writer.flush()
  assert.equal(calls, 1)
  release()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
})

test("a rejected in-flight write does not strand the newest queued snapshot", async () => {
  const f = fixture()
  const set = f.kv.set
  let reject!: (error: Error) => void
  f.kv.set = () => new Promise<void>((_resolve, fail) => { reject = fail })
  const writer = createSnapshotWriter(f.kv)
  writer.schedule("a", emptyDistribution()); writer.flush()
  f.kv.set = set
  writer.schedule("b", { ...emptyDistribution(), output: 2 }); writer.flush()
  assert.equal(f.writes.length, 0)
  reject(new Error("failed"))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(f.writes.length, 1)
  assert.equal(readDistributionSnapshot(f.kv, "b")?.output, 2)
})
