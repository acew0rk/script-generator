"use strict";

const HISTORY_KEY = "mcat-scripts-history";
const HISTORY_LIMIT = 50;
const SIGNAL_PHRASES = [
  "I NEED THE QUESTIONS AND ANSWER CHOICES",
  "DO NOT ADD THIS TO THE DATABASE",
];

const els = {
  transcript: document.getElementById("transcript"),
  dropzone: document.getElementById("dropzone"),
  dropzoneText: document.getElementById("dropzone-text"),
  imageInput: document.getElementById("image-input"),
  imagePreview: document.getElementById("image-preview"),
  imageThumb: document.getElementById("image-thumb"),
  imageRemove: document.getElementById("image-remove"),
  generateBtn: document.getElementById("generate-btn"),
  status: document.getElementById("status"),
  copyBtn: document.getElementById("copy-btn"),
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

function setBusy(busy) {
  els.generateBtn.disabled = busy;
  els.status.textContent = busy ? "Generating…" : "";
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

els.copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentScript);
    els.copyBtn.textContent = "Copied";
    setTimeout(() => (els.copyBtn.textContent = "Copy"), 1500);
  } catch {
    els.copyBtn.textContent = "Copy failed";
    setTimeout(() => (els.copyBtn.textContent = "Copy"), 1500);
  }
});

els.newBtn.addEventListener("click", () => {
  activeId = null;
  currentScript = "";
  els.transcript.value = "";
  clearImage();
  showBanner("", null);
  els.copyBtn.hidden = true;
  els.output.innerHTML = '<p class="placeholder">The generated script will appear here.</p>';
  renderHistory();
  els.transcript.focus();
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
  els.transcript.value = item.transcript;
  clearImage();
  showScript(item.script, false);
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
