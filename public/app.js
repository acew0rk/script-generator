"use strict";

const HISTORY_KEY = "mcat-scripts-history";
const HISTORY_LIMIT = 500;
const MAX_BATCH = 200;

const els = {
  link: document.getElementById("link"),
  linkBtn: document.getElementById("link-btn"),
  linkStatus: document.getElementById("link-status"),
  results: document.getElementById("batch-progress"),
  transcript: document.getElementById("transcript"),
  generateBtn: document.getElementById("generate-btn"),
  status: document.getElementById("status"),
  newBtn: document.getElementById("new-btn"),
  historyList: document.getElementById("history-list"),
  historyEmpty: document.getElementById("history-empty"),
  fixPanel: document.getElementById("fix-panel"),
  fixClose: document.getElementById("fix-close"),
  fixLink: document.getElementById("fix-link"),
  fixQa: document.getElementById("fix-qa"),
  fixTranscript: document.getElementById("fix-transcript"),
  fixBtn: document.getElementById("fix-btn"),
  fixStatus: document.getElementById("fix-status"),
  fixDropzone: document.getElementById("fix-dropzone"),
  fixDropzoneText: document.getElementById("fix-dropzone-text"),
  fixImageInput: document.getElementById("fix-image-input"),
  fixImagePreview: document.getElementById("fix-image-preview"),
  fixImageThumb: document.getElementById("fix-image-thumb"),
  fixImageRemove: document.getElementById("fix-image-remove"),
};

let fixingId = null; // history entry id currently open in the fix panel
let fixImage = null; // { media_type, data }

/* ---------- helpers ---------- */

function parseLinks(raw) {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

function shortUrl(u) {
  try {
    const p = new URL(u);
    return (p.host + p.pathname).replace(/^www\./, "").slice(0, 70);
  } catch {
    return String(u).slice(0, 70);
  }
}

// Identity for "already done?" checks — ignores TikTok's ?_r/?_t tracking params.
function linkKey(u) {
  try {
    const p = new URL(u);
    return (p.host + p.pathname)
      .replace(/^www\./, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  } catch {
    return String(u).trim().toLowerCase();
  }
}

function doneKeys() {
  const set = new Set();
  for (const it of loadHistory()) if (it.source) set.add(linkKey(it.source));
  return set;
}

function setBusy(busy) {
  els.linkBtn.disabled = busy;
  els.generateBtn.disabled = busy;
}

/* ---------- results list ---------- */

function addResultRow(labelText) {
  const li = document.createElement("li");
  li.className = "batch-row";
  const label = document.createElement("span");
  label.className = "batch-url";
  label.textContent = labelText;
  const state = document.createElement("span");
  state.className = "batch-state";
  state.textContent = "queued";
  li.append(label, state);
  els.results.appendChild(li);
  return li;
}

function setResultRow(li, kind, text, href) {
  const state = li.querySelector(".batch-state");
  state.textContent = "";
  li.classList.remove("run", "ok", "err", "warn");
  li.classList.add(kind);
  if (href) {
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = text;
    state.appendChild(a);
  } else {
    state.textContent = text;
  }
}

/* ---------- generate from link(s) ---------- */

async function generateFromLinks() {
  const pasted = parseLinks(els.link.value);
  if (!pasted.length) {
    els.link.focus();
    return;
  }

  // Drop duplicates within the paste, and anything already in history.
  const already = doneKeys();
  const seen = new Set();
  const links = [];
  let skipped = 0;
  for (const u of pasted) {
    const k = linkKey(u);
    if (seen.has(k)) continue;
    seen.add(k);
    if (already.has(k)) skipped += 1;
    else links.push(u);
  }

  if (!links.length) {
    els.linkStatus.textContent = skipped
      ? `All ${skipped} already done — nothing new. Delete a row from the list on the left to redo it.`
      : "";
    return;
  }
  if (links.length > MAX_BATCH) {
    els.linkStatus.textContent = `${links.length} new links — ${MAX_BATCH} max per run.`;
    return;
  }

  els.results.hidden = false;
  els.results.innerHTML = "";
  if (skipped) {
    const li = addResultRow(`${skipped} already done`);
    setResultRow(li, "ok", "skipped");
  }
  const rows = links.map((u) => addResultRow(shortUrl(u)));

  setBusy(true);
  let done = 0;

  for (let i = 0; i < links.length; i++) {
    const url = links[i];
    setResultRow(rows[i], "run", "working…");
    els.linkStatus.textContent = `Processing ${i + 1} of ${links.length}…`;

    try {
      const res = await fetch("/api/from-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ link: url }),
      });
      const data = await res.json();

      if (!res.ok) {
        setResultRow(rows[i], "err", data.error || `failed (${res.status})`);
        continue;
      }
      done += 1;
      recordResult(rows[i], { source: url, ...data });
    } catch {
      setResultRow(rows[i], "err", "server unreachable");
    }
  }

  setBusy(false);
  els.linkStatus.textContent =
    `${done} of ${links.length} done` + (skipped ? `, ${skipped} skipped` : "");
}

/* ---------- generate from a pasted transcript ---------- */

async function generateFromTranscript() {
  const transcript = els.transcript.value.trim();
  if (!transcript) {
    els.transcript.focus();
    return;
  }

  els.results.hidden = false;
  els.results.innerHTML = "";
  const row = addResultRow("pasted transcript");
  setResultRow(row, "run", "working…");
  setBusy(true);
  els.status.textContent = "Generating…";

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript }),
    });
    const data = await res.json();
    if (!res.ok) {
      setResultRow(row, "err", data.error || `failed (${res.status})`);
    } else {
      recordResult(row, { source: "", transcript, ...data });
      els.transcript.value = "";
    }
  } catch {
    setResultRow(row, "err", "server unreachable");
  }

  setBusy(false);
  els.status.textContent = "";
}

/* ---------- shared: react to one result ---------- */

function recordResult(row, data) {
  const at = data.airtable || null;
  const url = at && at.ok ? at.url || "" : "";

  if (data.signal) {
    setResultRow(row, "warn", "⚠ " + data.signal + " — not added to Airtable");
  } else if (at && at.ok) {
    setResultRow(row, "ok", "✓ added to Airtable ↗", url || undefined);
  } else if (at && !at.ok) {
    setResultRow(row, "warn", "script made, Airtable failed: " + (at.detail || ""));
  } else {
    setResultRow(row, "ok", "✓ script generated");
  }

  saveToHistory({
    id: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    title:
      shortUrl(data.source) ||
      (data.transcript || data.script || "").replace(/\s+/g, " ").trim().slice(0, 60) ||
      "Untitled",
    source: data.source || "",
    script: data.script || "",
    transcript: data.transcript || "",
    airtableUrl: url,
    signal: data.signal || "",
  });
}

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
    /* storage unavailable */
  }
}

function saveToHistory(entry) {
  const items = loadHistory();
  items.unshift(entry);
  persistHistory(items.slice(0, HISTORY_LIMIT));
  renderHistory();
}

function deleteHistory(id) {
  persistHistory(loadHistory().filter((it) => it.id !== id));
  renderHistory();
}

function updateHistoryItem(id, patch) {
  const items = loadHistory().map((it) => (it.id === id ? { ...it, ...patch } : it));
  persistHistory(items);
  renderHistory();
}

/* ---------- fix panel (re-run a flagged video with the question added) ---------- */

function readFixImage(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    const result = String(reader.result);
    fixImage = {
      media_type: file.type === "image/jpg" ? "image/jpeg" : file.type,
      data: result.slice(result.indexOf(",") + 1),
    };
    els.fixImageThumb.src = result;
    els.fixImagePreview.hidden = false;
    els.fixDropzoneText.hidden = true;
  };
  reader.readAsDataURL(file);
}

function clearFixImage() {
  fixImage = null;
  els.fixImageInput.value = "";
  els.fixImageThumb.removeAttribute("src");
  els.fixImagePreview.hidden = true;
  els.fixDropzoneText.hidden = false;
}

function openFix(item) {
  fixingId = item.id;
  clearFixImage();
  els.fixLink.textContent = item.source || "(no link — pasted transcript)";
  els.fixQa.value = "";
  els.fixTranscript.value = item.transcript || "";
  els.fixStatus.textContent = item.signal ? item.signal : "";
  els.fixPanel.hidden = false;
  els.fixPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  els.fixQa.focus();
}

async function submitFix() {
  const item = loadHistory().find((it) => it.id === fixingId);
  if (!item) {
    els.fixPanel.hidden = true;
    return;
  }
  const qa = els.fixQa.value.trim();
  const transcript = els.fixTranscript.value.trim();
  if (!qa && !fixImage) {
    els.fixStatus.textContent = "Add the question + answer choices (text or screenshot) first.";
    els.fixQa.focus();
    return;
  }

  const combined = qa
    ? transcript + "\n\n---\nQuestion and answer choices:\n" + qa
    : transcript;

  els.fixBtn.disabled = true;
  els.fixStatus.textContent = "Regenerating…";

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: combined,
        image: fixImage || undefined,
        link: item.source || undefined,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      els.fixStatus.textContent = data.error || `Failed (${res.status}).`;
      return;
    }
    if (data.signal) {
      els.fixStatus.textContent =
        data.signal + " — the question/choices still aren't clear. Add more detail or a screenshot.";
      return;
    }

    const url = data.airtable && data.airtable.ok ? data.airtable.url || "" : "";
    updateHistoryItem(item.id, {
      script: data.script || item.script,
      transcript: combined,
      airtableUrl: url,
      signal: "",
    });
    els.fixStatus.textContent = url ? "✓ Fixed — added to Airtable." : "✓ Regenerated.";
    setTimeout(() => {
      if (fixingId === item.id) els.fixPanel.hidden = true;
    }, 1500);
  } catch {
    els.fixStatus.textContent = "Could not reach the server.";
  } finally {
    els.fixBtn.disabled = false;
  }
}

els.fixBtn.addEventListener("click", submitFix);
els.fixClose.addEventListener("click", () => {
  els.fixPanel.hidden = true;
  fixingId = null;
});
els.fixDropzone.addEventListener("click", (e) => {
  if (e.target === els.fixImageRemove) return;
  els.fixImageInput.click();
});
els.fixImageInput.addEventListener("change", () => readFixImage(els.fixImageInput.files[0]));
els.fixImageRemove.addEventListener("click", (e) => {
  e.stopPropagation();
  clearFixImage();
});
els.fixDropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.fixDropzone.classList.add("dragover");
});
els.fixDropzone.addEventListener("dragleave", () => els.fixDropzone.classList.remove("dragover"));
els.fixDropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  els.fixDropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length) readFixImage(e.dataTransfer.files[0]);
});
els.fixQa.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (item) {
    e.preventDefault();
    readFixImage(item.getAsFile());
  }
});

function renderHistory() {
  const items = loadHistory();
  els.historyEmpty.hidden = items.length > 0;
  els.historyList.innerHTML = "";

  for (const item of items) {
    const li = document.createElement("li");
    li.className = "history-item";

    const del = document.createElement("button");
    del.className = "del";
    del.type = "button";
    del.textContent = "×";
    del.title = "Remove from list";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteHistory(item.id);
    });

    const titleEl = document.createElement("div");
    titleEl.className = "title";
    titleEl.textContent = item.title;

    const metaEl = document.createElement("div");
    metaEl.className = "meta";
    const when = new Date(item.ts).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    metaEl.textContent =
      when +
      " · " +
      (item.signal ? "flagged" : item.airtableUrl ? "in Airtable" : "local only");

    li.append(del, titleEl, metaEl);
    if (item.signal) {
      li.classList.add("linked", "flagged");
      li.title = "Add the question + answer choices and regenerate";
      li.addEventListener("click", () => openFix(item));
    } else if (item.airtableUrl) {
      li.classList.add("linked");
      li.title = "Open in Airtable";
      li.addEventListener("click", () => window.open(item.airtableUrl, "_blank", "noopener"));
    }
    els.historyList.appendChild(li);
  }
}

/* ---------- wiring ---------- */

els.linkBtn.addEventListener("click", generateFromLinks);
els.link.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) generateFromLinks();
});
els.generateBtn.addEventListener("click", generateFromTranscript);

els.newBtn.addEventListener("click", () => {
  els.link.value = "";
  els.transcript.value = "";
  els.linkStatus.textContent = "";
  els.status.textContent = "";
  els.results.innerHTML = "";
  els.results.hidden = true;
  els.fixPanel.hidden = true;
  fixingId = null;
  els.link.focus();
});

renderHistory();
