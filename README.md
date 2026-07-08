# 23andMe Haplogroup Harvester

A Manifest V3 Chrome extension that bulk-exports your **23andMe DNA Relatives** —
name, sex, relationship, % DNA shared, birthplaces, surnames, and both
**haplogroups** (Y‑DNA paternal + mtDNA maternal) — to a single CSV.

23andMe's official relatives export doesn't include haplogroups, and the site
only shows them one profile at a time. This tool reads them in bulk using
**your own logged-in session** (no passwords, no third-party servers) and paces
itself to stay polite to 23andMe's servers.

![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)
![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-blue.svg)

> **Unofficial personal tool.** Not affiliated with or endorsed by 23andMe. It
> only reads profiles your account can already see, using your own session.
> Automated access may be restricted by 23andMe's Terms of Service — use it
> responsibly, keep request rates low, and only on your own account and data.

---

## Screenshots

<!-- Add PNGs to docs/ and reference them here, for example: -->
<!-- ![Popup](docs/popup.png) -->

_Drop a screenshot of the popup into `docs/` and reference it here._

---

## Features

- **One-click "Fetch all my matches"** — pages your entire DNA Relatives list
  from 23andMe's own API. No manual scrolling, no file download.
- **Bulk haplogroups** — paternal (Y‑DNA) and maternal (mtDNA) for every match.
- **Rich export** — `Name, Sex, Relationship, Share %, Birthplace, Surnames,
  Paternal Haplogroup, Maternal Haplogroup, Profile ID`.
- **Only-shared filter** — skip matches that don't share ancestry results
  (they'd come back empty anyway).
- **Runs in the background** — the scan lives in the service worker, so it keeps
  going even if you close the popup.
- **Rate-limit safe** — randomized delays, an automatic cooldown every 20
  matches, and auto-pause the moment 23andMe rate-limits you (Cloudflare 1015).
- **Resume & skip** — finished matches are never re-scraped; failed ones are
  retried. Load a previous results CSV to skip work you've already done.

---

## Install (unpacked)

1. Download or clone this repository (or grab the packaged `.zip` from the [Releases](../../releases) page and unzip it).
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the repository folder.
5. Make sure you're **signed in to 23andMe** in the same Chrome profile, then
   click the extension icon.

> Tip: use the **Reload** icon on the extension card after any change — don't
> remove and re-add it, or Chrome will wipe the saved scan progress.

---

## Usage

1. Open your **DNA Relatives** page on 23andMe (signed in).
2. Click the extension → **Fetch all my matches** (or load a `relatives` CSV/JSON,
   or paste profile IDs/URLs).
3. Set the throttle (default 6–14 s between profiles) and press **Start Scan**.
4. Watch progress; **Pause/Resume** any time. If you get rate-limited it pauses
   itself — wait, then **Resume**.
5. Click **Download Scraped CSV** when done.

### Already scanned some?

Load a previously-exported results CSV via **"Load a results CSV to skip"** —
those matches are skipped *and* kept in the new export, so the file stays
complete across multiple sessions.

---

## How it works

Everything runs against 23andMe's internal JSON APIs under your session
(`fetch` with `credentials: "include"`; the host permission avoids CORS).

- **Match list** — `/p/<self>/family/relatives/ajax/?limit=…` returns every
  relative with name, sex, relationship, sharing %, `raw_family_locations`
  (birthplaces) and surnames.
- **Haplogroups** — `/p/<id>/ancestry/compute-result/?profile_id=<id>&name=…`
  returns `yhaplo_*` and `mthaplo_*` records; the value after the `:` in
  `haplogroup_id` is used (e.g. `R-P311`, `L2a1c`).

If 23andMe changes these endpoints, the URLs and field mappings are isolated at
the top of the relevant sections in `background.js`
(`RELATIVES_ENDPOINTS`, `buildEndpoints()`, `HAPLO_COMPUTE_NAMES`, `relFields()`).

---

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest (`activeTab`, `storage`, `downloads`, host access to `*.23andme.com`). |
| `popup.html` | The popup UI (vanilla CSS). |
| `popup.js` | Input handling, scan controls, progress, CSV export. |
| `background.js` | Service worker: relatives API, haplogroup scraping, throttle, resume. |

No build step, no dependencies — plain HTML/JS.

---

## Privacy

- Runs entirely in your browser under your own session. Nothing is sent to any
  third-party server.
- Your exported CSVs contain personal data about your matches — `.gitignore`
  keeps `*.csv` out of the repo. Don't commit or share them.

---

## License

[MIT](LICENSE)
