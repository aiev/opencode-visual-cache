# Visual-cache: bounded refresh and session-owned snapshots

Date: 2026-10-08. Local implementation based on upstream 1.7.5, commit
`6d93e072b76be983394c4e2f82803803697e1bb4`. Package version remains 1.7.5;
this PR does not include a release or npm publication.

## Changes

- Heavy distribution work is coalesced in bounded 100ms windows. Unlike a
  trailing debounce, ongoing streams cannot keep postponing publication.
  Cheap tracked summary reads retain host reactivity, including nested output
  and reasoning counters. Model pricing has its own memo rather than rebuilding
  the provider index twice on every message update.
- Estimated text contributions are reused when their **semantic inputs** have
  not changed. This is not an object-identity cache: in-place input/output,
  status, file/text flags and skill changes are detected. Exact API counters and
  last-turn step summaries remain live; only estimates are cached. Records are
  pruned to the current loaded messages and cleared on viewed-session changes.
- Part traversal is shared with the last-turn calculation, avoiding a second
  read of the same message's parts. Large host tool responses are still joined
  when a distribution refresh happens; this is not yet incremental output I/O.
- V2 tool/step/execution events are translated to the panel's event interface
  with global ownership preserved. Events from another session do not cause
  refreshes; scoped V1 events still work.
- Snapshot updates are coalesced over 250ms and compared field-by-field against
  stored values. No update is requested for an unchanged snapshot. Pending
  snapshots flush on viewed-session changes and disposal; storage errors remain
  non-critical. Async saves are serialized, retaining only the newest waiting
  value so slow persistence cannot produce an unbounded backlog or out-of-order
  writes. Identical refreshes during an in-flight save do not duplicate writes.
- The derived `cache_panel.dist_snapshot` value is now
  `{ version: 1, sessionID, dist }`. A foreign or ownerless legacy value cannot
  be used to display another session's distribution. Legacy derived caches are
  recomputed rather than guessed; OpenCode messages/history are not changed.
- The V2 adapter preserves available session token/cost aggregates instead of
  forcing message-window fallback. When unavailable, the previous fallback
  remains. Pricing, token-estimation ratios, currency conversion, skill maxima
  and turn grouping are unchanged.
- Balance-provider logic, credentials and polling are unchanged.
- Storage-readiness restoration is canceled on panel disposal. A delayed restore
  cannot replace an already valid live distribution with an older stored value.

## Tests

`npm test`: 21 passing test entries, including the two pre-existing balance and
credential test files. `npm run typecheck`, `npm run build`, package dry-run and
`git diff --check`: passed.

Coverage includes exact token/distribution/skill/step semantics; token-only
updates without text re-estimation; in-place edits; late hydration; removed and
reordered messages; circular inputs; bounded timers and cleanup; event owners;
snapshot session isolation, unchanged-write suppression, coalescing, flushing,
slow asynchronous saves, queued latest-value retention, synchronous and async
storage failures. CI now runs the tests in addition to typecheck/build.

## Actual-TUI comparison

The isolated fixture mounts the actual panel and V2 adapter, using the installed
1.7.5 bundle as the baseline and the proposed compiled bundle as the alternative.
Both copied bundles receive only test-only exports. It uses host **memory**
storage, 128 synthetic assistant messages, each with a 17,408-character synthetic
tool result, and no model calls or real prompts. The balance root and commands
are not mounted, so no credential lookup or provider-balance request is made.

Common checks compare the exact initial and final distributions and rendered
hit rate, cost, model and changed skill. Proposed-only checks cover real session
aggregates beyond the loaded window, empty child selection, late hydration,
return to the parent, stale pending parent work during a child switch, nested
Solid-store token changes without events even when session aggregates exist,
and disposal with restoration/refresh work pending.

Six final trials (three per implementation, alternating order) passed all
84 fixture assertions (27 baseline, 57 proposed). Each final trial verified the
expected bundle in its CPU profile. Initial and final distributions were equal
between implementations. The global CLI config was unchanged by these trials.

Results for the same 64-update phase:

| Metric | Installed 1.7.5 | Proposed |
| --- | ---: | ---: |
| Whole-client CPU-ms, trials | 1,967 / 2,037 / 2,065 | 229 / 192 / 243 |
| Whole-client CPU-ms, mean | 2,023.0 | 221.3 |
| Wall-ms including waits, mean | 3,380.0 | 1,806.7 |
| Message-list accesses, each trial | 128 | 128 |
| Provider/model-list accesses, each trial | 128 | 0 |
| Historical output-text getter reads, each trial | 8,256 | 1,664 |
| Snapshot update calls, each trial | 64 | 5 |

That is **89.1% less whole-client CPU work in this synthetic output-heavy phase**,
79.8% fewer output getter accesses, and 92.2% fewer snapshot update calls. The
message-list count is unchanged: both the panel and its balance-provider
auto-selection still read the reactive list, but heavy part work is coalesced.

Eight foreign legacy callbacks previously caused 9 scans, 1,161 output reads and
9 identical snapshot updates in every trial; proposed caused zero of each.
Foreign real V2 step events caused no work in either version (baseline never
bridged those names). Eight unchanged current callbacks caused 9 snapshot
updates before and zero after, with output reads falling from 1,161 to 256.

Development trials were excluded from these final measurements. Fixture-only
issues were corrected (Solid proxies require JSON copying rather than
`structuredClone`, rendered token counts use `fmt`, and panel mounting must be
awaited instead of assuming readiness after a fixed sleep). The earlier 90.0%
result was superseded after final-review fixes and new correctness scenarios.

## Measurement definition and limits

- A fixed batch of **64 current-message token updates**, 20ms between updates,
  is followed by 450ms for coalesced UI/snapshot work to settle.
- Fixture phase CPU is the whole temporary client's `process.cpuUsage()` user
  plus system microseconds, expressed as CPU-ms consumed for the same work.
  Wall time includes scheduled waits and any event-loop delay; it is not pure
  computation time or a model throughput measurement.
- Counters track output-text getter accesses and snapshot mutation invocations,
  **not** physical disk reads/writes, fsync count or persisted-history changes.
- A separate ten-second CPU profile verifies the loaded bundle and covers part
  of the broader fixture run. Baseline and proposed have different extra
  correctness phases, so aggregate profile CPU/RSS are not a matched performance
  comparison. Only the same named 64-update phase is used for CPU comparisons.
- Fresh 180×52 PTYs attach to one existing historical session, verified before
  startup. Inline configuration explicitly loads only the fixture (and disables
  the normal visual-cache), not the entire global plugin list. The shared service
  and other TUIs remain live. The fixture's messages are synthetic and do not
  replace or modify the attached session's messages.
- No idle performance improvement is claimed: earlier real-session ablations
  were inconclusive, and neither implementation does distribution work in the
  fixture's idle phase. There is no general RAM-gain claim.
- No end-to-end gain percentage is inferred for all real streaming sessions.
  The synthetic output-heavy workload deliberately exercises redundant history
  estimates; contribution-cache storage also has a bounded memory cost.

## Evidence and reproduction

The portable Linux driver is [`scripts/benchmark-visual-cache.py`](../../scripts/benchmark-visual-cache.py);
the complete synthetic fixture is [`scripts/fixtures/visual-cache.mjs`](../../scripts/fixtures/visual-cache.mjs).
It needs OpenCode 2.0.22 with SIGPROF support, a built checkout, an unmodified
1.7.5 bundle, and an existing idle session. It verifies the session before
starting a TUI, never submits a prompt, and refuses to overwrite an evidence
directory. It checks global config identity and original bundle fingerprints.

```sh
npm run version
npm run build
python3 scripts/benchmark-visual-cache.py \
  --session '<existing-idle-session-id>' \
  --directory '<session-directory>' \
  --baseline '<installed-1.7.5-or-built-upstream>/dist/v2.js' \
  --output '/tmp/opencode/visual-cache-comparison-new' \
  --rounds 3
```

The final raw local result is `/tmp/opencode/visual-cache-pr-final/result.json`.
Original profiles and machine-local artifacts remain private; the committed
fixture contains only synthetic messages and no real IDs, prompts or credentials.

Sanitized final measurements: [`visual-cache-2026-10-08.json`](visual-cache-2026-10-08.json).

SHA-256 fingerprints:

- Installed 1.7.5 V2 bundle:
  `97af24aa84cc4016614236420e7c251063ab2fe3e75398b14117544cede80183`
- Proposed V2 build:
  `cc0eb85591d8f6fc88216e98eeb74efc36210a0923a331cc821b0e9b9b3065d6`
- Raw six-trial local result:
  `7cc8c28b5db2fd3a94328d0d0cc8648a55778161851bfecce081fb05aaef2a92`

## Activation

Activated the validated local checkout in `~/.config/opencode/cli.json`, replacing
only `opencode-visual-cache@latest`. All seven configured plugin directives and
every unrelated setting were retained. The CLI config and previous derived
snapshot were backed up before activation under
`~/.local/state/opencode/visual-cache-backups/20261008T035502Z/` (private directory;
backup files mode 0600). The subsequent smoke also backed up the attached
session's shell manifest and subagent store.

A fresh normal TUI with all seven configured plugin directives stayed alive for
12 seconds and the actual local plugin produced a version-1 snapshot owned by
the viewed session. All 281 historical subagent records for that session were
identical before/after; the shell manifest was byte-identical. No prompt or
history-clear command was sent, and the smoke did not modify the CLI config or
the measured bundle. This is startup/correctness validation, not a full-plugin
performance comparison. Normal plugin startup may still refresh balances.

Local final-build smoke evidence:
`/tmp/opencode/visual-cache-activation-smoke-pr-final.json`; driver:
`/tmp/opencode/smoke-visual-cache-local.py`. No background-service restart or npm
publication is part of the change. Already-open TUIs should be reopened to
ensure that they load the validated bundle.
