# YouTube Cookie Injection — Design

**Status:** Approved · 2026-05-21
**Branch:** `feat/yt-dlp-cookies`
**Related:** [Cloud Supabase Migration](2026-05-21-cloud-supabase-migration-design.md), [Cloud Setup Tutorial](../../cloud-setup-tutorial.md)

## Problem

After deploying to Railway, `yt-dlp` fails on both `--dump-json` and audio download with:

```
ERROR: [youtube] <id>: Sign in to confirm you're not a bot.
Use --cookies-from-browser or --cookies for the authentication.
```

YouTube's bot detection flags traffic from data-center IP ranges. Cookies from a logged-in browser session bypass this. The local dev environment is unaffected (residential IP) and continues to work without cookies.

## Goal

Let `yt-dlp` authenticate as a signed-in user when running on Railway, with cookies supplied as a single Railway secret. Production fails fast if the secret is missing; local dev keeps running without it.

## Non-goals

- Automated cookie refresh (no headless-browser scheduler, no proxy fallback).
- Per-job or per-user cookies. One project-wide cookie set, applied to every `yt-dlp` call.
- Cookie rotation tooling. Refresh is a manual re-export + Railway redeploy.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Cookie source | Manual export from a dedicated YouTube account via a `cookies.txt` browser extension | Zero runtime dependencies; refresh ritual is a few minutes |
| Required in prod | Yes (`NODE_ENV=production` ⇒ secret required) | Matches API-key handling; fails fast on misconfigured deploys |
| Required in dev | No | Local dev hits YouTube from a residential IP and isn't bot-flagged |
| Wire format | Base64-encoded `cookies.txt` in a single Railway env var | Immune to multiline UI corruption; one-line refresh ritual |
| Container path | `/tmp/youtube-cookies.txt`, mode `0600` | Writable, ephemeral, container-local; restrictive perms |
| Applied to | Both `getMetadata` and `downloadAudio` invocations | Both calls hit YouTube and both get bot-checked |
| Secret scrubbing | `loadConfig` deletes `YOUTUBE_COOKIES_B64` from `process.env` after reading | Matches existing pattern for `ASSEMBLYAI_API_KEY` et al |

## Architecture

```
                    Railway env (per service)
                    YOUTUBE_COOKIES_B64=<base64>
                              │
                              ▼
                  ┌───────────────────────┐
   boot:          │ loadConfig() (zod)    │
                  │  → AppConfig          │
                  │  scrub from env       │
                  └──────────┬────────────┘
                             │ cfg.youtubeCookiesB64
                             ▼
                  ┌───────────────────────┐
                  │ writeCookiesFile(b64) │  src/services/youtube-cookies.ts
                  │  decode → sanity      │
                  │  fs.writeFile 0o600   │
                  └──────────┬────────────┘
                             │ '/tmp/youtube-cookies.txt'
                             ▼
                  ┌───────────────────────┐
                  │ new YouTubeService({  │  src/services/youtube.ts
                  │   cookiesPath })      │
                  └──────────┬────────────┘
                             │
                  ┌──────────┴─────────────┐
                  ▼                        ▼
        yt-dlp --cookies            yt-dlp --cookies
          --dump-json                 -x --audio-format mp3
          (getMetadata)               (downloadAudio)
```

## Components

### `src/config.ts`

Add to zod schema:

```ts
YOUTUBE_COOKIES_B64: z.string().optional(),
```

Add to `AppConfig`:

```ts
youtubeCookiesB64?: string
```

Map in `loadConfig`, scrub from `process.env` alongside other secrets, and after parsing:

```ts
if (config.nodeEnv === 'production' && !config.youtubeCookiesB64) {
  throw new Error('Invalid config: YOUTUBE_COOKIES_B64 is required in production')
}
```

### `src/services/youtube-cookies.ts` (new)

Single exported function:

```ts
export function writeCookiesFile(b64: string, dir = '/tmp'): string
```

Behavior:
1. Decode base64.
2. Validate the decoded content starts with `# Netscape HTTP Cookie File` or `# HTTP Cookie File` (yt-dlp's accepted headers). Throw a typed error if not.
3. Write to `<dir>/youtube-cookies.txt` with `mode: 0o600`.
4. Return the absolute path.

Why a separate module: keeps boot wiring in `index.ts`/`worker.ts` minimal and gives the validation logic its own unit test surface.

### `src/services/youtube.ts`

Extend constructor opts:

```ts
constructor(opts: { exec?: ExecFn; cookiesPath?: string } = {})
```

Store `this.cookiesPath`. Build a private helper:

```ts
private cookiesFlag(): string {
  return this.cookiesPath ? ` --cookies ${shellQuote(this.cookiesPath)}` : ''
}
```

Insert `this.cookiesFlag()` into both `yt-dlp` command strings, immediately after `yt-dlp --no-warnings`.

Tests already mock `exec`; the new flag is asserted by inspecting the command string.

### `src/index.ts` and `src/worker.ts`

After `loadConfig`, before `new YouTubeService(...)`:

```ts
const cookiesPath = cfg.youtubeCookiesB64
  ? writeCookiesFile(cfg.youtubeCookiesB64)
  : undefined
// ...
youtube: new YouTubeService({ cookiesPath }),
```

Both processes do this so that:
- The api can call `getMetadata` if a future route ever needs it.
- The worker can call both `getMetadata` and `downloadAudio` in the pipeline.

## Data flow

**Boot (per process):**

1. `loadConfig(process.env)` parses + validates + scrubs.
2. If `youtubeCookiesB64` set → `writeCookiesFile()` returns the path.
3. `new YouTubeService({ cookiesPath })` captures it.

**Per pipeline job (worker only):**

1. `runDownload(ctx)` calls `ctx.youtube.getMetadata(url)` → `yt-dlp --no-warnings --cookies '/tmp/youtube-cookies.txt' --dump-json --skip-download '<url>'`.
2. Then `ctx.youtube.downloadAudio(url, audioPath)` → `yt-dlp --no-warnings --cookies '/tmp/youtube-cookies.txt' -x --audio-format mp3 -o '<path>' '<url>'`.

## Failure modes

| Failure | Detection | Behavior |
|---|---|---|
| `YOUTUBE_COOKIES_B64` missing in prod | `loadConfig` runtime check | Process exits at startup with `Invalid config: YOUTUBE_COOKIES_B64 is required in production` |
| Malformed base64 | `Buffer.from(b64, 'base64')` produces empty/garbage bytes; header check fails | `writeCookiesFile` throws `Invalid YOUTUBE_COOKIES_B64: decoded content is not a Netscape cookies.txt file` at boot |
| `/tmp` not writable | `fs.writeFileSync` throws | Boot fails with the underlying `EACCES`/`EROFS` |
| Cookies expired (most common ongoing failure) | `yt-dlp` exits non-zero with the "Sign in to confirm you're not a bot" message | Existing pipeline error path stores `source_videos.status='error'` with stderr; operator re-exports cookies and updates the Railway secret (tutorial step) |
| Cookies tied to wrong account / suspended | Same as expired | Same flow |

## Testing

| Test file | Cases |
|---|---|
| `tests/unit/youtube.test.ts` (extend) | (1) `getMetadata` with `cookiesPath` set includes `--cookies '<path>'`; (2) `downloadAudio` likewise; (3) neither command contains `--cookies` when `cookiesPath` is undefined |
| `tests/unit/youtube-cookies.test.ts` (new) | (1) Valid base64 of a real `cookies.txt` → file exists, mode is `0o600`, content matches; (2) base64 of non-Netscape content throws; (3) non-base64 string throws |
| `tests/unit/config.test.ts` (extend if exists, otherwise add to whichever covers `loadConfig`) | (1) `NODE_ENV=production` without `YOUTUBE_COOKIES_B64` throws; (2) `NODE_ENV=development` without it succeeds; (3) set value is reflected on `AppConfig.youtubeCookiesB64`; (4) key is scrubbed from `process.env` after `loadConfig` |

No new integration test. End-to-end validation is a manual Railway redeploy + retry of the previously-failing video URL.

## Operator workflow (added to `docs/cloud-setup-tutorial.md`)

New section "Step 1.7 — Export YouTube cookies":

1. In a clean browser profile, sign in to a dedicated low-value YouTube account.
2. Install the "Get cookies.txt LOCALLY" browser extension.
3. Visit `https://www.youtube.com`, open the extension, click **Export** → save `cookies.txt`.
4. Encode: `base64 -i cookies.txt | pbcopy` (macOS) or `base64 -w0 cookies.txt | xclip -selection clipboard` (Linux).
5. Railway → **api** service → Variables → add `YOUTUBE_COOKIES_B64` (paste). Repeat on **worker** service (same value).
6. Redeploy both services.
7. To refresh when downloads start failing: repeat steps 3-6.

A note in **Known limitations** is updated to point at this section.

## Out of scope

- Encrypting the cookies file at rest on disk. Container is ephemeral; perms are `0600`; if Railway is compromised, the env var is exposed regardless.
- Auto-refresh via a scheduled job. Possible future work; not part of this design.
- Multiple cookie sets for load balancing across YouTube accounts. Not needed at current volume.
