# MCAT Script Generator

A small local web app that turns a short MCAT video transcript into a polished
narrator script. Paste the transcript (optionally attach a screenshot of the
question and answer choices), click **Generate script**, and get the finished
`### Short Video Script` back — formatted, with a one-click copy button.

Runs on **Google's Gemini API free tier** — no credit card, no cost.
The instruction prompt lives on the server ([system_prompt.py](system_prompt.py)),
so you never paste it again.

## Two ways to make a script

1. **Paste a transcript** → Generate. Free (Gemini).
2. **Paste a TikTok link** → it downloads the video, transcribes it with
   ElevenLabs, then writes the script. Needs an ElevenLabs key (paid, per-minute).
   The transcript lands in the box so you can fix misheard terms and regenerate.

## Setup

Requires Python 3 (3.10+ recommended; 3.9 works with warnings).

```bash
cp .env.example .env
pip3 install -r requirements.txt   # installs yt-dlp, for the link feature
```

1. Get a free Gemini API key at <https://aistudio.google.com/apikey>
   (sign in with a Google account, click "Create API key" — no billing setup).
2. Edit `.env`:
   ```
   GEMINI_API_KEY=AQ...            # required
   ELEVENLABS_API_KEY=sk_...       # optional, only for the TikTok-link feature
   ```

## Run

```bash
python3 server.py
```

Open <http://localhost:3000>. Press `Ctrl+C` to stop.

## Notes

- **Model** — defaults to `gemini-3.6-flash`. Override with `GEMINI_MODEL` in `.env`
  if Google publishes a newer one.
- **Free-tier limits** — a limited number of requests per minute / per day. If you
  hit the limit the app shows a "wait a minute" message.
- **Privacy** — on the free tier, Google may use prompts and responses to improve
  their products. Don't paste anything you wouldn't want used that way.
- **History** — generated scripts are saved in your browser (localStorage) and
  listed in the sidebar. Nothing is stored on the server.
- **Signal phrases** — if the model replies with
  `I NEED THE QUESTIONS AND ANSWER CHOICES` or `DO NOT ADD THIS TO THE DATABASE`,
  a banner highlights it above the output.

## Sharing it with other people (deploy to Render, free)

The steps are in [DEPLOY.md](DEPLOY.md). In short: put this folder on GitHub, then
point Render at it. Secret values on Render:

- `GEMINI_API_KEY` — your key
- `APP_PASSWORD` — a password anyone must type before the site works
- `ELEVENLABS_API_KEY` — optional; the TikTok-link feature often fails from a
  hosted server anyway (TikTok blocks datacenter IPs), so it's most reliable when
  you run the app locally

Locally, leave `APP_PASSWORD` empty in `.env` and there's no password prompt.

## Files

| File | Purpose |
|---|---|
| `server.py` | Standard-library HTTP server + Gemini API call + optional password gate |
| `system_prompt.py` | The fixed instruction prompt |
| `public/` | The web page (HTML/CSS/JS) |
| `render.yaml` | Render deployment config |
| `DEPLOY.md` | Step-by-step hosting instructions |
