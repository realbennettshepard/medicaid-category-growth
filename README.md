# U.S. Medicaid — high-growth service categories

A standalone, static web tool that maps 10 fraud-risk Medicaid service categories across
the United States: their **growth over time** (2018–2024) and their **temporospatial**
spread — nationally **by state**, or drill into **any state's counties**. Pick a category
to drive the choropleth; scrub or play the year slider to watch spending spread; toggle
total vs. per-resident and billing vs. point-of-care attribution.

No backend, no build step at runtime — just static files. Host it anywhere.

## Run locally

```bash
cd mn-medicaid-growth
python3 -m http.server 8077
# open http://localhost:8077
```

(Must be served over HTTP, not `file://` — the page `fetch()`es the JSON/topojson.)

## Deploy (any static host)

The whole folder is static — GitHub Pages, Netlify/Vercel/Cloudflare Pages (no build
command), or `aws s3 sync . s3://bucket`. All assets (D3, topojson, Chart.js, US state +
county maps) are bundled — **no CDN/network dependencies** at runtime.

## How it works

- **Default view:** US states choropleth for the selected category. Top list = top states.
- **Drill down:** pick a state from the Geography dropdown → it lazy-loads that state's
  county file and switches to a county choropleth. Top list = top counties.
- **Year slider + ▶ play:** animate 2018→2024. Color domain is fixed per category, so the
  animation shows real growth (places "light up" over time).
- **Metric:** Total $ or Per resident (divides by state/county population).
- **Attribute by:** Billing provider (where the agency bills) or Point of care (servicing
  provider — closest patient-proximate lens the data allows).

## Files

```
index.html                  markup + layout
styles.css                  styling (self-contained light theme)
app.js                      data load, landscape, D3 choropleth (state + county), Chart.js
data/national.json          category × STATE × year (both attributions) + national landscape  (~120 KB)
data/states/<FIPS>.json     category × COUNTY × year for one state, lazy-loaded (51 files)
data/us-counties.topo.json  US state + county + nation boundaries (one TopoJSON, both map levels)
vendor/                     d3 v7, topojson, Chart.js (bundled, offline)
build_data.py               regenerates all data from the source DuckDB
```

## Data provenance

- **Source:** HHS OpenData `medicaid-provider-spending` (national, 2018-01 → 2024-12,
  monthly). 14.9M categorized claim rows.
- **Metric:** summed `TOTAL_PAID` (Medicaid paid amount), in $M.
- **Geography (two attributions):**
  - *Billing provider* — billing NPI primary ZIP (NPPES) → county FIPS (state = FIPS[:2]).
  - *Point of care* — servicing NPI county (else billing). The dataset has **no patient
    address**, so this is the closest patient-proximate lens — still provider-based.
    Switching attribution moves only **~5.5%** of categorized spend to a different county;
    concentrated in clinician-delivered, agency-billed services (ABA, mental/behavioral
    health, peer recovery). Each category's shift shows in the map subtitle.
- **Coverage:** ~**82%** of categorized national paid maps to a county/state (some
  institutional billers use non-residential ZIPs absent from the ZIP→county crosswalk).
  Surfaced in the footer.
- **Category crosswalk:** every HCPCS→category assignment is auditable in
  `../Medicade/mn_service_category_crosswalk.csv`. Categories are non-overlapping; DME =
  any `E#`/`K#` HCPCS code.

### Honesty notes (also in the app footer)

- **2018 is under-reported** (ramp-up); 2019 is the first clean full year. Headline growth
  uses **2019→2023**. **Dec 2024 has claims runout** — late-2024 dips are partly artifact.
- Junk HCPCS code `"20"` ($20T) is excluded by construction.
- **ABA** CPT codes (97151–97158) began 2019, so 2018 ≈ $0.
- **Integrated Community Supports** and **Housing Stabilization Services** are partly
  MN-specific program *names*; nationally they map to broad HCPCS proxies (H2015/H2016,
  H0043/H0044), so read Tier 3 national figures with that caveat.
- Counties/states are **provider** location, not patient residence. "Per resident" divides
  by the unit's population — a screening flag, not a true per-capita rate.

## Regenerate the data

Requires the source DuckDB + parquets in the sibling `Medicade/` project:

```bash
python3 build_data.py   # rewrites data/national.json and data/states/*.json (~8s)
```
