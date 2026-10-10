/** @jsxImportSource @opentui/solid */

import { createSignal, createMemo, createEffect, onMount, onCleanup, untrack } from "solid-js"
import type { Context, PluginModule } from "./types"
import { createPanelApi, selectedSessionProviderID } from "./v2-panel-api"
import { TokenCachePanel } from "../panel/TokenCachePanel"
import type { PanelApi, PanelSignals } from "../panel/panel-api"
import { StatusView } from "./status"
import { mapTheme } from "./theme"
import { makeCommands, findOpencodeKeyV2, currentSessionID } from "./commands"
import { credentialsDbReady } from "./credentials"
import { createSessionBalances, type SessionBalances } from "./session-balance"
import { LANG_META, detectLang, type LangCode } from "../i18n"

const KV_PREFIX = "cache_panel"
const BALANCE_POLL_MS = 5 * 60 * 1000 // 5 minutes（对齐 V1）

// 环境变量覆盖 + 自动检测（对齐 V1：CACHE_TUI_LANG 优先，其次系统 locale）
declare const process: { env: Record<string, string | undefined> } | undefined
const DEBUG_LANG = typeof process !== "undefined" ? process.env?.CACHE_TUI_LANG : undefined
const INIT_LANG: LangCode = DEBUG_LANG !== undefined && LANG_META.some((m) => m.code === DEBUG_LANG)
  ? (DEBUG_LANG as LangCode)
  : detectLang()

/** Presentation preferences are shared; balance accessors are bound to one session. */
function createPanelSignals(balances: SessionBalances): PanelSignals {
  const [currencySymbol, setCurrencySymbol] = createSignal("$")
  const [exchangeRate, setExchangeRate] = createSignal(1)
  const [langCode, setLangCode] = createSignal(INIT_LANG)
  const [sectionDetail, setSectionDetail] = createSignal(true)
  const [sectionModel, setSectionModel] = createSignal(true)
  const [sectionDist, setSectionDist] = createSignal(true)
  const [sectionSkills, setSectionSkills] = createSignal(true)
  const [sectionBalance, setSectionBalance] = createSignal(true)
  const [sectionBottom, setSectionBottom] = createSignal(true)
  const [balanceCurrency, setBalanceCurrency] = createSignal("")
  const [borderVisible, setBorderVisible] = createSignal(true)
  const [overrideSessionId, setOverrideSessionId] = createSignal<string | undefined>(undefined)
  const [sidebarVisible, setSidebarVisible] = createSignal(true)
  const shared = {
    currencySymbol, setCurrencySymbol,
    exchangeRate, setExchangeRate,
    langCode: langCode as PanelSignals["langCode"], setLangCode: setLangCode as PanelSignals["setLangCode"],
    sectionDetail, setSectionDetail,
    sectionModel, setSectionModel,
    sectionDist, setSectionDist,
    sectionSkills, setSectionSkills,
    sectionBalance, setSectionBalance,
    sectionBottom, setSectionBottom,
    balanceCurrency, setBalanceCurrency,
    borderVisible, setBorderVisible,
    overrideSessionId, setOverrideSessionId,
    sidebarVisible, setSidebarVisible,
  }
  const bind = (sessionID: () => string): PanelSignals => ({
    ...shared,
    ...balances.signals(sessionID),
    balanceManaged: true,
    balanceForSession: (id) => bind(typeof id === "function" ? id : () => id),
  })
  return bind(balances.activeSessionID)
}

/** One always-mounted owner for commands and balance queries, including when the sidebar is hidden. */
function CommandRoot(props: { context: Context; api: PanelApi; signals: PanelSignals; balances: SessionBalances }) {
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: makeCommands(props.context, props.api, props.signals),
  }))
  onMount(() => {
    const saved = props.api.kv.get<string>(`${KV_PREFIX}.lang`)
    if (saved && LANG_META.some((m) => m.code === saved)) props.signals.setLangCode(saved as LangCode)
  })
  const target = createMemo(() => props.balances.watchKey())
  createEffect(() => {
    void target()
    untrack(() => { void props.balances.poll() })
  })
  const timer = setInterval(() => { void props.balances.poll() }, BALANCE_POLL_MS)
  onCleanup(() => {
    clearInterval(timer)
    props.balances.dispose()
  })
  return null
}

/** Presentation only: mounting/unmounting a sidebar cannot change the balance query owner. */
function PluginRoot(props: {
  context: Context
  api: PanelApi
  signals: PanelSignals
  sessionID: string
}) {
  // auto-clear override：用户导航到不同主会话时清除子代理视图（对齐 V1 createSidebarSlot）
  let lastSlotSid = props.sessionID
  createEffect(() => {
    const sid = props.sessionID
    if (sid !== lastSlotSid) {
      lastSlotSid = sid
      if (props.signals.overrideSessionId()) {
        props.signals.setOverrideSessionId(undefined)
        void props.api.kv.set(`${KV_PREFIX}.session`, "")
      }
    }
  })

  return (
    <TokenCachePanel
      theme={mapTheme(props.context.theme)}
      api={props.api}
      sessionId={props.sessionID}
      signals={props.signals.balanceForSession!(() => props.sessionID)}
    />
  )
}

const mod: PluginModule & { server: () => Promise<Record<string, never>> } = {
  id: "opencode-visual-cache",
  setup(context: Context) {
    const api = createPanelApi(context)
    const balances = createSessionBalances({
      activeSessionID: () => currentSessionID(context),
      providerID: (sessionID) => selectedSessionProviderID(context, sessionID),
      kv: api.kv,
      resolveKey: async (provider, sourceProviderID) => {
        await credentialsDbReady()
        return findOpencodeKeyV2(context, provider, sourceProviderID)
      },
    })
    const signals = createPanelSignals(balances)

    // 侧边栏完整面板（与 V1 同一组件；命令 layer 在组件内注册）。
    // prepend：排在宿主官方信息（问候/Context/用量）之前，紧跟会话标题。
    context.ui.slot({
      prepend: "sidebar.content",
      render: (props) => (
        <PluginRoot context={context} api={api} signals={signals} sessionID={String(props.sessionID ?? "")} />
      ),
    })

    // 命令层不能依赖侧栏挂载；窄屏或隐藏侧栏时仍需可用。
    context.ui.slot({
      append: "app",
      render: () => <CommandRoot context={context} api={api} signals={signals} balances={balances} />,
    })

    // Sidebar and footer bind to the same session-owned balance snapshot.
    context.ui.slot({
      append: "prompt.footer.status",
      render: (props) => (
        <StatusView
          context={context}
          api={api}
          signals={signals.balanceForSession!(() => String(props.sessionID ?? currentSessionID(context)))}
          sessionID={String(props.sessionID ?? currentSessionID(context))}
        />
      ),
    })

    // 偏好持久化（实验：storage.store 用法验证）
    context.storage.store("opencode-visual-cache.panel", { initial: { collapsed: false } })
    return balances.dispose
  },
  // V1 server 空实现（兼容标记）：参考 oh-my-opencode-slim 的 { id, server, setup }——
  // v2 加载 setup，但 V1 检测需要 server 字段识别为插件
  server: async () => ({}),
}

export default mod
