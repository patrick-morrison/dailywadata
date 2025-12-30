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

    // Visualization settings
    DEPTH_MIN: -30,    // Deep water (m)
    DEPTH_MAX: 0,      // Shallow water (m)

    // Gradient stops (shallow to deep)
    COLOR_STOPS: [
        { depth: -1, color: [122, 4, 3] },         // Shallow - dark red
        { depth: -5, color: [249, 117, 29] },      // Orange
        { depth: -10, color: [239, 205, 58] },     // Yellow
        { depth: -15, color: [109, 254, 98] },     // Green
        { depth: -20, color: [30, 203, 218] },     // Cyan
        { depth: -25, color: [70, 100, 218] },     // Blue
        { depth: -30, color: [48, 18, 59] }        // Deep - purple
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
map.on('load', () => {
    initializeLegend();
    loadBathymetry();

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
        image: canvas.toDataURL(),
        opacity: 0.9
    });

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
}

// ============================================
// Utilities
// ============================================

async function queryDepth(lng, lat) {
    const { bounds, image } = state;
    if (!image || !bounds) return null;

    // Convert input LngLat to Mercator Meters
    const [mx, my] = lngLatToMercator(lng, lat);
    const { mercatorBbox } = bounds;

    // Check bounds in Meters
    if (mx < mercatorBbox[0] || mx > mercatorBbox[2] || my < mercatorBbox[1] || my > mercatorBbox[3]) {
        return null;
    }

    // Map to pixel
    const pixelX = Math.floor((mx - mercatorBbox[0]) / (mercatorBbox[2] - mercatorBbox[0]) * bounds.width);
    // Note: Y is flipped in image coords (0 at top) vs Mercator (0 at equator, increasing North)
    // Mercator: Y increases North. Image: Y increases South (down).
    // Raster usually stored North-Up.
    // Pixel 0 is Max Y (North).
    const pixelY = Math.floor((mercatorBbox[3] - my) / (mercatorBbox[3] - mercatorBbox[1]) * bounds.height);

    if (pixelX < 0 || pixelX >= bounds.width || pixelY < 0 || pixelY >= bounds.height) return null;

    try {
        const value = await image.readRasters({ window: [pixelX, pixelY, pixelX + 1, pixelY + 1] });
        const depth = value[0][0] / 100; // Scale Int16 data back to meters
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

    if (depth !== null) {
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
// Route Profiler
// ============================================

class RouteProfiler {
    constructor() {
        this.isActive = false;
        this.points = [];
        this.markers = [];
        this.legTypes = []; // 'bearing' or 'contour' for each leg
        this.chart = null;
        this.speed = 40; // Default speed value
        this.speedUnit = 'mmin'; // 'mmin', 'knots', or 'ms'

        // Contour mode state
        this.contourMode = false;
        this.contourTolerance = 2;
        this.contourTargetDepth = null;

        // Edit mode state (on by default)
        this.editMode = true;

        this.initUI();
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
            this.stopDrawing();
        });

        // Listeners for Controls
        this.speedInput.addEventListener('input', (e) => {
            this.speed = parseFloat(e.target.value) || 1;
            this.updateChartTimeLabels();
            if (this.currentProfileData && this.waypointDists) {
                this.updateWaypointTable(this.currentProfileData, this.waypointDists);
            }
        });

        this.unitSelect.addEventListener('change', (e) => {
            this.speedUnit = e.target.value;
            this.updateChartTimeLabels();
            if (this.currentProfileData && this.waypointDists) {
                this.updateWaypointTable(this.currentProfileData, this.waypointDists);
            }
        });

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
                this.stopDrawing(); // Cancel without saving
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
            editBtnInit.querySelector('.edit-label').textContent = 'editing';
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

            // Midpoint Marker Logic (Only in Edit Mode)
            if (this.editMode && distance < 40 && segmentIndex !== null) {
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

        if (distanceM === null) {
            this.hoverDistance = null; // Clear line
            this.chart.setActiveElements([], { x: 0, y: 0 });
            this.chart.update();
            return;
        }

        // Find closest data point
        let closestIdx = 0;
        let minDiff = Infinity;
        const data = this.chart.data.datasets[0].data;

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
            this.chart.update();

            // Update top bar to show profile depth
            updateCursorDepth(point.depth, point.lng, point.lat, 'On Profile:');
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

            // Only consider if in middle 90% of segment (avoid endpoints)
            if (dist < minDist && t >= 0.05 && t <= 0.95) {
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

            // Use mousedown to insert and immediately start dragging
            el.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                e.preventDefault(); // Prevent map pan

                // Insert point (skip profile generation for now)
                const newIndex = segmentIndex + 1;
                this.insertWaypointAtSegment(this.pendingInsertSegment, true);

                // Start dragging the new point immediately
                this.startManualDrag(newIndex);
            });

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
        this.points.splice(insertIndex, 0, [lngLat.lng, lngLat.lat]);
        this.legTypes.splice(segmentIndex, 0, 'bearing'); // Insert a new bearing leg

        // Recreate all markers to maintain correct indices
        this.rebuildMarkers();
        this.updateLineLayer();

        // Regenerate profile if we have one (unless skipped)
        if (!skipProfile && this.currentProfileData) {
            await this.generateProfile();
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

            if (this.currentProfileData) {
                await this.generateProfile();
            }
        };

        map.on('mousemove', onDragMove);
        map.on('mouseup', onDragEnd);
    }

    toggleEditMode() {
        this.editMode = !this.editMode;

        const editBtn = document.getElementById('edit-toggle-btn');
        if (editBtn) {
            if (this.editMode) {
                editBtn.classList.add('active');
                editBtn.querySelector('.edit-label').textContent = 'Lock';
            } else {
                editBtn.classList.remove('active');
                editBtn.querySelector('.edit-label').textContent = 'Edit';
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

            marker.on('drag', () => {
                const lngLat = marker.getLngLat();
                this.points[marker._pointIndex] = [lngLat.lng, lngLat.lat];
                this.updateLineLayer();

                // Redundant cleanup just in case
                if (this.hoverMarker) {
                    this.hoverMarker.remove();
                    this.hoverMarker = null;
                }
            });

            marker.on('dragend', async () => {
                const lngLat = marker.getLngLat();
                this.points[marker._pointIndex] = [lngLat.lng, lngLat.lat];
                this.updateLineLayer();
                if (this.points.length >= 2 && this.currentProfileData) {
                    await this.generateProfile();
                }
            });

            this.markers.push(marker);
        });
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

    stopDrawing() {
        this.isActive = false;

        // Reset overlay state
        this.startOverlay.classList.remove('hidden');
        this.startOverlay.classList.remove('background-hidden');

        this.startBtn.textContent = 'Start Profile';
        this.startBtn.classList.remove('complete-mode');

        this.finishBtn.classList.add('hidden');
        map.getCanvas().style.cursor = '';
        this.clearRoute();
    }

    addPoint(lngLat) {
        const pointIndex = this.points.length;
        this.points.push([lngLat.lng, lngLat.lat]);

        // Record leg type for this leg (the leg from previous point to this one)
        // First point has no leg, subsequent points create legs
        if (this.points.length > 1) {
            this.legTypes.push(this.contourMode ? 'contour' : 'bearing');
        }

        // Add visual marker with WP label (draggable)
        const el = document.createElement('div');
        el.className = 'wp-marker';
        el.setAttribute('data-label', `WP${pointIndex}`);

        const marker = new maplibregl.Marker({ element: el, draggable: true })
            .setLngLat(lngLat)
            .addTo(map);

        // Store index on marker for reference in handlers
        marker._pointIndex = pointIndex;

        // Live update during drag
        marker.on('drag', () => {
            const lngLat = marker.getLngLat();
            this.points[marker._pointIndex] = [lngLat.lng, lngLat.lat];
            this.updateLineLayer();
        });

        // Regenerate profile after drag ends
        marker.on('dragend', async () => {
            const lngLat = marker.getLngLat();
            this.points[marker._pointIndex] = [lngLat.lng, lngLat.lat];
            this.updateLineLayer();
            // Only regenerate if we have a complete route
            if (this.points.length >= 2 && this.currentProfileData) {
                await this.generateProfile();
            }
        });

        this.markers.push(marker);
        this.updateLineLayer();
    }

    updateLineLayer() {
        const geojson = {
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: this.points
            }
        };

        const source = map.getSource('route-line');
        if (source) {
            source.setData(geojson);
        } else {
            map.addSource('route-line', {
                type: 'geojson',
                data: geojson
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
                    'line-dasharray': [2, 1]
                }
            });
        }
    }

    async finishRoute() {
        if (this.points.length < 2) {
            this.stopDrawing();
            return;
        }

        this.isActive = false;
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
    }

    clearRoute() {
        this.points = [];
        this.markers.forEach(m => m.remove());
        this.markers = [];
        this.legTypes = [];
        this.currentProfileData = null;
        this.contourTargetDepth = null;

        const source = map.getSource('route-line');
        if (source) {
            source.setData({
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: [] }
            });
        }

        // Remove debug markers
        if (this.debugMarkers) {
            this.debugMarkers.forEach(m => m.remove());
            this.debugMarkers = [];
        }

        if (this.chart) {
            this.chart.data.datasets[0].data = [];
            this.chart.update();
        }
    }

    // ----------------------------------------------------------------
    // Profiling Logic
    // ----------------------------------------------------------------

    async generateProfile() {
        if (!this.chart) this.initChart();

        // Clear previous debug markers
        if (this.debugMarkers) {
            this.debugMarkers.forEach(m => m.remove());
        }
        this.debugMarkers = [];

        const samples = [];
        const numSamples = 150; // increased samples

        // Calculate total distance and segment lengths
        let totalLenM = 0;
        const dists = [0];

        for (let i = 0; i < this.points.length - 1; i++) {
            const d = this.haversineDistance(this.points[i], this.points[i + 1]);
            totalLenM += d;
            dists.push(totalLenM);
        }

        // Walk segments
        const profileData = [];

        // Always include start
        profileData.push({ dist: 0, depth: await queryDepth(this.points[0][0], this.points[0][1]) });

        // Walk segments to populate profileData
        for (let i = 0; i < this.points.length - 1; i++) {
            const p1 = this.points[i];
            const p2 = this.points[i + 1];
            const segLen = this.haversineDistance(p1, p2);
            const numSegSamples = Math.max(2, Math.floor((segLen / totalLenM) * numSamples));

            for (let j = 1; j <= numSegSamples; j++) {
                const t = j / numSegSamples;
                const lng = p1[0] + (p2[0] - p1[0]) * t;
                const lat = p1[1] + (p2[1] - p1[1]) * t;

                const distFromStart = dists[i] + (segLen * t);
                let depth = await queryDepth(lng, lat);

                // Visual Debug: Add yellow dots at sampled locations
                const el = document.createElement('div');
                el.className = 'debug-sample-marker';
                el.style.width = '4px';
                el.style.height = '4px';
                el.style.background = '#facc15'; // Yellow-400
                el.style.borderRadius = '50%';
                el.style.pointerEvents = 'none';

                // Only show every 5th point to save DOM
                if (j % 5 === 0) {
                    const m = new maplibregl.Marker({ element: el })
                        .setLngLat([lng, lat])
                        .addTo(map);
                    this.debugMarkers.push(m);
                }

                profileData.push({ dist: distFromStart, depth: depth, lat: lat, lng: lng });
            }
        }

        this.currentProfileData = profileData;

        // Save waypoint distances for chart rendering
        this.waypointDists = dists;

        this.updateChart();
        this.updateWaypointTable(profileData, dists);
    }

    updateWaypointTable(profileData, dists) {
        // Elements
        const sidebar = document.getElementById('waypoint-sidebar');
        const tableBody = document.querySelector('#waypoint-table tbody');
        const depthMinEl = document.getElementById('depth-min');
        const depthMaxEl = document.getElementById('depth-max');
        const depthAvgEl = document.getElementById('depth-avg');

        if (!sidebar || !tableBody) return;

        // Show sidebar if hidden
        if (this.points.length > 0) {
            sidebar.classList.remove('hidden');
        } else {
            sidebar.classList.add('hidden');
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

        let cumulativeTimeMin = 0;

        // Convert speed to meters/min based on unit
        let speedMetersPerMin;
        if (this.speedUnit === 'mmin') {
            speedMetersPerMin = this.speed; // Already in m/min
        } else if (this.speedUnit === 'ms') {
            speedMetersPerMin = this.speed * 60; // m/s to m/min
        } else {
            // knots: 1 knot = 1852 m/h = 30.866 m/min
            speedMetersPerMin = this.speed * 30.866;
        }

        let totalDistNM = 0;

        // Iterate through segments (points)
        for (let i = 0; i < this.points.length; i++) {
            const p = this.points[i];
            const isStart = i === 0;
            const isEnd = i === this.points.length - 1;

            // Calculate leg stats
            let distM = 0;
            let legTimeMin = 0;
            let bearing = 0;
            let depthMin = null;
            let depthMax = null;

            if (i < this.points.length - 1) {
                // Leg to next point
                distM = this.haversineDistance(this.points[i], this.points[i + 1]);
                legTimeMin = distM / speedMetersPerMin;
                bearing = this.calculateBearing(this.points[i], this.points[i + 1]);

                // Find depth range for this segment in profileData
                // Approximate range by distance
                const startDist = dists[i];
                const endDist = dists[i + 1];

                const legSamples = profileData.filter(d => d.dist >= startDist && d.dist <= endDist && d.depth !== null);
                if (legSamples.length > 0) {
                    depthMin = Math.min(...legSamples.map(d => d.depth));
                    depthMax = Math.max(...legSamples.map(d => d.depth));
                }
            }

            // Format time
            const hours = Math.floor(cumulativeTimeMin / 60);
            const mins = Math.floor(cumulativeTimeMin % 60);
            const timeStr = `${hours}:${mins.toString().padStart(2, '0')}`;

            // Format Pos as signed decimal degrees (Google Maps compatible)
            const lat = p[1].toFixed(4);
            const lon = p[0].toFixed(4);

            // Row HTML
            const tr = document.createElement('tr');

            if (isEnd) {
                tr.innerHTML = `
                    <td class="wp-time">${timeStr} <span style="font-size:0.6em; color:red">END</span></td>
                    <td class="wp-pos">${lat}<br>${lon}</td>
                    <td>-</td>
                    <td>-</td>
                    <td>-</td>
                    <td>-</td>
                `;
            } else {
                // Format distance based on selected unit
                const distUnitEl = document.getElementById('dist-unit');
                const distUnit = distUnitEl ? distUnitEl.value : 'm';
                let distStr;
                if (distUnit === 'm') {
                    distStr = `${Math.round(distM)} m`;
                } else if (distUnit === 'km') {
                    distStr = `${(distM / 1000).toFixed(2)} km`;
                } else {
                    distStr = `${(distM / 1852).toFixed(2)} nm`;
                }

                const durMin = Math.round(legTimeMin);
                const depthStr = (depthMin !== null && depthMax !== null)
                    ? `<span class="wp-depth">${Math.abs(depthMin).toFixed(0)}-${Math.abs(depthMax).toFixed(0)}m</span>`
                    : '-';

                tr.innerHTML = `
                    <td class="wp-time">${timeStr}</td>
                    <td class="wp-pos">${lat}<br>${lon}</td>
                    <td class="wp-val">${distStr}</td>
                    <td class="wp-val">${Math.round(bearing)}°</td>
                    <td class="wp-val">${durMin} min</td>
                    <td>${depthStr}</td>
                `;
            }

            tableBody.appendChild(tr);

            cumulativeTimeMin += legTimeMin;
            if (!isEnd) totalDistNM += distM / 1852;
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
                    backgroundColor: 'rgba(30, 64, 175, 0.2)',
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
                            // Generate ticks at sensible time intervals
                            callback: function (val, index, ticks) {
                                // Get profiler reference
                                const profiler = window.profiler;
                                if (!profiler) return '';

                                // Calculate speed in meters per minute
                                let speedMetersPerMin;
                                if (profiler.speedUnit === 'mmin') {
                                    speedMetersPerMin = profiler.speed;
                                } else if (profiler.speedUnit === 'ms') {
                                    speedMetersPerMin = profiler.speed * 60;
                                } else {
                                    // knots: 1 knot = 1852 m/h = 30.866 m/min
                                    speedMetersPerMin = profiler.speed * 30.866;
                                }

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

                                // Calculate time in minutes
                                const timeMin = distM / speedMetersPerMin;
                                return Math.round(timeMin);
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

                        // Draw Label
                        if (index > 0 && index < this.waypointDists.length) {
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

        this.updateChartTimeLabels();
        this.chart.update();
    }

    updateChartTimeLabels() {
        // The xTime axis callback is defined in chart init and uses window.profiler
        // to get live speed/unit values. We just need to trigger a redraw.
        if (this.chart) {
            this.chart.update();
        }
    }
}

// Initialize Profiler when map loads
map.on('load', () => {
    window.profiler = new RouteProfiler();
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

        // Set xTime axis options to match x axis range
        if (chart.options.scales.xTime) {
            chart.options.scales.xTime.min = minX;
            chart.options.scales.xTime.max = maxX;
        }
    }
};
Chart.register(syncAxesPlugin);
