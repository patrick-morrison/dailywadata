# Day 21 — High Resolution National High Tide Coastline History

**Author:** Nick Wright


### Rationale

Tracking coastline changes is critical for understanding coastal erosion, sea level rise impacts, and land use planning. This map makes it easy to visualise how Australia's high tide boundary has shifted between 2016 and 2022, with the ability to toggle individual years or animate through time to spot patterns of change.

### Source

High Resolution National High Tide Coastline History (DPIRD-094) from the Department of Primary Industries and Regional Development via [Data WA](https://catalogue.data.wa.gov.au/dataset/high-resolution-national-high-tide-coastline-history-dpird-094). Derived from Sentinel-2 satellite imagery using the Normalised Difference Water Index. CC BY 4.0.

### Processing

Data is fetched directly from the WA SLIP (Shared Location Information Platform) WFS service in GeoJSON format, then rendered on the map using Leaflet with custom styling.

### Implementation Details

HTML/CSS/JS webmap using Leaflet for basemap rendering with Esri World Imagery tiles. Coastline vectors are loaded dynamically via WFS requests scoped to the current map viewport. Features include per-year colour-coded layers with toggle controls, an animation mode to cycle through years automatically, and debounced loading to avoid excessive requests during pan/zoom.


