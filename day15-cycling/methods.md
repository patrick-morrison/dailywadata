# Day 16 — WA Cycling Routes

**Author:** Coen Arrow

An interactive map of Western Australia's Long Term Cycle Network (LTCN), showing 11,281 route segments across metro Perth and regional WA. Understand planned vs. existing infrastructure, filter by route type (primary, secondary, local, transport trails), and explore cycling connectivity across the state.

## Data Source

**Long Term Cycle Network (LTCN)** from the Department of Transport Western Australia:

- [Metro Cycle Routes (LTCN)](https://catalogue.data.wa.gov.au/dataset/ltcn-dot-043) — 7,531 segments across Perth metropolitan area (33 LGAs)
- [Regional Cycle Routes (LTCN)](https://catalogue.data.wa.gov.au/en/dataset/regional-long-term-cycle-network-ltcn-dot-036) — 3,750 segments across regional WA

[Cycle Network Hierarchy Guide](https://www.transport.wa.gov.au/getmedia/54bb61d7-856e-4690-ac49-09708a138780/AT_P_WA_CycleNetwork_Hierarchy-FINAL-ua.pdf) (PDF) explains route types and planning levels.

**Licence:** CC BY 4.0 — [Creative Commons Attribution](https://creativecommons.org/licenses/by/4.0/)

---

## Processing

1. **Data Conversion:** GeoDataBase to GeoJSON format via [MyGeoData Cloud](https://mygeodata.cloud/)
2. **Geometry Preservation:** No simplification—original route accuracy maintained
3. **Attribute Retention:** All properties preserved for detailed route information

---

## Tech Stack

**MapLibre GL** (v4.7.1) for basemap rendering, **Deck.gl** (v9.0.16) for line visualization with:

- Dual-layer rendering (metro and regional networks independently toggleable)
- Color-coded hierarchy types: Primary (blue), Secondary (green), Local (red), Transport Trail (orange), Road Cycling (purple)
- Status indication via line style: solid = implemented, dashed = planned/draft
- Click-to-inspect route details (name, type, status, length)
- Dark/light basemap toggle (Carto)
- Geolocation feature with optional GPS tracking

---

## Notes

**Length Measurements:** Datasets contain two length fields with different units. `Shape_Leng` (meters) and `Shape_Length` (degrees). The map displays `Shape_Leng` in m. 

**Route Status:** Solid lines = Final LTCN (metro) or Existing (regional). Dashed lines = Draft LTCN (metro) or Proposed (regional). Some planned routes overlap existing infrastructure in areas marked for improvement.