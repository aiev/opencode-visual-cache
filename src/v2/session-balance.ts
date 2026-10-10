import { createSignal } from "solid-js"
import { balanceCredentialKey, balanceProviders, matchBalanceProvider, type BalanceProvider } from "../balance-providers"
import type { BalanceState, PanelApi, PanelSignals } from "../panel/panel-api"

const KV_PREFIX = "cache_panel"
const POLL_MS = 5 * 60 * 1000
const IDLE: BalanceState = { status: "idle", data: null, lastFetch: 0 }

interface Preference {
  auto: boolean
  providerId: string
}

interface Selection {
  sessionID: string
  sourceProviderID: string
  provider?: BalanceProvider
}

interface Snapshot {
  sourceProviderID: string
  providerId: string
  credentialInput: string
  state: BalanceState
}

interface Options {
  activeSessionID: () => string
  /** The session's selected provider, never the provider of its last response. */
  providerID: (sessionID: string) => string
  kv: PanelApi["kv"]
  resolveKey: (provider: BalanceProvider, sourceProviderID: string) => Promise<string>
  providers?: BalanceProvider[]
  now?: () => number
  timeoutMs?: number
}

type BalanceSignals = Pick<PanelSignals,
  "balanceProviderId" | "setBalanceProviderId" | "autoBalance" | "setAutoBalance" |
  "balanceUnsupported" | "setBalanceUnsupported" | "balanceState" |
  "balanceRefresh" | "setBalanceRefresh"
>

/** One plugin-owned query lifecycle, with preferences and cached results scoped to each tab. */
export function createSessionBalances(options: Options) {
  const providers = options.providers ?? balanceProviders
  const now = options.now ?? Date.now
  const sessions = new Map<string, ReturnType<typeof createSession>>()
  let generation = 0
  let disposed = false
  let cancelRequest: (() => void) | undefined

  function createSession(sessionID: string) {
    const saved = options.kv.get<Preference>(`${KV_PREFIX}.balance.session.${sessionID}`)
    // Do not migrate the old global manual selection: it must not pin every tab to one account.
    const [preference, setPreference] = createSignal<Preference>({
      auto: saved?.auto !== false,
      providerId: providers.some((p) => p.id === saved?.providerId) ? saved!.providerId : "",
    })
    const [snapshot, setSnapshot] = createSignal<Snapshot | undefined>()
    const [refresh, setRefresh] = createSignal(0)
    return { preference, setPreference, snapshot, setSnapshot, refresh, setRefresh, lastRefresh: 0 }
  }

  function session(sessionID: string) {
    let entry = sessions.get(sessionID)
    if (!entry) {
      entry = createSession(sessionID)
      sessions.set(sessionID, entry)
    }
    return entry
  }

  function selection(sessionID: string): Selection {
    const pref = session(sessionID).preference()
    const sourceProviderID = sessionID ? options.providerID(sessionID) : ""
    const id = pref.auto ? matchBalanceProvider(sourceProviderID)?.id : pref.providerId
    return { sessionID, sourceProviderID, provider: sessionID ? providers.find((p) => p.id === id) : undefined }
  }

  function credentialInput(target: Selection): string {
    return target.provider ? options.kv.get<string>(balanceCredentialKey(KV_PREFIX, target.provider), "") ?? "" : ""
  }

  function currentSnapshot(target: Selection): Snapshot | undefined {
    const snapshot = session(target.sessionID).snapshot()
    return snapshot?.providerId === target.provider?.id &&
      snapshot?.sourceProviderID === target.sourceProviderID &&
      snapshot?.credentialInput === credentialInput(target) ? snapshot : undefined
  }

  function savePreference(sessionID: string, pref: Preference) {
    if (!sessionID) return
    session(sessionID).setPreference(pref)
    void Promise.resolve(options.kv.set(`${KV_PREFIX}.balance.session.${sessionID}`, pref)).catch(() => {})
  }

  function signals(sessionID: () => string): BalanceSignals {
    return {
      balanceProviderId: () => selection(sessionID()).provider?.id ?? "",
      setBalanceProviderId: (providerId) => savePreference(sessionID(), { auto: false, providerId }),
      autoBalance: () => session(sessionID()).preference().auto,
      setAutoBalance: (auto) => savePreference(sessionID(), { auto, providerId: selection(sessionID()).provider?.id ?? "" }),
      balanceUnsupported: () => !selection(sessionID()).provider,
      // Unsupported status is derived from this tab's selection, not shared mutable state.
      setBalanceUnsupported: () => {},
      balanceState: () => currentSnapshot(selection(sessionID()))?.state ?? IDLE,
      balanceRefresh: () => session(sessionID()).refresh(),
      setBalanceRefresh: (value) => { session(sessionID()).setRefresh(value) },
    }
  }

  /** Reactive dependencies for the app owner; excludes query state to avoid polling loops. */
  function watchKey(): string {
    const target = selection(options.activeSessionID())
    return JSON.stringify([target.sessionID, target.sourceProviderID, target.provider?.id,
      credentialInput(target), session(target.sessionID).refresh()])
  }

  function cancel() {
    ++generation // Invalidate before any credential lookup, early return, or abort callback.
    cancelRequest?.()
    cancelRequest = undefined
  }

  async function poll(): Promise<void> {
    cancel()
    if (disposed) return
    const target = selection(options.activeSessionID())
    const provider = target.provider
    if (!provider) return // Unknown/unsupported is never a fallback to DeepSeek.

    const seq = generation
    const entry = session(target.sessionID)
    const input = credentialInput(target)
    const previous = currentSnapshot(target)
    const requestedRefresh = entry.refresh()
    const force = requestedRefresh !== entry.lastRefresh
    const controller = new AbortController()
    let timedOut = false
    const isCurrent = () => {
      const current = selection(options.activeSessionID())
      return !disposed && seq === generation && current.sessionID === target.sessionID &&
        current.sourceProviderID === target.sourceProviderID && current.provider?.id === provider.id &&
        credentialInput(current) === input && entry.refresh() === requestedRefresh
    }
    const set = (state: BalanceState) => entry.setSnapshot({
      sourceProviderID: target.sourceProviderID, providerId: provider.id, credentialInput: input, state,
    })

    // Race even providers/credential resolvers that ignore abort, so disposal and timeout settle promptly.
    let rejectAbort: (error: Error) => void = () => {}
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
    const onAbort = () => rejectAbort(new Error(timedOut ? "TIMEOUT" : "ABORTED"))
    controller.signal.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, options.timeoutMs ?? 10_000)
    const cancelThis = () => {
      clearTimeout(timer)
      controller.abort()
      // Keep a completed result for this tab; never leave an abandoned loading state behind.
      entry.setSnapshot(previous?.state.status === "ok" ? previous : undefined)
    }
    cancelRequest = cancelThis

    try {
      if (force || previous?.state.status !== "ok") set({ ...IDLE, status: "loading" })
      let key = input
      if (!key && provider.requiresKey !== false) {
        key = await Promise.race([options.resolveKey(provider, target.sourceProviderID), aborted])
      }
      if (!isCurrent() || controller.signal.aborted) return
      if (!key && provider.requiresKey !== false) { set(IDLE); return }
      if (!force && previous?.state.status === "ok" && previous.state.key === key &&
        now() - previous.state.lastFetch < POLL_MS) {
        entry.setSnapshot(previous)
        return
      }
      set({ ...IDLE, status: "loading", key })
      const data = await Promise.race([provider.fetchBalance(key, controller.signal), aborted])
      if (isCurrent() && !controller.signal.aborted) set({ status: "ok", data, lastFetch: now(), key })
    } catch (err) {
      if (isCurrent() && (!controller.signal.aborted || timedOut)) {
        set({ ...IDLE, status: "error", error: timedOut ? "TIMEOUT" : err instanceof Error ? err.message : "" })
      }
    } finally {
      // A cancelled refresh is still owed when the user returns to this tab.
      if (isCurrent() && (!controller.signal.aborted || timedOut)) entry.lastRefresh = requestedRefresh
      clearTimeout(timer)
      controller.signal.removeEventListener("abort", onAbort)
      if (cancelRequest === cancelThis) cancelRequest = undefined
    }
  }

  function dispose() {
    disposed = true
    cancel()
  }

  return { activeSessionID: options.activeSessionID, signals, watchKey, poll, dispose }
}

export type SessionBalances = ReturnType<typeof createSessionBalances>
