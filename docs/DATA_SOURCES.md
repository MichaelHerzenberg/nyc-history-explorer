# Data sources

Status checked **2026-10-27** from a cloud server, using the Empire State Building (BIN 1015862,
BBL 1008350041) as the test case. "In app" means the app uses it today.

## In the app

| Source | What it gives us | Matched by | Verified | Licence / terms | Limits & cautions |
|---|---|---|---|---|---|
| **NYC GeoSearch** (`geosearch.planninglabs.nyc/v2`) | Typed address → official BIN, BBL, coordinates; autocomplete | address text | ✅ search, autocomplete, reverse | Free public API from City Planning, no key | Covers addresses in the City's directory (PAD); returns several candidates, we take the first and show the match |
| **Building Footprints** `5zhs-2jue` | Outline, BIN, lot, roof height, construction year; map click and "near me" | BIN, point, radius | ✅ incl. spatial queries | NYC Open Data terms (free reuse, provided as-is) | "construction_year" is administrative and often approximate |
| **PLUTO** `64uk-42ks` | Tax-lot data: year built, alterations, floors, building class, owner of record, landmark flag | BBL | ✅ | NYC Open Data terms | City Planning warns year built is frequently estimated. Address is the tax address (ESB = "338 5 AVENUE") |
| **LPC Landmark & Historic District Building Database** `gpmc-yuvp` | Researched dates, architect, original owner, style, materials, original use, alterations | BIN | ✅ | NYC Open Data terms | Only buildings in landmarks or historic districts (524 in the pilot area) |
| **LPC Designated and Calendared Buildings and Sites** `ncre-qhxs` | Designation type, LP number, designation and hearing dates | BIN, BBL, location | ✅ | NYC Open Data terms | Some rows use placeholder BIN 1000000 |
| **LPC designation reports** (`s-media.nyc.gov/agencies/lpc/lp/NNNN.pdf`) | Full research report PDF | LP number | ✅ LP-02000 is the ESB report; LP-00001 resolves | Public government record | URL pattern inferred and spot-checked; the "url_report" column in `buis-pvji` is empty |
| **DOB Job Application Filings** `ic3t-wcy2` | Permits/alterations since ~1989 (BIS era): job type, dates, descriptions | BIN | ✅ 3,806 rows for ESB | NYC Open Data terms | Dates are stored as text; original pre-1989 permits are not in the data |
| **DOB NOW: Build filings** `w9ak-ipjd` | Filings since ~2016 | BIN | ✅ | NYC Open Data terms | |
| **DOB Certificates of Occupancy** `bs8b-p36w` | COs (mostly recent) | BIN | ✅ | NYC Open Data terms | Historic COs exist only as scans in BIS |
| **DOB Violations / ECB Violations / Complaints** `3h2n-5cm9`, `6bgk-3dad`, `eabe-havv` | Counts by decade | BIN | ✅ | NYC Open Data terms | |
| **ACRIS** Legals `8h5j-fqxa`, Master `bnx9-e6tj`, Parties `636b-3b5g`, Codes `7isb-wh4c` | Deeds, leases, mortgages, landmark recordings; parties and amounts | BBL | ✅ | NYC Open Data terms | For the ESB lot the data starts in 1971, deeds from 1991. Condo units have their own lots (not yet followed). ACRIS's own website refuses automated requests, so links are for people to click |
| **NYPL Digital Collections API** (`api.repo.nypl.org`) | One public-domain historical image per pilot landmark (25 of 250 matched) | building name + street, checked against catalogue date/genre | ✅ with key (2026-10-30) | Public domain per NYPL rights statement on each item; credit "From The New York Public Library" | Key required, 10,000 requests/day; used only by `scripts/nypl-photos.mjs`, never on the site. Images load from `images.nypl.org` (blocked in the build workspace, so not seen by eye there) |
| **NYC aerial photographs** (`maps.nyc.gov/xyz/1.0.0/photo/{year}/…`) | “Then and now” slider: 1924, 1951, 1996, 2001, 2004–2024 (every two years) | map position | ⚠️ Years and CC BY 4.0 licence from the City's official metadata (github.com/CityOfNewYork/nyc-geo-metadata, `Metadata_AerialImagery.md`). Tile address confirmed only for 1924 and 1951 (used by another public site); `maps.nyc.gov` is blocked in the build workspace. The slider reports any year that fails to load | CC BY 4.0, credited per year (1924 City Planning, 1951 Municipal Archives, later NYS orthoimagery program / OTI) | Max zoom unknown; set to 18 and enlarged beyond |
| **OpenStreetMap tiles** | Base map | — | ✅ | ODbL, attribution shown | Light use only under OSM tile policy (see TODO) |
| **Leaflet 1.9.4** (unpkg.com) | Map library | — | ✅ pinned with integrity hash | BSD-2 | |

## Linked, not fetched automatically

| Source | How it's used | Status |
|---|---|---|
| **Library of Congress, Chronicling America** | "Dig deeper" search links (name and address, from construction to 1963) plus an on-demand search button | ⚠️ loc.gov answered this cloud server with a Cloudflare challenge (HTTP 429). Browser access is **untested**; if it fails the button says so and the links still work. Newspapers before 1929 are public domain; LOC states most content has no known restrictions, but each item should be checked |
| **NYPL Digital Collections** | Search link by building name | ✅ |
| **DOB Building Information System (BIS)** | Link to full DOB file incl. scanned older COs | Standard public URL; BIS refuses automated checks (403), so it wasn't machine-tested |
| **ACRIS website** | Per-document links and BBL search | Standard public URL; redirects automated requests to its bandwidth policy page |
| **ZoLa** (zoning map) | Lot link | Not reachable from build server (not on network allowlist); URL pattern untested |

## Removed (owner decision, 2026-10-30)

| Source | Was used for | Why removed |
|---|---|---|
| Wikidata | Opening dates, heritage listings (NRHP/NHL), notable events, BIN-based matching to images | Community-edited, not dependable; pilot found wrong dates |
| Wikimedia Commons | Photos | Wiki; images were matched through Wikidata |
| Wikipedia | "Background" link | Wiki |

## Investigated, not yet used

| Source | Why it matters | Blocker / next step |
|---|---|---|
| **NYC Municipal Archives 1940s tax photos** | A photo of nearly every lot, around 1940, indexed by block and lot. Probably the single best historical photo source | `1940s.nyc` (volunteer site) **ruled out by its terms** (no automated access, republishing or linking without permission). Official sites (`nycrecords.access.preservica.com`, `www.nyc.gov/site/records`) blocked in the build workspace; their reuse terms are not yet read |
| **NYPL city directories** | Past occupants and businesses | Key now available; next step |
| **NYS Historic Newspapers**, **Fultonhistory** | NYC-heavy newspaper coverage | Check terms and APIs |
| **Socrata app token** | Higher NYC Open Data rate limits | Free; optional field in `web/lib/config.js` |

## Rules we follow

- Prefer official city records. Community sources are labelled and never override them silently.
- Link to the original record. Don't copy full texts we don't have rights to.
- No wiki sources (Wikidata, Wikipedia, Wikimedia Commons): owner decision 2026-10-30.
- When images return, show licence and credit on every one.
- Identify ourselves to APIs (User-Agent in scripts), keep request counts modest, and back off on
  HTTP 429.
