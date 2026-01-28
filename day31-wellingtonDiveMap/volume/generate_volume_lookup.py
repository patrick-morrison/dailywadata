#!/usr/bin/env python3
"""
Wellington Dam Volume-to-Level Lookup Table Generator

This script processes the Wellington Dam bathymetry GeoTIFF to generate a
volume-to-water-level lookup table for use in the web map application.

The lookup table allows conversion from Water Corporation's reported storage
volume (in gigalitres) to the corresponding water level (in metres AHD),
enabling accurate depth calculations for the dive map visualization.

Additionally, this script can cross-reference survey dive data (with depths
below water surface) against the bathymetry (with AHD elevations) to calculate
the water level at the time of the survey.

Wellington Dam Key Facts:
- Full Supply Level (FSL): ~165.5m AHD
- Total Capacity: ~185 GL
- Location: Collie River, Western Australia
- Coordinates: 33°23'S, 115°59'E

Usage:
    python generate_volume_lookup.py

Output:
    - Prints JavaScript-compatible lookup table to stdout
    - Creates volume_lookup.json with the data
    - Displays summary statistics
    - Cross-references survey data to estimate water level at survey time

Author: Aren Leishman
Date: January 2026
"""

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# Suppress GDAL warnings for cleaner output
import warnings
warnings.filterwarnings('ignore')

try:
    from osgeo import gdal, osr
    gdal.UseExceptions()
except ImportError:
    print("Error: GDAL/osgeo not installed. Install with: pip install gdal", file=sys.stderr)
    sys.exit(1)


# Configuration
SCRIPT_DIR = Path(__file__).parent
STANDARD_BATHY_PATH = SCRIPT_DIR / "WellingtonBathy_cog.tif"
HD_BATHY_PATH = SCRIPT_DIR / "WellingtonHdBathy_cog.tif"

# Survey data files (depths below water surface)
SURVEY_FILES = [
    SCRIPT_DIR / "north_adjusted.csv",
    SCRIPT_DIR / "south_adjusted.csv",
    SCRIPT_DIR / "northT1_adjusted.csv",
    SCRIPT_DIR / "northT2_adjusted.csv",
    SCRIPT_DIR / "southT1_adjusted.csv",
]

# Wellington Dam parameters
# Source: Water Corporation of Western Australia
FULL_SUPPLY_LEVEL_AHD = 165.5  # meters AHD
TOTAL_CAPACITY_GL = 185.0  # gigalitres
MIN_LEVEL_AHD = 126.0  # Approximate lowest point of dam bed

# Historical storage constraints for calibration
# Source: Water Corporation historical data
MIN_RECORDED_STORAGE_GL = 50.0  # Approximate minimum on record
MIN_STORAGE_DATE = "historical"

# Current storage (update as needed) - serves as calibration point
CURRENT_STORAGE_GL = 84.35  # As of January 2026
CURRENT_STORAGE_DATE = "2026-01-26"


def wgs84_to_web_mercator(lng: float, lat: float) -> tuple[float, float]:
    """
    Convert WGS84 (EPSG:4326) coordinates to Web Mercator (EPSG:3857).

    Args:
        lng: Longitude in degrees
        lat: Latitude in degrees

    Returns:
        Tuple of (x, y) in Web Mercator meters
    """
    x = lng * 20037508.34 / 180.0
    y = np.log(np.tan((90.0 + lat) * np.pi / 360.0)) / (np.pi / 180.0)
    y = y * 20037508.34 / 180.0
    return x, y


def load_bathymetry(filepath: Path) -> tuple[np.ndarray, dict]:
    """
    Load a bathymetry GeoTIFF and return the elevation data with metadata.

    Args:
        filepath: Path to the GeoTIFF file

    Returns:
        Tuple of (elevation_array, metadata_dict)
    """
    print(f"Loading: {filepath.name}")

    ds = gdal.Open(str(filepath))
    if ds is None:
        raise FileNotFoundError(f"Could not open {filepath}")

    band = ds.GetRasterBand(1)
    gt = ds.GetGeoTransform()

    # Read data as float64 to avoid overflow issues with Float16
    data = band.ReadAsArray().astype(np.float64)

    # Get nodata value
    nodata = band.GetNoDataValue()
    if nodata is None:
        nodata = 1e6  # Default for this dataset

    metadata = {
        'width': ds.RasterXSize,
        'height': ds.RasterYSize,
        'pixel_size_x': abs(gt[1]),
        'pixel_size_y': abs(gt[5]),
        'pixel_area_m2': abs(gt[1]) * abs(gt[5]),
        'origin_x': gt[0],
        'origin_y': gt[3],
        'nodata': nodata,
        'crs': ds.GetProjection()
    }

    ds = None  # Close dataset

    return data, metadata


def get_elevation_at_point(
    elevation_data: np.ndarray,
    metadata: dict,
    lng: float,
    lat: float
) -> float | None:
    """
    Get the bathymetry elevation at a specific WGS84 coordinate.

    Args:
        elevation_data: Array of bed elevations in meters AHD
        metadata: GeoTIFF metadata including origin and pixel size
        lng: Longitude in degrees (WGS84)
        lat: Latitude in degrees (WGS84)

    Returns:
        Elevation in meters AHD, or None if outside bounds or nodata
    """
    # Convert to Web Mercator
    x, y = wgs84_to_web_mercator(lng, lat)

    # Convert to pixel coordinates
    # GeoTransform: [origin_x, pixel_width, 0, origin_y, 0, -pixel_height]
    px = int((x - metadata['origin_x']) / metadata['pixel_size_x'])
    py = int((metadata['origin_y'] - y) / metadata['pixel_size_y'])

    # Check bounds
    if px < 0 or px >= metadata['width'] or py < 0 or py >= metadata['height']:
        return None

    # Get elevation value
    elev = elevation_data[py, px]

    # Check for nodata/invalid values
    if not np.isfinite(elev) or elev > 1e5 or elev < 100 or elev > 200:
        return None

    return float(elev)


def calculate_water_level_from_survey(
    elevation_data: np.ndarray,
    metadata: dict,
    survey_files: list[Path]
) -> dict:
    """
    Cross-reference survey dive depths with bathymetry elevations to
    calculate the water level at the time of the survey.

    Survey data has depth below water surface (negative values).
    Bathymetry has bed elevation in meters AHD.

    Relationship: water_level_AHD = bed_elevation_AHD - survey_depth
    (since survey_depth is negative, this is: water_level = bed_elev + |depth|)

    Args:
        elevation_data: Bathymetry array
        metadata: GeoTIFF metadata
        survey_files: List of paths to survey CSV files

    Returns:
        Dictionary with water level estimate and statistics
    """
    water_level_estimates = []
    matched_points = []

    for survey_file in survey_files:
        if not survey_file.exists():
            continue

        try:
            df = pd.read_csv(survey_file)

            # Need Y (lat), X (lng), and Elevation (depth below surface)
            if not all(col in df.columns for col in ['Y', 'X', 'Elevation']):
                continue

            for _, row in df.iterrows():
                lat = row['Y']
                lng = row['X']
                survey_depth = row['Elevation']  # Negative value (depth below surface)

                if pd.isna(lat) or pd.isna(lng) or pd.isna(survey_depth):
                    continue

                # Get bathymetry elevation at this point
                bed_elev = get_elevation_at_point(elevation_data, metadata, lng, lat)

                if bed_elev is None:
                    continue

                # Calculate water level: bed_elevation - survey_depth
                # survey_depth is negative, so this gives: bed_elev + |survey_depth|
                water_level = bed_elev - survey_depth

                # Sanity check: water level should be reasonable (140-170m AHD)
                if 140 <= water_level <= 170:
                    water_level_estimates.append(water_level)
                    matched_points.append({
                        'file': survey_file.name,
                        'lat': lat,
                        'lng': lng,
                        'survey_depth': survey_depth,
                        'bed_elev_ahd': bed_elev,
                        'water_level_ahd': water_level
                    })

        except Exception as e:
            print(f"  Warning: Error reading {survey_file.name}: {e}")

    if not water_level_estimates:
        return {
            'estimated_level': None,
            'matched_points': 0,
            'error': 'No matching points found'
        }

    estimates = np.array(water_level_estimates)

    return {
        'estimated_level': float(np.median(estimates)),
        'mean_level': float(np.mean(estimates)),
        'std_dev': float(np.std(estimates)),
        'min_level': float(np.min(estimates)),
        'max_level': float(np.max(estimates)),
        'matched_points': len(matched_points),
        'sample_matches': matched_points[:5] if len(matched_points) > 5 else matched_points
    }


def create_valid_mask(data: np.ndarray, nodata: float) -> np.ndarray:
    """
    Create a boolean mask for valid bathymetry pixels.

    Valid pixels are:
    - Finite (not inf or nan)
    - Not equal to nodata value
    - Within reasonable elevation range for Wellington Dam (100-200m AHD)

    Args:
        data: Elevation array
        nodata: NoData value from the GeoTIFF

    Returns:
        Boolean mask array (True = valid)
    """
    mask = (
        np.isfinite(data) &
        (data != nodata) &
        (data < 1e5) &  # Exclude overflow values
        (data > 100) &  # Below this is unreasonable for Wellington Dam
        (data < 200)    # Above this is unreasonable for Wellington Dam
    )
    return mask


def calculate_volume_at_level(
    elevation_data: np.ndarray,
    valid_mask: np.ndarray,
    water_level: float,
    pixel_area_m2: float
) -> float:
    """
    Calculate the water volume at a given water level.

    Volume is calculated as the sum of water depth over all submerged pixels,
    multiplied by the pixel area.

    Args:
        elevation_data: Array of bed elevations in meters AHD
        valid_mask: Boolean mask of valid pixels
        water_level: Water surface level in meters AHD
        pixel_area_m2: Area of each pixel in square meters

    Returns:
        Volume in gigalitres
    """
    # Find pixels that are underwater at this level
    underwater_mask = valid_mask & (elevation_data < water_level)

    if not np.any(underwater_mask):
        return 0.0

    # Calculate depth at each underwater pixel
    depths = water_level - elevation_data[underwater_mask]

    # Sum volumes: depth * area for each pixel, convert m³ to GL
    volume_m3 = np.sum(depths, dtype=np.float64) * pixel_area_m2
    volume_gl = volume_m3 / 1e9

    return volume_gl


def generate_volume_lookup_table(
    elevation_data: np.ndarray,
    metadata: dict,
    level_step: float = 0.5
) -> list[dict]:
    """
    Generate a complete volume-to-level lookup table.

    Args:
        elevation_data: Array of bed elevations
        metadata: GeoTIFF metadata including pixel area
        level_step: Step size in meters between levels (default 0.5m)

    Returns:
        List of {volumeGL, levelAHD} dictionaries
    """
    valid_mask = create_valid_mask(elevation_data, metadata['nodata'])
    valid_data = elevation_data[valid_mask]

    if len(valid_data) == 0:
        raise ValueError("No valid bathymetry data found!")

    # Determine elevation range
    min_elev = np.min(valid_data)
    max_elev = np.max(valid_data)

    print(f"\nBathymetry Statistics:")
    print(f"  Valid pixels: {np.sum(valid_mask):,} of {valid_mask.size:,} ({100*np.sum(valid_mask)/valid_mask.size:.1f}%)")
    print(f"  Elevation range: {min_elev:.2f}m to {max_elev:.2f}m AHD")
    print(f"  Pixel area: {metadata['pixel_area_m2']:.4f} m²")

    # Generate lookup table from minimum bed elevation to full supply level
    start_level = np.floor(min_elev)
    end_level = FULL_SUPPLY_LEVEL_AHD + 1

    levels = np.arange(start_level, end_level, level_step)
    lookup_table = []

    print(f"\nCalculating volumes for {len(levels)} water levels...")

    for i, level in enumerate(levels):
        volume = calculate_volume_at_level(
            elevation_data,
            valid_mask,
            level,
            metadata['pixel_area_m2']
        )

        lookup_table.append({
            'volumeGL': round(volume, 3),
            'levelAHD': round(level, 1)
        })

        # Progress indicator for key levels
        if level % 5 == 0:
            print(f"  Level {level:.0f}m AHD: {volume:.3f} GL")

    return lookup_table


def interpolate_level_from_volume(lookup_table: list[dict], volume_gl: float) -> float:
    """
    Interpolate the water level for a given storage volume.

    Args:
        lookup_table: List of {volumeGL, levelAHD} entries
        volume_gl: Volume to look up in gigalitres

    Returns:
        Interpolated water level in meters AHD
    """
    for i in range(1, len(lookup_table)):
        prev = lookup_table[i - 1]
        curr = lookup_table[i]

        if volume_gl <= curr['volumeGL']:
            # Linear interpolation
            if curr['volumeGL'] == prev['volumeGL']:
                return curr['levelAHD']

            ratio = (volume_gl - prev['volumeGL']) / (curr['volumeGL'] - prev['volumeGL'])
            return prev['levelAHD'] + ratio * (curr['levelAHD'] - prev['levelAHD'])

    # Volume exceeds table, return max level
    return lookup_table[-1]['levelAHD']


def create_calibrated_volume_model(
    partial_volumes: list[dict],
    calibration_volume_gl: float,
    calibration_level_ahd: float,
    full_supply_level: float = FULL_SUPPLY_LEVEL_AHD,
    full_supply_volume: float = TOTAL_CAPACITY_GL,
    min_storage_gl: float = MIN_RECORDED_STORAGE_GL
) -> list[dict]:
    """
    Create a calibrated volume-to-level lookup table using known reference points.

    The bathymetry only covers the deeper channel areas, but this is where most
    volume variation occurs. We can calibrate the partial volumes against known
    storage-level relationships:

    1. Calibration point: survey cross-reference gives us volume → level
    2. Full supply: 185 GL @ 165.5m AHD
    3. Minimum on record: ~50 GL

    The model uses the shape of the partial volume curve (which captures the
    deep channel geometry) and scales it to match the known total volumes.

    Args:
        partial_volumes: List of {volumeGL, levelAHD} from bathymetry calculation
        calibration_volume_gl: Known volume at calibration (e.g., 84.35 GL)
        calibration_level_ahd: Known level at calibration (from survey cross-ref)
        full_supply_level: Full supply level in meters AHD
        full_supply_volume: Full supply volume in GL
        min_storage_gl: Minimum recorded storage in GL

    Returns:
        Calibrated list of {volumeGL, levelAHD} entries
    """
    print(f"\n" + "=" * 60)
    print("Calibrated Volume Model")
    print("=" * 60)

    # Find the partial volume at calibration level
    partial_at_cal = None
    for i, entry in enumerate(partial_volumes):
        if entry['levelAHD'] >= calibration_level_ahd:
            # Interpolate if needed
            if i > 0:
                prev = partial_volumes[i - 1]
                t = (calibration_level_ahd - prev['levelAHD']) / (entry['levelAHD'] - prev['levelAHD'])
                partial_at_cal = prev['volumeGL'] + t * (entry['volumeGL'] - prev['volumeGL'])
            else:
                partial_at_cal = entry['volumeGL']
            break

    if partial_at_cal is None or partial_at_cal == 0:
        partial_at_cal = partial_volumes[-1]['volumeGL']

    print(f"Calibration point:")
    print(f"  Known: {calibration_volume_gl:.2f} GL @ {calibration_level_ahd:.2f}m AHD")
    print(f"  Partial volume from bathymetry: {partial_at_cal:.4f} GL")

    # Find partial volume at full supply
    partial_at_fsl = None
    for i, entry in enumerate(partial_volumes):
        if entry['levelAHD'] >= full_supply_level:
            if i > 0:
                prev = partial_volumes[i - 1]
                t = (full_supply_level - prev['levelAHD']) / (entry['levelAHD'] - prev['levelAHD'])
                partial_at_fsl = prev['volumeGL'] + t * (entry['volumeGL'] - prev['volumeGL'])
            else:
                partial_at_fsl = entry['volumeGL']
            break

    if partial_at_fsl is None:
        partial_at_fsl = partial_volumes[-1]['volumeGL']

    print(f"\nFull supply reference:")
    print(f"  Known: {full_supply_volume:.2f} GL @ {full_supply_level:.2f}m AHD")
    print(f"  Partial volume from bathymetry: {partial_at_fsl:.4f} GL")

    # The partial volumes give us the shape of the volume curve for the deep channel
    # We'll use a two-point calibration to scale:
    # - At calibration level: partial_at_cal -> calibration_volume_gl
    # - At full supply: partial_at_fsl -> full_supply_volume

    # Calculate scale factors for the linear transformation
    # actual_volume = a * partial_volume + b
    # Using two points to solve for a and b:
    if partial_at_fsl != partial_at_cal:
        a = (full_supply_volume - calibration_volume_gl) / (partial_at_fsl - partial_at_cal)
        b = calibration_volume_gl - a * partial_at_cal
    else:
        # Fallback: simple scaling
        a = calibration_volume_gl / partial_at_cal if partial_at_cal > 0 else 1000
        b = 0

    print(f"\nLinear calibration: V_actual = {a:.2f} * V_partial + {b:.2f}")

    # Apply calibration to create the lookup table
    calibrated_table = []
    min_level_for_volume = None

    for entry in partial_volumes:
        partial_v = entry['volumeGL']
        actual_v = a * partial_v + b

        # Don't allow negative volumes
        if actual_v < 0:
            actual_v = 0

        # Track when we reach minimum storage
        if actual_v >= min_storage_gl and min_level_for_volume is None:
            min_level_for_volume = entry['levelAHD']

        calibrated_table.append({
            'volumeGL': round(actual_v, 2),
            'levelAHD': entry['levelAHD']
        })

    print(f"\nCalibrated volume range:")
    print(f"  Minimum level in data: {calibrated_table[0]['levelAHD']:.1f}m AHD -> {calibrated_table[0]['volumeGL']:.2f} GL")

    if min_level_for_volume:
        print(f"  Level at {min_storage_gl} GL: ~{min_level_for_volume:.1f}m AHD")

    # Verify calibration
    cal_check = None
    fsl_check = None
    for entry in calibrated_table:
        if abs(entry['levelAHD'] - calibration_level_ahd) < 0.5:
            cal_check = entry['volumeGL']
        if abs(entry['levelAHD'] - full_supply_level) < 0.5:
            fsl_check = entry['volumeGL']

    print(f"\nVerification:")
    if cal_check:
        print(f"  At calibration level ({calibration_level_ahd:.1f}m): {cal_check:.2f} GL (target: {calibration_volume_gl} GL)")
    if fsl_check:
        print(f"  At full supply ({full_supply_level}m): {fsl_check:.2f} GL (target: {full_supply_volume} GL)")

    return calibrated_table


def level_from_calibrated_volume(calibrated_table: list[dict], volume_gl: float) -> float:
    """
    Get the water level for a given storage volume using the calibrated table.

    Args:
        calibrated_table: Calibrated {volumeGL, levelAHD} entries
        volume_gl: Volume to look up

    Returns:
        Water level in meters AHD
    """
    # Handle edge cases
    if volume_gl <= calibrated_table[0]['volumeGL']:
        return calibrated_table[0]['levelAHD']
    if volume_gl >= calibrated_table[-1]['volumeGL']:
        return calibrated_table[-1]['levelAHD']

    # Binary search for efficiency
    for i in range(1, len(calibrated_table)):
        if calibrated_table[i]['volumeGL'] >= volume_gl:
            prev = calibrated_table[i - 1]
            curr = calibrated_table[i]

            if curr['volumeGL'] == prev['volumeGL']:
                return curr['levelAHD']

            # Linear interpolation
            t = (volume_gl - prev['volumeGL']) / (curr['volumeGL'] - prev['volumeGL'])
            return prev['levelAHD'] + t * (curr['levelAHD'] - prev['levelAHD'])

    return calibrated_table[-1]['levelAHD']


def format_javascript_output(lookup_table: list[dict], sparse: bool = True) -> str:
    """
    Format the lookup table as JavaScript code.

    Args:
        lookup_table: Full lookup table
        sparse: If True, output only key points for interpolation

    Returns:
        JavaScript code string
    """
    if sparse:
        # Extract key points at 5m intervals plus endpoints
        sparse_table = []
        for entry in lookup_table:
            if entry['levelAHD'] % 5 == 0 or entry == lookup_table[0] or entry == lookup_table[-1]:
                sparse_table.append(entry)
        table_to_output = sparse_table
    else:
        table_to_output = lookup_table

    lines = [
        "// Volume-to-Level Lookup Table for Wellington Dam",
        "// Generated from bathymetry GeoTIFF by generate_volume_lookup.py",
        f"// Source: WellingtonBathy_cog.tif, processed {CURRENT_STORAGE_DATE}",
        "// Usage: Linear interpolation between points",
        "const VOLUME_TO_LEVEL = ["
    ]

    for entry in table_to_output:
        lines.append(f"    {{ volumeGL: {entry['volumeGL']:.3f}, levelAHD: {entry['levelAHD']:.1f} }},")

    lines.append("];")

    return "\n".join(lines)


def main():
    """Main execution function."""
    print("=" * 60)
    print("Wellington Dam Volume-to-Level Lookup Table Generator")
    print("=" * 60)

    # Check file exists
    if not STANDARD_BATHY_PATH.exists():
        print(f"Error: Bathymetry file not found: {STANDARD_BATHY_PATH}", file=sys.stderr)
        sys.exit(1)

    # Load bathymetry
    elevation_data, metadata = load_bathymetry(STANDARD_BATHY_PATH)

    # Generate partial volume lookup table from bathymetry
    partial_volumes = generate_volume_lookup_table(elevation_data, metadata)

    # Cross-reference survey data to estimate water level at survey time
    print(f"\n" + "=" * 60)
    print("Survey Cross-Reference Analysis")
    print("=" * 60)
    print("Comparing survey depths with bathymetry elevations...")

    survey_result = calculate_water_level_from_survey(
        elevation_data, metadata, SURVEY_FILES
    )

    if survey_result['estimated_level']:
        survey_water_level = survey_result['estimated_level']
        print(f"\nSurvey Water Level Estimate:")
        print(f"  Matched points: {survey_result['matched_points']}")
        print(f"  Median water level: {survey_water_level:.2f}m AHD")
        print(f"  Mean water level: {survey_result['mean_level']:.2f}m AHD")
        print(f"  Std deviation: {survey_result['std_dev']:.2f}m")
        print(f"  Range: {survey_result['min_level']:.2f}m to {survey_result['max_level']:.2f}m AHD")

        if survey_result.get('sample_matches'):
            print(f"\n  Sample matches:")
            for match in survey_result['sample_matches'][:3]:
                print(f"    - {match['file']}: depth={match['survey_depth']:.1f}m, "
                      f"bed={match['bed_elev_ahd']:.1f}m AHD -> water={match['water_level_ahd']:.1f}m AHD")
    else:
        survey_water_level = None
        print(f"  {survey_result.get('error', 'Unknown error')}")

    # Create calibrated volume model using the survey cross-reference
    min_bed_elev = partial_volumes[0]['levelAHD']

    if survey_water_level and 145 <= survey_water_level <= 165:
        calibration_level = survey_water_level
        calibration_volume = CURRENT_STORAGE_GL

        # Create calibrated lookup table
        calibrated_table = create_calibrated_volume_model(
            partial_volumes,
            calibration_volume_gl=calibration_volume,
            calibration_level_ahd=calibration_level,
            full_supply_level=FULL_SUPPLY_LEVEL_AHD,
            full_supply_volume=TOTAL_CAPACITY_GL,
            min_storage_gl=MIN_RECORDED_STORAGE_GL
        )

        # Use the calibrated model to get the current water level
        best_water_level = level_from_calibrated_volume(calibrated_table, CURRENT_STORAGE_GL)
        level_source = "calibrated model (survey cross-reference + known capacity)"

        # Test the model with different volumes
        print(f"\n" + "=" * 60)
        print("Volume-to-Level Lookup Examples")
        print("=" * 60)
        test_volumes = [50, 60, 70, 80, 84.35, 90, 100, 120, 150, 185]
        for vol in test_volumes:
            level = level_from_calibrated_volume(calibrated_table, vol)
            depth = level - min_bed_elev
            marker = " <-- current" if vol == 84.35 else ""
            print(f"  {vol:6.1f} GL -> {level:.2f}m AHD (max depth: {depth:.1f}m){marker}")

    else:
        # Fallback without calibration
        best_water_level = 155.0
        level_source = "default estimate (no survey calibration)"
        calibrated_table = partial_volumes

    max_depth = best_water_level - min_bed_elev

    print(f"\n" + "=" * 60)
    print("Results")
    print("=" * 60)
    print(f"Current storage: {CURRENT_STORAGE_GL} GL ({CURRENT_STORAGE_DATE})")
    print(f"Water level estimate: {best_water_level:.2f}m AHD")
    print(f"  Source: {level_source}")
    print(f"Minimum bed elevation: {min_bed_elev:.1f}m AHD")
    print(f"Maximum depth at current level: {max_depth:.1f}m")

    # Output JavaScript volume-to-level function
    print(f"\n" + "=" * 60)
    print("JavaScript Volume-to-Level Lookup Table")
    print("=" * 60)

    # Create a sparse table for JS (every 5 GL or at key points)
    js_table = []
    prev_vol = -999
    for entry in calibrated_table:
        vol = entry['volumeGL']
        # Include entries at 5 GL intervals, or near key volumes
        if vol >= 0 and (
            int(vol / 5) * 5 != int(prev_vol / 5) * 5 or  # Every 5 GL
            abs(vol - MIN_RECORDED_STORAGE_GL) < 3 or      # Near minimum
            abs(vol - CURRENT_STORAGE_GL) < 3 or           # Near current
            abs(vol - TOTAL_CAPACITY_GL) < 3               # Near max
        ):
            js_table.append(entry)
            prev_vol = vol

    print("const VOLUME_TO_LEVEL = [")
    for entry in js_table:
        print(f"    {{ volumeGL: {entry['volumeGL']:.1f}, levelAHD: {entry['levelAHD']:.1f} }},")
    print("];")

    print(f"""
// Current water level for {CURRENT_STORAGE_DATE}
const CONFIG = {{
    WATER_LEVEL_AHD: {best_water_level:.2f},
    WATER_LEVEL_DATE: '{CURRENT_STORAGE_DATE}',
    CURRENT_STORAGE_GL: {CURRENT_STORAGE_GL},
    MIN_ELEVATION_AHD: {min_bed_elev:.1f},
    DEPTH_RANGE: [0, {max_depth:.0f}],
}};
""")

    # Save full results to JSON
    output_path = SCRIPT_DIR / "volume_lookup.json"
    output_data = {
        'metadata': {
            'source': 'WellingtonBathy_cog.tif',
            'generated': CURRENT_STORAGE_DATE,
            'full_supply_level_ahd': FULL_SUPPLY_LEVEL_AHD,
            'total_capacity_gl': TOTAL_CAPACITY_GL,
            'min_recorded_storage_gl': MIN_RECORDED_STORAGE_GL,
            'pixel_area_m2': metadata['pixel_area_m2'],
            'valid_pixel_count': int(np.sum(create_valid_mask(elevation_data, metadata['nodata']))),
            'min_bed_elevation': min_bed_elev
        },
        'survey_analysis': {
            'matched_points': survey_result['matched_points'],
            'estimated_level_ahd': survey_result.get('estimated_level'),
            'mean_level_ahd': survey_result.get('mean_level'),
            'std_dev': survey_result.get('std_dev'),
        } if survey_result.get('estimated_level') else None,
        'calibration': {
            'calibration_volume_gl': CURRENT_STORAGE_GL,
            'calibration_level_ahd': survey_water_level if survey_water_level else None,
            'method': 'linear scaling with two-point calibration (survey + FSL)'
        } if survey_water_level else None,
        'current_estimate': {
            'volume_gl': CURRENT_STORAGE_GL,
            'date': CURRENT_STORAGE_DATE,
            'water_level_ahd': round(best_water_level, 2),
            'level_source': level_source,
            'max_depth_m': round(max_depth, 1)
        },
        'calibrated_lookup_table': calibrated_table,
        'partial_volumes': partial_volumes  # Raw bathymetry-only volumes for reference
    }

    with open(output_path, 'w') as f:
        json.dump(output_data, f, indent=2)

    print(f"Full results saved to: {output_path}")

    # Summary
    print(f"\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    print(f"Water level at {CURRENT_STORAGE_GL} GL: {best_water_level:.2f}m AHD")
    print(f"Maximum depth: {max_depth:.1f}m")
    print(f"Level at {MIN_RECORDED_STORAGE_GL} GL (min on record): {level_from_calibrated_volume(calibrated_table, MIN_RECORDED_STORAGE_GL):.2f}m AHD")
    print(f"Level at {TOTAL_CAPACITY_GL} GL (full supply): {level_from_calibrated_volume(calibrated_table, TOTAL_CAPACITY_GL):.2f}m AHD")


if __name__ == "__main__":
    main()
