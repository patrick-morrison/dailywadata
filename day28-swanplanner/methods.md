# Day 28 — Swan River Bathymetry

**Source:** DOT SC2010 Multibeam (2010). [Link](https://catalogue.data.wa.gov.au/dataset/bathymetry-catalogue)

**Processing:**
BAG file was hole-filled in QGIS and exported as a geotiff. This interpolated image was then optimized for web streaming by converting floating-point meters to 16-bit integers (scaled by 100), and sampled at 50% resolution. This conversion reduced the file size to 3.2 MB but requires adjustments back on the web app side.

**Command:**
```bash
gdal_translate SC20100413_Interpolated.tif SC20100413_optimized_int16.tif \
  -of COG \
  -ot Int16 \
  -scale -22 -1 -2200 -100 \
  -a_nodata -32768 \
  -co COMPRESS=DEFLATE \
  -co PREDICTOR=2
```
