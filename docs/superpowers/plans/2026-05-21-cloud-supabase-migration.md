# Cloud Migration (Railway + Supabase) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the two infrastructure config files (`nixpacks.toml`, updated `railway.toml`) needed for Railway to build and deploy this app's `api` + `worker` services with `yt-dlp` + `ffmpeg` available at runtime, gated by local `test:all` + `typecheck`, on the existing `feat/cloud-deploy` branch.

**Architecture:** No app code changes. Two files at the repo root: a new `nixpacks.toml` that declares the Nix packages (`nodejs_22`, `yt-dlp`, `ffmpeg`) and build commands, and an updated `railway.toml` adding a `/health` healthcheck to the api service. All cloud-side work (Supabase project, env vars, redeploys) is human-driven per `docs/cloud-setup-tutorial.md`.

**Tech Stack:** Nixpacks (Railway's default builder), TOML config files, existing Node 22 / TypeScript / Fastify / pg-boss stack.

**Pre-state (verified):**
- Branch `feat/cloud-deploy` exists, based on `origin/main`, with commits `f2c104d` (spec + tutorial) and `d9c257c` (spec amendment).
- `railway.toml` already exists with `builder = "NIXPACKS"` and both `services.api` + `services.worker` declared (no healthcheck yet).
- `nixpacks.toml` does not exist.
- `/health` already exists at `src/server.ts:24` returning `{status:'ok'}`.
- `loadConfig` in `src/config.ts` accepts the env vars the cloud will provide.
- `src/index.ts:26` binds the api to `host: '0.0.0.0'` (required for Railway).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `nixpacks.toml` | Create | Declare Nix packages (`nodejs_22`, `yt-dlp`, `ffmpeg`) and build steps (`npm ci`, `npm run build`) for both services. Applies to whichever service Railway builds. |
| `railway.toml` | Modify | Add `healthcheckPath = "/health"` and `healthcheckTimeout = 30` to `[services.api]`. Worker config unchanged. |

No other files change. No app code, no test code, no other docs.

---

## Task 1 — Create `nixpacks.toml`

**Files:**
- Create: `nixpacks.toml` (repo root)

- [ ] **Step 1.1: Verify file does not already exist**

Run:
```bash
ls nixpacks.toml 2>&1
```
Expected: `ls: nixpacks.toml: No such file or directory`

If the file already exists, stop and inspect — don't overwrite blindly.

- [ ] **Step 1.2: Create `nixpacks.toml` with the exact content below**

File: `nixpacks.toml`
```toml
[phases.setup]
nixPkgs = ["nodejs_22", "yt-dlp", "ffmpeg"]

[phases.build]
cmds = ["npm ci", "npm run build"]
```

Rationale per field:
- `nodejs_22` is pinned explicitly to match the local Node 22 requirement in the README.
- `yt-dlp` is required at worker runtime to download YouTube audio (`src/services/youtube.ts`).
- `ffmpeg` is `yt-dlp`'s mandatory transcoding dependency (extracts mp3 from video).
- `npm ci` over `npm install` for deterministic dependency resolution from `package-lock.json`.
- `npm run build` invokes `tsc` per `package.json`'s `build` script, producing `dist/`.

- [ ] **Step 1.3: Verify TOML parses**

Run:
```bash
node -e "console.log(require('fs').readFileSync('nixpacks.toml','utf8'))"
```
Expected: prints the file contents verbatim (no parse error needed — Nixpacks accepts the file; this is a presence + content check).

If you have a TOML parser handy (`pip install tomli` or similar), an explicit parse is nicer but optional. Nixpacks itself will validate during the first Railway build.

- [ ] **Step 1.4: Commit**

```bash
git add nixpacks.toml
git commit -m "feat(deploy): add nixpacks.toml with yt-dlp + ffmpeg"
```

---

## Task 2 — Add healthcheck to `railway.toml`

**Files:**
- Modify: `railway.toml` (repo root)

- [ ] **Step 2.1: Read current `railway.toml` to confirm baseline**

Run:
```bash
cat railway.toml
```
Expected output:
```toml
[build]
  builder = "NIXPACKS"

[deploy]
  restartPolicyType = "ON_FAILURE"
  restartPolicyMaxRetries = 3

[services.api]
  start = "node dist/index.js"

[services.worker]
  start = "node dist/worker.js"
```

If the content differs from the above, stop and reconcile before continuing.

- [ ] **Step 2.2: Edit `railway.toml` to add healthcheck fields to `[services.api]`**

Replace this block:
```toml
[services.api]
  start = "node dist/index.js"
```

With this block:
```toml
[services.api]
  start = "node dist/index.js"
  healthcheckPath = "/health"
  healthcheckTimeout = 30
```

The `[services.worker]` block stays unchanged.

The final file should read:
```toml
[build]
  builder = "NIXPACKS"

[deploy]
  restartPolicyType = "ON_FAILURE"
  restartPolicyMaxRetries = 3

[services.api]
  start = "node dist/index.js"
  healthcheckPath = "/health"
  healthcheckTimeout = 30

[services.worker]
  start = "node dist/worker.js"
```

- [ ] **Step 2.3: Verify the diff is exactly the two added lines**

Run:
```bash
git diff railway.toml
```
Expected: two added lines (`healthcheckPath` and `healthcheckTimeout`), no other changes.

- [ ] **Step 2.4: Commit**

```bash
git add railway.toml
git commit -m "feat(deploy): healthcheck /health on api service"
```

---

## Task 3 — Local verification gate

**Files:** none modified. This task runs the existing local checks against the new branch state.

- [ ] **Step 3.1: Typecheck passes**

Run:
```bash
npm run typecheck
```
Expected: exits 0, no TypeScript errors. No app code changed, so this should pass identically to `main`.

- [ ] **Step 3.2: Build succeeds**

Run:
```bash
npm run build
```
Expected: exits 0, produces a `dist/` directory with `index.js` and `worker.js`.

This step matters because Nixpacks will run the same `npm run build` during the cloud build — failing here means it would fail there too.

- [ ] **Step 3.3: Unit tests pass**

Run:
```bash
npm test
```
Expected: all Vitest unit tests pass. No new tests added; this verifies nothing was broken.

- [ ] **Step 3.4: Integration tests pass**

Pre-check: Docker daemon must be running and no `dev:worker` from another terminal should be connected to the test Postgres (see README note about the race).

Run:
```bash
npm run test:integration
```
Expected: integration tests pass against the Dockerized pgvector container.

- [ ] **Step 3.5: Confirm no working-tree drift after running checks**

Run:
```bash
git status
```
Expected: `working tree clean`. If `dist/` shows as untracked, that's fine — it's in `.gitignore` (verify with `cat .gitignore | grep dist`). If anything else appeared, investigate before proceeding.

- [ ] **Step 3.6: No commit needed**

This task produces no file changes. If everything passed, move to Task 4. If something failed, stop and diagnose — do **not** mask failures.

---

## Task 4 — Push branch and open PR

**Files:** none modified. This task handles the GitHub side of the handoff.

- [ ] **Step 4.1: Confirm branch + commits**

Run:
```bash
git log --oneline origin/main..HEAD
```
Expected (in order, most recent first):
```
<sha>  feat(deploy): healthcheck /health on api service
<sha>  feat(deploy): add nixpacks.toml with yt-dlp + ffmpeg
d9c257c  docs(cloud-migration): drop per-service AssemblyAI key split
f2c104d  docs: cloud migration design + Railway/Supabase setup tutorial
```

Four commits ahead of `origin/main`. If you see more or fewer, stop and reconcile.

- [ ] **Step 4.2: Push the branch to origin**

Run:
```bash
git push -u origin feat/cloud-deploy
```
Expected: push succeeds, sets upstream tracking.

- [ ] **Step 4.3: Open the PR**

Run:
```bash
gh pr create --title "Cloud migration: Railway + Supabase" --body "$(cat <<'EOF'
## Summary

- Adds `nixpacks.toml` so Railway's Nixpacks builder installs `yt-dlp` + `ffmpeg` (worker runtime deps) alongside Node 22.
- Adds `/health` healthcheck to the api service in `railway.toml`.
- Includes the design spec (`docs/superpowers/specs/2026-05-21-cloud-supabase-migration-design.md`) and a human setup tutorial (`docs/cloud-setup-tutorial.md`) for the one-time Supabase + Railway provisioning.

No app code changed. `loadConfig` already accepts the env vars cloud will provide; `/health` already exists; `src/index.ts` already binds `0.0.0.0`.

## Test plan

- [ ] `npm run typecheck` passes locally
- [ ] `npm run build` produces `dist/`
- [ ] `npm test` passes
- [ ] `npm run test:integration` passes (Docker daemon + no `dev:worker` running)
- [ ] After merge: human follows `docs/cloud-setup-tutorial.md` Parts 1–3 to provision Supabase, create the Railway project, set per-service env vars in the dashboard, redeploy, and verify end-to-end

## Secrets hygiene

- No real secret values appear in this branch, in commits, or in the PR description.
- Cloud secrets will be set by the user via the Railway web dashboard. The agent does not run `railway variables`, `railway run`, or any CLI that exposes values.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR URL printed.

- [ ] **Step 4.4: Report the PR URL**

Print the URL from `gh pr create` so the user can review. This is the end of the engineer-side implementation; from here the work shifts to the human running `docs/cloud-setup-tutorial.md`.

---

## Out of scope (do not implement)

These are deferred per the design spec — do **not** add them in this plan:

- Supabase project creation (human task, tutorial Part 1).
- Schema migrations against Supabase (human task, tutorial Part 1.4).
- Railway project creation, env-var entry, redeploy (human tasks, tutorial Part 2).
- Staging environment.
- Custom domain.
- CI gating / auto-deploy on `main`.
- Log shipping, alerting, autoscaling.
- DB-connectivity probe inside `/health`.
- Making `ASSEMBLYAI_API_KEY` optional in `loadConfig` (acknowledged limitation; deferred).

---

## Self-review notes (for the plan author)

**Spec coverage check:**
- Design spec "Code & config changes → New: `nixpacks.toml`" → Task 1.
- Design spec "Code & config changes → Modify: `railway.toml`" → Task 2.
- Design spec "Code: no changes required" → confirmed by Task 3's verification gates (which run against unchanged app code).
- Design spec "Migration steps" steps 1–3, 6–11 are human-driven and covered by the tutorial; this plan implements steps 4–5 of the spec's migration list.
- Design spec "Verification" is the post-deploy human check, also in the tutorial.

**Type / consistency check:**
- `nixpacks.toml` field names (`phases.setup.nixPkgs`, `phases.build.cmds`) match Nixpacks's documented schema.
- `railway.toml` healthcheck field names (`healthcheckPath`, `healthcheckTimeout`) match Railway's documented schema.
- Health endpoint path `/health` matches the route registered at `src/server.ts:24`.

**Placeholder scan:** none found.

**Scope check:** plan is intentionally tiny (two files, four tasks). The spec is decomposed correctly — the bulk of the work is human-driven provisioning, not code.
