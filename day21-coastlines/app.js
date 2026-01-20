// Splash screen handler
const splash = document.getElementById('splash');
const splashContent = document.querySelector('.splash-content');

function closeSplash() {
    splash.classList.add('hidden');
}

document.getElementById('enterMapBtn').addEventListener('click', closeSplash);

// Close splash when clicking outside the content area
splash.addEventListener('click', (e) => {
    if (!splashContent.contains(e.target)) {
        closeSplash();
    }
});

const map = L.map('map', { center: [-16.6569, 122.7197], zoom: 12, maxZoom: 18 });

L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Esri, Vantor, Earthstar Geographics, and the GIS User Community',
    maxZoom: 18
}).addTo(map);

const wfsUrl = 'https://public-services.slip.wa.gov.au/public/services/SLIP_Public_Services/Environment_WFS/MapServer/WFSServer';

const timePeriods = [
    { layer: 'esri:High_Tide__DPIRD-094__2016-01-01_to_2016-06-30', period: '2016', color: '#ff4444' },
    { layer: 'esri:High_Tide__DPIRD-094__2017-01-01_to_2017-06-30', period: '2017', color: '#ff8844' },
    { layer: 'esri:High_Tide__DPIRD-094__2018-01-01_to_2018-06-30', period: '2018', color: '#ffcc44' },
    { layer: 'esri:High_Tide__DPIRD-094__2019-01-01_to_2019-06-30', period: '2019', color: '#88ff44' },
    { layer: 'esri:High_Tide__DPIRD-094__2020-01-01_to_2020-06-30', period: '2020', color: '#44ffcc' },
    { layer: 'esri:High_Tide__DPIRD-094__2021-01-01_to_2021-06-30', period: '2021', color: '#4488ff' },
    { layer: 'esri:High_Tide__DPIRD-094__2022-01-01_to_2022-06-30', period: '2022', color: '#4444ff' }
];

const coastlineLayers = {};
const lineWeight = 4;
const minZoomForData = 8; // Minimum zoom level to request WFS data

// Swap coordinates from [lat, lon] to [lon, lat] for GeoJSON
const swapCoords = (coords) => {
    if (typeof coords[0] === 'number') return [coords[1], coords[0]];
    return coords.map(swapCoords);
};

async function loadWFSLayer(layerName, color) {
    const bounds = map.getBounds();
    // WFS 2.0.0 with EPSG:4326 expects lat,lon order (south,west,north,east)
    const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
    const url = `${wfsUrl}?service=WFS&version=2.0.0&request=GetFeature&typeName=${encodeURIComponent(layerName)}&outputFormat=geojson&srsName=EPSG:4326&bbox=${bbox}`;

    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();
        if (!data.features?.length) return null;

        data.features.forEach(f => {
            if (f.geometry?.coordinates) f.geometry.coordinates = swapCoords(f.geometry.coordinates);
        });

        return L.geoJSON(data, { style: { color, weight: lineWeight, opacity: 1 } });
    } catch {
        return null;
    }
}

function setSpinner(layerKey, active) {
    const spinner = document.getElementById(`spinner-${layerKey}`);
    if (spinner) {
        spinner.classList.toggle('active', active);
    }
}

function updateZoomMessage() {
    const zoomMsg = document.getElementById('zoomMessage');
    if (map.getZoom() < minZoomForData) {
        zoomMsg.classList.add('visible');
    } else {
        zoomMsg.classList.remove('visible');
    }
}

async function loadAllLayers() {
    updateZoomMessage();

    // Don't load data if zoomed out too far
    if (map.getZoom() < minZoomForData) {
        // Clear existing layers when zoomed out
        Object.keys(coastlineLayers).forEach(key => {
            const layer = coastlineLayers[key];
            if (layer && map.hasLayer(layer)) map.removeLayer(layer);
            delete coastlineLayers[key];
        });
        return;
    }

    // Mark loading started - this will pause animation
    isLoading = true;

    // Load all layers in parallel (keep existing layers visible during load)
    const currentLoadId = Date.now();
    loadAllLayers.currentId = currentLoadId;

    // During animation, load ALL layers (but only show active one)
    // Otherwise, only load enabled layers
    const layersToLoad = isAnimating
        ? timePeriods.map(p => p.layer)
        : timePeriods.filter(p => layerEnabled[p.layer]).map(p => p.layer);

    // Show spinners for layers being loaded
    timePeriods.forEach(period => {
        if (layersToLoad.includes(period.layer)) {
            setSpinner(period.layer, true);
        }
    });

    const results = await Promise.all(
        timePeriods.map(async period => {
            if (!layersToLoad.includes(period.layer)) return { key: period.layer, layer: null };
            const layer = await loadWFSLayer(period.layer, period.color);
            // Hide spinner when this layer finishes loading
            setSpinner(period.layer, false);
            return { key: period.layer, layer };
        })
    );

    // Only update layers if this is still the current load (not superseded by a newer one)
    if (loadAllLayers.currentId !== currentLoadId) return;

    // Now remove old layers and add new ones
    Object.keys(coastlineLayers).forEach(key => {
        const layer = coastlineLayers[key];
        if (layer && map.hasLayer(layer)) map.removeLayer(layer);
        delete coastlineLayers[key];
    });

    // Store new layers and add to map based on visibility
    results.forEach(({ key, layer }) => {
        if (layer) {
            coastlineLayers[key] = layer;
            // During animation, only show the currently active layer
            // Otherwise, show all enabled layers
            if (isAnimating) {
                const activeLayerKey = timePeriods[animationIndex].layer;
                if (key === activeLayerKey) layer.addTo(map);
            } else if (layerEnabled[key]) {
                layer.addTo(map);
            }
        }
    });

    // Mark loading complete and resume animation if it was paused
    isLoading = false;
    resumeAnimationIfPaused();
}

// Track which layers are enabled (all datasets enabled by default)
const layerEnabled = {};
timePeriods.forEach(p => layerEnabled[p.layer] = true);

// Build toggle controls
const toggleContainer = document.getElementById('yearToggles');
timePeriods.forEach(period => {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = layerEnabled[period.layer];
    checkbox.id = `toggle-${period.layer}`;
    checkbox.addEventListener('change', e => {
        layerEnabled[period.layer] = e.target.checked;
        const layer = coastlineLayers[period.layer];
        if (layer) {
            if (e.target.checked && !map.hasLayer(layer)) {
                layer.addTo(map);
            } else if (!e.target.checked && map.hasLayer(layer)) {
                map.removeLayer(layer);
            }
        }
    });

    const colorBox = document.createElement('div');
    colorBox.className = 'color-box';
    colorBox.style.background = period.color;

    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    spinner.id = `spinner-${period.layer}`;

    label.appendChild(checkbox);
    label.appendChild(colorBox);
    label.appendChild(document.createTextNode(period.period));
    label.appendChild(spinner);
    toggleContainer.appendChild(label);
});

// Add zoom message
const zoomMessage = document.createElement('div');
zoomMessage.className = 'zoom-message';
zoomMessage.id = 'zoomMessage';
zoomMessage.textContent = `Zoom in to load data (level ${minZoomForData}+)`;
toggleContainer.appendChild(zoomMessage);

// Animation controls
let animationInterval = null;
let animationIndex = 0;
let isAnimating = false;
let animationPaused = false;
let isLoading = false;
const animateBtn = document.getElementById('animateBtn');
const animationYearSpan = document.getElementById('animationYear');

function showOnlyYear(index) {
    timePeriods.forEach((period, i) => {
        const layer = coastlineLayers[period.layer];
        const checkbox = document.getElementById(`toggle-${period.layer}`);
        if (i === index) {
            layerEnabled[period.layer] = true;
            if (checkbox) checkbox.checked = true;
            if (layer && !map.hasLayer(layer)) layer.addTo(map);
            animationYearSpan.textContent = period.period;
        } else {
            layerEnabled[period.layer] = false;
            if (checkbox) checkbox.checked = false;
            if (layer && map.hasLayer(layer)) map.removeLayer(layer);
        }
    });
}

function animationStep() {
    // Don't advance if loading - animation is paused
    if (isLoading) {
        animationPaused = true;
        return;
    }
    animationPaused = false;
    animationIndex = (animationIndex + 1) % timePeriods.length;
    showOnlyYear(animationIndex);
}

function startAnimation() {
    animateBtn.textContent = 'Stop';
    animateBtn.classList.add('playing');
    isAnimating = true;
    animationPaused = false;

    // Check if only one layer is active, start from that layer
    const activeLayers = timePeriods.filter(p => layerEnabled[p.layer]);
    if (activeLayers.length === 1) {
        animationIndex = timePeriods.findIndex(p => p.layer === activeLayers[0].layer);
    } else {
        animationIndex = 0;
    }
    showOnlyYear(animationIndex);

    animationInterval = setInterval(animationStep, 1000);
}

function stopAnimation() {
    clearInterval(animationInterval);
    animationInterval = null;
    animateBtn.textContent = 'Play Animation';
    animateBtn.classList.remove('playing');
    animationYearSpan.textContent = '';
    isAnimating = false;
    animationPaused = false;

    // Keep only the last active layer visible (don't change anything)
}

function resumeAnimationIfPaused() {
    if (isAnimating && animationPaused && !isLoading) {
        animationPaused = false;
        // Show the current year's layer now that data is loaded
        showOnlyYear(animationIndex);
        // Reset the interval so user gets full viewing time for this frame
        clearInterval(animationInterval);
        animationInterval = setInterval(animationStep, 1000);
    }
}

animateBtn.addEventListener('click', () => {
    if (animationInterval) {
        stopAnimation();
    } else {
        startAnimation();
    }
});

// Debounced reload on pan/zoom (only fetch after the map settles)
let loadTimeout;
let initialLoadDone = false;
const loadDelayMs = 500;

function scheduleLoad() {
    clearTimeout(loadTimeout);
    loadTimeout = setTimeout(() => {
        loadAllLayers();
        if (!initialLoadDone) initialLoadDone = true;
    }, loadDelayMs);
}

map.on('moveend', () => {
    if (!initialLoadDone) return;
    scheduleLoad();
});

L.control.scale({ metric: true, imperial: false }).addTo(map);
map.attributionControl.setPrefix('v1.2.0 | Leaflet');

// Cursor coordinates display
const cursorCoords = document.getElementById('cursorCoords');
map.on('mousemove', e => {
    cursorCoords.textContent = `Lat: ${e.latlng.lat.toFixed(4)}, Lng: ${e.latlng.lng.toFixed(4)}`;
});

// Initial load after a brief delay to ensure map is ready
setTimeout(() => {
    scheduleLoad();
}, 100);
