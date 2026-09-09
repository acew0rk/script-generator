# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-purpose web app for turning MCAT short-video content into a narrator
script. Two input paths:

1. **Paste TikTok link(s)** (primary) → `POST /api/from-link`, one request per
   link → `yt-dlp` downloads the video → ElevenLabs `speech-to-text` transcribes
   it → Gemini writes the script → the row is written to Airtable.
   **Batch is frontend-only**: `app.js` splits the textarea on whitespace and
   loops the single-link endpoint sequentially (`MAX_BATCH` 20). No server-side
   batch endpoint.
2. **Paste a transcript** (fallback, collapsed `<details>`) → `POST /api/generate`
   → Gemini → Airtable. For when a download fails or the transcript came from
   elsewhere (transcript365).

The generated transcript/script are **not displayed** — the on-page output is a
results list where each row links to the new Airtable record. Review happens in
Airtable. Runs locally for the owner and is also deployed publicly
(password-gated) on Render.

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

- **`server.py`** — a `ThreadingHTTPServer` with one `Handler`. Routes: static
  files from `public/` (path-traversal guarded), `POST /api/from-link`
  (`{link}` → `transcribe_link()` → `call_gemini()` → `_finish()`), and
  `POST /api/generate` (`{transcript, image?}` → `call_gemini()` → `_finish()`).
  `call_gemini()` builds the Gemini `v1beta/models/{MODEL}:generateContent` REST
  payload by hand and sends it with `urllib.request` (`x-goog-api-key` header);
  it still accepts an `image` (`{media_type, data}` → Gemini `inlineData`) even
  though the current UI never sends one. All error paths raise `ApiError(status,
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
- **`public/`** — vanilla HTML/CSS/JS, no framework, no bundler. The UI is
  **link-first and output-light**: a textarea for TikTok link(s) → `app.js` loops
  `/api/from-link` sequentially and renders a per-link results list, each `✓` row
  linking straight to the new Airtable record. The generated transcript/script are
  **not shown on the page** — they live in Airtable. A collapsed `<details>` holds
  a paste-a-transcript fallback (`/api/generate`) for when a download fails.
  The sidebar is a **client-side log** in `localStorage` (`mcat-scripts-history`):
  title + status, click-through to Airtable when a row was saved. It keeps the
  full script/transcript as a local backup but never displays them.

### Auth model

When `APP_PASSWORD` is set, `_authed()` gates every request except `GET /healthz`
(left open for Render's health check). Browsers prompt natively; users enter a
blank username + the password. There are no sessions or cookies.

### Output post-processing

The prompt tells the model not to emit a "Short Video Script" title; `call_gemini()`
*also* strips a leading one defensively with a regex. The prompt (rule 11) forbids
LaTeX / math notation because the script is read aloud; `_strip_latex()` is the
backstop — it only fires when the text actually contains markup and converts the
common tokens (`\times`, `^{-9}`, `$...$`, …) to spoken words, leaving plain "$5"
money alone.

`call_gemini()` retries 429/5xx up to 4 times (3s/6s/9s) — the free tier throttles
per-minute *and* per-day. Once the daily quota is spent, retries can't help and
every generation fails until it resets (~midnight Pacific). There is no paid
billing or multi-provider fallback wired up.

### `_finish()` — signal phrases + Airtable

Runs after every successful generation on both routes. If the script contains a
"signal phrase" from the prompt (`I NEED THE QUESTIONS AND ANSWER CHOICES`,
`DO NOT ADD THIS TO THE DATABASE`) it sets `result["signal"]` and **skips Airtable**
— those aren't real scripts and must not land in the database. Otherwise it calls
`save_to_airtable()` (one `POST .../v0/{base}/{table}` with `typecast: true`)
writing hard-coded field names + values in the owner's "Main Database" table:
`Status`=`Script Complete`, `Script Status`=`Done`, `Source Account`=`MCAT Simplified`,
`Video Type`=`Long & Short Form`, `Original Transcript`, `Body Script`, and
`Video URL` (only when a link was used). Timing fields are deliberately left alone.
The result carries `airtable: {ok, detail, url}` (url = the record's Airtable page).
Best-effort: a failure is reported in that object and never raises. To change the
destination or the field values, edit `save_to_airtable()`.

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
  `healthCheckPath: /healthz`. `HOST` and `GEMINI_MODEL` have literal values; the
  rest (`GEMINI_API_KEY`, `APP_PASSWORD`, `ELEVENLABS_API_KEY`,
  `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE`) are `sync: false` —
  entered in the Render dashboard, not committed.
- **Push to `main` → Render auto-redeploys.** Changes to `render.yaml` itself
  (e.g. `buildCommand`) may need a **Manual sync** on the Render Blueprint page
  before they take effect.
- Free tier sleeps after ~15 min idle; first request then takes ~50s.
