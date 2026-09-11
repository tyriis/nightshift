# Plan I: Beta v0.1.0 shell wave — Implementation Plan

> Agentic worker note: execute top-down; every number in the FINAL-GATE
> RECORD is measured, not pasted. Authority: the maturity review
> (`docs/superpowers/reviews/2026-09-11-nightshift-beta-v0.1.0-maturity-review.md`)
> §3 CUT + this session's ticket #20. #16 is input, not authority.

**Goal:** move the five CUT MUST items so a `v0.1.0` tag becomes possible:
image reference + one publish (CUT 1), version surface (CUT 2), root README
(CUT 3), non-bypassable CI + build gate (CUT 4), live bar re-recorded on the
shipped bytes (CUT 5). Shell only — the product surface does not move.
**Architecture:** docs + `ci.yaml` edits on `main`'s shape (`eb8e585` +
review merge `090a86b`); image built from this branch and tagged
`ghcr.io/tyriis/nightshift:v0.1.0`. **Tech Stack:** existing pnpm/vitest/
Playwright gates, legacy docker builder (D-ddd lineage).

## Status & branch

- `main` = `090a86b` (PR #19 merged; review doc lands — re-verified 2026-09-11).
- Suite on `main` re-measured this shift: `vitest run` **703 / 90** (exact, matches §0).
- Branch: `feature/beta-v0.1.0-shell-wave` off `090a86b`.
- `git tag` at start: empty. `package.json` stays `0.1.0` (no bump — it already IS the version).

## Decision records

- **D-sss — image reference locked:** `ghcr.io/tyriis/nightshift`, one tag
  `v0.1.0` per release, `@sha256` digest is the home-ops pin. npm publish
  stays DROPPED (not deferred) per #16's locked decision. Reconciled ONCE
  with #16's publish lane + the QUEUED home-ops deploy: the CI `docker` job
  only BUILDS (day-one-capable for push); the operator's manual
  `docker push` carries `v0.1.0` (§FINAL-GATE RECORD, publish lane).
- **D-ttt — version surface:** annotated `v0.1.0` tag applied by the
  operator AFTER this PR merges, on the merge commit; mapping
  (`package.json` version == git tag == image tag; digest pin for rollback)
  recorded in root `CHANGELOG.md` with honest known-gaps. Pre-releases:
  `v0.1.0-rc.N`.
- **D-uuu — root README.md:** exists at last; 5-line container quickstart
  pointing into `deploy/README.md`, pointers to spec/contract/review/plans,
  Apache-2.0 note. Content lifted from `deploy/README.md` — no new claims.
- **D-vvv — `ci.yaml` (first legitimate edit, scope-guarded):** adds ONE
  `docker` job (`docker build` on push/PR, no push step). The `check` job is
  byte-unchanged. Required-status-check flip is HUMAN (prepared `gh api`
  calls in the PR body); contexts = `check` + `docker`.
- **D-www — live bar re-recorded on the shipped bytes (CUT 5):** fresh
  `--no-cache` image `ad53ba2ddbb2` built from THIS branch → twin healthy
  i=3 → `scripts/deploy-smoke.mjs` **24 PASS / 0 FAIL, exit 0** — legs
  byte-unchanged from the H record; hashed-asset line reads `start.Cs0EahH7`
  as measured. Tail appended in `deploy/DEPLOY-SMOKE.md`.

## Tasks

1. **CUT 3** — root `README.md` (new).
2. **CUT 2** — root `CHANGELOG.md` (new) + tag/digest note (D-ttt).
3. **CUT 4** — `ci.yaml` `docker` build arm (D-vvv) + required-checks prep (PR body).
4. **CUT 1** — build + tag `ghcr.io/tyriis/nightshift:v0.1.0`; push lane per D-sss.
5. **CUT 5** — live bar on the tagged image; append the I-wave tail to `deploy/DEPLOY-SMOKE.md`.
6. Full gate ladder + FINAL-GATE RECORD here; PR `resolves #20`; NEVER merge.

## Scope guard (what this plan REJECTS)

No product-feature work; `openapi/`, MCP-35, `docs/superpowers/specs/**`
byte-frozen (untouched — see zero-drift table). Post-cut items stay behind:
Renovate/Dependabot, SHA-pinning of actions (the new `docker` job reuses the
existing tag-pinned style to keep the diff minimal — pinned in the same
post-beta wave), release automation, coverage artifacts, concurrency groups,
e2e CI job + browser reinstall, `SECURITY.md`/CoC/CODEOWNERS/templates,
provenance/SBOM/CodeQL, linear-history + conversation-resolution flags, all
product-QUEUED items. npm publish: dead. Branch-protection flips + GHCR
visibility/token scoping + registry push: HUMAN, prepared verbatim in the PR.

## Execution ledger

- 2026-09-11: `main` re-verified at `090a86b` (PR #19 MERGED, mergeCommit oid
  confirmed via `gh pr view 19`); suite 703/90 re-measured; zero tags at start.
- Branch `feature/beta-v0.1.0-shell-wave` created off `090a86b`. Tasks 1–5
  executed top-down; I-wave tail appended to `deploy/DEPLOY-SMOKE.md` §1.
- Publish lane at record time: `docker push` from this session returns
  `permission_denied: The token provided does not match expected scopes`
  (4 attempts; `gh api /user` = `tyriis`). Package NOT yet on GHCR — the
  operator push is the single remaining publish step (HUMAN, verbatim below).

## FINAL-GATE RECORD (2026-09-11, this branch)

- **Gate ladder, all exit 0:** `pnpm test:coverage` **703 tests / 90 files**;
  coverage `Statements 99.53 (1938/1947) · Branches 98.58 (905/918) ·
  Functions 99.79 (476/477) · Lines 99.71 (1765/1770)` ≥ every H floor
  (99.53/98.57/99.78/99.71); `pnpm lint` clean; `pnpm typecheck` no errors;
  `pnpm build` ok; `pnpm ui:build` ok; `pnpm ui:offline-check` offline-safe
  (hosts: w3.org, svelte.dev); `pnpm test:e2e` **1 passed (4.0s)**.
- **LIVE leg (D-www):** legacy builder `--no-cache` → `Successfully built
  ad53ba2ddbb2` / tagged `ghcr.io/tyriis/nightshift:v0.1.0`; throwaway
  volume `ns-i-smoke`, twin `ns-i` (127.0.0.1:3199→3123, env-only
  bootstrap per D-ff) **healthy at i=3**; `node scripts/deploy-smoke.mjs`
  → **`deploy-smoke: ALL PASS` — 24 PASS / 0 FAIL, exit 0** (all H-wave
  probe lines green incl. `search finds the smoke task (FTS5 live)`).
  Teardown `docker stop -t 12` ExitCode 0; residue: container list and
  volume list for `ns-i` both empty.
- **Zero-drift (vs `origin/main`):** touched = `README.md` (new),
  `CHANGELOG.md` (new), `deploy/DEPLOY-SMOKE.md` (I-wave tail),
  `.github/workflows/ci.yaml` (D-vvv `docker` job), this doc. Byte-untouched:
  `openapi/`, `src/**`, `adapters/**`, `bin/`, `e2e/`, `scripts/**`,
  `deploy/README.md`, `docs/superpowers/specs/**`, `vitest.config.ts`,
  `package.json`, `pnpm-lock.yaml`, `lefthook.yaml`.
- **HUMAN steps for the operator (in order):**
  1. Merge PR (never by this shift).
  2. `git tag -a v0.1.0 <merge-sha> -m "nightshift beta v0.1.0" && git push origin v0.1.0`
  3. `docker push ghcr.io/tyriis/nightshift:v0.1.0` (image `ad53ba2ddbb2` built here; rebuild is deterministic: `docker build --no-cache -t ghcr.io/tyriis/nightshift:v0.1.0 .`), then `docker image inspect --format '{{index .RepoDigests 0}}' ghcr.io/tyriis/nightshift:v0.1.0` → record the `@sha256` for home-ops.
  4. GHCR package visibility → public (for external testers).
  5. Branch-protection flip — `gh api` prep in the PR body.
- **QUEUED (HUMAN)** unchanged from #20: home-ops bundle (HelmRelease,
  digest pin, §14 walkthrough = the beta acceptance run), Playwright
  browser reinstall + CI e2e job, session-key dual-rotation,
  `removeAdditional` 400-flip, OBS-1, MCP search exposure, CLI `search`
  leg, saved filters/undo, capability scopes, CSP, email, SSE,
  detail-page liveness. npm publish — DROPPED, do not resurrect.

## NEXT session handover

Beta shell wave is on `main` after the operator merge + tag + push. Next
shift: **acceptance shift** — run the recorded bar against the PUBLISHED
digest (`docker pull ghcr.io/tyriis/nightshift@<digest>` → deploy-smoke 24
again), then the §14 operator walkthrough (real Pocket ID, two humans,
`deploy/DEPLOY-SMOKE.md` steps 4/5/7) and the first-week audit. Post-cut
items enter only on recorded evidence. Never merge; sign commits;
grep-never-guess.
