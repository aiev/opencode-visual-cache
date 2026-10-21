import assert from "node:assert/strict"
import {
  balanceProviders,
  matchBalanceProvider,
  parseOpenCodeGoUsage,
  type BalanceDetail,
} from "../src/balance-providers"
import { findOpencodeKeyV2 } from "../src/v2/commands"
import type { Context } from "../src/v2/types"

const nowMs = Date.parse("2026-10-21T14:00:00.000Z")

function findDetail(details: BalanceDetail[], key: BalanceDetail["key"], windowSeconds?: number): BalanceDetail | undefined {
  return details.find((detail) => detail.key === key && detail.windowSeconds === windowSeconds)
}

const entry = parseOpenCodeGoUsage({
  usage: {
    rolling: { status: "ok", percent: 12.5, resetsAt: "2026-10-21T19:00:00.000Z" },
    weekly: { status: "ok", percent: 40, resetsAt: "2026-10-26T00:00:00.000Z" },
    monthly: { status: "ok", percent: 5, resetsAt: "2026-11-21T14:00:00.000Z" },
  },
}, nowMs)[0]
const details = entry.details ?? []
assert.equal(entry.display, "OpenCode Go 60%")
assert.equal(entry.total, "60%")
assert.equal(findDetail(details, "used", 18000)?.value, "12.5%")
assert.equal(findDetail(details, "remaining", 18000)?.value, "87.5%")
assert.equal(findDetail(details, "reset", 18000)?.value, "18000")
assert.equal(findDetail(details, "used", 604800)?.value, "40%")
assert.equal(findDetail(details, "remaining", 604800)?.value, "60%")
assert.equal(findDetail(details, "reset", 604800)?.value, "381600")
assert.equal(findDetail(details, "used", 2592000)?.value, "5%")
assert.equal(findDetail(details, "remaining", 2592000)?.value, "95%")
assert.equal(findDetail(details, "reset", 2592000)?.value, "2678400")

const clamped = parseOpenCodeGoUsage({
  usage: { rolling: { percent: -20 }, weekly: { percent: 150 } },
}, nowMs)[0]
assert.equal(clamped.display, "OpenCode Go 0%")
assert.equal(findDetail(clamped.details ?? [], "used", 18000)?.value, "0%")
assert.equal(findDetail(clamped.details ?? [], "remaining", 18000)?.value, "100%")
assert.equal(findDetail(clamped.details ?? [], "reset", 18000), undefined)
assert.equal(findDetail(clamped.details ?? [], "used", 604800)?.value, "100%")
assert.equal(findDetail(clamped.details ?? [], "remaining", 604800)?.value, "0%")

const decimal = parseOpenCodeGoUsage({ usage: { rolling: { percent: 12.34 } } }, nowMs)[0]
assert.equal(findDetail(decimal.details ?? [], "used", 18000)?.value, "12.3%")
assert.equal(findDetail(decimal.details ?? [], "remaining", 18000)?.value, "87.7%")

const limited = parseOpenCodeGoUsage({
  usage: { rolling: { status: "rate-limited", percent: 100 } },
}, nowMs)[0]
assert.equal(limited.display, "OpenCode Go 0%")

const pastReset = parseOpenCodeGoUsage({
  usage: { rolling: { percent: 1, resetsAt: "2020-01-01T00:00:00.000Z" } },
}, nowMs)[0]
assert.equal(findDetail(pastReset.details ?? [], "reset", 18000)?.value, "0")

for (const raw of [null, {}, { usage: null }, { usage: {} }, { usage: { rolling: { status: "ok" } } }]) {
  assert.throws(() => parseOpenCodeGoUsage(raw, nowMs), /EMPTY/)
}

const provider = balanceProviders.find((candidate) => candidate.id === "opencode-go")!
assert.equal(provider.name, "OpenCode Go")
assert.deepEqual(provider.credentialProviderIDs, ["opencode-go", "opencode"])
assert.equal(matchBalanceProvider("opencode-go")?.id, "opencode-go")
assert.equal(matchBalanceProvider("OPENCODE-GO")?.id, "opencode-go")
assert.equal(matchBalanceProvider("opencode-go-preview")?.id, "opencode-go")
assert.equal(matchBalanceProvider("opencode"), undefined)

const context = {
  location: { directory: "/mock-project" },
  data: { location: { provider: { list: () => [{ id: "opencode-go" }] } } },
} as unknown as Context
const calls: string[] = []
const token = findOpencodeKeyV2(context, provider, "opencode-go", (providerID) => {
  calls.push(providerID)
  return providerID === "opencode" ? "mock-console-token" : ""
})
assert.deepEqual(calls, ["opencode-go", "opencode"])
assert.equal(token, "mock-console-token")

const hostKeyContext = {
  location: { directory: "/mock-project" },
  data: { location: { provider: { list: () => [{ id: "opencode-go", key: "host-key" }] } } },
} as unknown as Context
assert.equal(
  findOpencodeKeyV2(hostKeyContext, provider, "opencode-go", () => { throw new Error("must not resolve") }),
  "host-key",
)

console.log("OpenCode Go shape tests passed")
