# Day 1 — Wadjemup Rottnest Bathymetry

**Author:** Patrick Morrison

Perth Bathymetric LiDAR from the **Department of Transport Western Australia** (December 2009, 10m grid).

Covers Perth, Rottnest, Warbro, Cockburn Sound, and Ocean Reef.

[Download data from DoT Geospatial Portal](https://www.transport.wa.gov.au/marine/charts-warnings-current-conditions/coastal-data-charts/geospatial-data)

**Licence:** CC BY 4.0 — [Creative Commons Attribution](https://creativecommons.org/licenses/by/4.0/)

---

## Processing

Individual survey grids combined as a virtual raster in QGIS, exported as a 25% Float32 DEFLATE COG (from 568 MB to 14 MB).

## Tech Stack

HTML/CSS/JS webmap. I wanted a chance to upgrade from my Leaflet map experience, so this uses the modern and open MapLibre GL for basemap rendering. deck.gl: colours and hillshades the bathymetry on the client side. GeoTIFF.js reads the COG to show depth on click.
