# Secure Local API Key Management for Node.js Projects

A practical guide for storing API secrets in macOS Keychain, keeping them out of shell
history, and limiting exposure to npm packages and AI coding agents.

---

## The Problem

Most local dev setups store secrets in `.env` files or shell profiles. This creates several
risks:

- **Git accidents** — `.env` files get committed
- **Shell history** — keys typed or exported appear in `~/.zsh_history`
- **npm package access** — any package in your dependency tree can read `process.env`
- **AI agent access** — local coding agents (Claude Code, Cursor, Copilot) inherit your
  shell environment and can read from the default login keychain

This guide addresses all of these — and is honest about which ones it doesn't fully solve.

---

## Architecture Overview

```
Isolated keychain (dev-secrets.keychain, 15-min auto-lock, per-access prompts)
    ↓  fetched on demand, macOS prompts on every access
.envrc helper functions (direnv, per-project, chmod 600)
    ↓  injected only into the target subprocess
run_server node dist/index.js
    ↓  process.env scrubbed immediately
AppConfig object (in-memory, not in process.env)
```

Secrets never touch shell history, are never permanently exported into the shell
environment, are removed from `process.env` as soon as the app reads them, and require
an explicit macOS prompt to access — defeating silent exfiltration.

---

## Step 1 — Create an Isolated, Auto-Locking Keychain

**Do not use the default login keychain for dev secrets.** The login keychain is
automatically unlocked at login and most terminal apps are pre-authorized to read from
it. Create a separate keychain that locks itself and requires a prompt on every access.

```bash
# Create the keychain (prompts for a protection password)
security create-keychain dev-secrets.keychain

# Auto-lock after 15 minutes of inactivity, and on sleep
security set-keychain-settings -t 900 -l dev-secrets.keychain
```

> **Why this matters:** A separate keychain with a short auto-lock window means even if
> an attacker (or a compromised AI agent) gets shell access, they can only read secrets
> during the brief window after you've authorized access. After 15 minutes idle, every
> access requires re-prompting.

> **Environment assumption:** This setup assumes an interactive GUI session (you're at
> your Mac, can click prompts). Over SSH or in headless contexts, `unlock-keychain`
> without a password cannot prompt and will fail silently — secrets become unreadable.
> Use a different secrets-loading mechanism for headless/CI environments.

> **Note on search lists:** You may see guides that tell you to add the new keychain to
> your default search list with `security list-keychains -d user -s ...`. **Skip that
> step.** Our `.envrc` always passes the keychain name explicitly to every
> `find-generic-password` call, so the search list doesn't need to know about it.
> Modifying the search list is risky — the `-s` flag *replaces* the entire list, and a
> malformed command can remove your login keychain (Safari passwords, Wi-Fi, certs)
> from the default search path until manually restored.

---

## Step 2 — Store Secrets with Per-Access Prompts

The critical flag here is **`-T ""`** — an empty trusted-applications list means
**no application is pre-authorized**. Every read triggers a macOS prompt.

> ## ⚠️ Critical: Never click "Always Allow"
>
> When the keychain access prompt appears, it has three buttons: **Deny**, **Allow**,
> and **Always Allow**. Clicking **Always Allow** adds the requesting application to
> the item's trusted-app list, **completely defeating `-T ""`** for that item. Future
> reads from that app — including any AI agent running in your terminal — happen
> silently with no prompt.
>
> **Always click "Allow" (not "Always Allow")**, every time. If you find yourself
> tempted to click "Always Allow" out of prompt fatigue, that's a signal to either
> consolidate accesses (use `run_server` to batch all 6 keys into one process startup
> with 6 prompts in quick succession) or accept that your threat model doesn't
> warrant this level of friction.
>
> If you accidentally click "Always Allow", you can revoke it: open Keychain Access,
> find the item, double-click it, go to "Access Control" tab, and remove the trusted
> app.

```bash
echo "Type OpenAI key (invisible):"     && read -s SECRET && security add-generic-password -s "your-app-name" -a "openai"     -T "" -w "$SECRET" dev-secrets.keychain && unset SECRET
echo "Type Anthropic key (invisible):"  && read -s SECRET && security add-generic-password -s "your-app-name" -a "anthropic"  -T "" -w "$SECRET" dev-secrets.keychain && unset SECRET
echo "Type AssemblyAI key (invisible):" && read -s SECRET && security add-generic-password -s "your-app-name" -a "assemblyai" -T "" -w "$SECRET" dev-secrets.keychain && unset SECRET
```

> **Note:** Each line follows the pattern `read -s SECRET && security ... && unset SECRET`.
> `read -s` reads silently (no echo) in both bash and zsh. The `&&` chain only proceeds if
> `read` succeeded, and `unset SECRET` clears the variable from your shell as soon as
> `security` returns. `$SECRET` is briefly present in the parent shell — acceptable for a
> one-time setup; if that bothers you, wrap each line in `( … )` to scope it to a subshell.

> ## ⚠️ Why `read -s SECRET` instead of `security`'s built-in `-w` prompt
>
> Apple's own help text says: *"Specify -w as the last option to be prompted."*
> In practice, on macOS 15 (Sequoia) `add-generic-password` with a bare trailing
> `-w` reproducibly prints the usage banner instead of prompting, leaving the
> keychain unchanged. Rather than rely on that, we read the key into a shell
> variable with `read -s SECRET` (silent — nothing echoed to terminal, nothing
> in history) and pass it via `-w "$SECRET"`.
>
> **Note on shell portability:** do **not** use `read -p "prompt:" var`. In zsh
> (macOS default), `-p` means "read from coprocess" and fails with
> `read: -p: no coprocess`. Use a separate `echo` for the prompt instead.
>
> **Honest tradeoff:** the key appears briefly in `ps aux` for the sub-second
> window that `security` is executing. This is a one-time setup cost per key
> and is still a strictly smaller exposure than a `.env` file on disk. The
> runtime path (via `.envrc` helper functions in Step 5) does not have this
> issue — `find-generic-password` retrieves the key without it ever appearing
> in argv.
>
> An alternative that avoids the `ps` window entirely is `security -i`
> interactive mode — the trailing-`-w` prompt is more consistently honored
> inside the interactive shell — but it is clunkier for a one-shot setup. Pick
> whichever fits your threat model.

Verify a key is stored (you'll get a Keychain prompt — this is the protection working).
If the byte count is greater than 0, the key is present:

```bash
 security find-generic-password -s "your-app-name" -a "openai" -w dev-secrets.keychain | wc -c
```

> **Why `| wc -c`?** Piping through `wc -c` avoids printing the key to the terminal
> (and therefore to the scrollback buffer). You only see the length. To actually
> retrieve the key value, drop the pipe — but be aware it then lands in scrollback.

---

## Step 3 — Suppress Shell History

Add to `~/.zshrc`:

```zsh
# Commands prefixed with a space are not recorded
setopt HIST_IGNORE_SPACE

# Never record commands that export secrets or call the Keychain CLI
HISTORY_IGNORE="(export *KEY*|export *SECRET*|export *TOKEN*|export *PASSWORD*|export *CONNECTION*|security add-generic-password*|security find-generic-password*)"
```

This gives you two layers:
- **Space prefix** — opt-in per command
- **Pattern matching** — automatic, catches accidents

**Audit existing history** for leaks before you started using this setup:

```bash
grep -iE "(api[_-]?key|secret|token|sk-|password|bearer)" ~/.zsh_history
```

Rotate any keys that appear.

---

## Step 4 — Install direnv

direnv loads and unloads environment variables as you `cd` into/out of a project
directory.

```bash
brew install direnv
```

Add the shell hook to `~/.zshrc` (after the history config):

```zsh
eval "$(direnv hook zsh)"
```

Reload your shell:

```bash
source ~/.zshrc
```

---

## Step 5 — Create `.envrc` with Helper Functions

Create `.envrc` in your project root. **Do not export secrets directly** — define
functions instead:

```bash
# .envrc
_kc() {
  # Unlock first — if the keychain is locked, this triggers a GUI prompt for
  # the keychain password (no -p flag = no password in shell history or
  # process list). No-op if already unlocked. Errors are surfaced so a wrong
  # keychain password or missing keychain doesn't silently return empty.
  security unlock-keychain dev-secrets.keychain || {
    echo "ERROR: failed to unlock dev-secrets.keychain — secrets unavailable" >&2
    return 1
  }
  local value
  value=$(security find-generic-password -s "your-app-name" -a "$1" -w dev-secrets.keychain 2>/dev/null)
  if [[ -z "$value" ]]; then
    echo "ERROR: no key found for '$1' in dev-secrets.keychain" >&2
    return 1
  fi
  printf '%s' "$value"
}

assemblyai_key()       { _kc assemblyai; }
openai_key()           { _kc openai; }
anthropic_key()        { _kc anthropic; }
supabase_conn()        { _kc supabase-conn; }
supabase_url()         { _kc supabase-url; }
supabase_service_key() { _kc supabase-service-role; }

# Injects all secrets into a single subprocess — gone when the process exits
run_server() {
  ASSEMBLYAI_API_KEY=$(assemblyai_key) \
  OPENAI_API_KEY=$(openai_key) \
  ANTHROPIC_API_KEY=$(anthropic_key) \
  SUPABASE_CONNECTION_STRING=$(supabase_conn) \
  SUPABASE_URL=$(supabase_url) \
  SUPABASE_SERVICE_ROLE_KEY=$(supabase_service_key) \
  PORT=${PORT:-3000} \
  NODE_ENV=${NODE_ENV:-development} \
  "$@"
}
```

**Lock down file permissions** (default is world-readable on macOS):

```bash
chmod 600 .envrc
```

Approve direnv:

```bash
direnv allow .
```

**Why functions instead of `export`?**

If you `export OPENAI_API_KEY=...` in `.envrc`, every child process in your shell
session inherits it — including `npm install`, `npm test`, arbitrary build scripts, and
any AI agent that spawns a subprocess. Helper functions mean the key is only injected
into the one specific process you explicitly invoke.

---

## Step 6 — Add `.envrc` to `.gitignore`

```gitignore
.env
.env.local
.envrc
```

`.envrc` contains Keychain lookup logic tied to your machine. It should not be committed.
Teammates run the `security add-generic-password` commands locally with their own
credentials.

---

## Step 7 — Scrub Secrets from `process.env` After Reading

Even with helper functions, secrets are briefly present in `process.env` when Node.js
starts. Any package that runs initialization code before your app reads config can still
see them.

Fix: delete secrets from `process.env` immediately after reading them in your config
module.

```typescript
// src/config.ts
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = Schema.safeParse(env)
  if (!parsed.success) { /* ... */ }

  const config = {
    openaiApiKey: parsed.data.OPENAI_API_KEY,
    // ... etc
  }

  // Scrub secrets — npm packages loaded after this point cannot read them
  for (const key of [
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ASSEMBLYAI_API_KEY',
    'SUPABASE_CONNECTION_STRING', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  ]) {
    delete process.env[key]
  }

  return config
}
```

Call `loadConfig()` at the very top of your entry point, before importing other modules
that might trigger npm package initialization code.

---

## Usage

**Start the server:** (you'll get a Keychain prompt the first time after auto-lock)

```bash
run_server node dist/index.js
```

**Single key for a one-off script:**

```bash
OPENAI_API_KEY=$(openai_key) node scripts/embed.js
```

**npm commands — no keys needed, none provided:**

```bash
npm install
npm run build
npm test
```

---

## Risk Coverage Summary

| Threat | Status | Mechanism |
|--------|--------|-----------|
| Secret committed to git | ✅ Solved | `.envrc` in `.gitignore` |
| Secret in shell history | ✅ Solved | `HIST_IGNORE_SPACE` + `HISTORY_IGNORE` patterns |
| Secret in `.env` file on disk | ✅ Eliminated | Keychain replaces `.env` entirely |
| `.envrc` readable by other users | ✅ Solved | `chmod 600` |
| `npm install` / build scripts reading env | ✅ Solved | Helper functions — no auto-export |
| npm packages reading `process.env` at runtime | ✅ Mostly solved | `delete process.env[key]` in config |
| npm packages running before `loadConfig()` | ⚠️ Narrow window | Keys present briefly at Node.js startup |
| Key visible in `ps aux` during one-time keychain insert | ⚠️ Narrow window | `read -s SECRET && security … -w "$SECRET"` passes the key as argv to `security` for sub-second duration. One-time setup cost; runtime path is unaffected. |
| `env` / `printenv` exposing keys | ✅ Solved | No auto-export; keys never in shell env |
| **Silent AI agent / process exfiltration** | ✅ Solved *conditionally* | Isolated keychain with `-T ""` requires a user-visible prompt on every access — **provided you never click "Always Allow"** (see warning in Step 2). Defeated by clicking Always Allow even once. |
| Process heap residue after secret use | ⚠️ Not addressed | Real but exotic; requires memory-zeroing or a separate secrets daemon |
| direnv supply-chain compromise | ⚠️ Not addressed | Low probability; mitigate by pinning direnv version |

---

## What the Isolated Keychain Buys You

The single most important upgrade in this setup is the dedicated, auto-locking keychain
with `-T ""`. Here's what it changes:

| Without isolated keychain | With isolated keychain |
|---------------------------|------------------------|
| Login keychain unlocked at login → silent access | Locked by default → access requires unlock |
| Terminal often pre-authorized via "Always Allow" | `-T ""` means **no** app is pre-trusted |
| Compromised process can read keys silently | Every read triggers a visible macOS prompt |
| Access remains until logout | Auto-locks after 15 min of inactivity |

If an AI agent or malicious script tries to read your keys, **you see a prompt**. You can
deny it. This is the meaningful security boundary.

---

## Residual Risks

Even with this setup, these gaps remain:

- **Authorized access window** — within 15 minutes of you unlocking the keychain, any
  process running as your user can read keys without re-prompting (the per-item `-T ""`
  prompt is separate from the keychain-unlock prompt — items still require their own
  authorization, but the keychain unlock itself does not re-prompt during the window).
  Lock the keychain manually after running a command
  (`security lock-keychain dev-secrets.keychain`) for highest assurance.
- **Heap residue** — keys exist in Node.js heap memory until garbage-collected. A
  process-memory dump could recover them. Mitigation: keep the secret values in scope
  only as long as necessary, and avoid logging.
- **Prompt fatigue → "Always Allow"** — this is the most likely failure mode in
  practice. With 6 keys × frequent server restarts, the prompt count adds up. The
  temptation to click "Always Allow" is strong, and a single such click silently
  reverts the protection model for that item to the same level as the default login
  keychain. Use `run_server` to batch all key accesses into one startup so prompts
  come together, and audit Keychain Access periodically (Access Control tab) to
  ensure no apps have been added to trusted lists.
- **Headless / SSH contexts** — `unlock-keychain` without `-p` cannot prompt over
  SSH. This setup is for interactive local development only.

---

## Quick Reference

```bash
# Create the isolated keychain (one-time setup)
security create-keychain dev-secrets.keychain
security set-keychain-settings -t 900 -l dev-secrets.keychain

# Store a new key (silent prompt via read -s; see Step 2 for why not -w bare)
echo "Type secret (invisible):" && read -s SECRET && security add-generic-password -s "your-app-name" -a "service-name" -T "" -w "$SECRET" dev-secrets.keychain && unset SECRET

# Verify a key is present without exposing it to scrollback
 security find-generic-password -s "your-app-name" -a "service-name" -w dev-secrets.keychain | wc -c

# Update an existing key (delete + re-add)
 security delete-generic-password -s "your-app-name" -a "service-name" dev-secrets.keychain
echo "Type secret (invisible):" && read -s SECRET && security add-generic-password -s "your-app-name" -a "service-name" -T "" -w "$SECRET" dev-secrets.keychain && unset SECRET

# Lock the keychain immediately after use
security lock-keychain dev-secrets.keychain

# Start your app with secrets
run_server node dist/index.js

# Re-approve .envrc after editing it
direnv allow .

# Audit your existing shell history for leaks
grep -iE "(api[_-]?key|secret|token|sk-|password|bearer)" ~/.zsh_history
```
