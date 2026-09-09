#!/usr/bin/env python3
"""Local web app: turn an MCAT video transcript into a narrator script.

Uses Google's Gemini API (free tier -- no credit card). Standard library only.

Run:  python3 server.py
Then open http://localhost:3000   (Ctrl+C to stop)
"""

import base64
import datetime
import glob
import hmac
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")

ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
MAX_BODY_BYTES = 15 * 1024 * 1024
REQUEST_TIMEOUT = 300  # seconds


def load_dotenv(path):
    """Minimal .env loader: KEY=VALUE per line. Does not override real env vars."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv(os.path.join(BASE_DIR, ".env"))

from system_prompt import SYSTEM_PROMPT  # noqa: E402  (after load_dotenv on purpose)

MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")
PORT = int(os.environ.get("PORT", "3000"))
HOST = os.environ.get("HOST", "127.0.0.1")
API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
# If set, the whole site is gated behind this password (HTTP Basic Auth).
# Leave empty for local use; set it on the hosted deployment.
APP_PASSWORD = os.environ.get("APP_PASSWORD", "").strip()
# Optional. Enables the "paste a link" flow: yt-dlp downloads the video, then
# ElevenLabs speech-to-text transcribes it. Without this key, only the
# paste-a-transcript flow works.
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "").strip()
ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"
ELEVENLABS_MODEL = os.environ.get("ELEVENLABS_MODEL", "scribe_v1")
# Optional. When all three are set, every generated script also creates a row in
# this Airtable table (best-effort -- a failure never blocks the script).
AIRTABLE_API_KEY = os.environ.get("AIRTABLE_API_KEY", "").strip()
AIRTABLE_BASE_ID = os.environ.get("AIRTABLE_BASE_ID", "").strip()
AIRTABLE_TABLE = os.environ.get("AIRTABLE_TABLE", "").strip()  # table id or name
GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent" % MODEL
)


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def call_gemini(transcript, image):
    parts = []
    if image is not None:
        media_type = image.get("media_type")
        data = image.get("data")
        if media_type not in ALLOWED_IMAGE_TYPES or not isinstance(data, str) or not data:
            raise ApiError(
                400, "Image must be a base64 PNG, JPEG, WebP, or GIF. Try re-attaching it."
            )
        parts.append({"inlineData": {"mimeType": media_type, "data": data}})
    parts.append({"text": transcript})

    if not API_KEY:
        raise ApiError(
            401,
            "GEMINI_API_KEY is not set. Get a free key at "
            "https://aistudio.google.com/apikey and add it to your .env file, then restart.",
        )

    payload = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"temperature": 1, "maxOutputTokens": 20000},
    }

    req = urllib.request.Request(
        GEMINI_URL,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"content-type": "application/json", "x-goog-api-key": API_KEY},
    )

    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise ApiError(exc.code, _describe_http_error(exc))
    except urllib.error.URLError as exc:
        raise ApiError(502, "Could not reach the Gemini API: %s" % exc.reason)
    except json.JSONDecodeError:
        raise ApiError(502, "The Gemini API returned an unreadable response.")

    block = body.get("promptFeedback", {}).get("blockReason")
    if block:
        raise ApiError(422, "Gemini blocked this request (%s)." % block)

    candidates = body.get("candidates") or []
    if not candidates:
        raise ApiError(502, "Gemini returned no output. Try again.")

    cand = candidates[0]
    finish = cand.get("finishReason")
    script = "".join(
        part.get("text", "") for part in cand.get("content", {}).get("parts", [])
    ).strip()

    # Defensive: drop a leading "Short Video Script" title if the model adds one anyway.
    script = re.sub(
        r"^\s*(?:#{1,6}\s*|\*\*)?\s*short video script\s*(?:\*\*)?\s*\n+",
        "",
        script,
        count=1,
        flags=re.IGNORECASE,
    ).strip()

    if not script:
        if finish and finish != "STOP":
            raise ApiError(422, "Gemini stopped early (%s) with no usable text." % finish)
        raise ApiError(502, "Gemini returned an empty response. Try again.")

    return {"script": script, "model": MODEL, "truncated": finish == "MAX_TOKENS"}


def _describe_http_error(exc):
    detail = ""
    try:
        parsed = json.loads(exc.read().decode("utf-8"))
        detail = parsed.get("error", {}).get("message", "")
    except Exception:
        pass
    if exc.code in (400, 403) and ("API key" in detail or "API_KEY" in detail):
        return "Gemini rejected the API key. Check GEMINI_API_KEY in your .env file."
    if exc.code == 429:
        return "Hit Gemini's free-tier rate limit. Wait a minute and try again."
    if detail:
        return "Gemini API error (%s): %s" % (exc.code, detail)
    return "Gemini API error (%s)." % exc.code


# ---- Link -> transcript (yt-dlp download + ElevenLabs speech-to-text) --------

def _short(exc):
    parts = str(exc).strip().splitlines()
    return (parts[-1] if parts else "unknown")[:180]


def _ytdlp_binary():
    """Prefer a standalone yt-dlp binary (self-contained, always current) over the
    pip module. Order: $YTDLP_BIN, ./bin/yt-dlp, yt-dlp on PATH."""
    candidates = [
        os.environ.get("YTDLP_BIN"),
        os.path.join(BASE_DIR, "bin", "yt-dlp"),
        shutil.which("yt-dlp"),
    ]
    for path in candidates:
        if path and os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def _download_media(url):
    """Download the media at `url` with yt-dlp. Returns (file_path, tmpdir)."""
    tmpdir = tempfile.mkdtemp(prefix="mcat-dl-")
    outtmpl = os.path.join(tmpdir, "media.%(ext)s")
    binary = _ytdlp_binary()

    try:
        if binary:
            proc = subprocess.run(
                [binary, "-q", "--no-warnings", "--no-playlist",
                 "-f", "mp4/bestaudio/best", "-o", outtmpl, url],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180,
            )
            if proc.returncode != 0:
                raise RuntimeError(proc.stdout.decode("utf-8", "replace"))
        else:
            try:
                import yt_dlp
            except ImportError:
                shutil.rmtree(tmpdir, ignore_errors=True)
                raise ApiError(
                    501,
                    "Link download needs yt-dlp. Run: pip3 install -r requirements.txt "
                    "(or drop the yt-dlp binary in ./bin/).",
                )
            opts = {
                "outtmpl": outtmpl, "format": "mp4/bestaudio/best",
                "noplaylist": True, "quiet": True, "no_warnings": True,
                "socket_timeout": 60,
            }
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([url])
    except ApiError:
        raise
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise ApiError(
            502,
            "Couldn't download that link (%s). TikTok sometimes blocks this "
            "(more so from a server) -- try again, run the app locally, or paste "
            "the transcript instead." % _short(exc),
        )

    files = glob.glob(os.path.join(tmpdir, "media.*"))
    if not files:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise ApiError(502, "The download produced no file. Paste the transcript instead.")
    return files[0], tmpdir


def _multipart(boundary, fields, file_field, filename, file_bytes):
    out = []
    for name, value in fields.items():
        out.append(("--%s\r\n" % boundary).encode())
        out.append(
            ('Content-Disposition: form-data; name="%s"\r\n\r\n' % name).encode()
        )
        out.append(("%s\r\n" % value).encode())
    out.append(("--%s\r\n" % boundary).encode())
    out.append(
        (
            'Content-Disposition: form-data; name="%s"; filename="%s"\r\n'
            % (file_field, filename)
        ).encode()
    )
    out.append(b"Content-Type: application/octet-stream\r\n\r\n")
    out.append(file_bytes)
    out.append(b"\r\n")
    out.append(("--%s--\r\n" % boundary).encode())
    return b"".join(out)


def transcribe_link(url):
    if not ELEVENLABS_API_KEY:
        raise ApiError(
            501,
            "Link transcription isn't set up here. Paste the transcript instead.",
        )
    if not re.match(r"^https?://", url, re.IGNORECASE):
        raise ApiError(400, "That doesn't look like a link -- paste a full https:// URL.")

    path, tmpdir = _download_media(url)
    try:
        with open(path, "rb") as fh:
            blob = fh.read()
        filename = os.path.basename(path)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    boundary = "----mcat%s" % uuid.uuid4().hex
    body = _multipart(
        boundary,
        fields={"model_id": ELEVENLABS_MODEL, "tag_audio_events": "false"},
        file_field="file",
        filename=filename,
        file_bytes=blob,
    )
    req = urllib.request.Request(
        ELEVENLABS_STT_URL,
        data=body,
        method="POST",
        headers={
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "multipart/form-data; boundary=%s" % boundary,
            "Content-Length": str(len(body)),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            payload = json.loads(exc.read().decode("utf-8"))
            detail = payload.get("detail", "")
            if isinstance(detail, dict):
                detail = detail.get("message", "")
        except Exception:
            pass
        if exc.code in (401, 403):
            raise ApiError(exc.code, "ElevenLabs rejected the API key (check ELEVENLABS_API_KEY).")
        raise ApiError(
            exc.code,
            "ElevenLabs error (%s)%s" % (exc.code, ": " + detail if detail else ""),
        )
    except urllib.error.URLError as exc:
        raise ApiError(502, "Couldn't reach ElevenLabs: %s" % exc.reason)
    except json.JSONDecodeError:
        raise ApiError(502, "ElevenLabs returned an unreadable response.")

    text = (data.get("text") or "").strip()
    if not text:
        raise ApiError(502, "ElevenLabs returned an empty transcript. Try a different link.")
    return text


# ---- Airtable (best-effort: a failure here never blocks the script) ---------

_SOURCE_ACCOUNT_MAP = [
    ("mcat_simplified", "MCAT Simplified"),
    ("mcatsimplified", "MCAT Simplified"),
    ("medschoolcoach", "MedSchoolCoach MCAT Prep"),
]


def _source_account(link):
    low = (link or "").lower()
    for needle, label in _SOURCE_ACCOUNT_MAP:
        if needle in low:
            return label
    return None


def save_to_airtable(link, transcript, script):
    """Create one row. Returns None (not configured), or (ok: bool, detail: str)."""
    if not (AIRTABLE_API_KEY and AIRTABLE_BASE_ID and AIRTABLE_TABLE):
        return None

    fields = {
        "Original Transcript": transcript,
        "Body Script": script,
        "Script Status": "Done",
        "Script Completed At": datetime.datetime.now(datetime.timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "Video Type": "Short Form",
    }
    if link:
        fields["Video URL"] = link
    src = _source_account(link)
    if src:
        fields["Source Account"] = src

    url = "https://api.airtable.com/v0/%s/%s" % (
        AIRTABLE_BASE_ID,
        urllib.parse.quote(AIRTABLE_TABLE, safe=""),
    )
    req = urllib.request.Request(
        url,
        data=json.dumps({"fields": fields, "typecast": True}).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": "Bearer " + AIRTABLE_API_KEY,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            rec = json.loads(resp.read().decode("utf-8"))
        return (True, rec.get("id", ""))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            err = json.loads(exc.read().decode("utf-8")).get("error", {})
            detail = err.get("message") or err.get("type") or "" if isinstance(err, dict) else str(err)
        except Exception:
            pass
        return (False, "Airtable %s%s" % (exc.code, ": " + detail if detail else ""))
    except Exception as exc:  # noqa: BLE001
        return (False, _short(exc))


class Handler(BaseHTTPRequestHandler):
    server_version = "MCATScriptGen/3.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _authed(self):
        if not APP_PASSWORD:
            return True
        header = self.headers.get("Authorization", "")
        if header.startswith("Basic "):
            try:
                decoded = base64.b64decode(header[6:]).decode("utf-8", "replace")
            except Exception:
                return False
            _, _, supplied = decoded.partition(":")
            return hmac.compare_digest(supplied, APP_PASSWORD)
        return False

    def _require_auth(self):
        body = b"Authentication required."
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="MCAT Script Generator"')
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status, obj):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _send_file(self, rel_path):
        if rel_path in ("", "/"):
            rel_path = "index.html"
        rel_path = rel_path.lstrip("/")
        full = os.path.normpath(os.path.join(PUBLIC_DIR, rel_path))
        if full != PUBLIC_DIR and not full.startswith(PUBLIC_DIR + os.sep):
            self._send_json(403, {"error": "Forbidden"})
            return
        if not os.path.isfile(full):
            self._send_json(404, {"error": "Not found"})
            return
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            self._send_json(200, {"ok": True})
            return
        if not self._authed():
            self._require_auth()
            return
        self._send_file(path)

    def _read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            self._send_json(400, {"error": "Request body missing or too large."})
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._send_json(400, {"error": "Invalid JSON body."})
            return None

    def _fail(self, exc):
        if isinstance(exc, ApiError):
            status = exc.status if 400 <= exc.status < 600 else 500
            self._send_json(status, {"error": exc.message})
        else:
            sys.stderr.write("Unexpected error: %r\n" % exc)
            self._send_json(500, {"error": "Unexpected server error. Check the logs."})

    def do_POST(self):
        if not self._authed():
            self._require_auth()
            return
        path = self.path.split("?", 1)[0]
        if path == "/api/generate":
            self._handle_generate()
        elif path == "/api/from-link":
            self._handle_from_link()
        else:
            self._send_json(404, {"error": "Not found"})

    def _handle_generate(self):
        data = self._read_json_body()
        if data is None:
            return

        transcript = data.get("transcript")
        if not isinstance(transcript, str) or not transcript.strip():
            self._send_json(400, {"error": "Transcript is required."})
            return

        image = data.get("image")
        if image is not None and not isinstance(image, dict):
            self._send_json(400, {"error": "Invalid image payload."})
            return

        transcript = transcript.strip()
        try:
            result = call_gemini(transcript, image)
        except Exception as exc:  # noqa: BLE001
            self._fail(exc)
            return

        _attach_airtable(result, None, transcript, result["script"])
        self._send_json(200, result)

    def _handle_from_link(self):
        data = self._read_json_body()
        if data is None:
            return

        link = data.get("link")
        if not isinstance(link, str) or not link.strip():
            self._send_json(400, {"error": "Paste a link first."})
            return
        link = link.strip()

        try:
            transcript = transcribe_link(link)
            result = call_gemini(transcript, None)
        except Exception as exc:  # noqa: BLE001
            self._fail(exc)
            return

        result["transcript"] = transcript
        _attach_airtable(result, link, transcript, result["script"])
        self._send_json(200, result)


def _attach_airtable(result, link, transcript, script):
    outcome = save_to_airtable(link, transcript, script)
    if outcome is None:
        return
    ok, detail = outcome
    result["airtable"] = {"ok": ok, "detail": detail}
    if not ok:
        sys.stderr.write("Airtable write failed: %s\n" % detail)


def main():
    if not API_KEY:
        sys.stderr.write(
            "\n[warn] GEMINI_API_KEY is not set. Get a free key at "
            "https://aistudio.google.com/apikey, copy .env.example to .env, and add it.\n\n"
        )
    mimetypes.add_type("text/javascript", ".js")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    where = "http://localhost:%d" % PORT if HOST in ("127.0.0.1", "localhost") else "port %d" % PORT
    print("MCAT script generator running at %s" % where)
    print("Model: %s" % MODEL)
    print("Password gate: %s" % ("ON" if APP_PASSWORD else "off"))
    print("Airtable: %s" % ("ON" if (AIRTABLE_API_KEY and AIRTABLE_BASE_ID and AIRTABLE_TABLE) else "off"))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
