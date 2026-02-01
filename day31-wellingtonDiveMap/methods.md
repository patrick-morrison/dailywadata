# Day 31 — Wellington Dam Dive Map

**Author:** Aren Leishman

Wellington Dam is one of Western Australia's largest inland water bodies, located on the Collie River near Collie. This interactive dive map visualizes bathymetry data collected via multibeam sonar surveys, overlaid with dive survey lines recorded during exploration of the submerged dam bed. It also includes a route planning utility that can either trace along the surveyed lines, follow bearings, or track along contours.

## Data Sources

### Bathymetry

The bathymetry is derived from DOT surveys AS20131211 and AS20130627, the former being 0.5m pixels of the center of the dam and the later being 1m pixels of the remaining surveyed area. This was merged and post processsed to produce a DEM COG, as well as a hillshade layer.

### Survey Lines

**Survey team:** Aren Leishman, Matt Gannicott, Huw Porter, Doreen Ee, Gabriel Feng, Patrick Morrison, Geoff Paynter, Stuart Parsons, Andrew Currie.

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

This cross-reference was performed using `generate_volume_lookup.py`, a Python script included in the project folder. This script also examines the DEM in order to estimate the volume of the dam, so Water Corporations publicly available volume numbers can be used to approximate the dam level and depths.

The current Water Corporation reported storage  **84.35 GL** (January 2026), and this was used to map the incomplete bathymetry of the dam to the surveyed water levels.

## Processing

### Bathymetry Visualization
To minimise the client CPU and network load, the two bathymetry datasets were merged in QGIS, and exported as a geotiff, being sure to export the raw data.

The merged cog was then generated from this by using `gdalwarp -t_srs EPSG:3857 merged_bathy.tif merged_bathy_cog.tif -of COG -b 1 -co COMPRESS=DEFLATE -co NBITS=16 -co PREDICTOR=3`

A similar treatment was given to the hillshade layer, generated in QGIS using a multidirectional light source, however this was exported as a rendered layer, and then converted into a COG by the same means as the elevation data.

The bathymetry is rendered using a custom WebGL layer that reads directly from Cloud Optimized GeoTIFFs:

1. **Elevation to Depth Conversion**: Bathymetry elevations (meters AHD) are converted to depth below water surface:
   ```
   depth = water_level_AHD (156.96m) - bed_elevation_AHD
   ```

2. **Color Mapping**: Depth values are mapped to an inverted Turbo colormap:
   - Red/orange: Shallow (0-5m)
   - Green/yellow: Medium (10-20m)
   - Blue/purple: Deep (25-31m)

   The colormap is inverted so that shallow areas appear warm and deep areas appear cool, matching intuitive depth perception.

3. **Water Level Masking**: Pixels above the current water level are rendered fully transparent, allowing the satellite basemap to show through for exposed terrain.

4. **Dynamic Re-colouring**: Raw elevation data is cached in memory, allowing instant re-colouring when the water level slider is adjusted without re-reading the COG files.

### Hillshade Rendering

The precomputed hill shade is rendered using a multiply blend mode, as this results in the most readable hillshading. This option is not provided by mapLibre so a custom webgl shader is used to achieve this blending.

**Vertex Shader**: Transforms tile coordinates to screen space and passes texture coordinates to the fragment shader.

**Fragment Shader**:
```glsl
vec4 hillshade = texture(u_hillshade, v_texCoord);
if (hillshade.a < 0.5) discard;  // NoData pixels
float lum = hillshade.r;          // Grayscale luminance
fragColor = vec4(lum, lum, lum, u_opacity);
```

**Multiply Blend Mode**: The hillshade layer uses WebGL blend function `gl.blendFunc(gl.DST_COLOR, gl.ZERO)`, which multiplies the destination (bathymetry colours) by the hillshade luminance. This darkens slopes facing away from the light source while preserving the underlying colour palette.

### Contour Generation
To ensure efficient realtime contouring in the browser (needed for the dynamic water level), a cache layer was generated using generate_contour_source.py. This applies an anisotropic diffusion algorithm to reduce the noise of the image and delete small details such as trees, while preserving sharp contours on cliff edges. This script also generates the COG with appropriately scaled overviews to ensure quick rendering, it also reduces the native resolution far below the bathymetry to ensure the contours calculate in a timely manner.

Depth contours are generated dynamically at render time at 1m intervals when zoomed beyond level 14 using the d3-contour library's marching squares algorithm:

- **Two-tier resolution**:
  - Low-resolution (4× overview) for zooms < 16 — synchronous generation
  - High-resolution (2× overview) for zooms ≥ 16 — asynchronous viewport reads

- **Styling**:
  - Major contours (depth divisible by 5): 2px line width
  - Minor contours: 1px line width
  - Labels with text halo for readability

- **Boundary handling**: The deepest contour's boundary coordinates are identified and stripped from shallower contours to create clean line segments without edge artifacts.

- **Caching**: LRU cache (20 entries) keyed by tier, zoom, interval, water level, and bounds to avoid regenerating unchanged contours.

### Measure Tool with Contour Tracking

The measure tool includes a contour-following mode that allows measurements to trace depth contours:

**Contour Drag Interaction**:
1. Click and drag on an existing measurement line segment
2. The tool queries bathymetry elevation at the cursor position
3. A* pathfinding finds a route along the contour at that depth

**A* Pathfinding Algorithm**:
- **Snap-to-contour**: Before pathfinding, finds the nearest cells within elevation tolerance of the target depth. Smoothed with Chaikin smoothing to add additional points and ensure smooth contour following.
- **Cost function** combines:
  - Base movement cost (1.0 orthogonal, 1.414 diagonal)
  - Depth penalty: quadratic penalty for deviation from target elevation
  - Directness penalty: discourages wandering away from the goal direction
- **Grid resolution**: Operates at the native resolution of the contouring geotiff.

### Survey Line Display

Survey CSV files are parsed and rendered as colored line features:
- Each survey line has a distinct color for identification
- Click survey lines in the legend to zoom to that line
- Full survey metadata available on hover

## Technical Implementation

HTML/CSS/JavaScript web map using:

- **MapLibre GL JS 4.7.1**: WebGL map rendering
- **GeoTIFF.js 2.1.3**: COG parsing for bathymetry and hillshade
- **d3-contour 4.0.2**: Marching squares algorithm for contour extraction

### Custom WebGL Layers

The application uses custom MapLibre GL layers for raster rendering:

- **bathymetry-layer.js**: Reads COG elevation data, applies Turbo colormap, outputs RGBA textures with alpha blending
- **multiply-hillshade-layer.js**: Reads pre-computed hillshade COG, renders with multiply blend mode for terrain shading

Both layers implement viewport-based COG reads with:
- Overview pyramid selection (capped at 2048×2048 pixels)
- 50% viewport padding for smooth panning
- Token-based cancellation for stale requests
- Debounced update handlers (200-300ms)

### Module Architecture

- **main.js**: Configuration, state management, initialization
- **map.js**: Layer management, UI controls, legend
- **measure.js**: Measurement tool with A* contour pathfinding
- **contours.js**: Contour generation with LRU caching
- **utils.js**: Coordinate transforms, RDP simplification, Chaikin smoothing

## Sources

**Bathymetry**: 
[Survey AS20131211, Department of Transport](https://dot-wa.maps.arcgis.com/apps/webappviewer/index.html?id=d58dd77d85654783b5fc8c775953c69b)
[Survey AS20130627, Department of Transport](https://dot-wa.maps.arcgis.com/apps/webappviewer/index.html?id=d58dd77d85654783b5fc8c775953c69b)

**Survey Lines**: Dive survey data, January 2026

**Water Level**: [Water Corporation of Western Australia](https://www.watercorporation.com.au/water-supply/rainfall-and-dams/dam-levels)

**Basemap**: Esri World Imagery

**Libraries**:
- [MapLibre GL JS](https://maplibre.org/) (BSD-3-Clause)
- [GeoTIFF.js](https://geotiffjs.github.io/) (MIT)
- [d3-contour](https://github.com/d3/d3-contour) (ISC)

**Licence:** CC BY 4.0 — [Creative Commons Attribution](https://creativecommons.org/licenses/by/4.0/)
