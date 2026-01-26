# Day 24 — Abrolhos Dive Trail

**Author:** Aren Leishman

The Houtman Abrolhos Islands are a popular spot for SCUBA diving, and as such there are designated dive trails with marked locations. This map showcases each of these routes while also laying over DOT bathymetry data of the area so that the depths of each of the routes can be observed. This is aided by a planning tool that measures distance traveled and the depth at each point along the route, line segments for the dive trails can be clicked directly to add them to the plan.

[Download dive trail markers from DataWA](https://catalogue.data.wa.gov.au/dataset/abrolhos-islands-dive-trail-markers)

[Download DOT Bathymetry data (Survey AB2016_mean_lidar) from the WA Bathymetry Portal](https://dot-wa.maps.arcgis.com/apps/webappviewer/index.html?id=d58dd77d85654783b5fc8c775953c69b)

**Licence:** CC BY 4.0 — [Creative Commons Attribution](https://creativecommons.org/licenses/by/4.0/)

---

## Processing

**Trail Markers**: The trail marker information was utilised as is from DataWA in a GeoJSON format.

**Bathymetry**: The survey .bag file was downloaded from the WA Bathymetry Portal. However as this file is 1.4 gigabytes some processing was required in order to ensure that it could be served effectively on the web. To achieve this the file was converted into a COG, and also changed to the EPSG:3857 CRS for web compatibility. To achieve filesize objectives a number of steps were taken:
- Band 2 (uncertainty) was discarded as it is not used in the end application
- DEFLATE compression was applied, with a floating point predictor (level 3)
- The dataset was precision reduced from 32 bit floating points to half precision 16 bit floating points.

The command to achieve this is in a single gdal call is: `gdalwarp -t_srs EPSG:3857 AB2016_mean_lidar.bag AbrolhosBathy_cog.tif -of COG -b 1 -co COMPRESS=DEFLATE -co NBITS=16 -co PREDICTOR=3`

This results in a COG which is ~67MiB in size.

The contours and hillshade are generated at render time in the browser by D3 Contours and Maplibre respectively.

## Implementation

HTML/CSS/JS webmap using MapLibre GL. The @geomatico/maplibre-cog-protocol library reads the Cloud Optimized GeoTIFF directly. D3 Contours was used to generate contours based on the zoomed-in area, as pregenerating the contour resulted in an over 100MiB geojson, which is too large to serve effectively.

## Sources

**Trail Markers**: [Department of Primary Industries and Regional Development](https://catalogue.data.wa.gov.au/dataset/abrolhos-islands-dive-trail-markers)

**Bathymetry**: [Survey AB2016_mean_lidar, Department of Transport](https://dot-wa.maps.arcgis.com/apps/webappviewer/index.html?id=d58dd77d85654783b5fc8c775953c69b)

**Basemap:** Esri World Imagery

**Libraries:** [MapLibre GL JS](https://maplibre.org/) (BSD-3-Clause), [@geomatico/maplibre-cog-protocol](https://github.com/geomatico/maplibre-cog-protocol) (ISC), [@d3/d3-contour](https://github.com/d3/d3-contour) (ISC)

