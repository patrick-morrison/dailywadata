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
        lng: 121.0,
        lat: -26.0,
        zoom: 5
    }
};

// ============================================
// State Management
// ============================================

const state = {
    // Layer states
    layerVisibility: {
        '5': true,
        '3': false,
        '4': false
    },
    layerOpacity: {
        '5': 1,
        '3': 1,
        '4': 1
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
    activeBasemap: 'street',

    // Geolocation
    userLocationMarker: null,
    watchId: null,
    isTracking: false,
    deviceHeading: null,

    // Popups
    activePopup: null
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
                    visibility: 'visible'
                }
            },
            {
                id: 'esri-satellite-layer',
                type: 'raster',
                source: 'esri-satellite',
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

map.on('load', () => {
    // Add WMS sources and layers
    addWmsLayers();

    // Load and add vector layers
    loadShipwrecks();
    loadMines();

    // Initialize controls
    initializeLayerControls();
    initializeBasemapToggle();
    initializeShipwrecksToggle();
    initializeMinesToggle();
    initializeMobileLegendCollapse();

    // Hide loading
    setTimeout(() => {
        document.getElementById('loading').classList.add('hidden');
    }, 500);
});

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
    map.setLayoutProperty(`wms-layer-${layerId}`, 'visibility', visible ? 'visible' : 'none');

    // Update UI state
    const control = document.querySelector(`.layer-control[data-layer="${layerId}"]`);
    if (control) {
        control.classList.toggle('disabled', !visible);
    }
}

function updateLayerOpacity(layerId, opacity) {
    state.layerOpacity[layerId] = opacity;
    map.setPaintProperty(`wms-layer-${layerId}`, 'raster-opacity', opacity);
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
                    type_of_si: 'Ship',
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
                    when_lost: '1946/09/01',
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
            }
        ];
        geojson.features.push(...manualWrecks);

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
        const siteTypeIdx = headers.indexOf('SITE_TYPE');
        const stageIdx = headers.indexOf('STAGE');
        const commoditiesIdx = headers.indexOf('COMMODITIES');

        // Convert to GeoJSON
        const features = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // Handle CSV with quoted fields
            const values = parseCSVLine(line);
            const lon = parseFloat(values[lonIdx]);
            const lat = parseFloat(values[latIdx]);

            if (isNaN(lon) || isNaN(lat)) continue;

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

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
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

    window.addEventListener('resize', () => {
        if (!isMobile()) {
            legendTitle.classList.remove('collapsed');
            legendContent.classList.remove('collapsed');
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
        window.removeEventListener('deviceorientation', handleDeviceOrientation);
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
                        window.addEventListener('deviceorientation', handleDeviceOrientation);
                    }
                })
                .catch(console.error);
        } else {
            window.addEventListener('deviceorientation', handleDeviceOrientation);
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
    if (!state.userLocationMarker) {
        const el = document.createElement('div');
        el.className = 'user-location-marker';
        el.innerHTML = '<div class="location-heading"></div><div class="location-dot"></div>';
        state.userLocationMarker = new maplibregl.Marker({ element: el }).setLngLat([longitude, latitude]).addTo(map);
    } else {
        state.userLocationMarker.setLngLat([longitude, latitude]);
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
// Utilities
// ============================================

function formatCoordinates(lng, lat) {
    const gmaps = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    const latM = (Math.abs(lat) % 1) * 60;
    const lngM = (Math.abs(lng) % 1) * 60;
    const dm = `${Math.floor(Math.abs(lat))}° ${latM.toFixed(3)}' ${lat >= 0 ? 'N' : 'S'}, ${Math.floor(Math.abs(lng))}° ${lngM.toFixed(3)}' ${lng >= 0 ? 'E' : 'W'}`;
    return { gmaps, display: dm };
}
