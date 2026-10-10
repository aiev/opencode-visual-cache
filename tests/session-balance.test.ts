import assert from "node:assert/strict"
import { test } from "node:test"
import { createEffect, createMemo, createRoot, createSignal, onCleanup, untrack } from "solid-js"
import { balanceProviders, type BalanceEntry, type BalanceProvider } from "../src/balance-providers"
import type { PanelApi, PanelSignals } from "../src/panel/panel-api"
import { createSessionBalances } from "../src/v2/session-balance"
import { findOpencodeKeyV2, makeCommands } from "../src/v2/commands"
import { selectedSessionProviderID } from "../src/v2/v2-panel-api"
import type { Context } from "../src/v2/types"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function balance(display: string): BalanceEntry[] {
  return [{ currency: "USD", total: "10", display }]
}

function harness(resolveKey?: (provider: BalanceProvider, source: string) => Promise<string>, timeoutMs?: number) {
  const [active, focus] = createSignal("A")
  const [sources, setSources] = createSignal<Record<string, string>>({ A: "deepseek", B: "alibaba-token-plan", C: "openai" })
  const values = new Map<string, unknown>()
  const calls: Array<{ provider: string; key: string; signal?: AbortSignal }> = []
  let clock = 1_700_000_000_000
  const providers: BalanceProvider[] = ["deepseek", "qwencloud", "openai", "moonshot"].map((id) => ({
    id, name: id,
    requiresKey: id === "qwencloud" ? false : undefined,
    credentialSlot: id === "qwencloud" ? "cookie" : undefined,
    fetchBalance: async (key, signal) => { calls.push({ provider: id, key, signal }); return balance(id) },
  }))
  const kv: PanelApi["kv"] = {
    ready: true,
    get: <T>(key: string, fallback?: T) => values.has(key) ? values.get(key) as T : fallback,
    set: (key, value) => { values.set(key, value) },
  }
  const balances = createSessionBalances({
    activeSessionID: active, providerID: (id) => sources()[id] ?? "", kv, providers,
    resolveKey: resolveKey ?? (async (_, source) => `mock-key:${source}`), now: () => clock, timeoutMs,
  })
  const tab = (id: string) => balances.signals(() => id)
  return {
    balances, active, focus, kv, values, providers, calls, tab,
    setProvider: (id: string, provider: string) => setSources((prev) => ({ ...prev, [id]: provider })),
    advance: (ms: number) => { clock += ms },
  }
}

test("selected provider comes from the tab, not historical responses or a background tab", () => {
  const context = {
    data: { session: {
      get: (id: string) => id === "A" ? { model: { providerID: "alibaba-token-plan", id: "deepseek-v4-flash" } } : {},
      message: { list: () => { throw new Error("historical messages must not choose the account") } },
    } },
    ui: { router: { current: () => ({ type: "session", sessionID: "A" }) }, model: { current: () => ({ providerID: "deepseek", id: "deepseek-v4-flash" }) } },
  } as unknown as Context
  assert.equal(selectedSessionProviderID(context, "A"), "alibaba-token-plan")
  assert.equal(selectedSessionProviderID(context, "B"), "")
  assert.equal(selectedSessionProviderID(context, ""), "")
  context.data.session.get = () => ({ id: "A" })
  assert.equal(selectedSessionProviderID(context, "A"), "deepseek")
})

test("each tab owns its provider and cache; sidebar and footer bindings share only that tab's result", async (t) => {
  const h = harness()
  t.after(h.balances.dispose)
  const dynamic = h.balances.signals(h.active)
  await h.balances.poll()
  assert.equal(h.tab("A").balanceState().data?.[0].display, "deepseek")
  h.focus("B")
  assert.equal(dynamic.balanceProviderId(), "qwencloud")
  assert.equal(dynamic.balanceState().status, "idle")
  await h.balances.poll()
  assert.equal(h.tab("B").balanceState().data?.[0].display, "qwencloud")
  assert.strictEqual(dynamic.balanceState(), h.tab("B").balanceState())
  assert.equal(h.tab("A").balanceState().data?.[0].display, "deepseek")
  h.focus("A")
  await h.balances.poll()
  assert.equal(dynamic.balanceProviderId(), "deepseek")
  assert.equal(h.calls.length, 2, "returning to a tab reuses only its own fresh result")
})

test("late credential resolution from DeepSeek cannot start a query after switching to Alibaba", async (t) => {
  const credentials = deferred<string>()
  const h = harness(() => credentials.promise)
  t.after(h.balances.dispose)
  const old = h.balances.poll()
  h.focus("B")
  await h.balances.poll()
  credentials.resolve("mock-old-key")
  await old
  assert.deepEqual(h.calls.map((call) => call.provider), ["qwencloud"])
  assert.equal(h.tab("A").balanceState().status, "idle")
  assert.equal(h.tab("B").balanceState().data?.[0].display, "qwencloud")
})

test("late responses are aborted and ignored even when the provider ignores its abort signal", async (t) => {
  const late = deferred<BalanceEntry[]>()
  const started = deferred<AbortSignal | undefined>()
  const h = harness()
  t.after(h.balances.dispose)
  h.providers[0].fetchBalance = (_, signal) => { started.resolve(signal); return late.promise }
  const old = h.balances.poll()
  const signal = await started.promise
  h.focus("B")
  await h.balances.poll()
  assert.equal(signal?.aborted, true)
  await old
  late.resolve(balance("stale-deepseek"))
  await Promise.resolve()
  assert.equal(h.tab("B").balanceState().data?.[0].display, "qwencloud")
  assert.equal(h.tab("A").balanceState().status, "idle")
})

test("a provider switch in the same tab takes effect before the next assistant response", async (t) => {
  const h = harness()
  t.after(h.balances.dispose)
  await h.balances.poll()
  h.setProvider("A", "alibaba-token-plan")
  assert.equal(h.tab("A").balanceProviderId(), "qwencloud")
  assert.equal(h.tab("A").balanceState().status, "idle")
  await h.balances.poll()
  assert.equal(h.tab("A").balanceState().data?.[0].display, "qwencloud")
})

test("a model switch rejects an old response even before the app watcher starts the next query", async (t) => {
  const late = deferred<BalanceEntry[]>()
  const started = deferred<void>()
  const h = harness()
  t.after(h.balances.dispose)
  h.providers[0].fetchBalance = () => { started.resolve(); return late.promise }
  const old = h.balances.poll()
  await started.promise
  h.setProvider("A", "alibaba-token-plan")
  late.resolve(balance("stale-deepseek"))
  await old
  assert.equal(h.tab("A").balanceProviderId(), "qwencloud")
  assert.equal(h.tab("A").balanceState().status, "idle")
  await h.balances.poll()
  assert.equal(h.tab("A").balanceState().data?.[0].display, "qwencloud")
})

test("unknown or unsupported tabs never query DeepSeek and invalidate pending credential lookups", async (t) => {
  const credentials = deferred<string>()
  const h = harness(() => credentials.promise)
  t.after(h.balances.dispose)
  const old = h.balances.poll()
  h.focus("unknown")
  assert.equal(h.tab("unknown").balanceProviderId(), "")
  assert.equal(h.tab("unknown").balanceUnsupported(), true)
  await h.balances.poll()
  h.setProvider("unknown", "anthropic")
  await h.balances.poll()
  credentials.resolve("mock-old-key")
  await old
  assert.equal(h.calls.length, 0)
  assert.equal(h.tab("unknown").balanceState().status, "idle")
})

test("cache identity includes the source provider even when its adapter and key are unchanged", async (t) => {
  const sources: string[] = []
  const h = harness(async (_, source) => { sources.push(source); return "same-mock-key" })
  t.after(h.balances.dispose)
  h.setProvider("A", "deepseek-personal")
  await h.balances.poll()
  h.setProvider("A", "deepseek-work")
  assert.equal(h.tab("A").balanceState().status, "idle")
  await h.balances.poll()
  assert.equal(h.calls.length, 2)
  assert.deepEqual(sources, ["deepseek-personal", "deepseek-work"])
  h.setProvider("A", "moonshotai-cn")
  await h.balances.poll()
  assert.equal(h.tab("A").balanceState().data?.[0].display, "moonshot")
})

test("different keyless adapters cannot reuse each other's empty-key cache", async (t) => {
  const h = harness()
  t.after(h.balances.dispose)
  h.providers.find((p) => p.id === "openai")!.requiresKey = false
  h.focus("B")
  await h.balances.poll()
  h.setProvider("B", "openai")
  await h.balances.poll()
  assert.deepEqual(h.calls.map((call) => call.provider), ["qwencloud", "openai"])
  assert.equal(h.tab("B").balanceState().data?.[0].display, "openai")
})

test("credentials, explicit refresh and expiry invalidate a tab's cached result", async (t) => {
  const h = harness()
  t.after(h.balances.dispose)
  await h.kv.set("cache_panel.balance.deepseek.key", "mock-first-key")
  await h.balances.poll()
  await h.balances.poll()
  assert.equal(h.calls.length, 1)
  h.tab("A").setBalanceRefresh(h.tab("A").balanceRefresh() + 1)
  await h.balances.poll()
  assert.equal(h.calls.length, 2)
  await h.kv.set("cache_panel.balance.deepseek.key", "mock-second-key")
  assert.equal(h.tab("A").balanceState().status, "idle")
  await h.balances.poll()
  assert.equal(h.calls.at(-1)?.key, "mock-second-key")
  await h.kv.set("cache_panel.balance.deepseek.key", "")
  await h.balances.poll()
  assert.equal(h.calls.at(-1)?.key, "mock-key:deepseek")
  h.advance(5 * 60 * 1000)
  await h.balances.poll()
  assert.equal(h.calls.length, 5)
})

test("manual selections are persisted per session and do not inherit the legacy global pin", async (t) => {
  const h = harness()
  t.after(h.balances.dispose)
  h.values.set("cache_panel.balance.provider", "deepseek")
  h.values.set("cache_panel.balance.auto", false)
  assert.equal(h.tab("B").autoBalance(), true)
  assert.equal(h.tab("B").balanceProviderId(), "qwencloud")
  h.tab("A").setBalanceProviderId("openai")
  assert.equal(h.tab("A").autoBalance(), false)
  assert.equal(h.tab("A").balanceProviderId(), "openai")
  assert.equal(h.tab("B").balanceProviderId(), "qwencloud")
  assert.deepEqual(h.values.get("cache_panel.balance.session.A"), { auto: false, providerId: "openai" })
  h.tab("A").setAutoBalance(true)
  assert.equal(h.tab("A").balanceProviderId(), "deepseek")
  h.values.set("cache_panel.balance.session.C", { auto: false, providerId: "moonshot" })
  assert.equal(h.tab("C").balanceProviderId(), "moonshot")
})

test("a forced refresh cancelled by a tab switch is retried when that tab regains focus", async (t) => {
  const h = harness()
  t.after(h.balances.dispose)
  await h.balances.poll()
  const late = deferred<BalanceEntry[]>()
  const started = deferred<void>()
  let requests = 0
  h.providers[0].fetchBalance = () => {
    ++requests
    started.resolve()
    return requests === 1 ? late.promise : Promise.resolve(balance("fresh-deepseek"))
  }
  h.tab("A").setBalanceRefresh(1)
  const old = h.balances.poll()
  await started.promise
  h.focus("B")
  await h.balances.poll()
  await old
  h.focus("A")
  await h.balances.poll()
  assert.equal(requests, 2)
  assert.equal(h.tab("A").balanceState().data?.[0].display, "fresh-deepseek")
  late.reject(new Error("late network failure"))
  await Promise.resolve()
  assert.equal(h.tab("A").balanceState().data?.[0].display, "fresh-deepseek")
})

test("missing or failing credentials do not trigger a balance query", async (t) => {
  const missing = harness(async () => "")
  t.after(missing.balances.dispose)
  await missing.balances.poll()
  assert.equal(missing.calls.length, 0)
  assert.equal(missing.tab("A").balanceState().status, "idle")
  const failing = harness(async () => { throw new Error("credential lookup failed") })
  t.after(failing.balances.dispose)
  await failing.balances.poll()
  assert.equal(failing.calls.length, 0)
  assert.equal(failing.tab("A").balanceState().error, "credential lookup failed")
})

for (const name of ["cache-balance", "cache-balance-key"]) {
  test(`${name} dialog changes only its originating tab after focus moves`, async (t) => {
    const h = harness()
    t.after(h.balances.dispose)
    const choose = deferred<string>()
    const context = {
      location: { directory: "/mock-project" },
      data: { location: { provider: { list: () => balanceProviders.map((p) => ({ id: p.id, key: "mock-key" })) } } },
      ui: {
        router: { current: () => ({ type: "session", sessionID: h.active() }) },
        toast: { show: () => {} },
        dialog: { select: () => choose.promise, prompt: async () => "login_qwencloud_ticket=mock-ticket" },
      },
    } as unknown as Context
    const signals = {
      ...h.balances.signals(h.active), langCode: () => "en",
      balanceForSession: (id: string | (() => string)) => ({ ...signals, ...h.balances.signals(typeof id === "function" ? id : () => id) }),
    } as PanelSignals
    const command = makeCommands(context, { kv: h.kv } as PanelApi, signals).find((c) => c.slash?.name === name)!
    const running = command.run()
    h.focus("B")
    choose.resolve("qwencloud")
    await running
    assert.equal(h.tab("A").autoBalance(), false)
    assert.equal(h.tab("A").balanceProviderId(), "qwencloud")
    assert.equal(h.tab("B").autoBalance(), true)
    assert.equal(h.tab("B").balanceRefresh(), 0)
    assert.ok(h.tab("A").balanceRefresh() > 0)
    assert.equal(h.values.has("cache_panel.balance.session.B"), false)
    assert.equal(h.values.get("cache_panel.balance.qwencloud.cookie"), "login_qwencloud_ticket=mock-ticket")
  })
}

test("automatic credentials belong to the tab's exact provider, not the official account", () => {
  const context = {
    location: { directory: "/mock-project" },
    data: { location: { provider: { list: (location: unknown) => {
      assert.strictEqual(location, context.location)
      return [{ id: "deepseek", key: "mock-official-key" }, { id: "deepseek-personal", key: "mock-personal-key" }]
    } } } },
  } as unknown as Context
  const provider = balanceProviders.find((p) => p.id === "deepseek")!
  assert.equal(findOpencodeKeyV2(context, provider, "deepseek-personal"), "mock-personal-key")
  assert.equal(findOpencodeKeyV2(context, provider, "deepseek"), "mock-official-key")
})

test("timeout settles even an uncooperative provider and disposal prevents late updates", async (t) => {
  const h = harness(async () => "mock-key", 5)
  t.after(h.balances.dispose)
  h.providers[0].fetchBalance = () => new Promise(() => {})
  await h.balances.poll()
  assert.equal(h.tab("A").balanceState().error, "TIMEOUT")
  const credentials = deferred<string>()
  const other = harness(() => credentials.promise)
  t.after(other.balances.dispose)
  const pending = other.balances.poll()
  other.balances.dispose()
  await pending
  credentials.resolve("mock-late-key")
  await Promise.resolve()
  assert.equal(other.calls.length, 0)
  assert.equal(other.tab("A").balanceState().status, "idle")
  await other.balances.poll()
  assert.equal(other.calls.length, 0)
})

test("the reactive app owner follows tab/model changes without a sidebar or polling loop", async (t) => {
  const h = harness()
  const dispose = createRoot((dispose) => {
    const target = createMemo(h.balances.watchKey)
    createEffect(() => { void target(); untrack(() => { void h.balances.poll() }) })
    onCleanup(h.balances.dispose)
    return dispose
  })
  t.after(dispose)
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  await settle()
  assert.equal(h.calls.length, 1)
  h.focus("B")
  await settle()
  assert.equal(h.calls.length, 2)
  assert.equal(h.tab("B").balanceState().data?.[0].display, "qwencloud")
  h.setProvider("B", "openai")
  await settle()
  assert.equal(h.calls.length, 3)
  assert.equal(h.tab("B").balanceState().data?.[0].display, "openai")
  h.focus("A")
  await settle()
  assert.equal(h.calls.length, 3)
})
