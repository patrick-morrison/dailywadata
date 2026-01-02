# Day 3 - Public Lighting Infrastructure

**Author:** Aren Leishman

Streetlights of the WA area as managed by Western Power, and thus does not cover all of WA.

The dataset has the ID of each streetlamp, as well as the wattage and type of bulb installed.

[Download data from dataWA](https://catalogue.data.wa.gov.au/dataset/streetlights-wp-043)

**Licence (map):** CC BY 4.0 — [Creative Commons Attribution](https://creativecommons.org/licenses/by/4.0/)
**Licence (data):** [Western Power Data](https://catalogue.data.wa.gov.au/dataset/wp-licence-terms-and-conditions/resource/5c0d580f-85a6-42de-ab47-036e70bcd2ad)

---

## Processing

The only preprocessing needed was converting the downloaded dataset (GDA94 Geopackage) to a EPSG:4326 GeoJSON for easy handling on the web, this dataset was then compressed further by parsing the GeoJSON to a csv, which is parsed back to a GeoJSON at runtime in the browser.

## Tech Stack

HTML/CSS/JS webmap. Utilising the modern and open MapLibre GL for basemap rendering, the streetlamps are then added as a scatterplot layer on top, with the size and color of the bulb determined by the wattage and type respectively.
