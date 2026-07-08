# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-07-08

### Added
- One-click **Fetch all my matches** — pages the entire DNA Relatives list from
  23andMe's `/family/relatives/ajax/` endpoint under the logged-in session.
- Bulk extraction of paternal (Y-DNA) and maternal (mtDNA) haplogroups via the
  ancestry `compute-result` endpoint.
- CSV export: `Name, Sex, Relationship, Share %, Birthplace, Surnames,
  Paternal Haplogroup, Maternal Haplogroup, Profile ID`.
- **Only matches sharing ancestry results** filter.
- Alternative inputs: load a `relatives` CSV/JSON, or paste profile IDs/URLs.
- Load a previous results CSV to **skip + merge** already-scanned matches.

### Reliability
- Background service worker keeps scanning after the popup closes.
- Randomized throttle (default 6–14s) plus an automatic cooldown every 20 matches.
- Auto-pause on rate limit (Cloudflare 1015 / HTTP 429 / 403 block page) and a
  circuit breaker after repeated failures — no more plowing through as "N/A".
- Resume without re-scraping: only cleanly-scraped matches count as done;
  failed/rate-limited ones are retried.

[1.0.0]: https://github.com/YOUR-USERNAME/haplogroup-harvester/releases/tag/v1.0.0
