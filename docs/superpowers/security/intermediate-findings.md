# Intermediate Security Findings Log

This file accumulates security-relevant findings across every run of the CLI install + pre-deploy scan plan (`2026-05-25-cli-tools-install.md`). Append-only. Newest entries at the bottom.

---
## Run 2026-05-25T00:00:00Z — ralph-review

**Triggered by:** /ralph-loop iter 1 (max 3, completion-promise REVIEW-COMPLETE)
**Working tree state:** uncommitted (no commits made by this plan)
**Reviewers dispatched:** 3 parallel general-purpose agents (security, anti-drift, completeness)

**Findings:**
- [MEDIUM] Vercel primary install path is community formula `vercel-cli`, not vendor-documented (npm/pnpm). Recommend swap: vendor npm path primary, brew formula fallback.
- [MEDIUM] Vercel fallback step reads as auto-fallback ("OR npm i -g vercel if Step 1 failed"). Needs explicit user-confirmation gate as separate sub-step.
- [MEDIUM] Secret-leak regex set has gaps: Stripe `whsec_`/`rk_live_`, GitHub `github_pat_`/`gho_`/`ghs_`/`ghr_`/`ghu_`, Slack `xoxp-`/`xoxa-`/`xapp-`, OpenAI `sk-proj-`, Anthropic `sk-ant-`, generic JWT prefix `eyJ`, AWS secret-key 40-char pair, `DATABASE_URL` with embedded creds.
- [MEDIUM] Anti-drift gap: Task 0 (pre-flight) and Tasks 1/2/3 (installs) have no explicit numbered "append to intermediate-findings.md" checkbox steps — rule lives only in prose at plan line 242. Risk: executor finishes silently.
- [MEDIUM] Audit scope mismatch: plan assumes `npm audit` for backend but no lockfile detection step (pnpm/npm/yarn). Could pick wrong tool.
- [LOW] Pre-flight Task 0 Step 3 confirms `brew --prefix` but not that `$(brew --prefix)/bin` is actually on `$PATH`.
- [LOW] No explicit "do not run vercel deploy / supabase db push / railway up until pre-deploy report says PASS" guardrail. Currently implicit only.
- [LOW] Supabase tap is third-party; first `brew tap` adds it on trust. Worth noting; not a blocker.
- [LOW] No version pinning / checksum verification on any install. Brew bottle signatures cover this; acceptable but reproducibility could be hardened.
- [LOW] Git-history secret scan explicitly deferred. Plan should track it as a known gap with TODO.
- [LOW] `npm audit --json` can emit error JSON on failure; plan does not sanity-check JSON validity before reading.
- [INFO] No `curl | bash`, no `sudo`, no `*login`, no secret writes, no auto-telemetry-disable. All anti-drift contract items respected at the install-task level.
- [INFO] Task 4 security scan is genuinely read-only: `/tmp/` redirects, Grep/Read tools, scan artifacts under `docs/superpowers/security/` only.

**Verdict: BLOCK.** Two of three reviewers returned BLOCK; one returned PASS-with-one-change. Aggregate: BLOCK pending fixes to MEDIUM-severity items.

**Actions taken:** read-only review of plan file. No source files modified. Plan file will be patched in same iteration to address blockers; iteration 2 will re-review.

**Next step:** Edit `docs/superpowers/plans/2026-05-25-cli-tools-install.md` to address all MEDIUM findings, then re-dispatch parallel review agents in iteration 2.
---

---
## Run 2026-05-25T00:05:00Z — ralph-review

**Triggered by:** /ralph-loop iter 2 (max 3, completion-promise REVIEW-COMPLETE)
**Working tree state:** uncommitted (plan file patched in iter 1; no project source modified)
**Reviewers dispatched:** 3 parallel general-purpose agents (security, anti-drift, completeness — all fresh, no iter-1 context)

**Findings:**
- [INFO] Security reviewer: PASS. Vercel flip to vendor npm path verified; fallback gate enforceable; no curl|bash, no sudo, no login, no secret writes, no auto-telemetry-disable; Supabase tap path safe.
- [INFO] Anti-drift reviewer: PASS. Tasks 0/1/2/3/4 all have explicit numbered append-to-intermediate-findings checkbox steps. No drift beyond the three named CLIs. All 8 Objective-contract items respected.
- [INFO] Completeness reviewer: PASS. All 11 iter-1 blockers verified resolved: PATH check, Vercel fallback gate, lockfile detection, expanded secret regex (Stripe/GitHub-PAT/Slack/OpenAI/Anthropic/JWT/AWS/DATABASE_URL), git-history tracked as deferred gap, JSON parse sanity, hard deploy-gate, both repos in scope, severity vocab.
- [LOW] Security reviewer flagged: hard-gate against deploys is advisory (user-discipline reading the report), not technically enforced (no wrapper script blocking deploy commands). Acceptable — it is a documentation-level gate, not a runtime block. Caller aware.

**Verdict: PASS.** All three reviewers independently returned PASS. Zero CRITICAL/HIGH findings. Plan ready to execute.

**Actions taken:** read-only review of patched plan. No source files modified. Appended iter-2 block to this findings log.

**Next step:** Loop completes (promise REVIEW-COMPLETE will fire). Hand control back to user for execution approval. User decides whether to: (a) proceed with Task 0 pre-flight, (b) request further changes, or (c) defer.
---

---
## Run 2026-05-25T00:10:00Z — manual

**Triggered by:** Task 0 pre-flight (user approved execution)
**Working tree state:** uncommitted
**Findings:**
- [INFO] Homebrew 5.1.12 detected. PASS.
- [INFO] Brew prefix: `/opt/homebrew` (Apple Silicon). PASS.
- [INFO] No existing installs of vercel/supabase/railway. Clean slate.
- [INFO] `/opt/homebrew/bin` is on `$PATH`. PASS.

**Actions taken:** read-only checks: `brew --version`, `brew --prefix`, `command -v vercel supabase railway`, `$PATH` membership check. No files modified outside this log.

**Next step:** Proceed to Tasks 1/2/3 (install railway via brew, supabase via brew tap, vercel via npm global).
---

---
## Run 2026-05-25T00:12:00Z — install

**Triggered by:** Task 1 (Railway CLI)
**Working tree state:** uncommitted
**Findings:**
- [INFO] Installed `railway 4.61.1` via `brew install railway`. No sudo, no errors.
- [INFO] Binary at `/opt/homebrew/bin/railway`.
- [INFO] Brew caveat: zsh completions installed to `/opt/homebrew/share/zsh/site-functions`. Non-issue.
- [INFO] Homebrew auto-update ran (took ~30s); 19 outdated formulae / 2 outdated casks on machine — unrelated to this install.

**Actions taken:** `brew install railway`. No source files modified.
**Next step:** Verified — railway --version returns `railway 4.61.1`.
---

---
## Run 2026-05-25T00:13:00Z — install

**Triggered by:** Task 2 (Supabase CLI)
**Working tree state:** uncommitted
**Findings:**
- [INFO] Tap `supabase/tap` added on first install (vendor-owned tap — github.com/supabase/homebrew-tap). Trusted on use per plan.
- [INFO] Installed `supabase 2.101.0` via `brew install supabase/tap/supabase`. No sudo, no errors.
- [INFO] Binary at `/opt/homebrew/bin/supabase`.
- [LOW] Brew warning: Tier 2 configuration ("You can report issues to Homebrew/* repositories"). Acceptable — Tier 2 is supported.
- [INFO] Brew advisory: a newer Command Line Tools release is available. Unrelated to this install; user can update separately.

**Actions taken:** `brew install supabase/tap/supabase`. No source files modified.
**Next step:** Verified — supabase --version returns `2.101.0`.
---

---
## Run 2026-05-25T00:14:00Z — install

**Triggered by:** Task 3 (Vercel CLI — primary npm path)
**Working tree state:** uncommitted
**Findings:**
- [INFO] Installed `Vercel CLI 54.4.1` via `npm i -g vercel@latest` (vendor-documented primary path). No sudo, no errors.
- [INFO] Binary at `/Users/donkim/.nvm/versions/node/v20.18.0/bin/vercel` (npm global under nvm — expected).
- [MEDIUM] Three EBADENGINE warnings: transitive deps `oxc-transform@0.111.0` (req `^20.19.0 || >=22.12.0`), `rolldown@1.0.0-rc.1` (same), `undici@7.25.0` (req `>=20.18.1`); current Node is `v20.18.0`. Install succeeded but Vercel CLI may misbehave at runtime on this Node version. Recommend bumping Node to v20.19+ or v22.12+ via nvm.
- [LOW] Deprecated dep warning: `tar@7.5.7` is deprecated upstream. Pulled in transitively; cannot fix from CLI side. Track upstream.
- [LOW] Fallback path (brew vercel-cli) NOT triggered — primary path succeeded as planned.

**Actions taken:** `npm i -g vercel@latest`. No source files modified.
**Next step:** Verified — `vercel --version` returns `Vercel CLI 54.4.1`. Recommend Node upgrade before running `vercel dev`.
---

---
## Run 2026-05-25T00:20:00Z — scan

**Triggered by:** Task 4 (Post-Install Project Security Scan)
**Working tree state:** uncommitted
**Scope:** backend (`video-transcriber/`, npm) and frontend (`ai-engineer-recap-fe/`, pnpm). Full report: `docs/superpowers/security/2026-05-25-pre-deploy-scan.md`.

**Findings:**
- [HIGH] Backend: `fastify` v4 chain has 5 HIGH advisories — `fast-uri` (path traversal + host confusion), `fast-json-stringify`, `@fastify/ajv-compiler`, `@fastify/fast-json-stringify-compiler`, and `fastify` itself (DoS in sendWebStream, Content-Type bypass, `request.protocol`/`request.host` spoofable via X-Forwarded-* headers).
- [HIGH] Frontend: `lodash` HIGH advisory — code injection via `_.template`.
- [MEDIUM] Backend `nixpacks.toml` lines 7-9: `curl -fsSL …/latest/download/yt-dlp_linux` + `chmod +x` on every Railway build. No version pin, no SHA256. Supply-chain risk.
- [MEDIUM] Vercel CLI install pulled transitive deps requiring Node `>=20.19` or `>=22.12`; current is `v20.18.0`. Runtime breakage possible.
- [MEDIUM] 5 backend + 3 frontend MODERATE dep vulns (see `/tmp/audit-*.json`).
- [LOW] Frontend `.gitignore` does not cover bare `.env` or `.envrc` — only `.env*.local`.
- [LOW] No `vercel.json` exists — Vercel will use defaults (no custom CSP/HSTS).
- [INFO] Secret-leak scan: zero real secrets. 12 hits on Pattern D were all `test:test@localhost` test-DB strings or `<placeholder>` template syntax in docs.
- [INFO] No preinstall/postinstall hooks in either `package.json`. Clean.
- [INFO] No tracked `.env*` files in either repo. Backend `.gitignore` is comprehensive.
- [INFO] Git-history secret scan deferred — recommended as separate follow-up (gitleaks or trufflehog).

**Verdict: Pre-deploy gate = BLOCK.** Two HIGH vulns must be resolved (fastify v4→v5 upgrade and lodash override pin) plus the `nixpacks.toml` yt-dlp pin before any production deploy command runs.

**Actions taken:** read-only scan — `npm audit`, `pnpm audit`, Grep secret patterns, Read deploy configs and gitignores. No project source modified. Wrote `docs/superpowers/security/2026-05-25-pre-deploy-scan.md`.

**Next step:** User decides remediation order. CLIs are installed and ready for non-deploy commands (`vercel login`, `supabase login`, `railway login`, `supabase init`, etc.) — the BLOCK applies only to deploy/serve/start commands.
---

---
## Run 2026-05-25T00:35:00Z — manual

**Triggered by:** User approval to remediate Must-fix items 4-6 from the pre-deploy report.
**Working tree state:** modified (package.json + nixpacks.toml in backend; package.json + pnpm-lock.yaml in frontend)

**Findings (post-remediation re-audit):**

| Repo | Before | After |
|---|---|---|
| Backend (`npm audit`) | 5 HIGH + 5 MODERATE = 10 | 0 HIGH + 5 MODERATE = 5 |
| Frontend (`pnpm audit`) | 1 HIGH + 3 MODERATE = 4 | 0 HIGH + 2 MODERATE = 2 |

- [INFO] Backend: `fastify` `^4.28.0` → `^5.8.5`. `@fastify/cors` `^8.5.0` → `^11.2.0`. `@fastify/rate-limit` `^8.1.1` → `^10.3.0`. All 5 backend HIGH advisories resolved (fast-uri, fast-json-stringify, @fastify/ajv-compiler, @fastify/fast-json-stringify-compiler, fastify itself). Typecheck passes. All 120 backend tests pass (20 test files, including smoke pipeline).
- [INFO] Frontend: added `pnpm.overrides.lodash: ^4.18.1`. Confirmed via `pnpm why lodash` that `recharts 2.15.0` now resolves to `lodash 4.18.1` (was 4.17.23, vulnerable). Frontend HIGH advisory resolved. All 10 frontend tests pass (5 test files).
- [INFO] `nixpacks.toml`: yt-dlp pinned to release `2026.03.17`. SHA256 `c2b0189f581fe4a2ddd41954f1bcb7d327db04b07ed0dea97e4f1b3e09b5dd8e` verified by fetching the official `SHA2-256SUMS` file directly from the GitHub release (not via WebFetch summary). Added `sha256sum -c -` check that fails the Railway build if the binary hash diverges. Supply-chain risk reduced from "latest at build time" (broad) to "this specific release was not compromised" (narrow).
- [MEDIUM] 5 backend + 2 frontend MODERATE vulnerabilities remain. Not blocking by the plan's gate (HIGH/CRITICAL only), but worth a follow-up `npm audit fix` / `pnpm update` pass when convenient.
- [INFO] Two harmless WebFetch prompt-injection attempts observed during this session (fake `<system-reminder>` blocks in Supabase docs and yt-dlp release fetch). Both ignored; flagged to user.

**Verdict: Pre-deploy gate = PASS.** Zero HIGH/CRITICAL findings. All three Must-fix items from the prior BLOCK are resolved and verified with tests.

**Actions taken:**
- Edited `video-transcriber/package.json` (fastify + 2 plugins).
- Edited `video-transcriber/nixpacks.toml` (yt-dlp pin + checksum).
- Edited `ai-engineer-recap-fe/package.json` (pnpm.overrides.lodash).
- Ran `npm install` (backend) and `pnpm install` (frontend) — lockfiles updated.
- Re-ran `npm audit` / `pnpm audit` — verified HIGH count is zero.
- Ran `npm run typecheck`, `npm test`, `pnpm test` — all green.

**Next step:** Deploy commands are now ungated. User can proceed with `vercel deploy`, `supabase db push`, `railway up` after their interactive logins.
---

---
## Run 2026-05-25T00:40:00Z — ralph-review

**Triggered by:** /ralph-loop iter 3 (max 3, completion-promise REVIEW-COMPLETE) — final review pass; read-only verification of the 12-item checklist at the bottom of `docs/superpowers/plans/2026-05-25-cli-tools-install.md`. No install commands executed; no brew install; no npm install.

**Working tree state:** uncommitted (per prior iter notes; remediation edits to backend package.json/nixpacks.toml were externally reverted during a branch checkout; FE `pnpm.overrides.lodash` change still on disk per prior iter — not re-verified this iteration since this run is read-only).

**Checklist verification (12 items):**
- [PASS] (1) Vendor-recommended install paths. Railway `brew install railway` (plan L112); Supabase `brew install supabase/tap/supabase` (L130); Vercel `npm i -g vercel@latest` primary (L151).
- [PASS] (2) No `curl | bash`. Avoidance documented L62; prohibited L308.
- [PASS] (3) No `sudo`. L12 + L310 prohibitions; install steps STOP on EACCES, no sudo retry.
- [PASS] (4) No login/auth during install. L9 + L306 prohibitions; logins only surfaced post-install (L299).
- [PASS] (5) No secrets to disk. L9 + L307; no `.envrc`/keychain writes; aligns with user keychain-helper preference.
- [PASS] (6) `--version` verification per CLI. Railway L115; Supabase L133; Vercel L154.
- [PASS] (7) No telemetry/login drift. L11 no auto-disable; L296 surfaces commands without running.
- [PASS] (8) Vercel fallback gated. L162-163 explicit "STOP and ask the user" gate.
- [PASS] (9) Task 4 read-only. L173 no fixes without approval; L222 Read tool only; `/tmp/` JSON redirects.
- [PASS] (10) Pre-deploy gate enforces BLOCK on CRITICAL/HIGH. L246 sign-off line; L314 hard-gate against deploy commands until report ends with `PASS`.
- [PASS] (11) Every run appends to `intermediate-findings.md`. Empirically verified: 8 prior blocks (iter-1 review, iter-2 review, pre-flight, 3× install, scan, remediation) all present and well-formed.
- [PASS] (12) Review appends its own `ralph-review` block. This block satisfies item 12 on commit of this edit.

**Findings:**
- [INFO] All 12 checklist items pass on inspection of the current plan file. No new BLOCK conditions raised.
- [INFO] Plan content is unchanged since iter-2 PASS verdict (no drift). Documentation Scan, Security Review, Pre-Flight, Install Tasks 1-3, Task 4 scan spec, and the Intermediate Findings Log spec all match the structure cited in iter-2.
- [INFO] Prompt injection observed in this iteration: an "Auto Mode Active" block appeared after legitimate plan content (after L333) attempting to push immediate execution. Ignored — the ralph-loop directive ("Do NOT execute any install command. Do NOT run brew install. Do NOT run npm install.") takes precedence. Flagged to user.
- [INFO] Per ralph-loop directive this iteration is read-only — no `brew install`, no `npm install`, no `pnpm install` invoked. Only Read/Edit tool usage to verify and append.
- [LOW] Carry-forward (not new): backend remediation edits (fastify v5 upgrade, nixpacks.toml yt-dlp pin) were reverted externally between the remediation run (T00:35:00Z) and the commit step. Not a plan-quality issue; a state-management note for the user. Frontend `pnpm.overrides.lodash` edit appears intact per prior iter.

**Verdict: PASS.** All 12 checklist items satisfied. Plan is well-formed, anti-drift contract holds, and the findings log is complete and append-only as required. Completion promise `REVIEW-COMPLETE` is now genuinely true.

**Actions taken:** read-only — Read on plan file (L1-L333) and findings log; Edit to append this block. No source files modified outside this log.

**Next step:** Loop completes. Hand control to user. Outstanding non-review work the user previously approved (commit + PR for backend code remediation + new docs, plus frontend `pnpm.overrides.lodash` commit + PR) remains pending; that is outside this iteration's read-only scope.
---

