# Methods: Trees in the City

## Source
**Local Government Authority (LGA) Tree Data** from the [City of Perth](https://catalogue.data.wa.gov.au/dataset/perth-trees-in-the-city), accessed via data.wa.gov.au. The dataset contains point locations for street trees within the City of Perth boundaries.

## Processing
The CSV data was parsed directly in the browser using PapaParse. Key fields used:
- `Scientific Name` for species identification.
- `Latitude` / `Longitude` for positioning.
- `Year Planted` (where available) for potential future visualization.

## Tech Stack
- **MapLibre GL JS**: Handles the light paper base map rendering.
- **Deck.gl**: Renders the high-performance scatterplot layer for tree points and the "Radar" visuals (rings, crosshairs).
- **Turf.js**: Performs geospatial calculations for the "Radar" filter (distance collection) and bearing calculations.
- **Custom CSS/JS**: Implements the "Light Paper Radar" aesthetic with a "North Wedge" beam and dark UI shelf.

## Author
Patrick Morrison (2026)
