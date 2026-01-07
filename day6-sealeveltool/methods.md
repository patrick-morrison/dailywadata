# Methods: Bathymetric Dataset Optimization

The original 2.6 GB Float32 GeoTIFF (31,999 × 20,799 pixels, range -8,640m to +3,989m) was optimized for sea level visualization by clipping to the +10m to -150m depth range and quantizing to 8-bit. Using `gdal_calc.py`, values were linearly scaled via `((depth + 150) × 255 / 160)` where depths ≥-150m and ≤+10m, with out-of-range values set to NoData (0). The resulting Byte GeoTIFF with DEFLATE compression and predictor 2 reduced file size by 99.5% to 14 MB while maintaining 63 cm vertical precision—adequate for the 250m spatial resolution. Decoding formula: `depth = (pixel × 160 / 255) - 150`.

## Command

```bash
gdal_calc.py -A AusBathyTopo__Australia__2024_250m_MSL_cog.tif \
  --outfile=bathytopo_10to150.tif \
  --calc="where((A >= -150) & (A <= 10), (A + 150) * 255 / 160, 0)" \
  --type=Byte \
  --NoDataValue=0 \
  --co COMPRESS=DEFLATE \
  --co TILED=YES \
  --co PREDICTOR=2
```

**Result**: 14 MB single-file GeoTIFF (99.5% reduction)

## Web Mercator Reprojection & Clipping

For correct alignment with web maps (which use EPSG:3857 Web Mercator projection), the WGS84 GeoTIFF was reprojected and clipped to the Australian extent:

```bash
# Reproject to Web Mercator
gdalwarp -t_srs EPSG:3857 -r bilinear -co COMPRESS=DEFLATE -co TILED=YES \
  bathytopo_8bit.tif bathytopo_mercator.tif

# Clip to Australia extent (in Mercator meters)
gdalwarp -te 12283687.6388 -5499471.2916 17703087.8382 -893448.1075 \
  -co COMPRESS=DEFLATE -co TILED=YES \
  bathytopo_mercator.tif bathytopo_aus.tif

# Add overview for faster loading
gdaladdo -r average bathytopo_aus.tif 8

# Create small preview file for instant loading
gdal_translate -outsize 10% 10% -r average -co COMPRESS=DEFLATE \
  bathytopo_aus.tif bathytopo_preview.tif
```

**Result**: 
- `bathytopo_aus.tif`: 13 MB (17,759 × 15,094 pixels) - main file
- `bathytopo_preview.tif`: 360 KB - instant preview
