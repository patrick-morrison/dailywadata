/**
 * Wadjemup Rottnest Bathymetry Visualization
 * Interactive depth map with hillshade rendering
 */

// ============================================
// Constants & Configuration
// ============================================

const CONFIG = {
    // Data settings
    COG_URL: (window.PAGE_CONFIG && window.PAGE_CONFIG.cogUrl) || 'dot_lidar.tif',
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

    // Bathymetry Bounds (hardcoded from dot_lidar.tif metadata)
    BOUNDS: {
        west: 115.37587,
        south: -32.54788,
        east: 115.92144,
        north: -31.41488,
        mercator: [12843583.026, -3835444.667, 12904315.769, -3686746.619]
    },

    // Calculate initial view from bounds
    get INITIAL_VIEW() {
        return {
            lng: (this.BOUNDS.west + this.BOUNDS.east) / 2,
            lat: (this.BOUNDS.south + this.BOUNDS.north) / 2,
            zoom: 10 // Temporary, fitBounds will override
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
    const pois = (window.PAGE_CONFIG && window.PAGE_CONFIG.pois) || [];
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
    const depth = await queryDepth(e.lngLat.lng, e.lngLat.lat);
    updateCursorDepth(depth, e.lngLat.lng, e.lngLat.lat);
});

map.on('click', async (e) => {
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

        // Use hardcoded bounds for instant setup
        state.bounds = {
            ...CONFIG.BOUNDS,
            mercatorBbox: CONFIG.BOUNDS.mercator,
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
        const depth = data[i];
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

    if (state.deckOverlay) map.removeControl(state.deckOverlay);
    state.deckOverlay = new deck.MapboxOverlay({ layers: [bitmapLayer] });
    map.addControl(state.deckOverlay);
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
        const depth = value[0][0];
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
            const z = data[idx] * state.exaggeration;

            // Simple logic: if neighbors are nodata, flatten
            if (z < -1000) { hillshade[idx] = 0; continue; }

            // Neighbors
            const zL = data[idx - 1] * state.exaggeration;
            const zR = data[idx + 1] * state.exaggeration;
            const zU = data[(y - 1) * width + x] * state.exaggeration;
            const zD = data[(y + 1) * width + x] * state.exaggeration;

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

function updateCursorDepth(depth, lng, lat) {
    const valueEl = document.getElementById('cursor-depth-value');
    const coordsEl = document.getElementById('cursor-coords');
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
