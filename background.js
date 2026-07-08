/* ============================================================================
 * 23andMe Haplogroup Harvester — background.js (MV3 service worker)
 *
 * Responsibilities:
 *   - Owns the scan loop so it survives the popup closing.
 *   - Calls the 23andMe ancestry JSON API for each match under the user's
 *     logged-in session (credentials: "include") — this is why host_permissions
 *     covers 23andMe, which also sidesteps CORS.
 *   - Reads paternal (Y-DNA) and maternal (mtDNA) haplogroups from that JSON.
 *   - Can page through the DNA Relatives API to fetch the whole match list
 *     (profile id, name, sex, relationship, share%, birthplaces, surnames).
 *   - Enforces a randomised human-like delay between requests.
 *   - Persists progress to chrome.storage so it can resume after the worker
 *     is suspended, and reports progress to the popup.
 *
 * NOTE ON THE ENDPOINT (read this if results come back "N/A"):
 *   Haplogroups are NOT in the profile HTML (23andMe is a React app); they come
 *   from /p/<id>/ancestry/compute-result/ with the profile_id and name query
 *   params. If everything returns N/A, open a match's profile in DevTools →
 *   Network, find the "compute-result" (or "haplogroup") request, and update
 *   buildEndpoints() / HAPLO_COMPUTE_NAMES below to match.
 * ========================================================================== */

const STORAGE_KEY = "scanState";

// In-memory (lost when the worker is suspended; rebuilt from storage on demand)
let S = null;               // current scan state
let timer = null;           // setTimeout handle for the inter-request delay
let keepAliveTimer = null;  // resets the worker idle timer during a run
let loopActive = false;     // is a tick chain currently live in THIS worker?

// Throttle safety: after COOLDOWN_EVERY profiles, take a longer random break so
// we stay well under 23andMe's rate limiter (Cloudflare error 1015).
const COOLDOWN_EVERY = 20;
const COOLDOWN_MIN = 45000;   // 45s
const COOLDOWN_MAX = 90000;   // 90s

// ============================================================================
// Message routing
// ============================================================================
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "START":
        await handleStart(msg);
        sendResponse(stateForPopup(true));
        break;
      case "PAUSE":
        await ensureLoaded();
        if (S) { S.paused = true; clearTimer(); stopKeepAlive(); await persist(); }
        broadcast();
        sendResponse(stateForPopup(true));
        break;
      case "RESUME":
        await ensureLoaded();
        if (S) {
          S.paused = false; S.running = true; S.loggedOut = false; S.rateLimited = false;
          await persist(); startKeepAlive(); kickLoop();
        }
        broadcast();
        sendResponse(stateForPopup(true));
        break;
      case "GET_STATE":
        await ensureLoaded();
        // Recover a run that was interrupted by worker suspension.
        if (S && S.running && !S.paused && !S.finished && !loopActive) {
          startKeepAlive(); kickLoop();
        }
        sendResponse(stateForPopup(true));
        break;
      case "FETCH_RELATIVES":
        try {
          const list = await fetchAllRelatives(msg.selfId || "", { onlyShared: !!msg.onlyShared });
          sendResponse({ ok: true, relatives: list });
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
        break;
      default:
        sendResponse(null);
    }
  })();
  return true; // keep the message channel open for the async response
});

// ============================================================================
// Scan control
// ============================================================================
async function handleStart(msg) {
  clearTimer();

  const prior = msg.skipDone ? await loadStored() : null;
  let results = (prior && prior.results) ? prior.results.slice() : [];

  // Merge in results the user loaded from a previously-exported CSV, so those
  // matches are skipped AND still appear in the final download.
  for (const pr of (msg.priorResults || [])) {
    let i = pr.profileId ? results.findIndex((r) => r && r.profileId === pr.profileId) : -1;
    if (i < 0 && pr.name) {
      i = results.findIndex((r) => r && r.name && String(r.name).toLowerCase() === String(pr.name).toLowerCase());
    }
    if (i >= 0) results[i] = pr; else results.push(pr);
  }

  // A match counts as "done" only if it was cleanly scraped (status "ok").
  // Track by id AND name so a results CSV without profile IDs still skips.
  const doneIds = {};
  const doneNames = {};
  for (const r of results) {
    if (r && r.status === "ok") {
      if (r.profileId) doneIds[r.profileId] = true;
      if (r.name) doneNames[String(r.name).toLowerCase()] = true;
    }
  }

  const remaining = (msg.queue || []).filter((m) => {
    if (m.profileId && doneIds[m.profileId]) return false;
    if (m.name && doneNames[String(m.name).toLowerCase()]) return false;
    return true;
  });
  const skipped = (msg.queue || []).length - remaining.length;

  S = {
    queue: remaining,
    results,
    doneIds,
    doneNames,
    index: 0,
    total: skipped + remaining.length,
    running: true,
    paused: false,
    finished: false,
    loggedOut: false,
    rateLimited: false,
    sinceCooldown: 0,
    consecutiveErrors: 0,
    minDelay: msg.minDelay || 6000,
    maxDelay: msg.maxDelay || 14000,
    times: [],
    currentName: "",
  };

  await persist();
  broadcast();
  startKeepAlive();
  kickLoop();
}

function kickLoop() {
  if (loopActive) return;
  loopActive = true;
  tick();
}

async function tick() {
  if (!S || !S.running || S.paused) { loopActive = false; stopKeepAlive(); return; }

  if (S.index >= S.queue.length) { await finish(); return; }

  const m = S.queue[S.index];
  S.currentName = m.name;
  broadcast(); // show "now: <name>"

  const t0 = Date.now();
  let row;
  try {
    row = await scrapeProfile(m);
  } catch (err) {
    row = { ...baseRow(m), paternal: "N/A", maternal: "N/A", status: "error" };
  }

  // Rate limited or logged out → STOP immediately without consuming this match,
  // so a later Resume retries it and nothing is falsely marked done.
  if (row.status === "rate_limited" || row.status === "logged_out") {
    S.paused = true;
    S.loggedOut = row.status === "logged_out";
    S.rateLimited = row.status === "rate_limited";
    clearTimer();
    stopKeepAlive();
    loopActive = false;
    await persist();
    broadcast();
    return;
  }

  // Circuit breaker: several failures in a row almost always means we've been
  // rate-limited/blocked or logged out. Stop rather than plow through marking
  // N/A. We do NOT advance, so Resume retries this exact match.
  if (row.status === "error") {
    S.consecutiveErrors = (S.consecutiveErrors || 0) + 1;
    if (S.consecutiveErrors >= 5) {
      S.paused = true;
      S.rateLimited = true;
      clearTimer();
      stopKeepAlive();
      loopActive = false;
      await persist();
      broadcast();
      return;
    }
  } else {
    S.consecutiveErrors = 0;
  }

  // Record the result (replacing any earlier row for this match). Only a clean
  // "ok" marks the match done; transient errors stay un-done for a later retry.
  upsertResult(row);
  if (row.status === "ok" && m.profileId) S.doneIds[m.profileId] = true;
  S.index++;

  const cycle = Date.now() - t0;
  S.times.push(cycle);
  if (S.times.length > 20) S.times.shift();

  await persist();
  broadcast();

  if (S.index >= S.queue.length) { await finish(); return; }

  // Randomised human-like throttle, plus a longer cooldown every batch.
  S.sinceCooldown = (S.sinceCooldown || 0) + 1;
  let delay = randInt(S.minDelay, S.maxDelay);
  if (S.sinceCooldown >= COOLDOWN_EVERY) {
    S.sinceCooldown = 0;
    delay += randInt(COOLDOWN_MIN, COOLDOWN_MAX);
    S.currentName = "cooling down to avoid rate limits…";
    await persist();
    broadcast();
  }
  timer = setTimeout(tick, delay);
}

async function finish() {
  clearTimer();
  stopKeepAlive();
  loopActive = false;
  if (S) {
    S.running = false;
    S.paused = false;
    S.finished = true;
    S.currentName = "";
    await persist();
  }
  broadcast();
}

// ============================================================================
// Fetch + parse a single profile
// ============================================================================
async function scrapeProfile(m) {
  const row = baseRow(m);
  const id = m.profileId || extractIdFromUrl(m.url);
  if (!id) return { ...row, paternal: "N/A", maternal: "N/A", status: "no_id" };

  const endpoints = buildEndpoints(id);

  let entries = null;   // null = never got valid JSON; [] = valid but empty
  let sawLogin = false;
  let rateLimited = false;

  for (const url of endpoints) {
    let res;
    try {
      res = await fetch(url, {
        credentials: "include",
        redirect: "follow",
        headers: { "Accept": "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest" },
      });
    } catch (e) { continue; }

    const finalUrl = res.url || url;
    if (/\/(signin|login|user\/signin)/i.test(finalUrl)) { sawLogin = true; continue; }

    // Read the body for ANY status so we can spot a Cloudflare rate-limit / block
    // page even when it comes back as 403 / 503 / etc. (not only 429).
    let txt = "";
    try { txt = await res.text(); } catch (e) { txt = ""; }

    if (res.status === 429 || res.status === 503 || looksRateLimited(txt)) { rateLimited = true; break; }
    if (!res.ok) continue;

    let data;
    try { data = JSON.parse(txt); }
    catch (e) { if (looksLikeLogin(txt)) sawLogin = true; continue; }

    const arr = normalizeEntries(data, id);
    if (arr === null) continue;
    entries = arr;
    break; // got a valid JSON response — accept it (empty = no haplogroups); 1 request/match
  }

  if (rateLimited) {
    return { ...row, paternal: "N/A", maternal: "N/A", status: "rate_limited" };
  }
  if (entries === null) {
    return { ...row, paternal: "N/A", maternal: "N/A", status: sawLogin ? "logged_out" : "error" };
  }

  const { paternal, maternal } = pickHaplos(entries);
  const isPrivate = entries.length === 0 || (!paternal && !maternal);

  // The relatives list already carries surnames + birthplaces. Only hit the
  // per-profile family_background endpoint when they're missing (e.g. a
  // file/paste-loaded queue), so the common path stays at one request/match.
  let surnames = row.surnames || "";
  let birthplace = row.birthplace || "";
  if (!surnames && !birthplace) {
    try { const fam = await fetchFamilyBackground(id); surnames = fam.surnames; birthplace = fam.birthplace; } catch (e) {}
  }

  return {
    ...row,
    surnames: surnames || "",
    birthplace: birthplace || "",
    paternal: paternal || (isPrivate ? "Private" : "N/A"),
    maternal: maternal || (isPrivate ? "Private" : "N/A"),
    status: "ok",
  };
}

function extractIdFromUrl(url) {
  if (!url) return "";
  const m = String(url).match(/\/(?:p|profile)\/([A-Za-z0-9]+)/);
  return m ? m[1] : "";
}

function baseRow(m) {
  return {
    name: m.name || "Unknown",
    sex: m.sex || "",
    relationship: m.relationship || "",
    share: m.share || "",
    birthplace: m.birthplace || "",
    surnames: m.surnames || "",
    profileId: m.profileId || "",
  };
}

// ============================================================================
// Haplogroup extraction — from the 23andMe ancestry JSON API
//
// Records look like:
//   { "profile_id": "298c6df894b525b8",
//     "name": "yhaplo_2023:haplogroup",
//     "result": { "haplogroup_id": "isogg_ydna_2016_01_04:R-P311" } }
//
// The compute-result endpoint REQUIRES the profile_id and name query params or
// it returns nothing (that was the original "N/A" bug). encodeURIComponent
// handles the ":" and "," encoding below.
// ============================================================================
const HAPLO_COMPUTE_NAMES = [
  "yhaplo_2023:haplogroup",
  "mthaplo_build_7:haplogroup",
];

function buildEndpoints(id) {
  const nameParam = encodeURIComponent(HAPLO_COMPUTE_NAMES.join(","));
  const pid = encodeURIComponent(id);
  return [
    `https://you.23andme.com/p/${id}/ancestry/compute-result/?profile_id=${pid}&name=${nameParam}`,
    `https://you.23andme.com/p/${id}/ancestry/haplogroup/?profile_id=${pid}`,
    `https://you.23andme.com/p/${id}/ancestry/haplogroup/`,
  ];
}

function normalizeEntries(data, id) {
  let arr = Array.isArray(data)
    ? data
    : (data && (data.data || data.results || data.haplogroups || data.compute_results || data.computeResults));
  if (!Array.isArray(arr)) return null;
  const matched = arr.filter((e) => e && (e.profile_id === id || e.profileId === id));
  return matched.length ? matched : arr;
}

function pickHaplos(entries) {
  let paternal = "", maternal = "";
  for (const e of entries) {
    if (!e) continue;
    const name = String(e.name || e.type || e.kind || "").toLowerCase();
    const hid =
      (e.result && (e.result.haplogroup_id || e.result.haplogroup || e.result.value)) ||
      e.haplogroup_id || e.haplogroup || "";
    const val = cleanHapId(hid);
    if (!val) continue;

    if (/ydna|yhaplo|paternal|y[_-]?line/.test(name)) {
      if (!paternal) paternal = val;
    } else if (/mtdna|mthaplo|maternal|mt[_-]?line/.test(name)) {
      if (!maternal) maternal = val;
    }
  }
  return { paternal, maternal };
}

function cleanHapId(hid) {
  if (!hid) return "";
  let s = String(hid).trim();
  if (s.includes(":")) s = s.split(":").pop();
  s = s.trim();
  if (!s || s.length > 30) return "";
  if (/^(unknown|none|n\/a|na|not_computed|not tested|pending)$/i.test(s)) return "";
  return s;
}

function looksLikeLogin(html) {
  if (!html) return false;
  return /id=["']signin|name=["']password|Log in to 23andMe|Sign in to your account|<title>[^<]*Sign\s*in/i.test(html);
}

// Cloudflare "Error 1015 — you are being rate limited" (and similar) pages.
function looksRateLimited(txt) {
  if (!txt) return false;
  return /error\s*1015|you are being rate limited|rate limited|cf-error-details|attention required.*cloudflare/i.test(txt);
}

// Insert or replace a result row by profileId, so re-scans don't duplicate.
function upsertResult(row) {
  if (!S) return;
  const i = row.profileId ? S.results.findIndex((r) => r && r.profileId === row.profileId) : -1;
  if (i >= 0) S.results[i] = row; else S.results.push(row);
}

// ============================================================================
// "Fetch all my matches" — page through the 23andMe DNA Relatives API
//
// The relatives list is paginated (25/page in the UI). We call the JSON API
// with limit/offset under the logged-in session and keep going until a page
// returns no new people.
//
// IF THE BUTTON RETURNS 0: open DNA Relatives -> DevTools -> Network, find the
// request that returns the list of relatives (JSON full of profile_id /
// relative_id), and put its URL template in RELATIVES_ENDPOINTS below. Use
// {self} for your own profile id, {limit} and {offset} for paging.
// ============================================================================
// One big page: the ajax endpoint respects `limit` but ignores `offset`,
// so we ask for everything at once (well above any realistic match count).
const RELATIVES_PAGE_SIZE = 20000;

const RELATIVES_ENDPOINTS = [
  // Confirmed base path from DevTools:  /p/<self>/family/relatives/ajax/
  "https://you.23andme.com/p/{self}/family/relatives/ajax/?limit={limit}&offset={offset}",
  "https://you.23andme.com/p/{self}/family/relatives/ajax/?limit={limit}&start={offset}",
  "https://you.23andme.com/p/{self}/family/relatives/ajax/",
  // Other shapes seen in the wild, as fallbacks.
  "https://you.23andme.com/p/{self}/family/relatives/?sort=strength&page={page}",
];

async function fetchAllRelatives(selfIdHint, opts) {
  opts = opts || {};
  const finalize = (rows) => (opts.onlyShared ? rows.filter((r) => r.openSharing) : rows);
  const selfId = selfIdHint || (await discoverSelfId());

  let template = null;
  let firstPage = null;
  for (const t of RELATIVES_ENDPOINTS) {
    const url = fillRelUrl(t, selfId, RELATIVES_PAGE_SIZE, 0, 1);
    const page = await fetchRelPage(url);
    if (page && page.rows.length) { template = t; firstPage = page; break; }
  }
  if (!template) {
    throw new Error(
      "Couldn't reach the relatives API automatically. Open your DNA Relatives page, then in DevTools -> Network copy the request URL that returns the list and send it over so I can pin the endpoint."
    );
  }

  const seen = new Set();
  const out = [];
  const pushRows = (rows) => {
    for (const r of rows) {
      if (!r.profileId || seen.has(r.profileId)) continue;
      seen.add(r.profileId);
      out.push(r);
    }
  };
  pushRows(firstPage.rows);

  // Got everything in one response (the endpoint ignores offset) — done.
  if (firstPage.rows.length < RELATIVES_PAGE_SIZE) return finalize(out);

  const total = firstPage.total || 0;
  for (let pageNum = 2, guard = 0; guard < 400; pageNum++, guard++) {
    if (total && out.length >= total) break;
    const url = fillRelUrl(template, selfId, RELATIVES_PAGE_SIZE, out.length, pageNum);
    const page = await fetchRelPage(url);
    if (!page || !page.rows.length) break;
    const before = out.length;
    pushRows(page.rows);
    if (out.length === before) break; // no new people — done
  }

  return finalize(out);
}

function fillRelUrl(t, self, limit, offset, page) {
  return t
    .replace("{self}", encodeURIComponent(self || ""))
    .replace("{limit}", String(limit))
    .replace("{offset}", String(offset))
    .replace("{page}", String(page == null ? 1 : page));
}

async function fetchRelPage(url) {
  let res;
  try {
    res = await fetch(url, {
      credentials: "include",
      redirect: "follow",
      headers: { "Accept": "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest" },
    });
  } catch (e) { return null; }
  if (/\/(signin|login|user\/signin)/i.test(res.url || url)) return null;
  if (res.status === 429 || res.status === 503) {
    throw new Error("You're being rate limited by 23andMe (Cloudflare 1015). Wait ~30–60 minutes, then try again.");
  }
  if (!res.ok) return null;

  let txt = "";
  try { txt = await res.text(); } catch (e) { return null; }
  let data;
  try { data = JSON.parse(txt); } catch (e) { return null; }

  const arr = Array.isArray(data)
    ? data
    : (data.relatives || data.data || data.results || data.matches || data.rows || []);
  if (!Array.isArray(arr)) return null;

  const total =
    (data && (data.total || data.count || (data.meta && (data.meta.total || data.meta.count)))) || 0;

  return { rows: arr.map(relFields).filter((r) => r.profileId), total: Number(total) || 0 };
}

// Pull our columns out of one relative object, tolerant of field naming.
function relFields(o) {
  if (!o || typeof o !== "object") return { profileId: "" };
  const g = (keys) => {
    for (const k of Object.keys(o)) {
      const nk = k.toLowerCase();
      if (keys.some((c) => nk === c || nk.includes(c))) {
        const v = o[k];
        if (v !== null && v !== undefined && v !== "") return v;
      }
    }
    return "";
  };

  // Match id = the RELATIVE's id. IMPORTANT: in this response o.profile_id is
  // the logged-in user's OWN id, so use relative_profile_id / profile_url.
  let profileId = cleanRelId(o.relative_profile_id || o.relative_id || "");
  if (!profileId && o.profile_url) profileId = cleanRelId(o.profile_url);
  if (!profileId) profileId = cleanRelId(g(["relative_profile_id", "relative_id", "human_id"]));

  let name = g(["display_name", "displayname", "full_name", "fullname", "label"]);
  if (!name) name = [o.first_name || "", o.last_name || ""].filter(Boolean).join(" ").trim();
  if (!name) name = g(["name"]);

  const sexRaw = String(o.sex || o.gender || "").toLowerCase();
  const sex = sexRaw.startsWith("m") ? "Male" : sexRaw.startsWith("f") ? "Female"
    : (sexRaw ? capitalize(sexRaw) : "");

  let relationship = String(
    o.predicted_relationship_id || o.overridden_relationship_id ||
    g(["relationship_name", "predicted_relationship", "relationship"]) || ""
  );
  relationship = prettyRelationship(relationship);

  const shareRaw = (o.ibd_proportion != null) ? o.ibd_proportion
    : g(["percent_dna_shared", "percent_shared", "sharing_percent", "similarity", "shared_dna_percent", "percent"]);
  const share = normShare(shareRaw);

  let birthplace = flattenList(o.raw_family_locations || o.family_locations || o.locations || "");
  if (!birthplace) birthplace = locFromGrandparents(o.grandparent_birth_locations);
  if (!birthplace) birthplace = locString(o.current_location);

  const surnames = flattenList(o.surnames || o.family_names || g(["surnames", "surname", "family_names"]) || "");

  const openSharing = !!(o.is_open_sharing ||
    (Array.isArray(o.privacy_contexts) && o.privacy_contexts.indexOf("dnar_open_share") >= 0));

  return { profileId, name: String(name || "Unknown"), sex, relationship, share, birthplace, surnames, openSharing };
}

// "first_cousin_once_removed" -> "First Cousin Once Removed"; leaves spaced text as-is.
function prettyRelationship(s) {
  if (!s) return "";
  s = String(s);
  if (/\s/.test(s)) return s.trim();
  return s.split(/[_\-]+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

function locString(o) {
  if (!o || typeof o !== "object") return "";
  return [o.city, o.state, o.country].filter(Boolean).join(", ");
}

function locFromGrandparents(gp) {
  if (!gp || typeof gp !== "object") return "";
  const set = new Set();
  for (const k of Object.keys(gp)) {
    const s = locString(gp[k]);
    if (s) set.add(s);
  }
  return Array.from(set).join("; ");
}

function cleanRelId(v) {
  const s = String(v == null ? "" : v).trim();
  const m = s.match(/\/(?:p|profile)\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  const hex = s.match(/[0-9a-f]{12,}/i);
  if (hex) return hex[0];
  return /^[A-Za-z0-9]{6,}$/.test(s) ? s : "";
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function normShare(v) {
  if (v === "" || v == null) return "";
  if (typeof v === "string" && v.includes("%")) return v.trim();
  let n = Number(v);
  if (!isFinite(n)) return String(v);
  if (n > 0 && n <= 1) n = n * 100; // 0.0457 -> 4.57
  return `${Math.round(n * 100) / 100}%`;
}

function flattenList(v) {
  if (v == null || v === "") return "";
  if (Array.isArray(v)) {
    const parts = v.map((x) => {
      if (x == null) return "";
      if (typeof x === "string" || typeof x === "number") return String(x);
      if (typeof x === "object") return String(x.name || x.label || x.value || x.location || x.country || x.surname || "").trim();
      return "";
    }).filter(Boolean);
    return Array.from(new Set(parts)).join("; ");
  }
  if (typeof v === "object") return String(v.name || v.label || v.value || "").trim();
  return String(v);
}

async function discoverSelfId() {
  const pages = [
    "https://you.23andme.com/family/relatives/",
    "https://you.23andme.com/family/",
    "https://you.23andme.com/",
  ];
  for (const url of pages) {
    let txt = "";
    try {
      const res = await fetch(url, { credentials: "include", redirect: "follow" });
      if (!res.ok) continue;
      txt = await res.text();
    } catch (e) { continue; }

    const keyed = txt.match(/"(?:account_id|self_id|profile_id|profileId|human_id)"\s*:\s*"([0-9a-f]{12,})"/i);
    if (keyed) return keyed[1];

    const counts = {};
    let m;
    const re = /\/p\/([0-9a-f]{12,})\//gi;
    while ((m = re.exec(txt))) counts[m[1]] = (counts[m[1]] || 0) + 1;
    const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    if (best) return best;
  }
  return "";
}

// ============================================================================
// Per-match family background — surnames + birthplaces (family_locations)
//
// Confirmed via DevTools: the family_background endpoint returns
//   { "surnames": ["Johnson", ...],
//     "family_locations": ["Durham, ... North Carolina, United States", ...],
//     "birth_country_paternal_gma": { "city": "...", "state": "...", "country": "..." }, ... }
// It can be async: the first call may return {"request_id": "..."} while it
// computes, so we retry the same URL a couple of times.
// ============================================================================
const FAMILY_BG_ENDPOINTS = [
  "https://you.23andme.com/p/{id}/family_background/",
  "https://you.23andme.com/family_background/?profile_id={id}",
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchFamilyBackground(id) {
  for (const t of FAMILY_BG_ENDPOINTS) {
    const url = t.replace("{id}", encodeURIComponent(id));
    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          credentials: "include",
          redirect: "follow",
          headers: { "Accept": "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest" },
        });
      } catch (e) { break; }
      if (/\/(signin|login)/i.test(res.url || url)) return { surnames: "", birthplace: "" };
      if (!res.ok) break;

      let data;
      try { data = JSON.parse(await res.text()); } catch (e) { break; }

      // Still computing — wait, then retry the same URL.
      const hasPayload = data && (data.surnames || data.family_locations ||
        Object.keys(data).some((k) => /^birth_country_/i.test(k)));
      if (data && data.request_id && !hasPayload) { await sleep(1500); continue; }

      const parsed = parseFamilyBg(data);
      if (parsed.surnames || parsed.birthplace) return parsed;
      break; // valid response but nothing useful — try next template
    }
  }
  return { surnames: "", birthplace: "" };
}

function parseFamilyBg(data) {
  if (!data || typeof data !== "object") return { surnames: "", birthplace: "" };
  const surnames = flattenList(data.surnames || data.family_names || "");
  let places = flattenList(data.family_locations || data.locations || "");
  if (!places) {
    const locs = [];
    for (const k of Object.keys(data)) {
      if (/^birth_country_/i.test(k) && data[k] && typeof data[k] === "object") {
        const o = data[k];
        const parts = [o.city, o.state, o.country].filter(Boolean);
        if (parts.length) locs.push(parts.join(", "));
      }
    }
    places = Array.from(new Set(locs)).join("; ");
  }
  return { surnames, birthplace: places };
}

// ============================================================================
// Persistence & messaging
// ============================================================================
async function persist() {
  if (!S) return;
  try { await chrome.storage.local.set({ [STORAGE_KEY]: S }); } catch (e) {}
}

async function loadStored() {
  try {
    const o = await chrome.storage.local.get(STORAGE_KEY);
    return o[STORAGE_KEY] || null;
  } catch (e) { return null; }
}

async function ensureLoaded() {
  if (!S) S = await loadStored();
}

function stateForPopup(full) {
  if (!S) {
    return { total: 0, done: 0, running: false, paused: false, finished: false, results: [], etaMs: null, currentName: "" };
  }
  const processed = S.index || 0;
  const done = Math.max(0, (S.total - S.queue.length) + processed);
  const remaining = Math.max(0, S.queue.length - processed);
  const avgCycle = mean(S.times);
  const avgDelay = (S.minDelay + S.maxDelay) / 2;
  const etaMs = (S.running && !S.paused && remaining > 0)
    ? remaining * (avgCycle + avgDelay)
    : (S.finished ? 0 : null);

  return {
    total: S.total,
    done,
    running: S.running,
    paused: S.paused,
    finished: S.finished,
    loggedOut: !!S.loggedOut,
    rateLimited: !!S.rateLimited,
    currentName: S.currentName || "",
    etaMs,
    results: full ? S.results : S.results.slice(-150),
  };
}

function broadcast() {
  try {
    chrome.runtime.sendMessage({ type: "PROGRESS", state: stateForPopup(true) }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) { /* popup closed — ignore */ }
}

// ============================================================================
// Small helpers
// ============================================================================
function clearTimer() {
  if (timer) { clearTimeout(timer); timer = null; }
}

function randInt(min, max) {
  min = Number(min) || 0;
  max = Number(max) || 0;
  if (max < min) { const t = min; min = max; max = t; }
  return Math.floor(min + Math.random() * (max - min + 1));
}

function mean(arr) {
  if (!arr || !arr.length) return 0;
  let s = 0;
  for (const n of arr) s += n;
  return s / arr.length;
}

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => { void chrome.runtime.lastError; }); }
    catch (e) { /* ignore */ }
  }, 20000);
}

function stopKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}
