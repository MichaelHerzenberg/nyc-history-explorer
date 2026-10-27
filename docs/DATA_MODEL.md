# Data model and address matching

## 1. Identifiers

| ID | Means | Example (Empire State Building) | Who uses it |
|---|---|---|---|
| **BIN** | Building Identification Number: one per building | `1015862` | DOB, footprints, LPC building data, Wikidata (P6082) |
| **BBL** | Borough-Block-Lot: one per tax lot (borough 1 digit, block 5, lot 4) | `1008350041` = Manhattan, block 835, lot 41 | PLUTO, ACRIS, LPC sites |
| **Address** | Many per building, spelled differently everywhere | 350 Fifth Ave / 338 5 Avenue / 338-350 Fifth Ave | everyone, inconsistently |
| **LP number** | Landmark designation | `LP-02000` (exterior), `LP-02001` (interior) | LPC |
| **Wikidata QID** | Wikidata item | `Q9188` | Wikidata, Commons |

A lot can hold several buildings (several BINs, one BBL). A large building can sit on a lot shared
with others. Condominiums split one building into many unit lots (75xx billing lot plus unit lots).

## 2. Matching steps (implemented in `web/lib/identity.js`)

1. **Typed address** → GeoSearch (City's Property Address Directory) → BIN + BBL + point.
   The matched label is shown so the user can see what was understood.
2. **Map tap** → footprint containing the point → BIN. **"Near me"** → footprints within
   ~40–150 m (scaled to GPS accuracy), nearest first. The user picks, because a corner or a
   multi-entrance block often has several candidates.
3. **BIN → footprint** cross-check: confirms the lot (`base_bbl`) and gets the outline. If the
   footprint's lot differs from the address lot, the address lot wins and the difference is logged.
4. **Condos**: PLUTO is queried with the footprint's `mappluto_bbl` (the billing lot).
5. **Placeholder BINs** (`1000000`, `2000000`, …) are never used for queries (Decision D8).
6. Every step is written to `match_log` and shown under "How this page was assembled".

Addresses from all sources are normalised (`normalizeAddress`: FIFTH→5, AVE→AVENUE, W→WEST,
33RD→33, Avenue of the Americas→6 AVENUE) and grouped, so the page lists every known spelling and
which sources use it.

**Known limits:** historical addresses that no longer exist aren't in GeoSearch. Demolished
buildings have retired BINs with no footprint. Neither case is handled yet (see TODO).

## 3. Building profile (the normalised record)

Produced by `buildProfile(identity, raw)`. Saved copies live in `web/data/buildings/<BIN>.json`.
`schema_version: 1`.

```
title, address                      display name and best address
identity { bin, bbl, pluto_bbl, borough, block, lot, lat, lng, condo, wikidata, wikipedia }
geometry                            GeoJSON footprint
match_log [ { step, source, detail } ]
addresses [ { address, normalized, sources[] } ]
facts     [ { key, label, value, cite[] } ]
timeline  [ { date (ISO or null), precision, date_label, category, certainty, title, detail, cite[] } ]
            category: construction | alteration | demolition | landmark | ownership | occupancy | event
            certainty: documented | recorded | reported
conflicts [ { field, values [ { value, source } ], note } ]
gaps      [ text ]                  what is missing or unknown, in plain English
dob       { totals, first_filing, by_decade[] }
ownership { deeds[], documents_by_class, earliest_document, total_documents, lot }
media     [ { title, thumb, full, page, date, year, historic, description, artist, license, license_url } ]
reports   [ { label, url } ]        LPC designation reports
research_links [ { group, label, url, note } ]
sources   { key: { label, publisher, url, license, caution } }
source_status [ { key, ok, count, error, retrieved_at } ]
narrative { paragraphs [ { heading, sentences [ { text, refs[] } ] } ], citations[], method }
```

`cite` = `{ source, url?, note? }`. `url` points at the specific record when one exists (an ACRIS
document, a DOB job, an LPC report), otherwise at the dataset.

## 4. Future database (not used yet)

When curated research or caching is needed, this Postgres schema (works on Supabase's free tier)
keeps the same three layers: raw records, normalised building data, generated text.

```sql
-- Buildings and their identifiers
create table building (
  bin            text primary key,          -- real BINs only; placeholders rejected
  bbl            text not null,
  name           text,
  lat            double precision,
  lng            double precision,
  geometry       jsonb,                     -- GeoJSON footprint
  in_pilot       boolean default false,
  updated_at     timestamptz default now()
);
create table building_address (
  bin            text references building(bin),
  normalized     text not null,             -- e.g. '350 5 AVENUE'
  display        text not null,             -- e.g. '350 Fifth Avenue'
  source         text not null,             -- 'geosearch' | 'pluto' | 'acris' | ...
  primary key (bin, normalized, source)
);
create index on building_address (normalized);

-- Layer 1: raw source records, stored exactly as received
create table source_record (
  id             bigserial primary key,
  source         text not null,             -- 'dob_jobs', 'acris_master', 'wikidata', ...
  source_id      text,                      -- the source's own ID (job number, document_id, QID)
  bin            text,
  bbl            text,
  request_url    text not null,
  retrieved_at   timestamptz not null,
  payload        jsonb not null
);
create index on source_record (bin);
create index on source_record (bbl);
create unique index on source_record (source, source_id) where source_id is not null;

-- Layer 2: normalised events and facts, each tied to the records that support it
create table event (
  id             bigserial primary key,
  bin            text references building(bin),
  date           date,
  date_precision text check (date_precision in ('day','month','year','range','unknown')),
  date_label     text,
  category       text not null,
  certainty      text not null check (certainty in ('documented','recorded','reported','curated')),
  title          text not null,
  detail         text,
  added_by       text default 'pipeline'    -- 'pipeline' or a person's name for hand research
);
create table event_citation (
  event_id       bigint references event(id) on delete cascade,
  source_record_id bigint references source_record(id),
  url            text,
  note           text
);

-- Layer 3: generated text, versioned, never edited by hand
create table narrative (
  bin            text references building(bin),
  generated_at   timestamptz default now(),
  method         text not null,             -- 'template-v1', or the AI model and prompt version
  body           jsonb not null,            -- paragraphs with footnote refs
  primary key (bin, generated_at)
);
```
