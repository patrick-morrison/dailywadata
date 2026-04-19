/**
 * Western Australia Magnetic Anomaly Visualization
 * Interactive map showing Total Magnetic Intensity (TMI) data
 */

// ============================================
// Constants & Configuration
// ============================================

const CONFIG = {
    // WMS Server
    WMS_BASE_URL: 'https://public-services.slip.wa.gov.au/public/services/SLIP_Public_Services/DMIRS_Imagery_Service/MapServer/WMSServer',

    // TMI Layers
    LAYERS: [
        { id: '5', name: 'TMI', title: 'Total Magnetic Intensity (80m)' },
        { id: '3', name: 'TMI RTP', title: 'Reduction to Pole (80m)' },
        { id: '4', name: 'TMI 1VD', title: 'First Vertical Derivative (80m)' }
    ],

    // Shipwrecks GeoJSON
    SHIPWRECKS_URL: '../day2-shipwrecks/Shipwrecks_WAM_002_WA_GDA2020_Public.geojson',

    // Operating Mines CSV
    MINES_URL: 'Operating_Mines.csv',

    // Mine commodity group colors
    COMMODITY_COLORS: {
        'Construction material': '#795548',  // Brown
        'Precious metal': '#FFD700',         // Gold
        'Iron': '#B71C1C',                   // Dark red
        'Industrial mineral': '#607D8B',     // Blue grey
        'Speciality metal': '#9C27B0',       // Purple
        'Steel alloy metal': '#455A64',      // Dark blue grey
        'Precious mineral': '#E91E63',       // Pink
        'Alumina': '#FF5722',                // Deep orange
        'Energy': '#FFC107',                 // Amber
        'Base metal': '#00BCD4',             // Cyan
        'Unknown': '#888888'                 // Grey
    },

    // Shipwreck construction material colors
    CONSTRUCTION_COLORS: {
        'Wooden': '#8B4513',      // Saddle brown
        'Iron': '#708090',        // Slate gray
        'Steel': '#4682B4',       // Steel blue
        'Composite': '#9370DB',   // Medium purple
        'Comp.': '#9370DB',       // Medium purple (same as Composite)
        'Aluminum': '#C0C0C0',    // Silver
        'Carvel': '#D2691E',      // Chocolate (wooden technique)
        'Clinker': '#A0522D',     // Sienna (wooden technique)
        'Unknown': '#888888'      // Gray for empty/unknown
    },

    // Initial map view - centered on WA
    INITIAL_VIEW: {
        lng: 121,
        lat: -26,
        zoom: 5
    }
};

// Register COG protocol for local GeoTIFF files
maplibregl.addProtocol('cog', MaplibreCOGProtocol.cogProtocol);

// ============================================
// State Management
// ============================================

const state = {
    // Layer states
    layerVisibility: {
        '5': true,
        '3': false,
        '4': false,
        'rotto': true
    },
    layerOpacity: {
        '5': 0.3,
        '3': 0.3,
        '4': 0.3,
        'rotto': 0.5
    },

    // Shipwrecks
    shipwrecksVisible: true,
    visibleConstructions: {
        'Wooden': true,
        'Iron': true,
        'Steel': true,
        'Composite': true,
        'Aluminum': true,
        'Unknown': true
    },

    // Operating Mines
    minesVisible: true,
    visibleCommodities: {
        'Construction material': true,
        'Precious metal': true,
        'Iron': true,
        'Industrial mineral': true,
        'Speciality metal': true,
        'Steel alloy metal': true,
        'Precious mineral': true,
        'Alumina': true,
        'Energy': true,
        'Base metal': true,
        'Unknown': true
    },

    // Basemap
    activeBasemap: 'satellite',

    // Geolocation
    userLocationMarker: null,
    watchId: null,
    isTracking: false,
    deviceHeading: null,

    // Location pin (from coordinate navigation or hash links)
    locationPin: null,

    // Popups
    activePopup: null,

    // Search data (populated on load)
    shipwrecksData: null,
    minesData: null,
    searchResults: []
};

// ============================================
// WMS URL Builder
// ============================================

function buildWmsTileUrl(layerId) {

    const params = new URLSearchParams({
        SERVICE: 'WMS',
        VERSION: '1.3.0',
        REQUEST: 'GetMap',
        LAYERS: layerId,
        STYLES: '',
        CRS: 'EPSG:3857',
        WIDTH: '256',
        HEIGHT: '256',
        FORMAT: 'image/png',
        TRANSPARENT: 'true'
    });

    return `${CONFIG.WMS_BASE_URL}?${params.toString()}&BBOX={bbox-epsg-3857}`;
}

// ============================================
// Map Initialization
// ============================================

const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        sources: {
            // Street basemap (Carto Light)
            'carto-light': {
                type: 'raster',
                tiles: [
                    'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
                    'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
                    'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png'
                ],
                tileSize: 256
            },
            // Satellite basemap (ESRI World Imagery)
            'esri-satellite': {
                type: 'raster',
                tiles: [
                    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
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
                    visibility: 'none'
                }
            },
            {
                id: 'esri-satellite-layer',
                type: 'raster',
                source: 'esri-satellite',
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
    minZoom: 4,
    maxZoom: 15,
    maxPitch: 0,
    dragRotate: false,
    customAttribution: '© <a href="https://data.wa.gov.au">Data WA</a> © DMIRS © CARTO © ESRI © OpenStreetMap contributors',
    attributionControl: {
        compact: true
    }
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

// ============================================
// Map Load Event
// ============================================

map.on('load', async () => {
    // Add WMS sources and layers
    addWmsLayers();

    // Add High Res Rotto 1VD (local COG) - only if CDN resource is available
    await addHighRes1VDLayer();

    // Load and add vector layers
    loadShipwrecks();
    loadMines();

    // Initialize controls
    initializeLayerControls();
    initializeBasemapToggle();
    initializeShipwrecksToggle();
    initializeMinesToggle();
    initializeMobileLegendCollapse();
    initializeMobileTitleToggle();
    initializeInfoPopovers();
    initializeSearch();

    // Handle URL hash for coordinate links
    handleUrlHash();

    // Hide loading
    setTimeout(() => {
        document.getElementById('loading').classList.add('hidden');
    }, 500);
});

// ============================================
// URL Hash Handling
// ============================================

function handleUrlHash() {
    const hash = globalThis.location.hash;
    if (!hash || hash.length < 2) return;

    // Parse #lat,lng format
    const coords = hash.slice(1).split(',');
    if (coords.length !== 2) return;

    const lat = Number.parseFloat(coords[0]);
    const lng = Number.parseFloat(coords[1]);

    if (Number.isNaN(lat) || Number.isNaN(lng)) return;

    // Validate reasonable bounds for WA
    if (lat < -45 || lat > 0 || lng < 100 || lng > 135) return;

    // Navigate to coordinates
    map.flyTo({ center: [lng, lat], zoom: 10 });

    // Add location pin
    addLocationPin([lng, lat]);
}

// Listen for hash changes
globalThis.addEventListener('hashchange', handleUrlHash);

// ============================================
// High Resolution 1VD Layer (CDN dependency)
// ============================================

const HIGH_RES_1VD_URL = 'https://cdn.arenleishman.com/20m1VD_rendered_cog.tif';

async function checkCdnResourceAvailable(url) {
    try {
        const response = await fetch(url, { method: 'HEAD' });
        return response.ok;
    } catch {
        return false;
    }
}

async function addHighRes1VDLayer() {
    const legendControl = document.querySelector('.layer-control[data-layer="rotto"]');

    const isAvailable = await checkCdnResourceAvailable(HIGH_RES_1VD_URL);

    if (!isAvailable) {
        // Hide the legend item if resource is unavailable
        if (legendControl) {
            legendControl.style.display = 'none';
        }
        // Update state to reflect layer is not available
        state.layerVisibility['rotto'] = false;
        console.warn('High Res 1VD layer unavailable - CDN resource not accessible');
        return;
    }

    // Resource is available, add the layer
    map.addSource('wms-rotto', {
        type: 'raster',
        url: `cog://${HIGH_RES_1VD_URL}`,
        tileSize: 256,
        maxzoom: 22
    });

    map.addLayer({
        id: 'wms-layer-rotto',
        type: 'raster',
        source: 'wms-rotto',
        paint: {
            'raster-opacity': state.layerOpacity['rotto'],
            'raster-resampling': 'linear'
        },
        layout: {
            visibility: state.layerVisibility['rotto'] ? 'visible' : 'none'
        }
    });
}

// ============================================
// WMS Layer Management
// ============================================

function addWmsLayers() {
    // Add layers in reverse order so first layer (TMI) is on top
    const reversedLayers = [...CONFIG.LAYERS].reverse();

    for (const layer of reversedLayers) {
        // Add source
        map.addSource(`wms-${layer.id}`, {
            type: 'raster',
            tiles: [buildWmsTileUrl(layer.id)],
            tileSize: 256
        });

        // Add layer
        map.addLayer({
            id: `wms-layer-${layer.id}`,
            type: 'raster',
            source: `wms-${layer.id}`,
            paint: {
                'raster-opacity': state.layerOpacity[layer.id]
            },
            layout: {
                visibility: state.layerVisibility[layer.id] ? 'visible' : 'none'
            }
        });
    }
}

function updateLayerVisibility(layerId, visible) {
    state.layerVisibility[layerId] = visible;

    // Check if layer exists before updating
    if (map.getLayer(`wms-layer-${layerId}`)) {
        map.setLayoutProperty(`wms-layer-${layerId}`, 'visibility', visible ? 'visible' : 'none');
    }

    // Update UI state
    const control = document.querySelector(`.layer-control[data-layer="${layerId}"]`);
    if (control) {
        control.classList.toggle('disabled', !visible);
    }
}

function updateLayerOpacity(layerId, opacity) {
    state.layerOpacity[layerId] = opacity;

    // Check if layer exists before updating
    if (map.getLayer(`wms-layer-${layerId}`)) {
        map.setPaintProperty(`wms-layer-${layerId}`, 'raster-opacity', opacity);
    }
}

// ============================================
// Shipwrecks Layer
// ============================================

async function loadShipwrecks() {
    try {
        const response = await fetch(CONFIG.SHIPWRECKS_URL);
        const geojson = await response.json();

        // Add manual entries for recently discovered wrecks
        const manualWrecks = [
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [115.4604, -32.1146] },
                properties: {
                    name: 'Thornliebank',
                    type_of_si: 'Barque (3-masted)',
                    constructi: 'Iron',
                    when_lost: '1928/04/18',
                    where_lost: 'Southwest of Rottnest Island',
                    region: 'Perth Metro',
                    protected: 'Protected Heritage WA Act'
                }
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [115.4995, -32.1504] },
                properties: {
                    name: 'HNLMS K XI',
                    type_of_si: 'Submarine',
                    constructi: 'Steel',
                    when_lost: '1946/09',
                    where_lost: 'Southeast of Rottnest Island',
                    region: 'Perth Metro',
                    protected: 'Protected Heritage WA Act'
                }
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [114.98, -33.25] },
                properties: {
                    name: 'Langstone',
                    type_of_si: 'Ship',
                    constructi: 'Iron',
                    when_lost: '1902/02/08',
                    where_lost: 'Near Naturaliste Reef',
                    region: 'South West (Bunbury Area)',
                    protected: 'Protected UCH Act 2018'
                }
            },
            // Wrecksploration identifications — new names for previously-unidentified Rottnest Graveyard sites
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [115.3699, -32.05263333] },
                properties: {
                    name: 'Sesa (ex Mallowdale, ex Adolphe II)',
                    type_of_si: 'Barque',
                    constructi: 'Iron',
                    when_lost: '1928/06/10',
                    where_lost: 'Rottnest Graveyard',
                    region: 'Perth Metro'
                }
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [115.36891, -32.070665] },
                properties: {
                    name: 'Knowsley (ex Euterpe, ex Anna Maria Schwalbe)',
                    type_of_si: 'Barque (coal hulk)',
                    constructi: 'Iron',
                    when_lost: '1923/10/03',
                    where_lost: 'Rottnest Graveyard',
                    region: 'Perth Metro'
                }
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [115.3841833, -32.08588333] },
                properties: {
                    name: 'Clipper (unidentified, ~62m iron clipper)',
                    type_of_si: 'Clipper (iron-hulled)',
                    constructi: 'Iron',
                    where_lost: 'Rottnest Graveyard',
                    region: 'Perth Metro'
                }
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [115.3498288, -32.0596805] },
                properties: {
                    name: 'Tamerlane',
                    type_of_si: 'Barque (coal hulk)',
                    constructi: 'Iron',
                    when_lost: '1919',
                    where_lost: 'Rottnest Graveyard',
                    region: 'Perth Metro'
                }
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [115.3450611, -32.06574305] },
                properties: {
                    name: 'Premier',
                    type_of_si: 'Steam dredge',
                    where_lost: 'Rottnest Graveyard',
                    region: 'Perth Metro'
                }
            },
            // Wrecksploration new locations — wrecks not in the WAM shipwrecks dataset
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [115.3138506, -32.10525] },
                properties: {
                    name: 'Bankfields (ex James Beazley)',
                    type_of_si: 'Barque (windjammer/coal hulk)',
                    constructi: 'Iron',
                    when_lost: '1950/06/07',
                    where_lost: 'Rottnest Graveyard',
                    region: 'Perth Metro'
                }
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [115.3526316, -32.1090224] },
                properties: {
                    name: 'Clevedon (ex Chrysomene)',
                    type_of_si: 'Clipper (ship-rigged, 3 masts)',
                    when_lost: '1930/10',
                    where_lost: 'Rottnest Graveyard',
                    region: 'Perth Metro'
                }
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [115.3538213, -32.1216633] },
                properties: {
                    name: 'County of Caithness',
                    type_of_si: 'Ship (4-masted)',
                    constructi: 'Iron',
                    where_lost: 'Rottnest Graveyard',
                    region: 'Perth Metro'
                }
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [115.4327897, -32.069910] },
                properties: {
                    name: 'Timaru',
                    type_of_si: 'Steam hopper barge / suction dredge',
                    constructi: 'Steel',
                    when_lost: '1920s',
                    where_lost: 'Rottnest Graveyard',
                    region: 'Perth Metro'
                }
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [115.288817, -31.9174] },
                properties: {
                    name: 'JFD Wreck (unidentified)',
                    type_of_si: 'Ship',
                    where_lost: 'North of Rottnest Island',
                    region: 'Perth Metro'
                }
            },
            // Alistair Cook magnetic anomaly candidates — unconfirmed targets, not yet identified as wrecks
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [115.4668009, -32.0088903] },
                properties: {
                    name: 'AC36',
                    type_of_si: 'Magnetic anomaly',
                    where_lost: 'North of Rottnest Island',
                    region: 'Perth Metro'
                }
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [115.4122556, -32.0623765] },
                properties: {
                    name: 'AC178',
                    type_of_si: 'Magnetic anomaly',
                    where_lost: 'Rottnest Graveyard area (unknown target)',
                    region: 'Perth Metro'
                }
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [115.4478922, -32.0381219] },
                properties: {
                    name: 'AC179',
                    type_of_si: 'Magnetic anomaly',
                    where_lost: 'Rottnest West End',
                    region: 'Perth Metro'
                }
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [115.4834991, -32.1140384] },
                properties: {
                    name: 'AC184',
                    type_of_si: 'Magnetic anomaly',
                    where_lost: 'Small anomaly, southeast of Rottnest Island',
                    region: 'Perth Metro'
                }
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [115.4222558, -32.1350603] },
                properties: {
                    name: 'AC186',
                    type_of_si: 'Magnetic anomaly',
                    where_lost: 'Good anomaly (noisy line), south of Rottnest Island',
                    region: 'Perth Metro'
                }
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [115.4182972, -32.0950561] },
                properties: {
                    name: 'AC187',
                    type_of_si: 'Magnetic anomaly',
                    where_lost: 'Small multi-peak anomaly, south of Rottnest Island',
                    region: 'Perth Metro'
                }
            },
            // Alistair Cook unnamed target without a Wrecksploration cross-reference
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [115.4311538, -32.1060481] },
                properties: {
                    name: 'AC43',
                    type_of_si: 'Magnetic anomaly',
                    where_lost: 'South of Rottnest Island (Wrecksploration site 43, not yet located)',
                    region: 'Perth Metro'
                }
            }
        ];
        geojson.features.push(...manualWrecks);

        // Store for search
        state.shipwrecksData = geojson;

        // Add source
        map.addSource('shipwrecks', {
            type: 'geojson',
            data: geojson
        });

        // Add circle layer for points with construction-based colors
        map.addLayer({
            id: 'shipwrecks-layer',
            type: 'circle',
            source: 'shipwrecks',
            paint: {
                'circle-radius': [
                    'interpolate', ['linear'], ['zoom'],
                    4, 3,
                    8, 5,
                    12, 8
                ],
                'circle-color': [
                    'match',
                    ['get', 'constructi'],
                    'Wooden', CONFIG.CONSTRUCTION_COLORS['Wooden'],
                    'Iron', CONFIG.CONSTRUCTION_COLORS['Iron'],
                    'Steel', CONFIG.CONSTRUCTION_COLORS['Steel'],
                    'Composite', CONFIG.CONSTRUCTION_COLORS['Composite'],
                    'Comp.', CONFIG.CONSTRUCTION_COLORS['Comp.'],
                    'Aluminum', CONFIG.CONSTRUCTION_COLORS['Aluminum'],
                    'Carvel', CONFIG.CONSTRUCTION_COLORS['Carvel'],
                    'Clinker', CONFIG.CONSTRUCTION_COLORS['Clinker'],
                    CONFIG.CONSTRUCTION_COLORS['Unknown'] // default
                ],
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2,
                'circle-opacity': 0.9
            }
        });

        // Add click handler for popups
        map.on('click', 'shipwrecks-layer', (e) => {
            if (e.features.length === 0) return;

            const feature = e.features[0];
            const props = feature.properties;
            const coords = feature.geometry.coordinates.slice();

            // Close existing popup
            if (state.activePopup) {
                state.activePopup.remove();
            }

            // Build popup content
            const construction = props.constructi || 'Unknown';
            const popupContent = `
                <div class="shipwreck-popup">
                    <div class="popup-title">${props.name || 'Unknown Vessel'}</div>
                    ${props.type_of_si ? `<div class="popup-row"><span class="popup-label">Type:</span> ${props.type_of_si}</div>` : ''}
                    <div class="popup-row"><span class="popup-label">Construction:</span> ${construction}</div>
                    ${props.when_lost ? `<div class="popup-row"><span class="popup-label">Lost:</span> ${props.when_lost}</div>` : ''}
                    ${props.where_lost ? `<div class="popup-row"><span class="popup-label">Location:</span> ${props.where_lost}</div>` : ''}
                    ${props.region ? `<div class="popup-row"><span class="popup-label">Region:</span> ${props.region}</div>` : ''}
                    ${props.protected ? `<div class="popup-row"><span class="popup-label">Status:</span> ${props.protected}</div>` : ''}
                </div>
            `;

            state.activePopup = new maplibregl.Popup({ closeButton: true, maxWidth: '300px' })
                .setLngLat(coords)
                .setHTML(popupContent)
                .addTo(map);
        });

        // Change cursor on hover
        map.on('mouseenter', 'shipwrecks-layer', () => {
            map.getCanvas().style.cursor = 'pointer';
        });

        map.on('mouseleave', 'shipwrecks-layer', () => {
            map.getCanvas().style.cursor = '';
        });

    } catch (error) {
        console.error('Failed to load shipwrecks:', error);
    }
}

function toggleShipwrecksVisibility(visible) {
    state.shipwrecksVisible = visible;
    map.setLayoutProperty('shipwrecks-layer', 'visibility', visible ? 'visible' : 'none');

    const control = document.querySelector('.layer-control[data-layer="shipwrecks"]');
    if (control) {
        control.classList.toggle('disabled', !visible);
    }
}

function updateShipwrecksFilter() {
    // Build filter for visible construction types
    const visibleTypes = Object.entries(state.visibleConstructions)
        .filter(([, visible]) => visible)
        .map(([type]) => type);

    if (visibleTypes.length === 0) {
        // Hide all
        map.setFilter('shipwrecks-layer', ['==', ['get', 'constructi'], '__none__']);
    } else if (visibleTypes.length === Object.keys(state.visibleConstructions).length) {
        // Show all - no filter needed
        map.setFilter('shipwrecks-layer', null);
    } else {
        // Build match expression for visible types
        // Handle "Unknown" specially - it matches empty strings
        const hasUnknown = visibleTypes.includes('Unknown');
        const regularTypes = visibleTypes.filter(t => t !== 'Unknown');

        // Include Comp., Carvel, Clinker based on their parent categories
        if (visibleTypes.includes('Composite')) {
            regularTypes.push('Comp.');
        }
        if (visibleTypes.includes('Wooden')) {
            regularTypes.push('Carvel', 'Clinker');
        }

        if (hasUnknown && regularTypes.length > 0) {
            // Match specific types OR empty string
            map.setFilter('shipwrecks-layer', [
                'any',
                ['in', ['get', 'constructi'], ['literal', regularTypes]],
                ['==', ['get', 'constructi'], ''],
                ['!', ['has', 'constructi']]
            ]);
        } else if (hasUnknown) {
            // Only unknown - match empty
            map.setFilter('shipwrecks-layer', [
                'any',
                ['==', ['get', 'constructi'], ''],
                ['!', ['has', 'constructi']]
            ]);
        } else {
            // Only specific types
            map.setFilter('shipwrecks-layer', ['in', ['get', 'constructi'], ['literal', regularTypes]]);
        }
    }
}

function initializeShipwrecksToggle() {
    const control = document.querySelector('.layer-control[data-layer="shipwrecks"]');
    if (!control) return;

    const checkbox = control.querySelector('input[type="checkbox"]');

    checkbox.addEventListener('change', () => {
        toggleShipwrecksVisibility(checkbox.checked);
    });

    // Construction type toggles
    const colorItems = control.querySelectorAll('.color-item[data-construction]');
    for (const item of colorItems) {
        item.addEventListener('click', () => {
            const construction = item.dataset.construction;
            state.visibleConstructions[construction] = !state.visibleConstructions[construction];
            item.classList.toggle('active');
            updateShipwrecksFilter();
        });
    }
}

// ============================================
// Operating Mines Layer
// ============================================

async function loadMines() {
    try {
        const response = await fetch(CONFIG.MINES_URL);
        const csvText = await response.text();

        // Parse CSV
        const lines = csvText.split('\n');
        const headers = lines[0].split(',');

        const lonIdx = headers.indexOf('LONGITUDE');
        const latIdx = headers.indexOf('LATITUDE');
        const nameIdx = headers.indexOf('SHORT_TITLE');
        const commodityIdx = headers.indexOf('COMMODITY_GROUP_NAME');
        const siteTypeIdx = headers.indexOf('SUB_TYPE');
        const stageIdx = headers.indexOf('STAGE');
        const commoditiesIdx = headers.indexOf('COMMODITIES');

        // Convert to GeoJSON
        const features = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // Handle CSV with quoted fields
            const values = parseCSVLine(line);
            const lon = Number.parseFloat(values[lonIdx]);
            const lat = Number.parseFloat(values[latIdx]);

            if (Number.isNaN(lon) || Number.isNaN(lat)) continue;

            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [lon, lat] },
                properties: {
                    name: values[nameIdx] || 'Unknown',
                    commodity_group: values[commodityIdx] || 'Unknown',
                    site_type: values[siteTypeIdx] || '',
                    stage: values[stageIdx] || '',
                    commodities: values[commoditiesIdx] || ''
                }
            });
        }

        const geojson = { type: 'FeatureCollection', features };

        // Store for search
        state.minesData = geojson;

        // Add source
        map.addSource('mines', {
            type: 'geojson',
            data: geojson
        });

        // Build color expression
        const colorExpr = ['match', ['get', 'commodity_group']];
        for (const [commodity, color] of Object.entries(CONFIG.COMMODITY_COLORS)) {
            if (commodity !== 'Unknown') {
                colorExpr.push(commodity, color);
            }
        }
        colorExpr.push(CONFIG.COMMODITY_COLORS['Unknown']); // default

        // Add circle layer
        map.addLayer({
            id: 'mines-layer',
            type: 'circle',
            source: 'mines',
            paint: {
                'circle-radius': [
                    'interpolate', ['linear'], ['zoom'],
                    4, 4,
                    8, 6,
                    12, 10
                ],
                'circle-color': colorExpr,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2,
                'circle-opacity': 0.9
            }
        });

        // Add click handler for popups
        map.on('click', 'mines-layer', (e) => {
            if (e.features.length === 0) return;

            const feature = e.features[0];
            const props = feature.properties;
            const coords = feature.geometry.coordinates.slice();

            if (state.activePopup) {
                state.activePopup.remove();
            }

            const popupContent = `
                <div class="mine-popup">
                    <div class="popup-title">${props.name}</div>
                    <div class="popup-row"><span class="popup-label">Commodity:</span> ${props.commodity_group}</div>
                    ${props.commodities ? `<div class="popup-row"><span class="popup-label">Resources:</span> ${props.commodities}</div>` : ''}
                    ${props.site_type ? `<div class="popup-row"><span class="popup-label">Type:</span> ${props.site_type}</div>` : ''}
                    ${props.stage ? `<div class="popup-row"><span class="popup-label">Stage:</span> ${props.stage}</div>` : ''}
                </div>
            `;

            state.activePopup = new maplibregl.Popup({ closeButton: true, maxWidth: '300px' })
                .setLngLat(coords)
                .setHTML(popupContent)
                .addTo(map);
        });

        // Change cursor on hover
        map.on('mouseenter', 'mines-layer', () => {
            map.getCanvas().style.cursor = 'pointer';
        });

        map.on('mouseleave', 'mines-layer', () => {
            map.getCanvas().style.cursor = '';
        });

    } catch (error) {
        console.error('Failed to load mines:', error);
    }
}

// Simple CSV line parser that handles quoted fields
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (const char of line) {
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current);
    return result;
}

function toggleMinesVisibility(visible) {
    state.minesVisible = visible;
    map.setLayoutProperty('mines-layer', 'visibility', visible ? 'visible' : 'none');

    const control = document.querySelector('.layer-control[data-layer="mines"]');
    if (control) {
        control.classList.toggle('disabled', !visible);
    }
}

function updateMinesFilter() {
    const visibleTypes = Object.entries(state.visibleCommodities)
        .filter(([, visible]) => visible)
        .map(([type]) => type);

    if (visibleTypes.length === 0) {
        map.setFilter('mines-layer', ['==', ['get', 'commodity_group'], '__none__']);
    } else if (visibleTypes.length === Object.keys(state.visibleCommodities).length) {
        map.setFilter('mines-layer', null);
    } else {
        const hasUnknown = visibleTypes.includes('Unknown');
        const regularTypes = visibleTypes.filter(t => t !== 'Unknown');

        // Include 'Fe' as Iron
        if (visibleTypes.includes('Iron')) {
            regularTypes.push('Fe');
        }

        if (hasUnknown && regularTypes.length > 0) {
            map.setFilter('mines-layer', [
                'any',
                ['in', ['get', 'commodity_group'], ['literal', regularTypes]],
                ['==', ['get', 'commodity_group'], ''],
                ['!', ['has', 'commodity_group']]
            ]);
        } else if (hasUnknown) {
            map.setFilter('mines-layer', [
                'any',
                ['==', ['get', 'commodity_group'], ''],
                ['!', ['has', 'commodity_group']]
            ]);
        } else {
            map.setFilter('mines-layer', ['in', ['get', 'commodity_group'], ['literal', regularTypes]]);
        }
    }
}

function initializeMinesToggle() {
    const control = document.querySelector('.layer-control[data-layer="mines"]');
    if (!control) return;

    const checkbox = control.querySelector('input[type="checkbox"]');

    checkbox.addEventListener('change', () => {
        toggleMinesVisibility(checkbox.checked);
    });

    // Commodity type toggles
    const colorItems = control.querySelectorAll('.color-item[data-commodity]');
    for (const item of colorItems) {
        item.addEventListener('click', () => {
            const commodity = item.dataset.commodity;
            state.visibleCommodities[commodity] = !state.visibleCommodities[commodity];
            item.classList.toggle('active');
            updateMinesFilter();
        });
    }
}

// ============================================
// Basemap Management
// ============================================

function setBasemap(basemap) {
    state.activeBasemap = basemap;

    if (basemap === 'street') {
        map.setLayoutProperty('carto-light-layer', 'visibility', 'visible');
        map.setLayoutProperty('esri-satellite-layer', 'visibility', 'none');
    } else {
        map.setLayoutProperty('carto-light-layer', 'visibility', 'none');
        map.setLayoutProperty('esri-satellite-layer', 'visibility', 'visible');
    }

    // Update button states
    document.querySelectorAll('.basemap-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.basemap === basemap);
    });
}

// ============================================
// Control Initialization
// ============================================

function initializeLayerControls() {
    // Only initialize WMS layer controls (not vector layers like shipwrecks)
    const layerControls = document.querySelectorAll('.layer-control:not(.vector-layer)');

    for (const control of layerControls) {
        const layerId = control.dataset.layer;
        const checkbox = control.querySelector('input[type="checkbox"]');
        const slider = control.querySelector('.opacity-slider');
        const valueDisplay = control.querySelector('.opacity-value');

        // Set initial disabled state
        if (!state.layerVisibility[layerId]) {
            control.classList.add('disabled');
        }

        // Checkbox toggle
        checkbox.addEventListener('change', () => {
            updateLayerVisibility(layerId, checkbox.checked);
        });

        // Opacity slider
        slider?.addEventListener('input', () => {
            const opacity = slider.value / 100;
            valueDisplay.textContent = `${slider.value}%`;
            updateLayerOpacity(layerId, opacity);
        });
    }
}

function initializeBasemapToggle() {
    const buttons = document.querySelectorAll('.basemap-btn');

    for (const btn of buttons) {
        btn.addEventListener('click', () => {
            setBasemap(btn.dataset.basemap);
        });
    }
}

function initializeMobileLegendCollapse() {
    const legendTitle = document.querySelector('.legend-title');
    const legendContent = document.querySelector('.legend-content');

    const isMobile = () => globalThis.innerWidth <= 768;

    // Start collapsed on mobile
    if (isMobile()) {
        legendTitle.classList.add('collapsed');
        legendContent.classList.add('collapsed');
    }

    // Toggle collapse on click (works on all screen sizes)
    legendTitle.addEventListener('click', () => {
        legendTitle.classList.toggle('collapsed');
        legendContent.classList.toggle('collapsed');
    });
}

function initializeMobileTitleToggle() {
    const titleCard = document.querySelector('.title-card');
    const header = document.querySelector('.header');
    const searchContainer = document.querySelector('.search-container');
    const isMobile = () => globalThis.innerWidth <= 768;

    // Update search bar position based on header height
    function updateSearchPosition() {
        if (isMobile() && header && searchContainer) {
            const headerRect = header.getBoundingClientRect();
            const newTop = headerRect.bottom + 8; // 8px gap below header
            searchContainer.style.setProperty('--search-top', `${newTop}px`);
        } else if (searchContainer) {
            searchContainer.style.removeProperty('--search-top');
        }
    }

    titleCard.addEventListener('click', (e) => {
        // Only toggle on mobile, and not when clicking links
        if (isMobile() && !e.target.closest('a')) {
            titleCard.classList.toggle('expanded');
            // Update search position after DOM update
            requestAnimationFrame(updateSearchPosition);
        }
    });

    // Collapse when clicking outside
    document.addEventListener('click', (e) => {
        if (isMobile() && !titleCard.contains(e.target)) {
            const wasExpanded = titleCard.classList.contains('expanded');
            titleCard.classList.remove('expanded');
            if (wasExpanded) {
                requestAnimationFrame(updateSearchPosition);
            }
        }
    });

    // Ensure expanded state is removed when resizing to desktop
    globalThis.addEventListener('resize', () => {
        if (!isMobile()) {
            titleCard.classList.remove('expanded');
        }
        updateSearchPosition();
    });

    // Initial position update
    updateSearchPosition();
}

// ============================================
// Info Popovers
// ============================================

function initializeInfoPopovers() {
    const infoBtns = document.querySelectorAll('.info-btn');
    const popovers = document.querySelectorAll('.info-popover');

    // Close all popovers
    function closeAllPopovers() {
        popovers.forEach(p => p.classList.remove('visible'));
        infoBtns.forEach(b => b.classList.remove('active'));
    }

    // Toggle popover on button click
    infoBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const infoId = btn.dataset.info;
            const popover = btn.parentElement.querySelector(`.info-popover[data-info="${infoId}"]`);

            if (popover.classList.contains('visible')) {
                popover.classList.remove('visible');
                btn.classList.remove('active');
            } else {
                closeAllPopovers();
                popover.classList.add('visible');
                btn.classList.add('active');
            }
        });
    });

    // Close popover when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.info-btn') && !e.target.closest('.info-popover')) {
            closeAllPopovers();
        }
    });

    // Close on escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeAllPopovers();
        }
    });
}

// ============================================
// Context Menu (Right Click)
// ============================================

map.on('contextmenu', async (e) => {
    const existing = document.getElementById('context-menu');
    if (existing) existing.remove();

    const { lng, lat } = e.lngLat;
    const coords = formatCoordinates(lng, lat);

    const menu = document.createElement('div');
    menu.id = 'context-menu';
    menu.className = 'context-menu';
    menu.style.left = `${e.point.x}px`;
    menu.style.top = `${e.point.y}px`;

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
        ${state.locationPin ? `
            <div class="context-menu-separator"></div>
            <div class="context-menu-item" id="remove-pin">
                <span>Remove Location Pin</span>
            </div>
        ` : ''}
    `;

    document.body.appendChild(menu);

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

    // Remove pin option (if pin exists)
    if (state.locationPin) {
        document.getElementById('remove-pin').addEventListener('click', () => {
            removeLocationPin();
            menu.remove();
        });
    }

    const removeMenu = () => {
        menu.remove();
        map.off('click', removeMenu);
        map.off('move', removeMenu);
    };
    map.on('click', removeMenu);
    map.on('move', removeMenu);
    map.on('zoom', removeMenu);
});

// ============================================
// Geolocation
// ============================================

document.getElementById('location-btn').addEventListener('click', toggleGeolocation);

function toggleGeolocation() {
    if (state.isTracking) {
        navigator.geolocation.clearWatch(state.watchId);
        globalThis.removeEventListener('deviceorientation', handleDeviceOrientation);
        state.isTracking = false;
        state.deviceHeading = null;
        document.getElementById('location-btn').classList.remove('active');
        if (state.userLocationMarker) state.userLocationMarker.remove();
        state.userLocationMarker = null;
    } else {
        if (!navigator.geolocation) return alert('No Geolocation support');
        document.getElementById('location-btn').classList.add('active');
        state.isTracking = true;

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
            globalThis.addEventListener('deviceorientation', handleDeviceOrientation);
        }

        state.watchId = navigator.geolocation.watchPosition(updateUserLocation,
            () => { alert('Locate failed'); toggleGeolocation(); },
            { enableHighAccuracy: true }
        );
    }
}

function handleDeviceOrientation(event) {
    if (event.webkitCompassHeading !== undefined) {
        state.deviceHeading = event.webkitCompassHeading;
    } else if (event.alpha !== null) {
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
    if (state.userLocationMarker) {
        state.userLocationMarker.setLngLat([longitude, latitude]);
    } else {
        const el = document.createElement('div');
        el.className = 'user-location-marker';
        el.innerHTML = '<div class="location-heading"></div><div class="location-dot"></div>';
        state.userLocationMarker = new maplibregl.Marker({ element: el }).setLngLat([longitude, latitude]).addTo(map);
    }

    const hEl = document.querySelector('.location-heading');
    if (hEl) {
        if (state.deviceHeading !== null && state.deviceHeading !== undefined) {
            // Device orientation is handling heading display
        } else if (heading !== null && heading !== undefined) {
            hEl.style.transform = `translate(-50%, -50%) rotate(${heading - 90}deg)`;
            hEl.style.display = 'block';
        } else {
            hEl.style.display = 'none';
        }
    }
    map.flyTo({ center: [longitude, latitude], zoom: 10 });
}

// ============================================
// Search Functionality
// ============================================

function initializeSearch() {
    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');
    const searchClear = document.getElementById('search-clear');

    // Handle input
    searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim();
        searchClear.style.display = query ? 'flex' : 'none';

        if (query.length < 2) {
            searchResults.classList.remove('visible');
            return;
        }

        // Check if input is coordinates
        const coords = parseCoordinates(query);
        if (coords) {
            displayCoordinateResult(coords);
            return;
        }

        const results = performSearch(query);
        displaySearchResults(results);
    });

    // Clear button
    searchClear.addEventListener('click', () => {
        searchInput.value = '';
        searchClear.style.display = 'none';
        searchResults.classList.remove('visible');
    });

    // Close results when clicking outside
    document.addEventListener('click', (e) => {
        const container = document.getElementById('search-container');
        if (!container.contains(e.target)) {
            searchResults.classList.remove('visible');
        }
    });

    // Reopen results on focus if there's a query
    searchInput.addEventListener('focus', () => {
        const query = searchInput.value.trim();
        if (query.length >= 2) {
            const coords = parseCoordinates(query);
            if (coords) {
                displayCoordinateResult(coords);
            } else {
                const results = performSearch(query);
                displaySearchResults(results);
            }
        }
    });

    // Handle Enter key for coordinates
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const query = searchInput.value.trim();
            const coords = parseCoordinates(query);

            if (coords) {
                // Navigate to coordinates
                map.flyTo({ center: [coords.lng, coords.lat], zoom: 12 });
                addLocationPin([coords.lng, coords.lat]);

                // Update URL hash
                globalThis.location.hash = `${coords.lat.toFixed(6)},${coords.lng.toFixed(6)}`;

                searchInput.value = '';
                searchClear.style.display = 'none';
                searchResults.classList.remove('visible');
            }
            // If not coordinates, let normal search behavior continue
        }
    });
}

function performSearch(query) {
    const results = [];
    const lowerQuery = query.toLowerCase();

    // Search shipwrecks
    if (state.shipwrecksData) {
        for (const feature of state.shipwrecksData.features) {
            const name = feature.properties.name || '';
            const score = fuzzyMatch(name, lowerQuery);
            if (score > 0) {
                const construction = normalizeConstruction(feature.properties.constructi);
                results.push({
                    type: 'wreck',
                    name: name,
                    subtype: feature.properties.type_of_si || 'Shipwreck',
                    color: CONFIG.CONSTRUCTION_COLORS[construction] || CONFIG.CONSTRUCTION_COLORS['Unknown'],
                    coordinates: feature.geometry.coordinates,
                    properties: feature.properties,
                    score: score
                });
            }
        }
    }

    // Search mines
    if (state.minesData) {
        for (const feature of state.minesData.features) {
            const name = feature.properties.name || '';
            const score = fuzzyMatch(name, lowerQuery);
            if (score > 0) {
                const commodity = feature.properties.commodity_group || 'Unknown';
                results.push({
                    type: 'mine',
                    name: name,
                    subtype: commodity,
                    color: CONFIG.COMMODITY_COLORS[commodity] || CONFIG.COMMODITY_COLORS['Unknown'],
                    coordinates: feature.geometry.coordinates,
                    properties: feature.properties,
                    score: score
                });
            }
        }
    }

    // Sort by score (higher first), then by name
    results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    // Limit results
    return results.slice(0, 50);
}

function fuzzyMatch(text, query) {
    const lowerText = text.toLowerCase();

    // Exact substring match (highest priority)
    if (lowerText.includes(query)) {
        // Bonus for starting with query
        return lowerText.startsWith(query) ? 100 : 90;
    }

    // Normalized match (remove spaces, punctuation)
    const normalizedText = lowerText.replaceAll(/[\s\-_.,']/g, '');
    const normalizedQuery = query.replaceAll(/[\s\-_.,']/g, '');

    if (normalizedText.includes(normalizedQuery)) {
        return normalizedText.startsWith(normalizedQuery) ? 80 : 70;
    }

    // Word-start matching (each query char starts a word)
    const words = lowerText.split(/[\s\-_.,']+/);
    const wordStarts = words.map(w => w[0]).join('');
    if (wordStarts.includes(normalizedQuery)) {
        return 60;
    }

    // Sequential character matching (all query chars appear in order)
    let textIdx = 0;
    let matched = 0;
    for (const char of normalizedQuery) {
        const foundIdx = normalizedText.indexOf(char, textIdx);
        if (foundIdx >= 0) {
            matched++;
            textIdx = foundIdx + 1;
        }
    }

    // Require at least 70% of characters to match in sequence
    if (matched === normalizedQuery.length && normalizedQuery.length >= 2) {
        return 50;
    }

    return 0;
}

function normalizeConstruction(constructi) {
    if (!constructi || constructi === '') return 'Unknown';
    if (constructi === 'Comp.') return 'Composite';
    if (constructi === 'Carvel' || constructi === 'Clinker') return 'Wooden';
    return constructi;
}

function displayCoordinateResult(coords) {
    const searchResults = document.getElementById('search-results');
    const searchInput = document.getElementById('search-input');

    const formattedCoords = formatCoordinates(coords.lng, coords.lat);

    searchResults.innerHTML = `
        <div class="search-result-item coordinate-result"
             style="border-left-color: #d97706; cursor: pointer;">
            <div class="search-result-name">Navigate to coordinates</div>
            <div class="search-result-type">${formattedCoords.display}</div>
        </div>
    `;

    // Add click handler
    const item = searchResults.querySelector('.coordinate-result');
    item.addEventListener('click', () => {
        map.flyTo({ center: [coords.lng, coords.lat], zoom: 12 });
        searchInput.value = '';
        document.getElementById('search-clear').style.display = 'none';
        searchResults.classList.remove('visible');
    });

    searchResults.classList.add('visible');
}

function displaySearchResults(results) {
    const searchResults = document.getElementById('search-results');

    if (results.length === 0) {
        searchResults.innerHTML = '<div class="search-no-results">No results found</div>';
        searchResults.classList.add('visible');
        return;
    }

    // Store results for click handler
    state.searchResults = results;

    searchResults.innerHTML = results.map((result, index) => `
        <div class="search-result-item"
             data-index="${index}"
             style="border-left-color: ${result.color};">
            <div class="search-result-name">${escapeHtml(result.name)}</div>
            <div class="search-result-type">${escapeHtml(result.subtype)} • ${result.type === 'wreck' ? 'Shipwreck' : 'Mine'}</div>
        </div>
    `).join('');

    // Add click handlers
    for (const item of searchResults.querySelectorAll('.search-result-item')) {
        item.addEventListener('click', () => {
            const index = Number.parseInt(item.dataset.index, 10);
            const result = state.searchResults[index];
            navigateToSearchResult(result);
            searchResults.classList.remove('visible');
        });
    }

    searchResults.classList.add('visible');
}

function navigateToSearchResult(result) {
    const [lng, lat] = result.coordinates;

    // Close existing popup
    if (state.activePopup) {
        state.activePopup.remove();
    }

    // Build popup content based on type
    let popupContent;
    if (result.type === 'wreck') {
        const props = result.properties;
        const construction = props.constructi || 'Unknown';
        popupContent = `
            <div class="shipwreck-popup">
                <div class="popup-title">${props.name || 'Unknown Vessel'}</div>
                ${props.type_of_si ? `<div class="popup-row"><span class="popup-label">Type:</span> ${props.type_of_si}</div>` : ''}
                <div class="popup-row"><span class="popup-label">Construction:</span> ${construction}</div>
                ${props.when_lost ? `<div class="popup-row"><span class="popup-label">Lost:</span> ${props.when_lost}</div>` : ''}
                ${props.where_lost ? `<div class="popup-row"><span class="popup-label">Location:</span> ${props.where_lost}</div>` : ''}
                ${props.region ? `<div class="popup-row"><span class="popup-label">Region:</span> ${props.region}</div>` : ''}
                ${props.protected ? `<div class="popup-row"><span class="popup-label">Status:</span> ${props.protected}</div>` : ''}
            </div>
        `;
    } else {
        const props = result.properties;
        popupContent = `
            <div class="mine-popup">
                <div class="popup-title">${props.name}</div>
                <div class="popup-row"><span class="popup-label">Commodity:</span> ${props.commodity_group}</div>
                ${props.commodities ? `<div class="popup-row"><span class="popup-label">Resources:</span> ${props.commodities}</div>` : ''}
                ${props.site_type ? `<div class="popup-row"><span class="popup-label">Type:</span> ${props.site_type}</div>` : ''}
                ${props.stage ? `<div class="popup-row"><span class="popup-label">Stage:</span> ${props.stage}</div>` : ''}
            </div>
        `;
    }

    // Create popup
    state.activePopup = new maplibregl.Popup({ closeButton: true, maxWidth: '300px' })
        .setLngLat([lng, lat])
        .setHTML(popupContent);

    // Fly to location and show popup when animation completes
    map.flyTo({ center: [lng, lat], zoom: 10 });
    map.once('moveend', () => {
        state.activePopup.addTo(map);
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================
// Location Pin Management
// ============================================

function addLocationPin(lngLat) {
    // Remove existing pin if any
    if (state.locationPin) {
        state.locationPin.remove();
    }

    // Create pin marker element
    const el = document.createElement('div');
    el.className = 'location-pin-marker';
    el.innerHTML = '📍';
    el.style.fontSize = '24px';
    el.style.cursor = 'default';

    // Add marker to map
    state.locationPin = new maplibregl.Marker({
        element: el,
        anchor: 'bottom'
    })
        .setLngLat(lngLat)
        .addTo(map);
}

function removeLocationPin() {
    if (state.locationPin) {
        state.locationPin.remove();
        state.locationPin = null;
    }
}

// ============================================
// Utilities
// ============================================

function parseCoordinates(query) {
    // Try decimal degrees format: -32.123456, 115.123456
    const ddRegex = /^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/;
    const ddMatch = query.match(ddRegex);

    if (ddMatch) {
        const lat = Number.parseFloat(ddMatch[1]);
        const lng = Number.parseFloat(ddMatch[2]);

        // Validate ranges
        if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
            return { lat, lng };
        }
    }

    // Try decimal minutes format: 32° 7.407' S, 115° 7.407' E
    const dmRegex = /^(\d+)°\s*(\d+\.?\d*)'\s*([NS])\s*,\s*(\d+)°\s*(\d+\.?\d*)'\s*([EW])$/i;
    const dmMatch = query.match(dmRegex);

    if (dmMatch) {
        const latDeg = Number.parseInt(dmMatch[1], 10);
        const latMin = Number.parseFloat(dmMatch[2]);
        const latDir = dmMatch[3].toUpperCase();
        const lngDeg = Number.parseInt(dmMatch[4], 10);
        const lngMin = Number.parseFloat(dmMatch[5]);
        const lngDir = dmMatch[6].toUpperCase();

        // Convert to decimal
        let lat = latDeg + latMin / 60;
        let lng = lngDeg + lngMin / 60;

        // Apply direction
        if (latDir === 'S') lat = -lat;
        if (lngDir === 'W') lng = -lng;

        // Validate ranges
        if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
            return { lat, lng };
        }
    }

    return null;
}

function formatCoordinates(lng, lat) {
    const gmaps = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    const latM = (Math.abs(lat) % 1) * 60;
    const lngM = (Math.abs(lng) % 1) * 60;
    const dm = `${Math.floor(Math.abs(lat))}° ${latM.toFixed(3)}' ${lat >= 0 ? 'N' : 'S'}, ${Math.floor(Math.abs(lng))}° ${lngM.toFixed(3)}' ${lng >= 0 ? 'E' : 'W'}`;
    return { gmaps, display: dm };
}
