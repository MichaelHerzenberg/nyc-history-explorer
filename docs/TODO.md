# To do

In rough priority order. ✅ = done, ⬜ = not started, 🟡 = partly done.

## Done in v0.1 (2026-10-27)
- ✅ Verified the core public sources from a live server (see `DATA_SOURCES.md`)
- ✅ Address/click/near-me → BIN + BBL matching, with a visible match log
- ✅ Empire State Building proof of concept: DOB, ACRIS, LPC, PLUTO, footprints
- ✅ Wiki sources removed; full citations shown (2026-10-30)
- ✅ Sourced timeline, key facts, conflicts, gaps, cited story, research links
- ✅ Map: pilot outline, landmark dots, clickable footprints at street zoom, highlight
- ✅ Offline tests (13), live tests (5), pilot reliability script and report
- ✅ GitHub Pages deploy workflow (runs tests first)

## Next
0. ⬜ **Check the aerial slider on a real browser**: confirm which years load (only 1924 and 1951 are proven).
1. ⬜ **Publish**: create the GitHub repository, push, turn on Pages (steps in README). *Owner action needed.*
2. ⬜ **Test on a real phone in Midtown**: "Near me" accuracy between tall buildings; whether
   Library of Congress search works from a phone browser.
3. 🟡 **Photos**: ✅ one NYPL image for 25 pilot landmarks (2026-10-30). ⬜ 1940s tax photos via the
   Municipal Archives' official site (1940s.nyc ruled out by its terms): needs network access to
   `nycrecords.access.preservica.com` and `www.nyc.gov`, then read their reuse terms.
4. ⬜ **NYPL city directories** (key now in hand): past occupants and businesses, the biggest gap.
5. ⬜ **Newspapers**: confirm browser access to loc.gov. If it works, show top matches
   automatically for landmarks, clearly labelled as keyword matches.
6. ⬜ **Condos**: follow unit lots in ACRIS so condo sales show up (currently only the billing lot).
7. ⬜ **Demolished / historic buildings**: retired BINs and old addresses (e.g. the Waldorf-Astoria
   that stood on the ESB site). Needs LPC research links and historic address search.
8. 🟡 **Pilot expansion**: all 250 designated landmarks in the pilot assemble (see `pilot-report.md`).
   Non-landmark buildings work live but have thinner records. Consider snapshots for the pilot
   landmarks if live loading proves slow.
9. ⬜ **Map tiles**: if traffic grows past light use, move off `tile.openstreetmap.org` to a free
   keyed tier or self-hosted tiles (OSM tile usage policy).
10. ⬜ **Socrata app token** (free) to raise NYC Open Data rate limits.
11. ⬜ **AI-written prose (optional, costs money)**: feed the cited facts to an AI model for more
    readable stories, keeping every sentence footnoted. Needs owner approval for API costs.
12. ⬜ **Database** (Supabase free tier) once there is hand-curated research to store. Schema is
    ready in `DATA_MODEL.md`.

## Known issues
- DOB descriptions are shown as filed (abbreviations and typos included).
- Some LPC report URLs are inferred from the LP number. Spot-checked, but not every one has been
  tested.
- "Built" uses the LPC range when available. Other sources' values are listed and disagreements
  flagged, but not resolved.
- Footprints load only at zoom 17+ (up to 3,000 per view) to keep the map fast.
