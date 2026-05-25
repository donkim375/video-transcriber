# CLI Tools Installation Plan (Vercel, Supabase, Railway)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans`. This plan is review-gated — `/ralph-loop` will dispatch parallel review agents before any install command runs.

**Goal:** Install Vercel CLI, Supabase CLI, and Railway CLI on this macOS machine using the safest documented install paths, with no token writes or login flow triggered as part of installation.

**Objective (anti-drift contract):**
1. Install ONLY the three named CLIs.
2. Do NOT run `*login`, do NOT export tokens, do NOT modify `.envrc`, do NOT touch `~/.zshrc`/`~/.bash_profile`.
3. Do NOT install global npm packages where the vendor explicitly discourages it (Supabase).
4. Do NOT auto-disable telemetry without asking — surface the option, let the user decide.
5. Do NOT use `sudo` for any install command. If a permissions error appears, stop and report.
6. Verify each install with `--version` only. No further commands.
7. After installs complete, run a **read-only security scan of the project codebase** before the user runs any deploy/serve/start command using the new CLIs. No remediation without approval.
8. **Every run (install run, scan run, /ralph-loop iteration) appends a timestamped entry to a single intermediate findings file** so nothing gets lost between iterations or sessions.

**Architecture:** Use Homebrew as the single install channel for all three CLIs. Homebrew is already the canonical macOS package manager on this machine, keeps binaries out of `node_modules`/`/usr/local` directly, gives one upgrade path (`brew upgrade`), and avoids the Supabase "no global npm" restriction.

**Tech Stack:** Homebrew (macOS), zsh, no Node.js global installs required.

---

## Documentation Scan Summary

### Vercel CLI (`https://vercel.com/docs/cli`)
- **Install:** `pnpm i vercel` / `npm i vercel` / `yarn i vercel` / `bun i vercel` (project-local). Experimental: `pnpm i -g @vercel/vc-native --force` for native binary.
- **Auth:** `vercel login` interactive. CI uses `VERCEL_TOKEN` env var (preferred over `--token` flag to avoid exposure in process lists).
- **Verify:** `vercel --version`.
- **Telemetry:** Enabled by default. Toggle: `vercel telemetry disable`.
- **Notes:** Vendor docs do not list a Homebrew tap. Homebrew has a third-party formula `vercel-cli` (community-maintained). The vendor-official path is npm-based.

### Supabase CLI (`https://supabase.com/docs/guides/local-development/cli/getting-started`)
- **Install (recommended):** `brew install supabase/tap/supabase`. Beta: `brew install supabase/tap/supabase-beta`.
- **Local dev dep alternative:** `npm install supabase --save-dev` or `npx supabase --help`.
- **EXPLICITLY UNSUPPORTED:** `npm install -g supabase` — vendor says do not do this.
- **Auth:** Not documented in this page (local dev focus). Local keys auto-generated on `supabase start`.
- **Telemetry:** Enabled by default. Disable via `SUPABASE_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`.
- **Verify:** `supabase --version` (inferred — page only shows `npx supabase --help`).
- **Notes:** Requires Docker Desktop for `supabase start`. Install does NOT require Docker; only runtime does.

### Railway CLI (`https://docs.railway.com/cli`)
- **Install:** `brew install railway` OR `npm i -g @railway/cli` (Node 16+) OR `bash <(curl -fsSL railway.com/install.sh) --agents -y`.
- **Auth:** `railway login` (or `--browserless`).
- **Tokens:** `RAILWAY_TOKEN` (project), `RAILWAY_API_TOKEN` (workspace) for CI.
- **Verify:** `railway --version`.
- **Telemetry/security:** Not documented on the install page.

---

## Security Review of Documentation

| Concern | Vercel | Supabase | Railway |
|---|---|---|---|
| Vendor-signed install? | npm registry (signed) | Homebrew tap (vendor-owned) | Homebrew (community) / npm / curl-pipe-bash |
| Curl-pipe-bash documented? | No | No | **YES — risky if used** |
| Sudo required? | No | No (Linux only) | No |
| Telemetry default ON? | Yes | Yes | Unspecified (assume yes) |
| Secrets touch install? | No | No | No |
| Login required to install? | No | No | No |

**Findings:**
1. **Railway curl-pipe-bash install is the highest-risk path** — avoid it. Use `brew install railway`.
2. **Supabase npm global is vendor-blocked** — must use brew.
3. **No install step requires tokens or secrets**, so this plan does NOT touch `.envrc` or keychain (aligns with user's "minimize secret exposure window" preference from memory).
4. **No sudo anywhere.** If `brew` prompts for sudo, stop — Homebrew should never need it on a normal user install.
5. **Telemetry decisions are deferred** to the user — we surface the toggle commands but do not run them.

---

## File / State Changes Expected

- Create: none (no project file edits required)
- Modify: none
- System state: 3 new binaries installed under `$(brew --prefix)/bin/` (e.g. `/opt/homebrew/bin/vercel`, `/opt/homebrew/bin/supabase`, `/opt/homebrew/bin/railway`)
- New Homebrew tap: `supabase/tap` (added implicitly by the supabase install)

---

## Pre-Flight Tasks (run before /ralph-loop)

### Task 0: Verify environment

- [ ] **Step 1:** Confirm Homebrew is installed and on PATH.
  Run: `brew --version`
  Expected: prints `Homebrew X.Y.Z`. If missing → STOP, ask user.

- [ ] **Step 2:** Confirm none of the three CLIs are already installed.
  Run: `command -v vercel supabase railway || true`
  Expected: empty output, or list of already-installed paths. If installed → STOP, ask user whether to upgrade or skip.

- [ ] **Step 3:** Confirm Homebrew shellenv is sane.
  Run: `brew --prefix`
  Expected: `/opt/homebrew` (Apple Silicon) or `/usr/local` (Intel).

- [ ] **Step 4:** Confirm `$(brew --prefix)/bin` is on `$PATH`.
  Run: `echo "$PATH" | tr ':' '\n' | grep -Fx "$(brew --prefix)/bin"`
  Expected: prints the brew bin path. If empty → STOP, ask user to fix shell init.

- [ ] **Step 5: Append pre-flight block to intermediate-findings.md.**
  Use Write/Edit tools to append a `manual` run block with: pre-flight results, brew version, brew prefix, detected existing CLIs (if any), PATH check result. If `intermediate-findings.md` does not exist, create it with the header from the "Intermediate Findings Log" section first.

---

## Install Tasks (executed only after /ralph-loop approval)

### Task 1: Install Railway CLI

**Files:** none — system install only.

- [ ] **Step 1:** Install via Homebrew (the safe path — NOT the curl|bash path documented).
  Run: `brew install railway`
  Expected: completion with no errors, no sudo prompts.

- [ ] **Step 2:** Verify install.
  Run: `railway --version`
  Expected: prints a version string (e.g. `railwayapp 3.x.x`).

- [ ] **Step 3:** Confirm binary location.
  Run: `command -v railway`
  Expected: `$(brew --prefix)/bin/railway`.

- [ ] **Step 4: Append `install` block to intermediate-findings.md.**
  Record: CLI name (railway), installed version (from Step 2), binary path (from Step 3), any warnings printed by brew (deprecated formula, caveats, post-install messages), telemetry status notice if any.

### Task 2: Install Supabase CLI

**Files:** none — system install only.

- [ ] **Step 1:** Install via the vendor-recommended tap.
  Run: `brew install supabase/tap/supabase`
  Expected: tap is added (`supabase/tap`), formula installed, no sudo, no errors.

- [ ] **Step 2:** Verify install.
  Run: `supabase --version`
  Expected: prints a version string.

- [ ] **Step 3:** Confirm binary location.
  Run: `command -v supabase`
  Expected: `$(brew --prefix)/bin/supabase`.

- [ ] **Step 4: Append `install` block to intermediate-findings.md.**
  Record: CLI name (supabase), installed version, binary path, any brew caveats (notably: tap added on first install, Docker Desktop requirement for runtime), telemetry default-on notice.

### Task 3: Install Vercel CLI

**Files:** none — system install only.

**Primary path: vendor-documented npm global install.** Vercel docs (vercel.com/docs/cli) list only npm/pnpm/yarn/bun as supported install channels. The community Homebrew formula `vercel-cli` is acceptable as a FALLBACK only, and only after explicit user confirmation.

- [ ] **Step 1: Install via vendor-supported npm global.**
  Run: `npm i -g vercel@latest`
  Expected: completion with no errors, no sudo prompts. If EACCES error → STOP, do NOT retry with sudo, report to user.

- [ ] **Step 2: Verify install.**
  Run: `vercel --version`
  Expected: prints a version string.

- [ ] **Step 3: Confirm binary location.**
  Run: `command -v vercel`
  Expected: an npm global path (e.g. `/opt/homebrew/bin/vercel` if brew-managed Node, or `~/.nvm/.../bin/vercel`).

- [ ] **Step 4 (fallback, gated): Only if Step 1 failed with a non-EACCES error.**
  STOP and ask the user before proceeding. Show the user: "Step 1 failed with <error>. The community-maintained Homebrew formula `vercel-cli` exists as an alternative, but it is NOT vendor-documented. Proceed with `brew install vercel-cli`?" Only on explicit "yes" → run `brew info vercel-cli` to confirm formula exists, then `brew install vercel-cli`. Then re-run Steps 2 and 3.

- [ ] **Step 5: Append `install` block to intermediate-findings.md.**
  Record: CLI name (vercel), installed version, binary path, install channel used (npm-global vs fallback brew formula), any deprecation/warning notices.

---

### Task 4: Post-Install Project Security Scan (READ-ONLY)

**Why this is in scope:** These CLIs deploy code to live infrastructure (Vercel edge, Supabase DB/auth, Railway services). Before the user runs `vercel deploy`, `supabase db push`, or `railway up`, the project should be scanned for issues that would otherwise ship to production. This scan is **read-only** — no fixes applied without explicit approval.

**Scan surface (both repos in this workspace):**
- `/Users/donkim/Code/video-transcriber/video-transcriber/` (backend)
- `/Users/donkim/Code/video-transcriber/ai-engineer-recap-fe/` (frontend)

**Files:**
- Create: `docs/superpowers/security/2026-05-25-pre-deploy-scan.md` (the findings report)
- Append: `docs/superpowers/security/intermediate-findings.md` (running log — see "Intermediate Findings Log" section below)

- [ ] **Step 0: Detect lockfile per repo (must run before audit).**
  For EACH of `/Users/donkim/Code/video-transcriber/video-transcriber/` and `/Users/donkim/Code/video-transcriber/ai-engineer-recap-fe/`:
  - If `pnpm-lock.yaml` exists → use `pnpm audit --json`.
  - Else if `yarn.lock` exists → use `yarn npm audit --json` (yarn v2+) or `yarn audit --json` (v1).
  - Else if `package-lock.json` exists → use `npm audit --json`.
  - Else → SKIP this repo's audit and record an INFO finding "no lockfile detected".

- [ ] **Step 1: Dependency vulnerability scan (backend)**
  Run the audit command chosen in Step 0 against `/Users/donkim/Code/video-transcriber/video-transcriber/`, redirect JSON to `/tmp/audit-be.json`. Verify JSON parses (first char `{`); if not, record an error finding and continue.

- [ ] **Step 2: Dependency vulnerability scan (frontend)**
  Run the audit command chosen in Step 0 against `/Users/donkim/Code/video-transcriber/ai-engineer-recap-fe/`, redirect JSON to `/tmp/audit-fe.json`. Verify JSON parses.

- [ ] **Step 3: Secret-leak scan (regex sweep, tracked files only)**
  Run (via Grep tool, NOT git-history scan — see Step 5b for the deferred git-history follow-up):

  **API key prefixes (Pattern A):**
  - Stripe: `(sk_live_|sk_test_|rk_live_|rk_test_|pk_live_|whsec_)[A-Za-z0-9]{16,}`
  - GitHub: `(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}`
  - Slack: `xox[baprs]-[A-Za-z0-9-]{10,}` covers `xoxb`, `xoxa`, `xoxp`, `xoxr`, `xoxs`; plus `xapp-[0-9]+-[A-Za-z0-9-]+`
  - OpenAI: `sk-(proj-)?[A-Za-z0-9_-]{20,}`
  - Anthropic: `sk-ant-[A-Za-z0-9_-]{20,}`
  - Google API: `AIza[0-9A-Za-z\-_]{35}`
  - AWS access key: `AKIA[0-9A-Z]{16}`
  - JWT-shaped: `eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`

  **Private keys (Pattern B):** `-----BEGIN (RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----`

  **Deploy-token assignments (Pattern C):** `(SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ANON_KEY|SUPABASE_JWT_SECRET|VERCEL_TOKEN|RAILWAY_TOKEN|RAILWAY_API_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|ASSEMBLYAI_API_KEY|GOOGLE_API_KEY|AWS_SECRET_ACCESS_KEY)\s*=\s*['\"]?[A-Za-z0-9_\-\.]{20,}`

  **DB URLs with embedded creds (Pattern D):** `(postgres|postgresql|mysql|mongodb|redis)://[^:@\s]+:[^@\s]+@`

  **AWS secret-key pair (Pattern E, contextual):** if Pattern A matched `AKIA…`, also grep the same file for `[A-Za-z0-9/+=]{40}` near `AWS_SECRET` / `secret_access_key`.

  Scope: exclude `node_modules/`, `.git/`, `dist/`, `.next/`, `build/`, `coverage/`, `*.lock`, `pnpm-lock.yaml`.

  Expected: zero hits in tracked files. Any hit in tracked-but-non-`.env*` files → CRITICAL. Hit in `.env.example` whose value is clearly a placeholder (e.g. `your-key-here`, all-zeros, `xxx`) → INFO. Any other hit → record, STOP, escalate to user before continuing.

- [ ] **Step 4: Deployment-config review**
  Read and review (via Read tool — no edits):
  - `vercel.json` (if exists) — check for `headers` (CSP, HSTS), `redirects`, exposed `env` keys
  - `supabase/config.toml` (if exists) — check `[auth]` settings, RLS-relevant flags
  - Railway config: `railway.json` / `railway.toml` / `nixpacks.toml` (if exists) — check exposed envs and start commands
  - `.env.example` files — confirm only placeholders, no real values
  Expected: no production secrets, no `*` CORS, no disabled auth/RLS.

- [ ] **Step 5: Project posture checks**
  - Read `package.json` `scripts` in both repos — flag any `postinstall`/`preinstall` that fetches remote code.
  - Glob for `.env*` files NOT in `.gitignore` (i.e. accidentally trackable).
  - Check that `.gitignore` covers `.env`, `.env.local`, `.env.*.local`, `.envrc`, `node_modules/`.
  Expected: clean.

- [ ] **Step 5b: Track known gaps (no execution).**
  Record in the findings report as INFO-severity follow-ups (NOT executed by this plan):
  - **Git-history secret scan deferred.** A leaked secret in history is still leaked. Recommend running `gitleaks detect --source . --no-banner` or `trufflehog git file://.` as a separate, user-approved task.
  - **No SBOM / license review.** Not part of this plan.
  - **No dynamic / runtime analysis.** Static only.

- [ ] **Step 6: Write the pre-deploy findings report**
  Write to `docs/superpowers/security/2026-05-25-pre-deploy-scan.md`:
  - Header: scan date, scanner version (Claude session + tools used), repos scanned.
  - One section per step above. Each finding: severity (critical/high/medium/low/info), file:line, evidence, recommended action.
  - Summary table at top: counts by severity.
  - Sign-off line: "Pre-deploy gate: PASS / BLOCK" — BLOCK if any critical/high finding.

- [ ] **Step 7: Append to intermediate findings log** (see section below)

---

## Intermediate Findings Log (every run writes here)

**File:** `docs/superpowers/security/intermediate-findings.md`

**Rule:** Every run of this plan — every install task, every scan task, and every `/ralph-loop` review iteration — APPENDS one block to this file. Never overwrites. This is the audit trail.

**Block format (append at end of file, oldest-first ordering):**

```markdown
---
## Run YYYY-MM-DDTHH:MM:SSZ — <run-kind>
<run-kind> ∈ { install | scan | ralph-review | manual }

**Triggered by:** <what kicked it off — e.g. "Task 1 step 2", "/ralph-loop iter 3", "user request">
**Working tree state:** <git rev-parse HEAD short SHA, or "uncommitted">
**Findings:**
- [SEV] <file:line or system area> — <one-line description>
- [SEV] ...
(or "None" if clean)

**Actions taken:** <commands run, files written — or "read-only, no changes">
**Next step:** <what unblocks the next iteration, or "ready for user review">
---
```

**Severity vocabulary:** `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `INFO`. CRITICAL/HIGH block downstream tasks until resolved or explicitly waived by the user.

**First-run setup:** If `intermediate-findings.md` does not exist when a task tries to append, create it with this header block first:

```markdown
# Intermediate Security Findings Log

This file accumulates security-relevant findings across every run of the CLI install + pre-deploy scan plan (`2026-05-25-cli-tools-install.md`). Append-only. Newest entries at the bottom.

```

- [ ] **Hook into every install task:** Tasks 1, 2, 3 each end with: "Append a `install` block to `intermediate-findings.md` recording: which CLI, version installed, binary path, any warnings from brew/npm output (e.g. deprecated formula, post-install messages, telemetry notices)."
- [ ] **Hook into scan task:** Task 4 Step 7 appends a `scan` block summarizing what Steps 1–5 found.
- [ ] **Hook into /ralph-loop:** Each review iteration appends a `ralph-review` block with the agent's findings.

---

## Post-Install (reported, not auto-executed)

After installs complete, surface to the user:
- Telemetry-disable commands they may want to run:
  - `vercel telemetry disable`
  - `export SUPABASE_TELEMETRY_DISABLED=1` (or add to shell profile — user's call)
- Login commands they will need later — but do NOT run them now:
  - `vercel login`, `supabase login`, `railway login`

---

## What This Plan Will NOT Do (anti-drift guardrails)

- Will NOT run any `*login` command.
- Will NOT write to `.envrc`, `~/.zshrc`, `~/.bash_profile`, keychain, or any token store.
- Will NOT install via `curl | bash` (Railway).
- Will NOT install Supabase via `npm install -g` (vendor-blocked).
- Will NOT use `sudo` anywhere.
- Will NOT call out to non-vendor domains beyond `brew`'s configured taps.
- Will NOT install Docker Desktop (Supabase runtime dep — separate decision).
- Will NOT modify any project files.
- Will NOT run `vercel deploy`, `supabase db push`, `supabase start`, `railway up`, `railway run`, or any other deploy/serve/start command. **Hard gate:** the user must not run those commands until `docs/superpowers/security/2026-05-25-pre-deploy-scan.md` ends with the line `Pre-deploy gate: PASS`. If it ends with `BLOCK`, the user must resolve the listed findings (or explicitly waive them in the findings log) before deploying.

---

## /ralph-loop Review Checklist

When `/ralph-loop` dispatches review agents, each agent should verify:

1. ✅ All install commands use vendor-recommended paths.
2. ✅ No `curl | bash` patterns survived into the plan.
3. ✅ No `sudo` survived into the plan.
4. ✅ No login/auth flow triggered during install.
5. ✅ No secrets written to disk.
6. ✅ Each CLI has a `--version` verification step.
7. ✅ The plan does not drift into telemetry-disabling or login flows the user did not approve.
8. ✅ Fallback path for Vercel (if `vercel-cli` formula missing) is clearly gated.
9. ✅ Post-install security scan (Task 4) is read-only — no auto-remediation, no commits, no edits to project source.
10. ✅ Pre-deploy gate enforces BLOCK on any CRITICAL/HIGH finding before user runs deploy commands.
11. ✅ Every install task and every review iteration appends to `intermediate-findings.md`. No silent runs.
12. ✅ The review itself appends a `ralph-review` block to `intermediate-findings.md` — meta-audit.
