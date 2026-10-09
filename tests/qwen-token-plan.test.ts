import assert from "node:assert/strict"
import {
  matchBalanceProvider,
  parseQwenTokenPlanUsage,
  type BalanceDetail,
} from "../src/balance-providers"

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

console.log("QwenCloud Token Plan quota tests passed")
