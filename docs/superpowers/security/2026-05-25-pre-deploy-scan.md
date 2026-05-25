# Pre-Deploy Security Scan — 2026-05-25

**Scanner:** Claude Code session (Opus 4.7), tools: Read, Glob, Grep, Bash (`npm audit`, `pnpm audit`, `node`).
**Repos scanned:**
- Backend: `/Users/donkim/Code/video-transcriber/video-transcriber/` (npm, package-lock.json)
- Frontend: `/Users/donkim/Code/video-transcriber/ai-engineer-recap-fe/` (pnpm, pnpm-lock.yaml)

## Summary

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 7 |
| MEDIUM | 9 |
| LOW | 2 |
| INFO | many (placeholders, doc strings) |

---

## Step 1 — Backend dependency audit (`npm audit`)

10 vulnerabilities (0 critical, 5 high, 5 moderate, 0 low):

| Package | Severity | Issue |
|---|---|---|
| `fast-uri` | HIGH | Path traversal via percent-encoded dot segments; host confusion via percent-encoded authority delimiters |
| `fast-json-stringify` | HIGH | Depends on vulnerable `fast-uri` |
| `@fastify/ajv-compiler` | HIGH | Depends on vulnerable `fast-uri` |
| `@fastify/fast-json-stringify-compiler` | HIGH | Depends on vulnerable `fast-json-stringify` |
| `fastify` | HIGH | DoS via unbounded memory in `sendWebStream`; Content-Type header tab char body-validation bypass; `request.protocol`/`request.host` spoofable via `X-Forwarded-Proto`/`X-Forwarded-Host` from untrusted connections |
| (5 moderate) | MEDIUM | Transitive — see `/tmp/audit-be.json` |

**Recommended remediation:** Upgrade `fastify` to v5 (`fastify@^5`) — fixes the entire chain. Current pin in `package.json` line 21: `"fastify": "^4.28.0"`. Note: v5 is a major and may require code changes (esp. around `request.protocol`/`request.host` handling and content-type parsing).

## Step 2 — Frontend dependency audit (`pnpm audit`)

4 vulnerabilities (0 critical, 1 high, 3 moderate, 0 low):

| Package | Severity | Issue |
|---|---|---|
| `lodash` | HIGH | Code injection via `_.template` import key names |
| (3 moderate) | MEDIUM | See `/tmp/audit-fe.json` |

**Recommended remediation:** `lodash` is transitive (Next.js/Radix ecosystem). Run `pnpm why lodash` to find the importer; if `_.template` is not used downstream, exposure is theoretical but the advisory still blocks the gate. Override via `pnpm.overrides` to pin lodash to a fixed version (≥4.17.21 is needed; check advisory for exact fixed range).

## Step 3 — Secret-leak scan

All patterns (A-E) ran across both repos, excluding `node_modules`, `.git`, `dist`, `.next`, `build`, `coverage`.

- Pattern A (API key prefixes — Stripe/GitHub/Slack/OpenAI/Anthropic/Google/AWS/JWT): **0 hits.** PASS.
- Pattern B (PEM private keys): **0 hits.** PASS.
- Pattern C (deploy-token env assignments): **0 hits.** PASS.
- Pattern D (DB URLs with embedded creds): **12 hits — ALL INFO-severity.** Every match is either:
  - `postgres://test:test@localhost:54329/test` (local test DB, intentional placeholder), or
  - `<project-ref>` / `[YOUR-PASSWORD]` style template placeholders in docs.
  No real credentials. PASS.
- Pattern E (AWS secret-key pair, contextual): skipped — no `AKIA` matches in Pattern A. PASS.

**Verdict for Step 3:** No real secret leaks in tracked files.

## Step 4 — Deployment-config review

- **`vercel.json`:** does not exist in either repo. INFO — Vercel will use platform defaults (no custom CSP, HSTS, or routing rules). Recommend adding once frontend deploys are live.
- **`supabase/config.toml`:** does not exist. INFO — Supabase project not yet initialized locally (`supabase init` would create it).
- **`railway.toml`** (backend, lines 1-15): clean. No secrets. Defines two services (`api`, `worker`) with sane health-check + restart policy. PASS.
- **`nixpacks.toml`** (backend, lines 1-17): ⚠️ **MEDIUM finding.**
  - Line 7-9: `curl -fsSL -o /app/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux` followed by `chmod +x`.
  - **Issue:** unpinned `latest` tag, no SHA256 checksum verification. Every Railway build pulls whatever the latest yt-dlp release happens to be, then executes it inside the app container. If the yt-dlp release pipeline were compromised, malicious binary runs in production.
  - **Recommended remediation:** pin a specific yt-dlp version (e.g. `…/download/2025.04.30/yt-dlp_linux`) and verify SHA256 against a known hash from the GitHub release notes.
- **`.env.example` (backend):** clean — placeholder names only, no values. PASS.
- **`.env.example` (frontend):** clean — single `NEXT_PUBLIC_API_URL=http://localhost:3000` line. PASS.

## Step 5 — Project posture

- **`package.json` scripts (backend):** no `preinstall` or `postinstall`. PASS.
- **`package.json` scripts (frontend):** no `preinstall` or `postinstall`. PASS.
- **Tracked `.env*` files (excluded from gitignore):** none found in either repo. PASS.
- **Backend `.gitignore`:** covers `.env`, `.env.local`, `.envrc`, `node_modules/`, `dist/`. PASS.
- **Frontend `.gitignore`:** covers `.env*.local`, `node_modules`, `.next/`. **LOW finding:** does NOT explicitly cover bare `.env` or `.envrc`. If someone adds a non-`.local` env file or direnv file, it would be tracked. Recommend adding `.env` and `.envrc` to frontend `.gitignore`.
- **EBADENGINE warning from `npm i -g vercel@latest`** (recorded during Task 3 install): three transitive deps (`oxc-transform`, `rolldown`, `undici`) want Node `^20.19.0 || >=22.12.0`. Current Node is `v20.18.0` (under nvm). **MEDIUM:** runtime may break. Recommend `nvm install 22 && nvm alias default 22` before running `vercel dev`.

## Step 5b — Known gaps (NOT executed by this scan)

- **INFO — Git-history secret scan deferred.** A leaked secret in history is still leaked even if removed from working tree. Recommend a follow-up run of `gitleaks detect --source . --no-banner` or `trufflehog git file://.` on each repo.
- **INFO — No SBOM / license review** in scope.
- **INFO — No dynamic / runtime / DAST analysis** in scope.

---

## Pre-deploy gate: **BLOCK**

Hard-gate condition triggered: 6 HIGH-severity dependency vulnerabilities (5 backend, 1 frontend) plus one MEDIUM-severity supply-chain issue in `nixpacks.toml`.

**Do not run** `vercel deploy`, `vercel --prod`, `supabase db push`, `supabase deploy`, `railway up`, or `railway run` against production until the BLOCK conditions below are resolved (or explicitly waived by the user in `intermediate-findings.md`).

### Must-fix before deploy

1. **HIGH** — Upgrade backend `fastify` to v5. Fixes 5 of the 6 high advisories.
2. **HIGH** — Resolve frontend `lodash` advisory via `pnpm.overrides` pin to fixed version.
3. **MEDIUM** — Pin yt-dlp version + add SHA256 verification in `nixpacks.toml`.

### Recommended but non-blocking

4. **MEDIUM** — Bump local Node to v22 to satisfy Vercel transitive deps.
5. **LOW** — Add `.env` and `.envrc` to frontend `.gitignore`.
6. **INFO** — Create `vercel.json` with explicit CSP/HSTS headers before first prod deploy.
7. **INFO** — Run a git-history secret scan (gitleaks/trufflehog) as a separate task.
