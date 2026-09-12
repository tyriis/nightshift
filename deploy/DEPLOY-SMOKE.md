# DEPLOY-SMOKE — the homelab deploy-smoke checklist (D-eee)

The §14 acceptance story, run LIVE on the real deployment. Split per D-eee:
**AUTOMATED** steps (0–3, 6) are non-interactive and carry zero secrets in the repo;
**OPERATOR** steps (4, 5, 7) need the real Pocket ID, a browser, and two humans.
Honesty bar (D-xx lineage): the LOCAL twin of 1–3 + 6 ran at ship time against the
Task-5 container — its evidence (every probe line, incl. the one known server-side
FAIL recorded below and in the plan's Task-6 record) lives in the plan document.
This checklist is what the operator runs AT HOME, on the real instance.

Never schedule TWO containers on ONE `/data` volume (single-writer SQLite — WAL
sidecars live beside the db; `deploy/README.md` states the rule in caps).

---

## 0. Inputs (env-only — D-ff)

- `NS_URL` — the deployed instance's public origin (e.g. `https://board.example`); steps 2/6 substitute the container name as `$C`.
- `NS_TOKEN` — a human-admin bearer (the bootstrap token while it is still alive).

Both scripts read secrets from the ENVIRONMENT only — never argv, never logged. For
LOCAL runs against the plan's Task-5 twin, the `NS_BOOTSTRAP_TOKEN` smoke literal in
the plan's own commands is the documented local-smoke value (never a real secret).

## 1. Automated probes — `scripts/deploy-smoke.mjs`

- [ ] From a checkout of the SAME code the image was built from (the probe byte-matches
      the served `/openapi.yaml` against this checkout — the D-ccc proof):

```bash
NS_URL=https://board.example NS_TOKEN=<admin-token> node scripts/deploy-smoke.mjs
```

Expected: one `PASS`/`FAIL` line per probe, then `deploy-smoke: ALL PASS` with **exit 0**
(any FAIL ⇒ `deploy-smoke: N FAIL`, exit 1; missing env ⇒ usage, exit 2). Machine lines,
never reworded. Covers: pong, contract byte-match, `/ui` shell + cache posture, hashed
asset caching, SPA deep-link, `/tasks` 401, `/mcp` 401, the full agent lifecycle on the
live contract (agent+token ⇒ task ⇒ claim/release/re-claim ⇒ lease-gated status ⇒ note ⇒
attachment round-trip ⇒ ascending event feed ⇒ agent release ⇒ human cancel ⇒ revoke).

> KNOWN FINDING — RESOLVED (Plan G, `fix(ui)` D-fff): the `/ui shell is
no-cache` arm FAILed against Plan F's shipped image — on an encoding-negotiated
> GET (`Accept-Encoding: br`) the preCompressed variants served
> `public, max-age=2592000, immutable`; `ui.ts`'s `setHeaders` `.endsWith('.html')`
> check missed the `.br`/`.gz` paths (and the gzip fallback leaked identically — a face
> the smoke never probed). Plan G re-pinned the predicate (strip the encoding extension
> before the `.html` check), pinned the class IN-SUITE (`ui.test.ts` U9/U9b), and the
> G-wave LIVE run measured **23 PASS / 0 FAIL, exit 0** — the probe was NEVER weakened:
> `scripts/deploy-smoke.mjs` byte-identical since Plan F. Historical evidence: Plan F's
> Task-6 record and the `d95dab4` gate-line amendment.
>
> H-wave LIVE run (fresh `--no-cache` image `4ceb72ad8928`) measured
> **24 PASS / 0 FAIL, exit 0** — every G arm green unchanged plus the new
> `search finds the smoke task (FTS5 live)` arm. `scripts/deploy-smoke.mjs` otherwise
> unchanged since F EXCEPT the sanctioned additive arm (D-rrr — growth by plan, zero
> assertions touched) and two comment-truth lines (D-mmm). Armed keepalive twin
> (1000/3): claim echoes `{interval_ms:1000,timeout_s:3}` (D-nnn live), silent claims
> revert with `lease_expired`/`lease expired` (in_progress g1 → todo g2), dead leases
> fence at exit 3 `stale_lease`, and cancel-with-lease clears the claim with
> `claim_released`/`claim released on cancel` (D-mmm live). `docker stop -t 12` both
> twins → ExitCode 0.
>
> I-wave LIVE run (beta shell wave; fresh `--no-cache` image `ad53ba2ddbb2`, built
> from `feature/beta-v0.1.0-shell-wave`, tagged `ghcr.io/tyriis/nightshift:v0.1.0`)
> measured **24 PASS / 0 FAIL, exit 0** — every H arm green, legs byte-unchanged;
> the hashed-asset line reads `start.Cs0EahH7` (UI hash, as measured). Boot twin
> on a throwaway volume healthy at i=3; `docker stop -t 12` → ExitCode 0; residue
> zero (container + volume gone).

## 2. Container / health / shutdown posture

- [ ] Boot is `healthy` (the HEALTHCHECK is `node -e` fetch on `/ping` — no curl in the image):

```bash
for i in $(seq 1 40); do [ "$(docker inspect -f '{{.State.Health.Status}}' $C)" = healthy ] && break; sleep 1; done
echo "health=$(docker inspect -f '{{.State.Health.Status}}' $C)"
docker exec $C id -u                          # 1000 — the node user
docker exec $C sh -c 'touch /app/x 2>/dev/null || echo READONLY-APP-OK'   # READONLY-APP-OK
docker exec $C sh -c 'ls /data'               # nightshift.db (+ -wal/-shm while running)
docker stop -t 12 $C && docker inspect -f '{{.State.ExitCode}}' $C   # 0 — graceful SIGTERM drain, WAL checkpoints
```

Expected: `healthy` within seconds, uid `1000`, `READONLY-APP-OK`, stop **ExitCode 0**.

## 3. CLI live legs against the real instance

The exit ladder (machine interface, `nightshift --help`):
``0 ok · 1 transport_error · 2 usage/config (nothing sent) · 3 API problem (`nightshift: <code>` on stderr)``.
In-container form: `docker exec -e NS_URL=http://127.0.0.1:3123 -e NS_TOKEN=… $C node bin/nightshift.mjs …`;
host form: `NS_URL=… NS_TOKEN=… node bin/nightshift.mjs …` (built `dist/`) or `pnpm cli …` (dev).

- [ ] `… next` → exit 0, one compact JSON line per ready task (empty output + 0 when none).
- [ ] `… claim <task-id>` → exit 0 with `{task_id, lease_token, generation}` — the lease
      rides STDOUT (the agent's own pipe), never argv (D-ff).
- [ ] `NS_LEASE_TOKEN=<lease> … heartbeat <task-id>` → exit 0 with the server Task
      DTO (`last_heartbeat_at` fresh). Absent lease ⇒ exit 2, nothing sent. A dead
      lease ⇒ exit 3, stderr line 1 `nightshift: stale_lease`. With enforcement
      enabled (both `NS_KEEPALIVE_*` set), a SILENT claim reverts to `todo` past the
      budget — audit action `lease_expired` — and the old lease then fences exit 3.
- [ ] `… report <task-id> --message "progress: wired the door"` → exit 0 with
      `{task_id, message_id}` (a `note` thread; `kind: question` is deliberately NOT
      exposed by the CLI — humans decide).
- [ ] `NS_LEASE_TOKEN=<claim's lease_token> … report <task-id> --status in_progress --reason "starting work"`
      → exit 0 with the server's Task DTO. A wrong lease ⇒ exit 3, stderr line 1
      `nightshift: stale_lease` — and if the command carried `--message`, the note HAS
      landed (honest partial state, D-aaa: no cross-request transaction).
- [ ] Race pin: two concurrent `… claim <same-id>` — exactly one exit 0; the loser exits 3,
      stderr line 1 exactly `nightshift: already_claimed`, line 2 the flat problem JSON
      with `holder_handle`.
- [ ] Search: NO operator step added here — the FTS5 live proof joined §1's automated probes
      in H (D-rrr): the smoke's 24th arm queries `GET /search?q=<stamp>` for the task it just
      created and requires it back (the CLI has no `search` command — D-ppp).

## 4. REAL Pocket ID (QUEUED HUMAN legs)

- [ ] Register the client in Pocket ID: redirect URI `{NS_PUBLIC_URL}/auth/callback`;
      confidential client ⇒ `client_secret_post` (present `NS_OIDC_CLIENT_SECRET` ⇒
      secret travels in the token-endpoint BODY only — D-ff/D-pp). Set `NS_OIDC_ISSUER`,
      `NS_OIDC_CLIENT_ID`, `NS_OIDC_CLIENT_SECRET`, `NS_PUBLIC_URL`, `NS_SESSION_KEY`
      (fail-closed matrix: issuer+client-id REQUIRE key+public-url — boot fails `invalid env`).
- [ ] **D-pp caveat — verbatim, read before wiring:**

  > Pocket-ID-ops note (QUEUED HUMAN): `INTERNAL_APP_URL`, when set on the IdP,
  > rewrites `jwks_uri`/`token_endpoint` to a host only reachable from the IdP's
  > network — the operator either leaves it unset or moves the RP closer to the IdP;
  > stated here so the morning operator is not surprised.

  The nightshift container must reach the PUBLIC URLs. Check from INSIDE the container:

```bash
docker exec $C node -e "fetch('https://idp.example/.well-known/openid-configuration',{signal:AbortSignal.timeout(5000)}).then(r=>r.json()).then(d=>console.log(d.jwks_uri, d.token_endpoint))"
# then reach BOTH printed hosts from the container (node -e fetch, exit 0 = reachable)
```

- [x] Browser login (RUN 2026-09-12 — local run, signed in against id.techtales.io as
      admin@techtales.io, landed on the board): open `{NS_PUBLIC_URL}/ui`, sign in through
      Pocket ID, land on the board (signed httpOnly session — same-origin browser +
      different-host IdP is the D-pp cookie-split posture the design already accounts for).
- [x] **Nonce-echo verify-once — TICKED 2026-09-12 (id.techtales.io)**: the browser login
      above succeeded and the RP's `verifyIdToken` requires a nonce byte-match, so Pocket ID
      echoes nonce. Instance-specific record (id.techtales.io), not a blanket claim.

  > `nonce` echo is Fosite-conformant but was NOT confirmed in Pocket ID's repo
  > (lib-1 flag 1): the stub asserts it, the RP requires it, and a verify-once against
  > the real instance is QUEUED (HUMAN).

  A SUCCESSFUL login IS the verification (the RP rejects a callback whose nonce does not
  byte-match) — TICKED: the browser login in the line above succeeded on 2026-09-12.

## 5. First-login allow-list round-trip

- [ ] With `oidc_provisioning` at its seeded default (`off`), attempt a browser login with
      an unlisted email ⇒ denied: `403`, detail `oidc identity not recognized (allow-list first)`,
      audit gains `login_denied` (`not allow-listed`). Confirm via `GET /audit`.
- [ ] As the bootstrap admin: `POST /admin/allowlist {"email":"you@example"}` (201) and
      `PUT /admin/policy/oidc_provisioning {"value":"allowlist"}` ⇒ retry the login ⇒
      session issued, a `member` human is provisioned (audit `human_provisioned`).
- [ ] Promote that human to admin. HONEST MECHANISM: the shipped REST surface has NO
      role-change op (D-ss — admins never arrive via provisioning; `role` is set only at
      actor creation). Operator surgery on a STOPPED container (never while running):

```bash
docker stop -t 12 $C
docker cp $C:/data/nightshift.db /tmp/ns-admin.db
for s in -wal -shm; do docker cp "$C:/data/nightshift.db$s" "/tmp/ns-admin.db$s" 2>/dev/null || true; done
node -e "const D=require('better-sqlite3'); const db=new D('/tmp/ns-admin.db'); db.prepare('update actors set role = ? where id = ?').run('admin', process.argv[1]); db.close()" <the-new-actor-id>
docker cp /tmp/ns-admin.db $C:/data/nightshift.db
for s in -wal -shm; do docker cp "/tmp/ns-admin.db$s" "$C:/data/nightshift.db$s" 2>/dev/null || true; done
rm -f /tmp/ns-admin.db*
docker start $C
```

- [ ] Verify the new admin can `GET /admin/actors` (200), THEN revoke the bootstrap
      credential: `POST /admin/tokens/tok_bootstrap/revoke` (204) **and remove
      `NS_BOOTSTRAP_TOKEN` from the deployment env too** — env-as-truth per boot
      re-arms the token on the next boot if the env stays (bootstrap.ts as-is).

## 6. FTS5 arms — the declared-not-pinned check, COPY ONLY (never the live file)

Plan C declared the `task_fts_ad` trigger + the in-migration rebuild's data-carry
NOT-PINNED (no app-level delete path exists) — this deploy-time job is its proof.
Run AFTER step 1 (the smoke created the matchable task on this volume). The container
must be STOPPED so the copy is not mid-WAL:

```bash
docker stop -t 12 $C
docker cp $C:/data/nightshift.db /tmp/ns-fts-copy.db
for s in -wal -shm; do docker cp "$C:/data/nightshift.db$s" "/tmp/ns-fts-copy.db$s" 2>/dev/null || true; done
node scripts/fts-probe.mjs /tmp/ns-fts-copy.db && rm -f /tmp/ns-fts-copy.db*
```

Expected exit 0, both machine lines (never reworded):
`PASS fts data-carry — N MATCH 'deploy-smoke' row(s), task t_…` and
`PASS fts delete-trigger — rowid N pruned (… → …, copy only)`.
The probe deletes ONLY inside the throwaway copy (it clears that task's own child rows
first — the smoke's note + attachment — because better-sqlite3 enforces FKs on the copy
connection; the arm under test is the trigger's prune). Any `FAIL fts …` line, exit 1,
is a finding for the PR record — do not delete the copy before capturing the line.

## 7. §14 live walkthrough — two humans (OPERATOR legs)

Step 1 already proved the AGENT-side spine on this instance (create/claim/lease/
release/status/note/attachment/event-feed/human-cancel). What only humans do here:

- [ ] 1. Both humans sign in via Pocket ID (step 4); a human admin creates the real
     Agent + token (step 3's forms apply to agent tokens).
- [ ] 2. Human files a task (+ attachment) → `todo`.
- [ ] 3. Two agent sessions race `claim` → step 3's race pin replays for real:
     one 200, one exit-3 `already_claimed`.
- [ ] 4. Winner posts its plan (`report --message`), splits the task into two children
     (`POST /tasks` with `parent_id`), releases, claims a child.
- [ ] 5. Agent question (thread `kind: question` — via the API/UI, not the CLI) ⇒ the
     review gate holds until a human answers the thread.
- [ ] 6. Agent links the PR (`--message`), moves `in_review`
     (`report --status in_review --reason …` under `NS_LEASE_TOKEN`); the other agent
     claims the sibling; both humans close:
     `PATCH /tasks/{id}/status {"status":"done","reason":"… shipped"}` —
     an AGENT close answers `agent_close_forbidden`; only humans close.
- [ ] 7. `GET /audit` reconstructs the whole story in order (task, claim, note, split,
     gate, review, closes) — the board shows rollups; zero hidden state.

## 8. Residue ledger + recording duty

Step 1 leaves residue BY DESIGN (audit-visible honesty, stated in the script header):

- one agent actor `deploy-smoke-<stamp>` — its token is REVOKED by the script;
- one CANCELED task `deploy-smoke <stamp>` + its note + its `smoke.txt` attachment;
- the audit spine of every step above (`login`-less: bearer traffic; the actions carry
  the story the §14-7 reconstruction needs).

- [ ] Recording duty: post in the PR/issue thread — date, image tag (+ digest), which
      steps ran with their exit codes, the verbatim tail lines
      (`deploy-smoke: ALL PASS`/`N FAIL`, both `PASS fts …` lines, the stop ExitCode),
      step 4's nonce verify-once tick, and the D-xx honesty split: what ran here vs what
      the operator ran at home.
