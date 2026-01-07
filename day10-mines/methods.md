# Day 10 - Abandoned Mines

**Author:** Aren Leishman

Western Australia has a very mining oriented history and economy, and a critical part of a mines lifecycle is its remediation and cleanup once the extraction of the commodity is complete. Knowing the condition and status of various abandoned mine features is valuable not just from the perspective of safety and land management, but also from a historical and archaeological lens. The remains of past mining operations give insight into the history of regions and work practices throughout WA.

[Download data from dataWA](https://catalogue.data.wa.gov.au/dataset/abandoned-mines)

**Licence:** CC BY 4.0 — [Creative Commons Attribution](https://creativecommons.org/licenses/by/4.0/)

---

## Processing

The only preprocessing needed was converting the downloaded dataset to a CSV for handling on the web.

## Tech Stack

HTML/CSS/JS webmap. Utilising the modern and open MapLibre GL for basemap rendering, the mines are then added as a scatterplot layer on top. To better analyse the dataset the feature type, condition, base condition, stability, and mined commodity are able to be visualised by colour. It is also possible to filter on these fields plus a few more. Clicking on a feature brings up its detailed record as well as its link on minedex.