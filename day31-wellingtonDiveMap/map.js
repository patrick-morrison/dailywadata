/**
 * map.js — Map layers, rendering, UI controls, survey lines
 *
 * All map layer setup, survey data loading, water level controls,
 * layer toggles, legend interactions, mobile toggle, and context menu.
 * Receives map, state, and config as explicit parameters.
 */

import {
    TURBO_COLORMAP,
    getActiveStorageGL,
    getActiveWaterLevel,
    getActiveDepthRange,
    getTurboColorForDepth,
    haversineDistance,
    formatCoordinates,
    coordKey,
    coordFromKey,
    webMercatorToLngLat
} from './utils.js';

// ============================================
// Depth Gradient Legend
// ============================================

/**
 * Build CSS depth gradient for the legend sidebar.
 *
 * @param {Object} state - Application state
 * @param {Object} config - Application config
 *
 * @reads state.useCurrentLevel, state.customStorageGL (via getActiveDepthRange)
 */
export function initializeDepthGradient(state, config) {
    const gradientEl = document.getElementById('depth-gradient');
    if (!gradientEl) return;

    const [minDepth, maxDepth] = getActiveDepthRange(state, config);

    const stops = [];
    for (let i = 0; i <= 10; i++) {
        const depth = (i / 10) * maxDepth;
        const [r, g, b] = getTurboColorForDepth(depth, minDepth, maxDepth);
        stops.push(`rgb(${r}, ${g}, ${b}) ${i * 10}%`);
    }

    gradientEl.style.background = `linear-gradient(to bottom, ${stops.join(', ')})`;
}

// ============================================
// Bathymetry Layers
// ============================================

/**
 * Register bathymetry and hillshade as custom WebGL layers.
 * Bathymetry loads the full COG (~6 MB) in one request, then reads from
 * the in-memory cache on each viewport change.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 * @param {Object} config - Application config
 *
 * @mutates state.bathymetryLayer — stores custom WebGL bathymetry layer reference
 * @mutates state.hillshadeLayer — stores custom WebGL hillshade layer reference
 */
export function addBathymetryLayers(map, state, config) {
    try {
        state.bathymetryLayer = createBathymetryLayer({
            id: 'bathymetry-layer',
            cogUrl: config.BATHY_COG,
            opacity: 1.0,
            getWaterLevel: () => getActiveWaterLevel(state, config),
            getDepthRange: () => getActiveDepthRange(state, config),
            noDataThreshold: 1e5,
            colormap: TURBO_COLORMAP
        });
        map.addLayer(state.bathymetryLayer);

        state.hillshadeLayer = createMultiplyHillshadeLayer({
            id: 'hillshade-layer',
            cogUrl: config.HILLSHADE_COG,
            opacity: 1.0
        });
        map.addLayer(state.hillshadeLayer);

        console.log('Bathymetry layers added successfully');
    } catch (error) {
        console.error('Failed to add bathymetry layers:', error);
    }
}

// ============================================
// Survey Line Loading
// ============================================

/**
 * Fetch CSV survey line files, parse them, add GeoJSON layers to the map,
 * then build the survey graph and add vertex markers.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 * @param {Object} config - Application config
 *
 * @mutates state.surveyData — populates survey line data by filename key
 * @mutates state.graph — populated via buildSurveyGraph
 * @mutates state.vertexSnap — populated via buildSurveyGraph
 */
export async function loadSurveyLines(map, state, config) {
    const allFeatures = [];

    for (const filename of config.SURVEY_LINE_FILES) {
        try {
            const response = await fetch(filename);
            if (!response.ok) {
                console.warn(`Could not load ${filename}`);
                continue;
            }

            const csvText = await response.text();
            const lines = csvText.trim().split('\n');
            const headers = lines[0].split(',');

            const yIndex = headers.findIndex(h => h.trim() === 'Y');
            const xIndex = headers.findIndex(h => h.trim() === 'X');
            const elevIndex = headers.findIndex(h => h.trim() === 'Elevation');
            const markerIndex = headers.findIndex(h => h.trim() === 'Marker');

            if (yIndex === -1 || xIndex === -1) {
                console.warn(`Missing Y/X columns in ${filename}`);
                continue;
            }

            const coordinates = [];
            const points = [];

            for (let i = 1; i < lines.length; i++) {
                const values = lines[i].split(',');
                const lat = parseFloat(values[yIndex]);
                const lng = parseFloat(values[xIndex]);
                const elevation = elevIndex !== -1 ? parseFloat(values[elevIndex]) : null;
                const marker = markerIndex !== -1 ? values[markerIndex]?.trim() : null;

                if (!isNaN(lat) && !isNaN(lng)) {
                    coordinates.push([lng, lat]);
                    points.push({
                        coord: [lng, lat],
                        elevation: elevation,
                        marker: marker
                    });
                }
            }

            if (coordinates.length >= 2) {
                const lineKey = filename.replace('.csv', '');
                state.surveyData[lineKey] = {
                    coordinates,
                    points,
                    color: config.SURVEY_LINE_COLORS[lineKey],
                    name: config.SURVEY_LINE_NAMES[lineKey]
                };

                allFeatures.push({
                    type: 'Feature',
                    geometry: {
                        type: 'LineString',
                        coordinates: coordinates
                    },
                    properties: {
                        lineKey: lineKey,
                        name: config.SURVEY_LINE_NAMES[lineKey],
                        color: config.SURVEY_LINE_COLORS[lineKey],
                        pointCount: coordinates.length
                    }
                });

                console.log(`Loaded ${filename}: ${coordinates.length} points`);
            }
        } catch (error) {
            console.error(`Error loading ${filename}:`, error);
        }
    }

    if (allFeatures.length > 0) {
        map.addSource('survey-lines', {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: allFeatures
            }
        });

        const colorExpression = ['match', ['get', 'lineKey']];
        Object.entries(config.SURVEY_LINE_COLORS).forEach(([key, color]) => {
            colorExpression.push(key, color);
        });
        colorExpression.push('#888888');

        map.addLayer({
            id: 'survey-lines-layer',
            type: 'line',
            source: 'survey-lines',
            paint: {
                'line-color': colorExpression,
                'line-width': 4,
                'line-opacity': 0.9
            }
        });
    }

    buildSurveyGraph(state);
    addVertexMarkers(map, state);
}

// ============================================
// Survey Graph
// ============================================

/**
 * Build adjacency list graph from survey line data.
 * Each consecutive vertex pair gets bidirectional edges with haversine distance.
 *
 * Near-duplicate vertices (within ~3 m) are snapped to a single canonical key
 * so that the North and South lines share their common first few points and
 * the graph stays connected at junctions.
 *
 * @param {Object} state - Application state
 *
 * @reads state.surveyData — survey line coordinate data
 * @mutates state.graph — adjacency list
 * @mutates state.vertexSnap — rawKey to canonicalKey mapping
 */
export function buildSurveyGraph(state) {
    const SNAP_THRESHOLD = 3;
    const graph = {};
    const canonicalCoords = [];
    const snapMap = {};

    function snap(coord) {
        const raw = coordKey(coord);
        if (snapMap[raw]) return snapMap[raw];

        for (const entry of canonicalCoords) {
            if (haversineDistance(coord, entry.coord) < SNAP_THRESHOLD) {
                snapMap[raw] = entry.key;
                return entry.key;
            }
        }

        snapMap[raw] = raw;
        canonicalCoords.push({ coord, key: raw });
        return raw;
    }

    for (const lineKey of Object.keys(state.surveyData)) {
        const { coordinates } = state.surveyData[lineKey];
        for (let i = 0; i < coordinates.length - 1; i++) {
            const keyA = snap(coordinates[i]);
            const keyB = snap(coordinates[i + 1]);
            const dist = haversineDistance(coordinates[i], coordinates[i + 1]);

            if (!graph[keyA]) graph[keyA] = [];
            if (!graph[keyB]) graph[keyB] = [];
            graph[keyA].push({ key: keyB, dist });
            graph[keyB].push({ key: keyA, dist });
        }
    }

    state.graph = graph;
    state.vertexSnap = snapMap;
    console.log(`Survey graph built: ${Object.keys(graph).length} vertices (${Object.keys(snapMap).length} raw coords, ${canonicalCoords.length} canonical)`);
}

// ============================================
// Vertex Markers
// ============================================

/**
 * Add clickable vertex markers for all survey line vertices.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 *
 * @reads state.surveyData — survey line coordinate data
 * @reads state.vertexSnap — vertex snap mapping
 */
export function addVertexMarkers(map, state) {
    const seen = new Set();
    const features = [];

    for (const lineKey of Object.keys(state.surveyData)) {
        const { coordinates } = state.surveyData[lineKey];
        for (const coord of coordinates) {
            const raw = coordKey(coord);
            const canonical = state.vertexSnap[raw] || raw;
            if (seen.has(canonical)) continue;
            seen.add(canonical);
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: coordFromKey(canonical) },
                properties: { key: canonical }
            });
        }
    }

    map.addSource('survey-vertices', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features }
    });

    map.addLayer({
        id: 'survey-vertices-layer',
        type: 'circle',
        source: 'survey-vertices',
        layout: {
            visibility: 'none'
        },
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2, 18, 6],
            'circle-color': '#ffffff',
            'circle-stroke-color': '#0891b2',
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 18, 1.5],
            'circle-opacity': 0.9
        }
    });

    map.addSource('survey-vertex-highlight', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });

    map.addLayer({
        id: 'survey-vertex-highlight-layer',
        type: 'circle',
        source: 'survey-vertex-highlight',
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 4, 18, 8],
            'circle-color': '#0891b2',
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
            'circle-opacity': 0.9
        }
    });

    console.log(`Vertex markers added: ${features.length} vertices`);
}

// findShortestPath is in utils.js (pure graph algorithm)

// ============================================
// GeoJSON Overlay Layers
// ============================================

const OVERLAY_LAYERS = [
    { id: 'entries',    file: 'Entries.geojson',    color: '#e74c3c', label: 'Entries' },
    { id: 'structures', file: 'Structures.geojson', color: '#f39c12', label: 'Structures' }
];

/**
 * Fetch and display GeoJSON overlay layers (Entries, Structures).
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 * @param {Object} callbacks - Cross-module callbacks
 * @param {Function} callbacks.addMeasureFreePoint - (lngLat) => void
 *
 * @reads state.measureMode — whether measure mode is active
 * @mutates state.activePopup — sets/removes active popup
 */
export async function loadOverlayLayers(map, state, callbacks) {
    for (const layer of OVERLAY_LAYERS) {
        try {
            const response = await fetch(layer.file);
            if (!response.ok) { console.warn(`Could not load ${layer.file}`); continue; }
            const geojson = await response.json();

            const features = geojson.features
                .filter(f => f.geometry !== null)
                .map(f => ({
                    ...f,
                    geometry: {
                        type: f.geometry.type,
                        coordinates: webMercatorToLngLat(f.geometry.coordinates[0], f.geometry.coordinates[1])
                    }
                }));

            const sourceId = `overlay-${layer.id}`;
            map.addSource(sourceId, {
                type: 'geojson',
                data: { type: 'FeatureCollection', features }
            });

            map.addLayer({
                id: `${sourceId}-circles`,
                type: 'circle',
                source: sourceId,
                paint: {
                    'circle-radius': 7,
                    'circle-color': layer.color,
                    'circle-stroke-color': '#ffffff',
                    'circle-stroke-width': 2,
                    'circle-opacity': 0.9
                }
            });

            map.addLayer({
                id: `${sourceId}-labels`,
                type: 'symbol',
                source: sourceId,
                layout: {
                    'text-field': ['coalesce', ['get', 'name'], ['get', 'Name'], ''],
                    'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
                    'text-size': 12,
                    'text-offset': [0, 1.5],
                    'text-anchor': 'top',
                    'text-optional': true
                },
                paint: {
                    'text-color': '#000000',
                    'text-halo-color': '#ffffff',
                    'text-halo-width': 1.5
                }
            });

            map.on('click', `${sourceId}-circles`, (e) => {
                if (state.measureMode) { callbacks.addMeasureFreePoint(e.lngLat); return; }
                const props = e.features[0].properties;
                const name = props.name || props.Name || 'Unnamed';
                const extra = props.Reporter ? `<div class="popup-row"><span class="popup-label">Reporter</span>${props.Reporter}</div>` : '';
                if (state.activePopup) state.activePopup.remove();
                state.activePopup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
                    .setLngLat(e.lngLat)
                    .setHTML(`<div class="segment-popup"><div class="popup-title">${name}</div>${extra}</div>`)
                    .addTo(map);
            });

            map.on('mouseenter', `${sourceId}-circles`, () => {
                if (!state.measureMode) map.getCanvas().style.cursor = 'pointer';
            });
            map.on('mouseleave', `${sourceId}-circles`, () => {
                if (!state.measureMode) map.getCanvas().style.cursor = '';
            });

            console.log(`Loaded overlay: ${layer.label} (${features.length} features)`);
        } catch (error) {
            console.error(`Error loading ${layer.file}:`, error);
        }
    }
}

// ============================================
// Layer Controls
// ============================================

/**
 * Initialize checkbox toggle bindings for layer visibility.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 * @param {Object} callbacks - Cross-module callbacks
 * @param {Function} callbacks.generateContoursForViewport - () => void
 *
 * @mutates state.layerVisibility — toggled by checkbox changes
 */
export function initializeLayerControls(map, state, callbacks) {
    const layerControls = document.querySelectorAll('.layer-control[data-layer]');

    layerControls.forEach(control => {
        const layerId = control.dataset.layer;
        const checkbox = control.querySelector('input[type="checkbox"]');

        checkbox.addEventListener('change', () => {
            state.layerVisibility[layerId] = checkbox.checked;
            const visibility = checkbox.checked ? 'visible' : 'none';

            if (layerId === 'bathymetry') {
                if (state.bathymetryLayer) {
                    state.bathymetryLayer.setOpacity(checkbox.checked ? 1.0 : 0.0);
                }
                if (state.hillshadeLayer) {
                    state.hillshadeLayer.setOpacity(checkbox.checked ? 1.0 : 0.0);
                }
                map.triggerRepaint();
            } else if (layerId === 'contours') {
                if (map.getLayer('contours-layer')) {
                    map.setLayoutProperty('contours-layer', 'visibility', visibility);
                }
                if (map.getLayer('contours-labels')) {
                    map.setLayoutProperty('contours-labels', 'visibility', visibility);
                }
                if (checkbox.checked) {
                    callbacks.generateContoursForViewport();
                }
            } else if (['entries', 'structures'].includes(layerId)) {
                const sourceId = `overlay-${layerId}`;
                if (map.getLayer(`${sourceId}-circles`)) {
                    map.setLayoutProperty(`${sourceId}-circles`, 'visibility', visibility);
                }
                if (map.getLayer(`${sourceId}-labels`)) {
                    map.setLayoutProperty(`${sourceId}-labels`, 'visibility', visibility);
                }
            }
        });
    });
}

// ============================================
// Legend Zoom to Survey Line
// ============================================

/**
 * Initialize survey line legend click-to-zoom functionality.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 *
 * @reads state.surveyData — survey line coordinate data
 */
export function initializeLegendToggles(map, state) {
    const colorItems = document.querySelectorAll('.color-item[data-line]');

    colorItems.forEach(item => {
        item.addEventListener('click', () => {
            const lineKey = item.dataset.line;
            const surveyLine = state.surveyData[lineKey];

            if (surveyLine && surveyLine.coordinates.length > 0) {
                const lngs = surveyLine.coordinates.map(c => c[0]);
                const lats = surveyLine.coordinates.map(c => c[1]);

                const bounds = [
                    [Math.min(...lngs), Math.min(...lats)],
                    [Math.max(...lngs), Math.max(...lats)]
                ];

                const isMobile = globalThis.innerWidth <= 768;
                const padding = isMobile
                    ? { top: 120, bottom: 250, left: 50, right: 50 }
                    : { top: 100, bottom: 100, left: 400, right: 100 };

                map.fitBounds(bounds, {
                    padding: padding,
                    maxZoom: 17,
                    duration: 1000
                });

                colorItems.forEach(ci => ci.classList.remove('selected'));
                item.classList.add('selected');
            }
        });
    });
}

// ============================================
// Mobile Toggle
// ============================================

/**
 * Initialize mobile expand/collapse behavior for legend and title card.
 */
export function initializeMobileToggle() {
    const titleCard = document.querySelector('.title-card');
    const legend = document.querySelector('.legend');
    const legendToggle = document.getElementById('legend-toggle');

    titleCard.addEventListener('click', (e) => {
        if (globalThis.innerWidth <= 768) {
            if (e.target.tagName !== 'A') {
                titleCard.classList.toggle('expanded');
            }
        }
    });

    if (legendToggle && legend) {
        legendToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            legend.classList.toggle('collapsed');

            const isCollapsed = legend.classList.contains('collapsed');
            localStorage.setItem('legendCollapsed', isCollapsed ? 'true' : 'false');
        });

        if (globalThis.innerWidth <= 768) {
            const savedState = localStorage.getItem('legendCollapsed');
            if (savedState === 'true') {
                legend.classList.add('collapsed');
            }
        }
    }
}

// ============================================
// Context Menu
// ============================================

/**
 * Initialize right-click context menu for coordinate copying.
 *
 * @param {maplibregl.Map} map - The map instance
 */
function showContextMenu(lngLat, point) {
    const existing = document.getElementById('context-menu');
    if (existing) existing.remove();

    const { lng, lat } = lngLat;
    const coords = formatCoordinates(lng, lat);

    const menu = document.createElement('div');
    menu.id = 'context-menu';
    menu.className = 'context-menu';
    menu.style.visibility = 'hidden';
    menu.style.left = `${point.x}px`;
    menu.style.top = `${point.y}px`;

    menu.innerHTML = `
        <div class="context-menu-item" id="copy-dd">
            <span>Copy Decimal Degrees</span>
            <span style="opacity: 0.5; margin-left: 12px; font-size: 0.7rem;">${coords.gmaps}</span>
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" id="copy-dm">
            <span>Copy Decimal Minutes</span>
            <span style="opacity: 0.5; margin-left: 12px; font-size: 0.7rem;">${coords.display}</span>
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" id="copy-link">
            <span>Copy Link</span>
        </div>
    `;

    document.body.appendChild(menu);

    // Clamp menu position so it stays on screen with padding,
    // and offset away from the touch point if it would overlap
    const menuRect = menu.getBoundingClientRect();
    const vw = globalThis.innerWidth;
    const vh = globalThis.innerHeight;
    const pad = 12;
    let left = point.x;
    let top = point.y;
    if (left + menuRect.width + pad > vw) left = point.x - menuRect.width;
    if (top + menuRect.height + pad > vh) top = point.y - menuRect.height;
    if (left < pad) left = pad;
    if (top < pad) top = pad;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = '';

    document.getElementById('copy-dd').addEventListener('click', () => {
        navigator.clipboard.writeText(coords.gmaps);
        menu.remove();
    });

    document.getElementById('copy-dm').addEventListener('click', () => {
        navigator.clipboard.writeText(coords.display);
        menu.remove();
    });

    document.getElementById('copy-link').addEventListener('click', () => {
        const url = `${globalThis.location.origin}${globalThis.location.pathname}#${lat.toFixed(6)},${lng.toFixed(6)}`;
        navigator.clipboard.writeText(url);
        menu.remove();
    });

    const closeMenu = () => {
        menu.remove();
        document.removeEventListener('click', closeMenu);
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 100);
}

export function initializeContextMenu(map) {
    // Desktop: right-click
    map.on('contextmenu', (e) => {
        showContextMenu(e.lngLat, e.point);
    });

    // Mobile: long-press (500ms)
    const canvas = map.getCanvas();
    let longPressTimer = null;
    let longPressTouch = null;

    canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
            return;
        }
        const touch = e.touches[0];
        longPressTouch = { x: touch.clientX, y: touch.clientY };

        longPressTimer = setTimeout(() => {
            if (!longPressTouch) return;
            const rect = canvas.getBoundingClientRect();
            const point = {
                x: longPressTouch.x - rect.left,
                y: longPressTouch.y - rect.top
            };
            const lngLat = map.unproject(point);
            showContextMenu(lngLat, point);
            longPressTouch = null;
        }, 500);
    }, { passive: true });

    canvas.addEventListener('touchmove', (e) => {
        if (!longPressTimer || !longPressTouch) return;
        const touch = e.touches[0];
        const dx = touch.clientX - longPressTouch.x;
        const dy = touch.clientY - longPressTouch.y;
        // Cancel if finger moved more than 10px
        if (dx * dx + dy * dy > 100) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
            longPressTouch = null;
        }
    }, { passive: true });

    canvas.addEventListener('touchend', () => {
        clearTimeout(longPressTimer);
        longPressTimer = null;
        longPressTouch = null;
    }, { passive: true });

    canvas.addEventListener('touchcancel', () => {
        clearTimeout(longPressTimer);
        longPressTimer = null;
        longPressTouch = null;
    }, { passive: true });
}

// ============================================
// Water Level Display and Controls
// ============================================

/**
 * Update DOM elements with current water level information.
 *
 * @param {Object} state - Application state
 * @param {Object} config - Application config
 *
 * @reads state.useCurrentLevel — whether using current or custom level
 * @reads state.customStorageGL (via getActiveStorageGL)
 */
export function updateWaterLevelDisplay(state, config) {
    const storageGL = getActiveStorageGL(state, config);
    const waterLevel = getActiveWaterLevel(state, config);
    const [, maxDepth] = getActiveDepthRange(state, config);

    const noteEl = document.getElementById('water-level-note');
    if (noteEl) {
        if (state.useCurrentLevel) {
            noteEl.textContent = `Water level: ~${waterLevel.toFixed(1)}m AHD (${storageGL} GL)`;
            noteEl.title = `Current level from Water Corporation (${config.WATER_LEVEL_DATE})`;
        } else {
            noteEl.textContent = `Water level: ~${waterLevel.toFixed(1)}m AHD (${storageGL} GL)`;
            noteEl.title = 'Custom water level (drag slider to adjust)';
        }
    }

    const depthLabelsEl = document.querySelector('.depth-labels');
    if (depthLabelsEl) {
        const midDepth = Math.round(maxDepth / 2);
        depthLabelsEl.innerHTML = `<span>0m</span><span>${midDepth}m</span><span>${maxDepth}m</span>`;
    }

    const sliderValueEl = document.getElementById('water-level-value');
    if (sliderValueEl) {
        sliderValueEl.textContent = `${Math.round(storageGL)} GL`;
    }

    initializeDepthGradient(state, config);
}

/**
 * Refresh bathymetry after water level change.
 * Re-colors the cached elevation data — no COG re-read needed.
 *
 * @param {Object} state - Application state
 *
 * @reads state.bathymetryLayer — custom WebGL layer reference
 * @mutates state.contoursCache — cleared
 */
export function refreshBathymetryTiles(state) {
    if (state.bathymetryLayer && state.bathymetryLayer.recolor) {
        state.bathymetryLayer.recolor();
    }

    state.contoursCache.clear();
}

/**
 * Handle water level change from slider or checkbox.
 *
 * @param {Object} state - Application state
 * @param {Object} config - Application config
 * @param {Object} callbacks - Cross-module callbacks
 * @param {Function} callbacks.updateElevationProfile - () => void
 * @param {Function} callbacks.generateContoursForViewport - () => void
 * @param {Function} callbacks.rebuildMeasurePanel - () => void
 */
export function onWaterLevelChange(state, config, callbacks) {
    updateWaterLevelDisplay(state, config);
    refreshBathymetryTiles(state);

    if (state.contourLowRes && state.layerVisibility.contours) {
        callbacks.generateContoursForViewport();
    }

    callbacks.updateElevationProfile();
    callbacks.rebuildMeasurePanel();
}

/**
 * Initialize water level slider and lock checkbox controls.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 * @param {Object} config - Application config
 * @param {Object} callbacks - Cross-module callbacks
 * @param {Function} callbacks.updateElevationProfile - () => void
 * @param {Function} callbacks.generateContoursForViewport - () => void
 *
 * @mutates state.customStorageGL — updated by slider input
 * @mutates state.useCurrentLevel — toggled by checkbox
 */
export function initializeWaterLevelControls(map, state, config, callbacks) {
    const slider = document.getElementById('water-level-slider');
    const lockCheckbox = document.getElementById('water-level-lock');
    const currentLevelLabel = document.getElementById('current-level-label');

    if (!slider || !lockCheckbox) return;

    slider.value = Math.round(config.CURRENT_STORAGE_GL);
    slider.disabled = state.useCurrentLevel;
    if (currentLevelLabel) {
        currentLevelLabel.textContent = `${config.CURRENT_STORAGE_GL} GL`;
    }

    slider.addEventListener('input', () => {
        state.customStorageGL = parseFloat(slider.value);
        updateWaterLevelDisplay(state, config);
    });

    slider.addEventListener('change', () => {
        state.customStorageGL = parseFloat(slider.value);
        onWaterLevelChange(state, config, callbacks);
    });

    lockCheckbox.addEventListener('change', () => {
        state.useCurrentLevel = lockCheckbox.checked;
        slider.disabled = state.useCurrentLevel;

        if (state.useCurrentLevel) {
            slider.value = Math.round(config.CURRENT_STORAGE_GL);
        }

        onWaterLevelChange(state, config, callbacks);
    });
}
