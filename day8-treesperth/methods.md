# Methods: Trees in the City

## Source
[City of Perth - Trees in the City](https://catalogue.data.wa.gov.au/dataset/perth-trees-in-the-city) - 314 species across ~30,000 public trees.

## Processing
CSV parsed in-browser with PapaParse. Uses `Scientific Name`, `Latitude`, `Longitude`, `Common Name`, and tree significance attributes. No server-side processing.

## Implementation
- **MapLibre GL JS**: Base map rendering
- **Deck.gl**: High-performance point rendering and radar visuals
- **Turf.js**: Distance calculations and geospatial operations
- **localStorage**: Species collection persistence with save/load

## Features
- 30m proximity radar with smooth GPS interpolation
- 314 species collection tracking
- Offline-capable with localStorage backup
- iOS-compatible compass rotation

Patrick Morrison (2026)
