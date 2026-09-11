# deploy/ — the nightshift operator surface (Plan F, D-eee)

Everything an operator needs to run, wire Pocket ID to, and drive a nightshift
instance. The live acceptance checklist is [`DEPLOY-SMOKE.md`](DEPLOY-SMOKE.md);
this README is the reference it points back to. Every fact here is transcribed
from the shipped code — `src/main/config.ts`, `src/cli/run.ts`, `Dockerfile`,
`src/main/bootstrap.ts`, `src/index.ts` — nothing invented.

## What ships here

**Repo-side artifacts** (this repository):

- `Dockerfile` — the three-stage image (`build` → `proddeps` → `runtime`), all
  stages on the ONE base tag `node:24-bookworm-slim` (one glibc, one native ABI).
- `bin/nightshift.mjs` — the CLI shim (`package.json` `bin.nightshift`); ships in
  the image and resolves `dist/` after `pnpm build` (`src/` under the
  `development` condition is the `pnpm cli` dev path).
- `scripts/deploy-smoke.mjs` + `scripts/fts-probe.mjs` — the automated probes
  driven by `DEPLOY-SMOKE.md`.
- `deploy/DEPLOY-SMOKE.md` + this README.

**Home-ops side (NOT this repo):** the HelmRelease, the image build in CI, the
registry push, and the **tag/digest pin** — the Dockerfile states the posture:
operators pin `@sha256` digests in home-ops.

**The image itself:** `build` compiles `tsc` + the SvelteKit static SPA and runs
the offline gate as an image gate (`pnpm build && pnpm ui:build &&
pnpm ui:offline-check` — a shell that phones a CDN REDS the image); `proddeps`
installs `--prod` only (better-sqlite3's native build lands HERE; the
`python3`/`make`/`g++` node-gyp tooling exists only in the build stages and
never ships in the runtime layer); `runtime` is **non-root** (`USER node`,
uid `1000`), `WORKDIR /app` with the app tree root-owned 755 — the `/data`
volume is the only writable path — `ENV NS_DB_PATH=/data/nightshift.db
NS_DATA_DIR=/data`, `EXPOSE 3123`, a `HEALTHCHECK` on `/ping`, and
`ENTRYPOINT ["node", "dist/index.js"]`.

## Quickstart

```bash
docker build -t nightshift:local .
docker volume create ns-data
BOOT_TOKEN="planf-local-smoke-token-0123456789abcdef" # the documented local-smoke literal, never a real secret
docker run -d --name nightshift -p 127.0.0.1:3123:3123 \
  -v ns-data:/data -e NS_BOOTSTRAP_TOKEN="$BOOT_TOKEN" nightshift:local
curl -s http://127.0.0.1:3123/ping   # {"pong":"it worked!"} — public, no auth
```

One volume at `/data`, first boot seeded by `NS_BOOTSTRAP_TOKEN` (see Volumes
and the env table). **Port mapping targets `NS_PORT`** — the container listens
on it (default `3123`), so if you set `-e NS_PORT=4000`, map `-p …:4000`. The
`$BOOT_TOKEN` literal above is the plan's documented local-smoke value
(`DEPLOY-SMOKE.md` §0); a real deployment generates its own (≥32 chars) and
keeps it env-only.

## The environment — every `NS_*` the server reads

Transcribed from `src/main/config.ts:5-40` (schema), bounds verbatim. The image
sets `NS_DB_PATH=/data/nightshift.db` and `NS_DATA_DIR=/data` as `ENV`
(`Dockerfile:47-48`); repo defaults apply when running from source.

| Variable                    | Default                                          | Rule (config.ts)                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NS_PORT`                   | `3123`                                           | int, `1024`–`65535`                                                                                                                                                                                                     |
| `NS_DB_PATH`                | `./nightshift.db` (image: `/data/nightshift.db`) | non-empty string                                                                                                                                                                                                        |
| `NS_BOOTSTRAP_TOKEN`        | unset (optional)                                 | ≥32 chars; first-boot admin + token — **env-as-truth per boot**, see Volumes                                                                                                                                            |
| `NS_DATA_DIR`               | `./data` (image: `/data`)                        | non-empty string; uploads live here                                                                                                                                                                                     |
| `NS_MAX_UPLOAD_BYTES`       | `20971520`                                       | int, ≥`1024`                                                                                                                                                                                                            |
| `NS_RATE_LIMIT_PER_MIN`     | `120`                                            | int, ≥`0`; **`0` = limiter off** (`rate-limit.ts:15`)                                                                                                                                                                   |
| `NS_WEBHOOK_INTERVAL_MS`    | `1000`                                           | int, ≥`0`; **`0` disables the delivery loop** (`config.ts:97`, `index.ts:26`)                                                                                                                                           |
| `NS_WEBHOOK_TIMEOUT_MS`     | `5000`                                           | int, ≥`100`                                                                                                                                                                                                             |
| `NS_WEBHOOK_MAX_BACKOFF_MS` | `300000`                                         | int, ≥`1000`                                                                                                                                                                                                            |
| `NS_OIDC_ISSUER`            | unset (optional)                                 | non-empty; **trailing `/` stripped at load**                                                                                                                                                                            |
| `NS_OIDC_CLIENT_ID`         | unset (optional)                                 | non-empty                                                                                                                                                                                                               |
| `NS_OIDC_CLIENT_SECRET`     | unset (optional)                                 | ≥8 chars; env-only; sent in the token-endpoint **BODY** only (`client_secret_post`), never the URL, never logged (D-ff); absent ⇒ public client + PKCE                                                                  |
| `NS_OIDC_SCOPE`             | `openid profile email`                           | non-empty                                                                                                                                                                                                               |
| `NS_PUBLIC_URL`             | unset (optional)                                 | non-empty; **trailing `/` stripped at load**; REQUIRED with OIDC                                                                                                                                                        |
| `NS_SESSION_KEY`            | unset (optional)                                 | ≥32 chars; REQUIRED with OIDC; env-only                                                                                                                                                                                 |
| `NS_SESSION_TTL_S`          | `28800`                                          | int, `60`–`2592000` (8 h absolute, no idle refresh)                                                                                                                                                                     |
| `NS_KEEPALIVE_INTERVAL_MS`  | `0`                                              | int, ≥`0`; **`0` = sweeper never starts (dormant default, D-ggg)**; the sweep tick when enabled                                                                                                                         |
| `NS_KEEPALIVE_TIMEOUT_S`    | `0`                                              | int, ≥`0`; **`0` = claims never expire**; silence budget before a silent claim reverts to `todo`; with the interval it forms an all-or-nothing pair — half-open fails the boot, budget ≥ tick (`config.ts` superRefine) |

**Fail-closed matrix (D-qq, `config.ts:45-61`):** once OIDC is configured —
`NS_OIDC_ISSUER` **AND** `NS_OIDC_CLIENT_ID` set — then `NS_SESSION_KEY` and
`NS_PUBLIC_URL` are **REQUIRED**; a half-configured login surface fails the
boot with the pinned `invalid env: …` throw (exit 1). No issuer/client-id ⇒
everything stays dormant and every pre-E deployment is byte-identical.

**Secrets are env-only, never argv, never logged, never echoed in errors
(D-ff)** — applies to every `NS_*` secret and to the CLI's `NS_TOKEN` /
`NS_LEASE_TOKEN` below.

## OIDC / Pocket ID

**Dormant rule:** with no issuer/client-id, the routes still EXIST (the drift ⇄
yaml set stays config-invariant) and the two pre-session GET legs `GET
/auth/login` and `GET /auth/callback` answer the pinned `500 internal_error` +
detail `oidc not configured` (`routes/auth.ts:51,66`); `/auth/me` and
`/auth/logout` stay auth-gated as before. Public without any credential are
exactly `/ping`, `/openapi.yaml`, GET/HEAD `/ui…`, and GET `/auth/login` +
`/auth/callback` (`auth.ts:22,29`).

**Registering the Pocket ID client:** redirect URI `{NS_PUBLIC_URL}/auth/callback`;
confidential client ⇒ `client_secret_post` (present `NS_OIDC_CLIENT_SECRET` ⇒
the secret travels in the token-endpoint BODY only — D-ff/D-pp). Then set
`NS_OIDC_ISSUER`, `NS_OIDC_CLIENT_ID`, `NS_OIDC_CLIENT_SECRET`, `NS_PUBLIC_URL`,
`NS_SESSION_KEY` (the fail-closed matrix above).

**D-pp caveat — VERBATIM from Plan E (read before wiring):**

> Pocket-ID-ops note (QUEUED HUMAN): `INTERNAL_APP_URL`, when set on the IdP,
> rewrites `jwks_uri`/`token_endpoint` to a host only reachable from the IdP's
> network — the operator either leaves it unset or moves the RP closer to the
> IdP; stated here so the morning operator is not surprised.

The nightshift container must reach the **PUBLIC** URLs — check from inside the
container (`DEPLOY-SMOKE.md` §4 ships the `docker exec … fetch` one-liners for
`jwks_uri`/`token_endpoint`). Note the shape of the deployment: the browser is
same-origin with this app while the IdP lives on another host — cookie domains
split — which is exactly why sessions here are signed `httpOnly`
`__Host-ns_sess` envelopes rather than IdP-domain cookies (D-pp/D-qq).

**Nonce echo — verify-once at the FIRST real login (QUEUED HUMAN):**

> `nonce` echo is Fosite-conformant but was NOT confirmed in Pocket ID's repo
> (lib-1 flag 1): the stub asserts it, the RP requires it, and a verify-once
> against the real instance is QUEUED (HUMAN).

A successful browser login IS the verification (the RP rejects a callback whose
nonce does not byte-match) — tick the box in `DEPLOY-SMOKE.md` §4.

**Session-key rotation (D-qq) — VERBATIM from Plan E:**

> Key rotation is deliberately deferred: single active key, env-keyed, rotation
> story = operator reissues key ⇒ all sessions die on the exp bound — QUEUED
> (HUMAN) if the operator wants dual-key rotation.

Reissue `NS_SESSION_KEY` ⇒ every existing cookie fails signature verification
by the `NS_SESSION_TTL_S` outer bound at the latest; restart alone does NOT
invalidate sessions (the `sessions` table survives — stated).

## Keepalive enforcement (Plan G)

**Dormant by default** (`0`/`0` — D-ggg). To ENABLE, set BOTH (half-open fails
the boot, exit 1): e.g. `NS_KEEPALIVE_INTERVAL_MS=10000 NS_KEEPALIVE_TIMEOUT_S=300`.
A claimed task whose last liveness (heartbeat — or the claim itself, which counts
as the first) predates the budget reverts to `todo` at the next tick: claim
cleared, generation bumped, audit gains action `lease_expired` with reason
`lease expired` (spec §6.7's pre-named reason — it rides `GET /audit` and the
event feed). Any LATER write with the old lease answers `412 stale_lease` — the
zombie fence, zero new error surface. Holders stay alive by heartbeating inside
the budget (`nightshift heartbeat`, or MCP `post_update` which already rides it).

A CLAIM echoes the pair: `POST /tasks/{id}/claim` answers `keepalive:
{interval_ms, timeout_s}` (0/0 = dormant) so a holder paces off the server's
policy, never off a guess (§12's "lease carries interval + timeout", shipped in H).

Effective budget is TICK-QUANTIZED: expiry is checked only on sweep
ticks, so detection can lag the configured budget by up to one interval
(worst case budget == interval means up to a full interval late — quality-lane
advisory off ed74a60, sanctioned here into the operator text).

## Volumes & WAL

**ONE volume mounted at `/data`** — the SQLite db trio (`nightshift.db` +
`-wal` + `-shm`) and the uploads tree (`NS_DATA_DIR`) all live there.

- **NEVER schedule two containers on one `/data` volume** — SQLite is
  single-writer and the WAL sidecars live beside the db (caps, per
  `DEPLOY-SMOKE.md`'s own caps line).
- **NEVER put `/data` on a network filesystem** — WAL requires
  local-POSIX-shared-memory semantics; `-shm` over NFS is corruption territory.
- **Backup = stop, then copy** the db trio AND the `data/` tree (the `docker
stop -t 12 $C` + `docker cp` pattern in `DEPLOY-SMOKE.md` §5/§6 checkpoints
  the WAL first). Copy the live files while running and you copy a torn state.
- **RESTORE:** child rows are FK-enforced, so restore the **FULL trio to a
  clean target** (db + `-wal` + `-shm` together, onto nothing) — never merge
  pieces into a foreign or pre-existing db file.
- **Bootstrap is env-as-truth per boot** (`src/main/bootstrap.ts` as-is):
  `NS_BOOTSTRAP_TOKEN` re-arms (UPSERTs) the `tok_bootstrap` row onto the env's
  hash on EVERY boot. `POST /admin/tokens/tok_bootstrap/revoke` alone is
  undone by the next restart — **durable revocation requires REMOVING the env
  from the deployment too** (`bootstrap.ts:24-27`; `DEPLOY-SMOKE.md` §5 pins
  the two-step).

## Non-root, read-only `/app`, graceful stop

The runtime runs as `node` (**uid `1000`**); the `/app` tree is root-owned 755,
so the process has no writable path except `/data` (`Dockerfile:31-34,45-46` —
`DEPLOY-SMOKE.md` §2 probes `id -u` and `READONLY-APP-OK`). On `SIGTERM`/`SIGINT`
the process drains the delivery loop, closes the server, destroys the db pool
and exits **0** (`src/index.ts:28-41`; a second signal while closing is a
no-op) — `docker stop -t 12` measures ExitCode 0 and checkpoints the WAL on the
way out.

## Health

`GET /ping` → `{"pong":"it worked!"}` — public, no credential (`app.ts:42-44`).
The image `HEALTHCHECK` is a `node -e` fetch against
`http://127.0.0.1:${NS_PORT??3123}/ping` (no curl in the image),
`--interval=30s --timeout=3s --start-period=5s --start-interval=1s
--retries=3` (`Dockerfile:50-51`).

## The CLI

`nightshift` (`bin/nightshift.mjs`; in-image `docker exec … node
bin/nightshift.mjs …`, host `node bin/nightshift.mjs …` after `pnpm build`,
dev `pnpm cli …` — `DEPLOY-SMOKE.md` §3). The usage block below is copied
verbatim from `src/cli/run.ts:42-44` (`nightshift --help` prints exactly these
lines, on **stderr**, exit 0):

```text
usage: nightshift next [--label L] [--limit N] | claim <task-id> | heartbeat <task-id> | report <task-id> [--message M] [--status S --reason R]
env: NS_URL + NS_TOKEN required · NS_LEASE_TOKEN for heartbeat and --status · NS_TIMEOUT_MS default 15000 (secrets via env, never argv — D-ff)
exit: 0 ok · 1 transport_error · 2 usage/config (nothing sent) · 3 API problem (`nightshift: <code>` on stderr)
```

The commands (the exact set `run.ts` dispatches):

| Command           | Flags/args                                                                                                                                               | Stdout on exit 0                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `next`            | `--label L`, `--limit N` (int 1..100 — the server pin)                                                                                                   | one JSON line per ready task (server DTO untouched); empty + 0 when none                      |
| `claim`           | `<task-id>` (exactly one)                                                                                                                                | `{"task_id":…,"lease_token":…,"generation":…}` — the lease rides STDOUT, never argv (D-ff)    |
| `heartbeat`       | `<task-id>` (exactly one); the lease via `NS_LEASE_TOKEN` — REQUIRED (absent ⇒ exit 2, nothing sent)                                                     | the server's Task DTO (liveness recorded)                                                     |
| `report`          | `<task-id>`, `--message M`, and/or `--status S --reason R` (`--status` REQUIRES `--reason`; S ∈ `backlog\|todo\|in_progress\|in_review\|done\|canceled`) | with `--message` only: `{"task_id":…,"message_id":…}`; with `--status`: the server's Task DTO |
| `help` / `--help` | —                                                                                                                                                        | (usage lines land on stderr)                                                                  |

Environment (CLI-side, `run.ts:22-27`):

| Variable         | Rule                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NS_URL`         | REQUIRED; validated URL                                                                                                                                                                                                         |
| `NS_TOKEN`       | REQUIRED; non-empty bearer                                                                                                                                                                                                      |
| `NS_LEASE_TOKEN` | optional; the claim-issued capability — REQUIRED for `heartbeat` (absent ⇒ exit 2, nothing sent) and REQUIRED **while the target task is CLAIMED** for `--status` (absent on an unclaimed task ⇒ omitted from the body; n29/P9) |
| `NS_TIMEOUT_MS`  | int ≥`100`, default `15000`; a per-call `AbortSignal.timeout`                                                                                                                                                                   |

**Secrets env-only, never argv (D-ff)** — `NS_TOKEN`/`NS_LEASE_TOKEN` never
appear in argv and are never echoed (`run.ts:132`:
`nightshift: config_error check NS_URL / NS_TOKEN / NS_TIMEOUT_MS (values never echoed)`).

**Exit ladder (pinned, grep-stable — branch on the code, never parse prose):**
`0 ok · 1 transport_error · 2 usage/config (nothing sent) · 3 API problem
(`nightshift: <code>` on stderr)` — stderr LINE 1 is always the machine string
`nightshift: <token>`. The shipped strings, verbatim from `run.ts`:

- exit 2 (usage/config — **nothing was sent**): `nightshift: usage_error <why>`
  (then the three usage lines), `nightshift: config_error --status must be one of backlog|todo|in_progress|in_review|done|canceled`,
  `nightshift: config_error --limit must be an integer 1..100 (the server pin)`,
  and the NS_URL/NS_TOKEN line quoted above.
- exit 1: `nightshift: transport_error` (network failure, timeout, or a body
  that is neither data nor a D-jj problem).
- exit 3 (API problem): `nightshift: <server taxonomy code verbatim>` — e.g.
  `nightshift: already_claimed` (race loser), `nightshift: stale_lease` — with
  the flat problem JSON on line 2.

Worked examples:

```bash
export NS_URL=https://board.example NS_TOKEN=<human-admin-token>
node bin/nightshift.mjs next --label infra --limit 5
node bin/nightshift.mjs claim t_01abc                      # lease_token on stdout — keep it in a pipe var
node bin/nightshift.mjs report t_01abc --message "wired the door"
NS_LEASE_TOKEN=<claim's lease_token> node bin/nightshift.mjs report t_01abc \
  --status in_progress --reason "starting work"            # wrong lease ⇒ exit 3 stale_lease
```

An agent-daemon loop is just the ladder: `next` → `claim` → work →
`report --message` → (lease-gated) `report --status`, branching on `$?` and the
line-1 code. Notes: thread `kind: question` is **deliberately unexposed** by
the CLI (humans decide — `run.ts:204`; `DEPLOY-SMOKE.md` §3/§7); an AGENT close
(`--status done`) answers `403 agent_close_forbidden` while `review_gate` is
`on` (the default) — only humans close.

## Upgrade & rollback

Migrations run AT BOOT (`migrateToLatest` before listen, `src/index.ts:17`) and
are **forward-only**. Rollback = start the prior image tag (digest-pinned); if
the schema moved between the tags, restore the pre-upgrade volume snapshot
(stop → copy the trio + `data/`) FIRST — an old binary against a new schema is
not supported. Take the snapshot before every upgrade.

## Deploy-smoke

Run the automated probes after any deploy: `DEPLOY-SMOKE.md` §1
(`NS_URL=… NS_TOKEN=… node scripts/deploy-smoke.mjs`). Expect **23 PASS /
0 FAIL** (exit 0). Plan F's ship-time run recorded 22/1 — the one FAIL was the
encoding-negotiated `/ui` shell variants served as `public, max-age=2592000,
immutable` (the bare `.html` check missed them; a 30 d stale-shell hazard, plus an
unprobed gzip-fallback face). Plan G's `ui.ts` fix closed both faces and the G-wave
ship-time run measured 23 PASS / 0 FAIL with the probe byte-identical. Full lineage:
`DEPLOY-SMOKE.md` §1 and Plan F's Task-6 record.

Honest scope (D-eee): the automated legs (steps 0–3, 6) ran against the
ship-time container; the browser/OIDC legs (steps 4, 5, 7 — real Pocket ID, a
browser, two humans) are OPERATOR-side at home and have not run here.
