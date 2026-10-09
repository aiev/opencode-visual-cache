import assert from "node:assert/strict"
import {
  balanceCredentialKey,
  getBalanceProvider,
  looksLikeQwenCookie,
  matchBalanceProvider,
  normalizeQwenCookie,
  parseQwenConsoleQuota,
  parseQwenTokenPlanUsage,
  type BalanceDetail,
} from "../src/balance-providers"

const qwen = getBalanceProvider("qwencloud")

const nowMs = 1_700_000_000_000
const resetIso = "2026-08-01T00:00:00.000Z"
const resetSeconds = Math.round((Date.parse(resetIso) - nowMs) / 1000)

function firstEntry(raw: unknown) {
  return parseQwenTokenPlanUsage(raw, nowMs)[0]
}

function findDetail(details: BalanceDetail[] | undefined, key: BalanceDetail["key"]): BalanceDetail | undefined {
  return details?.find((detail) => detail.key === key)
}

// 官方文档 `qwencloud usage summary --format json` 的 token_plan 快照
const monthly = firstEntry({
  period: { from: "2026-07-01", to: "2026-07-21" },
  token_plan: {
    subscribed: true,
    planName: "Token Plan",
    status: "valid",
    totalCredits: 25000,
    remainingCredits: 18000,
    usedPct: 28,
    resetDate: resetIso,
  },
})
assert.equal(monthly.currency, "CREDITS")
assert.equal(monthly.total, "18000")
assert.equal(monthly.display, "Token Plan 72%")
assert.equal(findDetail(monthly.details, "plan")?.value, "TOKEN PLAN")
assert.equal(findDetail(monthly.details, "credits")?.value, "18000 / 25000")
assert.equal(findDetail(monthly.details, "used")?.value, "28%")
assert.equal(findDetail(monthly.details, "remaining")?.value, "72%")
assert.equal(findDetail(monthly.details, "reset")?.value, String(resetSeconds))

// {meta,data} 信封与 specCode / 毫秒 resetDate 变体
const enveloped = firstEntry({
  meta: { ok: true },
  data: {
    token_plan: {
      subscribed: true,
      specCode: "lite",
      totalCredits: 11500,
      remainingCredits: 2300,
      usedPct: 80,
      resetDate: nowMs + 3600_000,
    },
  },
})
assert.equal(enveloped.display, "Token Plan 20%")
assert.equal(findDetail(enveloped.details, "plan")?.value, "LITE")
assert.equal(findDetail(enveloped.details, "reset")?.value, "3600")

// 仅 remaining（无 total/usedPct）→ 不猜百分率，直接显示 Credits
const remainingOnly = firstEntry({ token_plan: { subscribed: true, remainingCredits: 42.5 } })
assert.equal(remainingOnly.display, "42.5 Credits")
assert.equal(findDetail(remainingOnly.details, "used"), undefined)
assert.equal(findDetail(remainingOnly.details, "remaining"), undefined)

// 无订阅 / 额度全 0（登录账号没有 Token Plan）→ NOPLAN；缺字段 / 非对象 → EMPTY
assert.throws(() => parseQwenTokenPlanUsage({ token_plan: { subscribed: false, planName: "Token Plan", totalCredits: 0, remainingCredits: 0, usedPct: 0 } }, nowMs), /NOPLAN/)
assert.throws(() => parseQwenTokenPlanUsage({ token_plan: { subscribed: true, totalCredits: 0, remainingCredits: 0, usedPct: 0 } }, nowMs), /NOPLAN/)
assert.throws(() => parseQwenTokenPlanUsage({ pay_as_you_go: { total: { cost: 1 } } }, nowMs), /EMPTY/)
assert.throws(() => parseQwenTokenPlanUsage({ token_plan: { subscribed: true } }, nowMs), /EMPTY/)
assert.throws(() => parseQwenTokenPlanUsage(null, nowMs), /EMPTY/)

// providerID → 余额 provider 映射（Token Plan 的两个 providerID 都要命中）
assert.equal(matchBalanceProvider("alibaba-token-plan")?.id, "qwencloud")
assert.equal(matchBalanceProvider("Alibaba-Token-Plan")?.id, "qwencloud")
assert.equal(matchBalanceProvider("qwencloud")?.id, "qwencloud")
assert.equal(matchBalanceProvider("bailian-token-plan-personal")?.id, "qwencloud")
assert.equal(matchBalanceProvider("deepseek")?.id, "deepseek")
assert.equal(matchBalanceProvider("moonshotai-cn")?.id, "moonshot")
assert.equal(matchBalanceProvider("anthropic"), undefined)

// requiresKey：CLI provider 无 key 也轮询，其余仍要求 key
assert.equal(matchBalanceProvider("alibaba-token-plan")?.requiresKey, false)
assert.equal(matchBalanceProvider("deepseek")?.requiresKey, undefined)

// 凭据槽位：qwencloud 用独立的 Cookie 槽位，避免和复用的 API key 混用
assert.equal(balanceCredentialKey("cache_panel", qwen), "cache_panel.balance.qwencloud.cookie")
assert.equal(balanceCredentialKey("cache_panel", matchBalanceProvider("deepseek")!), "cache_panel.balance.deepseek.key")
assert.equal(qwen.optionalKeyPrompt, "balCookiePrompt")
assert.equal(qwen.keySourceLabel, "keyCookie")

// Cookie 归一化与形状判断（误粘贴 API key 时不应打到控制台网关）
assert.equal(normalizeQwenCookie("cookie: a=1\nb=2"), "a=1; b=2")
assert.equal(normalizeQwenCookie("  login_qwencloud_ticket=xyz  "), "login_qwencloud_ticket=xyz")
assert.equal(looksLikeQwenCookie("a=1; b=2"), true)
assert.equal(looksLikeQwenCookie("sk-ws-abcdef"), false)
assert.equal(looksLikeQwenCookie(""), false)

// ── 控制台网关（个人版 Token Plan 真实响应形状，2026-10-09 抓取）──
const consoleQuota = {
  standard: { five_hour: 3000, monthly: 45000 },
  addon_quota: { extrabundle: 20000 },
  lite: { five_hour: 700, monthly: 11500 },
  pro: { five_hour: 12000, monthly: 180000 },
  essential: { five_hour: 1800, monthly: 25500 },
}
const consoleUsage = {
  per1MonthPercentage: 0.015465678304857778,
  per1MonthResetTime: 1794326400000,
}
const consoleSubscription = {
  instanceCode: "sfm_tokenplanpersonal_dp_intl-sg-1",
  specCode: "pro",
  remainingDays: 31,
  startTime: 1791579506000,
  endTime: 1794326400000,
  autoRenewFlag: false,
  status: "VALID",
}
const monthReset = Math.round((1794326400000 - nowMs) / 1000)

const consoleEntry = parseQwenConsoleQuota(
  { usage: consoleUsage, subscription: consoleSubscription, quotaConfig: consoleQuota },
  nowMs,
)[0]
assert.equal(consoleEntry.currency, "CREDITS")
assert.equal(consoleEntry.total, "177216")
assert.equal(consoleEntry.display, "Token Plan 98.5%")
assert.equal(findDetail(consoleEntry.details, "plan")?.value, "PRO")
assert.equal(findDetail(consoleEntry.details, "credits")?.value, "177216 / 180000")
assert.equal(findDetail(consoleEntry.details, "used")?.value, "1.5%")
assert.equal(findDetail(consoleEntry.details, "remaining")?.value, "98.5%")
assert.equal(findDetail(consoleEntry.details, "reset")?.value, String(monthReset))
// 单窗口不带 windowSeconds，避免标签噪音
assert.equal(findDetail(consoleEntry.details, "remaining")?.windowSeconds, undefined)

// 多窗口（团队版 5 小时 + 每周 + 月度）：逐窗口标注，Credits 取上限最大的窗口
const multi = parseQwenConsoleQuota({
  usage: {
    per5HourPercentage: 0.25,
    per5HourResetTime: nowMs + 3_600_000,
    per1WeekPercentage: 0.4,
    per1MonthPercentage: 0.5,
    per1MonthResetTime: nowMs + 86_400_000,
  },
  subscription: consoleSubscription,
  quotaConfig: consoleQuota,
}, nowMs)[0]
assert.equal(multi.display, "Token Plan 50%")
assert.equal(multi.total, "90000")
const remainingByWindow = multi.details.filter((d) => d.key === "remaining")
assert.deepEqual(remainingByWindow.map((d) => [d.windowSeconds, d.value]), [
  [18_000, "75%"],
  [604_800, "60%"],
  [2_592_000, "50%"],
])
assert.equal(findDetail(multi.details, "credits")?.windowSeconds, 2_592_000)

// 已是百分数（> 1）与未知套餐（无上限）：仍显示百分比，不猜 Credits
const rawPercent = parseQwenConsoleQuota({
  usage: { per1MonthPercentage: 12.5 },
  subscription: consoleSubscription,
  quotaConfig: consoleQuota,
}, nowMs)[0]
assert.equal(rawPercent.display, "Token Plan 87.5%")
assert.equal(findDetail(rawPercent.details, "credits")?.value, "157500 / 180000")

const unknownSpec = parseQwenConsoleQuota({
  usage: consoleUsage,
  subscription: { ...consoleSubscription, specCode: "ultra" },
  quotaConfig: consoleQuota,
}, nowMs)[0]
assert.equal(unknownSpec.total, "0")
assert.equal(findDetail(unknownSpec.details, "credits"), undefined)
assert.equal(unknownSpec.display, "Token Plan 98.5%")

// 订阅过期 → NOPLAN；没有窗口字段 → EMPTY
assert.throws(
  () => parseQwenConsoleQuota({ usage: consoleUsage, subscription: { ...consoleSubscription, status: "EXPIRED" }, quotaConfig: consoleQuota }, nowMs),
  /NOPLAN/,
)
assert.throws(() => parseQwenConsoleQuota({ usage: {}, subscription: consoleSubscription }, nowMs), /EMPTY/)
assert.throws(() => parseQwenConsoleQuota({}, nowMs), /EMPTY/)

console.log("QwenCloud Token Plan quota tests passed")
