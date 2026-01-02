/**
 * Western Australia Abandoned Mines Visualization
 * Interactive map showing historical mining sites
 */

// ============================================
// Constants & Configuration
// ============================================

const CONFIG = {
    // Data settings
    CSV_URL: 'wabmines.csv',

    // Visualization settings
    CIRCLE_OPACITY: 0.7, // 70% opacity
    DEFAULT_RADIUS: 5, // Default radius in meters

    // Color mapping for different feature types
    FEATURE_COLORS: {
        'Shaft': [139, 69, 19],              // Saddle brown
        'Adit': [101, 67, 33],               // Dark brown
        'Costean/Trench': [210, 180, 140],   // Tan
        'Pit/Quarry': [244, 164, 96],        // Sandy brown
        'Open Stope': [205, 133, 63],        // Peru
        'Waste Dump': [160, 120, 80],        // Medium brown
        'Tailings Dump': [180, 140, 100],    // Light brown
        'Other': [169, 169, 169]             // Gray for other/unknown
    },

    // Map bounds (will be calculated from data)
    INITIAL_VIEW: {
        lng: 121.5,
        lat: -30.0,
        zoom: 6
    }
};

// ============================================
// Utility Functions
// ============================================

/**
 * Normalize feature type to handle unknown/null/empty values
 */
function normalizeFeatureType(featureType) {
    if (!featureType || featureType === 'null' || featureType.trim() === '') {
        return 'Other';
    }
    // Check if the feature type matches one of our known types
    if (CONFIG.FEATURE_COLORS[featureType]) {
        return featureType;
    }
    return 'Other';
}

/**
 * Parse CSV text into array of objects
 */
function parseCSV(csvText) {
    const lines = csvText.trim().split('\n');
    const headers = lines[0].split(',');

    const features = [];
    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',');

        // Parse all fields dynamically based on headers
        const properties = {};
        for (let j = 0; j < headers.length; j++) {
            properties[headers[j]] = values[j] || '';
        }

        // Create GeoJSON-like feature object
        features.push({
            type: 'Feature',
            properties: properties,
            geometry: {
                type: 'Point',
                coordinates: [Number.parseFloat(properties.X), Number.parseFloat(properties.Y)]
            }
        });
    }

    return {
        type: 'FeatureCollection',
        features: features
    };
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

    // Visibility toggles for each feature type
    visibleFeatureTypes: {
        'Shaft': true,
        'Adit': true,
        'Costean/Trench': true,
        'Pit/Quarry': true,
        'Open Stope': true,
        'Waste Dump': true,
        'Tailings Dump': true,
        'Other': true
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
            }
        },
        layers: [
            {
                id: 'carto-light-layer',
                type: 'raster',
                source: 'carto-light',
                minzoom: 0,
                maxzoom: 22,
                layout: {
                    visibility: 'visible'
                }
            }
        ]
    },
    center: [CONFIG.INITIAL_VIEW.lng, CONFIG.INITIAL_VIEW.lat],
    zoom: CONFIG.INITIAL_VIEW.zoom,
    minZoom: 5,
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
    loadMines();
    initializeLegendToggles();
    initializeMobileLegendCollapse();
});

// Legend Toggle Functionality
function initializeLegendToggles() {
    const legendItems = document.querySelectorAll('.legend-item[data-feature-type]');

    for (const item of legendItems) {
        item.addEventListener('click', () => {
            const featureType = item.dataset.featureType;

            // Toggle visibility state
            state.visibleFeatureTypes[featureType] = !state.visibleFeatureTypes[featureType];

            // Toggle active class
            item.classList.toggle('active');

            // Re-render with updated visibility
            if (state.geojsonData) {
                renderMines(state.geojsonData);
            }
        });
    };
}

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

// Mobile Legend Collapse
function initializeMobileLegendCollapse() {
    const legendTitle = document.querySelector('.legend-title');
    const legendContent = document.querySelector('.legend-content');

    // Only collapse on mobile (check viewport width)
    const isMobile = () => window.innerWidth <= 768;

    // Start collapsed on mobile
    if (isMobile()) {
        legendTitle.classList.add('collapsed');
        legendContent.classList.add('collapsed');
    }

    legendTitle.addEventListener('click', () => {
        if (isMobile()) {
            legendTitle.classList.toggle('collapsed');
            legendContent.classList.toggle('collapsed');
        }
    });

    // Re-check on resize
    window.addEventListener('resize', () => {
        if (!isMobile()) {
            legendTitle.classList.remove('collapsed');
            legendContent.classList.remove('collapsed');
        }
    });
}

// ============================================
// Data Loading & Processing
// ============================================

function setLoadingText(text) {
    const el = document.getElementById('loading-text');
    if (el) el.textContent = text;
}

async function loadMines() {
    try {
        setLoadingText('Loading abandoned mines data...');

        const response = await fetch(CONFIG.CSV_URL);
        const csvText = await response.text();
        const geojson = parseCSV(csvText);

        state.geojsonData = geojson;

        // Update mine count
        document.getElementById('mine-count').textContent = geojson.features.length.toLocaleString();

        // Render mines
        renderMines(geojson);

        // Hide loading
        setTimeout(() => {
            document.getElementById('loading').classList.add('hidden');
        }, 500);

    } catch (error) {
        console.error('Failed to load mines:', error);
        setLoadingText('Failed to load data');
    }
}

// ============================================
// Rendering
// ============================================

function renderMines(geojson) {
    // Filter features based on visible feature types
    const visibleFeatures = geojson.features.filter(feature => {
        const featureType = normalizeFeatureType(feature.properties.FEATURE_TY);
        return state.visibleFeatureTypes[featureType] !== false;
    });

    // Create deck.gl layer
    const scatterplotLayer = new deck.ScatterplotLayer({
        id: 'mines',
        data: visibleFeatures,
        getPosition: d => d.geometry.coordinates,
        getRadius: d => CONFIG.DEFAULT_RADIUS,
        getFillColor: d => {
            const featureType = normalizeFeatureType(d.properties.FEATURE_TY);
            const color = CONFIG.FEATURE_COLORS[featureType] || CONFIG.FEATURE_COLORS.Other;
            return [...color, CONFIG.CIRCLE_OPACITY * 255];
        },
        onHover: e => {
            const mine = queryNearestMine(e);
            if (mine) {
                map.getCanvas().style.cursor = 'pointer'; // Change cursor
            }
            updateCursorInfo(mine, e.coordinate[0], e.coordinate[1]);
        },
        onClick: e => {
            const mine = queryNearestMine(e);
            if (mine) {
                showClickPopup(mine, e.coordinate[0], e.coordinate[1]);
            }
        },
        radiusUnits: 'meters',
        radiusMinPixels: 2,
        radiusMaxPixels: 50,
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

function queryNearestMine(e) {
    if (!state.geojsonData) return null;

    return e?.object;
}

function formatCoordinates(lng, lat) {
    const gmaps = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    const latM = (Math.abs(lat) % 1) * 60;
    const lngM = (Math.abs(lng) % 1) * 60;
    const dm = `${Math.floor(Math.abs(lat))}° ${latM.toFixed(3)}' ${lat >= 0 ? 'N' : 'S'}, ${Math.floor(Math.abs(lng))}° ${lngM.toFixed(3)}' ${lng >= 0 ? 'E' : 'W'}`;
    return { gmaps, display: dm };
}

function updateCursorInfo(mine, lng, lat) {
    const valueEl = document.getElementById('cursor-info-value');
    const coordsEl = document.getElementById('cursor-coords');
    if (mine) {
        const r = formatCoordinates(lng, lat);
        const props = mine.properties;
        const featureType = normalizeFeatureType(props.FEATURE_TY);
        const siteName = props.WABMINES_N || 'Unknown';
        valueEl.textContent = `${featureType} - ${siteName}`;
        coordsEl.innerHTML = `<span class="copyable" title="Copy decimal">${r.gmaps}</span><br><span class="copyable" title="Copy DM">${r.display}</span>`;
    } else {
        valueEl.textContent = '--';
        coordsEl.textContent = '--';
    }
}

function showClickPopup(mine, lng, lat) {
    const props = mine.properties;
    const featureType = normalizeFeatureType(props.FEATURE_TY);
    const siteName = props.WABMINES_N || 'Unknown';
    const commodities = props.COMMODITIE || 'Unknown';
    const condition = props.CONDITION || 'Unknown';
    const siteType = props.SITE_TYPE || 'Unknown';

    if (state.clickMarker) state.clickMarker.remove();
    if (state.clickPopup) state.clickPopup.remove();

    const el = document.createElement('div');
    el.className = 'click-marker';
    state.clickMarker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
    const trueLng = mine.geometry.coordinates[0];
    const trueLat = mine.geometry.coordinates[1];

    const r = formatCoordinates(trueLng, trueLat);
    state.clickPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, className: 'mine-popup', offset: 12 })
        .setLngLat([lng, lat])
        .setHTML(`
            <div class="popup-mine-info">
                <div class="popup-label">Site:</div>
                <div class="popup-value">${siteName}</div>
                <div class="popup-label">Feature:</div>
                <div class="popup-value">${featureType}</div>
                <div class="popup-label">Site Type:</div>
                <div class="popup-value">${siteType}</div>
                <div class="popup-label">Commodities:</div>
                <div class="popup-value">${commodities}</div>
                <div class="popup-label">Condition:</div>
                <div class="popup-value">${condition}</div>
                <div class="popup-label">Site Code:</div>
                <div class="popup-value">${props.SITE_CODE || 'N/A'}</div>
            </div>
            <div class="popup-coords copyable">${r.gmaps}</div>
            <div class="popup-coords-dm copyable">${r.display}</div>
            <button class="popup-share-btn" data-lat="${trueLat}" data-lng="${trueLng}">
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
            const url = `${globalThis.location.origin}${globalThis.location.pathname}#${lat.toFixed(6)},${lng.toFixed(6)}`;
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
        globalThis.removeEventListener('deviceorientation', handleDeviceOrientation);
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
                        globalThis.addEventListener('deviceorientation', handleDeviceOrientation);
                    }
                })
                .catch(console.error);
        } else {
            // Non-iOS or older iOS - just add listener
            globalThis.addEventListener('deviceorientation', handleDeviceOrientation);
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
