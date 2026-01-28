/**
 * contours.js — Contour generation from elevation grids
 *
 * Self-contained contour logic for generating depth contours from
 * GeoTIFF elevation data. Handles low-res synchronous generation
 * and high-res async viewport reads. All functions receive state
 * and map as explicit parameters.
 */

import {
    debounce,
    getActiveWaterLevel,
    lngLatToWebMercator,
    webMercatorToLngLat
} from './utils.js';

// ============================================
// Contour Layer Setup
// ============================================

/**
 * Set up contour source/layers on the map (synchronous, fast).
 * Must be called after survey lines are added so we can insert before them.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 * @param {Object} config - Application config
 * @param {Function} generateContoursForViewportFn - Bound contour generation function
 *
 * @reads state.layerVisibility.contours — initial layer visibility
 */
export function setupContourLayers(map, state, config, generateContoursForViewportFn) {
    map.addSource('contours-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });

    map.addLayer({
        id: 'contours-layer',
        type: 'line',
        source: 'contours-source',
        paint: {
            'line-color': config.CONTOUR_COLOR,
            'line-width': [
                'case',
                ['==', ['%', ['get', 'depth'], 5], 0],
                2,
                1
            ],
            'line-opacity': 0.6
        },
        layout: {
            visibility: state.layerVisibility.contours ? 'visible' : 'none'
        },
        minzoom: Math.min(...Object.keys(config.CONTOUR_INTERVALS).map(Number))
    }, 'survey-lines-layer');

    map.addLayer({
        id: 'contours-labels',
        type: 'symbol',
        source: 'contours-source',
        paint: {
            'text-color': config.CONTOUR_COLOR,
            'text-halo-color': '#ffffff',
            'text-halo-width': 2,
            'text-opacity': 0.9
        },
        layout: {
            'text-field': ['concat', ['get', 'depth'], 'm'],
            'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
            'text-size': 11,
            'symbol-placement': 'line-center',
            'text-rotation-alignment': 'map',
            'text-pitch-alignment': 'viewport',
            'text-max-angle': 45,
            'text-padding': 1,
            'symbol-sort-key': ['case',
                ['==', ['%', ['get', 'depth'], 5], 0], 0,
                1
            ],
            visibility: state.layerVisibility.contours ? 'visible' : 'none'
        },
        minzoom: Math.min(...Object.keys(config.CONTOUR_INTERVALS).map(Number))
    }, 'survey-lines-layer');

    map.on('moveend', debounce(generateContoursForViewportFn, 300));
}

// ============================================
// Contour Source Initialization
// ============================================

/**
 * Load the pre-processed contour source (small, pre-smoothed) and read the
 * entire grid into memory once. Designed to run in the background — does NOT
 * block loading overlay.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 * @param {Object} config - Application config
 * @param {Function} generateContoursForViewportFn - Bound contour generation function
 *
 * @mutates state.contourTiff — stores GeoTIFF object reference
 * @mutates state.contourNoData — stores NoData value
 * @mutates state.contourBbox — stores full extent bbox
 * @mutates state.contourLowRes — stores { grid, width, height, bbox }
 */
export async function initializeContourGeneration(map, state, config, generateContoursForViewportFn, pool) {
    try {
        console.time('\u23F1\uFE0F contour: load contour source');
        const tiff = await GeoTIFF.fromUrl(config.CONTOUR_COG, {
            allowFullFile: false,
            cacheSize: 100
        });

        state.contourTiff = tiff;
        state.geoTiffPool = pool || null;

        const image = await tiff.getImage();
        const nativeWidth = image.getWidth();
        const nativeHeight = image.getHeight();
        const bbox = image.getBoundingBox();
        const noData = image.getFileDirectory().GDAL_NODATA;
        const noDataValue = noData !== undefined ? parseFloat(noData) : -9999;

        state.contourNoData = noDataValue;
        state.contourBbox = bbox;
        state.contourNativeWidth = nativeWidth;
        state.contourNativeHeight = nativeHeight;
        // Native pixel size in CRS units (EPSG:3857 meters)
        state.contourPixelSizeX = (bbox[2] - bbox[0]) / nativeWidth;
        state.contourPixelSizeY = (bbox[3] - bbox[1]) / nativeHeight;

        // Use 8x overview for display grid (~512px short side, equivalent to
        // old native quality but derived from higher-res smoothed source)
        const lowWidth = Math.round(nativeWidth / 4);
        const lowHeight = Math.round(nativeHeight / 4);
        const rasters = await tiff.readRasters({ width: lowWidth, height: lowHeight, pool });
        const rawGrid = rasters[0];

        const grid = new Float32Array(rawGrid.length);
        for (let i = 0; i < rawGrid.length; i++) {
            const val = rawGrid[i];
            if (val === noDataValue || val >= 1e5 || !Number.isFinite(val)) {
                grid[i] = Number.NaN;
            } else {
                grid[i] = val;
            }
        }

        state.contourLowRes = { grid, width: lowWidth, height: lowHeight, bbox };
        console.timeEnd('\u23F1\uFE0F contour: load contour source');
        console.log(`Contour source loaded: native ${nativeWidth}\u00D7${nativeHeight}, low-res ${lowWidth}\u00D7${lowHeight}, ${(rawGrid.length * 4 / 1024).toFixed(0)}KB`);

        if (map.getZoom() >= Math.min(...Object.keys(config.CONTOUR_INTERVALS).map(Number))) {
            console.time('\u23F1\uFE0F contour: generateContoursForViewport (initial)');
            generateContoursForViewportFn();
            console.timeEnd('\u23F1\uFE0F contour: generateContoursForViewport (initial)');
        }

    } catch (error) {
        console.error('Failed to initialize contour generation:', error);
    }
}

// ============================================
// Contour GeoJSON Generation
// ============================================

/**
 * Generate contour GeoJSON from a grid + bbox.
 *
 * d3.contours produces closed polygon rings. When an isoline hits the NoData
 * boundary it gets "closed" by tracing along the boundary edge. We identify
 * boundary segments by collecting coordinates from the deepest threshold's
 * rings, then stripping those coordinates from other depths.
 *
 * @param {Float32Array} grid - Elevation values (AHD), row-major
 * @param {number} width - Grid width in pixels
 * @param {number} height - Grid height in pixels
 * @param {number[]} bbox - [minX, minY, maxX, maxY] in EPSG:3857
 * @param {number} waterLevel - Current water level in meters AHD
 * @param {number} interval - Contour interval in meters
 * @param {Object} config - Application config
 * @returns {{ type: string, features: Array }} GeoJSON FeatureCollection
 */
export function generateContourGeoJSON(grid, width, height, bbox, waterLevel, interval, config) {
    const maxContourDepth = Math.round(waterLevel - config.MIN_ELEVATION_AHD);
    const thresholds = [];
    for (let depth = interval; depth <= maxContourDepth; depth += interval) {
        const ahdLevel = waterLevel - depth;
        if (ahdLevel >= config.MIN_ELEVATION_AHD) {
            thresholds.push(ahdLevel);
        }
    }

    const contourGenerator = d3.contours()
        .size([width, height])
        .thresholds(thresholds)
        .smooth(true);

    const contourMultiPolygons = contourGenerator(grid);

    // Pass 1: find the deepest threshold and collect its boundary coords
    let deepestAHD = Infinity;
    for (const mp of contourMultiPolygons) {
        if (mp.coordinates.length > 0 && mp.value < deepestAHD) {
            deepestAHD = mp.value;
        }
    }
    const deepestDepth = Math.round(waterLevel - deepestAHD);

    const boundaryCoords = new Set();
    for (const mp of contourMultiPolygons) {
        if (mp.value !== deepestAHD) continue;
        for (const polygon of mp.coordinates) {
            for (const ring of polygon) {
                for (const [x, y] of ring) {
                    boundaryCoords.add(`${(x * 100) | 0},${(y * 100) | 0}`);
                }
            }
        }
    }

    // Pass 2: build features, stripping boundary coordinates
    const pixelToGeo = (x, y) => {
        const mercatorX = bbox[0] + (x / width) * (bbox[2] - bbox[0]);
        const mercatorY = bbox[3] - (y / height) * (bbox[3] - bbox[1]);
        return webMercatorToLngLat(mercatorX, mercatorY);
    };

    const features = [];

    for (const multiPolygon of contourMultiPolygons) {
        if (multiPolygon.coordinates.length === 0) continue;

        const ahdLevel = multiPolygon.value;
        const depth = Math.round(waterLevel - ahdLevel);
        if (depth <= 0) continue;
        if (depth === deepestDepth) continue;

        for (const polygon of multiPolygon.coordinates) {
            for (const ring of polygon) {
                if (ring.length < 10) continue;

                let currentSegment = [];
                for (const [x, y] of ring) {
                    const key = `${(x * 100) | 0},${(y * 100) | 0}`;
                    if (boundaryCoords.has(key)) {
                        if (currentSegment.length >= 5) {
                            features.push({
                                type: 'Feature',
                                properties: { depth, ahdLevel, interval },
                                geometry: {
                                    type: 'LineString',
                                    coordinates: currentSegment.map(
                                        ([px, py]) => pixelToGeo(px, py)
                                    )
                                }
                            });
                        }
                        currentSegment = [];
                    } else {
                        currentSegment.push([x, y]);
                    }
                }
                if (currentSegment.length >= 5) {
                    features.push({
                        type: 'Feature',
                        properties: { depth, ahdLevel, interval },
                        geometry: {
                            type: 'LineString',
                            coordinates: currentSegment.map(
                                ([px, py]) => pixelToGeo(px, py)
                            )
                        }
                    });
                }
            }
        }
    }

    return { type: 'FeatureCollection', features };
}

// ============================================
// Viewport Contour Generation
// ============================================

/**
 * Generate contours for the current map viewport. Uses low-res cached grid
 * for zoom < 16, and async high-res viewport read for zoom >= 16.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 * @param {Object} config - Application config
 *
 * @reads state.contourLowRes — cached low-res grid
 * @reads state.layerVisibility.contours — whether contours are enabled
 * @reads state.contoursCache — contour cache (Map)
 * @mutates state.lastContourGeoJSON — last generated GeoJSON
 * @mutates state.contoursCache — adds new cache entries
 */
export function generateContoursForViewport(map, state, config) {
    if (!state.contourLowRes) return;
    if (!state.layerVisibility.contours) return;

    const zoom = Math.floor(map.getZoom());
    const minContourZoom = Math.min(...Object.keys(config.CONTOUR_INTERVALS).map(Number));
    if (zoom < minContourZoom) return;

    const bounds = map.getBounds();

    let interval = 10;
    for (const [zoomThreshold, int] of Object.entries(config.CONTOUR_INTERVALS).sort((a, b) => b[0] - a[0])) {
        if (zoom >= parseInt(zoomThreshold)) {
            interval = int;
            break;
        }
    }

    const waterLevel = getActiveWaterLevel(state, config);
    const tier = zoom >= 16 ? 'hi' : 'lo';
    const cacheKey = `${tier}-${zoom}-${interval}-${waterLevel.toFixed(1)}-${bounds.toString()}`;

    if (state.contoursCache.has(cacheKey)) {
        state.lastContourGeoJSON = state.contoursCache.get(cacheKey);
        map.getSource('contours-source').setData(state.lastContourGeoJSON);
        return;
    }

    if (zoom < 16) {
        console.time('\u23F1\uFE0F contour: generate (low-res)');
        try {
            const { grid, width, height, bbox } = state.contourLowRes;
            const geojson = generateContourGeoJSON(grid, width, height, bbox, waterLevel, interval, config);
            state.lastContourGeoJSON = geojson;

            if (map.getSource('contours-source')) {
                map.getSource('contours-source').setData(geojson);
            }

            if (state.contoursCache.size > 20) {
                const firstKey = state.contoursCache.keys().next().value;
                state.contoursCache.delete(firstKey);
            }
            state.contoursCache.set(cacheKey, geojson);
        } catch (error) {
            console.error('Failed to generate contours (low-res):', error);
        }
        console.timeEnd('\u23F1\uFE0F contour: generate (low-res)');
    } else {
        // Show low-res immediately, then async hi-res
        try {
            const { grid, width, height, bbox } = state.contourLowRes;
            const loGeojson = generateContourGeoJSON(grid, width, height, bbox, waterLevel, interval, config);
            if (map.getSource('contours-source')) {
                map.getSource('contours-source').setData(loGeojson);
            }
        } catch (e) {
            // Non-critical
        }

        generateHighResContours(map, state, config, bounds, waterLevel, interval, cacheKey);
    }
}

// ============================================
// High-Resolution Contour Generation
// ============================================

/**
 * Async high-resolution contour generation for zoom >= 16.
 * Reads only the viewport extent from the COG at appropriate resolution.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 * @param {Object} config - Application config
 * @param {maplibregl.LngLatBounds} bounds - Current viewport bounds
 * @param {number} waterLevel - Current water level in meters AHD
 * @param {number} interval - Contour interval in meters
 * @param {string} cacheKey - Cache key for this contour generation
 *
 * @reads state.contourTiff — GeoTIFF object reference
 * @reads state.contourBbox — full extent bbox
 * @reads state.contourNoData — NoData value
 * @reads state.contourGenToken — cancellation token
 * @mutates state.contourGenToken — incremented for cancellation
 * @mutates state.lastContourGeoJSON — stores generated GeoJSON
 * @mutates state.contoursCache — adds new cache entry
 */
export async function generateHighResContours(map, state, config, bounds, waterLevel, interval, cacheKey) {
    if (!state.contourTiff || !state.contourBbox) return;

    const token = ++state.contourGenToken;

    try {
        console.time('\u23F1\uFE0F contour: generate (hi-res)');

        const sw = lngLatToWebMercator(bounds.getWest(), bounds.getSouth());
        const ne = lngLatToWebMercator(bounds.getEast(), bounds.getNorth());

        const padX = (ne[0] - sw[0]) * 0.5;
        const padY = (ne[1] - sw[1]) * 0.5;

        const [srcMinX, srcMinY, srcMaxX, srcMaxY] = state.contourBbox;
        const bboxMinX = Math.max(sw[0] - padX, srcMinX);
        const bboxMinY = Math.max(sw[1] - padY, srcMinY);
        const bboxMaxX = Math.min(ne[0] + padX, srcMaxX);
        const bboxMaxY = Math.min(ne[1] + padY, srcMaxY);

        if (bboxMinX >= bboxMaxX || bboxMinY >= bboxMaxY) {
            console.timeEnd('\u23F1\uFE0F contour: generate (hi-res)');
            return;
        }

        const bbox = [bboxMinX, bboxMinY, bboxMaxX, bboxMaxY];

        // Use 8x overview resolution for display reads — keeps contour display
        // on overview data while native/2x/4x are reserved for routing
        const resX = state.contourPixelSizeX * 8;
        const resY = state.contourPixelSizeY * 8;

        const rasters = await state.contourTiff.readRasters({
            bbox,
            resX,
            resY,
            pool: state.geoTiffPool
        });

        if (token !== state.contourGenToken) {
            console.timeEnd('\u23F1\uFE0F contour: generate (hi-res)');
            return;
        }

        const rawGrid = rasters[0];
        const width = rasters.width;
        const height = rasters.height;

        const grid = new Float32Array(rawGrid.length);
        const noDataValue = state.contourNoData;
        for (let i = 0; i < rawGrid.length; i++) {
            const val = rawGrid[i];
            if (val === noDataValue || val >= 1e5 || !Number.isFinite(val)) {
                grid[i] = Number.NaN;
            } else {
                grid[i] = val;
            }
        }

        if (token !== state.contourGenToken) {
            console.timeEnd('\u23F1\uFE0F contour: generate (hi-res)');
            return;
        }

        const geojson = generateContourGeoJSON(grid, width, height, bbox, waterLevel, interval, config);
        state.lastContourGeoJSON = geojson;

        if (map.getSource('contours-source')) {
            map.getSource('contours-source').setData(geojson);
        }

        if (state.contoursCache.size > 20) {
            const firstKey = state.contoursCache.keys().next().value;
            state.contoursCache.delete(firstKey);
        }
        state.contoursCache.set(cacheKey, geojson);

        console.timeEnd('\u23F1\uFE0F contour: generate (hi-res)');
    } catch (error) {
        console.error('Failed to generate contours (hi-res):', error);
    }
}
