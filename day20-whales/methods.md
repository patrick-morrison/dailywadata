# Day 20 - Whale Sightings

**Author:** Aren Leishman

As scientists voyaged around the Kimberley between 2008 and 2011 during their whale tracking research, the latitude, longitude, and number of whales sighted. This has been visualised with the ability to scroll through time, select windows, and showcase research that has been undertaken.

[Download data from dataWA](https://data.gov.au/data/dataset/wamsi-2-kimberley-node-project-1-2-1b-monitoring-of-humpback-whales-megaptera-novaeangliae-_7e9)

**Licence:** CC BY 4.0 — [Creative Commons Attribution](https://creativecommons.org/licenses/by/4.0/)

---

## Processing

The only preprocessing needed was converting the original excel files to a single CSV for handling on the web, this was done using the convert_data.py script available under day 20 in github.

## Tech Stack

HTML/CSS/JS webmap. Utilising the modern and open MapLibre GL for basemap rendering, the whales are then added as a scatterplot layer on top. There is a chartJS chart rendering the timeline, with the native functionality used to animate the timeline showing features on the map.