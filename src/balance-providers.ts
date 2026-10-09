// ---------------------------------------------------------------------------
// Balance providers — pluggable account-balance query adapters.
// ---------------------------------------------------------------------------

/** 宿主运行时（Bun/Node）注入；用于按需取 node:child_process（见 runQwenCli）。 */
declare const process: {
  env: Record<string, string | undefined>
  getBuiltinModule?: (id: string) => unknown
} | undefined

/** 归一化后的余额条目——显示层与具体 provider 解耦。 */
export interface BalanceEntry {
  currency: string   // 原生币种（CNY/USD…），复用现有汇率换算
  total: string      // 余额字符串
  display?: string   // 非货币额度的预格式化显示文本
  details?: BalanceDetail[]
}

export type BalanceDetailKey = "plan" | "used" | "remaining" | "window" | "reset" | "codeReview" | "credits" | "resetCredits"

export interface BalanceDetail {
  key: BalanceDetailKey
  value: string
  windowSeconds?: number
}

/** provider 统一错误：message 即错误码（401/403/EMPTY/…），显示层直接展示。 */
export class BalanceError extends Error {}

/** provider 文案可引用的 i18n key 子集（键定义见 src/i18n.ts）。 */
export type BalanceMessageKey = "keyUser" | "keyOpenCode" | "keyNotSet" | "keyCli" | "keyCookie" | "balKeyPrompt" | "balCliHint" | "balCookiePrompt" | "balCookieHelp" | "balCookieOk" | "balCookieNoTicket" | "balCookieInvalid"

/** 凭据输入校验结果：错误提示 / 成功提示 / 归一化后要写入 KV 的值。 */
export interface BalanceCredentialCheck {
  error?: { messageKey: BalanceMessageKey; params?: Record<string, string | number> }
  saved?: { messageKey: BalanceMessageKey; params?: Record<string, string | number> }
  /** 归一化后的凭据（省略表示按原输入保存）。 */
  value?: string
}

/** 可插拔的余额 provider 适配器。 */
export interface BalanceProvider {
  id: string                    // 唯一标识，同时用作 KV key 命名空间
  name: string                  // 显示名（专有名词，无需 i18n）
  keyPlaceholder?: string       // key 输入框占位（如 "sk-..."）
  /** OpenCode providerID 别名（如 alibaba-token-plan → qwencloud）；支持前缀匹配。 */
  aliases?: readonly string[]
  /** false = 不依赖 API key（凭据由外部登录态提供，如 qwencloud CLI）。默认需要 key。 */
  requiresKey?: boolean
  /** 凭据的 KV 槽位后缀（默认 "key"）。requiresKey === false 时也可配置可选凭据
   *  （如 qwencloud 的控制台 Cookie），用独立槽位避免和复用的 API key 混淆。 */
  credentialSlot?: string
  /** 可选凭据的输入说明（i18n key）。设置后 /cache-balance-key 为该 provider 打开输入框。 */
  optionalKeyPrompt?: BalanceMessageKey
  /** 已配置凭据时菜单标注的 i18n key（默认 "keyUser"）。 */
  keySourceLabel?: BalanceMessageKey
  /** 可选：保存前校验/归一化用户粘贴的凭据（Cookie 类凭据用，见 qwencloud）。 */
  checkCredential?(input: string): BalanceCredentialCheck
  fetchBalance(apiKey: string, signal?: AbortSignal): Promise<BalanceEntry[]>
}

/** provider 凭据的 KV key：`<prefix>.balance.<id>.<credentialSlot ?? "key">`。 */
export function balanceCredentialKey(kvPrefix: string, provider: BalanceProvider): string {
  return `${kvPrefix}.balance.${provider.id}.${provider.credentialSlot ?? "key"}`
}

const siliconflowProvider: BalanceProvider = {
  id: "siliconflow",
  name: "SiliconFlow",
  keyPlaceholder: "sk-...",
  async fetchBalance(apiKey, signal) {
    // 国内站 api.siliconflow.cn（CNY）；国际站为 api.siliconflow.com（USD）
    const res = await fetch("https://api.siliconflow.cn/v1/user/info", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal,
    })
    if (!res.ok) {
      if (res.status === 401) throw new BalanceError("401")
      if (res.status === 403) throw new BalanceError("403")
      throw new BalanceError(String(res.status))
    }
    const json = await res.json() as {
      status?: boolean
      data?: {
        balance?: string | number
        chargeBalance?: string | number
        totalBalance?: string | number
      }
    }
    // totalBalance 为总余额（含充值+赠送），缺失时回退 balance
    const total = json.data?.totalBalance ?? json.data?.balance
    if (typeof total === "undefined" || total === null) throw new BalanceError("EMPTY")
    return [{ currency: "CNY", total: String(total) }]
  },
}

const deepseekProvider: BalanceProvider = {
  id: "deepseek",
  name: "DeepSeek",
  keyPlaceholder: "sk-...",
  async fetchBalance(apiKey, signal) {
    const res = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal,
    })
    if (!res.ok) {
      if (res.status === 401) throw new BalanceError("401")
      if (res.status === 402 || res.status === 403) throw new BalanceError("403")
      throw new BalanceError(String(res.status))
    }
    const json = await res.json() as {
      is_available?: boolean
      balance_infos?: { currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }[]
    }
    const infos = json.balance_infos ?? []
    if (infos.length === 0) throw new BalanceError("EMPTY")
    return infos.map((info) => ({
      currency: info.currency ?? "CNY",
      total: info.total_balance ?? "0",
    }))
  },
}

const openrouterProvider: BalanceProvider = {
  id: "openrouter",
  name: "OpenRouter",
  keyPlaceholder: "sk-or-...",
  async fetchBalance(apiKey, signal) {
    // 官方文档标注需 Management key，实测普通 API key 亦可查询账户余额
    const res = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal,
    })
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new BalanceError("403")
      throw new BalanceError(String(res.status))
    }
    const json = await res.json() as {
      data?: { total_credits?: number; total_usage?: number }
    }
    const credits = json.data?.total_credits
    const usage = json.data?.total_usage
    if (typeof credits !== "number" || typeof usage !== "number") throw new BalanceError("EMPTY")
    // 剩余额度 = 充值总额 - 已用
    return [{ currency: "USD", total: (credits - usage).toFixed(2) }]
  },
}

const moonshotProvider: BalanceProvider = {
  id: "moonshot",
  name: "Moonshot",
  keyPlaceholder: "sk-...",
  async fetchBalance(apiKey, signal) {
    // 国内站 api.moonshot.cn（CNY）；国际站 api.moonshot.ai（USD）
    const res = await fetch("https://api.moonshot.cn/v1/users/me/balance", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal,
    })
    if (!res.ok) {
      if (res.status === 401) throw new BalanceError("401")
      if (res.status === 403) throw new BalanceError("403")
      throw new BalanceError(String(res.status))
    }
    const json = await res.json() as {
      data?: { available_balance?: string | number }
    }
    const balance = json.data?.available_balance
    if (typeof balance === "undefined" || balance === null) throw new BalanceError("EMPTY")
    return [{ currency: "CNY", total: String(balance) }]
  },
}

const hyperProvider: BalanceProvider = {
  id: "hyper",
  name: "Charm Hyper",
  keyPlaceholder: "sk-hyper-...",
  async fetchBalance(apiKey, signal) {
    // 官方接口：GET /v1/credits → {"balance": 98}（积分余额）
    const res = await fetch("https://hyper.charm.land/v1/credits", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal,
    })
    if (!res.ok) {
      if (res.status === 401) throw new BalanceError("401")
      if (res.status === 403) throw new BalanceError("403")
      throw new BalanceError(String(res.status))
    }
    const json = await res.json() as { balance?: string | number }
    const balance = json.balance
    if (typeof balance === "undefined" || balance === null) throw new BalanceError("EMPTY")
    // hyper 积分换算：100 积分 = $5，即 1 积分 = $0.05
    const usd = (Number(balance) * 0.05).toFixed(2)
    return [{ currency: "USD", total: usd }]
  },
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const encoded = token.split(".")[1]
    if (!encoded || typeof atob !== "function") return undefined
    const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"))
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function getChatGPTAccountId(token: string): string | undefined {
  const payload = decodeJwtPayload(token)
  const auth = payload?.["https://api.openai.com/auth"]
  if (auth && typeof auth === "object") {
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id
    if (typeof accountId === "string" && accountId) return accountId
  }
  const accountId = payload?.chatgpt_account_id
  return typeof accountId === "string" && accountId ? accountId : undefined
}

type OpenAIRecord = Record<string, unknown>

interface CodexPercentages {
  used: number
  remaining: number
}

interface CodexRateWindow {
  data: OpenAIRecord
  windowSeconds?: number
  order: number
}

function asRecord(value: unknown): OpenAIRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as OpenAIRecord : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN
  return Number.isFinite(number) ? number : undefined
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)
}

function formatCreditAmount(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(2).replace(/\.?0+$/, "")
}

function getPercentages(snapshot: OpenAIRecord): CodexPercentages | undefined {
  const explicitUsed = asFiniteNumber(snapshot.used_percent)
  const explicitRemaining = asFiniteNumber(snapshot.remaining_percent)
  if (explicitUsed !== undefined || explicitRemaining !== undefined) {
    const used = clampPercent(explicitUsed ?? 100 - explicitRemaining!)
    const remaining = clampPercent(explicitRemaining ?? 100 - used)
    return { used, remaining }
  }

  const limit = asFiniteNumber(snapshot.limit)
  const usedAmount = asFiniteNumber(snapshot.used)
  const remainingAmount = asFiniteNumber(snapshot.remaining)
  if (limit !== undefined && limit > 0 && (usedAmount !== undefined || remainingAmount !== undefined)) {
    const used = usedAmount !== undefined ? (usedAmount / limit) * 100 : 100 - (remainingAmount! / limit) * 100
    const remaining = remainingAmount !== undefined ? (remainingAmount / limit) * 100 : 100 - used
    return { used: clampPercent(used), remaining: clampPercent(remaining) }
  }

  const amountTotal = (usedAmount ?? 0) + (remainingAmount ?? 0)
  if (amountTotal > 0 && (usedAmount !== undefined || remainingAmount !== undefined)) {
    const used = usedAmount !== undefined ? (usedAmount / amountTotal) * 100 : 0
    return { used: clampPercent(used), remaining: clampPercent(100 - used) }
  }
  return undefined
}

function getRateWindows(rateLimit: unknown): CodexRateWindow[] {
  const record = asRecord(rateLimit)
  if (!record) return []
  return Object.entries(record)
    .map(([name, value], order): CodexRateWindow | undefined => {
      const data = asRecord(value)
      if (!data) return undefined
      const normalizedName = name.toLowerCase()
      if (normalizedName.includes("individual")) return undefined
      const windowSeconds = asFiniteNumber(data.limit_window_seconds)
      const looksLikeWindow = normalizedName.includes("window") ||
        windowSeconds !== undefined ||
        "used_percent" in data ||
        "remaining_percent" in data
      if (!looksLikeWindow) return undefined
      return { data, windowSeconds, order }
    })
    .filter((window): window is CodexRateWindow => window !== undefined)
    .sort((a, b) => (a.windowSeconds ?? Number.MAX_SAFE_INTEGER) - (b.windowSeconds ?? Number.MAX_SAFE_INTEGER) || a.order - b.order)
}

function getResetAfterSeconds(snapshot: OpenAIRecord, nowMs: number): number | undefined {
  const relative = asFiniteNumber(snapshot.reset_after_seconds)
  if (relative !== undefined) return Math.max(0, Math.round(relative))

  for (const key of ["reset_at", "resets_at", "resetAt", "resetsAt"]) {
    const timestamp = asFiniteNumber(snapshot[key])
    if (timestamp === undefined) continue
    const timestampSeconds = timestamp > 1e12 ? timestamp / 1000 : timestamp
    return Math.max(0, Math.round(timestampSeconds - nowMs / 1000))
  }
  return undefined
}

function appendQuotaDetails(details: BalanceDetail[], percentages: CodexPercentages, windowSeconds?: number): void {
  const scope = windowSeconds === undefined ? {} : { windowSeconds }
  details.push({ key: "used", value: `${formatPercent(percentages.used)}%`, ...scope })
  details.push({ key: "remaining", value: `${formatPercent(percentages.remaining)}%`, ...scope })
}

export function parseOpenAIUsage(raw: unknown, nowMs = Date.now()): BalanceEntry[] {
  const json = asRecord(raw)
  if (!json) throw new BalanceError("EMPTY")

  const details: BalanceDetail[] = []
  if (typeof json.plan_type === "string" && json.plan_type) {
    details.push({ key: "plan", value: json.plan_type.toUpperCase() })
  }

  const rateLimit = asRecord(json.rate_limit)
  const remainingValues: number[] = []
  let hasRateQuota = false
  for (const window of getRateWindows(rateLimit)) {
    const percentages = getPercentages(window.data)
    if (percentages) {
      appendQuotaDetails(details, percentages, window.windowSeconds)
      remainingValues.push(percentages.remaining)
      hasRateQuota = true
    }
    const resetAfter = getResetAfterSeconds(window.data, nowMs)
    if (resetAfter !== undefined) {
      details.push({
        key: "reset",
        value: String(resetAfter),
        ...(window.windowSeconds === undefined ? {} : { windowSeconds: window.windowSeconds }),
      })
    }
  }

  const spendControl = asRecord(asRecord(json.spend_control)?.individual_limit)
  const individualLimit = asRecord(json.individual_limit) ?? asRecord(rateLimit?.individual_limit) ?? spendControl
  const individualPercentages = individualLimit ? getPercentages(individualLimit) : undefined
  if (individualPercentages) {
    remainingValues.push(individualPercentages.remaining)
    if (!hasRateQuota) appendQuotaDetails(details, individualPercentages)
  }
  if (individualLimit) {
    const resetAfter = getResetAfterSeconds(individualLimit, nowMs)
    if (resetAfter !== undefined) details.push({ key: "reset", value: String(resetAfter) })
  }

  const codeReviewWindow = asRecord(asRecord(json.code_review_rate_limit)?.primary_window)
  const codeReviewUsed = asFiniteNumber(codeReviewWindow?.used_percent)
  if (codeReviewUsed !== undefined) {
    details.push({ key: "codeReview", value: `${formatPercent(clampPercent(100 - codeReviewUsed))}%` })
  }

  const credits = asRecord(json.credits)
  let hasCreditDetail = false
  if (credits?.unlimited === true) {
    details.push({ key: "credits", value: "unlimited" })
    hasCreditDetail = true
  } else {
    const creditBalance = asFiniteNumber(credits?.balance)
    if (creditBalance !== undefined) {
      details.push({ key: "credits", value: `$${creditBalance.toFixed(2)}` })
      hasCreditDetail = true
    } else if (individualLimit) {
      const remaining = asFiniteNumber(individualLimit.remaining)
      const limit = asFiniteNumber(individualLimit.limit)
      const amounts = [remaining, limit].filter((value): value is number => value !== undefined)
      if (amounts.length > 0) {
        details.push({ key: "credits", value: amounts.map(formatCreditAmount).join(" / ") })
        hasCreditDetail = true
      }
    }
  }

  const resetCredits = asFiniteNumber(asRecord(json.rate_limit_reset_credits)?.available_count)
  if (resetCredits !== undefined) details.push({ key: "resetCredits", value: String(resetCredits) })

  if (details.length === 0 || (!hasRateQuota && !individualPercentages && !hasCreditDetail && resetCredits === undefined)) {
    throw new BalanceError("EMPTY")
  }

  const summaryRemaining = remainingValues.length > 0 ? Math.min(...remainingValues) : undefined
  const summary = summaryRemaining === undefined ? undefined : formatPercent(summaryRemaining)
  return [{
    currency: "CODEX",
    total: summary === undefined ? "0" : `${summary}%`,
    display: summary === undefined ? "Codex" : `Codex ${summary}%`,
    details,
  }]
}

const openaiProvider: BalanceProvider = {
  id: "openai",
  name: "OpenAI Codex",
  keyPlaceholder: "OAuth access token (eyJ...)",
  async fetchBalance(accessToken, signal) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      Referer: "https://chatgpt.com/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36",
      "OpenAI-Beta": "codex-1",
      "oai-language": "zh-CN",
      originator: "Codex Desktop",
    }
    const accountId = getChatGPTAccountId(accessToken)
    if (accountId) headers["ChatGPT-Account-Id"] = accountId

    const res = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers, signal })
    if (!res.ok) {
      if (res.status === 401) throw new BalanceError("401")
      if (res.status === 403) throw new BalanceError("403")
      throw new BalanceError(String(res.status))
    }
    const json = await res.json()
    return parseOpenAIUsage(json)
  },
}

// ---------------------------------------------------------------------------
// QwenCloud Token Plan — Credits quota，两个来源：
//
//   1. 控制台 Cookie（可选凭据，优先）：home.qwencloud.com 的网关接口，个人版
//      （Individual / Pro）也能拿到真实用量，返回窗口用量百分比 + 套餐上限。
//   2. 官方 CLI 的 device-flow 登录态（无 Cookie 时回退）：
//      `qwencloud usage summary --format json` 的 `token_plan` 快照。
//
// Token Plan 的 `sk-sp-*` key 只做推理：billing 路由一律 `ConsoleNeedLogin`，
// quota 无法用 key 查询（官方 FAQ + CodexBar#2328 实测）。CLI 侧对灰度账号
// （QuerySubscriptionGray=true）只查团队版 seat 接口，个人版订阅会读成
// `subscribed: false`（QwenCloud/qwencloud-cli#13），因此控制台 Cookie 是
// 个人版唯一可靠的来源。
// ---------------------------------------------------------------------------

const QWEN_CLI = "qwencloud"
const QWEN_CLI_TIMEOUT_MS = 8_000 // 面板轮询 10s 超时之内，留解析余量

interface ChildProcessModule {
  execFile(
    file: string,
    args: readonly string[],
    options: Record<string, unknown>,
    callback: (error: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string, stderr: string) => void,
  ): unknown
}

/** 取 node:child_process（Bun/Node 宿主）；宿主不提供时返回 undefined → CLI 缺失。 */
function loadChildProcess(): ChildProcessModule | undefined {
  const getter = typeof process !== "undefined" ? process.getBuiltinModule : undefined
  if (!getter) return undefined
  try {
    const mod = getter("node:child_process") as ChildProcessModule | undefined
    return mod && typeof mod.execFile === "function" ? mod : undefined
  } catch {
    return undefined
  }
}

/** 未登录/凭据过期的输出特征（CLI 文档：未登录 exit 2、`AUTH_REQUIRED`）。 */
function looksUnauthenticated(output: string): boolean {
  return /AUTH_REQUIRED|auth login|not logged|unauthori[sz]ed|token expired|ConsoleNeedLogin/i.test(output)
}

/** 运行 qwencloud CLI，返回 stdout；失败只抛错误码，不外泄输出。 */
export function runQwenCli(args: readonly string[], signal?: AbortSignal): Promise<string> {
  const child = loadChildProcess()
  if (!child) return Promise.reject(new BalanceError("CLI"))
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) { reject(new BalanceError("TIMEOUT")); return }
    const handle = child.execFile(
      QWEN_CLI,
      [...args],
      { timeout: QWEN_CLI_TIMEOUT_MS, maxBuffer: 1 << 20, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && typeof error.code === "string" && error.code === "ENOENT") { reject(new BalanceError("CLI")); return }
        if (error && error.killed) { reject(new BalanceError("TIMEOUT")); return }
        const text = String(stdout ?? "")
        if (error || looksUnauthenticated(`${text}${String(stderr ?? "")}`)) {
          reject(new BalanceError(error && error.code === 2 ? "AUTH" : looksUnauthenticated(`${text}${String(stderr ?? "")}`) ? "AUTH" : "EMPTY"))
          return
        }
        resolve(text)
      },
    ) as { kill?: (signal?: string) => unknown } | undefined
    const abort = () => { try { handle?.kill?.("SIGKILL") } catch { /* 已退出 */ } }
    signal?.addEventListener("abort", abort, { once: true })
  })
}

/** 重置时间戳（ISO 字符串 / 秒 / 毫秒）→ 距今秒数。 */
function qwenResetSeconds(value: unknown, nowMs: number): number | undefined {
  const timestamp = asFiniteNumber(value)
  let ms: number | undefined
  if (timestamp !== undefined) ms = timestamp > 1e12 ? timestamp : timestamp * 1000
  else if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) ms = parsed
  }
  if (ms === undefined) return undefined
  return Math.max(0, Math.round((ms - nowMs) / 1000))
}

/** 解析 `qwencloud usage summary --format json` 的 token_plan 快照。 */
export function parseQwenTokenPlanUsage(raw: unknown, nowMs = Date.now()): BalanceEntry[] {
  const root = asRecord(raw)
  if (!root) throw new BalanceError("EMPTY")
  // 兼容 CLI 的 {meta,data} 信封与顶层直出两种形态
  const json = asRecord(root.data) ?? root
  const plan = asRecord(json.token_plan) ?? asRecord(asRecord(root.token_plan))
  if (!plan) throw new BalanceError("EMPTY")
  // 登录账号没有订阅（usage summary 的 subscribed=false / totalCredits=0 也是这种状态）：
  // 与"接口没返回数据"分开提示，避免用户以为插件坏了，其实是登录账号不对
  if (plan.subscribed === false) throw new BalanceError("NOPLAN")

  const total = asFiniteNumber(plan.totalCredits) ?? asFiniteNumber(plan.total_credits)
  const remaining = asFiniteNumber(plan.remainingCredits) ?? asFiniteNumber(plan.remaining_credits)
  if (total === undefined && remaining === undefined) throw new BalanceError("EMPTY")
  if ((total ?? 0) <= 0 && (remaining ?? 0) <= 0) throw new BalanceError("NOPLAN")

  const usedPct = asFiniteNumber(plan.usedPct) ?? asFiniteNumber(plan.used_pct)
  const remainingPct = total !== undefined && total > 0 && remaining !== undefined
    ? clampPercent((remaining / total) * 100)
    : usedPct === undefined ? undefined : clampPercent(100 - usedPct)

  const details: BalanceDetail[] = []
  const planName = typeof plan.planName === "string" && plan.planName.length > 0
    ? plan.planName
    : typeof plan.specCode === "string" && plan.specCode.length > 0 ? plan.specCode : ""
  if (planName) details.push({ key: "plan", value: planName.toUpperCase() })
  if (total !== undefined) {
    // Credits 行给套餐额度上限（对齐控制台的 "Plan quota"），余量看 Remaining 行
    details.push({ key: "credits", value: formatCreditAmount(total) })
  }
  const usedCredits = total !== undefined && total > 0 && remaining !== undefined ? Math.max(0, total - remaining) : undefined
  if (usedPct !== undefined) {
    const usedPctText = `${formatPercent(usedPct)}%`
    details.push({ key: "used", value: usedCredits === undefined ? usedPctText : `${formatCreditAmount(usedCredits)} / ${usedPctText}` })
  }
  if (remainingPct !== undefined) {
    const remainingPctText = `${formatPercent(remainingPct)}%`
    details.push({
      key: "remaining",
      value: usedCredits === undefined || remaining === undefined ? remainingPctText : `${formatCreditAmount(remaining)} / ${remainingPctText}`,
    })
  }
  const resetAfter = qwenResetSeconds(plan.resetDate ?? plan.reset_date ?? plan.next_reset_at, nowMs)
  if (resetAfter !== undefined) details.push({ key: "reset", value: String(resetAfter) })

  const summary = remainingPct === undefined ? undefined : formatPercent(remainingPct)
  return [{
    currency: "CREDITS",
    total: remaining === undefined ? "0" : formatCreditAmount(remaining),
    // Credits 非货币，走 display 直出，避免被汇率换算
    display: summary !== undefined
      ? `Token Plan ${summary}%`
      : remaining !== undefined ? `${formatCreditAmount(remaining)} Credits` : "Token Plan",
    details,
  }]
}

const QWEN_CONSOLE_HOST = "https://home.qwencloud.com"
const QWEN_CONSOLE_GATEWAY = "https://cs-data.qwencloud.com/data/api.json"
const QWEN_CONSOLE_REGION = "ap-southeast-1"
/** 控制台个人版 Token Plan 的网关接口名（未文档化，CodexBar#2328 记录）。 */
const qwenConsoleApi = (name: string) => `zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/${name}`

/** usage 字段名里的窗口单位（`per5HourPercentage` → `5Hour`）→ 秒数。 */
const QWEN_WINDOW_SECONDS: Record<string, number> = {
  "5Hour": 5 * 3600,
  "1Week": 7 * 86400,
  "1Month": 30 * 86400,
}

/** 个人版 Token Plan 的会话票据（缺失时控制台网关会返回登录页）。 */
const QWEN_SESSION_COOKIE = "login_qwencloud_ticket"

/** 从任意粘贴形态里抽取 `name=value` 对：DevTools 请求头整行、`document.cookie`、
 *  Application/Cookies 表格的逐行粘贴都能解析；无 `=` 的行（其它请求头、表头）自动丢弃。 */
export function parseQwenCookiePairs(value: string): Record<string, string> {
  const out: Record<string, string> = {}
  const put = (name: string, raw: string) => {
    const key = name.trim().replace(/^cookie:\s*/i, "").replace(/^"|"$/g, "").replace(/:$/, "").trim()
    const val = raw.trim().replace(/^"|"$/g, "")
    if (!key || !val || !/^[A-Za-z0-9_.%-]+$/.test(key)) return
    if (!out[key]) out[key] = val
  }
  const fromList = (list: unknown[]) => {
    for (const item of list) {
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>
        if (typeof rec.name === "string" && typeof rec.value === "string") put(rec.name, rec.value)
      }
    }
  }
  // Cookie 导出（JSON 数组 / {cookies:[…]}）：整体解析后取 name/value
  const trimmed = value.trim()
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const json: unknown = JSON.parse(trimmed)
      const list = Array.isArray(json) ? json : ((json as { cookies?: unknown }).cookies ?? [])
      if (Array.isArray(list)) fromList(list)
      return out
    } catch {
      // 不是合法 JSON → 落到逐行解析
    }
  }
  for (const chunk of value.split(/[\r\n;]+/)) {
    const line = chunk.trim()
    if (!line) continue
    // Netscape cookies.txt / DevTools 表格粘贴：制表符分隔，倒数两列为 name、value
    if (line.includes("\t")) {
      const cols = line.split("\t").filter((c) => c.trim() !== "")
      if (cols.length >= 2) put(cols[cols.length - 2]!, cols[cols.length - 1]!)
      continue
    }
    const eq = line.indexOf("=")
    if (eq <= 0) {
      // `"name": "value"`（DevTools/JSON 导出）：只有带引号的键才当 Cookie，避免误收其它请求头
      const quoted = /^"([A-Za-z0-9_.%-]+)"\s*:\s*"(.+)"$/.exec(line)
      if (quoted) put(quoted[1]!, quoted[2]!)
      continue
    }
    put(line.slice(0, eq), line.slice(eq + 1))
  }
  return out
}

/** 归一化浏览器 Cookie：只保留识别到的 `name=value` 对，去重后以 `; ` 连接。 */
export function normalizeQwenCookie(value: string): string {
  return Object.entries(parseQwenCookiePairs(value)).map(([k, v]) => `${k}=${v}`).join("; ")
}

/** 粗略判断凭据像不像 Cookie，避免把误粘贴的 API key 发出去。 */
export function looksLikeQwenCookie(value: string): boolean {
  if (/^sk-/i.test(value.trim())) return false
  return Object.keys(parseQwenCookiePairs(value)).length > 0
}

/** 粘贴的 Cookie 里是否含会话票据（决定 quota 能否真的读到）。 */
export function qwenCookieHasTicket(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(parseQwenCookiePairs(value), QWEN_SESSION_COOKIE)
}

function qwenConsoleHeaders(cookie: string): Record<string, string> {
  return {
    cookie,
    Accept: "application/json",
    Origin: QWEN_CONSOLE_HOST,
    Referer: `${QWEN_CONSOLE_HOST}/analytics/token-plan/individual`,
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36",
  }
}

/** Cookie 失效的特征：网关返回登录页 / ret 里带 NeedLogin 系列错误。 */
function looksLoginRequired(output: string): boolean {
  return /ConsoleNeedLogin|NeedLogin|NotLogin|PleaseLogin|AUTH_REQUIRED|unauthori[sz]ed|token expired/i.test(output)
}

/** 控制台 CSRF `sec_token`：Cookie 不是有效登录态时拿不到（返回 HTML/空）。 */
async function qwenConsoleSecToken(cookie: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${QWEN_CONSOLE_HOST}/tool/user/info.json`, { headers: qwenConsoleHeaders(cookie), signal })
  const text = await res.text().catch(() => "")
  if (res.status === 401 || res.status === 403) throw new BalanceError("COOKIE")
  if (!res.ok) throw new BalanceError(String(res.status))
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new BalanceError("COOKIE")
  }
  const token = asRecord(asRecord(json)?.data)?.secToken
  if (typeof token !== "string" || !token) throw new BalanceError("COOKIE")
  return token
}

/** 调用一次控制台网关，剥掉 {data:{DataV2:{ret,data:{code,data}}}} 三层信封。 */
async function qwenConsoleCall(
  cookie: string,
  secToken: string,
  api: string,
  signal?: AbortSignal,
): Promise<OpenAIRecord> {
  const body = new URLSearchParams({
    product: "sfm_bailian",
    action: "IntlBroadScopeAspnGateway",
    sec_token: secToken,
    region: QWEN_CONSOLE_REGION,
    params: JSON.stringify({
      Api: api,
      Data: {
        cornerstoneParam: {
          domain: "home.qwencloud.com",
          consoleSite: "QWENCLOUD",
          console: "ONE_CONSOLE",
          xsp_lang: "en-US",
          protocol: "V2",
          productCode: "p_efm",
        },
      },
      V: "1.0",
    }),
  })
  const url = `${QWEN_CONSOLE_GATEWAY}?product=sfm_bailian&action=IntlBroadScopeAspnGateway&api=${encodeURIComponent(api)}`
  const res = await fetch(url, {
    method: "POST",
    headers: { ...qwenConsoleHeaders(cookie), "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal,
  })
  if (res.status === 401 || res.status === 403) throw new BalanceError("COOKIE")
  if (!res.ok) throw new BalanceError(String(res.status))
  const text = await res.text().catch(() => "")
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new BalanceError("COOKIE") // 登录页 HTML
  }
  const data = asRecord(asRecord(json)?.data)
  const envelope = asRecord(data?.DataV2) ?? data
  const payload = asRecord(asRecord(envelope?.data)?.data)
  const code = typeof asRecord(envelope?.data)?.code === "string" ? String(asRecord(envelope?.data)?.code) : ""
  const ret = Array.isArray(envelope?.ret) ? String(envelope?.ret[0] ?? "") : ""
  if (payload && (code === "SUCCESS" || ret.startsWith("SUCCESS"))) return payload
  const output = `${code} ${ret} ${typeof data?.message === "string" ? data.message : ""}`
  if (looksLoginRequired(output)) throw new BalanceError("COOKIE")
  throw new BalanceError("EMPTY")
}

/** usage 的 `perXxxPercentage` → 每个限流窗口的用量。 */
interface QwenQuotaWindow {
  windowSeconds?: number
  usedPct: number
  remainingPct: number
  resetAfter?: number
  ceiling?: number
}

function collectQwenWindows(usage: OpenAIRecord, nowMs: number): QwenQuotaWindow[] {
  const windows: QwenQuotaWindow[] = []
  for (const [field, value] of Object.entries(usage)) {
    const match = /^per(.+)Percentage$/.exec(field)
    if (!match) continue
    const raw = asFiniteNumber(value)
    if (raw === undefined) continue
    // 控制台给的是 0..1 的小数（0.0154 = 已用 1.55%）；> 1 视为已经是百分数
    const usedPct = clampPercent(raw > 1 ? raw : raw * 100)
    windows.push({
      windowSeconds: QWEN_WINDOW_SECONDS[match[1]],
      usedPct,
      remainingPct: clampPercent(100 - usedPct),
      resetAfter: qwenResetSeconds(usage[`per${match[1]}ResetTime`], nowMs),
    })
  }
  return windows.sort((a, b) => (a.windowSeconds ?? Number.MAX_SAFE_INTEGER) - (b.windowSeconds ?? Number.MAX_SAFE_INTEGER))
}

/** 窗口 → 该窗口的 Credits 上限（quota-config 按套餐给出，字段为 snake_case）。 */
function qwenWindowCeiling(windowSeconds: number | undefined, tier: OpenAIRecord | undefined): number | undefined {
  if (!tier) return undefined
  if (windowSeconds !== undefined && windowSeconds <= 6 * 3600) return asFiniteNumber(tier.five_hour)
  if (windowSeconds !== undefined && windowSeconds <= 86400) return asFiniteNumber(tier.daily)
  if (windowSeconds !== undefined && windowSeconds <= 7 * 86400) return asFiniteNumber(tier.weekly)
  return asFiniteNumber(tier.monthly)
}

export interface QwenConsoleSnapshot {
  usage?: unknown
  subscription?: unknown
  quotaConfig?: unknown
}

/** 合并控制台三个接口（用量 / 订阅 / 套餐上限）为余额条目。 */
export function parseQwenConsoleQuota(snapshot: QwenConsoleSnapshot, nowMs = Date.now()): BalanceEntry[] {
  const usage = asRecord(snapshot.usage)
  const subscription = asRecord(snapshot.subscription)
  const tiers = asRecord(snapshot.quotaConfig)
  if (!usage) throw new BalanceError("EMPTY")

  // 订阅非 VALID（过期/退款）：与"接口没返回数据"分开提示
  const status = typeof subscription?.status === "string" ? subscription.status.toUpperCase() : ""
  if (status && status !== "VALID") throw new BalanceError("NOPLAN")

  const spec = typeof subscription?.specCode === "string" ? subscription.specCode.toLowerCase() : ""
  const windows = collectQwenWindows(usage, nowMs)
  if (windows.length === 0) throw new BalanceError("EMPTY")
  const tier = spec ? asRecord(tiers?.[spec]) : undefined
  for (const window of windows) window.ceiling = qwenWindowCeiling(window.windowSeconds, tier)

  const multiple = windows.length > 1
  const scope = (window: QwenQuotaWindow) => (multiple && window.windowSeconds !== undefined ? { windowSeconds: window.windowSeconds } : {})
  const details: BalanceDetail[] = []
  if (spec) details.push({ key: "plan", value: spec.toUpperCase() })

  // Credits 行对齐控制台的 "Plan quota"：只给套餐额度上限，取上限最大的窗口（个人版即月度额度）
  const withCeiling = windows.filter((window) => (window.ceiling ?? 0) > 0)
  const primary = withCeiling.length > 0 ? withCeiling.reduce((a, b) => ((b.ceiling ?? 0) > (a.ceiling ?? 0) ? b : a)) : undefined
  const remainingCredits = primary ? Math.round((primary.ceiling ?? 0) * (primary.remainingPct / 100)) : undefined
  if (primary && remainingCredits !== undefined) {
    details.push({ key: "credits", value: formatCreditAmount(primary.ceiling ?? 0), ...scope(primary) })
  }
  for (const window of windows) {
    // Used / Remaining 两行都把 Credits 和百分比并列，省得手工换算
    const ceiling = (window.ceiling ?? 0) > 0 ? window.ceiling ?? 0 : undefined
    const usedPct = `${formatPercent(window.usedPct)}%`
    const remainingPct = `${formatPercent(window.remainingPct)}%`
    details.push({
      key: "used",
      value: ceiling === undefined ? usedPct : `${formatCreditAmount(Math.round(ceiling * window.usedPct / 100))} / ${usedPct}`,
      ...scope(window),
    })
    details.push({
      key: "remaining",
      value: ceiling === undefined ? remainingPct : `${formatCreditAmount(Math.round(ceiling * window.remainingPct / 100))} / ${remainingPct}`,
      ...scope(window),
    })
    if (window.resetAfter !== undefined) details.push({ key: "reset", value: String(window.resetAfter), ...scope(window) })
  }

  const summary = formatPercent(clampPercent(Math.min(...windows.map((window) => window.remainingPct))))
  return [{
    currency: "CREDITS",
    total: remainingCredits === undefined ? "0" : String(remainingCredits),
    // Credits 非货币，走 display 直出，避免被汇率换算
    display: `Token Plan ${summary}%`,
    details,
  }]
}

/** 控制台 Cookie 读取 quota（个人版/团队版都可用）。 */
export async function fetchQwenConsoleQuota(credential: string, signal?: AbortSignal): Promise<BalanceEntry[]> {
  const cookie = normalizeQwenCookie(credential)
  if (!cookie) throw new BalanceError("COOKIE")
  const secToken = await qwenConsoleSecToken(cookie, signal)
  const [usage, subscription, quotaConfig] = await Promise.all([
    qwenConsoleCall(cookie, secToken, qwenConsoleApi("usage"), signal),
    qwenConsoleCall(cookie, secToken, qwenConsoleApi("subscription"), signal),
    qwenConsoleCall(cookie, secToken, qwenConsoleApi("quota-config"), signal),
  ])
  return parseQwenConsoleQuota({ usage, subscription, quotaConfig })
}

const qwencloudProvider: BalanceProvider = {
  id: "qwencloud",
  name: "QwenCloud Token Plan",
  // 凭据可选：控制台 Cookie（`.cookie` 槽位）优先，未配置时回退 qwencloud CLI 登录态
  requiresKey: false,
  credentialSlot: "cookie",
  optionalKeyPrompt: "balCookiePrompt",
  keySourceLabel: "keyCookie",
  // 保存前把粘贴内容拆成 name=value 对，并告诉用户有没有找到会话票据
  checkCredential(input) {
    const pairs = parseQwenCookiePairs(input)
    const count = Object.keys(pairs).length
    if (count === 0) return { error: { messageKey: "balCookieInvalid" } }
    const found = Object.prototype.hasOwnProperty.call(pairs, QWEN_SESSION_COOKIE)
    return {
      value: normalizeQwenCookie(input),
      saved: { messageKey: found ? "balCookieOk" : "balCookieNoTicket", params: { n: count } },
    }
  },
  keyPlaceholder: "login_qwencloud_ticket=...",
  aliases: ["alibaba-token-plan", "bailian-token-plan"],
  async fetchBalance(credential, signal) {
    const cookie = normalizeQwenCookie(credential ?? "")
    // 没有可用 Cookie（或误粘贴了 API key）→ 回退官方 CLI 的 device-flow 登录态
    if (!cookie || /^sk-/i.test((credential ?? "").trim())) {
      const stdout = await runQwenCli(["usage", "summary", "--format", "json"], signal)
      let parsed: unknown
      try {
        parsed = JSON.parse(stdout)
      } catch {
        throw new BalanceError("EMPTY")
      }
      return parseQwenTokenPlanUsage(parsed)
    }
    // 粘贴了一堆 Cookie 却没有登录票据：不去打三个接口，直接报明确的错误
    if (!qwenCookieHasTicket(cookie)) throw new BalanceError("NO_TICKET")
    return fetchQwenConsoleQuota(cookie, signal)
  },
}

/** 已注册的 provider 列表（按需追加新适配器）。 */
export const balanceProviders: BalanceProvider[] = [deepseekProvider, siliconflowProvider, openrouterProvider, moonshotProvider, hyperProvider, openaiProvider, qwencloudProvider]

/** 按 id 取 provider；未知 id 回退到第一个。 */
export function getBalanceProvider(id: string): BalanceProvider {
  return balanceProviders.find((p) => p.id === id) ?? balanceProviders[0] ?? deepseekProvider
}

/**
 * 按 OpenCode providerID 匹配余额 provider。
 * 先精确匹配 id，再匹配 provider 别名（如 alibaba-token-plan → qwencloud），
 * 最后按前缀匹配（如 moonshotai-cn → moonshot）；未命中返回 undefined。
 * 比较不区分大小写，容忍 providerID 的大小写变体。
 */
export function matchBalanceProvider(providerId: string): BalanceProvider | undefined {
  const id = providerId.toLowerCase()
  const exact = balanceProviders.find((p) => p.id.toLowerCase() === id)
  if (exact) return exact
  const aliased = balanceProviders.find((p) =>
    (p.aliases ?? []).some((alias) => {
      const value = alias.toLowerCase()
      return id === value || id.startsWith(value)
    }))
  if (aliased) return aliased
  return balanceProviders.find((p) => id.startsWith(p.id.toLowerCase()))
}

/** key 脱敏：保留头 5 尾 5 字符，中间用 * 填充。 */
export function maskKey(k: string): string {
  if (!k) return ""
  if (k.length <= 10) return k.slice(0, 5) + "*".repeat(Math.max(3, k.length - 5))
  return k.slice(0, 5) + "*".repeat(Math.max(3, k.length - 10)) + k.slice(-5)
}
