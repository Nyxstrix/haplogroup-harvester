/* ============================================================================
 * 23andMe Haplogroup Harvester — popup.js
 * Handles: getting the match list (auto-fetch, file, or paste), building the
 * work queue, driving the background scan loop, live progress/ETA, table
 * preview, and CSV export. The actual fetching/scraping happens in
 * background.js (the service worker) so the scan survives the popup closing.
 * ========================================================================== */

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const fileInput  = $("fileInput");
const dropZone   = $("dropZone");
const dropText   = $("dropText");
const pasteBox   = $("pasteBox");
const pasteBtn   = $("pasteBtn");
const fetchAllBtn= $("fetchAllBtn");
const onlySharedEl= $("onlyShared");
const priorInput = $("priorInput");
const priorHint  = $("priorHint");
const minDelayEl = $("minDelay");
const maxDelayEl = $("maxDelay");
const skipDoneEl = $("skipDone");
const startBtn   = $("startBtn");
const pauseBtn   = $("pauseBtn");
const downloadBtn= $("downloadBtn");
const bar        = $("bar");
const statusLine = $("statusLine");
const statusSub  = $("statusSub");
const statePill  = $("statePill");
const resultBody = $("resultBody");
const resultCount= $("resultCount");

let queue = [];        // [{ profileId, name, sex, relationship, share, birthplace, surnames, url }]
let fileLoaded = false;
let priorResults = []; // rows loaded from a previous results CSV (to skip + merge)

// ============================================================================
// One-click: fetch all my matches straight from 23andMe
// ============================================================================
fetchAllBtn.addEventListener("click", () => {
  fetchAllBtn.disabled = true;
  fetchAllBtn.textContent = "Fetching…";
  statusLine.textContent = "Fetching your matches from 23andMe…";
  statusSub.textContent = "Paging through DNA Relatives — this can take a moment.";

  getSelfIdFromTabs((selfId) => {
    chrome.runtime.sendMessage({ type: "FETCH_RELATIVES", selfId, onlyShared: !!(onlySharedEl && onlySharedEl.checked) }, (resp) => {
      fetchAllBtn.disabled = false;
      fetchAllBtn.textContent = "Fetch all my matches";

      if (chrome.runtime.lastError) {
        queueFailed("Background worker not reachable — reload the extension and try again.");
        return;
      }
      if (!resp || !resp.ok) {
        queueFailed((resp && resp.error) || "Couldn't fetch matches.");
        return;
      }
      const rels = resp.relatives || [];
      if (!rels.length) {
        queueFailed("No matches returned. Open your DNA Relatives page (logged in) and try again.");
        return;
      }
      queue = rels.map((r) => ({
        profileId: r.profileId,
        name: r.name || "Unknown",
        sex: r.sex || "",
        relationship: r.relationship || "",
        share: r.share || "",
        birthplace: r.birthplace || "",
        surnames: r.surnames || "",
        url: buildUrl(r.profileId, ""),
      }));
      queueLoaded(`${queue.length} matches fetched from 23andMe`);
    });
  });
});

// Try to read the logged-in user's own profile id from an open 23andMe tab
// (helps the background pick the right relatives endpoint). Falls back to "".
function getSelfIdFromTabs(cb) {
  try {
    chrome.tabs.query({ url: "*://*.23andme.com/*" }, (tabs) => {
      let selfId = "";
      for (const t of (tabs || [])) {
        const m = (t.url || "").match(/\/p\/([0-9a-z]{12,})\//i);
        if (m) { selfId = m[1]; break; }
      }
      cb(selfId);
    });
  } catch (e) { cb(""); }
}

// ============================================================================
// File loading & parsing
// ============================================================================

fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) loadFile(file);
});

// Drag & drop convenience
["dragover", "dragenter"].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.style.borderColor = "#38bdf8"; })
);
["dragleave", "drop"].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.style.borderColor = ""; })
);
dropZone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

// Paste alternative — no file download required.
pasteBtn.addEventListener("click", () => {
  const text = (pasteBox.value || "").trim();
  if (!text) {
    queueFailed("Paste some profile IDs, URLs, or JSON first.");
    return;
  }
  try {
    const isJson = text.startsWith("[") || text.startsWith("{");
    const q = isJson ? parseJson(text) : parsePasted(text);
    if (!q.length) throw new Error("No profile IDs found in what you pasted.");
    queue = q;
    queueLoaded(`${q.length} matches pasted`);
  } catch (err) {
    queueFailed(err.message);
  }
});

// Load a previously-exported results CSV: skip those matches, keep them in the export.
priorInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      priorResults = parseResultsCsv(reader.result);
      priorHint.innerHTML = priorResults.length
        ? `<span style="color:#34d399">Loaded ${priorResults.length} already-scanned matches — they'll be skipped and kept in the export.</span>`
        : `<span style="color:#fbbf24">No already-scanned rows found in that CSV.</span>`;
    } catch (err) {
      priorHint.innerHTML = `<span style="color:#f87171">Couldn't read that CSV.</span>`;
    }
  };
  reader.readAsText(file);
});

// Shared UI updates so every load path behaves identically.
function queueLoaded(label) {
  fileLoaded = true;
  dropZone.classList.add("loaded");
  dropText.innerHTML =
    `<strong>${escapeHtml(label)}</strong>` +
    `<div class="hint">ready to scan</div>`;
  startBtn.disabled = false;
  statusLine.textContent = `${queue.length} matches queued. Press “Start Scan”.`;
  statusSub.textContent = "";
}

function queueFailed(msg) {
  fileLoaded = false;
  startBtn.disabled = true;
  dropZone.classList.remove("loaded");
  statusLine.textContent = "Could not load list.";
  statusSub.innerHTML = `<span style="color:#f87171">${escapeHtml(msg)}</span>`;
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = reader.result;
      const isJson = /\.json$/i.test(file.name) || text.trim().startsWith("[") || text.trim().startsWith("{");
      queue = isJson ? parseJson(text) : parseCsv(text);

      if (!queue.length) throw new Error("No matches with a profile ID/URL were found in this file.");
      queueLoaded(`${file.name} — ${queue.length} matches`);
    } catch (err) {
      queueFailed(err.message);
    }
  };
  reader.onerror = () => { statusLine.textContent = "Failed to read the file."; };
  reader.readAsText(file);
}

// --- Column detection helpers -------------------------------------------------
const COLS = {
  name:      ["display name", "displayname", "name", "full name", "match name"],
  first:     ["first name", "firstname", "given name"],
  last:      ["last name", "lastname", "surname", "family name"],
  sex:       ["sex", "gender"],
  relationship: ["relationship", "predicted relationship", "predicted_relationship", "relationship range"],
  share:     ["% dna shared", "percent dna shared", "percentage dna shared", "shared dna", "dna shared",
              "% shared", "shared %", "percent_dna_shared", "percentage"],
  birthplace:["birthplace", "birth place", "birth_place", "birthplaces", "ancestor birthplaces",
              "birth country", "birth_country", "location"],
  surnames:  ["surnames", "family names", "family_names", "surname"],
  profileId: ["profile id", "profileid", "profile_id", "remote id", "remote_id", "human id",
              "human_id", "match id", "id"],
  profileUrl:["profile url", "profileurl", "profile_url", "profile link", "url", "link", "profile"],
};

function pickIndex(headers, candidates) {
  for (const c of candidates) {
    const i = headers.indexOf(c);
    if (i !== -1) return i;
  }
  // fuzzy contains
  for (let i = 0; i < headers.length; i++) {
    if (candidates.some((c) => headers[i].includes(c))) return i;
  }
  return -1;
}

function normalizeHeaders(arr) {
  return arr.map((h) => String(h || "").trim().toLowerCase().replace(/^"|"$/g, ""));
}

// Extract a 23andMe profile id from an id string or a URL like
// https://you.23andme.com/p/<id>/  or  /profile/<id>/
function extractProfileId(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  const m = s.match(/\/(?:p|profile)\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{6,}$/.test(s)) return s;
  return "";
}

function buildUrl(profileId, rawUrl) {
  if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
    return rawUrl.replace(/\/?$/, "/");
  }
  return `https://you.23andme.com/p/${profileId}/`;
}

// Arrays / objects / strings -> "a; b; c" for CSV-friendly single cells.
function flatten(v) {
  if (v == null || v === "") return "";
  if (Array.isArray(v)) {
    const parts = v.map((x) => {
      if (x == null) return "";
      if (typeof x === "object") return String(x.name || x.label || x.value || x.location || x.country || x.surname || "").trim();
      return String(x);
    }).filter(Boolean);
    return Array.from(new Set(parts)).join("; ");
  }
  if (typeof v === "object") return String(v.name || v.label || v.value || "").trim();
  return String(v);
}

// Parse a free-form pasted block into queue rows. Handles, per line:
//   - a bare profile id, a profile URL, or "Name, id" / tab-separated columns.
function parsePasted(text) {
  const out = [];
  const seen = new Set();
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^#/.test(line)) continue;

    const tokens = line.split(/[\t,;|]+/).map((t) => t.trim()).filter(Boolean);
    let profileId = "";
    const nameParts = [];
    for (const tok of tokens) {
      const id = extractProfileId(tok);
      if (id && !profileId) profileId = id;
      else nameParts.push(tok);
    }
    if (!profileId || seen.has(profileId)) continue;
    seen.add(profileId);

    out.push({
      profileId,
      name: nameParts.join(" ").trim() || profileId,
      sex: "",
      relationship: "",
      share: "",
      birthplace: "",
      surnames: "",
      url: buildUrl(profileId, ""),
    });
  }
  return out;
}

// --- CSV -------------------------------------------------------------------
function parseCsv(text) {
  const rows = csvToRows(text).filter((r) => r.length && r.some((c) => c !== ""));
  if (rows.length < 2) throw new Error("The CSV appears to be empty.");

  const headers = normalizeHeaders(rows[0]);
  const iName  = pickIndex(headers, COLS.name);
  const iFirst = pickIndex(headers, COLS.first);
  const iLast  = pickIndex(headers, COLS.last);
  const iSex   = pickIndex(headers, COLS.sex);
  const iRel   = pickIndex(headers, COLS.relationship);
  const iShare = pickIndex(headers, COLS.share);
  const iBirth = pickIndex(headers, COLS.birthplace);
  const iSurn  = pickIndex(headers, COLS.surnames);
  const iId    = pickIndex(headers, COLS.profileId);
  const iUrl   = pickIndex(headers, COLS.profileUrl);

  if (iId === -1 && iUrl === -1) {
    throw new Error("No profile ID or URL column found. Detected columns: " + headers.join(", "));
  }

  const cell = (row, i) => (i !== -1 ? String(row[i] == null ? "" : row[i]).trim() : "");

  const out = [];
  const seen = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rawId  = cell(row, iId);
    const rawUrl = cell(row, iUrl);
    const profileId = extractProfileId(rawId) || extractProfileId(rawUrl);
    if (!profileId && !/^https?:/i.test(rawUrl)) continue;

    let name = cell(row, iName);
    if (!name && (iFirst !== -1 || iLast !== -1)) {
      name = [cell(row, iFirst), cell(row, iLast)].join(" ").trim();
    }

    const key = profileId || rawUrl;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      profileId,
      name: name || "Unknown",
      sex: cell(row, iSex),
      relationship: cell(row, iRel),
      share: cell(row, iShare),
      birthplace: cell(row, iBirth),
      surnames: cell(row, iSurn),
      url: buildUrl(profileId, rawUrl),
    });
  }
  return out;
}

// Minimal RFC-4180-ish CSV parser (handles quotes, commas, newlines in quotes)
function csvToRows(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += ch;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Parse a previously-exported results CSV into result rows (to skip + merge).
function parseResultsCsv(text) {
  const rows = csvToRows(text).filter((r) => r.length && r.some((c) => c !== ""));
  if (rows.length < 2) return [];
  const h = normalizeHeaders(rows[0]);
  const iName  = pickIndex(h, ["name", "display name", "full name"]);
  const iSex   = pickIndex(h, ["sex", "gender"]);
  const iRel   = pickIndex(h, ["relationship"]);
  const iShare = pickIndex(h, ["share %", "share", "% dna shared", "percent"]);
  const iBirth = pickIndex(h, ["birthplace", "birth place"]);
  const iSurn  = pickIndex(h, ["surnames", "surname"]);
  const iPat   = pickIndex(h, ["paternal haplogroup", "paternal", "y-dna", "ydna"]);
  const iMat   = pickIndex(h, ["maternal haplogroup", "maternal", "mtdna"]);
  const iId    = pickIndex(h, ["profile id", "profileid", "profile_id"]);
  const cell = (r, i) => (i !== -1 ? String(r[i] == null ? "" : r[i]).trim() : "");
  const real = (v) => v && !/^n\/?a$/i.test(v);
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const pat = cell(row, iPat), mat = cell(row, iMat);
    // Only treat a row as "done" if it was actually resolved (haplogroup or Private).
    if (!real(pat) && !real(mat)) continue;
    out.push({
      profileId: cell(row, iId),
      name: cell(row, iName) || "Unknown",
      sex: cell(row, iSex),
      relationship: cell(row, iRel),
      share: cell(row, iShare),
      birthplace: cell(row, iBirth),
      surnames: cell(row, iSurn),
      paternal: pat || "N/A",
      maternal: mat || "N/A",
      status: "ok",
    });
  }
  return out;
}

// --- JSON ------------------------------------------------------------------
function parseJson(text) {
  const data = JSON.parse(text);
  let list = Array.isArray(data) ? data
    : (data.relatives || data.matches || data.data || data.results || []);
  if (!Array.isArray(list)) throw new Error("Unrecognised JSON structure.");

  const get = (obj, keys) => {
    for (const k of Object.keys(obj)) {
      const nk = k.toLowerCase();
      if (keys.some((c) => nk === c || nk.includes(c))) {
        const v = obj[k];
        if (v !== null && v !== undefined && v !== "") return v;
      }
    }
    return "";
  };

  const out = [];
  const seen = new Set();
  for (const obj of list) {
    if (!obj || typeof obj !== "object") continue;
    const rawId  = get(obj, ["profile_id", "profileid", "relative_id", "remote_id", "human_id", "id"]);
    const rawUrl = get(obj, ["profile_url", "profileurl", "url", "link", "profile"]);
    const profileId = extractProfileId(rawId) || extractProfileId(rawUrl);
    if (!profileId && !/^https?:/i.test(String(rawUrl))) continue;

    let name = get(obj, ["display_name", "displayname", "full name", "fullname"]);
    if (!name) {
      const f = get(obj, ["first_name", "firstname", "given"]);
      const l = get(obj, ["last_name", "lastname", "family_name"]);
      name = [f, l].filter(Boolean).join(" ").trim();
    }
    if (!name) name = get(obj, ["name"]);

    const sexRaw = String(get(obj, ["sex", "gender"]) || "").toLowerCase();
    const sex = sexRaw === "m" ? "Male" : sexRaw === "f" ? "Female"
      : (sexRaw ? sexRaw[0].toUpperCase() + sexRaw.slice(1) : "");

    const key = profileId || String(rawUrl);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      profileId,
      name: (name || "Unknown").toString().trim(),
      sex,
      relationship: (get(obj, ["relationship", "predicted"]) || "").toString().trim(),
      share: (get(obj, ["% dna shared", "shared dna", "dna_shared", "percent", "shared"]) || "").toString().trim(),
      birthplace: flatten(get(obj, ["birthplace", "birth_place", "birthplaces", "birth_country", "family_locations", "locations"])),
      surnames: flatten(get(obj, ["surnames", "surname", "family_names"])),
      url: buildUrl(profileId, rawUrl),
    });
  }
  return out;
}

// ============================================================================
// Talking to the background service worker
// ============================================================================

startBtn.addEventListener("click", () => {
  if (!fileLoaded) return;
  const min = Math.max(1, parseInt(minDelayEl.value, 10) || 6);
  const max = Math.max(min, parseInt(maxDelayEl.value, 10) || 14);
  chrome.runtime.sendMessage({
    type: "START",
    queue,
    priorResults,
    minDelay: min * 1000,
    maxDelay: max * 1000,
    skipDone: skipDoneEl.checked,
  });
});

pauseBtn.addEventListener("click", () => {
  const paused = pauseBtn.dataset.state === "paused";
  chrome.runtime.sendMessage({ type: paused ? "RESUME" : "PAUSE" });
});

downloadBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
    if (state && state.results && state.results.length) downloadCsv(state.results);
  });
});

// Live updates pushed from the worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "PROGRESS") render(msg.state);
});

// Hydrate on open (scan may already be running)
chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
  if (chrome.runtime.lastError) return;
  if (state) render(state);
});

// ============================================================================
// Rendering
// ============================================================================

function render(state) {
  const { total = 0, done = 0, running, paused, finished, results = [], etaMs, currentName } = state;

  const pct = total ? Math.round((done / total) * 100) : 0;
  bar.style.width = pct + "%";

  if (finished) {
    statusLine.textContent = `Done — scraped ${done} of ${total} matches (100%).`;
    statusSub.textContent = "Click “Download Scraped CSV” to save your results.";
    setPill("done", "complete");
  } else if (running && !paused) {
    statusLine.textContent = `Scraping match ${done + 1} of ${total} (${pct}%).`;
    statusSub.textContent =
      `Est. time remaining: ${fmtTime(etaMs)}` + (currentName ? ` · now: ${currentName}` : "");
    setPill("run", "scanning");
  } else if (paused && state.rateLimited) {
    statusLine.textContent = `Paused at ${done} of ${total} (${pct}%) — rate limited.`;
    statusSub.innerHTML = `<span style="color:#fbbf24">23andMe rate-limited you (Cloudflare 1015). ` +
      `Wait ~30–60 min (or longer), then press “Resume”. Progress is saved and finished matches won't be re-scraped.</span>`;
    setPill("pause", "rate limited");
  } else if (paused && state.loggedOut) {
    statusLine.textContent = `Stopped at ${done} of ${total} (${pct}%).`;
    statusSub.innerHTML = `<span style="color:#f87171">Your 23andMe session looks logged out. ` +
      `Open a 23andMe tab, sign in, then press “Resume”.</span>`;
    setPill("pause", "logged out");
  } else if (paused) {
    statusLine.textContent = `Paused at ${done} of ${total} (${pct}%).`;
    statusSub.textContent = "Press “Resume” to continue.";
    setPill("pause", "paused");
  } else if (fileLoaded) {
    statusLine.textContent = `${total || queue.length} matches queued. Press “Start Scan”.`;
    setPill("idle", "idle");
  }

  startBtn.disabled = !fileLoaded || (running && !finished);
  pauseBtn.disabled = !running || finished;
  if (paused) { pauseBtn.textContent = "Resume"; pauseBtn.dataset.state = "paused"; }
  else        { pauseBtn.textContent = "Pause";  pauseBtn.dataset.state = "running"; }
  downloadBtn.disabled = results.length === 0;

  resultCount.textContent = results.length;
  if (!results.length) {
    resultBody.innerHTML = `<tr class="empty-row"><td colspan="5">No results yet.</td></tr>`;
  } else {
    resultBody.innerHTML = results.map(rowHtml).join("");
    const scroller = resultBody.closest(".table-scroll");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }
}

function rowHtml(r) {
  return `<tr>
    <td>${escapeHtml(r.name)}</td>
    <td>${escapeHtml(r.relationship || "—")}</td>
    <td>${escapeHtml(r.share || "—")}</td>
    <td class="hap">${hapCell(r.paternal)}</td>
    <td class="hap">${hapCell(r.maternal)}</td>
  </tr>`;
}

function hapCell(v) {
  if (v === "Private") return `<span class="tag-private">Private</span>`;
  if (!v || v === "N/A") return `<span class="tag-na">N/A</span>`;
  return escapeHtml(v);
}

function setPill(kind, label) {
  statePill.textContent = label;
  statePill.className = "stat-pill pill-" + kind;
}

function fmtTime(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

// Build and download the results CSV (full column set).
function downloadCsv(results) {
  const headers = ["Name", "Sex", "Relationship", "Share %", "Birthplace", "Surnames", "Paternal Haplogroup", "Maternal Haplogroup", "Profile ID"];
  const rows = [headers.map(csvCell).join(",")];
  for (const r of results) {
    rows.push([
      r.name || "",
      r.sex || "",
      r.relationship || "",
      r.share || "",
      r.birthplace || "",
      r.surnames || "",
      r.paternal || "",
      r.maternal || "",
      r.profileId || "",
    ].map(csvCell).join(","));
  }
  // Prepend a BOM so Excel reads UTF-8 correctly.
  const blob = new Blob(["﻿" + rows.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `haplogroups_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(v) {
  const s = String(v == null ? "" : v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
