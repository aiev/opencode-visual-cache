import type { TokenDist } from "../core"
import type { PanelApi } from "./panel-api"
import { createCoalescedTask } from "./refresh"
import { emptyDistribution } from "./distribution"

const KEY = "cache_panel.dist_snapshot"
type Snapshot = { version: 1; sessionID: string; dist: TokenDist }
const fields = Object.keys(emptyDistribution()) as Array<keyof TokenDist>
export const sameDistribution = (a: TokenDist, b: TokenDist) => fields.every((key) => a[key] === b[key])

/** Legacy snapshots have no owner: do not display them in an arbitrary session. */
export function readDistributionSnapshot(kv: PanelApi["kv"], sid: string): TokenDist | undefined {
  const raw = kv.get<Snapshot>(KEY)
  if (raw?.version !== 1 || raw.sessionID !== sid || !raw.dist) return undefined
  if (!fields.every((key) => typeof raw.dist[key] === "number" && Number.isFinite(raw.dist[key]) && raw.dist[key] >= 0)) return undefined
  return { ...raw.dist }
}

/** Derived cache only. Coalesce and serialize writes, retaining at most the
 * newest waiting value so a slow store cannot build up an unbounded queue. */
export function createSnapshotWriter(kv: PanelApi["kv"], delay = 250) {
  const task = createCoalescedTask(delay)
  let sessionID: string | undefined
  let writing = false
  let queued: Snapshot | undefined
  const finish = () => { writing = false; drain() }
  const drain = () => {
    while (!writing && queued) {
      const snapshot = queued
      queued = undefined
      try {
        const previous = readDistributionSnapshot(kv, snapshot.sessionID)
        if (previous && sameDistribution(previous, snapshot.dist)) continue
        writing = true
        const result = kv.set(KEY, snapshot)
        if (result) {
          void Promise.resolve(result).then(finish, finish)
          return
        }
      } catch { /* Derived cache failures must not break the panel. */ }
      writing = false
    }
  }
  return {
    schedule(sid: string, dist: TokenDist) {
      if (sessionID !== sid) task.flush()
      sessionID = sid
      const snapshot: Snapshot = { version: 1, sessionID: sid, dist: { ...dist } }
      task.schedule(() => {
        queued = snapshot
        drain()
      })
    },
    flush: task.flush,
  }
}
