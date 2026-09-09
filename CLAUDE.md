# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-purpose web app for turning MCAT short-video content into a narrator
script. Two input paths:

1. **Paste a transcript** → `POST /api/generate` → Gemini writes the script. Free.
2. **Paste a link (TikTok)** → `POST /api/from-link` → `yt-dlp` downloads the
   video → ElevenLabs `speech-to-text` transcribes it → same Gemini step. The
   response includes the raw `transcript` so the UI can show it for editing.

Runs locally for the owner and is also deployed publicly (password-gated) on Render.

## Running it

```bash
cp .env.example .env                # put a real GEMINI_API_KEY in .env
python3 server.py                   # serves http://localhost:3000, Ctrl+C to stop
```

- **No tests, no linter.** The only third-party dependency is `yt-dlp` (link
  feature). Without it, the paste-a-transcript path still works; the link path
  returns a clear error.
- Written to run on macOS system `python3` (3.9). Keep new code 3.9-compatible
  (no `match`, no runtime `X | Y` unions).
- **`yt-dlp` on this Mac: use the standalone binary, not pip.** Current `yt-dlp`
  dropped Python 3.9, so `pip install` here gets a stale build that TikTok
  rejects. `bin/yt-dlp` (a downloaded standalone binary, gitignored) is what the
  server uses locally — `_download_media()` prefers `$YTDLP_BIN` → `./bin/yt-dlp`
  → `yt-dlp` on PATH, and only falls back to `import yt_dlp`. Refresh it with:
  `curl -fsSL -o bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos && chmod +x bin/yt-dlp`
- On Render (and any non-3.9 machine) the pip module is fine —
  `pip install -r requirements.txt`.
- The page pulls Poppins + Lato from Google Fonts via a `<link>` in
  `public/index.html` — the only external asset.
- There is no dev/prod split beyond environment variables.

## Environment variables (read from `.env` locally, from the host dashboard in prod)

| Var | Purpose |
|---|---|
| `GEMINI_API_KEY` | Required. Free key from https://aistudio.google.com/apikey |
| `GEMINI_MODEL` | Default `gemini-3.6-flash`. Google retires old model ids — see below |
| `ELEVENLABS_API_KEY` | Optional. Enables `POST /api/from-link`. Without it that route 501s |
| `ELEVENLABS_MODEL` | Default `scribe_v1` |
| `YTDLP_BIN` | Optional. Explicit path to a yt-dlp binary; else `./bin/yt-dlp` or PATH |
| `AIRTABLE_API_KEY` / `AIRTABLE_BASE_ID` / `AIRTABLE_TABLE` | Optional; **all three** enable logging every script to Airtable. Token needs `data.records:write` (the app only writes, never reads) |
| `APP_PASSWORD` | If set, the **entire site** is behind HTTP Basic Auth. Empty locally |
| `HOST` | Default `127.0.0.1`. Render sets `0.0.0.0` |
| `PORT` | Default `3000`. Render injects its own |

`load_dotenv()` in `server.py` is a hand-rolled parser that **does not override
real environment variables**, so Render's dashboard values always win over a
committed file. `.env` is gitignored; `.env.example` is the template.

## Architecture

Three moving parts, each in one file:

- **`server.py`** — a `ThreadingHTTPServer` with one `Handler`. It does two jobs:
  1. Serves static files from `public/` (path-traversal guarded).
  2. `POST /api/generate` — validates `{transcript, image?}`, calls
     `call_gemini()`, returns `{script, model, truncated}`.
  `call_gemini()` builds the Gemini `v1beta/models/{MODEL}:generateContent` REST
  payload by hand and sends it with `urllib.request` (`x-goog-api-key` header).
  The frontend's image shape `{media_type, data}` is translated here into
  Gemini's `inlineData: {mimeType, data}`. All error paths raise `ApiError(status,
  message)` which becomes the JSON `{error}` the UI shows.
  `transcribe_link()` = `_download_media()` (yt-dlp — binary via `subprocess` if
  found, else the module — into a temp dir that is always cleaned up) + a
  hand-built `multipart/form-data` POST to ElevenLabs (`_multipart()` — there is
  no `requests`). TikTok downloads routinely fail from datacenter IPs; the error
  message says so and points the user to run locally / paste instead.
- **`system_prompt.py`** — the instruction prompt sent as Gemini's
  `systemInstruction`. This is the owner's own prompt, verbatim, minus its
  chat-style handshake. **Edit the prompt here.** It is imported *after*
  `load_dotenv()` on purpose.
- **`public/`** — vanilla HTML/CSS/JS, no framework, no bundler. `app.js`
  contains a deliberately tiny hand-rolled Markdown renderer (headings, bold,
  italic, lists only — the model's output format is known and narrow) and all
  history logic. **History is 100% client-side** in `localStorage` under
  `mcat-scripts-history`; the server never sees or stores it.

### Auth model

When `APP_PASSWORD` is set, `_authed()` gates every request except `GET /healthz`
(left open for Render's health check). Browsers prompt natively; users enter a
blank username + the password. There are no sessions or cookies.

### Output post-processing

The prompt tells the model not to emit a "Short Video Script" title; `call_gemini()`
*also* strips a leading one defensively with a regex. Two "signal phrases" from the
prompt (`I NEED THE QUESTIONS AND ANSWER CHOICES`, `DO NOT ADD THIS TO THE DATABASE`)
are detected in `app.js` and surfaced as a banner rather than blending into the script.

### Airtable logging

`_attach_airtable()` runs after every successful generation on both routes. It
calls `save_to_airtable()` (one `POST .../v0/{base}/{table}` with `typecast: true`)
writing hard-coded field names + values in the owner's "Main Database" table:
`Status`=`Script Complete`, `Script Status`=`Done`, `Source Account`=`MCAT Simplified`,
`Video Type`=`Long & Short Form`, `Original Transcript`, `Body Script`, and
`Video URL` (only when a link was used). Timing fields are deliberately left alone.
Best-effort: a failure is attached to the JSON as `airtable: {ok, detail}` for a
small UI note and never raises. If the destination table or the desired
values/fields change, edit `save_to_airtable()`.

## Gemini model ids

Google removes old model ids for new projects. If generation starts returning a
`404 ... "no longer available"`, the error body names the current replacement —
update `GEMINI_MODEL` in `.env` (and the default in `server.py`) to that id. This
already happened once: `gemini-2.5-flash` → `gemini-3.6-flash`.

## Deployment

- GitHub: `github.com/acew0rk/script-generator`, branch `main`.
- Render reads `render.yaml` (a Blueprint): `plan: free`,
  `buildCommand: pip install -r requirements.txt` (required — a blueprint deploy
  runs no build step without it, so `yt-dlp` silently won't install),
  `healthCheckPath: /healthz`. The three secrets (`GEMINI_API_KEY`,
  `APP_PASSWORD`, `ELEVENLABS_API_KEY`) are `sync: false` and entered in the
  Render dashboard, not committed.
- **Push to `main` → Render auto-redeploys.** Changes to `render.yaml` itself
  (e.g. `buildCommand`) may need a **Manual sync** on the Render Blueprint page
  before they take effect.
- Free tier sleeps after ~15 min idle; first request then takes ~50s.
