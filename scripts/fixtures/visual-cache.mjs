const { TokenCachePanel, createPanelApi, createPanelSignals, mapTheme } = await import(process.env.VISUAL_CACHE_FIXTURE_BUNDLE)
import { createComponent } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { writeFileSync } from "node:fs"

const REPORT = process.env.VISUAL_CACHE_FIXTURE_REPORT
const OPTIMIZED = process.env.VISUAL_CACHE_FIXTURE_MODE === "optimized"
const SID = "fixture-cache-session", CHILD = "fixture-cache-child"
const COUNT = 128, TEXT = "synthetic output\n".repeat(1024)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const cpu = () => { const c = process.cpuUsage(); return c.user + c.system }

export default {
  id: "fixture.visual-cache.comparison",
  setup(context) {
    const stores = new Map(), handlers = new Map(), results = [], checks = []
    const counts = { messageLists: 0, modelLists: 0, outputTextReads: 0, snapshotWrites: 0, identicalSnapshotWrites: 0 }
    let lastSnapshot, panel, tail = TEXT
    const messages = Array.from({ length: COUNT }, (_, index) => ({
      id: `fixture-message-${index}`, type: "assistant", finish: "stop", time: Date.now(),
      model: { providerID: "fixture-no-balance", id: "fixture-model" }, cost: 0.001,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 5, write: 0 } },
      content: [{ id: `fixture-tool-${index}`, type: "tool", name: "shell", state: {
        status: "completed", input: { command: "synthetic command" },
        content: [{ type: "text", get text() { counts.outputTextReads++; return index === COUNT - 1 ? tail : TEXT } }],
      } }],
    }))
    const [list, setList] = createSignal(messages)
    const [childStore, setChildStore] = createStore({ messages: [] })
    const setChildList = (messages) => setChildStore("messages", messages)
    const [viewed] = createSignal(SID)
    const [mounted, setMounted] = createSignal(true)
    const [aggregate, setAggregate] = createSignal(undefined)
    const [childAggregate, setChildAggregate] = createSignal(undefined)
    const fake = {
      ...context,
      storage: { ...context.storage,
        store(key, options) {
          if (!stores.has(key)) {
            let value = options.initial.value
            if (key.endsWith(".open") || key.endsWith(".dist") || key.endsWith(".skills")) value = true
            if (key.endsWith(".lang")) value = "en"
            const [state, mutate] = context.storage.memory(`fixture.visual.compare.${key}`, { initial: { value } })
            stores.set(key, [state, async (fn) => {
              mutate((draft) => {
                fn(draft)
                if (key.endsWith(".dist_snapshot")) {
                  counts.snapshotWrites++
                  const snapshot = JSON.stringify(draft.value)
                  if (snapshot === lastSnapshot) counts.identicalSnapshotWrites++
                  lastSnapshot = snapshot
                }
              })
            }])
          }
          return stores.get(key)
        },
      },
      data: { ...context.data,
        session: { ...context.data.session,
          get: (id) => ({ id, parentID: id === CHILD ? SID : undefined, agent: "fixture",
            model: { providerID: "fixture-no-balance", id: "fixture-model" }, ...(id === SID ? aggregate() : childAggregate()) }),
          message: { list: (id) => { counts.messageLists++; return id === SID ? list() : id === CHILD ? childStore.messages : [] } },
        },
        location: { ...context.data.location, model: { list: () => {
          counts.modelLists++
          return [{ providerID: "fixture-no-balance", modelID: "fixture-model", id: "fixture-model",
            cost: [{ input: 1, output: 1, cache: { read: 0.1, write: 1 } }] }]
        } } },
        on(type, callback) {
          if (!handlers.has(type)) handlers.set(type, new Set())
          handlers.get(type).add(callback)
          return () => handlers.get(type).delete(callback)
        },
      },
    }
    const api = createPanelApi(fake), signals = createPanelSignals()
    signals.setSectionBalance(false)
    writeFileSync(REPORT, JSON.stringify({ complete: false, phase: "setup" }))
    context.ui.slot({ append: "sidebar.content", render: () => createComponent(Show, {
      get when() { return mounted() },
      children: (_when) => {
        panel = createComponent(TokenCachePanel, {
          theme: mapTheme(context.theme), api, get sessionId() { return viewed() }, signals,
        })
        return panel
      },
    }) })
    const emit = (type, sid) => {
      for (const fn of handlers.get(type) ?? []) fn({ type, data: { sessionID: sid, id: "fixture-event" } })
    }
    const dist = () => {
      const value = stores.get("opencode-visual-cache.cache_panel.dist_snapshot")?.[0].value
      const raw = value?.dist ?? value
      return raw === undefined ? undefined : JSON.parse(JSON.stringify(raw))
    }
    const rendered = () => {
      const texts = []
      const visit = (node) => {
        if (typeof node?.plainText === "string") texts.push(node.plainText)
        for (const child of node?.getChildren?.() ?? []) visit(child)
      }
      visit(panel)
      return texts.join("\n")
    }
    const check = (name, ok) => { checks.push({ name, ok }); if (!ok) throw new Error(`Check failed: ${name}`) }
    const phase = async (name, action) => {
      const before = { ...counts }, start = performance.now(), beforeCpu = cpu()
      await action()
      await delay(450)
      results.push({ phase: name, wallMilliseconds: Math.round(performance.now() - start),
        cpuMilliseconds: Math.round((cpu() - beforeCpu) / 1000),
        ...Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value - before[key]])) })
    }
    const inspect = async () => {
      try {
        // Sidebar mounting can lag behind plugin setup while the real attached
        // transcript loads. Do not start the fixture before its panel is ready.
        await delay(1200)
        for (let tries = 0; tries < 200 && (!panel || dist()?.output !== COUNT * 5); tries++) await delay(50)
        const initial = dist()
        check("initial exact output", initial?.output === COUNT * 5)
        check("initial exact API input", initial?.apiInput === 15)
        check("rendered initial hit rate", rendered().includes("33.3%"))
        check("rendered initial cost", rendered().includes("$0.128"))
        check("rendered selected model", rendered().includes("fixture-model"))
        await phase("idle", async () => { await delay(300) })
        await phase("foreign-legacy-events", async () => {
          for (let i = 0; i < 8; i++) { emit("message.updated", "other-session"); await delay(20) }
        })
        await phase("foreign-v2-events", async () => {
          for (let i = 0; i < 8; i++) { emit("session.step.started", "other-session"); await delay(20) }
        })
        await phase("current-reactive-token-updates-64", async () => {
          for (let i = 0; i < 64; i++) {
            setList((previous) => {
              const last = previous.at(-1)
              return [...previous.slice(0, -1), { ...last, tokens: { ...last.tokens, output: last.tokens.output + 1 } }]
            })
            await delay(20)
          }
        })
        const streamed = dist()
        check("latest exact output after 64 changes", streamed.output === COUNT * 5 + 64 && streamed.apiOutput === 69)
        check("unchanged historical estimates", streamed.toolResult === initial.toolResult && streamed.toolCall === initial.toolCall)
        await phase("current-unchanged-events", async () => {
          for (let i = 0; i < 8; i++) { emit("message.updated", SID); await delay(20) }
        })
        await phase("in-place-tool-and-skill-update", async () => {
          const tool = list().at(-1).content[0]
          tool.name = "skill"
          tool.state.input.command = "changed input"
          tail = "# Skill: fixture-skill\n" + "skill payload ".repeat(20)
          emit("session.tool.success", SID); emit("message.part.updated", SID)
        })
        check("in-place changed output detected", dist().toolResult !== initial.toolResult)
        check("in-place skill rendered", rendered().includes("fixture-skill"))
        if (OPTIMIZED) {
          await phase("session-aggregates", async () => {
            setAggregate({ tokens: { input: 5000, output: 10000, cache: { read: 8000, write: 200 } }, cost: 12.5 })
          })
          check("real aggregates used beyond loaded window", rendered().includes("$12.50") && rendered().includes("10.0K"))
          setAggregate(undefined)
          await delay(150)
          await phase("empty-child-switch", async () => { signals.setOverrideSessionId(CHILD) })
          check("child does not display parent distribution", !rendered().includes("fixture-skill") && !rendered().includes("33.3%"))
          await phase("child-late-hydration", async () => {
            setChildList([{ id: "child-a", type: "assistant", finish: "stop", cost: 0.2,
              model: { providerID: "fixture-no-balance", id: "fixture-model" },
              tokens: { input: 30, output: 3, cache: { read: 30, write: 0 } },
              content: [{ type: "tool", name: "task", state: { status: "completed", input: { prompt: "child instructions" },
                content: [{ type: "text", text: "child output" }] } }] }])
          })
          check("child token values isolated", dist().output === 3 && dist().apiInput === 60 && rendered().includes("50.0%"))
          await phase("deep-reactive-output-with-aggregates", async () => {
            setChildAggregate({ tokens: { input: 30, output: 3000, cache: { read: 30, write: 0 } }, cost: 0.2 })
            await delay(150)
            setChildStore("messages", 0, "tokens", "output", 6)
            setChildStore("messages", 0, "tokens", "reasoning", 4)
          })
          check("in-place token changes update distribution even with aggregates", dist().output === 6 && dist().reasoning === 4 && rendered().includes("3,000"))
          await phase("return-to-parent", async () => { signals.setOverrideSessionId(undefined) })
          check("parent exact state restored", dist().output === COUNT * 5 + 64 && rendered().includes("fixture-skill"))
          emit("message.updated", SID)
          signals.setOverrideSessionId(CHILD)
          await delay(500)
          check("pending parent work cannot overwrite child", dist().output === 6 && dist().apiInput === 60)
          const foreign = results.filter((r) => r.phase.startsWith("foreign"))
          check("foreign events cause no work", foreign.every((r) => r.messageLists === 0 && r.snapshotWrites === 0))
          check("unchanged current events do not write", results.find((r) => r.phase === "current-unchanged-events").snapshotWrites === 0)
          setMounted(false)
          api.kv.ready = false
          setMounted(true)
          await delay(30)
          setMounted(false)
          await delay(150)
          const beforeRestore = signals.balanceRefresh()
          const beforeUnmount = { ...counts }
          api.kv.ready = true
          await delay(350)
          check("disposed panel cannot restore configuration later", signals.balanceRefresh() === beforeRestore)
          check("disposed refresh timers and event handlers do no work", counts.messageLists === beforeUnmount.messageLists && counts.snapshotWrites === beforeUnmount.snapshotWrites)
        }
        writeFileSync(REPORT, JSON.stringify({ complete: true, success: true, mode: OPTIMIZED ? "optimized" : "baseline",
          messageCount: COUNT, syntheticOutputCharsPerMessage: TEXT.length, results, checks,
          initialDistribution: initial, finalStreamedDistribution: streamed,
          durableStoresCreated: 0, balancePollingMounted: false }, null, 2))
      } catch (error) {
        writeFileSync(REPORT, JSON.stringify({ complete: true, success: false, error: String(error), results, checks,
          diagnostics: { counts, panelMounted: Boolean(panel), distribution: dist(), syntheticPanelText: rendered() } }, null, 2))
      }
    }
    void inspect()
  },
}
