/**
 * Wadjemup Rottnest Bathymetry Visualization
 * Interactive depth map with hillshade rendering
 */

// ============================================
// Constants & Configuration
// ============================================

const CONFIG = {
    // Data settings
    COG_URL: window.PAGE_CONFIG?.cogUrl || 'SC20100413_optimized.tif',
    NODATA_VALUE: -9999,

    // Visualization settings (Swan River: 0-22m depth)
    DEPTH_MIN: -22,    // Deep water (m)
    DEPTH_MAX: 0,      // Shallow water (m)

    // Gradient stops (shallow to deep) - optimized for 0-22m range
    COLOR_STOPS: [
        { depth: -0.5, color: [122, 4, 3] },       // Very shallow - dark red
        { depth: -4, color: [249, 117, 29] },      // Orange
        { depth: -8, color: [239, 205, 58] },      // Yellow
        { depth: -12, color: [109, 254, 98] },     // Green
        { depth: -16, color: [30, 203, 218] },     // Cyan
        { depth: -20, color: [70, 100, 218] },     // Blue
        { depth: -22, color: [48, 18, 59] }        // Deep - purple
    ],

    // Hillshade parameters
    SUN_AZIMUTH: 315,
    SUN_ALTITUDE: 45,

    // Performance
    MAX_RENDER_WIDTH: 2048,

    // Bathymetry Bounds (SC20100413) in WGS84
    BOUNDS: {
        west: 115.7532,
        south: -32.0421,
        east: 115.8594,
        north: -31.9599
    },

    // Calculate initial view from bounds
    get INITIAL_VIEW() {
        return {
            lng: 115.80,
            lat: -32.00,
            zoom: 12
        };
    }
};

// ============================================
// State Management
// ============================================

const state = {
    tiff: null,
    image: null,
    rasterData: null,
    bounds: null,
    deckOverlay: null,
    exaggeration: 15,

    // Rendered dimensions (may differ from TIFF dimensions due to scaling)
    renderedWidth: null,
    renderedHeight: null,

    // Markers
    clickMarker: null,
    clickPopup: null,
    poiMarkers: [],

    // Geolocation
    userLocationMarker: null,
    watchId: null,
    isTracking: false,
    deviceHeading: null
};

// ============================================
// Math Utils (Web Mercator)
// ============================================

const EARTH_RADIUS = 6378137;

/**
 * Convert Web Mercator (EPSG:3857) X/Y to WGS84 Lng/Lat
 */
function mercatorToLngLat(x, y) {
    const lng = (x * 180) / (Math.PI * EARTH_RADIUS);
    const lat = (Math.atan(Math.exp((y * Math.PI) / (Math.PI * EARTH_RADIUS))) * 360) / Math.PI - 90;
    return [lng, lat];
}

/**
 * Convert WGS84 Lng/Lat to Web Mercator (EPSG:3857) X/Y
 */
function lngLatToMercator(lng, lat) {
    const x = (lng * Math.PI * EARTH_RADIUS) / 180;
    const y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * (Math.PI * EARTH_RADIUS) / Math.PI;
    return [x, y];
}

// ============================================
// Map Initialization
// ============================================

const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        sources: {
            'carto-light': {
                type: 'raster',
                tiles: [
                    'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
                    'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
                    'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png'
                ],
                tileSize: 256
            }
        },
        layers: [{
            id: 'carto-light-layer',
            type: 'raster',
            source: 'carto-light',
            minzoom: 0,
            maxzoom: 22
        }]
    },
    center: [CONFIG.INITIAL_VIEW.lng, CONFIG.INITIAL_VIEW.lat],
    zoom: CONFIG.INITIAL_VIEW.zoom,
    minZoom: 9,
    maxZoom: 16,
    maxPitch: 0,
    dragRotate: false,
    customAttribution: '© <a href="https://www.transport.wa.gov.au">Dept of Transport WA</a> © CARTO © OpenStreetMap contributors',
    attributionControl: {
        compact: true
    }
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

// ============================================
// Event Handlers
// ============================================

// Map Load
// Track when bathymetry data is ready
let bathymetryReady = null;

map.on('load', () => {
    initializeLegend();

    // Create route line layer early so deck.gl can use beforeId to render beneath it
    map.addSource('route-line', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'route-line-layer',
        type: 'line',
        source: 'route-line',
        layout: {
            'line-join': 'round',
            'line-cap': 'round'
        },
        paint: {
            'line-color': '#dc2626',
            'line-width': 3,
            'line-opacity': 1
        }
    });

    // Store promise so we can await it elsewhere
    bathymetryReady = loadBathymetry();

    // Add POIs
    const pois = window.PAGE_CONFIG?.pois || [];
    pois.forEach(poi => {
        const el = document.createElement('div');
        el.className = 'poi-marker';
        el.innerHTML = `<span class="poi-label">${poi.name}</span>`;

        new maplibregl.Marker({ element: el, anchor: 'center' })
            .setLngLat([poi.lng, poi.lat])
            .addTo(map);
    });

    // Check for shared location hash (#lat,lng)
    checkHashLocation();
});

async function checkHashLocation() {
    const hash = window.location.hash.slice(1);
    if (!hash) return;

    const [latStr, lngStr] = hash.split(',');
    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);

    if (isNaN(lat) || isNaN(lng)) return;

    // Wait for data to load, then show popup
    const waitForData = () => {
        if (state.image) {
            // Fly to location (zoom 13 is a reasonable detail level)
            map.flyTo({ center: [lng, lat], zoom: 13, duration: 1500 });

            // Query depth and show popup after fly completes
            setTimeout(async () => {
                const depth = await queryDepth(lng, lat);
                if (depth !== null) {
                    showClickPopup(depth, lng, lat);
                }
            }, 1600);
        } else {
            setTimeout(waitForData, 200);
        }
    };
    waitForData();
}

// Interactions
map.on('mousemove', async (e) => {
    // If profile sync is active, do NOT overwrite the display
    // We check if the profiler has a hover distance set
    if (window.profiler && window.profiler.hoverDistance !== null) {
        return;
    }

    const depth = await queryDepth(e.lngLat.lng, e.lngLat.lat);
    updateCursorDepth(depth, e.lngLat.lng, e.lngLat.lat);
});

map.on('click', async (e) => {
    // If drawing a route, ignore normal clicks
    if (window.profiler && window.profiler.isActive) return;

    // Only show popup for touch events, not mouse clicks
    const isTouch = e.originalEvent?.pointerType === 'touch' ||
        e.originalEvent?.touches !== undefined ||
        e.originalEvent?.type?.startsWith('touch');
    if (!isTouch) return;

    const depth = await queryDepth(e.lngLat.lng, e.lngLat.lat);
    if (depth !== null) {
        showClickPopup(depth, e.lngLat.lng, e.lngLat.lat);
    }
});

// Context Menu (Right Click)
map.on('contextmenu', async (e) => {
    const existing = document.getElementById('context-menu');
    if (existing) existing.remove();

    const { lng, lat } = e.lngLat;
    const coords = formatCoordinates(lng, lat);

    // Query depth at click location
    const depth = await queryDepth(lng, lat);

    // Create menu
    const menu = document.createElement('div');
    menu.id = 'context-menu';
    menu.className = 'context-menu';
    menu.style.left = `${e.point.x}px`;
    menu.style.top = `${e.point.y}px`;

    // Menu Items - Copy Depth first if available
    let menuHtml = '';

    if (depth !== null) {
        menuHtml += `
            <div class="context-menu-item" id="copy-depth">
                <span>Copy Depth</span>
                <span style="opacity: 0.5; margin-left: 12px; font-size: 0.7rem;">${depth.toFixed(1)}m</span>
            </div>
            <div class="context-menu-separator"></div>
        `;
    }

    menuHtml += `
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

    menu.innerHTML = menuHtml;
    document.body.appendChild(menu);

    // Click Handlers
    document.getElementById('copy-dd').addEventListener('click', () => {
        navigator.clipboard.writeText(coords.gmaps);
        menu.remove();
    });

    document.getElementById('copy-dm').addEventListener('click', () => {
        navigator.clipboard.writeText(coords.display);
        menu.remove();
    });

    document.getElementById('copy-link').addEventListener('click', () => {
        const url = `${window.location.origin}${window.location.pathname}#${lat.toFixed(6)},${lng.toFixed(6)}`;
        navigator.clipboard.writeText(url);
        menu.remove();
    });

    if (depth !== null) {
        document.getElementById('copy-depth').addEventListener('click', () => {
            navigator.clipboard.writeText(`${depth.toFixed(1)}m`);
            menu.remove();
        });
    }

    // Close on map click/move
    const removeMenu = () => {
        menu.remove();
        map.off('click', removeMenu);
        map.off('move', removeMenu);
    };
    map.on('click', removeMenu);
    map.on('move', removeMenu);
    map.on('zoom', removeMenu);
});

// Long-press for mobile (triggers context menu)
let longPressTimer = null;
let longPressPoint = null;

map.getCanvas().addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;

    const touch = e.touches[0];
    longPressPoint = { x: touch.clientX, y: touch.clientY };

    longPressTimer = setTimeout(() => {
        // Trigger context menu at touch location
        const rect = map.getCanvas().getBoundingClientRect();
        const point = new maplibregl.Point(
            touch.clientX - rect.left,
            touch.clientY - rect.top
        );
        const lngLat = map.unproject(point);

        // Dispatch a synthetic contextmenu event
        map.fire('contextmenu', {
            lngLat: lngLat,
            point: point,
            originalEvent: e
        });
    }, 500);
}, { passive: true });

map.getCanvas().addEventListener('touchmove', (e) => {
    // Cancel if finger moves too much
    if (longPressTimer && longPressPoint) {
        const touch = e.touches[0];
        const dx = touch.clientX - longPressPoint.x;
        const dy = touch.clientY - longPressPoint.y;
        if (Math.sqrt(dx * dx + dy * dy) > 10) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    }
}, { passive: true });

map.getCanvas().addEventListener('touchend', () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
}, { passive: true });

document.getElementById('location-btn').addEventListener('click', toggleGeolocation);

// Lock Zoom functionality
let isZoomLocked = false;
document.getElementById('lock-zoom-btn').addEventListener('click', () => {
    isZoomLocked = !isZoomLocked;
    const lockBtn = document.getElementById('lock-zoom-btn');

    if (isZoomLocked) {
        // Disable zoom controls
        map.scrollZoom.disable();
        map.doubleClickZoom.disable();
        map.touchZoomRotate.disableZoom();
        lockBtn.classList.add('active');
        lockBtn.title = 'Unlock zoom';
    } else {
        // Enable zoom controls
        map.scrollZoom.enable();
        map.doubleClickZoom.enable();
        map.touchZoomRotate.enableZoom();
        lockBtn.classList.remove('active');
        lockBtn.title = 'Lock zoom';
    }
});

// ============================================
// Data Loading & Processing
// ============================================

function setLoadingText(text) {
    const el = document.getElementById('loading-text');
    if (el) el.textContent = text;
}

/**
 * Load GeoTIFF with fallback for Safari range request issues
 */
async function loadTiffWithFallback(url) {
    // Try COG range request first
    try {
        return await GeoTIFF.fromUrl(url);
    } catch (error) {
        console.warn('COG range request failed, loading full file:', error.message);
    }

    // Fallback: fetch entire file
    setLoadingText('Loading bathymetry...');
    const response = await fetch(url);
    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    return await GeoTIFF.fromArrayBuffer(arrayBuffer);
}

async function loadBathymetry() {
    try {
        setLoadingText('Connecting to bathymetry data...');

        // Safari can fail range requests - try COG first, fallback to full download
        state.tiff = await loadTiffWithFallback(CONFIG.COG_URL);
        state.image = await state.tiff.getImage();

        const width = state.image.getWidth();
        const height = state.image.getHeight();

        // Calculate mercator bbox from lat/lng bounds for accurate pixel-to-coord mapping
        const [minX, minY] = lngLatToMercator(CONFIG.BOUNDS.west, CONFIG.BOUNDS.south);
        const [maxX, maxY] = lngLatToMercator(CONFIG.BOUNDS.east, CONFIG.BOUNDS.north);

        state.bounds = {
            ...CONFIG.BOUNDS,
            mercatorBbox: [minX, minY, maxX, maxY],
            width,
            height
        };

        // ----------------------------------------------------
        // Stage 1: Fast Preview (using COG overviews)
        // ----------------------------------------------------
        setLoadingText('Loading preview...');
        const previewWidth = Math.round(width / 8); // ~300px width (Level 3 overview)
        const previewHeight = Math.round(height / 8);

        // Read low-res data
        const previewData = await state.image.readRasters({
            width: previewWidth,
            height: previewHeight,
            resampleMethod: 'nearest'
        });

        // Render preview immediately
        state.rasterData = previewData; // Temporary store
        state.renderedWidth = previewWidth;
        state.renderedHeight = previewHeight;
        renderBathymetry(previewWidth, previewHeight);

        // Fit map bounds immediately so user sees something
        fitMapBounds();

        // ----------------------------------------------------
        // Stage 2: Full Resolution
        // ----------------------------------------------------
        // Update small status indicator
        setLoadingText('Refining detail...');

        // Calculate optimal display resolution
        const targetWidth = Math.min(width, CONFIG.MAX_RENDER_WIDTH);
        const targetHeight = Math.round(height * (targetWidth / width));

        // Read full-res data
        const fullData = await state.image.readRasters({
            width: targetWidth,
            height: targetHeight,
            resampleMethod: 'bilinear'
        });

        // Render full quality
        state.rasterData = fullData; // Update store
        state.renderedWidth = targetWidth;
        state.renderedHeight = targetHeight;

        // Brief delay to allow UI thread to process
        await new Promise(resolve => setTimeout(resolve, 50));
        renderBathymetry(targetWidth, targetHeight);

        // Hide status pill when done
        document.getElementById('loading').classList.add('hidden');

    } catch (error) {
        console.error('Failed to load:', error);
        setLoadingText('Failed to load data');
    }
}

function fitMapBounds() {
    const mapWidth = map.getContainer().clientWidth;
    const padding = Math.round(mapWidth * 0.075); // 7.5% padding = 85% fill

    // Use center latitude for both corners to fit only horizontal extent
    // This allows vertical overflow while ensuring 85% horizontal fill
    const centerLat = (state.bounds.south + state.bounds.north) / 2;

    map.fitBounds(
        [[state.bounds.west, centerLat], [state.bounds.east, centerLat]],
        {
            padding: { top: 0, bottom: 0, left: padding, right: padding },
            duration: 2000 // Smooth zoom-in animation
        }
    );
}

// ============================================
// Rendering
// ============================================

function renderBathymetry(width, height) {
    const data = state.rasterData[0];
    const { mercatorBbox } = state.bounds;

    // Calculate cell size in meters (Mercator units)
    const cellSizeX = (mercatorBbox[2] - mercatorBbox[0]) / width;
    const cellSizeY = (mercatorBbox[3] - mercatorBbox[1]) / height;
    const cellSize = (cellSizeX + cellSizeY) / 2;

    const hillshade = computeHillshade(data, width, height, cellSize);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);

    for (let i = 0; i < width * height; i++) {
        const depth = data[i] / 100; // Scale Int16 back to meters
        const px = i * 4;

        if (depth < CONFIG.DEPTH_MIN || depth > CONFIG.DEPTH_MAX || isNaN(depth)) {
            imageData.data[px + 3] = 0;
            continue;
        }

        const color = getColorForDepth(depth);
        const shade = hillshade[i];

        imageData.data[px] = Math.round(color[0] * shade);
        imageData.data[px + 1] = Math.round(color[1] * shade);
        imageData.data[px + 2] = Math.round(color[2] * shade);
        imageData.data[px + 3] = 220;
    }

    ctx.putImageData(imageData, 0, 0);

    const bitmapLayer = new deck.BitmapLayer({
        id: 'bathymetry',
        // Native LngLat bounds are sufficient because images are axis-aligned
        bounds: [state.bounds.west, state.bounds.south, state.bounds.east, state.bounds.north],
        image: canvas,
        opacity: 0.9,
        beforeId: 'route-line-layer' // Render beneath the route line
    });

    state.bathymetryLayer = bitmapLayer;

    if (!state.deckOverlay) {
        state.deckOverlay = new deck.MapboxOverlay({
            interleaved: true,
            layers: [bitmapLayer]
        });
        map.addControl(state.deckOverlay);
    } else {
        state.deckOverlay.setProps({
            layers: [bitmapLayer]
        });
    }
    // Route line z-order handled by beforeId on the BitmapLayer
}

// ============================================
// Utilities
// ============================================

// Fast synchronous depth lookup using cached raster data (for profile generation)
function queryDepthFast(lng, lat) {
    if (!state.rasterData || !state.bounds || !state.renderedWidth) return null;

    const data = state.rasterData[0];
    const width = state.renderedWidth;
    const height = state.renderedHeight;
    const { mercatorBbox } = state.bounds;

    // Convert to Mercator
    const [mx, my] = lngLatToMercator(lng, lat);

    // Check bounds
    if (mx < mercatorBbox[0] || mx > mercatorBbox[2] || my < mercatorBbox[1] || my > mercatorBbox[3]) {
        return null;
    }

    // Map to pixel in rendered dimensions
    const pixelX = Math.floor((mx - mercatorBbox[0]) / (mercatorBbox[2] - mercatorBbox[0]) * width);
    const pixelY = Math.floor((mercatorBbox[3] - my) / (mercatorBbox[3] - mercatorBbox[1]) * height);

    if (pixelX < 0 || pixelX >= width || pixelY < 0 || pixelY >= height) return null;

    const idx = pixelY * width + pixelX;
    if (idx < 0 || idx >= data.length) return null;

    const depth = data[idx] / 100; // Scale Int16 to meters
    return (depth > CONFIG.DEPTH_MIN && depth < CONFIG.DEPTH_MAX) ? depth : null;
}

// Async version for single-point queries (e.g., click popup)
async function queryDepth(lng, lat) {
    // Use fast cached version if available
    if (state.rasterData) {
        return queryDepthFast(lng, lat);
    }

    // Fallback to reading from image
    const { bounds, image } = state;
    if (!image || !bounds) return null;

    const [mx, my] = lngLatToMercator(lng, lat);
    const { mercatorBbox } = bounds;

    if (mx < mercatorBbox[0] || mx > mercatorBbox[2] || my < mercatorBbox[1] || my > mercatorBbox[3]) {
        return null;
    }

    const pixelX = Math.floor((mx - mercatorBbox[0]) / (mercatorBbox[2] - mercatorBbox[0]) * bounds.width);
    const pixelY = Math.floor((mercatorBbox[3] - my) / (mercatorBbox[3] - mercatorBbox[1]) * bounds.height);

    if (pixelX < 0 || pixelX >= bounds.width || pixelY < 0 || pixelY >= bounds.height) return null;

    try {
        const value = await image.readRasters({ window: [pixelX, pixelY, pixelX + 1, pixelY + 1] });
        const depth = value[0][0] / 100;
        return (depth > CONFIG.DEPTH_MIN && depth < CONFIG.DEPTH_MAX) ? depth : null;
    } catch {
        return null;
    }
}

function getColorForDepth(depth) {
    if (depth === null || isNaN(depth)) return [0, 0, 0, 0];
    const clamped = Math.max(CONFIG.DEPTH_MIN, Math.min(CONFIG.DEPTH_MAX, depth));
    const stops = CONFIG.COLOR_STOPS;

    for (let i = 0; i < stops.length - 1; i++) {
        if (clamped >= stops[i + 1].depth) {
            const t = (clamped - stops[i].depth) / (stops[i + 1].depth - stops[i].depth);
            const c1 = stops[i].color;
            const c2 = stops[i + 1].color;
            return [
                Math.round(c1[0] + t * (c2[0] - c1[0])),
                Math.round(c1[1] + t * (c2[1] - c1[1])),
                Math.round(c1[2] + t * (c2[2] - c1[2])),
                255
            ];
        }
    }
    return [...stops[stops.length - 1].color, 255];
}

function computeHillshade(data, width, height, cellSize) {
    const hillshade = new Float32Array(width * height);
    const azimuthRad = CONFIG.SUN_AZIMUTH * Math.PI / 180;
    const altitudeRad = CONFIG.SUN_ALTITUDE * Math.PI / 180;
    const sunX = Math.sin(azimuthRad) * Math.cos(altitudeRad);
    const sunY = Math.cos(azimuthRad) * Math.cos(altitudeRad);
    const sunZ = Math.sin(altitudeRad);

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const idx = y * width + x;
            // Get value and scale it back from Int16 (x100) to meters
            const z = (data[idx] / 100) * state.exaggeration;

            // Simple logic: if neighbors are nodata, flatten
            if (z < -1000) { hillshade[idx] = 0; continue; }

            // Neighbors
            const zL = (data[idx - 1] / 100) * state.exaggeration;
            const zR = (data[idx + 1] / 100) * state.exaggeration;
            const zU = (data[(y - 1) * width + x] / 100) * state.exaggeration;
            const zD = (data[(y + 1) * width + x] / 100) * state.exaggeration;

            if (zL < -1000 || zR < -1000 || zU < -1000 || zD < -1000) {
                hillshade[idx] = 1; continue;
            }

            const dzdx = (zR - zL) / (2 * cellSize);
            const dzdy = (zD - zU) / (2 * cellSize);
            const shade = ((-dzdx * sunX - dzdy * sunY + sunZ) / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1));
            hillshade[idx] = Math.max(0, Math.min(1, shade * 0.5 + 0.5));
        }
    }
    return hillshade;
}

// ============================================
// UI Utils
// ============================================

function initializeLegend() {
    const stops = CONFIG.COLOR_STOPS.map(s => {
        const pct = ((-s.depth) / Math.abs(CONFIG.DEPTH_MIN)) * 100;
        return `rgb(${s.color.join(',')}) ${pct}%`;
    });
    document.getElementById('legend-gradient').style.background = `linear-gradient(to right, ${stops.join(', ')})`;
}

function formatCoordinates(lng, lat) {
    if (lng === undefined || lng === null || lat === undefined || lat === null) {
        return { gmaps: 'N/A', display: 'N/A' };
    }
    const gmaps = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    const latM = (Math.abs(lat) % 1) * 60;
    const lngM = (Math.abs(lng) % 1) * 60;
    const dm = `${Math.floor(Math.abs(lat))}° ${latM.toFixed(3)}' ${lat >= 0 ? 'N' : 'S'}, ${Math.floor(Math.abs(lng))}° ${lngM.toFixed(3)}' ${lng >= 0 ? 'E' : 'W'}`;
    return { gmaps, display: dm };
}

function updateCursorDepth(depth, lng, lat, labelOverride = null) {
    const valueEl = document.getElementById('cursor-depth-value');
    const coordsEl = document.getElementById('cursor-coords');
    const labelEl = document.getElementById('cursor-depth-label');

    // Update label if element exists
    if (labelEl) {
        labelEl.textContent = labelOverride || 'At cursor:';
        labelEl.style.color = labelOverride ? '#eab308' : ''; // Yellow when on profile
    }

    if (depth !== null && depth !== undefined) {
        const r = formatCoordinates(lng, lat);
        valueEl.textContent = depth.toFixed(1);
        coordsEl.innerHTML = `<span class="copyable" title="Copy decimal">${r.gmaps}</span><br><span class="copyable" title="Copy DM">${r.display}</span>`;
    } else {
        valueEl.textContent = '--';
        coordsEl.textContent = '--';
    }
}

function showClickPopup(depth, lng, lat) {
    const r = formatCoordinates(lng, lat);
    if (state.clickMarker) state.clickMarker.remove();
    if (state.clickPopup) state.clickPopup.remove();

    const el = document.createElement('div');
    el.className = 'click-marker';
    state.clickMarker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);

    state.clickPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, className: 'depth-popup', offset: 12 })
        .setLngLat([lng, lat])
        .setHTML(`
            <div class="popup-depth">${depth.toFixed(1)}<span class="popup-unit">m</span></div>
            <div class="popup-coords copyable">${r.gmaps}</div>
            <div class="popup-coords-dm copyable">${r.display}</div>
            <button class="popup-share-btn" data-lat="${lat}" data-lng="${lng}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                </svg>
                <span>Copy Link</span>
            </button>
        `)
        .addTo(map);

    // Attach share button handler
    const shareBtn = document.querySelector('.popup-share-btn');
    if (shareBtn) {
        shareBtn.addEventListener('click', () => {
            const url = `${window.location.origin}${window.location.pathname}#${lat.toFixed(6)},${lng.toFixed(6)}`;
            navigator.clipboard.writeText(url);
            shareBtn.querySelector('span').textContent = 'Copied!';
            setTimeout(() => {
                shareBtn.querySelector('span').textContent = 'Copy Link';
            }, 2000);
        });
    }

    state.clickPopup.on('close', () => {
        if (state.clickMarker) state.clickMarker.remove();
        state.clickMarker = null;
    });
}

function toggleGeolocation() {
    if (state.isTracking) {
        // Stop tracking
        navigator.geolocation.clearWatch(state.watchId);
        window.removeEventListener('deviceorientation', handleDeviceOrientation);
        state.isTracking = false;
        state.deviceHeading = null;
        document.getElementById('location-btn').classList.remove('active');
        if (state.userLocationMarker) state.userLocationMarker.remove();
        state.userLocationMarker = null;
    } else {
        // Start tracking
        if (!navigator.geolocation) return alert('No Geolocation support');
        document.getElementById('location-btn').classList.add('active');
        state.isTracking = true;

        // Request device orientation permission (required on iOS 13+)
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
            DeviceOrientationEvent.requestPermission()
                .then(response => {
                    if (response === 'granted') {
                        window.addEventListener('deviceorientation', handleDeviceOrientation);
                    }
                })
                .catch(console.error);
        } else {
            // Non-iOS or older iOS - just add listener
            window.addEventListener('deviceorientation', handleDeviceOrientation);
        }

        state.watchId = navigator.geolocation.watchPosition(updateUserLocation,
            () => { alert('Locate failed'); toggleGeolocation(); },
            { enableHighAccuracy: true }
        );
    }
}

function handleDeviceOrientation(event) {
    // iOS uses webkitCompassHeading (degrees from true north)
    // Android uses alpha (degrees from arbitrary reference, needs adjustment)
    if (event.webkitCompassHeading !== undefined) {
        state.deviceHeading = event.webkitCompassHeading;
    } else if (event.alpha !== null) {
        // Android: alpha is rotation around z-axis, 0-360
        state.deviceHeading = 360 - event.alpha;
    }
    updateHeadingDisplay();
}

function updateHeadingDisplay() {
    const hEl = document.querySelector('.location-heading');
    if (hEl && state.deviceHeading !== null && state.deviceHeading !== undefined) {
        hEl.style.transform = `translate(-50%, -50%) rotate(${state.deviceHeading - 90}deg)`;
        hEl.style.display = 'block';
    }
}

function updateUserLocation(pos) {
    const { longitude, latitude, heading } = pos.coords;
    if (!state.userLocationMarker) {
        const el = document.createElement('div');
        el.className = 'user-location-marker';
        el.innerHTML = '<div class="location-heading"></div><div class="location-dot"></div>';
        state.userLocationMarker = new maplibregl.Marker({ element: el }).setLngLat([longitude, latitude]).addTo(map);
    } else {
        state.userLocationMarker.setLngLat([longitude, latitude]);
    }

    // Use device compass heading if available, otherwise fall back to GPS heading
    const hEl = document.querySelector('.location-heading');
    if (hEl) {
        if (state.deviceHeading !== null && state.deviceHeading !== undefined) {
            // Device orientation is handling heading display
        } else if (heading !== null && heading !== undefined) {
            // Fall back to GPS heading (only works when moving)
            hEl.style.transform = `translate(-50%, -50%) rotate(${heading - 90}deg)`;
            hEl.style.display = 'block';
        } else {
            hEl.style.display = 'none';
        }
    }
    map.flyTo({ center: [longitude, latitude], zoom: 14 });
}

// ============================================
// Data Structures
// ============================================

class MinHeap {
    constructor() {
        this.heap = [];
    }

    push(node) {
        this.heap.push(node);
        this.bubbleUp(this.heap.length - 1);
    }

    pop() {
        if (this.heap.length === 0) return null;
        const min = this.heap[0];
        const last = this.heap.pop();
        if (this.heap.length > 0) {
            this.heap[0] = last;
            this.bubbleDown(0);
        }
        return min;
    }

    isEmpty() {
        return this.heap.length === 0;
    }

    // Deterministic comparison: compare f-score, then h-score (heuristic) as tie-breaker
    compare(a, b) {
        if (a.f !== b.f) return a.f < b.f;
        // Tie-breaker: prefer node closer to goal (lower h)
        return a.h < b.h;
    }

    bubbleUp(index) {
        while (index > 0) {
            const parentIndex = Math.floor((index - 1) / 2);
            if (!this.compare(this.heap[index], this.heap[parentIndex])) break;
            [this.heap[parentIndex], this.heap[index]] = [this.heap[index], this.heap[parentIndex]];
            index = parentIndex;
        }
    }

    bubbleDown(index) {
        while (true) {
            let leftChild = 2 * index + 1;
            let rightChild = 2 * index + 2;
            let smallest = index;

            if (leftChild < this.heap.length && this.compare(this.heap[leftChild], this.heap[smallest])) {
                smallest = leftChild;
            }
            if (rightChild < this.heap.length && this.compare(this.heap[rightChild], this.heap[smallest])) {
                smallest = rightChild;
            }

            if (smallest === index) break;

            [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
            index = smallest;
        }
    }
}

// ============================================
// Route Profiler
// ============================================

class RouteProfiler {
    constructor(points = []) {
        this.isActive = false;
        this.points = points; // User-defined waypoints [lng, lat]
        this.markers = [];
        this.legData = []; // [{ type: 'bearing', path: [...] }, ...] - Length of points - 1
        this.suggestedPaths = []; // Contour suggestions for each leg
        this.currentProfileData = null;
        this.chart = null;
        this.speed = 25; // m/min - safe swimming speed with fins (~1.5 km/h)
        this.speedUnit = 'mmin';
        this.waypointDists = [];
        this.editMode = true; // Default to edit mode
        this.hoverMarker = null;
        this.hoverDistance = null; // For chart sync
        this.contourTolerance = 1.0; // +/- 1 meter default
        this.contourTargetDepth = null;
        this.profileSampleMarkers = []; // Visualization of sample points along route
        this.isFinished = false; // Track if route has been completed
        this.isManualDragging = false; // Track manual drag state for midpoint insertion
        this.hoveredMarkerIndex = null; // Track which waypoint is being hovered for delete

        this.initUI();

        // Global keyboard listener for delete
        document.addEventListener('keydown', (e) => {
            if ((e.key === 'Backspace' || e.key === 'Delete') && this.hoveredMarkerIndex !== null && this.editMode) {
                e.preventDefault();
                this.deleteWaypoint(this.hoveredMarkerIndex);
            }
        });

        // Initialize leg data for any existing points
        this.initializeLegData();

        // Defer marker/line build until map is ready if needed, 
        // but typically instance created on load.
        // We'll call these, but safeguards in methods should handle empty state.
        this.rebuildMarkers();
        this.updateLineLayer();

        if (this.points.length >= 2) {
            // Don't generate profile in constructor - wait for user to complete
        }
    }

    initializeLegData() {
        this.legData = [];
        for (let i = 0; i < this.points.length - 1; i++) {
            this.legData.push({
                type: 'bearing',
                path: [this.points[i], this.points[i + 1]],
                bearingPath: [this.points[i], this.points[i + 1]],
                hasContour: false
            });
        }
    }

    /**
     * Convert speed to meters per minute (single source of truth for all time calculations)
     * CRITICAL: This function must be used consistently everywhere for safety
     * @returns {number} Speed in meters per minute
     */
    getSpeedMetersPerMin() {
        if (this.speedUnit === 'mmin') {
            return this.speed; // Already in m/min
        } else if (this.speedUnit === 'ms') {
            return this.speed * 60; // m/s to m/min (exact)
        } else {
            // knots: 1 knot = 1 nautical mile per hour
            // 1 nautical mile = 1852 meters (exact, by international definition)
            // 1 hour = 60 minutes
            return this.speed * (1852 / 60); // = 30.86666... m/min (exact)
        }
    }

    initUI() {
        // Elements
        this.startOverlay = document.getElementById('start-overlay');
        this.startBtn = document.getElementById('start-btn');
        this.finishBtn = document.getElementById('finish-btn');
        this.shelf = document.getElementById('shelf');
        this.speedInput = document.getElementById('speed-input');
        this.unitSelect = document.getElementById('speed-unit');
        this.distUnitSelect = document.getElementById('dist-unit');

        // Listeners for Start Button
        this.startBtn.addEventListener('click', () => {
            if (this.isActive) {
                this.finishRoute();
            } else {
                this.startDrawing();
            }
        });

        // Listeners for Finish Button (still useful as backup or for consistency)
        this.finishBtn.addEventListener('click', () => this.finishRoute());

        // Listeners for Clear Button
        this.clearBtn = document.getElementById('clear-btn');
        this.clearBtn.addEventListener('click', () => {
            // Skip confirmation if only 0-1 points
            if (this.points.length <= 1) {
                this.stopDrawing();
                return;
            }
            if (confirm('Clear the current route?')) {
                this.stopDrawing();
            }
        });

        // Listeners for Controls
        this.speedInput.addEventListener('input', (e) => {
            this.speed = parseFloat(e.target.value) || 1;
            this.updateChartTimeLabels();
            this.updateSpeedDescription();
            if (this.currentProfileData && this.waypointDists) {
                this.updateWaypointTable(this.currentProfileData, this.waypointDists);
            }
        });

        this.unitSelect.addEventListener('change', (e) => {
            this.speedUnit = e.target.value;
            this.updateChartTimeLabels();
            this.updateSpeedDescription();
            if (this.currentProfileData && this.waypointDists) {
                this.updateWaypointTable(this.currentProfileData, this.waypointDists);
            }
        });

        // Initial speed description
        this.updateSpeedDescription();

        // Distance unit change listener - sync both dropdowns
        const distUnitChart = document.getElementById('dist-unit');
        const distUnitSidebar = document.getElementById('dist-unit-sidebar');

        const handleDistUnitChange = (sourceEl, targetEl) => {
            if (targetEl) targetEl.value = sourceEl.value;
            if (this.currentProfileData && this.waypointDists) {
                this.updateWaypointTable(this.currentProfileData, this.waypointDists);
                this.updateChart();
            }
        };

        if (distUnitChart) {
            distUnitChart.addEventListener('change', () => handleDistUnitChange(distUnitChart, distUnitSidebar));
        }
        if (distUnitSidebar) {
            distUnitSidebar.addEventListener('change', () => handleDistUnitChange(distUnitSidebar, distUnitChart));
        }

        // Map Click for Drawing
        map.on('click', (e) => {
            if (!this.isActive) return;
            this.addPoint(e.lngLat);
        });

        // Escape Key to Cancel
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isActive) {
                this.stopDrawing(true); // Cancel without saving, don't auto-restart
            }
        });

        // Edit Toggle Button
        const editBtn = document.getElementById('edit-toggle-btn');
        if (editBtn) {
            editBtn.addEventListener('click', () => {
                this.toggleEditMode();
            });
        }

        // Start Profile Link (in empty state) - dynamic text
        this.startLink = document.getElementById('start-profile-link');
        this.emptyState = document.getElementById('empty-state');
        if (this.startLink) {
            this.startLink.addEventListener('click', (e) => {
                e.preventDefault();
                if (this.isActive) {
                    this.finishRoute();
                } else {
                    this.startDrawing();
                }
            });
        }

        // Set initial edit button state (since editMode is true by default)
        const editBtnInit = document.getElementById('edit-toggle-btn');
        if (editBtnInit) {
            editBtnInit.classList.add('active');
            const label = editBtnInit.querySelector('.edit-label');
            if (label) label.textContent = 'Editing';
        }

        // Contour Assist checkbox listener
        const contourAssistCheckbox = document.getElementById('contour-assist-checkbox');
        if (contourAssistCheckbox) {
            contourAssistCheckbox.addEventListener('change', async (e) => {
                if (e.target.checked && this.points.length >= 2) {
                    // Calculate contour suggestions for all legs when enabled
                    for (let i = 0; i < this.points.length; i++) {
                        await this.calculateContourSuggestions(i);
                    }
                } else if (!e.target.checked) {
                    // Hide all suggestions when disabled
                    this.hideAllSuggestedPaths();
                }
            });
        }

        // Share button listener
        const shareBtn = document.getElementById('share-btn');
        if (shareBtn) {
            shareBtn.addEventListener('click', () => this.showShareModal());
        }

        // Mid-line insertion marker
        this.midpointMarker = null;
        this.pendingInsertSegment = null;

        // Detect hover near route line for mid-line insertion and chart sync
        map.on('mousemove', (e) => {
            // Check for manual dragging
            if (this.isManualDragging) {
                this.hideMidpointMarker();
                this.syncChartHover(null); // Ensure chart sync is cleared
                return;
            }

            // Only proceed if we have at least 2 points
            if (this.points.length < 2) {
                this.hideMidpointMarker();
                this.syncChartHover(null);
                return;
            }

            // Find closest segment and distance
            const { segmentIndex, distance, t } = this.findClosestSegment(e.lngLat);

            // Midpoint Marker Logic (Only in Edit Mode, not on contour legs)
            const leg = this.legData[segmentIndex];
            const isContourLeg = leg && leg.type === 'contour';
            if (this.editMode && distance < 40 && segmentIndex !== null && !isContourLeg) {
                // Place marker at segment midpoint, not cursor position
                const p1 = this.points[segmentIndex];
                const p2 = this.points[segmentIndex + 1];
                const midpoint = { lng: (p1[0] + p2[0]) / 2, lat: (p1[1] + p2[1]) / 2 };
                this.showMidpointMarker(midpoint, segmentIndex);
            } else {
                this.hideMidpointMarker();
            }

            // Chart Sync Logic (Always active if profile exists)
            if (distance < 30 && segmentIndex !== null && this.currentProfileData) {
                // Calculate total distance to the cursor point on the line
                let distSum = 0;
                for (let i = 0; i < segmentIndex; i++) {
                    distSum += this.haversineDistance(this.points[i], this.points[i + 1]);
                }
                const segLen = this.haversineDistance(this.points[segmentIndex], this.points[segmentIndex + 1]);
                const currentDist = distSum + (segLen * (t || 0));

                this.syncChartHover(currentDist);
            } else {
                this.syncChartHover(null);
            }
        });
    }

    syncChartHover(distanceM) {
        if (!this.chart || !this.currentProfileData) return;

        const data = this.chart.data?.datasets?.[0]?.data;
        if (!data || data.length === 0) return;

        if (distanceM === null) {
            this.hoverDistance = null; // Clear line
            this.chart.setActiveElements([], { x: 0, y: 0 });
            this.chart.update('none'); // Skip animation to avoid profile "disappearing"
            return;
        }

        // Find closest data point
        let closestIdx = 0;
        let minDiff = Infinity;

        // Binary search optional, linear scan fine for small datasets (~150 points)
        for (let i = 0; i < data.length; i++) {
            const diff = Math.abs(data[i].x - distanceM);
            if (diff < minDiff) {
                minDiff = diff;
                closestIdx = i;
            }
        }

        // Snap the vertical line to the exact data point location
        this.hoverDistance = data[closestIdx].x;

        // Activate tooltip
        const meta = this.chart.getDatasetMeta(0);
        const rect = this.chart.canvas.getBoundingClientRect();
        const point = meta.data[closestIdx];

        if (point) {
            // Trigger tooltip AND highlight the point on the chart
            const activeElements = [{ datasetIndex: 0, index: closestIdx }];
            this.chart.setActiveElements(activeElements);
            this.chart.tooltip.setActiveElements(activeElements, { x: point.x, y: point.y });
            this.chart.update('none'); // Skip animation to avoid profile flickering

            // Update top bar to show profile depth (get data from currentProfileData, not chart element)
            const profilePoint = this.currentProfileData[closestIdx];
            if (profilePoint) {
                updateCursorDepth(profilePoint.depth, profilePoint.lng, profilePoint.lat, 'On Profile:');
            }
        }
    }

    findClosestSegment(lngLat) {
        const point = map.project([lngLat.lng, lngLat.lat]);
        let minDist = Infinity;
        let closestPoint = null;
        let segmentIndex = null;
        let closestT = 0;

        for (let i = 0; i < this.points.length - 1; i++) {
            const p1 = map.project(this.points[i]);
            const p2 = map.project(this.points[i + 1]);

            // Find closest point on segment
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const lenSq = dx * dx + dy * dy;

            let t = 0;
            if (lenSq > 0) {
                t = Math.max(0, Math.min(1, ((point.x - p1.x) * dx + (point.y - p1.y) * dy) / lenSq));
            }

            const closest = { x: p1.x + t * dx, y: p1.y + t * dy };
            const dist = Math.sqrt((point.x - closest.x) ** 2 + (point.y - closest.y) ** 2);

            // Always find the truly closest segment for tight hover behavior
            if (dist < minDist) {
                minDist = dist;
                closestPoint = map.unproject([closest.x, closest.y]);
                segmentIndex = i;
                closestT = t;
            }
        }

        return { segmentIndex, closestPoint, distance: minDist, t: closestT };
    }

    showMidpointMarker(lngLat, segmentIndex) {
        if (!this.midpointMarker) {
            const el = document.createElement('div');
            el.className = 'midpoint-marker';
            el.innerHTML = '+';

            // Handle both mouse and touch for insertion
            const handleInsert = (e) => {
                e.stopPropagation();
                e.preventDefault(); // Prevent map pan

                // Insert point (skip profile generation for now)
                const newIndex = segmentIndex + 1;
                this.insertWaypointAtSegment(this.pendingInsertSegment, true);

                // Start dragging the new point immediately
                this.startManualDrag(newIndex);
            };

            el.addEventListener('mousedown', handleInsert);
            el.addEventListener('touchstart', handleInsert, { passive: false });

            this.midpointMarker = new maplibregl.Marker({ element: el })
                .setLngLat(lngLat)
                .addTo(map);
        } else {
            this.midpointMarker.setLngLat(lngLat);
        }
        this.pendingInsertSegment = segmentIndex;
    }

    hideMidpointMarker() {
        if (this.midpointMarker) {
            this.midpointMarker.remove();
            this.midpointMarker = null;
        }
        this.pendingInsertSegment = null;
    }

    async insertWaypointAtSegment(segmentIndex, skipProfile = false) {
        if (segmentIndex === null || segmentIndex >= this.points.length - 1) return;

        const lngLat = this.midpointMarker.getLngLat();
        this.hideMidpointMarker();

        // Insert point at segmentIndex + 1
        const insertIndex = segmentIndex + 1;
        const newPoint = [lngLat.lng, lngLat.lat];
        this.points.splice(insertIndex, 0, newPoint);

        // Preserve leg data: split the affected leg, keep others intact
        const newLegData = [];
        for (let i = 0; i < this.legData.length; i++) {
            if (i === segmentIndex) {
                // Split this leg into two
                const startPoint = this.points[segmentIndex];
                const endPoint = this.points[insertIndex + 1];

                // First half: from original start to new point
                newLegData.push({
                    type: 'bearing', // Reset to bearing for the split legs
                    path: [startPoint, newPoint],
                    bearingPath: [startPoint, newPoint],
                    hasContour: false
                });

                // Second half: from new point to original end
                newLegData.push({
                    type: 'bearing',
                    path: [newPoint, endPoint],
                    bearingPath: [newPoint, endPoint],
                    hasContour: false
                });
            } else if (i > segmentIndex) {
                // Legs after the split: preserve type and contour paths
                const leg = this.legData[i];
                if (leg.type === 'contour' && leg.hasContour && leg.path && leg.path.length > 2) {
                    // For contour legs, preserve the full calculated path
                    // Only update bearingPath endpoints for reference
                    newLegData.push({
                        ...leg,
                        bearingPath: [this.points[i + 1], this.points[i + 2]]
                    });
                } else {
                    // For bearing legs, update path to new endpoints
                    newLegData.push({
                        ...leg,
                        path: [this.points[i + 1], this.points[i + 2]],
                        bearingPath: [this.points[i + 1], this.points[i + 2]]
                    });
                }
            } else {
                // Legs before the split: keep as-is
                newLegData.push(this.legData[i]);
            }
        }
        this.legData = newLegData;

        // Update suggested paths array (insert null for the new leg)
        this.suggestedPaths.splice(segmentIndex, 1, null, null);
        this.hideSuggestedPath(segmentIndex);
        this.hideSuggestedPath(segmentIndex + 1);

        // Recreate all markers to maintain correct indices
        this.rebuildMarkers();
        this.updateLineLayer();

        // Regenerate profile if route is finished (unless skipped)
        if (!skipProfile && this.isFinished) {
            await this.generateProfile();

            // Recalculate contour suggestions for all legs if Contour Assist is enabled
            const contourAssistEnabled = document.getElementById('contour-assist-checkbox')?.checked;
            if (contourAssistEnabled) {
                for (let i = 0; i < this.points.length; i++) {
                    await this.calculateContourSuggestions(i);
                }
            }
        }
    }

    startManualDrag(pointIndex) {
        this.isManualDragging = true;
        this.syncChartHover(null); // Clear chart sync

        // Explicitly remove hover marker to prevent orphans
        if (this.hoverMarker) {
            this.hoverMarker.remove();
            this.hoverMarker = null;
        }

        map.dragPan.disable();

        const onDragMove = (e) => {
            const lngLat = e.lngLat;
            this.points[pointIndex] = [lngLat.lng, lngLat.lat];

            // Update legData paths for connected legs (so updateLineLayer works correctly)
            if (pointIndex < this.points.length - 1 && this.legData[pointIndex]) {
                this.legData[pointIndex].path = [this.points[pointIndex], this.points[pointIndex + 1]];
            }
            if (pointIndex > 0 && this.legData[pointIndex - 1]) {
                this.legData[pointIndex - 1].path = [this.points[pointIndex - 1], this.points[pointIndex]];
            }

            this.updateLineLayer();
            if (this.markers[pointIndex]) {
                this.markers[pointIndex].setLngLat(lngLat);
            }
        };

        const onDragEnd = async () => {
            this.isManualDragging = false;
            map.dragPan.enable();
            map.off('mousemove', onDragMove);
            map.off('mouseup', onDragEnd);

            // Remember which adjacent legs were in contour mode
            const wasContourNext = pointIndex < this.points.length - 1 &&
                this.legData[pointIndex]?.type === 'contour';
            const wasContourPrev = pointIndex > 0 &&
                this.legData[pointIndex - 1]?.type === 'contour';

            // Reset adjacent legs to bearing (contour path is now invalid)
            if (pointIndex < this.points.length - 1) {
                this.legData[pointIndex] = {
                    type: 'bearing',
                    path: [this.points[pointIndex], this.points[pointIndex + 1]],
                    bearingPath: [this.points[pointIndex], this.points[pointIndex + 1]],
                    hasContour: false
                };
                this.suggestedPaths[pointIndex] = null;
                this.hideSuggestedPath(pointIndex);
            }
            if (pointIndex > 0) {
                const legIdx = pointIndex - 1;
                this.legData[legIdx] = {
                    type: 'bearing',
                    path: [this.points[legIdx], this.points[pointIndex]],
                    bearingPath: [this.points[legIdx], this.points[pointIndex]],
                    hasContour: false
                };
                this.suggestedPaths[legIdx] = null;
                this.hideSuggestedPath(legIdx);
            }

            this.updateLineLayer();

            // Generate profile first (it's visible), then contour suggestions in background
            if (this.currentProfileData) {
                await this.generateProfile();
            }

            // Defer contour calculations so they don't block the UI
            const contourAssistEnabled = document.getElementById('contour-assist-checkbox')?.checked;
            if (contourAssistEnabled) {
                setTimeout(async () => {
                    await this.calculateContourSuggestions(pointIndex);

                    // If leg was in contour mode and we found a new valid path, restore contour mode
                    if (wasContourNext && this.legData[pointIndex]?.hasContour) {
                        this.setLegType(pointIndex, 'contour');
                    }
                    if (wasContourPrev && this.legData[pointIndex - 1]?.hasContour) {
                        this.setLegType(pointIndex - 1, 'contour');
                    }

                    // Regenerate profile with restored contour paths
                    if (this.currentProfileData) {
                        await this.generateProfile();
                    }
                }, 0);
            }
        };

        map.on('mousemove', onDragMove);
        map.on('mouseup', onDragEnd);
    }

    toggleEditMode() {
        this.editMode = !this.editMode;

        const editBtn = document.getElementById('edit-toggle-btn');
        if (editBtn) {
            const label = editBtn.querySelector('.edit-label');
            if (this.editMode) {
                editBtn.classList.add('active');
                if (label) label.textContent = 'Editing';
            } else {
                editBtn.classList.remove('active');
                if (label) label.textContent = 'Edit';
                this.hideMidpointMarker();
            }
        }

        // Update marker draggability
        this.markers.forEach(marker => {
            const el = marker.getElement();
            if (this.editMode) {
                marker.setDraggable(true);
                el.style.cursor = 'grab';
            } else {
                marker.setDraggable(false);
                el.style.cursor = 'default';
            }
        });
    }

    rebuildMarkers() {
        // Remove all existing markers
        this.markers.forEach(m => m.remove());
        this.markers = [];

        // Recreate markers for all points
        this.points.forEach((point, index) => {
            const el = document.createElement('div');
            el.className = 'wp-marker';
            el.setAttribute('data-label', `WP${index}`);
            el.style.cursor = this.editMode ? 'grab' : 'default';

            const marker = new maplibregl.Marker({ element: el, draggable: this.editMode })
                .setLngLat(point)
                .addTo(map);

            marker._pointIndex = index;

            marker.on('dragstart', () => {
                this.syncChartHover(null); // Clear chart sync
                if (this.hoverMarker) {
                    this.hoverMarker.remove();
                    this.hoverMarker = null;
                }
            });

            marker.on('drag', async () => {
                const lngLat = marker.getLngLat();
                const idx = marker._pointIndex;

                // Update points array
                this.points[idx] = [lngLat.lng, lngLat.lat];

                // Update legData paths for connected legs (so updateLineLayer works correctly)
                if (idx < this.points.length - 1 && this.legData[idx]) {
                    this.legData[idx].path = [this.points[idx], this.points[idx + 1]];
                }
                if (idx > 0 && this.legData[idx - 1]) {
                    this.legData[idx - 1].path = [this.points[idx - 1], this.points[idx]];
                }

                this.updateLineLayer();

                // Redundant cleanup just in case
                if (this.hoverMarker) {
                    this.hoverMarker.remove();
                    this.hoverMarker = null;
                }

                // Contour Assist: Show depth contours during drag
                const contourAssistEnabled = document.getElementById('contour-assist-checkbox')?.checked;
                if (contourAssistEnabled) {
                    const depth = await queryDepth(lngLat.lng, lngLat.lat);
                    if (depth !== null) {
                        await this.showContourHighlight(lngLat.lng, lngLat.lat, depth);
                    }
                }
            });
            marker.on('dragend', async () => {
                const lngLat = marker.getLngLat();
                const idx = marker._pointIndex;

                // Remember which adjacent legs were in contour mode
                const wasContourNext = idx < this.points.length - 1 &&
                    this.legData[idx]?.type === 'contour';
                const wasContourPrev = idx > 0 &&
                    this.legData[idx - 1]?.type === 'contour';

                // Now that drag is done, update point and leg data
                this.points[idx] = [lngLat.lng, lngLat.lat];

                // Reset adjacent legs (contour path is now invalid)
                if (idx < this.points.length - 1) {
                    this.legData[idx] = {
                        type: 'bearing',
                        path: [this.points[idx], this.points[idx + 1]],
                        bearingPath: [this.points[idx], this.points[idx + 1]],
                        hasContour: false
                    };
                    this.suggestedPaths[idx] = null;
                    this.hideSuggestedPath(idx);
                }
                if (idx > 0) {
                    const legIdx = idx - 1;
                    this.legData[legIdx] = {
                        type: 'bearing',
                        path: [this.points[legIdx], this.points[idx]],
                        bearingPath: [this.points[legIdx], this.points[idx]],
                        hasContour: false
                    };
                    this.suggestedPaths[legIdx] = null;
                    this.hideSuggestedPath(legIdx);
                }

                this.updateLineLayer();

                // Hide contour highlight when drag ends
                this.hideContourHighlight();

                // Generate profile first (it's visible)
                if (this.points.length >= 2 && this.currentProfileData) {
                    await this.generateProfile();
                }

                // Defer contour calculations so they don't block the UI
                const contourAssistEnabled = document.getElementById('contour-assist-checkbox')?.checked;
                if (contourAssistEnabled) {
                    setTimeout(async () => {
                        await this.calculateContourSuggestions(idx);

                        // If leg was in contour mode and we found a new valid path, restore contour mode
                        if (wasContourNext && this.legData[idx]?.hasContour) {
                            this.setLegType(idx, 'contour');
                        }
                        if (wasContourPrev && this.legData[idx - 1]?.hasContour) {
                            this.setLegType(idx - 1, 'contour');
                        }

                        // Regenerate profile with restored contour paths
                        if (this.currentProfileData) {
                            await this.generateProfile();
                        }
                    }, 0);
                }
            });

            // Hover tracking for delete
            el.addEventListener('mouseenter', () => {
                this.hoveredMarkerIndex = index;
                if (this.editMode) {
                    el.style.outline = '2px solid #dc2626';
                    el.title = 'Press Backspace or right-click to delete';
                }
            });

            el.addEventListener('mouseleave', () => {
                this.hoveredMarkerIndex = null;
                el.style.outline = '';
                el.title = '';
            });

            // Right-click to delete
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.editMode) {
                    this.deleteWaypoint(index);
                }
            });

            // Long press to show context menu (mobile)
            let longPressTimer = null;
            let touchStartPos = null;
            const LONG_PRESS_DURATION = 600; // ms
            const TOUCH_MOVE_THRESHOLD = 10; // pixels

            el.addEventListener('touchstart', (e) => {
                const touch = e.touches[0];
                touchStartPos = {
                    x: touch.clientX,
                    y: touch.clientY
                };

                longPressTimer = setTimeout(async () => {
                    // Long press detected - show context menu with delete option
                    if (navigator.vibrate) {
                        navigator.vibrate(50); // Haptic feedback
                    }

                    // Remove any existing context menu
                    const existing = document.getElementById('context-menu');
                    if (existing) existing.remove();

                    // Get waypoint coordinates and depth
                    const waypointPos = point;
                    const coords = formatCoordinates(waypointPos[0], waypointPos[1]);
                    const depth = await queryDepth(waypointPos[0], waypointPos[1]);

                    // Create context menu
                    const menu = document.createElement('div');
                    menu.id = 'context-menu';
                    menu.className = 'context-menu';
                    menu.style.left = `${touch.clientX}px`;
                    menu.style.top = `${touch.clientY}px`;

                    // Menu Items - Delete first, then copy options
                    let menuHtml = `
                        <div class="context-menu-item" id="delete-waypoint" style="color: #dc2626;">
                            <span>Delete Waypoint</span>
                        </div>
                        <div class="context-menu-separator"></div>
                    `;

                    if (depth !== null) {
                        menuHtml += `
                            <div class="context-menu-item" id="copy-depth">
                                <span>Copy Depth</span>
                                <span style="opacity: 0.5; margin-left: 12px; font-size: 0.7rem;">${depth.toFixed(1)}m</span>
                            </div>
                            <div class="context-menu-separator"></div>
                        `;
                    }

                    menuHtml += `
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

                    menu.innerHTML = menuHtml;
                    document.body.appendChild(menu);

                    // Click Handlers
                    document.getElementById('delete-waypoint').addEventListener('click', () => {
                        this.deleteWaypoint(index);
                        menu.remove();
                    });

                    document.getElementById('copy-dd').addEventListener('click', () => {
                        navigator.clipboard.writeText(coords.gmaps);
                        menu.remove();
                    });

                    document.getElementById('copy-dm').addEventListener('click', () => {
                        navigator.clipboard.writeText(coords.display);
                        menu.remove();
                    });

                    document.getElementById('copy-link').addEventListener('click', () => {
                        const url = `${window.location.origin}${window.location.pathname}#${waypointPos[1].toFixed(6)},${waypointPos[0].toFixed(6)}`;
                        navigator.clipboard.writeText(url);
                        menu.remove();
                    });

                    if (depth !== null) {
                        document.getElementById('copy-depth').addEventListener('click', () => {
                            navigator.clipboard.writeText(`${depth.toFixed(1)}m`);
                            menu.remove();
                        });
                    }

                    // Close on map click/move
                    const removeMenu = () => {
                        menu.remove();
                        map.off('click', removeMenu);
                        map.off('move', removeMenu);
                    };
                    map.on('click', removeMenu);
                    map.on('move', removeMenu);
                    map.on('zoom', removeMenu);

                    longPressTimer = null;
                }, LONG_PRESS_DURATION);
            }, { passive: true });

            el.addEventListener('touchmove', (e) => {
                if (!longPressTimer || !touchStartPos) return;

                const touch = e.touches[0];
                const deltaX = Math.abs(touch.clientX - touchStartPos.x);
                const deltaY = Math.abs(touch.clientY - touchStartPos.y);

                // Cancel long press if moved too much
                if (deltaX > TOUCH_MOVE_THRESHOLD || deltaY > TOUCH_MOVE_THRESHOLD) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
            }, { passive: true });

            el.addEventListener('touchend', () => {
                if (longPressTimer) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
                touchStartPos = null;
            }, { passive: true });

            el.addEventListener('touchcancel', () => {
                if (longPressTimer) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
                touchStartPos = null;
            }, { passive: true });

            this.markers.push(marker);
        });
    }

    async deleteWaypoint(index) {
        if (index < 0 || index >= this.points.length) return;
        if (this.points.length <= 2) {
            // Can't delete if only 2 points left
            console.warn('Cannot delete: minimum 2 waypoints required');
            return;
        }

        // Clear hover state
        this.hoveredMarkerIndex = null;

        const numPoints = this.points.length;
        const isFirstPoint = index === 0;
        const isLastPoint = index === numPoints - 1;

        // Remove the point
        this.points.splice(index, 1);

        // Rebuild leg data based on which point was deleted
        if (isFirstPoint) {
            // Deleting first point: remove first leg, shift remaining legs
            this.legData = this.legData.slice(1).map((leg, i) => {
                if (leg.type === 'contour' && leg.hasContour && leg.path && leg.path.length > 2) {
                    // Preserve contour path, just update bearingPath
                    return {
                        ...leg,
                        bearingPath: [this.points[i], this.points[i + 1]]
                    };
                } else {
                    return {
                        ...leg,
                        path: [this.points[i], this.points[i + 1]],
                        bearingPath: [this.points[i], this.points[i + 1]]
                    };
                }
            });
        } else if (isLastPoint) {
            // Deleting last point: just remove the last leg
            this.legData = this.legData.slice(0, -1);
        } else {
            // Deleting middle point: merge two adjacent legs into one
            const newLegData = [];
            for (let i = 0; i < this.legData.length; i++) {
                if (i === index - 1) {
                    // This leg needs to connect to the point after the deleted one
                    newLegData.push({
                        type: 'bearing',
                        path: [this.points[index - 1], this.points[index]],
                        bearingPath: [this.points[index - 1], this.points[index]],
                        hasContour: false
                    });
                } else if (i === index) {
                    // Skip this leg (absorbed into the previous one)
                    continue;
                } else if (i > index) {
                    // Legs after: shift indices, preserve contour paths
                    const leg = this.legData[i];
                    const newIdx = i - 1;
                    if (leg.type === 'contour' && leg.hasContour && leg.path && leg.path.length > 2) {
                        newLegData.push({
                            ...leg,
                            bearingPath: [this.points[newIdx], this.points[newIdx + 1]]
                        });
                    } else {
                        newLegData.push({
                            ...leg,
                            path: [this.points[newIdx], this.points[newIdx + 1]],
                            bearingPath: [this.points[newIdx], this.points[newIdx + 1]]
                        });
                    }
                } else {
                    // Legs before: keep as-is
                    newLegData.push(this.legData[i]);
                }
            }
            this.legData = newLegData;
        }

        // Clean up suggested paths
        this.hideAllSuggestedPaths();
        this.suggestedPaths = this.suggestedPaths.filter((_, i) => i !== index && i !== index - 1);

        // Rebuild markers and update
        this.rebuildMarkers();
        this.updateLineLayer();

        // Regenerate profile if route is finished (same as finishRoute behavior)
        if (this.points.length >= 2 && this.isFinished) {
            await this.generateProfile();

            // Recalculate contour suggestions for all legs if Contour Assist is enabled
            const contourAssistEnabled = document.getElementById('contour-assist-checkbox')?.checked;
            if (contourAssistEnabled) {
                for (let i = 0; i < this.points.length; i++) {
                    await this.calculateContourSuggestions(i);
                }
            }
        } else if (this.points.length < 2) {
            // If we're down to less than 2 points, clear the table
            this.updateWaypointTable([], []);
        }

        // Explicitly sync mobile planner after deletion
        if (window.syncMobilePlanner) {
            window.syncMobilePlanner();
        }
    }

    startDrawing() {
        this.isActive = true;
        this.clearRoute();

        // Transform button to "Complete" state
        // Keep overlay technically visible for the button, but hide background to allow map click
        this.startOverlay.classList.remove('hidden');
        this.startOverlay.classList.add('background-hidden');

        this.startBtn.textContent = 'Complete Profile';
        this.startBtn.classList.add('complete-mode');

        // Update sidebar link text
        if (this.startLink) {
            this.startLink.textContent = 'Complete Profile';
        }

        this.finishBtn.classList.remove('hidden'); // Show Stop/Finish button in header too for clarity
        map.getCanvas().style.cursor = 'crosshair';
    }

    stopDrawing(skipAutoRestart = false) {
        this.isActive = false;
        this.isFinished = false;

        // Reset overlay state
        this.startOverlay.classList.remove('hidden');
        this.startOverlay.classList.remove('background-hidden');
        this.startOverlay.style.display = ''; // Clear any inline display:none

        this.startBtn.textContent = 'Start Profile';
        this.startBtn.classList.remove('complete-mode');

        // Reset start link text
        if (this.startLink) {
            this.startLink.textContent = 'Start Profile';
        }

        this.finishBtn.classList.add('hidden');
        map.getCanvas().style.cursor = '';
        this.clearRoute();

        // Automatically restart drawing mode after clearing (unless skipped)
        if (!skipAutoRestart) {
            setTimeout(() => {
                this.startDrawing();
            }, 100);
        }
    }

    addPoint(lngLat) {
        // Handle MapLibre LngLat object or array
        const lng = lngLat.lng !== undefined ? lngLat.lng : lngLat[0];
        const lat = lngLat.lat !== undefined ? lngLat.lat : lngLat[1];

        this.points.push([lng, lat]);

        // Add default bearing leg if we have >= 2 points
        if (this.points.length > 1) {
            const prev = this.points[this.points.length - 2];
            this.legData.push({
                type: 'bearing',
                path: [prev, [lng, lat]],
                bearingPath: [prev, [lng, lat]],
                hasContour: false
            });
        }

        this.rebuildMarkers();
        this.updateLineLayer();

        if (this.points.length >= 2 && this.currentProfileData) {
            this.generateProfile();
        }
    }

    updatePoint(index, lng, lat) {
        this.points[index] = [lng, lat];

        // Update connected legs to simple bearing (reset geometry)
        // Leg starting at this index (if exists)
        if (index < this.points.length - 1) {
            this.legData[index] = {
                type: 'bearing',
                path: [this.points[index], this.points[index + 1]],
                bearingPath: [this.points[index], this.points[index + 1]],
                hasContour: false
            };
            this.suggestedPaths[index] = null; // Clear suggestion
            this.hideSuggestedPath(index);
        }

        // Leg ending at this index (if exists)
        if (index > 0) {
            const legIdx = index - 1;
            this.legData[legIdx] = {
                type: 'bearing',
                path: [this.points[legIdx], this.points[index]],
                bearingPath: [this.points[legIdx], this.points[index]],
                hasContour: false
            };
            this.suggestedPaths[legIdx] = null; // Clear suggestion
            this.hideSuggestedPath(legIdx);
        }

        if (this.markers[index]) {
            this.markers[index].setLngLat([lng, lat]);
        }
        this.updateLineLayer(); // Updates route line geometry
        // Profile update is triggered by dragend usually, but called here for completeness if needed
    }

    removePoint(index) {
        this.points.splice(index, 1);

        // Rebuild leg data completely to be safe (easier than splicing legData)
        this.initializeLegData();
        this.hideAllSuggestedPaths();
        this.suggestedPaths = [];

        this.rebuildMarkers();
        this.updateLineLayer();

        if (this.points.length >= 2 && this.currentProfileData) {
            this.generateProfile();
        } else if (this.currentProfileData) {
            this.currentProfileData = null;
            this.updateWaypointTable([], []);
            this.clearProfileChart();
        }
    }


    async generateProfile() {
        if (!this.chart) this.initChart();

        if (this.points.length < 2) {
            this.updateWaypointTable([], []);
            return [];
        }

        // Construct full path from leg data
        let fullPath = [];
        let dists = [0];
        let totalDist = 0;

        for (let i = 0; i < this.legData.length; i++) {
            const leg = this.legData[i];
            // For the very first leg, include the start point
            // For subsequent legs, skip the first point to avoid duplicates
            const pathSegment = (i === 0) ? leg.path : leg.path.slice(1);
            fullPath = fullPath.concat(pathSegment);

            // Keep track of waypoint distances for the table
            let legDist = 0;
            for (let j = 0; j < leg.path.length - 1; j++) {
                legDist += this.haversineDistance(leg.path[j], leg.path[j + 1]);
            }
            totalDist += legDist;
            dists.push(totalDist);
        }

        this.waypointDists = dists;

        // Verify data integrity for safety-critical calculations
        if (dists.length !== this.points.length) {
            console.error(`[SAFETY] Distance array length mismatch: expected ${this.points.length}, got ${dists.length}`);
        }
        if (fullPath.length < this.points.length) {
            console.error(`[SAFETY] Path construction error: insufficient points for waypoints`);
        }

        // Verify path distance consistency (10cm tolerance)
        let totalPathLen = 0;
        for (let i = 0; i < fullPath.length - 1; i++) {
            totalPathLen += this.haversineDistance(fullPath[i], fullPath[i + 1]);
        }
        const finalDist = dists[dists.length - 1];
        if (Math.abs(totalPathLen - finalDist) > 0.1) {
            console.warn(`[SAFETY] Path distance mismatch: ${(totalPathLen - finalDist).toFixed(2)}m difference detected`);
        }

        // Progressive rendering: quick low-res first, then full resolution
        const lowResSamples = 30;
        const fullResSamples = 300;

        // Generate samples at a given resolution (synchronous using cached raster data)
        const generateSamples = (numSamples) => {
            const data = [];

            // Start point
            data.push({
                dist: 0,
                depth: queryDepthFast(fullPath[0][0], fullPath[0][1]),
                lng: fullPath[0][0],
                lat: fullPath[0][1]
            });

            let currentDist = 0;

            for (let i = 0; i < fullPath.length - 1; i++) {
                const p1 = fullPath[i];
                const p2 = fullPath[i + 1];
                const segLen = this.haversineDistance(p1, p2);

                const samplesInSeg = Math.max(1, Math.round((segLen / totalPathLen) * numSamples));

                for (let j = 1; j <= samplesInSeg; j++) {
                    const t = j / samplesInSeg;
                    const lng = p1[0] + (p2[0] - p1[0]) * t;
                    const lat = p1[1] + (p2[1] - p1[1]) * t;
                    const depth = queryDepthFast(lng, lat);

                    data.push({
                        dist: currentDist + (segLen * t),
                        depth: depth,
                        lng: lng,
                        lat: lat
                    });
                }
                currentDist += segLen;
            }

            // Ensure all waypoints appear at exact cumulative distances
            // Maintains consistency between waypoint table and profile visualization
            for (let wpIdx = 0; wpIdx < dists.length; wpIdx++) {
                const exactWpDist = dists[wpIdx];
                const wpCoords = this.points[wpIdx];

                // Find closest sample to this waypoint distance
                let closestIdx = -1;
                let minDiff = Infinity;
                for (let i = 0; i < data.length; i++) {
                    const diff = Math.abs(data[i].dist - exactWpDist);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closestIdx = i;
                    }
                }

                if (closestIdx >= 0 && minDiff < 1.0) {
                    // Sample within 1m - snap it to exact waypoint distance and coordinates
                    data[closestIdx].dist = exactWpDist;
                    data[closestIdx].lng = wpCoords[0];
                    data[closestIdx].lat = wpCoords[1];
                    data[closestIdx].depth = queryDepthFast(wpCoords[0], wpCoords[1]);
                } else {
                    // No sample within 1m - insert exact waypoint sample
                    const wpSample = {
                        dist: exactWpDist,
                        depth: queryDepthFast(wpCoords[0], wpCoords[1]),
                        lng: wpCoords[0],
                        lat: wpCoords[1]
                    };

                    // Find insertion point to maintain sorted order
                    let insertIdx = data.length;
                    for (let i = 0; i < data.length; i++) {
                        if (data[i].dist > exactWpDist) {
                            insertIdx = i;
                            break;
                        }
                    }
                    data.splice(insertIdx, 0, wpSample);
                }
            }

            return data;
        };

        // Quick low-res render first (instant with synchronous depth queries)
        const lowResData = generateSamples(lowResSamples);
        this.currentProfileData = lowResData;
        this.updateChart();
        this.updateWaypointTable(lowResData, dists);

        // Then full resolution (deferred to allow browser to paint low-res first)
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 16)));

        const fullResData = generateSamples(fullResSamples);
        this.currentProfileData = fullResData;
        this.updateChart();
        this.updateWaypointTable(fullResData, dists);

        // Render sample point markers along route
        this.renderProfileSampleMarkers(fullResData);

        return fullResData;
    }

    renderProfileSampleMarkers(profileData) {
        // Clear existing
        if (this.profileSampleMarkers) {
            this.profileSampleMarkers.forEach(m => m.remove());
        }
        this.profileSampleMarkers = [];

        // Sample points to avoid too many DOM elements
        const step = profileData.length > 100 ? 15 : 1;

        for (let i = 0; i < profileData.length; i += step) {
            const p = profileData[i];
            const el = document.createElement('div');
            el.className = 'debug-marker-dot';
            el.style.width = '4px';
            el.style.height = '4px';
            el.style.background = '#facc15'; // Yellow-400
            el.style.borderRadius = '50%';
            el.style.pointerEvents = 'none';

            const marker = new maplibregl.Marker({ element: el, offset: [0, 0] })
                .setLngLat([p.lng, p.lat])
                .addTo(map);

            this.profileSampleMarkers.push(marker);
        }
    }

    updateLineLayer() {
        if (this.points.length < 2) {
            const source = map.getSource('route-line');
            if (source) {
                source.setData({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: [] }
                });
            }
            if (map.getLayer('route-arrows')) {
                map.removeLayer('route-arrows');
            }
            return;
        }

        // Use legData for complex paths if available and valid, otherwise use simple points
        let allCoords = [];
        if (this.legData && this.legData.length === this.points.length - 1) {
            // Concatenate all leg paths
            this.legData.forEach((leg, i) => {
                const segment = (i === 0) ? leg.path : leg.path.slice(1);
                allCoords = allCoords.concat(segment);
            });
        } else {
            // Fallback to simple point-to-point line (for real-time drag updates)
            allCoords = this.points;
        }

        const geojson = {
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: allCoords
            }
        };

        // Source is created on map load, just update the data
        const source = map.getSource('route-line');
        if (source) {
            source.setData(geojson);
        }
        // Route line z-order handled by beforeId on deck.gl layers
    }

    async finishRoute() {
        if (this.points.length < 2) {
            this.stopDrawing(true); // Error case, don't auto-restart
            return;
        }

        this.isActive = false;
        this.isFinished = true; // Mark route as finished
        map.getCanvas().style.cursor = '';
        this.finishBtn.classList.add('hidden');

        // Hide overlay completely now so we can see the chart behind it
        this.startOverlay.classList.add('hidden');
        this.startOverlay.classList.remove('background-hidden');

        // Reset button for next time (when overlay becomes visible again via Clear)
        this.startBtn.textContent = 'Start Profile';
        this.startBtn.classList.remove('complete-mode');

        // Hide the sidebar empty state since we now have a profile
        if (this.emptyState) {
            this.emptyState.style.display = 'none';
        }

        // Generate Profile
        await this.generateProfile();

        // Calculate contour suggestions for all legs if Contour Assist is enabled
        const contourAssistEnabled = document.getElementById('contour-assist-checkbox')?.checked;
        if (contourAssistEnabled) {
            for (let i = 0; i < this.points.length; i++) {
                await this.calculateContourSuggestions(i);
            }
        }
    }

    // ============================================
    // Contour Path Suggestions
    // ============================================

    /**
     * Calculate contour path suggestions for legs adjacent to a moved waypoint
     */
    async calculateContourSuggestions(pointIndex) {
        if (!this.points || this.points.length < 2) return;

        // Check both adjacent legs
        const legsToCheck = [];
        if (pointIndex > 0) legsToCheck.push(pointIndex - 1); // Previous leg
        if (pointIndex < this.points.length - 1) legsToCheck.push(pointIndex); // Next leg

        for (const legIndex of legsToCheck) {
            const start = this.points[legIndex];
            const end = this.points[legIndex + 1];

            // Get depth at start point
            const startDepth = await queryDepth(start[0], start[1]);
            if (startDepth === null) {
                continue;
            }

            // Try to find contour path
            const contourPath = await this.findContourPath(
                start[0], start[1],
                end[0], end[1],
                startDepth,
                this.contourTolerance
            );

            if (contourPath && contourPath.length > 2) {
                // Store path in leg data for toggling
                this.legData[legIndex].contourPath = contourPath;
                this.legData[legIndex].hasContour = true;
                this.legData[legIndex].bearingPath = [start, end]; // Always valid straight line

                this.suggestedPaths[legIndex] = contourPath;

                // Only show suggestion if we are NOT already in contour mode
                if (this.legData[legIndex].type !== 'contour') {
                    this.showSuggestedPath(legIndex, contourPath);
                }
            } else {
                this.legData[legIndex].hasContour = false;
                this.suggestedPaths[legIndex] = null;
                this.hideSuggestedPath(legIndex);
            }

            // Refresh table to show toggle button
            if (this.currentProfileData) this.generateProfile();
        }
    }

    /**
     * Display a suggested contour path on the map
     */
    showSuggestedPath(legIndex, path) {
        const sourceId = `suggested-path-${legIndex}`;
        const layerId = `suggested-path-layer-${legIndex}`;

        // Remove existing suggestion for this leg
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getLayer(`${layerId}-casing`)) map.removeLayer(`${layerId}-casing`);
        if (map.getSource(sourceId)) map.removeSource(sourceId);

        // Add source
        map.addSource(sourceId, {
            type: 'geojson',
            data: {
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: path
                }
            }
        });

        // Add layer (black casing for contrast)
        // No beforeId -> Render on top!

        map.addLayer({
            id: `${layerId}-casing`,
            type: 'line',
            source: sourceId,
            paint: {
                'line-color': '#000000',
                'line-width': 5,
                'line-opacity': 0.4
            }
        });

        // Add layer (white dotted line on top)
        map.addLayer({
            id: layerId,
            type: 'line',
            source: sourceId,
            paint: {
                'line-color': '#ffffff',
                'line-width': 2.5,
                'line-dasharray': [2, 2], // Tighter dots
                'line-opacity': 1.0
            }
        });

        // Subtle animation (fade in)
        let opacity = 0;
        const animateIn = () => {
            opacity += 0.05;
            if (map.getLayer(layerId)) {
                map.setPaintProperty(layerId, 'line-opacity', Math.min(1.0, opacity));
                if (opacity < 1.0) requestAnimationFrame(animateIn);
            }
        };
        requestAnimationFrame(animateIn);
    }

    /**
     * Hide suggested path for a leg
     */
    hideSuggestedPath(legIndex) {
        const sourceId = `suggested-path-${legIndex}`;
        const layerId = `suggested-path-layer-${legIndex}`;
        const casingId = `${layerId}-casing`;

        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getLayer(casingId)) map.removeLayer(casingId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
    }

    hideAllSuggestedPaths() {
        // Hide all suggestion overlays
        for (let i = 0; i < this.points.length; i++) {
            this.hideSuggestedPath(i);
        }
    }

    /**
     * Set the type of a leg (contour vs bearing)
     * @param {number} legIndex - Index of the leg
     * @param {string} type - 'bearing' or 'contour'
     */
    async setLegType(legIndex, type) {
        const leg = this.legData[legIndex];
        if (!leg) return;

        console.log(`[Leg] Setting leg ${legIndex} to ${type}`);

        if (type === 'contour') {
            if (leg.hasContour && leg.contourPath) {
                leg.type = 'contour';
                leg.path = leg.contourPath;
                this.hideSuggestedPath(legIndex); // Hide suggestion as applied
            }
        } else {
            // Revert to bearing
            leg.type = 'bearing';
            // Ensure we have a valid bearing path (start/end points)
            leg.path = [this.points[legIndex], this.points[legIndex + 1]];

            // If we have a contour available, show it as suggestion again
            if (leg.hasContour) {
                this.showSuggestedPath(legIndex, leg.contourPath);
            }
        }

        // Update map and profile
        this.updateLineLayer();
        if (this.points.length >= 2 && this.currentProfileData) {
            await this.generateProfile();
        }
    }

    // ============================================
    // Contour Pathfinding
    // ============================================

    /**
     * Find a path that follows depth contours between two points
     * Uses A* search on a grid sampled from bathymetry data
     */
    async findContourPath(startLng, startLat, endLng, endLat, targetDepth, tolerance) {
        if (!state.rasterData || !state.renderedWidth || !state.renderedHeight) return null;

        const data = state.rasterData[0]; // Int16Array
        const width = state.renderedWidth;
        const height = state.renderedHeight;
        const totalPixels = width * height;
        const { mercatorBbox } = state.bounds;

        // Convert lng/lat to grid coordinates
        const toGrid = (lng, lat) => {
            const [mx, my] = lngLatToMercator(lng, lat);
            const x = Math.floor((mx - mercatorBbox[0]) / (mercatorBbox[2] - mercatorBbox[0]) * width);
            const y = Math.floor((mercatorBbox[3] - my) / (mercatorBbox[3] - mercatorBbox[1]) * height);
            return [x, y];
        };

        const fromGrid = (x, y) => {
            const mx = mercatorBbox[0] + (x / width) * (mercatorBbox[2] - mercatorBbox[0]);
            const my = mercatorBbox[3] - (y / height) * (mercatorBbox[3] - mercatorBbox[1]);
            return mercatorToLngLat(mx, my);
        };

        const [startX, startY] = toGrid(startLng, startLat);
        const [endX, endY] = toGrid(endLng, endLat);

        // Bounds checking
        if (startX < 0 || startX >= width || startY < 0 || startY >= height ||
            endX < 0 || endX >= width || endY < 0 || endY >= height) {
            return null;
        }

        // Check if direct path is already within tolerance - if so, use it
        const directSamples = 20;
        const tolerance100 = tolerance * 100;
        const targetDepth100 = targetDepth * 100;
        let directPathValid = true;
        for (let i = 0; i <= directSamples; i++) {
            const t = i / directSamples;
            const x = Math.floor(startX + (endX - startX) * t);
            const y = Math.floor(startY + (endY - startY) * t);
            if (x < 0 || x >= width || y < 0 || y >= height) {
                directPathValid = false;
                break;
            }
            const idx = y * width + x;
            const depth = data[idx];
            if (Math.abs(depth - targetDepth100) > tolerance100) {
                directPathValid = false;
                break;
            }
        }
        if (directPathValid) {
            // Direct path is good enough, no need for contour routing
            return null;
        }

        // Calculate straight-line distance for iteration limit
        const straightDist = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2);
        // Increased multiplier (50x) and max (20k) for long winding contour paths
        const maxIterations = Math.min(50000, Math.max(5000, Math.ceil(straightDist * 100)));

        // OPTIMIZATION: Use TypedArrays instead of Map/Set for O(1) access and no GC
        // visited: 0 = unvisited, 1 = closed, 2 = open (optional, mostly track closed)
        const visited = new Uint8Array(totalPixels);
        const gScores = new Float32Array(totalPixels);
        gScores.fill(Infinity);

        const startIdx = startY * width + startX;

        gScores[startIdx] = 0;

        // MinHeap for Open Set
        const minHeap = new MinHeap();
        const startH = Math.sqrt((startX - endX) ** 2 + (startY - endY) ** 2);
        minHeap.push({ x: startX, y: startY, idx: startIdx, g: 0, h: startH, f: startH, parent: null });

        let iterations = 0;

        // Helper arrays for neighbors (8-direction)
        // dx: -1, 0, 1 ...
        // cost: 1 or 1.414
        const neighborOffsets = [
            { dx: -1, dy: -1, cost: 1.414 }, { dx: 0, dy: -1, cost: 1 }, { dx: 1, dy: -1, cost: 1.414 },
            { dx: -1, dy: 0, cost: 1 }, { dx: 1, dy: 0, cost: 1 },
            { dx: -1, dy: 1, cost: 1.414 }, { dx: 0, dy: 1, cost: 1 }, { dx: 1, dy: 1, cost: 1.414 }
        ];

        while (!minHeap.isEmpty() && iterations++ < maxIterations) {
            const current = minHeap.pop();

            // Lazy deletion check
            if (visited[current.idx] === 1) continue;
            visited[current.idx] = 1; // Mark closed

            // Goal reached? (Within 2 grid units)
            if (Math.abs(current.x - endX) <= 2 && Math.abs(current.y - endY) <= 2) {
                // Reconstruct path
                const path = [];
                let node = current;
                while (node) {
                    const [lng, lat] = fromGrid(node.x, node.y);
                    path.unshift([lng, lat]);
                    node = node.parent;
                }
                // Ensure path starts and ends exactly at waypoints
                path[0] = [startLng, startLat];
                path[path.length - 1] = [endLng, endLat];
                return this.simplifyPath(path);
            }

            // Neighbors
            for (let i = 0; i < 8; i++) {
                const { dx, dy, cost } = neighborOffsets[i];
                const nx = current.x + dx;
                const ny = current.y + dy;

                if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

                const nIdx = ny * width + nx;
                if (visited[nIdx] === 1) continue; // Already closed

                const depth = data[nIdx];
                const diff = Math.abs(depth - targetDepth100);

                // Check depth tolerance
                if (diff > tolerance100) continue;

                // Calculate G cost
                // Add penalty for deviation from target depth to encourage staying "on contour"
                const depthPenalty = (diff / tolerance100) * 2.0;

                // Directness bonus: small penalty for moves not toward goal
                // Dot product of move direction with goal direction
                const goalDx = endX - current.x;
                const goalDy = endY - current.y;
                const goalDist = Math.sqrt(goalDx * goalDx + goalDy * goalDy);
                let directnessPenalty = 0;
                if (goalDist > 0) {
                    const dot = (dx * goalDx + dy * goalDy) / (Math.sqrt(dx * dx + dy * dy) * goalDist);
                    // dot is -1 (away) to +1 (toward), convert to penalty 0 to 0.5
                    directnessPenalty = (1 - dot) * 0.25;
                }

                const g = current.g + cost + depthPenalty + directnessPenalty;

                if (g < gScores[nIdx]) {
                    gScores[nIdx] = g;
                    const h = Math.sqrt((nx - endX) ** 2 + (ny - endY) ** 2);
                    minHeap.push({ x: nx, y: ny, idx: nIdx, g, h, f: g + h, parent: current });
                }
            }
        }

        // No path found
        return null;
    }

    /**
     * Simplify path using Ramer-Douglas-Peucker algorithm
     */
    simplifyPath(path, epsilon = 0.00005) {
        if (path.length <= 2) return path;

        // Find point with max distance from line
        let maxDist = 0;
        let maxIndex = 0;
        const start = path[0];
        const end = path[path.length - 1];

        for (let i = 1; i < path.length - 1; i++) {
            const dist = this.pointToLineDistance(path[i], start, end);
            if (dist > maxDist) {
                maxDist = dist;
                maxIndex = i;
            }
        }

        // If max distance is greater than epsilon, recursively simplify
        if (maxDist > epsilon) {
            const left = this.simplifyPath(path.slice(0, maxIndex + 1), epsilon);
            const right = this.simplifyPath(path.slice(maxIndex), epsilon);
            return left.slice(0, -1).concat(right);
        }

        return [start, end];
    }

    pointToLineDistance(point, lineStart, lineEnd) {
        const [px, py] = point;
        const [x1, y1] = lineStart;
        const [x2, y2] = lineEnd;

        const A = px - x1;
        const B = py - y1;
        const C = x2 - x1;
        const D = y2 - y1;

        const dot = A * C + B * D;
        const lenSq = C * C + D * D;
        let param = -1;

        if (lenSq !== 0) param = dot / lenSq;

        let xx, yy;

        if (param < 0) {
            xx = x1;
            yy = y1;
        } else if (param > 1) {
            xx = x2;
            yy = y2;
        } else {
            xx = x1 + param * C;
            yy = y1 + param * D;
        }

        const dx = px - xx;
        const dy = py - yy;
        return Math.sqrt(dx * dx + dy * dy);
    }

    async showContourHighlight(lng, lat, depth) {
        if (!state.rasterData || !state.bounds || depth === null || isNaN(depth)) return;
        if (!state.renderedWidth || !state.renderedHeight) return;

        const data = state.rasterData[0];
        // Use actual rendered dimensions, not original TIFF dimensions
        const width = state.renderedWidth;
        const height = state.renderedHeight;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(width, height);

        const tolerance = this.contourTolerance * 100;
        const targetDepth = depth * 100;

        // Fill matching depth pixels with transparent blue
        for (let y = 0; y < height; y++) {
            const rowOffset = y * width;
            for (let x = 0; x < width; x++) {
                const i = rowOffset + x;
                const value = data[i];

                // Highlight pixels within depth tolerance
                if (Math.abs(value - targetDepth) <= tolerance) {
                    const px = i * 4;
                    imageData.data[px] = 30;        // R - blue tint
                    imageData.data[px + 1] = 144;   // G
                    imageData.data[px + 2] = 255;   // B - bright blue
                    imageData.data[px + 3] = 128;   // Semi-transparent (50%)
                }
            }
        }

        ctx.putImageData(imageData, 0, 0);

        if (!state.bathymetryLayer) return;

        const contourLayer = new deck.BitmapLayer({
            id: 'contour-highlight',
            bounds: [state.bounds.west, state.bounds.south, state.bounds.east, state.bounds.north],
            image: canvas,
            opacity: 1.0,
            beforeId: 'route-line-layer' // Render beneath the route line
        });

        // Render contour on top of bathymetry (both beneath route line via beforeId)
        state.deckOverlay.setProps({
            layers: [state.bathymetryLayer, contourLayer]
        });

        // Add blue glow to waypoints within depth tolerance
        for (let i = 0; i < this.points.length; i++) {
            const point = this.points[i];
            const pointDepth = await queryDepth(point[0], point[1]);

            if (pointDepth !== null && Math.abs(pointDepth * 100 - targetDepth) <= tolerance) {
                // This waypoint is within tolerance - add blue glow
                if (this.markers[i]) {
                    const el = this.markers[i].getElement();
                    el.style.filter = 'drop-shadow(0 0 12px rgba(30, 144, 255, 1)) drop-shadow(0 0 24px rgba(30, 144, 255, 0.6))';
                    // Don't set transform - it interferes with MapLibre marker positioning
                    el.style.transition = 'filter 0.2s ease';
                }
            }
        }
    }

    hideContourHighlight() {
        if (state.bathymetryLayer && state.deckOverlay) {
            // Restore just the bathymetry layer
            state.deckOverlay.setProps({
                layers: [state.bathymetryLayer]
            });
        }

        // Remove blue glow from all waypoints (don't touch transform - MapLibre uses it for positioning!)
        for (let i = 0; i < this.markers.length; i++) {
            if (this.markers[i]) {
                const el = this.markers[i].getElement();
                el.style.filter = '';
                // Don't reset transform - MapLibre uses it to position the marker on the map
            }
        }
        // Route line z-order handled by beforeId on deck.gl layers
    }

    clearRoute() {
        // Clean up contour suggestions
        if (this.hideAllSuggestedPaths) {
            this.hideAllSuggestedPaths();
        }
        this.suggestedPaths = [];

        this.points = [];
        this.legData = [];

        this.markers.forEach(m => m.remove());
        this.markers = [];

        this.updateLineLayer();
        this.clearProfileChart();
        this.updateWaypointTable([], []);
        this.currentProfileData = null;
        this.waypointDists = [];

        if (this.midpointMarker) {
            this.midpointMarker.remove();
            this.midpointMarker = null;
        }
        if (this.hoverMarker) {
            this.hoverMarker.remove();
            this.hoverMarker = null;
        }

        // Clear chart data
        if (this.chart) {
            this.chart.data.datasets[0].data = [];
            this.chart.update();
        }

        // Remove profile sample markers
        if (this.profileSampleMarkers) {
            this.profileSampleMarkers.forEach(m => m.remove());
            this.profileSampleMarkers = [];
        }
    }



    updateWaypointTable(profileData, dists) {
        // Elements
        const sidebar = document.getElementById('waypoint-sidebar');
        const tableBody = document.querySelector('#waypoint-table tbody');
        const depthMinEl = document.getElementById('depth-min');
        const depthMaxEl = document.getElementById('depth-max');
        const depthAvgEl = document.getElementById('depth-avg');

        if (!sidebar || !tableBody) return;

        // Save scroll position before updating
        const waypointContent = sidebar.querySelector('.waypoint-content');
        const scrollTop = waypointContent ? waypointContent.scrollTop : 0;

        // Always show sidebar (empty state will be visible when no points)
        sidebar.classList.remove('hidden');

        // If no points, clear table and show empty state
        if (this.points.length === 0) {
            tableBody.innerHTML = '';

            // Reset depth stats
            if (depthMinEl) depthMinEl.textContent = '--';
            if (depthMaxEl) depthMaxEl.textContent = '--';
            if (depthAvgEl) depthAvgEl.textContent = '--';

            // Reset total distance
            const totalDistDisplayEl = document.getElementById('total-dist-display');
            if (totalDistDisplayEl) totalDistDisplayEl.textContent = '0';

            // Sync mobile planner to show empty state
            if (window.syncMobilePlanner) {
                window.syncMobilePlanner();
            }

            return;
        }

        // Calculate overall depth stats
        const validDepths = profileData.filter(d => d.depth !== null).map(d => Math.abs(d.depth));
        if (validDepths.length > 0) {
            const minDepth = Math.min(...validDepths);
            const maxDepth = Math.max(...validDepths);
            const avgDepth = validDepths.reduce((a, b) => a + b, 0) / validDepths.length;

            if (depthMinEl) depthMinEl.textContent = minDepth.toFixed(1);
            if (depthMaxEl) depthMaxEl.textContent = maxDepth.toFixed(1);
            if (depthAvgEl) depthAvgEl.textContent = avgDepth.toFixed(1);
        } else {
            if (depthMinEl) depthMinEl.textContent = '--';
            if (depthMaxEl) depthMaxEl.textContent = '--';
            if (depthAvgEl) depthAvgEl.textContent = '--';
        }

        tableBody.innerHTML = '';

        // Get speed in m/min using single source of truth
        const speedMetersPerMin = this.getSpeedMetersPerMin();

        let totalDistNM = 0;

        // Iterate through waypoints - each row shows the OUTGOING leg from that waypoint
        for (let i = 0; i < this.points.length; i++) {
            const p = this.points[i];
            const isEnd = i === this.points.length - 1;
            const hasOutgoingLeg = i < this.points.length - 1;

            // Calculate leg stats for the leg DEPARTING from this point (to next point)
            let distM = 0;
            let legTimeMin = 0;
            let bearing = 0;
            let depthMin = null;
            let depthMax = null;

            if (hasOutgoingLeg) {
                // Use actual path distance from dists array (accounts for contour paths)
                distM = dists[i + 1] - dists[i];
                legTimeMin = distM / speedMetersPerMin;
                bearing = this.calculateBearing(this.points[i], this.points[i + 1]);

                // Find depth range for this segment in profileData
                const startDist = dists[i];
                const endDist = dists[i + 1];

                const legSamples = profileData.filter(d => d.dist >= startDist && d.dist <= endDist && d.depth !== null);
                if (legSamples.length > 0) {
                    depthMin = Math.min(...legSamples.map(d => d.depth));
                    depthMax = Math.max(...legSamples.map(d => d.depth));
                }
            }

            // CRITICAL: Calculate arrival time FROM distance (single source of truth)
            // Don't accumulate to avoid floating point errors
            const arrivalTimeMin = dists[i] / speedMetersPerMin;
            const hours = Math.floor(arrivalTimeMin / 60);
            const mins = Math.floor(arrivalTimeMin % 60);
            const timeStr = `${hours}:${mins.toString().padStart(2, '0')}`;

            const lat = p[1].toFixed(4);
            const lon = p[0].toFixed(4);

            // Format distance based on selected unit
            const distUnitEl = document.getElementById('dist-unit');
            const distUnit = distUnitEl ? distUnitEl.value : 'm';
            let distStr = '--';
            if (hasOutgoingLeg) {
                if (distUnit === 'm') {
                    distStr = `${Math.round(distM)} m`;
                } else if (distUnit === 'km') {
                    distStr = `${(distM / 1000).toFixed(2)} km`;
                } else {
                    distStr = `${(distM / 1852).toFixed(2)} nm`;
                }
            }

            let depthStr = '--';
            if (depthMin !== null && depthMax !== null) {
                if (Math.abs(depthMin - depthMax) < 0.5) {
                    // Same depth, just show one value
                    depthStr = `${Math.abs(depthMin).toFixed(1)}m`;
                } else {
                    // Show range (shallower - deeper)
                    const shallow = Math.abs(Math.min(depthMin, depthMax)).toFixed(1);
                    const deep = Math.abs(Math.max(depthMin, depthMax)).toFixed(1);
                    depthStr = `${shallow}-${deep}m`;
                }
            }

            const durMin = hasOutgoingLeg ? Math.round(legTimeMin) : '--';

            const tr = document.createElement('tr');

            if (isEnd) {
                // Last point - END badge in distance column, total runtime shown
                tr.innerHTML = `
                    <td class="wp-time">${timeStr}</td>
                    <td class="wp-pos">${lat}<br>${lon}</td>
                    <td class="wp-val"><span class="end-badge">END</span></td>
                    <td class="wp-val">--</td>
                    <td class="wp-val">--</td>
                    <td class="wp-depth">--</td>
                    <td></td>
                `;
            } else {
                // Has outgoing leg - show stats and contour toggle for leg DEPARTING from this point
                const legIdx = i; // Leg index = waypoint index for outgoing leg
                const leg = this.legData[legIdx];
                const hasContour = leg && leg.hasContour;
                const isContourMode = leg && leg.type === 'contour';

                const toggleHtml = hasContour
                    ? `<label class="switch" title="Contour path available - click to toggle">
                        <input type="checkbox"
                            ${isContourMode ? 'checked' : ''}
                            onchange="profiler.setLegType(${legIdx}, this.checked ? 'contour' : 'bearing')">
                        <span class="slider"></span>
                    </label>`
                    : `<span class="contour-unavailable" title="No contour path found for this leg">--</span>`;

                // Bearing is approximate on contour legs - show lighter with superscript asterisk
                const bearingDisplay = isContourMode
                    ? `<span class="contour-hint">${Math.round(bearing)}°<sup>*</sup></span>`
                    : `${Math.round(bearing)}°`;

                tr.innerHTML = `
                    <td class="wp-time">${timeStr}</td>
                    <td class="wp-pos">${lat}<br>${lon}</td>
                    <td class="wp-val">${distStr}</td>
                    <td class="wp-val">${bearingDisplay}</td>
                    <td class="wp-val">${durMin} min</td>
                    <td class="wp-depth">${depthStr}</td>
                    <td>${toggleHtml}</td>
                `;
            }

            // Add click handler to pan to point
            tr.onclick = (e) => {
                // Ignore clicks on checkbox
                if (e.target.tagName.toLowerCase() === 'input' || e.target.classList.contains('slider')) return;

                map.flyTo({ center: p, zoom: 14 });
            };

            tableBody.appendChild(tr);

            // Track total distance for summary display
            totalDistNM += (distM / 1852);
        }
        // Update total distance display in waypoint sidebar
        const totalDistDisplayEl = document.getElementById('total-dist-display');
        const distUnitEl = document.getElementById('dist-unit');
        const distUnit = distUnitEl ? distUnitEl.value : 'm';
        const totalDistM = totalDistNM * 1852; // Convert back to meters

        let distValue, distLabel;
        if (distUnit === 'm') {
            distValue = Math.round(totalDistM);
            distLabel = 'm';
        } else if (distUnit === 'km') {
            distValue = (totalDistM / 1000).toFixed(2);
            distLabel = 'km';
        } else {
            distValue = totalDistNM.toFixed(2);
            distLabel = 'nm';
        }

        if (totalDistDisplayEl) {
            totalDistDisplayEl.textContent = distValue;
        }

        // Restore scroll position after updating table
        if (waypointContent) {
            waypointContent.scrollTop = scrollTop;
        }
    }

    calculateBearing(p1, p2) {
        const φ1 = p1[1] * Math.PI / 180;
        const φ2 = p2[1] * Math.PI / 180;
        const Δλ = (p2[0] - p1[0]) * Math.PI / 180;

        const y = Math.sin(Δλ) * Math.cos(φ2);
        const x = Math.cos(φ1) * Math.sin(φ2) -
            Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

        let brng = Math.atan2(y, x) * 180 / Math.PI;
        return (brng + 360) % 360;
    }

    haversineDistance(p1, p2) { // [lng, lat]
        const R = 6371e3; // metres
        const φ1 = p1[1] * Math.PI / 180;
        const φ2 = p2[1] * Math.PI / 180;
        const Δφ = (p2[1] - p1[1]) * Math.PI / 180;
        const Δλ = (p2[0] - p1[0]) * Math.PI / 180;

        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return R * c;
    }

    // ----------------------------------------------------------------
    // Chart Logic
    // ----------------------------------------------------------------

    clearProfileChart() {
        if (this.chart) {
            this.chart.data.datasets[0].data = [];
            this.chart.update();
        }
    }

    initChart() {
        const ctx = document.getElementById('profile-chart').getContext('2d');

        // Register plugin to draw background areas
        const backgroundPlugin = {
            id: 'customCanvasBackgroundColor',
            beforeDraw: (chart) => {
                const ctx = chart.canvas.getContext('2d');
                ctx.save();
                ctx.globalCompositeOperation = 'destination-over';
                ctx.fillStyle = 'white';
                ctx.fillRect(0, 0, chart.width, chart.height);
                ctx.restore();
            }
        };

        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [{
                    label: 'Depth',
                    data: [],
                    borderColor: '#1e40af',
                    backgroundColor: 'rgba(30, 64, 175, 0.35)',
                    borderWidth: 2,
                    fill: true,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    tension: 0.1,
                    spanGaps: false, // We manually handle gaps by dropping to 0
                    segment: {
                        // Style segments connected to a 'gap' point (y=0, isGap=true)
                        borderColor: ctx => (ctx.p0.raw.isGap || ctx.p1.raw.isGap) ? 'rgba(0,0,0,0.3)' : undefined,
                        borderDash: ctx => (ctx.p0.raw.isGap || ctx.p1.raw.isGap) ? [4, 4] : undefined,
                    }
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    x: {
                        type: 'number',
                        easing: 'easeInOutQuart',
                        duration: 1500,
                        from: NaN, // Start from left
                        delay(ctx) {
                            // Stagger animation from left to right
                            return ctx.type === 'data' && ctx.mode === 'default'
                                ? ctx.dataIndex * 3
                                : 0;
                        }
                    },
                    y: {
                        type: 'number',
                        easing: 'easeInOutQuart',
                        duration: 1500,
                        from: 0
                    }
                },
                interaction: {
                    intersect: false,
                    mode: 'index',
                },
                scales: {
                    x: {
                        type: 'linear',
                        title: { display: false }, // Hidden - using dropdown instead
                        ticks: {
                            callback: function (value) {
                                // Get distance unit to format appropriately
                                const distUnitEl = document.getElementById('dist-unit');
                                const distUnit = distUnitEl ? distUnitEl.value : 'm';

                                if (distUnit === 'm') {
                                    return Math.round(value); // Meters: integers
                                } else if (distUnit === 'km') {
                                    // km: show 1-2 decimals
                                    return value < 1 ? value.toFixed(2) : value.toFixed(1);
                                } else {
                                    // nm: show 1-2 decimals
                                    return value < 1 ? value.toFixed(2) : value.toFixed(1);
                                }
                            }
                        }
                    },
                    xTime: {
                        type: 'linear',
                        position: 'top',
                        title: { display: true, text: 'Time (min)' },
                        grid: { drawOnChartArea: false },
                        ticks: {
                            // Tighter time gradations - show more ticks
                            autoSkip: true,
                            maxTicksLimit: 15, // Increased from default (~7) for tighter gradations
                            callback: function (val, index, ticks) {
                                // Get profiler reference
                                const profiler = window.profiler;
                                if (!profiler) return '';

                                // Use single source of truth for speed conversion (CRITICAL for safety)
                                const speedMetersPerMin = profiler.getSpeedMetersPerMin();

                                // Avoid division by zero
                                if (!speedMetersPerMin || speedMetersPerMin <= 0) return '';

                                // Get distance unit
                                const distUnitEl = document.getElementById('dist-unit');
                                const distUnit = distUnitEl ? distUnitEl.value : 'm';

                                // val is in the current display unit, convert to meters
                                let distM;
                                if (distUnit === 'nm') {
                                    distM = val * 1852;
                                } else if (distUnit === 'km') {
                                    distM = val * 1000;
                                } else {
                                    distM = val; // already in meters
                                }

                                // Calculate time in minutes (use floor to match table display logic)
                                const timeMin = distM / speedMetersPerMin;
                                // Show integer minutes for consistency with waypoint table
                                const displayMin = Math.floor(timeMin);
                                return displayMin;
                            }
                        }
                    },
                    y: {
                        title: { display: true, text: 'Depth (m relative to chart datum)' },
                        reverse: false, // Standard axis: 0 at top, negatives below
                        suggestedMax: 0, // Ensure 0 is always at the top
                    }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        enabled: false, // Custom behavior
                        external: (context) => {
                            // Tooltip Model
                            const tooltipModel = context.tooltip;

                            // Remove existing hover marker if tooltip hidden
                            if (tooltipModel.opacity === 0) {
                                if (this.hoverMarker) {
                                    this.hoverMarker.remove();
                                    this.hoverMarker = null;
                                }
                                // Clear cursor depth display
                                updateCursorDepth(null, 0, 0);
                                return;
                            }

                            // Get data point
                            if (tooltipModel.dataPoints && tooltipModel.dataPoints.length > 0) {
                                const index = tooltipModel.dataPoints[0].dataIndex;
                                const point = this.currentProfileData[index];

                                if (point && point.lat && point.lng) {
                                    // Update cursor depth display in legend
                                    updateCursorDepth(point.depth, point.lng, point.lat, 'On Profile:');

                                    // Create/Update marker on map
                                    const el = document.createElement('div');
                                    el.style.width = '12px';
                                    el.style.height = '12px';
                                    el.style.background = '#eab308'; // Yellow-500
                                    el.style.border = '2px solid white';
                                    el.style.borderRadius = '50%';
                                    el.style.boxShadow = '0 0 10px rgba(0,0,0,0.5)';
                                    el.style.zIndex = '500'; // Keep behind midpoint marker (2000) and WPs (1000)

                                    if (!this.hoverMarker) {
                                        this.hoverMarker = new maplibregl.Marker({ element: el })
                                            .setLngLat([point.lng, point.lat])
                                            .addTo(map);
                                    } else {
                                        this.hoverMarker.setLngLat([point.lng, point.lat]);
                                    }
                                }
                            }
                        }
                    },
                    // Custom plugin to draw vertical lines for waypoints
                    annotation: {
                        // Note: Chart.js annotation plugin is not loaded, we use a custom inline plugin below
                    }
                },
                onClick: () => {
                    // nothing
                }
            },
            plugins: [backgroundPlugin, {
                id: 'waypointLines',
                afterDraw: (chart) => {
                    if (!this.waypointDists || this.waypointDists.length === 0) return;

                    const ctx = chart.ctx;
                    const xAxis = chart.scales.x;
                    const yAxis = chart.scales.y;

                    ctx.save();
                    ctx.beginPath();
                    ctx.lineWidth = 1;
                    ctx.strokeStyle = 'rgba(220, 38, 38, 0.5)'; // Red, semi-transparent
                    ctx.setLineDash([5, 5]);

                    // Get selected distance unit
                    const distUnitEl = document.getElementById('dist-unit');
                    const distUnit = distUnitEl ? distUnitEl.value : 'm';

                    this.waypointDists.forEach((distM, index) => {
                        // Convert distM to the selected unit for x-axis
                        let xVal;
                        if (distUnit === 'nm') {
                            xVal = distM * 0.000539957; // meters to NM
                        } else if (distUnit === 'km') {
                            xVal = distM / 1000; // meters to km
                        } else {
                            xVal = distM; // meters
                        }
                        const x = xAxis.getPixelForValue(xVal);

                        // Draw line
                        ctx.moveTo(x, yAxis.top);
                        ctx.lineTo(x, yAxis.bottom);

                        // Draw Label (skip first and last waypoints - start and end)
                        if (index > 0 && index < this.waypointDists.length - 1) {
                            ctx.fillStyle = '#dc2626';
                            ctx.textAlign = 'center';
                            ctx.font = '10px JetBrains Mono';
                            ctx.fillText(`WP${index}`, x, yAxis.top + 10);
                        }
                    });

                    ctx.stroke();
                    ctx.restore();
                }
            }, {
                    // Plugin to draw subtle blue line on hover
                    id: 'hoverLine',
                    afterDraw: (chart) => {
                        if (this.hoverDistance === null || this.hoverDistance === undefined) return;

                        const ctx = chart.ctx;
                        const xAxis = chart.scales.x;
                        const yAxis = chart.scales.y;

                        // Get selected distance unit
                        const distUnitEl = document.getElementById('dist-unit');
                        const distUnit = distUnitEl ? distUnitEl.value : 'm';

                        // Convert hover distance to chart units
                        let xVal;
                        if (distUnit === 'nm') {
                            xVal = this.hoverDistance * 0.000539957;
                        } else if (distUnit === 'km') {
                            xVal = this.hoverDistance / 1000;
                        } else {
                            xVal = this.hoverDistance;
                        }

                        const x = xAxis.getPixelForValue(xVal);

                        // Ensure line is within chart area
                        if (x < xAxis.left || x > xAxis.right) return;

                        ctx.save();
                        ctx.beginPath();
                        ctx.lineWidth = 0.5; // Thinner line
                        ctx.strokeStyle = 'rgba(59, 130, 246, 0.8)'; // Blue-500, higher opacity
                        ctx.setLineDash([]); // Solid line

                        ctx.moveTo(x, yAxis.top);
                        ctx.lineTo(x, yAxis.bottom);

                        ctx.stroke();
                        ctx.restore();
                    }
                }]
        });

        // Clean up hover marker when cursor leaves chart
        const canvas = document.getElementById('profile-chart');
        canvas.addEventListener('mouseleave', () => {
            if (this.hoverMarker) {
                this.hoverMarker.remove();
                this.hoverMarker = null;
            }
            updateCursorDepth(null, 0, 0);
        });
    }

    updateChart() {
        if (!this.currentProfileData) return;

        // Get selected distance unit
        const distUnitEl = document.getElementById('dist-unit');
        const distUnit = distUnitEl ? distUnitEl.value : 'm';

        // Transform data for chart
        const dataPoints = this.currentProfileData.map(p => {
            let val = 0;
            let isGap = false;

            if (p.depth === null) {
                val = 0;
                isGap = true;
            } else {
                val = -Math.abs(p.depth);
            }

            // Convert distance based on selected unit
            let x;
            if (distUnit === 'nm') {
                x = p.dist * 0.000539957; // meters to NM
            } else if (distUnit === 'km') {
                x = p.dist / 1000; // meters to km
            } else {
                x = p.dist; // meters
            }

            return { x, y: val, isGap };
        });

        this.chart.data.datasets[0].data = dataPoints;
        this.chart.update('none');
    }

    updateChartTimeLabels() {
        // The xTime axis callback is defined in chart init and uses window.profiler
        // to get live speed/unit values. We just need to trigger a redraw.
        if (this.chart) {
            this.chart.update('none');
        }
    }

    /**
     * Generate a shareable URL with current route state
     */
    generateShareUrl() {
        if (this.points.length < 2) return null;

        const params = new URLSearchParams();

        // Speed and unit
        params.set('s', this.speed.toString());
        params.set('u', this.speedUnit);

        // Points - encode as comma-separated lng,lat pairs with 6 decimal precision
        const pointsStr = this.points.map(p =>
            `${p[0].toFixed(6)},${p[1].toFixed(6)}`
        ).join(';');
        params.set('p', pointsStr);

        // Leg types - compact encoding: 'b' for bearing, 'c' for contour
        const legTypes = this.legData.map(leg => leg.type === 'contour' ? 'c' : 'b').join('');
        params.set('l', legTypes);

        const url = new URL(window.location.href.split('?')[0]);
        url.search = params.toString();
        return url.toString();
    }

    /**
     * Show share modal with URL and copy button
     */
    showShareModal() {
        const url = this.generateShareUrl();
        if (!url) {
            console.warn('No route to share');
            this.showToast('No route to share yet', true);
            return;
        }

        // Remove existing modal if any
        const existingModal = document.querySelector('.share-modal');
        if (existingModal) {
            existingModal.remove();
        }

        // Create modal
        const modal = document.createElement('div');
        modal.className = 'share-modal';
        modal.innerHTML = `
            <div class="share-modal-content">
                <div class="share-modal-header">
                    <h3>Share Route</h3>
                    <button class="share-modal-close" aria-label="Close">&times;</button>
                </div>
                <div class="share-modal-body">
                    <label for="share-url-input">Share this link:</label>
                    <div class="share-url-container">
                        <input type="text" id="share-url-input" value="${url}" readonly>
                        <button class="share-copy-btn">Copy</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Show modal with animation
        setTimeout(() => modal.classList.add('show'), 10);

        // Close button handler
        const closeBtn = modal.querySelector('.share-modal-close');
        closeBtn.addEventListener('click', () => this.closeShareModal());

        // Click outside to close
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                this.closeShareModal();
            }
        });

        // Copy button handler
        const copyBtn = modal.querySelector('.share-copy-btn');
        const urlInput = modal.querySelector('#share-url-input');
        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(url);
                copyBtn.textContent = 'Copied!';
                copyBtn.classList.add('copied');
                urlInput.select();

                setTimeout(() => {
                    copyBtn.textContent = 'Copy';
                    copyBtn.classList.remove('copied');
                }, 1500);
            } catch (err) {
                console.error('Failed to copy URL:', err);
                this.showToast('Failed to copy link', true);
            }
        });

        // Select URL on input click
        urlInput.addEventListener('click', () => {
            urlInput.select();
        });

        // ESC key to close
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                this.closeShareModal();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }

    /**
     * Close share modal
     */
    closeShareModal() {
        const modal = document.querySelector('.share-modal');
        if (modal) {
            modal.classList.remove('show');
            setTimeout(() => modal.remove(), 300);
        }
    }

    /**
     * Show a toast notification
     */
    showToast(message, isError = false) {
        // Remove existing toast if any
        const existingToast = document.querySelector('.share-toast');
        if (existingToast) {
            existingToast.remove();
        }

        // Create toast element
        const toast = document.createElement('div');
        toast.className = 'share-toast';
        if (isError) toast.classList.add('error');
        toast.textContent = message;
        document.body.appendChild(toast);

        // Trigger animation
        setTimeout(() => toast.classList.add('show'), 10);

        // Remove after 2 seconds
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 2000);
    }

    /**
     * Load route state from URL parameters
     */
    async loadFromUrl() {
        const params = new URLSearchParams(window.location.search);

        // Check if we have route data
        const pointsStr = params.get('p');
        if (!pointsStr) return false;

        try {
            // Parse points
            const points = pointsStr.split(';').map(pair => {
                const [lng, lat] = pair.split(',').map(Number);
                if (isNaN(lng) || isNaN(lat)) throw new Error('Invalid coordinates');
                return [lng, lat];
            });

            if (points.length < 2) return false;

            // Parse speed
            const speed = parseFloat(params.get('s'));
            if (!isNaN(speed) && speed > 0) {
                this.speed = speed;
                if (this.speedInput) this.speedInput.value = speed;
            }

            // Parse unit
            const unit = params.get('u');
            if (unit && ['mmin', 'knots', 'ms'].includes(unit)) {
                this.speedUnit = unit;
                if (this.unitSelect) this.unitSelect.value = unit;
            }

            // Parse leg types
            const legTypesStr = params.get('l') || '';

            // Set points
            this.points = points;
            this.initializeLegData();

            // Apply leg types
            for (let i = 0; i < legTypesStr.length && i < this.legData.length; i++) {
                if (legTypesStr[i] === 'c') {
                    this.legData[i].type = 'contour';
                }
            }

            // Mark as finished route
            this.isFinished = true;
            this.isActive = false;

            // Disable edit mode for shared routes
            this.editMode = false;
            const editBtn = document.getElementById('edit-toggle-btn');
            if (editBtn) {
                editBtn.classList.remove('active');
                const label = editBtn.querySelector('.edit-label');
                if (label) label.textContent = 'Edit';
            }

            // Hide start overlay
            if (this.startOverlay) {
                this.startOverlay.style.display = 'none';
            }

            // Show shelf
            if (this.shelf) {
                this.shelf.classList.add('active');
            }

            // Update UI
            this.rebuildMarkers();
            this.updateLineLayer();
            this.updateSpeedDescription();

            // Wait for bathymetry data to be ready before processing route
            (async () => {
                // Ensure bathymetry is loaded
                if (bathymetryReady) {
                    await bathymetryReady;
                }

                // Fit map to route bounds with padding for UI elements
                const bounds = this.points.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(this.points[0], this.points[0]));

                // Adjust padding for mobile vs desktop
                const isMobile = window.innerWidth <= 768;
                const padding = isMobile
                    ? { top: 40, bottom: 40, left: 40, right: 40 }
                    : { top: 40, bottom: 40, left: 40, right: 280 };

                map.fitBounds(bounds, {
                    padding: padding,
                    maxZoom: 16
                });

                // Calculate contour suggestions for all legs
                for (let i = 0; i < this.points.length - 1; i++) {
                    await this.calculateContourSuggestions(i);
                    // If leg was marked as contour and we found a path, apply it
                    if (this.legData[i].type === 'contour' && this.legData[i].hasContour) {
                        this.legData[i].path = this.legData[i].contourPath;
                    }
                }

                // Update map with contour paths
                this.updateLineLayer();

                // Generate profile with correct paths
                await this.generateProfile();
            })();

            return true;
        } catch (err) {
            console.error('Failed to load route from URL:', err);
            return false;
        }
    }

    updateSpeedDescription() {
        const descEl = document.getElementById('speed-desc');
        if (!descEl) return;

        // Convert current speed to m/min for comparison
        let speedMMin = this.speed;
        if (this.speedUnit === 'knots') {
            speedMMin = this.speed * 30.867; // 1 knot ≈ 30.867 m/min
        } else if (this.speedUnit === 'ms') {
            speedMMin = this.speed * 60; // m/s to m/min
        }

        // Determine description based on m/min
        let desc = '';
        if (speedMMin >= 70) {
            desc = 'Unreasonable';
        } else if (speedMMin >= 55) {
            desc = 'Fast Scooter';
        } else if (speedMMin >= 35) {
            desc = 'Scooter';
        } else if (speedMMin >= 30) {
            desc = 'Fast Swim';
        } else if (speedMMin >= 20) {
            desc = 'Normal';
        } else if (speedMMin >= 10) {
            desc = 'Slow';
        } else {
            desc = 'Very Slow';
        }

        descEl.textContent = desc;
    }
}

// Initialize Profiler when map loads
map.on('load', async () => {
    window.profiler = new RouteProfiler();
    // Load route from URL if present (this will wait for bathymetry internally)
    await window.profiler.loadFromUrl();
});

// Hook into updateChart to sync axis ranges BEFORE tick generation
const syncAxesPlugin = {
    id: 'syncAxes',
    beforeLayout: (chart) => {
        // Get the data from the x-axis to determine min/max
        const datasets = chart.data.datasets;
        if (!datasets || !datasets[0] || !datasets[0].data || datasets[0].data.length === 0) {
            return;
        }

        // Find min/max x values from data
        const xValues = datasets[0].data.map(p => p.x).filter(v => v !== undefined && !isNaN(v));
        if (xValues.length === 0) return;

        const minX = Math.min(...xValues);
        const maxX = Math.max(...xValues);

        // Synchronize both distance and time axes to identical ranges
        // Ensures time labels align precisely with distance positions
        if (chart.options.scales.x) {
            chart.options.scales.x.min = minX;
            chart.options.scales.x.max = maxX;
        }
        if (chart.options.scales.xTime) {
            chart.options.scales.xTime.min = minX;
            chart.options.scales.xTime.max = maxX;
        }
    }
};
Chart.register(syncAxesPlugin);

// ============================================
// Mobile Tab Navigation
// ============================================

function initializeMobileTabs() {
    const tabs = document.querySelectorAll('.shelf-tab');
    const panels = document.querySelectorAll('.shelf-tab-panel');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetPanel = tab.dataset.tab;

            // Update tab active states
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Update panel active states
            panels.forEach(p => {
                if (p.dataset.panel === targetPanel) {
                    p.classList.add('active');
                } else {
                    p.classList.remove('active');
                }
            });
        });
    });

    // Clone waypoint sidebar content to mobile planner panel
    function syncMobilePlanner() {
        const sidebar = document.getElementById('waypoint-sidebar');
        const mobileContent = document.getElementById('planner-mobile-content');

        if (sidebar && mobileContent && window.innerWidth <= 768) {
            // Save scroll position before cloning
            const existingContent = mobileContent.querySelector('.waypoint-content');
            const savedScrollTop = existingContent ? existingContent.scrollTop : 0;

            // Clone the waypoint content
            const waypointHeader = sidebar.querySelector('.waypoint-header');
            const depthStats = sidebar.querySelector('.depth-stats');
            const waypointContent = sidebar.querySelector('.waypoint-content');

            // Clear mobile content
            mobileContent.innerHTML = '';

            // Clone elements
            if (waypointHeader) {
                const headerClone = waypointHeader.cloneNode(true);
                mobileContent.appendChild(headerClone);

                // Re-attach event listeners for cloned buttons
                const editBtn = headerClone.querySelector('#edit-toggle-btn');
                if (editBtn && window.profiler) {
                    editBtn.addEventListener('click', () => window.profiler.toggleEditMode());
                }

                const distUnitSelect = headerClone.querySelector('#dist-unit-sidebar');
                if (distUnitSelect && window.profiler) {
                    distUnitSelect.addEventListener('change', (e) => {
                        const mainSelect = document.getElementById('dist-unit');
                        if (mainSelect) {
                            mainSelect.value = e.target.value;
                            mainSelect.dispatchEvent(new Event('change'));
                        }
                    });
                }
            }

            if (depthStats) {
                mobileContent.appendChild(depthStats.cloneNode(true));
            }

            if (waypointContent) {
                const contentClone = waypointContent.cloneNode(true);
                mobileContent.appendChild(contentClone);

                // Re-attach start profile link event listener
                const startLink = contentClone.querySelector('#start-profile-link');
                if (startLink && window.profiler) {
                    startLink.addEventListener('click', (e) => {
                        e.preventDefault();
                        if (window.profiler.isActive) {
                            window.profiler.finishRoute();
                        } else {
                            window.profiler.startDrawing();
                        }
                    });
                }

                // Restore scroll position after cloning
                contentClone.scrollTop = savedScrollTop;
            }
        }
    }

    // Expose globally for manual syncing
    window.syncMobilePlanner = syncMobilePlanner;

    // Sync on initialization and window resize
    syncMobilePlanner();
    window.addEventListener('resize', syncMobilePlanner);

    // Also sync when waypoint table updates (use MutationObserver)
    const sidebar = document.getElementById('waypoint-sidebar');
    if (sidebar) {
        const observer = new MutationObserver(syncMobilePlanner);
        observer.observe(sidebar, { childList: true, subtree: true });
    }
}

// ============================================
// Touch Optimizations
// ============================================

function initializeTouchOptimizations() {
    // Improve touch behavior for chart
    const canvas = document.getElementById('profile-chart');
    if (canvas) {
        // Allow touch events to work with Chart.js tooltips
        canvas.style.touchAction = 'none';

        let touchTimeout;
        canvas.addEventListener('touchstart', (e) => {
            // Show tooltip on touch
            if (e.touches.length === 1 && window.profiler && window.profiler.chart) {
                const touch = e.touches[0];
                const rect = canvas.getBoundingClientRect();
                const x = touch.clientX - rect.left;
                const y = touch.clientY - rect.top;

                // Create a synthetic mousemove event for Chart.js
                const mouseEvent = new MouseEvent('mousemove', {
                    clientX: touch.clientX,
                    clientY: touch.clientY,
                    bubbles: true
                });
                canvas.dispatchEvent(mouseEvent);
            }
        });

        canvas.addEventListener('touchend', () => {
            // Clear tooltip after a delay
            touchTimeout = setTimeout(() => {
                if (window.profiler && window.profiler.chart) {
                    window.profiler.chart.setActiveElements([]);
                    window.profiler.chart.tooltip.setActiveElements([]);
                    window.profiler.chart.update('none');
                }
            }, 2000);
        });
    }

    // Improve waypoint marker touch targets
    function enhanceWaypointTouch() {
        const wpMarkers = document.querySelectorAll('.wp-marker');
        wpMarkers.forEach(marker => {
            marker.style.cursor = 'grab';

            // Add touch event listeners for dragging
            let isDragging = false;

            marker.addEventListener('touchstart', (e) => {
                isDragging = true;
                marker.style.cursor = 'grabbing';
                e.preventDefault(); // Prevent scroll while dragging
            });

            marker.addEventListener('touchend', () => {
                isDragging = false;
                marker.style.cursor = 'grab';
            });
        });
    }

    // Run on load and periodically (markers are added dynamically)
    enhanceWaypointTouch();
    setInterval(enhanceWaypointTouch, 1000);
}

// ============================================
// Swipe Gesture for Tab Switching
// ============================================

function initializeSwipeGestures() {
    const shelf = document.getElementById('shelf');
    let touchStartX = 0;
    let touchEndX = 0;

    if (!shelf || window.innerWidth > 768) return;

    shelf.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    shelf.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        handleSwipe();
    }, { passive: true });

    function handleSwipe() {
        const swipeThreshold = 50;
        const diff = touchStartX - touchEndX;

        if (Math.abs(diff) < swipeThreshold) return;

        const tabs = document.querySelectorAll('.shelf-tab');
        const activeTab = document.querySelector('.shelf-tab.active');
        const activeIndex = Array.from(tabs).indexOf(activeTab);

        if (diff > 0 && activeIndex < tabs.length - 1) {
            // Swipe left - next tab
            tabs[activeIndex + 1].click();
        } else if (diff < 0 && activeIndex > 0) {
            // Swipe right - previous tab
            tabs[activeIndex - 1].click();
        }
    }
}

// Initialize all mobile features
document.addEventListener('DOMContentLoaded', () => {
    initializeMobileTabs();
    initializeTouchOptimizations();
    initializeSwipeGestures();
});
