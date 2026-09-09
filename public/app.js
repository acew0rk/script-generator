"use strict";

const HISTORY_KEY = "mcat-scripts-history";
const HISTORY_LIMIT = 50;
const SIGNAL_PHRASES = [
  "I NEED THE QUESTIONS AND ANSWER CHOICES",
  "DO NOT ADD THIS TO THE DATABASE",
];

const els = {
  link: document.getElementById("link"),
  linkBtn: document.getElementById("link-btn"),
  linkStatus: document.getElementById("link-status"),
  batchProgress: document.getElementById("batch-progress"),
  transcript: document.getElementById("transcript"),
  copyTranscriptBtn: document.getElementById("copy-transcript-btn"),
  dropzone: document.getElementById("dropzone"),
  dropzoneText: document.getElementById("dropzone-text"),
  imageInput: document.getElementById("image-input"),
  imagePreview: document.getElementById("image-preview"),
  imageThumb: document.getElementById("image-thumb"),
  imageRemove: document.getElementById("image-remove"),
  generateBtn: document.getElementById("generate-btn"),
  status: document.getElementById("status"),
  copyBtn: document.getElementById("copy-btn"),
  airtableNote: document.getElementById("airtable-note"),
  banner: document.getElementById("banner"),
  output: document.getElementById("output"),
  historyList: document.getElementById("history-list"),
  historyEmpty: document.getElementById("history-empty"),
  newBtn: document.getElementById("new-btn"),
};

let attachedImage = null; // { media_type, data } — data is bare base64
let currentScript = "";
let activeId = null;

/* ---------- tiny markdown renderer (headings, bold, italic, lists) ---------- */

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s) {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push("<p>" + paragraph.map(inline).join("\n") + "</p>");
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);

    if (line.trim() === "") {
      flushParagraph();
      flushList();
    } else if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length, 3);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (ul || ol) {
      flushParagraph();
      const want = ul ? "ul" : "ol";
      if (list && list !== want) flushList();
      if (!list) {
        list = want;
        out.push(`<${list}>`);
      }
      out.push("<li>" + inline((ul || ol)[1]) + "</li>");
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return out.join("\n");
}

/* ---------- image attach ---------- */

function readImageFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    const result = String(reader.result);
    const comma = result.indexOf(",");
    attachedImage = {
      media_type: file.type === "image/jpg" ? "image/jpeg" : file.type,
      data: result.slice(comma + 1),
    };
    els.imageThumb.src = result;
    els.imagePreview.hidden = false;
    els.dropzoneText.hidden = true;
  };
  reader.readAsDataURL(file);
}

function clearImage() {
  attachedImage = null;
  els.imageInput.value = "";
  els.imageThumb.removeAttribute("src");
  els.imagePreview.hidden = true;
  els.dropzoneText.hidden = false;
}

els.dropzone.addEventListener("click", (e) => {
  if (e.target === els.imageRemove) return;
  els.imageInput.click();
});
els.dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    els.imageInput.click();
  }
});
els.imageInput.addEventListener("change", () => readImageFile(els.imageInput.files[0]));
els.imageRemove.addEventListener("click", (e) => {
  e.stopPropagation();
  clearImage();
});

els.dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.dropzone.classList.add("dragover");
});
els.dropzone.addEventListener("dragleave", () =>
  els.dropzone.classList.remove("dragover"),
);
els.dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  els.dropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length) readImageFile(e.dataTransfer.files[0]);
});

els.transcript.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) =>
    i.type.startsWith("image/"),
  );
  if (item) {
    e.preventDefault();
    readImageFile(item.getAsFile());
  }
});

/* ---------- generate ---------- */

async function generate() {
  const transcript = els.transcript.value.trim();
  if (!transcript) {
    els.transcript.focus();
    return;
  }

  setBusy(true);
  showBanner("", null);

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript, image: attachedImage || undefined }),
    });
    const data = await res.json();

    if (!res.ok) {
      showBanner(data.error || `Request failed (${res.status}).`, "error");
      return;
    }

    showScript(data.script, data.truncated);
    showAirtableNote(data.airtable);
    saveToHistory({
      id: String(Date.now()),
      ts: Date.now(),
      transcript,
      hasImage: Boolean(attachedImage),
      script: data.script,
    });
  } catch (err) {
    showBanner("Could not reach the server. Is it still running?", "error");
  } finally {
    setBusy(false);
  }
}

function setBusy(busy, msg) {
  els.generateBtn.disabled = busy;
  els.linkBtn.disabled = busy;
  els.status.textContent = busy ? msg || "Generating…" : "";
}

function updateTranscriptCopy() {
  els.copyTranscriptBtn.hidden = !els.transcript.value.trim();
}

function showAirtableNote(info) {
  if (!info) {
    els.airtableNote.hidden = true;
    return;
  }
  els.airtableNote.hidden = false;
  els.airtableNote.textContent = info.ok
    ? "✓ Saved to Airtable"
    : "⚠ Airtable: " + (info.detail || "not saved");
  els.airtableNote.classList.toggle("err", !info.ok);
}

els.transcript.addEventListener("input", updateTranscriptCopy);

const MAX_BATCH = 20;

function parseLinks(raw) {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

function shortUrl(u) {
  try {
    const p = new URL(u);
    return (p.host + p.pathname).replace(/^www\./, "").slice(0, 64);
  } catch {
    return u.slice(0, 64);
  }
}

function addBatchRow(url) {
  const li = document.createElement("li");
  li.className = "batch-row";
  const label = document.createElement("span");
  label.className = "batch-url";
  label.textContent = shortUrl(url);
  const state = document.createElement("span");
  state.className = "batch-state";
  state.textContent = "queued";
  li.append(label, state);
  li.addEventListener("click", () => {
    if (!li._result) return;
    els.transcript.value = li._result.transcript || "";
    updateTranscriptCopy();
    showScript(li._result.script, li._result.truncated);
    showAirtableNote(li._result.airtable);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  els.batchProgress.appendChild(li);
  return li;
}

function setBatchRow(li, kind, text) {
  li.querySelector(".batch-state").textContent = text;
  li.classList.remove("run", "ok", "err");
  li.classList.add(kind);
}

async function generateFromLink() {
  const links = parseLinks(els.link.value);
  if (!links.length) {
    els.link.focus();
    return;
  }
  if (links.length > MAX_BATCH) {
    showBanner(
      `That's ${links.length} links — do ${MAX_BATCH} or fewer at a time.`,
      "error",
    );
    return;
  }

  showBanner("", null);
  const batch = links.length > 1;
  els.batchProgress.innerHTML = "";
  els.batchProgress.hidden = !batch;
  const rows = batch ? links.map(addBatchRow) : [];

  setBusy(true, batch ? `Processing 0/${links.length}…` : "Downloading & transcribing…");
  els.linkStatus.textContent = batch ? "" : "This can take up to a minute.";

  let done = 0;
  let lastOk = null;

  for (let i = 0; i < links.length; i++) {
    const url = links[i];
    if (batch) setBatchRow(rows[i], "run", "working…");
    els.status.textContent = batch
      ? `Processing ${i + 1}/${links.length}…`
      : "Downloading & transcribing…";

    try {
      const res = await fetch("/api/from-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ link: url }),
      });
      const data = await res.json();

      if (!res.ok) {
        const msg = data.error || `failed (${res.status})`;
        if (batch) setBatchRow(rows[i], "err", msg);
        else showBanner(msg, "error");
        continue;
      }

      done++;
      lastOk = { url, ...data };
      if (batch) {
        rows[i]._result = data;
        const at = data.airtable;
        setBatchRow(
          rows[i],
          "ok",
          at ? (at.ok ? "✓ script + Airtable" : "✓ script (Airtable failed)") : "✓ script",
        );
      }
      saveToHistory({
        id: String(Date.now()) + "-" + i,
        ts: Date.now(),
        transcript: data.transcript || "",
        hasImage: false,
        source: url,
        script: data.script,
      });
    } catch (err) {
      if (batch) setBatchRow(rows[i], "err", "server unreachable");
      else showBanner("Could not reach the server. Is it still running?", "error");
    }
  }

  setBusy(false);
  els.linkStatus.textContent = batch ? `${done} of ${links.length} done` : "";

  if (lastOk) {
    els.transcript.value = lastOk.transcript || "";
    updateTranscriptCopy();
    showScript(lastOk.script, lastOk.truncated);
    showAirtableNote(lastOk.airtable);
  } else if (batch) {
    showBanner("None of the links could be processed.", "error");
  }
}

function showBanner(text, kind) {
  if (!text) {
    els.banner.hidden = true;
    els.banner.textContent = "";
    return;
  }
  els.banner.hidden = false;
  els.banner.textContent = text;
  els.banner.classList.toggle("error", kind === "error");
}

function showScript(script, truncated) {
  currentScript = script;
  els.output.innerHTML = renderMarkdown(script);
  els.copyBtn.hidden = false;

  const hit = SIGNAL_PHRASES.find((p) => script.includes(p));
  if (hit === "I NEED THE QUESTIONS AND ANSWER CHOICES") {
    showBanner(
      "The model needs the question and answer choices — attach a screenshot and generate again.",
      "warn",
    );
  } else if (hit === "DO NOT ADD THIS TO THE DATABASE") {
    showBanner(
      "The transcript looks cut off. Do not add this one to the database.",
      "warn",
    );
  } else if (truncated) {
    showBanner("The script was cut off at the length limit — try generating again.", "warn");
  } else {
    showBanner("", null);
  }
}

els.generateBtn.addEventListener("click", generate);
els.linkBtn.addEventListener("click", generateFromLink);
els.link.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) generateFromLink();
});

async function copyToButton(text, btn) {
  try {
    await navigator.clipboard.writeText(text || "");
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy"), 1500);
}

els.copyBtn.addEventListener("click", () => copyToButton(currentScript, els.copyBtn));
els.copyTranscriptBtn.addEventListener("click", () =>
  copyToButton(els.transcript.value, els.copyTranscriptBtn),
);

els.newBtn.addEventListener("click", () => {
  activeId = null;
  currentScript = "";
  els.link.value = "";
  els.linkStatus.textContent = "";
  els.batchProgress.innerHTML = "";
  els.batchProgress.hidden = true;
  els.transcript.value = "";
  updateTranscriptCopy();
  clearImage();
  showBanner("", null);
  showAirtableNote(null);
  els.copyBtn.hidden = true;
  els.output.innerHTML = '<p class="placeholder">The generated script will appear here.</p>';
  renderHistory();
  els.link.focus();
});

/* ---------- history (localStorage) ---------- */

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistHistory(items) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
  } catch {
    /* storage unavailable — history just won't persist */
  }
}

function saveToHistory(entry) {
  const items = loadHistory();
  items.unshift(entry);
  persistHistory(items.slice(0, HISTORY_LIMIT));
  activeId = entry.id;
  renderHistory();
}

function deleteHistory(id) {
  persistHistory(loadHistory().filter((it) => it.id !== id));
  if (activeId === id) activeId = null;
  renderHistory();
}

function openHistory(id) {
  const item = loadHistory().find((it) => it.id === id);
  if (!item) return;
  activeId = id;
  els.transcript.value = item.transcript || "";
  updateTranscriptCopy();
  clearImage();
  showScript(item.script, false);
  showAirtableNote(null);
  renderHistory();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderHistory() {
  const items = loadHistory();
  els.historyEmpty.hidden = items.length > 0;
  els.historyList.innerHTML = "";

  for (const item of items) {
    const li = document.createElement("li");
    li.className = "history-item" + (item.id === activeId ? " active" : "");
    li.tabIndex = 0;

    const title =
      (item.transcript || "").replace(/\s+/g, " ").trim().slice(0, 60) || "Untitled";
    const when = new Date(item.ts).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

    const del = document.createElement("button");
    del.className = "del";
    del.type = "button";
    del.textContent = "×";
    del.title = "Delete";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteHistory(item.id);
    });

    const titleEl = document.createElement("div");
    titleEl.className = "title";
    titleEl.textContent = title;

    const metaEl = document.createElement("div");
    metaEl.className = "meta";
    metaEl.textContent = when + (item.hasImage ? " · image" : "");

    li.append(del, titleEl, metaEl);
    li.addEventListener("click", () => openHistory(item.id));
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter") openHistory(item.id);
    });
    els.historyList.appendChild(li);
  }
}

renderHistory();
updateTranscriptCopy();
