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
        NORMAL: [65, 90, 60],     // Deep Olive / Forest Green
        SIGNIFICANT: [194, 145, 46], // Deep Ochre / Antique Gold
        SELECTED: [50, 205, 50],   // Lime Green (Bright but not Neon)
        RINGS: [0, 0, 0, 0], // Transparent Fill
        RING_STROKE: [0, 0, 0, 40] // Clean stroke
    },
    // Locked Pitch
    LOCKED_PITCH: 0,
    // TEST LOCATION: Lock to specific coordinates
    TEST_LOCATION: {
        lng: 115.859213,
        lat: -31.957816
    }
};

// ============================================
// State Management
// ============================================

const state = {
    allTrees: [],
    nearbyTrees: [],
    // Initialize with Test Location
    userPos: { ...CONFIG.TEST_LOCATION },
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
        firstTreeId: tree.id,
        firstTreeName: tree.name
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

    // Update Content Visibility
    const isNearby = tabName === 'nearby';
    document.getElementById('tree-list').style.display = isNearby ? 'block' : 'none';
    document.getElementById('collection-list').style.display = isNearby ? 'none' : 'block';
    document.getElementById('progress-container').style.display = isNearby ? 'none' : 'block';
    document.querySelector('.radar-status').style.display = isNearby ? 'block' : 'none';

    // Map Mode Switch
    try {
        if (isNearby) {
            // Radar Mode
            if (map.getLayer('carto-positron')) {
                map.setLayoutProperty('carto-positron', 'visibility', 'none');
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
                pitch: 0
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

    // We want 60m (diameter for 30m radius) to fit in the smallest dimension
    const minDim = Math.min(container.clientWidth, container.clientHeight);

    // Target size: fit within 2px margin on each side = 4px total deduction
    // 30m radius = 60m diameter
    // We want 60 meters to be represented by (minDim - 4) pixels.
    const targetPixels = minDim - 4;

    const C = 156543.03;
    const latRad = lat * Math.PI / 180;

    // 2^z = (C * cos(lat) * targetPixels) / 60
    const z = Math.log2((C * Math.cos(latRad) * targetPixels) / 60);
    return z - 1; // Adjust for MapLibre 512px base sizing
}

// ============================================
// Map Initialization
// ============================================

// Initial zoom based on Test Location
const initialZoom = calculateOptimalZoom(CONFIG.TEST_LOCATION.lat);

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
                layout: { visibility: 'none' }, // Hidden by default (Radar Mode)
                paint: { 'raster-opacity': 1 }
            }
        ]
    },
    center: [CONFIG.TEST_LOCATION.lng, CONFIG.TEST_LOCATION.lat],
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
            significant: isSignificant
        });
    }

    state.allTrees = processed;

    // Initial Radar Update
    updateRadar();
}

// ============================================
// Radar Logic (TESTING: LOCKED LOCATION)
// ============================================

document.getElementById('locate-btn').addEventListener('click', toggleTracking);

function toggleTracking() {
    if (state.isTracking) {
        // Stop tracking
        window.removeEventListener('deviceorientation', handleOrientation);
        state.isTracking = false;
        document.getElementById('locate-btn').classList.remove('active');
    } else {
        // Start tracking (Orientation ONLY for testing)
        state.isTracking = true;
        document.getElementById('locate-btn').classList.add('active');

        // FORCE LOCATION (In case it drifted)
        updatePosition({
            coords: {
                longitude: CONFIG.TEST_LOCATION.lng,
                latitude: CONFIG.TEST_LOCATION.lat
            }
        });

        // Request Compass Permission (iOS 13+)
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
            DeviceOrientationEvent.requestPermission()
                .then(response => {
                    if (response === 'granted') {
                        window.addEventListener('deviceorientation', handleOrientation);
                    }
                })
                .catch(console.error);
        } else {
            // Android often needs absolute event for true north
            if ('ondeviceorientationabsolute' in window) {
                window.addEventListener('deviceorientationabsolute', handleOrientation);
            } else {
                window.addEventListener('deviceorientation', handleOrientation);
            }
        }

        // Start smoothing loop
        if (!state.compassLoop) {
            state.compassLoop = requestAnimationFrame(updateCompassPhysics);
        }

        console.log("Tracking started (Test Mode: Locked Location, Live Compass)");
    }
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
    if (!state.isTracking) return;

    if (state.targetHeading !== undefined) {
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

        map.setBearing(state.currentHeading);
    }

    state.compassLoop = requestAnimationFrame(updateCompassPhysics);
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

    // 2. Diagonal Crosshairs: NW, NE, SE, SW (45, 135, 225, 315)
    // Extending from center to 30m inner ring? Or full? 30m seems right.
    // Actually typically crosshairs extend to the limit.
    const bearings = [45, 135, 225, 315];
    const origin = [center.lng, center.lat];

    bearings.forEach(bearing => {
        const start = turf.destination(turf.point(origin), 10, bearing, { units: 'meters' }).geometry.coordinates;
        const dest = turf.destination(turf.point(origin), 30, bearing, { units: 'meters' }).geometry.coordinates;
        features.push({
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: [start, dest]
            },
            properties: { type: 'crosshair', bearing: bearing }
        });
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
        const center = map.getCenter();
        state.userPos = { lng: center.lng, lat: center.lat };
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
            lineWidthMinPixels: 0.5,
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
                const rgb = d.significant ? CONFIG.COLORS.SIGNIFICANT : CONFIG.COLORS.NORMAL;
                if (d.id === state.selectedIndex) return [...CONFIG.COLORS.SELECTED, 255];
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
                const collectedNames = Object.keys(state.seenSpecies);
                // 1. If not collected, hide
                if (!collectedNames.includes(d.name)) return [0, 0, 0, 0];

                // 2. If a specific species is selected
                if (state.selectedCollectionSpecies) {
                    // Highlight the selected one, fade the others
                    return d.name === state.selectedCollectionSpecies
                        ? [100, 100, 100, 180]  // Dark, visible
                        : [200, 200, 200, 50];  // Faint background context
                }

                // 3. Default: Show all collected species distributions nicely
                return [150, 150, 150, 100];
            },
            getRadius: 5,
            radiusMinPixels: 2,
            radiusMaxPixels: 10,
            stroked: false,
            pickable: false,
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
                // Highight if this is the selected species
                if (d.name === state.selectedCollectionSpecies) return CONFIG.COLORS.SELECTED;
                return d.significant ? CONFIG.COLORS.SIGNIFICANT : CONFIG.COLORS.NORMAL;
            },
            getRadius: d => d.name === state.selectedCollectionSpecies ? 8 : 4,
            radiusMinPixels: 3,
            radiusMaxPixels: 12,
            stroked: true,
            getLineColor: [255, 255, 255, 255],
            getLineWidth: 1,
            pickable: true,
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
            getPosition: d => d.position,
            getText: d => d.name,
            getSize: 13,
            getColor: d => [26, 26, 26, d.alpha],
            getPixelOffset: [0, -18],
            fontFamily: 'Roboto',
            fontWeight: 700,
            fontSettings: { sdf: true },
            outlineColor: d => [255, 255, 255, d.alpha],
            outlineWidth: 4,
            background: false,
            extensions: [new deck.CollisionFilterExtension()],
            collisionEnabled: true,
            getCollisionPriority: d => -d.distance,
            collisionGroup: 'trees'
        })
    ];

    if (state.deckOverlay) {
        state.deckOverlay.setProps({ layers });
    } else {
        state.deckOverlay = new deck.MapboxOverlay({ layers });
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

    if (listTrees.length === 0) {
        list.innerHTML = `<div class="empty-state">No trees found within 30m.</div>`;
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

        // Plus button - only show if species not yet seen
        const speciesSeen = isSpeciesSeen(tree.name);
        const escapedName = tree.name.replace(/'/g, "\\'");
        const plusBtnHtml = speciesSeen ? `<span class="tree-dist" style="margin-right: 12px; font-size: 0.8rem; color: #999;">COLLECTED</span>` : `
            <button class="collect-btn" onclick="event.stopPropagation(); markSpeciesSeen('${escapedName}', {id: ${tree.id}, name: '${escapedName}'})">+</button>
        `;

        item.innerHTML = `
            <div class="tree-info">
                <h3>${tree.name}</h3>
                <div class="tree-meta">
                    ${metaHtml}
                </div>
            </div>
            <div style="display:flex; align-items:center;">
                ${plusBtnHtml}
                <div class="tree-dist">${Math.round(tree.distance)}m</div>
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

        item.innerHTML = `
            <div class="tree-info">
                <h3>${name}</h3>
                <div class="tree-meta">
                    <span>Found ${dateStr}</span>
                </div>
            </div>
        `;
        list.appendChild(item);
    });
}

function selectCollectionSpecies(name) {
    state.selectedCollectionSpecies = name;
    renderDeck();
    updateCollectionList(); // To update selected highlight
}

function selectTree(id) {
    if (!id) return;
    state.selectedIndex = id;
    renderDeck();
    updateUI();
    const el = document.getElementById(`tree-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
