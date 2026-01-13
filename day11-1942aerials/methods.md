# Day 11 — Fremantle-Pinjarra 1942 Aerial Photography

**Author:** Patrick Morrison

225 aerial photographs captured on 14-15 January 1942 over the Fremantle-Pinjarra region using a Williamson Eagle 4 camera across four film rolls (MAP1333, MAP1481, MAP1458, and MAP1873). Aligned in Agisoft Metashape, and with complete metadata and direct download links to source TIF files, preview JPGs, and thumbnail JPGs.

These photographs were taken during WWII military mapping operations, showing the landscape as it was over 80 years ago.

[Download data from Geoscience Australia](https://www.ga.gov.au/scientific-topics/national-location-information/historical-aerial-photography)


**Licence:** CC BY 4.0 — [Creative Commons Attribution](https://creativecommons.org/licenses/by/4.0/)

---

## Processing

**Orthomosaic:** Grayscale orthomosaic at 1m resolution (21330×29211 pixels, 28MB). Exported from Agisoft Metashape as uncompressed GeoTIFF, then converted to Cloud Optimized GeoTIFF in Web Mercator projection (EPSG:3857) with JPEG compression at quality 20. Reprojected using bilinear resampling with internal tiling (256×256 blocks) and multi-resolution overviews.

**DEM:** Digital Elevation Model at 5m resolution (4267×5842 pixels, 3.3MB). Generated in Agisoft Metashape from cleaned point cloud at **Medium Depth Maps quality**, meaning this can be substantially more detailed — the source point cloud supports resolution up to 25cm.

The terrain visualization combines color-coded elevation with hillshading using GDAL's multiply blend method (replicating QGIS multiply blend mode). Each RGB channel was processed separately using `gdal_calc.py` with the formula `(A.astype(float)*B.astype(float)/255.0)` where A is the elevation color and B is the hillshade value. The `.astype(float)` casting is critical to avoid integer division errors. Channels were then merged with `gdal_merge.py` using JPEG compression. Final output converted to Cloud Optimized GeoTIFF in Web Mercator projection (EPSG:3857) with internal tiling and multi-resolution overviews.

**Camera Positions:** 225 aligned camera positions with metadata exported from Agisoft Metashape's bundle adjustment. Includes original flight log positions, refined estimated positions, and alignment error metrics.

## Implementation

HTML/CSS/JS webmap using MapLibre GL. The @geomatico/maplibre-cog-protocol library reads Cloud Optimized GeoTIFFs directly. Camera positions shown as clickable markers with metadata, thumbnails, and download links.

## Sources

**Aerial Photography:** Geoscience Australia — [Historical Aerial Photography Collection](https://www.ga.gov.au/scientific-topics/national-location-information/historical-aerial-photography)

**Basemap:** Esri World Imagery

**Libraries:** [MapLibre GL JS](https://maplibre.org/) (BSD-3-Clause), [@geomatico/maplibre-cog-protocol](https://github.com/geomatico/maplibre-cog-protocol) (ISC)
