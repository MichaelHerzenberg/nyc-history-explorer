# NYC History Explorer

Discover the documented history of New York City buildings, one address at a time.

Search an address, tap a building on the map, or press **Near me** while walking. The app gathers
public records about that building (construction, landmark designations, Department of Buildings
filings, property documents, archival photos) and assembles them into a sourced timeline and a short
written history. Every statement links to the record it came from, and the page says plainly what
is unknown or where sources disagree.

**Status (October 2026): working prototype.** Pilot area is Midtown Manhattan (23rd–59th Streets,
3rd–9th Avenues), but search works citywide. See [`docs/pilot-report.md`](docs/pilot-report.md) for
measured reliability across the pilot's landmark buildings.

**Cost: $0.** No server, no database, no paid APIs, no AI subscription. The website is plain files;
each visitor's browser asks the public data sources directly.

---

## Try it on your computer

You need [Node.js](https://nodejs.org) (version 18 or newer, free). Nothing else to install.

1. Download this project (on GitHub: green **Code** button → **Download ZIP**, then unzip).
2. Open a terminal in the project folder:
   - **Mac:** open Terminal, type `cd ` (with a space), drag the folder onto the window, press Enter.
   - **Windows:** open the folder, click the address bar, type `cmd`, press Enter.
3. Type `npm start` and press Enter.
4. Open **http://localhost:8080** in your browser. Press **Ctrl+C** in the terminal to stop.

## Put it online for free (GitHub Pages)

Do this once:

1. Make sure the repository is **Public** (GitHub → repository → **Settings** → **General** → bottom
   of page, "Change visibility"). Free GitHub Pages needs a public repository.
2. Go to **Settings** → **Pages**. Under "Build and deployment" → "Source", choose **GitHub Actions**.
3. Go to the **Actions** tab, choose **Test and deploy**, click **Run workflow**.

After a minute or two the site is live at `https://<your-username>.github.io/nyc-history-explorer/`.
From then on, every change saved to the `main` branch is tested and published automatically. If a
test fails, the old version stays online and the Actions tab shows a red ✗.

"Near me" needs `https://`, which GitHub Pages provides. Location never leaves the visitor's phone
except as a map query to NYC Open Data.

## Check that it works (tests)

| Command | What it checks | Needs internet? |
|---|---|---|
| `npm test` | Address matching, date handling, and that the Empire State Building profile is built correctly from saved data: right IDs, right facts, every statement cited, disagreements flagged, outages handled | No |
| `npm run test:live` | The real public sources still answer the way the app expects (ESB by address, by map click, "near me" at Times Square, landmark layer, autocomplete) | Yes |
| `npm run pilot` | Builds profiles for a sample of 40 Midtown landmarks and writes `docs/pilot-report.md` (`-- --all` for every landmark) | Yes |

## Save a copy of a building's data

```
npm run snapshot -- --bin 1015862
npm run snapshot -- "350 Fifth Avenue"
```

This writes the raw source responses to `data/raw/<BIN>.json` and the finished profile to
`web/data/buildings/<BIN>.json`. The website uses a saved profile as a fallback if the live sources
are down.

## How it is organised

```
web/                  the website (this folder is what gets published)
  index.html          page layout
  style.css           look and feel (light and dark mode)
  app.js              map, search, "near me", building page
  lib/config.js       pilot area, data source addresses, dataset IDs
  lib/address.js      address clean-up and ID helpers
  lib/identity.js     works out which building you mean (address/click → BIN + BBL)
  lib/sources.js      fetches raw records from each source
  lib/profile.js      turns raw records into facts, timeline, gaps, conflicts
  lib/narrative.js    writes the cited story from the profile
  data/buildings/     saved profiles (fallback copies)
data/raw/             saved raw source responses (not published)
scripts/              local server, snapshot and pilot-check tools
test/                 automated tests and saved test data
docs/                 decisions, data sources, data model, to-do list
```

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): what was built and why, in plain English
- [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md): every source, verified status, licence, limits
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md): how buildings are matched across databases, the profile format, future database schema
- [`docs/TODO.md`](docs/TODO.md): what is unfinished, in priority order
- [`docs/pilot-report.md`](docs/pilot-report.md): latest reliability run

## Credits

Data: NYC Open Data (Department of Buildings, Department of Finance/ACRIS, Landmarks Preservation
Commission, Department of City Planning, Office of Technology & Innovation), NYC GeoSearch,
Wikidata (CC0), Wikimedia Commons (per-image licences), Library of Congress.
Map: © OpenStreetMap contributors, rendered with Leaflet.
