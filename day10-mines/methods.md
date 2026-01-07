# Day 3 - Public Lighting Infrastructure

**Author:** Aren Leishman

Streetlights of the WA area as managed by Western Power, and thus does not cover all of WA.

The dataset has the ID of each streetlamp, as well as the wattage and type of bulb installed.

[Download data from dataWA](https://catalogue.data.wa.gov.au/dataset/streetlights-wp-043)

**Licence:** CC BY 4.0 — [Creative Commons Attribution](https://creativecommons.org/licenses/by/4.0/)

---

## Processing

The only preprocessing needed was converting the downloaded dataset to a CSV for handling on the web.

## Tech Stack

HTML/CSS/JS webmap. Utilising the modern and open MapLibre GL for basemap rendering, the mines are then added as a scatterplot layer on top. To better analyse the dataset the feature type, condition, base condition, stability, and mined commodity are able to be visualised by colour. It is also possible to filter on these fields plus a few more. Clicking on a feature brings up its detailed record as well as its link on minedex.