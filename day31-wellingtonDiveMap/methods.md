# Day 31 — Wellington Dam Dive Map

**Author:** Aren Leishman

Wellington Dam is one of Western Australia's largest inland water bodies, located on the Collie River near Collie. This interactive dive map visualizes bathymetry data collected via multibeam sonar surveys, overlaid with dive survey lines recorded during exploration of the submerged dam bed.

## Data Sources

### Bathymetry

Two Cloud Optimized GeoTIFF (COG) files provide the underwater terrain visualization:

- **WellingtonBathy_cog.tif** (2.8 MB, 1.2m resolution): Full coverage bathymetry of the surveyed areas
- **WellingtonHdBathy_cog.tif** (1.6 MB, 0.6m resolution): High-resolution overlay for a subset area

Both datasets are in EPSG:3857 (Web Mercator) with elevations stored in meters AHD (Australian Height Datum).

### Survey Lines

Five CSV files contain dive survey track data recorded with a cave survey tool:

- `north_adjusted.csv` - Northern survey line (57 points)
- `south_adjusted.csv` - Southern survey line (40 points)
- `northT1_adjusted.csv` - Northern traverse 1
- `northT2_adjusted.csv` - Northern traverse 2
- `southT1_adjusted.csv` - Southern traverse 1

Each CSV contains:
- Y, X: WGS84 coordinates (latitude, longitude)
- Elevation: Depth below water surface at time of survey (negative values)
- Additional survey metadata (heading, pitch, temperature, etc.)

### Water Level Estimation

The water level at the time of survey was calculated by cross-referencing the survey depths with the bathymetry elevations:

```
water_level_AHD = bed_elevation_AHD - survey_depth
```

Using 126 matched points between the survey and bathymetry datasets:
- **Median water level: 156.96m AHD**
- Standard deviation: 0.69m
- Range: 154.70m to 158.34m AHD

This cross-reference was performed using `generate_volume_lookup.py`, a Python script included in the project folder.

Current Water Corporation reported storage: **84.35 GL** (January 2026)

## Processing

### Bathymetry Visualization

1. Bathymetry elevations (meters AHD) are converted to depth below water surface:
   ```
   depth = water_level_AHD (156.96m) - bed_elevation_AHD
   ```

2. Depth values are mapped to the Turbo colormap:
   - Blue/purple: Shallow (0-5m)
   - Green/yellow: Medium (10-20m)
   - Orange/red: Deep (25-31m)

3. Pixels above the water level are rendered transparent

4. Hillshade layer provides depth perception

### Contour Generation

Depth contours are generated dynamically at render time using the d3-contour library:
- 5m intervals at zoom levels 14-15
- 2m intervals at zoom levels 16+
- Contours are labeled with depth values

### Survey Line Display

Survey CSV files are parsed and rendered as colored line features:
- Each survey line has a distinct color for identification
- Click survey lines in the legend to zoom to that line
- Full survey metadata available on hover

## Technical Implementation

HTML/CSS/JavaScript web map using:

- **MapLibre GL JS 4.7.1**: WebGL map rendering
- **@geomatico/maplibre-cog-protocol 0.5.0**: Cloud Optimized GeoTIFF direct loading
- **GeoTIFF.js 2.1.3**: GeoTIFF parsing for contour generation
- **d3-contour 4.0.2**: Marching squares algorithm for contour extraction

Key differences from Day 24 (Abrolhos Dive Trail):
- 100% bathymetry opacity (vs 50%)
- Dual bathymetry layers (standard + HD overlay)
- Depth reference from AHD elevation (vs sea level)
- Survey lines from CSV (vs GeoJSON markers)
- Depth gradient legend bar

## Wellington Dam Facts

- **Location**: Collie River, 8km SW of Collie, Western Australia
- **Coordinates**: 33°23'S, 115°59'E
- **Full Supply Level**: ~165.5m AHD
- **Total Capacity**: ~185 GL
- **Current Storage**: 84.35 GL (January 2026)
- **Bed Elevation Range**: 126m to 160m AHD (surveyed areas)
- **Maximum Surveyed Depth**: ~31m below current water level

## Sources

**Bathymetry**: Multibeam sonar survey data

**Survey Lines**: Dive survey data, January 2026

**Water Level**: [Water Corporation of Western Australia](https://www.watercorporation.com.au/water-supply/rainfall-and-dams/dam-levels)

**Basemap**: Esri World Imagery

**Libraries**:
- [MapLibre GL JS](https://maplibre.org/) (BSD-3-Clause)
- [@geomatico/maplibre-cog-protocol](https://github.com/geomatico/maplibre-cog-protocol) (ISC)
- [GeoTIFF.js](https://geotiffjs.github.io/) (MIT)
- [d3-contour](https://github.com/d3/d3-contour) (ISC)

**Licence:** CC BY 4.0 — [Creative Commons Attribution](https://creativecommons.org/licenses/by/4.0/)
