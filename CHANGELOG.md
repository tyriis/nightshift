# Changelog

All notable changes to nightshift are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

**Version / tag / digest mapping (locked at `v0.1.0`):** the `package.json`
`version`, the annotated git tag `v0.1.0`, and the container image tag
`v0.1.0` are the same number. Home-ops pins the image by its `@sha256:`
digest (see `deploy/README.md` for the pull-and-run surface). Pre-releases,
if any, use `v0.1.0-rc.N`.

## v0.1.0 — 2026-09-11 (first public beta)

### Added

- Self-hosted task board where humans and AI agents are first-class actors
  (spec: `docs/superpowers/specs/2026-09-05-nightshift-design.md`).
- Agent REST API + MCP server with bearer-token actors; 401 fail-closed
  (`src/server/`).
- Tasks, questions, thread notes, and attachments (Plans A–B, D).
- Ascending-cursor events feed (`/events`) + webhooks (Plan C).
- OIDC login via Pocket ID with a fail-closed matrix, and the SvelteKit
  static SPA board (Plan E).
- Single production Docker image, non-root, `/data` volume, `HEALTHCHECK`
  (Plan F); operator deploy surface documented in `deploy/README.md`.
- Brotli + keepalive shell fixes (Plan G) and the §12 keepalive carry-overs
  plus the FTS5 live `search` slice (Plan H).
- Repo CLI (`bin/nightshift.mjs`) over the same REST surface.
- Gates as shipped evidence: `vitest run` 703 tests / 90 files; coverage
  floors enforced via `pnpm test:coverage`; live deploy-smoke bar
  **24 PASS / 0 FAIL** (`scripts/deploy-smoke.mjs`, records in
  `deploy/DEPLOY-SMOKE.md`).

### Known gaps (honest, as of this beta)

- No npm package — **dropped by decision**, not deferred: nightshift ships
  as the GHCR image + git repo.
- Playwright e2e (`pnpm test:e2e`) runs locally only; the CI e2e job is
  post-beta (browser install is a HUMAN step).
- GitHub Actions refs are tag-pinned (`@v4`), not SHA-pinned; no dependency
  automation (Renovate/Dependabot) yet.
- `SECURITY.md`, `CONTRIBUTING.md`, CODEOWNERS, and issue/PR templates are
  absent — docs polish stays behind the beta cut.
- The §14 operator acceptance walkthrough against a real deployed instance
  is the beta's own acceptance run (QUEUED, HUMAN): home-ops HelmRelease,
  registry digest pin, real Pocket ID credentials.
