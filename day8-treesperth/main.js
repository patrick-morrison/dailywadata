/**
 * Trees Perth - Radar Map Logic (Mobile Only + Shaded Rings + Pure Radar)
 */

// ============================================
// Constants & Configuration
// ============================================

const CONFIG = {
    CSV_URL: 'Trees_in_the_City.csv',
    RADAR_RADIUS: 30, // meters (Interaction/List Limit - 30m)
    VISUAL_RADIUS: 30, // meters (Rendering Limit - 30m)
    FADE_START: 5,  // Alpha = 255 until here
    FADE_END: 30,   // Alpha = 0 by here (Invisible at outer ring)
    COLORS: {
        NORMAL: [85, 107, 85],           // Deep Sage (#556b55) - Dark on light
        RARE: [218, 165, 32],            // Goldenrod - rare species
        HISTORIC: [70, 130, 180],        // Steel Blue - historic significance
        COMMUNITY: [100, 149, 237],      // Cornflower Blue - community significance
        SIGNIFICANT_GROUP: [65, 105, 225], // Royal Blue - significant group
        SELECTED: [50, 200, 50],         // Vibrant Lime Green - highly visible
        RINGS: [0, 0, 0, 0],             // Transparent Fill
        RING_STROKE: [74, 93, 74, 80]    // Visible dark rings (increased opacity from 25)
    },
    // Locked Pitch - REMOVED (Allow user to tilt? Or keep locked 0)
    // Actually keep 0 for pure radar feel
    LOCKED_PITCH: 0
};

// ============================================
// State Management
// ============================================

const state = {
    allTrees: [],
    nearbyTrees: [],
    // Initialize with NULL (Waiting for location)
    userPos: null,
    heading: 0,
    deckOverlay: null,
    selectedIndex: -1,
    watchId: null,
    isTracking: false,
    radarRings: [], // GeoJSON features
    seenSpecies: {}, // { speciesName: { firstSeenAt, firstTreeId, firstTreeName } }
    activeTab: 'nearby', // 'nearby' or 'collection'
    selectedCollectionSpecies: null // speciesName selected in collection tab
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
    return (θ * 180 / Math.PI + 360) % 360; // Degrees 0-360
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
    updateUI();
}

// ============================================
// Collection & Tab Logic
// ============================================

function toggleTab(tabName) {
    state.activeTab = tabName;

    // Update Tab UI
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Set data-tab on body for CSS control (e.g., wedge visibility)
    document.body.setAttribute('data-tab', tabName);

    // Update Content Visibility
    const isNearby = tabName === 'nearby';
    document.getElementById('tree-list').style.display = isNearby ? 'block' : 'none';
    document.getElementById('collection-list').style.display = isNearby ? 'none' : 'block';
    // Keep progress bar visible in both views
    document.getElementById('progress-container').style.display = 'block';
    document.querySelector('.radar-status').style.display = isNearby ? 'block' : 'none';

    // Map Mode Switch
    try {
        if (isNearby) {
            // Nearby mode: DO NOT auto-enable tracking. 
            // User must explicitly click "Enable Location" or "Start"
            // if (!state.isTracking) {
            //    toggleTracking(); 
            // }

            // Show base map layer (visible in radar view)
            if (map.getLayer('carto-positron')) {
                map.setLayoutProperty('carto-positron', 'visibility', 'visible');
            }
            updatePosition({ coords: { longitude: state.userPos.lng, latitude: state.userPos.lat } }); // Reset zoom/pitch

            // Disable interaction for pure radar feel
            map.boxZoom.disable();
            map.doubleClickZoom.disable();
            map.dragPan.disable();
            map.dragRotate.disable();
            map.keyboard.disable();
            map.scrollZoom.disable();
            map.touchZoomRotate.disable();
        } else {
            // Collection Map Mode
            if (map.getLayer('carto-positron')) {
                map.setLayoutProperty('carto-positron', 'visibility', 'visible');
            }
            map.jumpTo({
                center: [state.userPos.lng, state.userPos.lat],
                zoom: 13,
                pitch: 0,
                bearing: 0 // Lock to north
            });

            // Enable interaction for exploration
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

    // Reset selection when switching
    state.selectedCollectionSpecies = null;
    renderDeck();
    updateUI();
}

// Init Tabs
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

// Initial zoom based on Perth CBD Default
const initialZoom = 13;
const defaultCenter = [115.8605, -31.9505]; // Perth CBD

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
                layout: { visibility: 'visible' }, // Visible to show map background
                paint: { 'raster-opacity': 0.8 } // Increased opacity for better visibility
            }
        ]
    },
    center: defaultCenter,
    zoom: initialZoom,
    pitch: CONFIG.LOCKED_PITCH,
    attributionControl: false,
    interactive: false
});

// Handle resize to keep fit
map.on('resize', () => {
    if (state.userPos) {
        const newZoom = calculateOptimalZoom(state.userPos.lat);
        map.jumpTo({ zoom: newZoom });
    }
});

// Force update on load to ensure container dim is correct
map.on('load', () => {
    if (state.userPos) {
        const newZoom = calculateOptimalZoom(state.userPos.lat);
        map.jumpTo({ zoom: newZoom });
    }

    // Default to location OFF - show enable button
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
        // Stop tracking
        if (state.watchId) {
            navigator.geolocation.clearWatch(state.watchId);
            state.watchId = null;
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
        document.getElementById('locate-btn').classList.remove('active');
        showLocationMessage();
    } else {
        // Start tracking
        if (!navigator.geolocation) {
            alert("Geolocation is not supported by your browser");
            return;
        }

        state.isTracking = true;
        document.getElementById('locate-btn').classList.add('active');
        hideLocationMessage(); // Show map (even if waiting)

        hideLocationMessage(); // Show map (even if waiting)

        // Use startWatch for robust handling (retries, high/low accuracy)
        startWatch(true);

        console.log("Tracking started (Requesting GPS)");
    }
}

function startWatch(useHighAccuracy) {
    // Clear existing if any (prevent duplicates on retry)
    if (state.watchId) navigator.geolocation.clearWatch(state.watchId);

    const options = {
        enableHighAccuracy: useHighAccuracy,
        maximumAge: 5000,
        timeout: 10000
    };

    state.watchId = navigator.geolocation.watchPosition(
        (pos) => {
            updatePosition(pos);
            // Also enable compass if available
            enableCompass();
        },
        (err) => {
            // Quietly handle errors - no alerts for transient issues

            // Code 1: Permission Denied - Fatal
            if (err.code === 1) {
                console.warn("Location error (Fatal): Permission denied.");
                alert("Location permission denied. Please enable it in settings.");
                toggleTracking(); // Stop tracking cleanly
                return;
            }

            // Code 2 (Unavailable) & 3 (Timeout): Transient
            // Only log as debug/info to avoid "freaking out" the console/user
            // console.debug(`Location error (${useHighAccuracy ? 'High' : 'Low'} Accuracy):`, err.message);

            // If using High Accuracy and failing, fallback to Low Accuracy
            if ((err.code === 2 || err.code === 3) && useHighAccuracy) {
                console.log("Falling back to low accuracy...");
                startWatch(false);
                return;
            }

            // If already on low accuracy, just keep waiting. The browser will retry.
            // Do NOT stop tracking.
        },
        options
    );
}

function enableCompass() {
    if (state.compassLoop) return; // Already running

    // Request Compass Permission (iOS 13+)
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
            .then(response => {
                if (response === 'granted') {
                    window.addEventListener('deviceorientation', handleOrientation, true);
                }
            })
            .catch(console.error);
    } else {
        if ('ondeviceorientationabsolute' in window) {
            window.addEventListener('deviceorientationabsolute', handleOrientation, true);
        } else {
            window.addEventListener('deviceorientation', handleOrientation, true);
        }
    }
    // Start smoothing loop
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
    // Will be repopulated by updateUI()
}

function handleOrientation(e) {
    let heading = null;

    if (e.webkitCompassHeading) {
        // iOS
        heading = e.webkitCompassHeading;
    } else if (e.absolute && e.alpha !== null) {
        // Android (Absolute North)
        heading = 360 - e.alpha;
    } else if (e.alpha !== null) {
        // Fallback (Relative)
        heading = 360 - e.alpha;
    }

    if (heading !== null) {
        state.targetHeading = heading;
    }
}

// Smoothly interpolate current heading to target
function updateCompassPhysics() {
    if (state.targetHeading !== undefined && state.isTracking) {
        // Initialize if needed
        if (state.currentHeading === undefined) {
            state.currentHeading = state.targetHeading;
        }

        // Handle the 359->0 wrap-around
        let diff = state.targetHeading - state.currentHeading;
        while (diff < -180) diff += 360;
        while (diff > 180) diff -= 360;

        // Lerp factor (0.1 = heavy/smooth, 0.3 = responsive)
        // "Like compass app" implies some weight. Try 0.15
        state.currentHeading += diff * 0.15;

        // Only rotate map in "nearby" tab (proximity collecting screen)
        // Keep collection map north-up for easier browsing
        if (state.activeTab === 'nearby') {
            map.setBearing(state.currentHeading);
        }
    }

    // Continue loop if tracking is active
    if (state.isTracking) {
        state.compassLoop = requestAnimationFrame(updateCompassPhysics);
    }
}

function updatePosition(pos) {
    state.userPos = {
        lng: pos.coords.longitude,
        lat: pos.coords.latitude
    };

    // Dynamic Zoom update on position change
    const newZoom = calculateOptimalZoom(state.userPos.lat);

    map.jumpTo({
        center: [state.userPos.lng, state.userPos.lat],
        zoom: newZoom,
        pitch: CONFIG.LOCKED_PITCH
    });

    updateRadar();
}

// Used for rings
function getDestinationPoint(lng, lat, distanceMeters, bearing) {
    // Simple spherical approximation is enough for short distances (<100m)
    // but Turf is cleaner if available. Assuming turf.min.js handles this via turf.destination
    // fallback to manual calculation if needed to stay dependency-light?
    // Let's rely on turf since we use turf.circle

    const point = turf.point([lng, lat]);
    const dest = turf.destination(point, distanceMeters / 1000, 0, { units: 'kilometers' }); // Hacky: re-calc below properly
    return turf.destination(point, distanceMeters, bearing, { units: 'meters' }).geometry.coordinates;
}

function generateRadarRings(center) {
    if (!center) return [];

    const features = [];

    // 1. Concentric Circles: 10m, 20m, 30m
    const radii = [10, 20, 30];
    radii.forEach(r => {
        features.push(turf.circle([center.lng, center.lat], r, {
            steps: 64,
            units: 'meters',
            properties: { type: 'ring', radius: r }
        }));
    });

    // Crosshairs removed - keeping only circles for cleaner view

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
            onClick: info => {
                if (info.object && info.object.distance <= CONFIG.RADAR_RADIUS) {
                    selectTree(info.object.id);
                }
            },
            updateTriggers: {
                getFillColor: [state.selectedIndex], // Corrected syntax
                getRadius: [state.selectedIndex]     // Corrected syntax
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
                // Hydrate with full tree data found by ID
                return state.allTrees.find(t => t.id === seen.firstTreeId);
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
            pickable: false,
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

        // Labels
        new deck.TextLayer({
            id: 'trees-text-common',
            data: state.nearbyTrees,
            visible: false, // Labels hidden
            getPosition: d => d.position,
            getText: d => d.name,
            getSize: 13,
            getColor: d => {
                // Labels always fully opaque - no fading
                return [26, 26, 26, 255];
            },
            getPixelOffset: [0, -18],
            fontFamily: 'Roboto',
            fontWeight: 700,
            fontSettings: { sdf: true },
            outlineColor: [255, 255, 255, 200],
            outlineWidth: 4,
            background: false,
            extensions: [new deck.CollisionFilterExtension()],
            collisionEnabled: true,
            getCollisionPriority: d => -d.distance, // Closer trees get priority
            collisionTestProps: {
                sizeScale: 1.2, // Smaller test box = more labels can fit (was default 2)
                sizeMinPixels: 0,
                sizeMaxPixels: 100
            },
            collisionGroup: 'trees',
            // Stabilize labels during rotation - only update when data changes
            updateTriggers: {
                getPosition: [state.nearbyTrees.length],
                getText: [state.nearbyTrees.length]
            },
            // GPU acceleration for smooth rendering
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
    const listTrees = state.nearbyTrees.filter(t => t.distance <= CONFIG.RADAR_RADIUS);

    document.getElementById('radar-count').textContent = listTrees.length;

    const list = document.getElementById('tree-list');
    list.innerHTML = '';

    // If not tracking (or waiting for location for the first time), show enable button
    if (!state.isTracking && !state.userPos) {
        showEnableLocationButton();
        return;
    }

    if (listTrees.length === 0) {
        let msg = "No trees found within 30m.";

        // Find nearest tree if we have user position
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

        list.innerHTML = `<div class="empty-state">${msg}</div>`;
        return;
    }

    listTrees.forEach(tree => {
        const item = document.createElement('div');
        item.className = `tree-item ${tree.id === state.selectedIndex ? 'selected' : ''}`;
        item.id = `tree-${tree.id}`;
        item.onclick = () => selectTree(tree.id);

        let metaHtml = '';
        if (tree.botanical) metaHtml += `<span class="botanical">${tree.botanical}</span>`;
        if (tree.height) metaHtml += `<span>${tree.height}m</span>`;
        if (tree.age) metaHtml += `<span>${tree.age} yrs</span>`;

        // Add badge for special trees
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

        // Plus button - only show if species not yet seen
        const speciesSeen = isSpeciesSeen(tree.name);
        const escapedName = tree.name.replace(/'/g, "\\'");
        const escapedBotanical = (tree.botanical || '').replace(/'/g, "\\'");
        const plusBtnHtml = speciesSeen ?
            `<button class="collect-btn collected" disabled>✓</button>` :
            `<button class="collect-btn" onclick="event.stopPropagation(); markSpeciesSeen('${escapedName}', {id: ${tree.id}, name: '${escapedName}', botanical: '${escapedBotanical}'})">+</button>`;

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
        list.appendChild(item);
    });

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

    if (count === 0) return; // Keep default empty state

    // Sort by recent
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
    updateUI();
    const el = document.getElementById(`tree-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
