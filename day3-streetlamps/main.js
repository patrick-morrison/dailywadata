/**
 * Western Australia Streetlights Visualization
 * Interactive map showing public lighting infrastructure
 */

// ============================================
// Constants & Configuration
// ============================================

const CONFIG = {
    // Data settings
    GEOJSON_URL: 'streetlights.geojson',

    // Visualization settings
    CIRCLE_OPACITY: 0.8, // 80% opacity

    // Color mapping for different bulb types
    BULB_COLORS: {
        'Light-Emitting Diode': [255, 255, 255],       // #FFFFFF - White
        'Mercury Vapour/Universal': [216, 247, 255],   // #D8F7FF - Light blue
        'Low Pressure Sodium': [255, 209, 178],        // #FFD1B2 - Light orange/peach
        'Metal Halide': [242, 252, 255],               // #F2FCFF - Very light blue
        'High Pressure Sodium': [255, 184, 76],        // #FFB84C - Orange/amber
        'Compact Fluorescent': [255, 255, 220],        // #FFFFDC - Light yellow (default for CFL)
        'Unknown': [200, 200, 200]                     // Gray for unknown/empty/null
    },

    // Radius scaling configuration - Linear formula: radius = wattage * scale
    // Manually tune the scale factor for each bulb type
    RADIUS_SCALES: {
        'Light-Emitting Diode': 0.3,
        'Mercury Vapour/Universal': 0.2,
        'High Pressure Sodium': 0.15,
        'Compact Fluorescent': 0.25,
        'Metal Halide': 0.2,
        'Low Pressure Sodium': 0.1,
        'Unknown': 0.3
    },

    // Map bounds (will be calculated from data)
    INITIAL_VIEW: {
        lng: 115.8605,
        lat: -31.9505,
        zoom: 10
    }
};

// ============================================
// Utility Functions
// ============================================

/**
 * Normalize bulb type to handle unknown/null/empty values
 */
function normalizeBulbType(bulbType) {
    if (!bulbType || bulbType === 'null' || bulbType.trim() === '') {
        return 'Unknown';
    }
    return bulbType;
}

// ============================================
// State Management
// ============================================

const state = {
    geojsonData: null,
    deckOverlay: null,

    // Markers
    clickMarker: null,
    clickPopup: null,

    // Geolocation
    userLocationMarker: null,
    watchId: null,
    isTracking: false,
    deviceHeading: null,

    // Visibility toggles for each bulb type
    visibleBulbTypes: {
        'Light-Emitting Diode': true,
        'Mercury Vapour/Universal': true,
        'High Pressure Sodium': true,
        'Compact Fluorescent': true,
        'Metal Halide': true,
        'Low Pressure Sodium': true,
        'Unknown': true
    }
};

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
            },
            'carto-dark': {
                type: 'raster',
                tiles: [
                    'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
                    'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
                    'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'
                ],
                tileSize: 256
            }
        },
        layers: [
            {
                id: 'carto-light-layer',
                type: 'raster',
                source: 'carto-light',
                minzoom: 0,
                maxzoom: 22
            },
            {
                id: 'carto-dark-layer',
                type: 'raster',
                source: 'carto-dark',
                minzoom: 0,
                maxzoom: 22,
                layout: {
                    visibility: 'none'
                }
            }
        ]
    },
    center: [CONFIG.INITIAL_VIEW.lng, CONFIG.INITIAL_VIEW.lat],
    zoom: CONFIG.INITIAL_VIEW.zoom,
    minZoom: 7,
    maxZoom: 18,
    maxPitch: 0,
    dragRotate: false,
    customAttribution: '© <a href="https://data.wa.gov.au">Data WA</a> © CARTO © OpenStreetMap contributors',
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
    loadStreetlights();
    initializeLegendToggles();
    initializeDarkMode();
});

// Legend Toggle Functionality
function initializeLegendToggles() {
    const legendItems = document.querySelectorAll('.legend-item[data-bulb-type]');

    for (const item of legendItems) {
        item.addEventListener('click', () => {
            const bulbType = item.dataset.bulbType;

            // Toggle visibility state
            state.visibleBulbTypes[bulbType] = !state.visibleBulbTypes[bulbType];

            // Toggle active class
            item.classList.toggle('active');

            // Re-render with updated visibility
            if (state.geojsonData) {
                renderStreetlights(state.geojsonData);
            }
        });
    };
}

// Interactions
map.on('mousemove', (e) => {
    const light = queryNearestLight(e.lngLat.lng, e.lngLat.lat);
    updateCursorInfo(light, e.lngLat.lng, e.lngLat.lat);
});

map.on('click', async (e) => {
    const light = queryNearestLight(e.lngLat.lng, e.lngLat.lat);
    if (light) {
        showClickPopup(light, e.lngLat.lng, e.lngLat.lat);
    }
});

// Context Menu (Right Click)
map.on('contextmenu', async (e) => {
    const existing = document.getElementById('context-menu');
    if (existing) existing.remove();

    const { lng, lat } = e.lngLat;
    const coords = formatCoordinates(lng, lat);

    // Create menu
    const menu = document.createElement('div');
    menu.id = 'context-menu';
    menu.className = 'context-menu';
    menu.style.left = `${e.point.x}px`;
    menu.style.top = `${e.point.y}px`;

    // Menu Items
    let menuHtml = `
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
        const url = `${globalThis.location.origin}${globalThis.location.pathname}#${lat.toFixed(6)},${lng.toFixed(6)}`;
        navigator.clipboard.writeText(url);
        menu.remove();
    });

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

document.getElementById('location-btn').addEventListener('click', toggleGeolocation);

// Dark Mode Toggle
function initializeDarkMode() {
    // Restore dark mode state from localStorage
    const isDark = localStorage.getItem('darkMode') === 'true';
    const checkbox = document.getElementById('dark-mode-checkbox');

    // Set checkbox state
    checkbox.checked = isDark;

    // Apply dark mode if enabled
    if (isDark) {
        map.setLayoutProperty('carto-light-layer', 'visibility', 'none');
        map.setLayoutProperty('carto-dark-layer', 'visibility', 'visible');
    }
}

document.getElementById('dark-mode-checkbox').addEventListener('change', (e) => {
    const isDark = e.target.checked;

    // Save state to localStorage
    localStorage.setItem('darkMode', isDark.toString());

    // Apply dark mode
    if (isDark) {
        map.setLayoutProperty('carto-light-layer', 'visibility', 'none');
        map.setLayoutProperty('carto-dark-layer', 'visibility', 'visible');
    } else {
        map.setLayoutProperty('carto-dark-layer', 'visibility', 'none');
        map.setLayoutProperty('carto-light-layer', 'visibility', 'visible');
    }
});

// ============================================
// Data Loading & Processing
// ============================================

function setLoadingText(text) {
    const el = document.getElementById('loading-text');
    if (el) el.textContent = text;
}

async function loadStreetlights() {
    try {
        setLoadingText('Loading streetlight data...');

        const response = await fetch(CONFIG.GEOJSON_URL);
        const geojson = await response.json();

        state.geojsonData = geojson;

        // Update light count
        document.getElementById('light-count').textContent = geojson.features.length.toLocaleString();

        // Calculate bounds
        const bounds = calculateBounds(geojson);

        // Render streetlights
        renderStreetlights(geojson);

        // Fit map to bounds
        map.fitBounds(bounds, {
            padding: { top: 100, bottom: 100, left: 100, right: 100 },
            duration: 2000
        });

        // Hide loading
        setTimeout(() => {
            document.getElementById('loading').classList.add('hidden');
        }, 500);

    } catch (error) {
        console.error('Failed to load streetlights:', error);
        setLoadingText('Failed to load data');
    }
}

function calculateBounds(geojson) {
    let minLng = Infinity, maxLng = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;

    for (const feature of geojson.features) {
        const [lng, lat] = feature.geometry.coordinates;
        minLng = Math.min(minLng, lng);
        maxLng = Math.max(maxLng, lng);
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
    };

    return [[minLng, minLat], [maxLng, maxLat]];
}

// ============================================
// Rendering
// ============================================

function renderStreetlights(geojson) {
    // Filter features based on visible bulb types
    const visibleFeatures = geojson.features.filter(feature => {
        const bulbType = normalizeBulbType(feature.properties.bulb_type);
        return state.visibleBulbTypes[bulbType] !== false;
    });

    // Create deck.gl layer
    const scatterplotLayer = new deck.ScatterplotLayer({
        id: 'streetlights',
        data: visibleFeatures,
        getPosition: d => d.geometry.coordinates,
        getRadius: d => {
            const bulbType = normalizeBulbType(d.properties.bulb_type);
            const wattage = Number.parseFloat(d.properties.bulb_watts);

            // Get scale factor for this bulb type
            const scale = CONFIG.RADIUS_SCALES[bulbType] || CONFIG.RADIUS_SCALES.Unknown;

            // Calculate radius using linear formula: radius = wattage * scale
            // Default to 10m if wattage is null/invalid
            if (Number.isNaN(wattage) || wattage === null) {
                return 10;
            }

            return wattage * scale;
        },
        getFillColor: d => {
            const bulbType = normalizeBulbType(d.properties.bulb_type);
            const color = CONFIG.BULB_COLORS[bulbType] || CONFIG.BULB_COLORS.Unknown;
            return [...color, CONFIG.CIRCLE_OPACITY * 255];
        },
        radiusUnits: 'meters',
        radiusMinPixels: 1,
        radiusMaxPixels: 100,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 100]
    });

    if (state.deckOverlay) map.removeControl(state.deckOverlay);
    state.deckOverlay = new deck.MapboxOverlay({ layers: [scatterplotLayer] });
    map.addControl(state.deckOverlay);
}

// ============================================
// Utilities
// ============================================

function queryNearestLight(lng, lat) {
    if (!state.geojsonData) return null;

    let nearest = null;
    let minDist = Infinity;

    // Simple distance check (only check if within reasonable range)
    const maxDist = 0.001; // roughly 100m in degrees

    for (const feature of state.geojsonData.features) {
        // Only consider lights that are currently visible
        const bulbType = normalizeBulbType(feature.properties.bulb_type);
        if (state.visibleBulbTypes[bulbType] === false) {
            return; // Skip this feature if its type is hidden
        }

        const [fLng, fLat] = feature.geometry.coordinates;
        const dx = fLng - lng;
        const dy = fLat - lat;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < maxDist && dist < minDist) {
            minDist = dist;
            nearest = feature;
        }
    };

    return nearest;
}

function formatCoordinates(lng, lat) {
    const gmaps = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    const latM = (Math.abs(lat) % 1) * 60;
    const lngM = (Math.abs(lng) % 1) * 60;
    const dm = `${Math.floor(Math.abs(lat))}° ${latM.toFixed(3)}' ${lat >= 0 ? 'N' : 'S'}, ${Math.floor(Math.abs(lng))}° ${lngM.toFixed(3)}' ${lng >= 0 ? 'E' : 'W'}`;
    return { gmaps, display: dm };
}

function updateCursorInfo(light, lng, lat) {
    const valueEl = document.getElementById('cursor-info-value');
    const coordsEl = document.getElementById('cursor-coords');
    if (light) {
        const r = formatCoordinates(lng, lat);
        const props = light.properties;
        const bulbType = normalizeBulbType(props.bulb_type);
        valueEl.textContent = `${bulbType} (${props.bulb_watts}W)`;
        coordsEl.innerHTML = `<span class="copyable" title="Copy decimal">${r.gmaps}</span><br><span class="copyable" title="Copy DM">${r.display}</span>`;
    } else {
        valueEl.textContent = '--';
        coordsEl.textContent = '--';
    }
}

function showClickPopup(light, lng, lat) {
    const r = formatCoordinates(lng, lat);
    const props = light.properties;
    const bulbType = normalizeBulbType(props.bulb_type);

    if (state.clickMarker) state.clickMarker.remove();
    if (state.clickPopup) state.clickPopup.remove();

    const el = document.createElement('div');
    el.className = 'click-marker';
    state.clickMarker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);

    state.clickPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, className: 'light-popup', offset: 12 })
        .setLngLat([lng, lat])
        .setHTML(`
            <div class="popup-light-info">
                <div class="popup-label">Type:</div>
                <div class="popup-value">${bulbType}</div>
                <div class="popup-label">Power:</div>
                <div class="popup-value">${props.bulb_watts}W</div>
                <div class="popup-label">ID:</div>
                <div class="popup-value">${props.pick_id}</div>
            </div>
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

// ============================================
// Geolocation
// ============================================

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
