/** Bounded coalescing, not trailing debounce: sustained streams still refresh. */
export function createCoalescedTask(delay = 100) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: (() => void) | undefined
  const cancel = () => {
    clearTimeout(timer)
    timer = undefined
    pending = undefined
  }
  const flush = () => {
    const task = pending
    cancel()
    task?.()
  }
  return {
    schedule(task: () => void) {
      pending = task
      if (timer === undefined) timer = setTimeout(flush, delay)
    },
    cancel,
    flush,
  }
}

/** V1 can be host-scoped; global V2 events must have a matching owner. */
export function isViewedSessionEvent(event: unknown, sid: string): boolean {
  const e = event as Record<string, any> | undefined
  const data = e?.data ?? e?.properties ?? e?.payload
  const owner = e?.sessionID ?? data?.sessionID ?? data?.info?.sessionID ?? data?.part?.sessionID
  return owner == null ? e?.scope !== "global" : String(owner) === sid
}
