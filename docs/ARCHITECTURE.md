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
 │       DOB · ACRIS · LPC · PLUTO · Footprints (all NYC Open Data)
 │  3. profile.js   raw records ──► facts, timeline, gaps, conflicts
 │  4. narrative.js profile ──► cited story                      │
 │  5. app.js       map + building page                          │
 └───────────────────────────────────────────────────────────────┘
          │ HTTPS, straight to each public source; no server of our own
          ▼
  data.cityofnewyork.us · geosearch.planninglabs.nyc · tile.openstreetmap.org
  (loc.gov on request)
```

The same `web/lib/*.js` code also runs under Node.js for the tests, the snapshot tool and the pilot
check, so there is exactly one copy of the logic.

## Decisions

### D1. No server and no database for the prototype
**Decision:** The site is static files. Each visitor's browser queries the public APIs directly.
**Why:** It costs nothing, has nothing to maintain or patch, and can't go down for lack of payment.
All the core sources (NYC Open Data, GeoSearch) allow browser access (CORS),
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
in ACRIS). IDs don't drift. See `DATA_MODEL.md` for the full matching rules.

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
- (v0.1 also had **Reported** for Wikidata; removed in D9.)

Disagreements are shown, never silently resolved. For example, 49 West 28th Street (Tin Pan Alley)
is circa 1852 in the LPC survey but 1920 in both PLUTO and the footprint data. The 2026-10-30
pilot run flagged date conflicts for 36 of 250 landmarks (14%).

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

### D9. No wiki sources (owner decision, 2026-10-30)
**Decision:** Wikidata, Wikipedia and Wikimedia Commons are removed: no facts, events, photos or
links from them.
**Why:** The owner judged them not dependable enough. Anyone can edit them, and the v0.1 pilot found
errors (e.g. a 1984 "inception" date for the 1902 Knox Building).
**Cost:** No photos for now; no National Register / National Historic Landmark dates; fewer
corroborating sources. Photos return when an archival source is added (1940s tax photos, NYPL),
see TODO.

### D10. Full citations
Every story sentence has numbered footnotes, and the citation list is always shown (not collapsed).
Each citation gives the source, the publishing agency, the specific record (job number, document
ID, LP number) where there is one, the access date and the link. Timeline entries and key facts
also show their sources inline.

### D11. One NYPL image per building, chosen ahead of time (2026-10-30)
**Decision:** `scripts/nypl-photos.mjs` searches NYPL Digital Collections for each pilot landmark,
picks at most **one** public-domain image, and saves it to `web/data/nypl-photos.json`. The website
reads that file; visitors never call the NYPL API.
**Why:** NYPL's API needs a key, and anything on a public website is visible to everyone, so the key
must stay off the site. NYPL also allows 10,000 requests a day. One search plus up to four
catalogue checks per building keeps a full pilot run near 300 requests (the script enforces a hard
cap, `--max-requests`, default 1,000).
**Matching is strict** (`scripts/photo-match.mjs`, with tests built from real wrong matches): the
title must name the building, short names must be a whole phrase, menus/programs/portraits are
rejected, and images dated before the building was built are rejected. The first loose attempt
matched a fish, a play, menus and predecessor buildings; the strict rules found 25 buildings with a
confident match, all checked by eye. Better to show no picture than the wrong one.
**Token:** kept only in a private file in the working session, never committed. To refresh,
run `NYPL_TOKEN=... node scripts/nypl-photos.mjs --refresh`.

### D12. 1940s.nyc not used (2026-10-30)
The 1940s tax photos would be ideal, and 1940s.nyc indexes them by block and lot. But its terms of
use prohibit automated access, republishing or publicly displaying its content without written
permission, and "unauthorized framing of or linking to the Site". So we don't use it. The photos
belong to the NYC Municipal Archives; the route is the Archives' own site or permission from
them (see TODO).

### D13. Headline-first pages (2026-10-30)
The owner wants a building's headlines, not paperwork: who built it, when and for whom, major
changes, who occupied it, and notable events. The story now has four parts (Origins, Changes over
time, Businesses here, On the block). Permit counts, violations, mortgages and deed chains are kept
but moved to a collapsed "Full records" section, and the timeline shows highlights by default.

### D14. Tenants from three kinds of record
Offices: New York State Department of State filings (principal-office and chief-executive
addresses only). Shops and restaurants: City licences and restaurant inspections. Older tenants:
leases recorded in ACRIS, skipping leases between the owner's own companies. None of these has
company size, so lists are ordered by length of stay, not importance.

### D15. On the block: murders and fires (owner's lookup)
`web/lib/nycLookup.js` is the owner's module (murders within a radius from NYPD complaint data;
fires on the street within the ZIP from FDNY). Fixed in place: numbered avenues for FDNY
("FIFTH" -> "5"), FDNY's double-spaced spellings, and several ZIP codes per building. Only murders
and serious fires (all hands or second alarm and up) reach the story and timeline; victim details
are never shown.
