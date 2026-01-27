"""
Generate a pre-processed contour source raster from the merged bathymetry COG.

Uses Perona-Malik anisotropic diffusion to smooth noise (trees, debris) while
preserving sharp depth edges (dam walls, cliffs). Output is a small COG suitable
for fast in-browser contour generation.

Usage:
    python generate_contour_source.py
"""

import numpy as np
from osgeo import gdal, gdalconst

gdal.UseExceptions()

# ── Configuration ──────────────────────────────────────────────────────────────
INPUT_COG = "merged_bathy_cog.tif"
OUTPUT_COG = "contour_source.tif"
SHORT_AXIS = 1024          # Target short axis in pixels
NODATA_IN = 1_000_000.0    # Source NoData value
NODATA_OUT = -9999.0        # Output NoData value

# Anisotropic diffusion parameters
AD_NITER = 30    # Number of iterations (more = smoother)
AD_KAPPA = 1.0   # Edge threshold in metres — gradients above this are preserved
AD_GAMMA = 0.15  # Step size (must be <= 0.25 for stability)


# ── Anisotropic Diffusion ─────────────────────────────────────────────────────
def anisotropic_diffusion(data, niter=30, kappa=3.0, gamma=0.15):
    """
    Perona-Malik anisotropic diffusion (Lorentzian / option 2).

    Smooths flat/gradual areas aggressively while preserving edges where the
    depth gradient exceeds `kappa` metres per pixel.

    Parameters
    ----------
    data : np.ndarray (float64)
        Elevation grid. NaN values are treated as boundaries (no diffusion across).
    niter : int
        Number of diffusion iterations.
    kappa : float
        Edge threshold in data units (metres). Gradients larger than this
        are treated as edges and preserved.
    gamma : float
        Integration constant / step size. Must be <= 0.25 for stability.
    """
    mask = np.isnan(data)
    img = data.copy()
    # Fill NaN temporarily so gradient computation doesn't propagate NaN
    fill = np.nanmedian(data)
    img[mask] = fill

    for i in range(niter):
        # Gradients in 4 cardinal directions
        dN = np.zeros_like(img)
        dS = np.zeros_like(img)
        dE = np.zeros_like(img)
        dW = np.zeros_like(img)

        dN[1:, :]  = img[:-1, :] - img[1:, :]
        dS[:-1, :] = img[1:, :]  - img[:-1, :]
        dE[:, :-1] = img[:, 1:]  - img[:, :-1]
        dW[:, 1:]  = img[:, :-1] - img[:, 1:]

        # Lorentzian conduction coefficients — preserves wide slopes better
        cN = 1.0 / (1.0 + (dN / kappa) ** 2)
        cS = 1.0 / (1.0 + (dS / kappa) ** 2)
        cE = 1.0 / (1.0 + (dE / kappa) ** 2)
        cW = 1.0 / (1.0 + (dW / kappa) ** 2)

        # Zero out diffusion across NaN boundaries
        cN[mask] = 0; cS[mask] = 0; cE[mask] = 0; cW[mask] = 0
        # Also zero the neighbour side of NaN boundaries
        cS[1:, :][mask[:-1, :]]  = 0
        cN[:-1, :][mask[1:, :]]  = 0
        cE[:, 1:][mask[:, :-1]]  = 0
        cW[:, :-1][mask[:, 1:]]  = 0

        img += gamma * (cN * dN + cS * dS + cE * dE + cW * dW)

        # Re-enforce NaN mask
        img[mask] = fill

        if (i + 1) % 10 == 0:
            print(f"  Diffusion iteration {i + 1}/{niter}")

    img[mask] = np.nan
    return img


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print(f"Opening {INPUT_COG}...")
    src_ds = gdal.Open(INPUT_COG)
    src_band = src_ds.GetRasterBand(1)
    src_w = src_ds.RasterXSize
    src_h = src_ds.RasterYSize
    print(f"  Source size: {src_w}×{src_h}")

    # Compute output dimensions (short axis = SHORT_AXIS)
    scale = SHORT_AXIS / min(src_w, src_h)
    out_w = int(round(src_w * scale))
    out_h = int(round(src_h * scale))
    print(f"  Output size: {out_w}×{out_h} (scale factor: {scale:.4f})")

    # Read and downsample using GDAL (bilinear)
    print("Reading and downsampling...")
    data = src_band.ReadAsArray(
        buf_xsize=out_w, buf_ysize=out_h,
        resample_alg=gdalconst.GRIORA_Bilinear
    ).astype(np.float64)

    # Mark NoData as NaN
    data[data >= NODATA_IN * 0.9] = np.nan
    data[~np.isfinite(data)] = np.nan
    valid_count = np.count_nonzero(~np.isnan(data))
    print(f"  Valid pixels: {valid_count} / {data.size} ({100*valid_count/data.size:.1f}%)")
    print(f"  Depth range: {np.nanmin(data):.2f} – {np.nanmax(data):.2f} m AHD")

    # Anisotropic diffusion
    print(f"Applying anisotropic diffusion (niter={AD_NITER}, kappa={AD_KAPPA}, gamma={AD_GAMMA})...")
    smoothed = anisotropic_diffusion(data, niter=AD_NITER, kappa=AD_KAPPA, gamma=AD_GAMMA)

    # Convert back to float32, restore NoData
    result = smoothed.astype(np.float32)
    result[np.isnan(result)] = NODATA_OUT

    # Write output COG
    print(f"Writing {OUTPUT_COG}...")
    gt = list(src_ds.GetGeoTransform())
    gt[1] = gt[1] / scale   # Adjust pixel width
    gt[5] = gt[5] / scale   # Adjust pixel height

    driver = gdal.GetDriverByName("GTiff")
    out_ds = driver.Create(
        OUTPUT_COG, out_w, out_h, 1, gdalconst.GDT_Float32,
        options=[
            "COMPRESS=DEFLATE",
            "TILED=YES",
            "BLOCKXSIZE=256",
            "BLOCKYSIZE=256",
        ]
    )
    out_ds.SetGeoTransform(gt)
    out_ds.SetProjection(src_ds.GetProjection())

    out_band = out_ds.GetRasterBand(1)
    out_band.SetNoDataValue(NODATA_OUT)
    out_band.WriteArray(result)

    out_ds.FlushCache()
    out_ds = None
    src_ds = None

    # Build overview pyramids (factors 2 and 4)
    # Factor 4 → ~512×1191 (used for zoom 14-15 cached grid)
    # Factor 2 → ~1024×2382 (intermediate)
    print("Building overview pyramids (factors 2, 4)...")
    ds = gdal.Open(OUTPUT_COG, gdalconst.GA_Update)
    ds.BuildOverviews("AVERAGE", [2, 4])
    ds.FlushCache()
    ds = None
    print("  Overviews built successfully")

    # Report output size
    import os
    size_kb = os.path.getsize(OUTPUT_COG) / 1024
    print(f"Done! Output: {out_w}×{out_h}, {size_kb:.0f} KB")


if __name__ == "__main__":
    main()
