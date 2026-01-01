# Day 29 — Swan River Route Planning

**Author:** Patrick Morrison

Interactive route planner for scooter diving in the Swan River, Western Australia.

## Data Source

Swan-Canning Multibeam Survey (SC2010) from **Department of Transport Western Australia**.

[Download from Data WA Catalogue](https://catalogue.data.wa.gov.au/dataset/bathymetry-catalogue)

**Licence:** CC BY 4.0

**Coordinate System:** GDA94 / MGA zone 50 (EPSG:28350)

---

## Processing

BAG file was hole-filled in QGIS and exported as a GeoTIFF. Optimized for web streaming by converting Float32 meters to Int16 (×100) at 25% resolution. Reduced from 731MB to 3.2MB.

The GeoTIFF retains the original GDA94 / MGA zone 50 projection. On-the-fly conversion to Web Mercator (EPSG:3857) happens client-side for web map display.

```bash
gdal_translate SC20100413_Interpolated.tif SC20100413_optimized.tif \
  -of COG \
  -ot Int16 \
  -scale -22 -1 -2200 -100 \
  -a_nodata -32768 \
  -co COMPRESS=DEFLATE \
  -co PREDICTOR=2
```

---

## Tech Stack

- **MapLibre GL** — Vector basemap rendering
- **deck.gl** — Bathymetry colouring and hillshade
- **GeoTIFF.js** — COG streaming and depth queries
- **Chart.js** — Depth profile visualization

---

## Contour Pathfinding

A* search on the bathymetry grid finds routes that follow depth contours:

- **Tolerance:** ±1 meter from target depth
- **Depth penalty:** Discourages deviation from target depth
- **Directness penalty:** Prevents unnecessary wandering
- **Direct path check:** Skips routing if straight line is already within tolerance

Routes are simplified using Ramer-Douglas-Peucker (epsilon ~5.5m) and always snap to exact waypoint coordinates.

---

## Share URLs

Route configuration encoded in URL parameters:
- `s` — Speed value
- `u` — Unit (m/min, knots, m/s)
- `p` — Waypoints as semicolon-separated lng,lat pairs
- `l` — Leg types (b=bearing, c=contour)
