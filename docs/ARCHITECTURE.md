# Architecture and decisions

A running log of how the app is built and why, written for a non-programmer owner. Newest decisions
at the bottom. When something changes, add a new entry instead of rewriting old ones.

## The shape of the system (v0.1, October 2026)

```
 Visitor's phone or computer
 ┌───────────────────────────────────────────────────────────────┐
 │  Website (plain HTML/JS files from GitHub Pages)              │
 │                                                               │
 │  1. identity.js  "which building?"                            │
 │       typed address ──► NYC GeoSearch ──► BIN + BBL           │
 │       map tap ───────► Building Footprints ──► BIN ──► BBL    │
 │  2. sources.js   fetch raw records by BIN / BBL (in parallel) │
 │       DOB · ACRIS · LPC · PLUTO · Footprints · Wikidata · Commons
 │  3. profile.js   raw records ──► facts, timeline, gaps, conflicts
 │  4. narrative.js profile ──► cited story                      │
 │  5. app.js       map + building page                          │
 └───────────────────────────────────────────────────────────────┘
          │ HTTPS, straight to each public source; no server of our own
          ▼
  data.cityofnewyork.us · geosearch.planninglabs.nyc · query.wikidata.org
  commons.wikimedia.org · tile.openstreetmap.org · (loc.gov on request)
```

The same `web/lib/*.js` code also runs under Node.js for the tests, the snapshot tool and the pilot
check, so there is exactly one copy of the logic.

## Decisions

### D1. No server and no database for the prototype
**Decision:** The site is static files. Each visitor's browser queries the public APIs directly.
**Why:** It costs nothing, has nothing to maintain or patch, and can't go down for lack of payment.
All the core sources (NYC Open Data, GeoSearch, Wikidata, Commons) allow browser access (CORS),
which was verified on 2026-10-27. City data is always current because it is read live.
**Trade-off:** Each building page makes about 20 requests and takes 3–8 seconds. Rate limits apply
per visitor rather than to us, which suits a free app. We can't store anything the sources don't
already hold, such as hand-researched notes or user contributions.
**When to revisit:** When adding curated research, user contributions or full-text newspaper
matching, add a database (see D6). The profile format is already designed to be stored.

### D2. Match buildings by official ID, not by address text
**Decision:** Every lookup is converted first to the City's IDs: **BIN** (building) and **BBL**
(tax lot). All other queries use those IDs.
**Why:** Addresses are spelled differently in every dataset (the Empire State Building is
"350 Fifth Avenue" in the address directory, "338 5 AVENUE" in tax data, and "338-350 FIFTH AVE"
in ACRIS). IDs don't drift. Wikidata also stores BINs (property P6082), so archives are matched by
ID rather than guessed from the name. See `DATA_MODEL.md` for the full matching rules.

### D3. Keep raw data, the profile and the story separate
**Decision:** Three layers: raw responses exactly as received (`sources.js`, saved to `data/raw/`),
the normalised profile (`profile.js`), and the written story (`narrative.js`).
**Why:** It's required by the brief, and it means any statement can be traced back to the exact
record. The profile code is a pure function of the raw data, so it can be tested offline.

### D4. Rule-based story, no AI model (yet)
**Decision:** The narrative is assembled from templates. Each sentence uses only facts already in
the profile and carries footnotes.
**Why:** It's free, it can't invent anything, and it's predictable. The brief rules out fabrication
and avoids paid AI.
**Later:** An AI model could rewrite the same cited facts into livelier prose. The input would be
the profile's facts and citations only, and the output would be checked so every sentence still
maps to a footnote. That would need an API key and would cost money, so it needs the owner's
approval first.

### D5. Three levels of certainty, shown everywhere
- **Documented:** official records and researched designations (LPC, DOB filings, ACRIS documents).
- **Recorded:** administrative data that is often approximate (PLUTO "year built", footprint year).
- **Reported:** community sources (Wikidata). Useful leads, not authorities.

Disagreements are shown, never silently resolved. For example, One Times Square is 1908 in city
data but the Times Tower opened in 1904. The full pilot run flagged construction-date conflicts for 51 of
250 landmarks (20%), which is why this matters.

### D6. Future database: Supabase (Postgres) free tier, only when needed
`DATA_MODEL.md` contains a ready schema. It is not used yet because nothing needs storing. Supabase's
free tier pauses inactive projects after a week and caps storage at 500 MB, which is fine for
curated data and a cache but would need checking before relying on it.

### D7. Map: Leaflet + OpenStreetMap tiles
Free, no key. OpenStreetMap's tile servers are for light use only. If the app gets real traffic,
switch to a free-tier tile provider with a key, or self-host tiles. That is a single line in
`app.js`.

### D8. Placeholder building IDs are refused
DOB uses BINs like `1000000` for "no building number". Some LPC records carry one (one Rockefeller
Center entry did). Querying by a placeholder pulls in thousands of unrelated buildings' records, so
the app refuses to query by placeholder BINs and falls back to lot-level (BBL) data only.
