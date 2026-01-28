/**
 * main.js — Config, state, map creation, initialization orchestrator
 *
 * Defines the application configuration, mutable state, and MapLibre GL
 * map instance. Imports all modules and wires cross-module dependencies
 * via explicit callback objects.
 */

import { getWaterLevelFromVolume } from './utils.js';

import {
    setupContourLayers,
    initializeContourGeneration,
    generateContoursForViewport
} from './contours.js';

import {
    initializeDepthGradient,
    addBathymetryLayers,
    loadSurveyLines,
    loadOverlayLayers,
    initializeLayerControls,
    initializeLegendToggles,
    initializeMobileToggle,
    initializeContextMenu,
    updateWaterLevelDisplay,
    initializeWaterLevelControls,
    onWaterLevelChange
} from './map.js';

import {
    initializeMeasureTool,
    addMeasureVertex,
    addMeasureFreePoint,
    updateElevationProfile,
    rebuildMeasurePanel,
    initializeDepthProbe,
    initializeClickHandlers,
    encodeNavPlan,
    decodeNavPlan,
    restoreNavPlan
} from './measure.js';

// ============================================
// Configuration
// ============================================

const CONFIG = {
    INITIAL_VIEW: {
        lng: 115.9930,
        lat: -33.3900,
        zoom: 15
    },

    // Bathymetry COG files
    BATHY_COG: 'merged_bathy_cog.tif',
    HILLSHADE_COG: 'hillshade_cog.tif',
    // Pre-processed contour source: 4096px short side with 2/4/8/16x overview pyramids, pre-smoothed
    CONTOUR_COG: 'contour_source.tif',

    // Water level configuration (from calibrated volume model)
    // Update CURRENT_STORAGE_GL to recalculate water level automatically
    CURRENT_STORAGE_GL: 84.35,
    WATER_LEVEL_DATE: '2026-01-26',
    get WATER_LEVEL_AHD() { return getWaterLevelFromVolume(this.CURRENT_STORAGE_GL); },

    // Elevation and depth ranges (dynamically calculated)
    MIN_ELEVATION_AHD: 126.0,
    get MAX_ELEVATION_AHD() { return this.WATER_LEVEL_AHD; },
    get DEPTH_RANGE() { return [0, Math.round(this.WATER_LEVEL_AHD - this.MIN_ELEVATION_AHD)]; },

    // Survey line files and colors
    SURVEY_LINE_FILES: [
        'north_adjusted.csv',
        'south_adjusted.csv',
        'northT1_adjusted.csv',
        'northT2_adjusted.csv',
        'southT1_adjusted.csv'
    ],
    SURVEY_LINE_COLORS: {
        'north_adjusted': '#FF6B6B',
        'south_adjusted': '#4ECDC4',
        'northT1_adjusted': '#FFE66D',
        'northT2_adjusted': '#95E1D3',
        'southT1_adjusted': '#AA96DA'
    },
    SURVEY_LINE_NAMES: {
        'north_adjusted': 'North Line',
        'south_adjusted': 'South Line',
        'northT1_adjusted': 'North Traverse 1',
        'northT2_adjusted': 'North Traverse 2',
        'southT1_adjusted': 'South Traverse 1'
    },

    // Contour configuration
    CONTOUR_COLOR: '#000000',
    CONTOUR_INTERVALS: {
        14: 1    // Zoom 14+: 1m intervals
    },
    MIN_CONTOUR_DEPTH: 0,
    MAX_CONTOUR_DEPTH: 31
};

// ============================================
// State
// ============================================

const state = {
    layerVisibility: {
        bathymetry: true,
        contours: true,
        entries: true,
        structures: true
    },
    measureMode: false,
    measurePoints: [],        // { lng, lat, isVertex, vertexKey }
    measureSegments: [],      // { coords: [[lng,lat],...], distance: number }
    measureTotalDistance: 0,
    lastMeasureVertexKey: null,
    graph: {},                // adjacency list: { "lng,lat": [{ key, dist }] }
    vertexSnap: {},           // rawKey -> canonicalKey for near-duplicate merging
    activePopup: null,
    surveyData: {},           // Survey line GeoJSON data by filename
    contoursCache: new Map(),
    contourLowRes: null,      // Pre-loaded {grid, width, height, bbox} from contour_source.tif overview
    contourTiff: null,        // GeoTIFF object ref for high-res viewport reads
    contourNoData: -9999,     // NoData value from contour source
    contourBbox: null,        // Full extent bbox [minX, minY, maxX, maxY] EPSG:3857
    contourGenToken: 0,       // Counter for cancelling stale async reads
    lastContourGeoJSON: null, // Last generated GeoJSON for debug download
    bathymetryLayer: null,    // Custom WebGL bathymetry layer reference
    hillshadeLayer: null,     // Custom WebGL hillshade layer reference

    // Water level control state
    useCurrentLevel: true,           // Whether to use Water Corp current level
    customStorageGL: 84,             // Custom storage level when not using current

    // Depth probe tool state
    depthProbeMode: false,
    depthProbeTooltip: null,         // DOM element reference (desktop)
    depthProbePopup: null,           // MapLibre Popup reference (mobile)

    // Drag state for free-form measure points
    draggingPointIndex: null,
    _suppressClick: false,

    // Contour drag state
    draggingContourSegment: null,    // { segmentIndex, pointAIndex, pointBIndex }
    contourDragGrid: null,           // { grid, width, height, bbox } — cached grid for A*
    contourDragGridLoading: false,   // Whether async grid load is in progress
    contourPreviewCoords: null,      // Preview path coordinates during drag

    // Internal: config reference for modules that need it via state
    _config: CONFIG
};

// ============================================
// Map Initialization
// ============================================

const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
            'esri-satellite': {
                type: 'raster',
                tiles: [
                    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
                ],
                tileSize: 256,
                maxzoom: 18
            }
        },
        layers: [
            {
                id: 'satellite-layer',
                type: 'raster',
                source: 'esri-satellite',
                minzoom: 0
            }
        ]
    },
    center: [CONFIG.INITIAL_VIEW.lng, CONFIG.INITIAL_VIEW.lat],
    zoom: CONFIG.INITIAL_VIEW.zoom,
    minZoom: 12,
    maxZoom: 20,
    maxPitch: 0,
    dragRotate: false,
    attributionControl: false
});

map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');

// ============================================
// Debug: downloadContourGeoJSON
// ============================================

/**
 * Download the current contour GeoJSON for analysis.
 * Call from the browser console: downloadContourGeoJSON()
 */
globalThis.downloadContourGeoJSON = function () {
    if (!state.lastContourGeoJSON) {
        console.warn('No contour data available \u2014 zoom in to generate contours first');
        return;
    }
    const data = state.lastContourGeoJSON;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `contours_z${Math.floor(map.getZoom())}.geojson`;
    a.click();
    URL.revokeObjectURL(url);
    console.log(`Downloaded ${data.features.length} features`);
};

// ============================================
// Nav Plan URL State
// ============================================

let _navHashTimer = null;

/** Debounced update of the URL hash with the current nav plan state. */
function updateNavHash() {
    clearTimeout(_navHashTimer);
    _navHashTimer = setTimeout(() => {
        const encoded = encodeNavPlan(map, state, CONFIG);
        if (encoded) {
            history.replaceState(null, '', '#nav=' + encoded);
        } else if (location.hash.startsWith('#nav=')) {
            history.replaceState(null, '', location.pathname + location.search);
        }
    }, 500);
}

// ============================================
// Cross-Module Callback Factories
// ============================================

// Bound contour generation function (map + state + config pre-applied)
const boundGenerateContoursForViewport = () => generateContoursForViewport(map, state, CONFIG);

// Water level callbacks
const waterLevelCallbacks = {
    updateElevationProfile: () => updateElevationProfile(state),
    generateContoursForViewport: boundGenerateContoursForViewport,
    rebuildMeasurePanel: () => rebuildMeasurePanel(state, CONFIG)
};

// Layer control callbacks
const layerControlCallbacks = {
    generateContoursForViewport: boundGenerateContoursForViewport
};

// Overlay layer callbacks
const overlayCallbacks = {
    addMeasureFreePoint: (lngLat) => addMeasureFreePoint(map, state, lngLat)
};

// Click handler callbacks
const clickHandlerCallbacks = {
    addMeasureVertex: (clickedKey) => addMeasureVertex(map, state, clickedKey),
    addMeasureFreePoint: (lngLat) => addMeasureFreePoint(map, state, lngLat)
};

// ============================================
// Map Load Handler
// ============================================

const geoTiffPool = new GeoTIFF.Pool();

map.on('load', async () => {
    try {
        // Initialize water level controls first
        initializeWaterLevelControls(map, state, CONFIG, waterLevelCallbacks);
        initializeDepthGradient(state, CONFIG);
        updateWaterLevelDisplay(state, CONFIG);

        // Add bathymetry + hillshade layers
        addBathymetryLayers(map, state, CONFIG, geoTiffPool);

        // Load survey lines (small CSV fetches)
        await loadSurveyLines(map, state, CONFIG);

        // Set up contour source/layers (needs survey lines first for z-order)
        setupContourLayers(map, state, CONFIG, boundGenerateContoursForViewport);

        // Load GeoJSON overlay layers
        await loadOverlayLayers(map, state, overlayCallbacks);

        // Initialize UI handlers
        initializeMeasureTool(map, state);
        initializeDepthProbe(map, state);
        initializeLayerControls(map, state, layerControlCallbacks);
        initializeClickHandlers(map, state, CONFIG, clickHandlerCallbacks);
        initializeLegendToggles(map, state);
        initializeMobileToggle();
        initializeContextMenu(map);

        // Wire up nav plan URL updates — called whenever measure state changes
        state.onNavPlanChange = updateNavHash;

        // Restore nav plan from URL hash if present
        let navPlanRestored = false;
        if (location.hash.startsWith('#nav=')) {
            const plan = decodeNavPlan(location.hash.slice(5));
            if (plan) {
                restoreNavPlan(map, state, CONFIG, plan);
                navPlanRestored = true;
                console.log('Nav plan restored from URL');
            }
        }

        // If a nav plan changed the water level, propagate through
        // the full pipeline (display, bathymetry recolor, contour cache clear)
        if (navPlanRestored && !state.useCurrentLevel) {
            onWaterLevelChange(state, CONFIG, waterLevelCallbacks);
        }

        // Hide loading overlay — map is interactive now
        document.getElementById('loading').classList.add('hidden');

        // Force a render frame so MapLibre draws the bathymetry tiles
        map.triggerRepaint();

        // Fire moveend so viewport-dependent layers (bathymetry, hillshade)
        // re-read at the correct position — especially after nav plan restore
        // which uses jumpTo (doesn't fire moveend automatically)
        map.fire('moveend');

        // Start contour COG loading + initial generation in background
        requestAnimationFrame(() => {
            initializeContourGeneration(map, state, CONFIG, boundGenerateContoursForViewport, geoTiffPool);
        });

    } catch (error) {
        console.error('Error loading map:', error);
        document.getElementById('loading-text').textContent = 'Error loading map';
    }
});
