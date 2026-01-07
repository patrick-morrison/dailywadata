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
    DEFAULT_RADIUS: 50, // Default radius in meters

    // Color mapping for different feature types
    FEATURE_COLORS: {
        'Shaft': [139, 69, 19],              // Saddle brown
        'Adit': [101, 67, 33],               // Dark brown
        'Costean/Trench': [210, 180, 140],   // Tan
        'Pit/Quarry': [244, 164, 96],        // Sandy brown
        'Open Stope': [205, 133, 63],        // Peru
        'Waste Dump': [160, 120, 80],        // Medium brown
        'Tailings Dump': [180, 140, 100],    // Light brown
        'Other': [169, 169, 169],            // Gray for other/unknown
        '__NULL__': [200, 200, 200]          // Light gray for null
    },

    // Color mapping for condition (red to green gradient)
    CONDITION_COLORS: {
        'Poor': [180, 50, 50],               // Dark red
        'Fair': [200, 150, 60],              // Amber/orange
        'Good': [80, 140, 80],               // Green
        '__NULL__': [150, 150, 150]          // Gray
    },

    // Color mapping for base condition (subsidence severity)
    BASE_CONDITION_COLORS: {
        'Severe Subsidence': [150, 40, 40],      // Deep red
        'Moderate Subsidence': [190, 80, 60],    // Red-orange
        'Slight Subsidence': [210, 140, 90],     // Orange-brown
        'Firm': [100, 130, 100],                 // Green-gray
        'Undercut/Overhang': [180, 60, 60],      // Red
        'Cracked': [200, 100, 80],               // Orange-red
        'Conical Collar': [160, 140, 100],       // Tan
        'Severely Eroded': [190, 110, 70],       // Orange
        'Unknown': [140, 140, 140],              // Medium gray
        '__NULL__': [170, 170, 170]              // Light gray
    },

    // Color mapping for commodities (top commodities + Other)
    COMMODITY_COLORS: {
        'Gold': [218, 165, 32],              // Goldenrod
        'Iron': [139, 90, 90],               // Dark red-brown
        'Copper': [184, 115, 51],            // Copper color
        'Nickel': [192, 192, 192],           // Silver
        'Tin': [169, 169, 169],              // Gray
        'Manganese': [80, 60, 80],           // Purple-gray
        'Lead': [120, 120, 140],             // Blue-gray
        'Zinc': [160, 170, 180],             // Light blue-gray
        'Silver': [220, 220, 230],           // Bright silver
        'Tantalum': [100, 80, 120],          // Purple
        'Tungsten': [140, 140, 130],         // Warm gray
        'Coal': [40, 40, 40],                // Near black
        'Phosphate': [200, 180, 140],        // Beige
        'Gypsum': [240, 235, 230],           // Off-white
        'Lithium': [230, 230, 250],          // Lavender
        'Other': [170, 150, 130],            // Medium brown
        '__NULL__': [180, 180, 180]          // Light gray
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
 * Field mapping for filter types to CSV column names
 */
const FILTER_FIELD_MAP = {
    'feature-type': 'FEATURE_TY',
    'site-subtype': 'SITE_SUB_T',
    'base-condition': 'BASE_CONDI',
    'condition': 'CONDITION',
    'visibility': 'VISIBILITY',
    'commodity': 'COMMODITIE',
    'excavation': 'EXCAVATION'
};

/**
 * Normalize filter value to handle null/empty/invalid values
 */
function normalizeFilterValue(properties, filterType) {
    const field = FILTER_FIELD_MAP[filterType];
    const value = properties[field];

    // Handle null/empty values
    if (!value || value === 'null' || value.trim() === '' || value === '-9999' || value === '-9999.000000000000000') {
        return '__NULL__';
    }

    const trimmed = value.trim();

    // Special handling for commodities (may have multiple comma-separated values)
    if (filterType === 'commodity') {
        // Take first commodity if multiple
        return trimmed.split(',')[0].trim();
    }

    return trimmed;
}

/**
 * Check if a feature passes all active filters (AND logic)
 */
function featurePassesFilters(feature) {
    // For each filter dimension
    for (const [filterType, allowedValues] of Object.entries(state.filters)) {
        // If this dimension has active filters
        if (allowedValues.size > 0) {
            const featureValue = normalizeFilterValue(feature.properties, filterType);

            // Check if feature's value is in the allowed set
            if (!allowedValues.has(featureValue)) {
                return false; // Fail fast on first non-match
            }
        }
    }

    return true; // Passes all filters
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

/**
 * Compute filter statistics from loaded data
 * This runs once when data is loaded and caches results
 */
function computeFilterStatistics(geojson) {
    const stats = {
        'feature-type': {},
        'site-subtype': {},
        'base-condition': {},
        'condition': {},
        'visibility': {},
        'commodity': {},
        'excavation': {}
    };

    // Count occurrences of each value in each dimension
    for (const feature of geojson.features) {
        for (const [filterType, counts] of Object.entries(stats)) {
            const value = normalizeFilterValue(feature.properties, filterType);
            counts[value] = (counts[value] || 0) + 1;
        }
    }

    // Sort each dimension by count (descending)
    for (const filterType of Object.keys(stats)) {
        const sorted = Object.entries(stats[filterType])
            .sort((a, b) => b[1] - a[1]);

        stats[filterType] = Object.fromEntries(sorted);
    }

    return stats;
}

/**
 * Identify top commodities for color mapping
 */
function getTopCommodities(stats) {
    const commodities = stats['commodity'];
    const sorted = Object.entries(commodities)
        .filter(([value]) => value !== '__NULL__')
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([value]) => value);

    return new Set(sorted);
}

/**
 * Get color function for current display mode
 */
function getColorFunctionForDisplayMode(displayMode) {
    const colorMaps = {
        'feature-type': CONFIG.FEATURE_COLORS,
        'condition': CONFIG.CONDITION_COLORS,
        'base-condition': CONFIG.BASE_CONDITION_COLORS,
        'commodity': CONFIG.COMMODITY_COLORS
    };

    const colorMap = colorMaps[displayMode];
    const filterType = displayMode;

    return (d) => {
        const value = normalizeFilterValue(d.properties, filterType);

        // For commodities, map non-top-15 to "Other"
        let colorKey = value;
        if (displayMode === 'commodity' && value !== '__NULL__') {
            if (!state.topCommodities || !state.topCommodities.has(value)) {
                colorKey = 'Other';
            }
        }

        const color = colorMap[colorKey] || colorMap['Other'] || [169, 169, 169];
        return [...color, CONFIG.CIRCLE_OPACITY * 255];
    };
}

/**
 * Get color for a specific value (for legend display)
 */
function getColorForValue(filterType, value) {
    const colorMaps = {
        'feature-type': CONFIG.FEATURE_COLORS,
        'condition': CONFIG.CONDITION_COLORS,
        'base-condition': CONFIG.BASE_CONDITION_COLORS,
        'commodity': CONFIG.COMMODITY_COLORS
    };

    const colorMap = colorMaps[filterType];
    if (!colorMap) return [169, 169, 169]; // Default gray

    // For commodities, map non-top-15 to "Other"
    let colorKey = value;
    if (filterType === 'commodity' && value !== '__NULL__') {
        if (!state.topCommodities || !state.topCommodities.has(value)) {
            colorKey = 'Other';
        }
    }

    return colorMap[colorKey] || colorMap['Other'] || [169, 169, 169];
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

    // Active tab and display mode
    activeTab: 'feature-type',
    displayMode: 'feature-type', // 'feature-type' | 'condition' | 'base-condition' | 'commodity'

    // Multi-dimensional filters (Set-based for performance)
    // Empty Set = all visible (no filter active)
    filters: {
        'feature-type': new Set(),
        'site-subtype': new Set(),
        'base-condition': new Set(),
        'condition': new Set(),
        'visibility': new Set(),
        'commodity': new Set(),
        'excavation': new Set()
    },

    // Cached filter statistics (computed once on load)
    filterStats: null,

    // Top commodities for color mapping
    topCommodities: null
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
    initializeTabNavigation();
    initializeDisplayModeSelector();
    initializeMobileLegendCollapse();

    // Wire up clear filters button
    document.querySelector('.clear-filters-btn').addEventListener('click', clearAllFilters);
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

        // Compute filter statistics (once on load)
        setLoadingText('Computing filter statistics...');
        state.filterStats = computeFilterStatistics(geojson);
        state.topCommodities = getTopCommodities(state.filterStats);

        // Update mine count
        document.getElementById('mine-count').textContent = geojson.features.length.toLocaleString();

        // Initialize filter panels with data
        initializeFilterPanels(state.filterStats);

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
    if (!geojson) return;

    // Filter features based on ALL active filters (AND logic)
    const visibleFeatures = geojson.features.filter(featurePassesFilters);

    // Get color function based on display mode
    const colorFunction = getColorFunctionForDisplayMode(state.displayMode);

    // Create deck.gl layer
    const scatterplotLayer = new deck.ScatterplotLayer({
        id: 'mines',
        data: visibleFeatures,
        getPosition: d => d.geometry.coordinates,
        getRadius: d => CONFIG.DEFAULT_RADIUS,
        getFillColor: colorFunction,
        onHover: e => {
            const mine = queryNearestMine(e);
            if (mine) {
                map.getCanvas().style.cursor = 'pointer';
            } else {
                map.getCanvas().style.cursor = '';
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

    // Update visible count
    updateVisibleCount(visibleFeatures.length);
}

/**
 * Initialize filter panels with data from statistics
 */
function initializeFilterPanels(stats) {
    const panels = {
        'feature-type': document.querySelector('[data-panel="feature-type"]'),
        'site-subtype': document.querySelector('[data-panel="site-subtype"]'),
        'base-condition': document.querySelector('[data-panel="base-condition"]'),
        'condition': document.querySelector('[data-panel="condition"]'),
        'visibility': document.querySelector('[data-panel="visibility"]'),
        'commodity': document.querySelector('[data-panel="commodity"]'),
        'excavation': document.querySelector('[data-panel="excavation"]')
    };

    for (const [filterType, panel] of Object.entries(panels)) {
        const counts = stats[filterType];

        // Find the header (keep it)
        const header = panel.querySelector('.filter-panel-header');

        // Clear existing content except header
        while (panel.lastChild && panel.lastChild !== header) {
            panel.removeChild(panel.lastChild);
        }

        // Create filter items
        for (const [value, count] of Object.entries(counts)) {
            const item = createFilterItem(filterType, value, count);
            panel.appendChild(item);
        }
    }
}

/**
 * Create a filter item element
 */
function createFilterItem(filterType, value, count) {
    const item = document.createElement('div');
    item.className = 'filter-item active';
    item.dataset.filterType = filterType;
    item.dataset.filterValue = value;

    // Color indicator (only for display-mode-compatible types)
    const showColor = (
        filterType === 'feature-type' ||
        filterType === 'condition' ||
        filterType === 'base-condition' ||
        filterType === 'commodity'
    );

    if (showColor && filterType === state.displayMode) {
        const color = getColorForValue(filterType, value);
        const colorDiv = document.createElement('div');
        colorDiv.className = 'filter-color';
        colorDiv.style.background = `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.7)`;
        item.appendChild(colorDiv);
    }

    // Label
    const label = document.createElement('span');
    label.className = 'filter-label';
    label.textContent = value === '__NULL__' ? 'Unknown / Not recorded' : value;
    item.appendChild(label);

    // Count
    const countSpan = document.createElement('span');
    countSpan.className = 'filter-count';
    countSpan.textContent = count.toLocaleString();
    item.appendChild(countSpan);

    // Click handler
    item.addEventListener('click', () => {
        toggleFilter(filterType, value);
    });

    return item;
}

/**
 * Update the visual state of filter items based on current filter Set
 */
function updateFilterItemsUI(filterType) {
    const filterSet = state.filters[filterType];
    const panel = document.querySelector(`[data-panel="${filterType}"]`);

    if (!panel) return;

    panel.querySelectorAll('.filter-item').forEach(item => {
        const itemValue = item.dataset.filterValue;

        // If filter Set is empty, all items should be active
        // If filter Set has values, only items in the Set should be active
        if (filterSet.size === 0 || filterSet.has(itemValue)) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
}

/**
 * Toggle a filter value
 */
function toggleFilter(filterType, value) {
    const filterSet = state.filters[filterType];

    if (filterSet.has(value)) {
        filterSet.delete(value);
    } else {
        filterSet.add(value);
    }

    // Update visual state and re-render
    updateFilterItemsUI(filterType);
    renderMines(state.geojsonData);
    updateActiveFilterSummary();
    updateTabIndicators();
}

/**
 * Clear all filters across all dimensions
 */
function clearAllFilters() {
    for (const filterType of Object.keys(state.filters)) {
        state.filters[filterType].clear();
        updateFilterItemsUI(filterType);
    }

    renderMines(state.geojsonData);
    updateActiveFilterSummary();
    updateTabIndicators();
}

/**
 * Update active filter summary display
 */
function updateActiveFilterSummary() {
    let activeCount = 0;
    for (const filterSet of Object.values(state.filters)) {
        activeCount += filterSet.size;
    }

    const countEl = document.querySelector('.active-count');
    if (activeCount === 0) {
        countEl.textContent = 'No filters active';
    } else {
        countEl.textContent = `${activeCount} filter${activeCount === 1 ? '' : 's'} active`;
    }
}

/**
 * Update tab indicators to show which tabs have active filters
 */
function updateTabIndicators() {
    document.querySelectorAll('.filter-tab').forEach(tab => {
        const tabName = tab.dataset.tab;
        const hasActiveFilters = state.filters[tabName]?.size > 0;

        tab.classList.toggle('has-active-filters', hasActiveFilters);
    });
}

/**
 * Update visible feature count display
 */
function updateVisibleCount(count) {
    const statsEl = document.querySelector('.stats-value');
    statsEl.textContent = `${count.toLocaleString()} / ${state.geojsonData.features.length.toLocaleString()}`;
}

/**
 * Initialize tab navigation
 */
function initializeTabNavigation() {
    const tabs = document.querySelectorAll('.filter-tab');
    const panels = document.querySelectorAll('.filter-panel');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Update active tab
            const targetPanel = tab.dataset.tab;
            state.activeTab = targetPanel;

            // Update UI
            tabs.forEach(t => t.classList.remove('active'));
            panels.forEach(p => p.classList.remove('active'));

            tab.classList.add('active');
            document.querySelector(`[data-panel="${targetPanel}"]`).classList.add('active');

            // Update legend colors if the active tab matches display mode
            updateLegendForDisplayMode(state.displayMode);

            // Save preference to localStorage
            localStorage.setItem('mines-active-tab', targetPanel);
        });
    });

    // Restore last active tab
    const savedTab = localStorage.getItem('mines-active-tab');
    if (savedTab) {
        const tabToClick = document.querySelector(`[data-tab="${savedTab}"]`);
        if (tabToClick) tabToClick.click();
    }
}

/**
 * Initialize display mode selector
 */
function initializeDisplayModeSelector() {
    const selector = document.getElementById('display-mode');

    selector.addEventListener('change', (e) => {
        state.displayMode = e.target.value;
        renderMines(state.geojsonData);
        updateLegendForDisplayMode(state.displayMode);

        // Save preference
        localStorage.setItem('mines-display-mode', state.displayMode);
    });

    // Restore saved preference
    const savedMode = localStorage.getItem('mines-display-mode');
    if (savedMode) {
        selector.value = savedMode;
        state.displayMode = savedMode;
    }
}

/**
 * Update legend colors when display mode changes
 */
function updateLegendForDisplayMode(displayMode) {
    // Update color indicators in the active panel
    const activePanel = document.querySelector('.filter-panel.active');
    if (!activePanel) return;

    const filterType = activePanel.dataset.panel;

    // Only show colors if display mode matches filter type
    const shouldShowColors = filterType === displayMode;

    activePanel.querySelectorAll('.filter-item').forEach(item => {
        const colorDiv = item.querySelector('.filter-color');
        const value = item.dataset.filterValue;

        if (shouldShowColors && !colorDiv) {
            // Add color indicator
            const color = getColorForValue(filterType, value);
            const newColorDiv = document.createElement('div');
            newColorDiv.className = 'filter-color';
            newColorDiv.style.background = `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.7)`;
            item.insertBefore(newColorDiv, item.firstChild);
        } else if (!shouldShowColors && colorDiv) {
            // Remove color indicator
            colorDiv.remove();
        } else if (shouldShowColors && colorDiv) {
            // Update existing color
            const color = getColorForValue(filterType, value);
            colorDiv.style.background = `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.7)`;
        }
    });
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
        const featureType = normalizeFilterValue(props, 'feature-type');
        const siteName = props.WABMINES_N || 'Unknown';
        valueEl.textContent = `${featureType} - ${siteName}`;
        coordsEl.innerHTML = `<span class="copyable" title="Copy decimal">${r.gmaps}</span><br><span class="copyable" title="Copy DM">${r.display}</span>`;
    } else {
        valueEl.textContent = '--';
        coordsEl.textContent = '--';
    }
}

// ============================================
// Enhanced Popup Content Generation
// ============================================

function isValidValue(value) {
    return value && value !== 'null' && value.trim() !== '' && value !== '-9999';
}

function generatePopupContent(props, coordinates) {
    // Field configuration organized by category
    const fieldConfig = {
        'Primary Info': [
            { key: 'WABMINES_N', label: 'Site Name' },
            { key: 'FEATURE_TY', label: 'Feature Type', transform: normalizeFilterValue },
            { key: 'SITE_TYPE', label: 'Site Type' },
            { key: 'SITE_CODE', label: 'Site Code' }
        ],
        'Location': [
            { key: 'LOCALITY', label: 'Locality' },
            { key: 'LEASE_NUMB', label: 'Lease Number' },
            { key: 'LGA_NAME', label: 'Local Government Area' },
            { key: 'SHIRE_NAME', label: 'Shire' }
        ],
        'Commodities': [
            { key: 'COMMODITIE', label: 'Commodities' },
            { key: 'MINERAL_FI', label: 'Mineral Field' }
        ],
        'Condition': [
            { key: 'CONDITION', label: 'Condition' },
            { key: 'BASE_CONDI', label: 'Base Condition' },
            { key: 'SITE_SUB_T', label: 'Site Subtype' },
            { key: 'VISIBILITY', label: 'Visibility' }
        ],
        'Physical Characteristics': [
            { key: 'EXCAVATION', label: 'Excavation' },
            { key: 'DEPTH_LENG', label: 'Depth/Length' },
            { key: 'WIDTH', label: 'Width' },
            { key: 'ORIENTATIO', label: 'Orientation' },
            { key: 'SLOPE', label: 'Slope' }
        ],
        'Safety Features': [
            { key: 'FENCE', label: 'Fence' },
            { key: 'FENCE_COND', label: 'Fence Condition' },
            { key: 'GATE', label: 'Gate' },
            { key: 'SIGNAGE', label: 'Signage' },
            { key: 'CAP', label: 'Cap' },
            { key: 'BACKFILL', label: 'Backfill' }
        ],
        'Underground': [
            { key: 'DECLINE', label: 'Decline' },
            { key: 'ACCESSIBLE', label: 'Accessible' },
            { key: 'WATER_LEVE', label: 'Water Level' },
            { key: 'TIMBER', label: 'Timber' }
        ],
        'Other': [
            { key: 'ENVIRONMEN', label: 'Environment' },
            { key: 'LAND_USE', label: 'Land Use' },
            { key: 'SURVEY_DAT', label: 'Survey Date' },
            { key: 'COMMENT', label: 'Comments' }
        ]
    };

    let html = '';

    // Build sections
    for (const [sectionName, fields] of Object.entries(fieldConfig)) {
        const validFields = fields.filter(f => isValidValue(props[f.key]));

        if (validFields.length > 0) {
            html += `<div class="popup-section">`;
            html += `<div class="popup-section-title">${sectionName}</div>`;
            html += `<div class="popup-section-content">`;

            for (const field of validFields) {
                let value = props[field.key];
                if (field.transform) {
                    value = field.transform(value);
                }
                html += `<div class="popup-field">`;
                html += `<div class="popup-label">${field.label}:</div>`;
                html += `<div class="popup-value">${value}</div>`;
                html += `</div>`;
            }

            html += `</div></div>`;
        }
    }

    // Add coordinates
    html += `<div class="popup-coords copyable">${coordinates.gmaps}</div>`;
    html += `<div class="popup-coords-dm copyable">${coordinates.display}</div>`;

    // Add action buttons
    html += `<div class="popup-actions">`;
    html += `<button class="popup-share-btn" data-lat="${props.Y}" data-lng="${props.X}">`;
    html += `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">`;
    html += `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>`;
    html += `<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`;
    html += `</svg><span>Copy Link</span></button>`;

    if (isValidValue(props.WEB_LINK)) {
        html += `<a href="${props.WEB_LINK}" target="_blank" rel="noopener noreferrer" class="popup-web-link-btn">`;
        html += `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">`;
        html += `<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`;
        html += `<polyline points="15 3 21 3 21 9"/>`;
        html += `<line x1="10" y1="14" x2="21" y2="3"/>`;
        html += `</svg><span>View on Minedex</span></a>`;
    }

    html += `</div>`;

    return html;
}

function showClickPopup(mine, lng, lat) {
    const props = mine.properties;

    if (state.clickMarker) state.clickMarker.remove();
    if (state.clickPopup) state.clickPopup.remove();

    const el = document.createElement('div');
    el.className = 'click-marker';
    state.clickMarker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
    const trueLng = mine.geometry.coordinates[0];
    const trueLat = mine.geometry.coordinates[1];

    const r = formatCoordinates(trueLng, trueLat);
    const popupHTML = generatePopupContent(props, r);

    state.clickPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, className: 'mine-popup', offset: 12 })
        .setLngLat([lng, lat])
        .setHTML(popupHTML)
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
