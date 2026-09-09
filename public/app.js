"use strict";

const HISTORY_KEY = "mcat-scripts-history";
const HISTORY_LIMIT = 100;
const MAX_BATCH = 20;

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
};

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
  const links = parseLinks(els.link.value);
  if (!links.length) {
    els.link.focus();
    return;
  }
  if (links.length > MAX_BATCH) {
    els.linkStatus.textContent = `Too many — ${MAX_BATCH} or fewer at a time.`;
    return;
  }

  els.results.hidden = false;
  els.results.innerHTML = "";
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
  els.linkStatus.textContent = `${done} of ${links.length} done`;
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
    if (item.airtableUrl) {
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
  els.link.focus();
});

renderHistory();
