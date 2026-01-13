/**
 * Trees Perth - Radar Map Logic (Mobile Only + Shaded Rings + Pure Radar)
 */

// ============================================
// Constants & Configuration
// ============================================

const CONFIG = {
    CSV_URL: 'Trees_in_the_City.csv',
    RADAR_RADIUS: 30,
    VISUAL_RADIUS: 30,
    FADE_START: 10,
    FADE_END: 30,
    COLORS: {
        NORMAL: [85, 107, 85],
        RARE: [218, 165, 32],
        HISTORIC: [70, 130, 180],
        COMMUNITY: [100, 149, 237],
        SIGNIFICANT_GROUP: [65, 105, 225],
        SELECTED: [50, 200, 50],
        RINGS: [0, 0, 0, 0],
        RING_STROKE: [74, 93, 74, 80]
    },
    LOCKED_PITCH: 0
};

// ============================================
// State Management
// ============================================

const state = {
    allTrees: [],
    nearbyTrees: [],
    userPos: null,
    smoothedPos: null,
    displayPos: null,
    heading: 0,
    deckOverlay: null,
    selectedIndex: -1,
    watchId: null,
    isTracking: false,
    radarRings: [],
    seenSpecies: {},
    activeTab: 'nearby',
    selectedCollectionSpecies: null,
    lastListUpdate: 0,
    positionLoop: null,
    lastPositionTime: null,
    watchdogTimer: null
};

// ============================================
// Math Utils
// ============================================

const EARTH_RADIUS = 6378137;

function mercatorToLngLat(x, y) {
    const lng = (x * 180) / (Math.PI * EARTH_RADIUS);
    const lat = (Math.atan(Math.exp((y * Math.PI) / (Math.PI * EARTH_RADIUS))) * 360) / Math.PI - 90;
    return [lng, lat];
}

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) *
        Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function getBearing(lat1, lon1, lat2, lon2) {
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) -
        Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

    const θ = Math.atan2(y, x);
    return (θ * 180 / Math.PI + 360) % 360;
}

function findNearestTree(lat, lng) {
    let nearest = null;
    let minDist = Infinity;

    for (const tree of state.allTrees) {
        const d = getDistance(lat, lng, tree.position[1], tree.position[0]);
        if (d < minDist) {
            minDist = d;
            nearest = tree;
        }
    }
    return { tree: nearest, distance: minDist };
}

// ============================================
// Seen Species Storage (localStorage)
// ============================================

const STORAGE_KEY = 'treesPerth_seenSpecies';

function loadSeenSpecies() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            state.seenSpecies = JSON.parse(stored);
        }
    } catch (e) {
        console.warn('Failed to load seen species:', e);
        state.seenSpecies = {};
    }
}

function saveSeenSpecies() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state.seenSpecies));
    } catch (e) {
        console.warn('Failed to save seen species:', e);
    }
}

function markSpeciesSeen(speciesName, tree) {
    if (state.seenSpecies[speciesName]) return; // Already seen

    state.seenSpecies[speciesName] = {
        firstSeenAt: new Date().toISOString(),
        treeId: tree.id,
        botanical: tree.botanical || null
    };
    saveSeenSpecies();

    // Force immediate update - bypass throttle
    state.lastListUpdate = 0;
    updateUI();
    updateProgressBar();
    updateCollectionList();
    renderDeck();
}

// ============================================
// Collection & Tab Logic
// ============================================

function toggleTab(tabName) {
    state.activeTab = tabName;

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    document.body.setAttribute('data-tab', tabName);

    const isNearby = tabName === 'nearby';
    document.getElementById('tree-list').style.display = isNearby ? 'block' : 'none';
    document.getElementById('collection-list').style.display = isNearby ? 'none' : 'block';
    document.getElementById('progress-container').style.display = 'block';
    document.querySelector('.radar-status').style.display = isNearby ? 'block' : 'none';

    try {
        if (isNearby) {
            if (map.getLayer('carto-positron')) {
                map.setLayoutProperty('carto-positron', 'visibility', 'visible');
            }

            map.boxZoom.disable();
            map.doubleClickZoom.disable();
            map.dragPan.disable();
            map.dragRotate.disable();
            map.keyboard.disable();
            map.scrollZoom.disable();
            map.touchZoomRotate.disable();
        } else {
            if (map.getLayer('carto-positron')) {
                map.setLayoutProperty('carto-positron', 'visibility', 'visible');
            }

            const collectedTrees = state.allTrees.filter(t => isSpeciesSeen(t.name));
            if (collectedTrees.length > 0) {
                const lngs = collectedTrees.map(t => t.position[0]);
                const lats = collectedTrees.map(t => t.position[1]);
                const bounds = [
                    [Math.min(...lngs), Math.min(...lats)],
                    [Math.max(...lngs), Math.max(...lats)]
                ];
                map.fitBounds(bounds, {
                    padding: 50,
                    pitch: 0,
                    bearing: 0,
                    duration: 500
                });
            } else if (state.userPos) {
                map.jumpTo({
                    center: [state.userPos.lng, state.userPos.lat],
                    zoom: 13,
                    pitch: 0,
                    bearing: 0
                });
            }

            map.boxZoom.enable();
            map.doubleClickZoom.enable();
            map.dragPan.enable();
            map.dragRotate.enable();
            map.keyboard.enable();
            map.scrollZoom.enable();
            map.touchZoomRotate.enable();
        }
    } catch (e) {
        console.warn("Map interaction error:", e);
    }

    state.selectedCollectionSpecies = null;
    renderDeck();

    if (!isNearby) {
        updateCollectionList();
    }
}

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleTab(btn.dataset.tab));
});

function isSpeciesSeen(speciesName) {
    return !!state.seenSpecies[speciesName];
}

// Load on init
loadSeenSpecies();

// ============================================
// Dynamic Zoom Calculation
// ============================================

function calculateOptimalZoom(lat) {
    const container = document.getElementById('map');
    if (!container) return 18;

    // Default if no lat provided
    if (lat === null || lat === undefined) return 13;

    // We want 60m (diameter for 30m radius) to fit in the smallest dimension
    const minDim = Math.min(container.clientWidth, container.clientHeight);

    // Target size: fit within full width (no margin)
    // 30m radius = 60m diameter
    // We want 60 meters to be represented by minDim pixels.
    const targetPixels = minDim;

    const C = 156543.03;
    const latRad = lat * Math.PI / 180;

    // 2^z = (C * cos(lat) * targetPixels) / 60
    const z = Math.log2((C * Math.cos(latRad) * targetPixels) / 60);
    return z - 1; // Adjust for MapLibre 512px base sizing
}

// ============================================
// Map Initialization
// ============================================

const initialZoom = 13;
const defaultCenter = [115.8605, -31.9505];

const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        sources: {
            'carto': {
                type: 'raster',
                tiles: [
                    'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
                    'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png'
                ],
                tileSize: 256,
                attribution: '&copy; CARTO'
            }
        },
        layers: [
            {
                id: 'carto-positron',
                type: 'raster',
                source: 'carto',
                layout: { visibility: 'visible' },
                paint: { 'raster-opacity': 0.8 }
            }
        ]
    },
    center: defaultCenter,
    zoom: initialZoom,
    pitch: CONFIG.LOCKED_PITCH,
    attributionControl: false,
    interactive: false
});

map.on('resize', () => {
    if (state.userPos) {
        const newZoom = calculateOptimalZoom(state.userPos.lat);
        map.jumpTo({ zoom: newZoom });
    }
});

map.on('load', () => {
    if (state.userPos) {
        const newZoom = calculateOptimalZoom(state.userPos.lat);
        map.jumpTo({ zoom: newZoom });
    }

    setTimeout(() => {
        showEnableLocationButton();
        if (!state.userPos) greyOutRadar();
    }, 100);
});


// ============================================
// Data Loading
// ============================================

Papa.parse(CONFIG.CSV_URL, {
    download: true,
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
    complete: (results) => {
        processData(results.data);
    }
});

function processData(rawData) {
    const processed = [];
    const currentYear = new Date().getFullYear();

    for (const row of rawData) {
        if (typeof row.X !== 'number' || typeof row.Y !== 'number') continue;
        const [lng, lat] = mercatorToLngLat(row.X, row.Y);

        let isSignificant = false;
        if (row.HISTORIC_SIGNIFICANCE === 'Yes' ||
            row.COMMUNITY_SIGNIFICANCE === 'Yes' ||
            row.SIGNIFICANT_GROUP === 'Yes') {
            isSignificant = true;
        }

        const yearPlanted = row.DATE_PLANTED ? new Date(row.DATE_PLANTED).getFullYear() : null;
        const age = yearPlanted ? currentYear - yearPlanted : null;

        processed.push({
            id: row.TREE_ID,
            position: [lng, lat],
            name: row.COMMON_NAME || 'Unknown Tree',
            botanical: row.BOTANICAL_NAME || null,
            height: row.TREE_HEIGHT || null,
            age: age,
            isRare: row.RARE_SPECIES === 'Yes',
            historicSignificance: row.HISTORIC_SIGNIFICANCE === 'Yes',
            communitySignificance: row.COMMUNITY_SIGNIFICANCE === 'Yes',
            significantGroup: row.SIGNIFICANT_GROUP === 'Yes',
            significant: isSignificant
        });
    }

    state.allTrees = processed;

    // Initial Radar Update (Only if location known)
    if (state.userPos) {
        updateRadar();
    }

    // Initialize progress bar with correct total
    updateCollectionList();
}

// ============================================
// Radar Logic (TESTING: LOCKED LOCATION)
// ============================================

document.getElementById('locate-btn').addEventListener('click', toggleTracking);

function toggleTracking() {
    if (state.isTracking) {
        if (state.watchId) {
            navigator.geolocation.clearWatch(state.watchId);
            state.watchId = null;
        }
        if (state.watchdogTimer) {
            clearInterval(state.watchdogTimer);
            state.watchdogTimer = null;
        }
        if (state.positionLoop) {
            cancelAnimationFrame(state.positionLoop);
            state.positionLoop = null;
        }
        window.removeEventListener('deviceorientation', handleOrientation);
        window.removeEventListener('deviceorientationabsolute', handleOrientation);
        if (state.compassLoop) {
            cancelAnimationFrame(state.compassLoop);
            state.compassLoop = null;
        }

        state.isTracking = false;
        state.targetHeading = undefined;
        state.currentHeading = undefined;
        state.smoothedPos = null;
        state.displayPos = null;
        state.lastPositionTime = null;

        document.getElementById('locate-btn').classList.remove('active');
        showLocationMessage();
    } else {
        if (!navigator.geolocation) {
            alert("Geolocation is not supported by your browser");
            return;
        }

        state.isTracking = true;
        document.getElementById('locate-btn').classList.add('active');
        hideLocationMessage();

        requestCompassPermission();
        startWatch(true);
    }
}

function startWatch(useHighAccuracy) {
    if (state.watchId) navigator.geolocation.clearWatch(state.watchId);

    const options = {
        enableHighAccuracy: useHighAccuracy,
        maximumAge: 5000,
        timeout: 10000
    };

    state.watchId = navigator.geolocation.watchPosition(
        (pos) => {
            updatePosition(pos);
        },
        (err) => {
            if (err.code === 1) {
                alert("Location permission denied. Please enable it in settings.");
                toggleTracking();
                return;
            }

            if ((err.code === 2 || err.code === 3) && useHighAccuracy) {
                startWatch(false);
                return;
            }
        },
        options
    );

    startLocationWatchdog();
}

function startLocationWatchdog() {
    if (state.watchdogTimer) {
        clearInterval(state.watchdogTimer);
    }

    state.watchdogTimer = setInterval(() => {
        if (!state.isTracking) {
            clearInterval(state.watchdogTimer);
            state.watchdogTimer = null;
            return;
        }

        const now = Date.now();
        const timeSinceLastPosition = state.lastPositionTime ? now - state.lastPositionTime : Infinity;

        if (timeSinceLastPosition > 15000 && state.lastPositionTime) {
            startWatch(true);
        }
    }, 15000);
}

function requestCompassPermission() {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
            .then(response => {
                if (response === 'granted') {
                    enableCompass();
                }
            })
            .catch(err => {
                console.warn('Compass permission denied:', err);
            });
    } else {
        enableCompass();
    }
}

function enableCompass() {
    if (state.compassLoop) return;

    if ('ondeviceorientationabsolute' in window) {
        window.addEventListener('deviceorientationabsolute', handleOrientation, true);
    } else {
        window.addEventListener('deviceorientation', handleOrientation, true);
    }

    state.compassLoop = requestAnimationFrame(updateCompassPhysics);
}

// Location UI helpers
function showEnableLocationButton() {
    const list = document.getElementById('tree-list');
    list.innerHTML = `
        <div class="empty-state intro-state">
            <p class="intro-text">
                This shows the open data for trees in the City of Perth<br>
                Allow location to look around and collect species.
            </p>
            <button id="enable-location-btn" class="enable-location-btn">
                Enable Location
            </button>
            <p style="margin-top: 20px; font-size: 0.75rem; color: #6b7b6b;">
                Patrick Morrison 2026. <a href="../sources.html" style="color: #4a5d4a; text-decoration: underline; text-underline-offset: 2px;">Methods →</a>
            </p>
        </div>
    `;
    // Attach click handler
    setTimeout(() => {
        const btn = document.getElementById('enable-location-btn');
        if (btn) {
            btn.onclick = () => toggleTracking();
        }
    }, 0);
}

function greyOutRadar() {
    const mapEl = document.getElementById('map');
    if (mapEl && !mapEl.classList.contains('disabled')) {
        mapEl.classList.add('disabled');
    }
}

function enableRadar() {
    const mapEl = document.getElementById('map');
    if (mapEl) {
        mapEl.classList.remove('disabled');
    }
}

function showLocationMessage() {
    showEnableLocationButton();
    greyOutRadar();
}

function hideLocationMessage() {
    enableRadar();
    const list = document.getElementById('tree-list');
    list.innerHTML = '<div class="empty-state"><div style="margin-bottom:8px">Waiting for GPS</div><div style="font-size:0.85em;color:#8b9b8b">Are you outside?</div></div>';
}

function handleOrientation(e) {
    let heading = null;

    if (e.webkitCompassHeading) {
        heading = e.webkitCompassHeading;
    } else if (e.absolute && e.alpha !== null) {
        heading = 360 - e.alpha;
    } else if (e.alpha !== null) {
        heading = 360 - e.alpha;
    }

    if (heading !== null) {
        state.targetHeading = heading;
    }
}

function updateCompassPhysics() {
    if (state.targetHeading !== undefined && state.isTracking) {
        if (state.currentHeading === undefined) {
            state.currentHeading = state.targetHeading;
        }

        let diff = state.targetHeading - state.currentHeading;
        while (diff < -180) diff += 360;
        while (diff > 180) diff -= 360;

        state.currentHeading += diff * 0.15;

        if (state.activeTab === 'nearby') {
            map.setBearing(state.currentHeading);
        }
    }

    if (state.isTracking) {
        state.compassLoop = requestAnimationFrame(updateCompassPhysics);
    }
}

function updatePositionPhysics() {
    if (state.userPos && state.displayPos && state.isTracking) {
        const lerpFactor = 0.15;
        state.displayPos = {
            lng: state.displayPos.lng + lerpFactor * (state.userPos.lng - state.displayPos.lng),
            lat: state.displayPos.lat + lerpFactor * (state.userPos.lat - state.displayPos.lat)
        };

        if (state.activeTab === 'nearby') {
            const newZoom = calculateOptimalZoom(state.displayPos.lat);
            map.jumpTo({
                center: [state.displayPos.lng, state.displayPos.lat],
                zoom: newZoom,
                pitch: CONFIG.LOCKED_PITCH
            });
        }

        state.radarRings = generateRadarRings(state.displayPos);
        renderDeck();
    }

    if (state.isTracking) {
        state.positionLoop = requestAnimationFrame(updatePositionPhysics);
    }
}

function updatePosition(pos) {
    const rawPos = {
        lng: pos.coords.longitude,
        lat: pos.coords.latitude
    };

    const isFirstPosition = !state.smoothedPos;
    state.lastPositionTime = Date.now();

    if (isFirstPosition) {
        state.smoothedPos = rawPos;
        state.userPos = state.smoothedPos;
        state.displayPos = { ...state.userPos };

        const newZoom = calculateOptimalZoom(state.userPos.lat);
        map.jumpTo({
            center: [state.userPos.lng, state.userPos.lat],
            zoom: newZoom,
            pitch: CONFIG.LOCKED_PITCH
        });

        if (!state.positionLoop) {
            state.positionLoop = requestAnimationFrame(updatePositionPhysics);
        }

        state.lastListUpdate = 0;
    } else {
        const alpha = 0.5;
        state.smoothedPos = {
            lng: state.smoothedPos.lng + alpha * (rawPos.lng - state.smoothedPos.lng),
            lat: state.smoothedPos.lat + alpha * (rawPos.lat - state.smoothedPos.lat)
        };
        state.userPos = state.smoothedPos;
    }

    updateRadar();
}

function getDestinationPoint(lng, lat, distanceMeters, bearing) {
    const point = turf.point([lng, lat]);
    return turf.destination(point, distanceMeters, bearing, { units: 'meters' }).geometry.coordinates;
}

function generateRadarRings(center) {
    if (!center) return [];

    const features = [];
    const radii = [10, 20, 30];
    radii.forEach(r => {
        features.push(turf.circle([center.lng, center.lat], r, {
            steps: 64,
            units: 'meters',
            properties: { type: 'ring', radius: r }
        }));
    });

    return features;
}

function getAlpha(distance) {
    if (distance <= CONFIG.FADE_START) return 255;
    if (distance >= CONFIG.FADE_END) return 0;

    const linearRatio = 1 - (distance - CONFIG.FADE_START) / (CONFIG.FADE_END - CONFIG.FADE_START);
    const logRatio = linearRatio * linearRatio;
    return Math.floor(logRatio * 255);
}

function updateRadar() {
    if (!state.userPos) {
        state.radarRings = { type: 'FeatureCollection', features: [] };
        state.nearbyTrees = [];
        renderDeck();
        updateUI();
        return;
    }

    state.radarRings = generateRadarRings(state.userPos);

    const nearby = [];
    for (const tree of state.allTrees) {
        const d = getDistance(
            state.userPos.lat, state.userPos.lng,
            tree.position[1], tree.position[0]
        );

        if (d <= CONFIG.VISUAL_RADIUS) {
            tree.distance = d;
            tree.alpha = getAlpha(d);
            nearby.push(tree);
        }
    }

    nearby.sort((a, b) => a.distance - b.distance);
    state.nearbyTrees = nearby;

    renderDeck();
    updateUI();
}

// ============================================
// Deck.gl Visualization
// ============================================

function renderDeck() {
    const layers = [
        // Radar Rings & Crosshairs
        new deck.GeoJsonLayer({
            id: 'radar-features',
            data: state.radarRings,
            filled: false,
            stroked: true,
            getLineColor: CONFIG.COLORS.RING_STROKE,
            getLineWidth: 0.5,
            lineWidthMinPixels: 1.0,
            getLineDashArray: [4, 4], // Dashed lines for paper map grid feel
            dashJustified: true,
            pickable: false,
            parameters: {
                depthTest: false
            },
            // Hide radar rings in collection mode
            visible: state.activeTab === 'nearby'
        }),

        // Nearby Trees (Radar Mode)
        new deck.ScatterplotLayer({
            id: 'trees-scatter-nearby',
            data: state.nearbyTrees,
            visible: state.activeTab === 'nearby',
            getPosition: d => d.position,
            getFillColor: d => {
                // Priority: Selected > Rare > Significance types > Normal
                if (d.id === state.selectedIndex) return [...CONFIG.COLORS.SELECTED, 255];

                let rgb;
                if (d.isRare) {
                    rgb = CONFIG.COLORS.RARE;
                } else if (d.historicSignificance) {
                    rgb = CONFIG.COLORS.HISTORIC;
                } else if (d.communitySignificance) {
                    rgb = CONFIG.COLORS.COMMUNITY;
                } else if (d.significantGroup) {
                    rgb = CONFIG.COLORS.SIGNIFICANT_GROUP;
                } else {
                    rgb = CONFIG.COLORS.NORMAL;
                }
                return [...rgb, d.alpha];
            },
            getRadius: d => d.id === state.selectedIndex ? 5 : 3,
            radiusMinPixels: 1.5,
            radiusMaxPixels: 10,
            stroked: true,
            getLineColor: d => [255, 255, 255, Math.floor(d.alpha * 0.8)],
            getLineWidth: 0.5,
            lineWidthMinPixels: 0.5,
            pickable: true,
            pickingRadius: 10,
            onClick: info => {
                if (info.object && info.object.distance <= CONFIG.RADAR_RADIUS) {
                    selectTree(info.object.id);
                }
            },
            updateTriggers: {
                getFillColor: [state.selectedIndex],
                getRadius: [state.selectedIndex]
            }
        }),

        // -------------------------------
        // COLLECTION MODE LAYERS
        // -------------------------------

        // 1. Distribution View (Grey Dots - All instances of collected species)
        new deck.ScatterplotLayer({
            id: 'collection-distribution',
            data: state.allTrees,
            // Show if we are in collection tab
            visible: state.activeTab === 'collection',
            getPosition: d => d.position,
            getFillColor: d => {
                // 1. If not collected, hide
                if (!isSpeciesSeen(d.name)) return [0, 0, 0, 0];

                // 2. If a specific species is selected
                if (state.selectedCollectionSpecies) {
                    if (d.name === state.selectedCollectionSpecies) {
                        // Check if this is the first collected tree
                        const data = state.seenSpecies[state.selectedCollectionSpecies];
                        if (data && d.id === data.treeId) {
                            return [...CONFIG.COLORS.SELECTED, 255]; // Bright green for first found
                        }
                        // Other trees of this species - use their proper color
                        if (d.isRare) return [...CONFIG.COLORS.RARE, 200];
                        if (d.historicSignificance) return [...CONFIG.COLORS.HISTORIC, 200];
                        if (d.communitySignificance) return [...CONFIG.COLORS.COMMUNITY, 200];
                        if (d.significantGroup) return [...CONFIG.COLORS.SIGNIFICANT_GROUP, 200];
                        return [...CONFIG.COLORS.NORMAL, 200];
                    }
                    return [200, 200, 200, 50];  // Faint background for other species
                }

                // 3. Default: Show all collected species with proper colors
                if (d.isRare) return [...CONFIG.COLORS.RARE, 120];
                if (d.historicSignificance) return [...CONFIG.COLORS.HISTORIC, 120];
                if (d.communitySignificance) return [...CONFIG.COLORS.COMMUNITY, 120];
                if (d.significantGroup) return [...CONFIG.COLORS.SIGNIFICANT_GROUP, 120];
                return [...CONFIG.COLORS.NORMAL, 120];
            },
            getRadius: 5,
            radiusMinPixels: 2,
            radiusMaxPixels: 10,
            stroked: false,
            pickable: false,
            getElevation: d => {
                // Highlighted trees (when species selected) should be on top
                if (state.selectedCollectionSpecies && d.name === state.selectedCollectionSpecies) {
                    return 10;
                }
                return 0;
            },
            updateTriggers: {
                getFillColor: [state.selectedCollectionSpecies, Object.keys(state.seenSpecies).length]
            }
        }),

        // 2. "My Trees" (The specific ones I found)
        new deck.ScatterplotLayer({
            id: 'collection-my-trees',
            data: Object.values(state.seenSpecies).map(seen => {
                return state.allTrees.find(t => t.id === seen.treeId);
            }).filter(Boolean),
            visible: state.activeTab === 'collection',
            getPosition: d => d.position,
            getFillColor: d => {
                // Highlight selected species in bright green
                if (d.name === state.selectedCollectionSpecies) return CONFIG.COLORS.SELECTED;
                // All other collected trees in deep green
                return [74, 93, 74, 255]; // Deep green (#4a5d4a)
            },
            getRadius: d => d.name === state.selectedCollectionSpecies ? 8 : 4,
            radiusMinPixels: 3,
            radiusMaxPixels: 12,
            stroked: true,
            getLineColor: [255, 255, 255, 150],
            getLineWidth: 1,
            pickable: true,
            getElevation: d => {
                // Selected species should render on top
                if (d.name === state.selectedCollectionSpecies) {
                    return 20;
                }
                return 5;
            },
            onClick: info => {
                if (info.object) selectCollectionSpecies(info.object.name);
            },
            updateTriggers: {
                getFillColor: [state.selectedCollectionSpecies],
                getRadius: [state.selectedCollectionSpecies]
            }
        }),

        new deck.TextLayer({
            id: 'trees-text-common',
            data: state.nearbyTrees,
            visible: false,
            getPosition: d => d.position,
            getText: d => d.name,
            getSize: 13,
            getColor: [26, 26, 26, 255],
            getPixelOffset: [0, -18],
            fontFamily: 'Roboto',
            fontWeight: 700,
            fontSettings: { sdf: true },
            outlineColor: [255, 255, 255, 200],
            outlineWidth: 4,
            background: false,
            extensions: [new deck.CollisionFilterExtension()],
            collisionEnabled: true,
            getCollisionPriority: d => -d.distance,
            collisionTestProps: {
                sizeScale: 1.2,
                sizeMinPixels: 0,
                sizeMaxPixels: 100
            },
            collisionGroup: 'trees',
            updateTriggers: {
                getPosition: [state.nearbyTrees.length],
                getText: [state.nearbyTrees.length]
            },
            parameters: {
                depthTest: false
            }
        })
    ];

    if (state.deckOverlay) {
        state.deckOverlay.setProps({ layers });
    } else {
        state.deckOverlay = new deck.MapboxOverlay({ layers, interleaved: true });
        map.addControl(state.deckOverlay);
    }
}

// ============================================
// UI & Interaction
// ============================================

function updateUI() {
    // Throttle list updates to every 3 seconds to give users time to interact
    const now = Date.now();
    const LIST_UPDATE_INTERVAL = 3000; // 3 seconds

    // Always update count immediately
    const listTrees = state.nearbyTrees.filter(t => t.distance <= CONFIG.RADAR_RADIUS);
    document.getElementById('radar-count').textContent = listTrees.length;

    const list = document.getElementById('tree-list');

    // If not tracking (or waiting for location for the first time), show enable button
    if (!state.isTracking && !state.userPos) {
        list.innerHTML = '';
        showEnableLocationButton();
        return;
    }

    if (listTrees.length === 0) {
        let msg = "No trees found within 30m.";

        if (state.userPos && state.allTrees.length > 0) {
            const nearest = findNearestTree(state.userPos.lat, state.userPos.lng);
            if (nearest && nearest.tree) {
                const distKm = (nearest.distance / 1000).toFixed(1);
                const bearing = getBearing(state.userPos.lat, state.userPos.lng, nearest.tree.position[1], nearest.tree.position[0]);
                const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
                const cardIndex = Math.round(bearing / 45) % 8;
                const cardinal = directions[cardIndex];

                msg = `
                    <div style="margin-bottom: 8px;">No trees nearby.</div>
                    <div style="font-size: 0.85em; color: #8b9b8b; line-height: 1.4;">
                        This map only covers the City of Perth.<br><br>
                        Nearest tree: <strong>${nearest.tree.name}</strong><br>
                        <strong>${distKm} km</strong> to the <strong>${cardinal}</strong>
                    </div>
                `;
            }
        }

        // Remove all existing tree items before showing empty state
        list.querySelectorAll('.tree-item').forEach(item => item.remove());
        list.innerHTML = `<div class="empty-state">${msg}</div>`;
        return;
    }

    const emptyState = list.querySelector('.empty-state');
    if (emptyState) {
        emptyState.remove();
    }

    // Check if list is currently populated with tree items
    const hasTreeItems = list.querySelectorAll('.tree-item').length > 0;

    // Only apply throttle if list already has items (to prevent flicker during updates)
    // Always allow update when transitioning from empty to populated state
    if (hasTreeItems && now - state.lastListUpdate < LIST_UPDATE_INTERVAL) {
        return;
    }
    state.lastListUpdate = now;

    // Preserve scroll position
    const currentScroll = list.scrollTop;

    // Smart update: only modify items that changed, preserve existing items to avoid flicker
    const currentIds = Array.from(list.querySelectorAll('.tree-item')).map(el => el.id);
    const newIds = listTrees.map(t => `tree-${t.id}`);

    // Remove items no longer in range
    currentIds.forEach(id => {
        if (!newIds.includes(id)) {
            const el = document.getElementById(id);
            if (el) {
                el.style.opacity = '0';
                setTimeout(() => el.remove(), 200);
            }
        }
    });

    // Update or create items in correct order
    listTrees.forEach((tree, index) => {
        const itemId = `tree-${tree.id}`;
        let item = document.getElementById(itemId);
        const isNew = !item;

        if (isNew) {
            item = document.createElement('div');
            item.className = 'tree-item';
            item.id = itemId;
            item.style.opacity = '0';
        }

        // Update class and click handler
        item.className = `tree-item ${tree.id === state.selectedIndex ? 'selected' : ''}`;
        item.onclick = () => selectTree(tree.id);

        // Build content
        let metaHtml = '';
        if (tree.botanical) metaHtml += `<span class="botanical">${tree.botanical}</span>`;
        if (tree.height) metaHtml += `<span>${tree.height}m</span>`;
        if (tree.age) metaHtml += `<span>${tree.age} yrs</span>`;

        let badgeHtml = '';
        if (tree.isRare) {
            badgeHtml = '<span class="tree-badge rare" title="Rare Species">RARE</span>';
        } else if (tree.historicSignificance) {
            badgeHtml = '<span class="tree-badge historic" title="Historic Significance">HISTORIC</span>';
        } else if (tree.communitySignificance) {
            badgeHtml = '<span class="tree-badge community" title="Community Significance">COMMUNITY</span>';
        } else if (tree.significantGroup) {
            badgeHtml = '<span class="tree-badge significant-group" title="Significant Group">GROUP</span>';
        }

        const speciesSeen = isSpeciesSeen(tree.name);
        const escapedName = tree.name.replace(/'/g, "\\'");
        const escapedBotanical = (tree.botanical || '').replace(/'/g, "\\'");
        const plusBtnHtml = speciesSeen ?
            `<button class="collect-btn collected" disabled>✓</button>` :
            `<button class="collect-btn" onclick="event.stopPropagation(); markSpeciesSeen('${escapedName}', {id: ${tree.id}, name: '${escapedName}', botanical: '${escapedBotanical}'})">+</button>`;

        // Update innerHTML
        item.innerHTML = `
            <div class="tree-info">
                <h3>${tree.name} ${badgeHtml}</h3>
                <div class="tree-meta">${metaHtml}</div>
            </div>
            <div class="tree-actions">
                <span class="tree-dist">${tree.distance.toFixed(0)}m</span>
                ${plusBtnHtml}
            </div>
        `;

        // Insert in correct position (ordered by distance)
        if (isNew) {
            // Find correct position and insert
            const children = Array.from(list.children);
            let insertBefore = null;
            for (let i = 0; i < children.length; i++) {
                const childId = children[i].id;
                const childIndex = newIds.indexOf(childId);
                if (childIndex > index) {
                    insertBefore = children[i];
                    break;
                }
            }
            if (insertBefore) {
                list.insertBefore(item, insertBefore);
            } else {
                list.appendChild(item);
            }
            // Fade in new items
            requestAnimationFrame(() => {
                item.style.opacity = '1';
            });
        } else {
            // Existing item - ensure it's in correct position
            const children = Array.from(list.children);
            const currentIndex = children.indexOf(item);
            let targetIndex = 0;
            for (let i = 0; i < index; i++) {
                if (children.includes(document.getElementById(newIds[i]))) {
                    targetIndex++;
                }
            }
            if (currentIndex !== targetIndex && children[targetIndex] !== item) {
                list.insertBefore(item, children[targetIndex]);
            }
        }
    });

    // Restore scroll position
    list.scrollTop = currentScroll;

    // Update Collection UI if on that tab
    if (state.activeTab === 'collection') {
        updateCollectionList();
    }
}

function getUniqueSpeciesCount() {
    const unique = new Set(state.allTrees.map(t => t.name));
    return unique.size;
}

function updateCollectionList() {
    const list = document.getElementById('collection-list');
    list.innerHTML = '';

    const seenEntries = Object.entries(state.seenSpecies);

    // Update Progress
    const total = getUniqueSpeciesCount();
    const count = seenEntries.length;
    document.getElementById('progress-text').textContent = `${count} / ${total} Species Collected`;
    document.getElementById('progress-percent').textContent = `${Math.round((count / total) * 100)}%`;
    document.getElementById('progress-fill').style.width = `${(count / total) * 100}%`;

    // Sort and display species if any
    if (count > 0) {
        seenEntries.sort((a, b) => new Date(b[1].firstSeenAt) - new Date(a[1].firstSeenAt));
        seenEntries.forEach(([name, data]) => {
            const item = document.createElement('div');
            item.className = `tree-item ${state.selectedCollectionSpecies === name ? 'selected' : ''}`;
            item.onclick = () => selectCollectionSpecies(name);

            const dateStr = new Date(data.firstSeenAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            const botanicalHtml = data.botanical ? `<span class="botanical">${data.botanical}</span>` : '';

            item.innerHTML = `
                <div class="tree-info">
                    <h3>${name}</h3>
                    <div class="tree-meta">
                        ${botanicalHtml}
                        <span>Found ${dateStr}</span>
                    </div>
                </div>
            `;
            list.appendChild(item);
        });
    }

    // Add backup footer at bottom - ALWAYS show
    const footer = document.createElement('div');
    footer.className = 'backup-footer';
    footer.innerHTML = `
        <div class="backup-buttons">
            <button id="save-progress-btn" class="backup-btn" ${count === 0 ? 'disabled' : ''}>Save</button>
            <button id="load-progress-btn" class="backup-btn">Load</button>
        </div>
        <div class="backup-description">
            Stored in localStorage. Backup your progress just in case.
        </div>
    `;
    list.appendChild(footer);

    // Attach click handlers
    setTimeout(() => {
        const saveBtn = document.getElementById('save-progress-btn');
        const loadBtn = document.getElementById('load-progress-btn');
        if (saveBtn && count > 0) saveBtn.onclick = saveProgress;
        if (loadBtn) loadBtn.onclick = () => document.getElementById('load-modal').style.display = 'flex';
    }, 0);
}

function selectCollectionSpecies(name) {
    const tooltip = document.getElementById('collection-tooltip');

    if (!name || state.selectedCollectionSpecies === name) {
        // Deselect or toggle off
        state.selectedCollectionSpecies = null;
        tooltip.style.display = 'none';
    } else {
        state.selectedCollectionSpecies = name;

        // Show tooltip with collection info
        const data = state.seenSpecies[name];
        if (data) {
            const dateStr = new Date(data.firstSeenAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
            });

            // Find the original tree to get its position
            const originalTree = state.allTrees.find(t => t.id === data.treeId);
            if (originalTree) {
                // Convert lat/lng to screen position
                const point = map.project(originalTree.position);

                tooltip.innerHTML = `Found ${dateStr}`;
                tooltip.style.left = `${point.x}px`;
                tooltip.style.top = `${point.y - 50}px`;
                tooltip.style.display = 'block';
            }
        }
    }

    renderDeck();
    updateCollectionList(); // To update selected highlight
}

// Hide tooltip on map interaction
map.on('movestart', () => {
    const tooltip = document.getElementById('collection-tooltip');
    if (tooltip) tooltip.style.display = 'none';
});
map.on('zoomstart', () => {
    const tooltip = document.getElementById('collection-tooltip');
    if (tooltip) tooltip.style.display = 'none';
});
map.on('rotatestart', () => {
    const tooltip = document.getElementById('collection-tooltip');
    if (tooltip) tooltip.style.display = 'none';
});

function selectTree(id) {
    if (!id) return;
    state.selectedIndex = id;
    renderDeck();

    // Force immediate visual update in list - bypass throttle for selection changes
    const listItems = document.querySelectorAll('.tree-item');
    listItems.forEach(item => {
        if (item.id === `tree-${id}`) {
            item.classList.add('selected');
        } else {
            item.classList.remove('selected');
        }
    });
    updateUI();
    const el = document.getElementById(`tree-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ============================================
// Save/Load Progress
// ============================================

function saveProgress() {
    // Show save modal with explanation
    document.getElementById('save-modal').style.display = 'flex';
}

function doSaveDownload() {
    // Create tab-delimited text: datetime\tbotanical_name
    const lines = [];
    for (const [name, data] of Object.entries(state.seenSpecies)) {
        const botanical = data.botanical || name;
        lines.push(`${data.firstSeenAt}\t${botanical}`);
    }

    const content = lines.join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);

    // Create filename with current date
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `trees-perth-backup-${dateStr}.txt`;

    // Trigger download
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    // Close modal
    document.getElementById('save-modal').style.display = 'none';
}

// Modal handlers - use onclick and setTimeout to ensure DOM is ready
setTimeout(() => {
    const downloadBtn = document.getElementById('download-btn');
    const saveCancelBtn = document.getElementById('save-cancel-btn');
    const fileInput = document.getElementById('file-input');
    const updateBtn = document.getElementById('update-btn');
    const overwriteBtn = document.getElementById('overwrite-btn');
    const clearBtn = document.getElementById('clear-btn');
    const cancelBtn = document.getElementById('cancel-btn');

    if (downloadBtn) downloadBtn.onclick = doSaveDownload;
    if (saveCancelBtn) saveCancelBtn.onclick = () => document.getElementById('save-modal').style.display = 'none';

    if (fileInput) {
        fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                window.loadedBackupData = event.target.result;
                document.getElementById('file-actions').style.display = 'block';
            };
            reader.readAsText(file);
        };
    }

    if (updateBtn) {
        updateBtn.onclick = () => {
            if (!window.loadedBackupData) return;
            if (!confirm('Add new species from backup? Existing progress kept.')) return;

            const lines = window.loadedBackupData.split('\n').filter(l => l.trim());
            let added = 0;
            for (const line of lines) {
                const [datetime, botanical] = line.split('\t');
                if (!datetime || !botanical) continue;
                if (!state.seenSpecies[botanical]) {
                    state.seenSpecies[botanical] = { firstSeenAt: datetime, treeId: null, botanical };
                    added++;
                } else if (new Date(datetime) < new Date(state.seenSpecies[botanical].firstSeenAt)) {
                    state.seenSpecies[botanical].firstSeenAt = datetime;
                }
            }
            saveSeenSpecies();
            updateCollectionList();
            renderDeck();
            // Force immediate UI update to refresh checkmarks - bypass throttle
            state.lastListUpdate = 0;
            updateUI();
            closeLoadModal();
            alert(`Added ${added} species!`);
        };
    }

    if (overwriteBtn) {
        overwriteBtn.onclick = () => {
            if (!window.loadedBackupData) return;
            const count = Object.keys(state.seenSpecies).length;
            if (!confirm(`DELETE ${count} species and replace?`)) return;

            state.seenSpecies = {};
            const lines = window.loadedBackupData.split('\n').filter(l => l.trim());
            for (const line of lines) {
                const [datetime, botanical] = line.split('\t');
                if (datetime && botanical) {
                    state.seenSpecies[botanical] = { firstSeenAt: datetime, treeId: null, botanical };
                }
            }
            saveSeenSpecies();
            updateCollectionList();
            renderDeck();
            // Force immediate UI update to refresh checkmarks - bypass throttle
            state.lastListUpdate = 0;
            updateUI();
            closeLoadModal();
            alert(`Loaded ${lines.length} species!`);
        };
    }

    if (clearBtn) {
        clearBtn.onclick = () => {
            const count = Object.keys(state.seenSpecies).length;
            if (count === 0) { alert('No progress to clear.'); return; }
            if (!confirm(`DELETE ALL ${count} species?`)) return;
            if (!confirm('Absolutely sure?')) return;

            state.seenSpecies = {};
            saveSeenSpecies();
            updateCollectionList();
            renderDeck();
            closeLoadModal();
            alert('Cleared.');
        };
    }

    if (cancelBtn) cancelBtn.onclick = closeLoadModal;
}, 100);

function closeLoadModal() {
    document.getElementById('load-modal').style.display = 'none';
    const input = document.getElementById('file-input');
    if (input) input.value = '';
    const actions = document.getElementById('file-actions');
    if (actions) actions.style.display = 'none';
    window.loadedBackupData = null;
}
