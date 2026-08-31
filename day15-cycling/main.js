/**
 * Western Australia Cycling Routes Visualization
 * Interactive map showing the Long Term Cycle Network
 */

// ============================================
// Constants & Configuration
// ============================================

const CONFIG = {
    // Data URLs
    METRO_URL: 'LTCN_20251002.geojson',
    REGIONAL_URL: 'LTCN_Regional_20260105.geojson',

    // Color scheme (RGB arrays)
    HIERARCHY_COLORS: {
        'Primary Route': [31, 120, 180],        // Blue
        'Secondary Route': [51, 160, 44],       // Green
        'Local Route': [227, 26, 28],           // Red
        'Transport Trail': [255, 127, 0],       // Orange
        'Road Cycling Route': [106, 61, 154]    // Purple
    },

    // Line widths (pixels)
    HIERARCHY_WIDTHS: {
        'Primary Route': 4,
        'Secondary Route': 3,
        'Local Route': 2,
        'Transport Trail': 3,
        'Road Cycling Route': 2.5
    },

    // Initial map view
    INITIAL_VIEW: {
        lng: 116.5,
        lat: -27.5,
        zoom: 5.5
    }
};

// ============================================
// State Management
// ============================================

const state = {
    metroData: null,
    regionalData: null,
    deckOverlay: null,
    routePopup: null,

    // Geolocation
    userLocationMarker: null,
    watchId: null,
    isTracking: false,

    // Network visibility toggles
    visibleNetworks: {
        metro: true,
        regional: true
    },

    // Hierarchy type visibility toggles
    visibleHierarchy: {
        'Primary Route': true,
        'Secondary Route': true,
        'Local Route': true,
        'Transport Trail': true,
        'Road Cycling Route': true
    },

    // Line-style visibility toggles
    visibleLineStyles: {
        'Final/Existing': true,
        'Draft/Proposed': true
    },

    // Selected route state
    selectedRoute: {
        id: null,
        networkType: null
    },

    // Geographic filter state
    visibleGeographic: {
        regions: new Set(),
        councils: new Set()
    },

    // Track if route click occurred (for map click handler)
    routeClickHandled: false
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
                    'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png?key=cb1_2myl_1_31461085fa422f814744aaaf',
                    'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png?key=cb1_2myl_1_31461085fa422f814744aaaf',
                    'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png?key=cb1_2myl_1_31461085fa422f814744aaaf'
                ],
                tileSize: 256
            },
            'carto-dark': {
                type: 'raster',
                tiles: [
                    'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png?key=cb1_2myl_1_31461085fa422f814744aaaf',
                    'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png?key=cb1_2myl_1_31461085fa422f814744aaaf',
                    'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png?key=cb1_2myl_1_31461085fa422f814744aaaf'
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
    minZoom: 6,
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
    loadCyclingData();
    initializeLegendToggles();
    initializePanelCollapse();
    initializeDarkMode();
    initializeMobileLegendCollapse();
});

// Map Click - Clear selection when clicking on empty map area
// Use setTimeout to ensure Deck.gl onClick fires first
map.on('click', () => {
    setTimeout(() => {
        if (!state.routeClickHandled) {
            clearRouteInfo();
        }
        state.routeClickHandled = false;
    }, 0);
});

// Legend Toggle Functionality - Networks
function initializeLegendToggles() {
    // Network toggles
    const networkItems = document.querySelectorAll('.legend-item[data-network]');
    for (const item of networkItems) {
        item.addEventListener('click', () => {
            const network = item.dataset.network;
            state.visibleNetworks[network] = !state.visibleNetworks[network];
            item.classList.toggle('active');
            renderCyclingLayers(state.metroData, state.regionalData);
        });
    }

    // Hierarchy toggles
    const hierarchyItems = document.querySelectorAll('.legend-item[data-hierarchy]');
    for (const item of hierarchyItems) {
        item.addEventListener('click', () => {
            const hierarchy = item.dataset.hierarchy;
            state.visibleHierarchy[hierarchy] = !state.visibleHierarchy[hierarchy];
            item.classList.toggle('active');
            renderCyclingLayers(state.metroData, state.regionalData);
        });
    }

    // Line-style toggles
    const lineStyleItems = document.querySelectorAll('.legend-item[data-linestyle]');
    for (const item of lineStyleItems) {
        item.addEventListener('click', () => {
            const lineStyle = item.dataset.linestyle;
            state.visibleLineStyles[lineStyle] = !state.visibleLineStyles[lineStyle];
            item.classList.toggle('active');
            renderCyclingLayers(state.metroData, state.regionalData);
        });
    }
}

// Panel Collapse Functionality
function initializePanelCollapse() {
    // Info panel collapse
    const infoHeader = document.getElementById('info-header');
    const infoContent = document.getElementById('info-content');

    infoHeader.addEventListener('click', () => {
        infoHeader.classList.toggle('collapsed');
        infoContent.classList.toggle('collapsed');
    });

    // Filters panel collapse
    const filtersHeader = document.getElementById('filters-header');
    const filtersContent = document.getElementById('filters-content');

    filtersHeader.addEventListener('click', () => {
        filtersHeader.classList.toggle('collapsed');
        filtersContent.classList.toggle('collapsed');
    });
}

document.getElementById('location-btn').addEventListener('click', toggleGeolocation);

// Dark Mode Toggle
function initializeDarkMode() {
    // Default to light mode, allow localStorage to override
    const savedMode = localStorage.getItem('darkMode');
    const isDark = savedMode !== null ? savedMode === 'true' : false;
    const checkbox = document.getElementById('dark-mode-checkbox');

    checkbox.checked = isDark;

    if (isDark) {
        document.body.classList.add('dark-mode');
        map.setLayoutProperty('carto-light-layer', 'visibility', 'none');
        map.setLayoutProperty('carto-dark-layer', 'visibility', 'visible');
    }
}

document.getElementById('dark-mode-checkbox').addEventListener('change', (e) => {
    const isDark = e.target.checked;
    localStorage.setItem('darkMode', isDark.toString());

    if (isDark) {
        document.body.classList.add('dark-mode');
        map.setLayoutProperty('carto-light-layer', 'visibility', 'none');
        map.setLayoutProperty('carto-dark-layer', 'visibility', 'visible');
    } else {
        document.body.classList.remove('dark-mode');
        map.setLayoutProperty('carto-dark-layer', 'visibility', 'none');
        map.setLayoutProperty('carto-light-layer', 'visibility', 'visible');
    }
});

// Mobile Legend Collapse
function initializeMobileLegendCollapse() {
    const legendTitles = document.querySelectorAll('.legend-title');

    const isMobile = () => window.innerWidth <= 768;

    legendTitles.forEach((title, index) => {
        const content = title.nextElementSibling;

        if (isMobile() && index > 0) {
            title.classList.add('collapsed');
            if (content && content.classList.contains('legend-content')) {
                content.classList.add('collapsed');
            }
        }

        title.addEventListener('click', () => {
            if (isMobile() && content && content.classList.contains('legend-content')) {
                title.classList.toggle('collapsed');
                content.classList.toggle('collapsed');
            }
        });
    });

    window.addEventListener('resize', () => {
        if (!isMobile()) {
            legendTitles.forEach(title => {
                const content = title.nextElementSibling;
                title.classList.remove('collapsed');
                if (content && content.classList.contains('legend-content')) {
                    content.classList.remove('collapsed');
                }
            });
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

async function loadCyclingData() {
    try {
        setLoadingText('Loading metro cycling routes...');
        const metroResponse = await fetch(CONFIG.METRO_URL);
        const metroData = await metroResponse.json();
        state.metroData = metroData;

        setLoadingText('Loading regional cycling routes...');
        const regionalResponse = await fetch(CONFIG.REGIONAL_URL);
        const regionalData = await regionalResponse.json();
        state.regionalData = regionalData;

        // Update counts in legend
        document.getElementById('metro-count').textContent = metroData.features.length.toLocaleString();
        document.getElementById('regional-count').textContent = regionalData.features.length.toLocaleString();

        // Initialize geographic filter FIRST
        initializeGeographicFilter(metroData, regionalData);
        initializeGeographicSearch();
        initializeGeographicToggleAll();

        // Render layers AFTER filter is initialized
        renderCyclingLayers(metroData, regionalData);

        // Hide loading
        setTimeout(() => {
            document.getElementById('loading').classList.add('hidden');
        }, 500);

    } catch (error) {
        console.error('Failed to load cycling data:', error);
        setLoadingText('Failed to load data');
    }
}

// ============================================
// Geographic Filter
// ============================================

function initializeGeographicFilter(metroData, regionalData) {
    // Extract unique councils from metro data
    const councils = new Set();
    metroData.features.forEach(f => {
        if (f.properties.LGA_Name) {
            councils.add(f.properties.LGA_Name);
        }
    });

    // Extract unique regions from regional data
    const regions = new Set();
    regionalData.features.forEach(f => {
        if (f.properties.Strategy) {
            regions.add(f.properties.Strategy);
        }
    });

    // Initialize state with all areas selected
    state.visibleGeographic.councils = new Set(councils);
    state.visibleGeographic.regions = new Set(regions);

    // Populate region list
    const regionList = document.getElementById('region-list');
    Array.from(regions).sort().forEach(region => {
        const item = createGeoCheckboxItem(region, 'region');
        regionList.appendChild(item);
    });

    // Populate council list
    const councilList = document.getElementById('council-list');
    Array.from(councils).sort().forEach(council => {
        const item = createGeoCheckboxItem(council, 'council');
        councilList.appendChild(item);
    });

    // Update summary
    updateGeoSummary();
}

function createGeoCheckboxItem(name, type) {
    const item = document.createElement('div');
    item.className = 'geo-checkbox-item active';
    item.dataset.name = name;
    item.dataset.type = type;

    item.innerHTML = `
        <div class="geo-checkbox"></div>
        <div class="geo-checkbox-label">${name}</div>
    `;

    item.addEventListener('click', () => {
        toggleGeographicFilter(name, type, item);
    });

    return item;
}

function toggleGeographicFilter(name, type, element) {
    const isActive = element.classList.contains('active');

    if (isActive) {
        // Deactivate
        element.classList.remove('active');
        if (type === 'region') {
            state.visibleGeographic.regions.delete(name);
        } else {
            state.visibleGeographic.councils.delete(name);
        }
    } else {
        // Activate
        element.classList.add('active');
        if (type === 'region') {
            state.visibleGeographic.regions.add(name);
        } else {
            state.visibleGeographic.councils.add(name);
        }
    }

    updateGeoSummary();
    renderCyclingLayers(state.metroData, state.regionalData);
}

function updateGeoSummary() {
    const totalRegions = document.querySelectorAll('.geo-checkbox-item[data-type="region"]').length;
    const totalCouncils = document.querySelectorAll('.geo-checkbox-item[data-type="council"]').length;
    const selectedRegions = state.visibleGeographic.regions.size;
    const selectedCouncils = state.visibleGeographic.councils.size;

    const summary = document.getElementById('geo-summary');

    if (selectedRegions === totalRegions && selectedCouncils === totalCouncils) {
        summary.textContent = 'All areas selected';
    } else if (selectedRegions === 0 && selectedCouncils === 0) {
        summary.textContent = 'No areas selected';
    } else {
        const parts = [];
        if (selectedRegions > 0) parts.push(`${selectedRegions}/${totalRegions} regions`);
        if (selectedCouncils > 0) parts.push(`${selectedCouncils}/${totalCouncils} councils`);
        summary.textContent = parts.join(', ');
    }
}

function initializeGeographicSearch() {
    const searchInput = document.getElementById('geo-search');

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        const items = document.querySelectorAll('.geo-checkbox-item');

        if (query === '') {
            // Show all items
            items.forEach(item => item.classList.remove('hidden'));
        } else {
            // Filter by substring match
            items.forEach(item => {
                const name = item.dataset.name.toLowerCase();
                if (name.includes(query)) {
                    item.classList.remove('hidden');
                } else {
                    item.classList.add('hidden');
                }
            });
        }
    });
}

function initializeGeographicToggleAll() {
    const selectAllBtn = document.getElementById('geo-select-all');
    const deselectAllBtn = document.getElementById('geo-deselect-all');

    selectAllBtn.addEventListener('click', () => {
        const items = document.querySelectorAll('.geo-checkbox-item');

        items.forEach(item => {
            if (!item.classList.contains('active')) {
                const name = item.dataset.name;
                const type = item.dataset.type;

                item.classList.add('active');
                if (type === 'region') {
                    state.visibleGeographic.regions.add(name);
                } else {
                    state.visibleGeographic.councils.add(name);
                }
            }
        });

        updateGeoSummary();
        renderCyclingLayers(state.metroData, state.regionalData);
    });

    deselectAllBtn.addEventListener('click', () => {
        const items = document.querySelectorAll('.geo-checkbox-item');

        items.forEach(item => {
            if (item.classList.contains('active')) {
                const name = item.dataset.name;
                const type = item.dataset.type;

                item.classList.remove('active');
                if (type === 'region') {
                    state.visibleGeographic.regions.delete(name);
                } else {
                    state.visibleGeographic.councils.delete(name);
                }
            }
        });

        updateGeoSummary();
        renderCyclingLayers(state.metroData, state.regionalData);
    });
}

// Get unique identifier for a route
function getRouteId(feature, networkType) {
    const props = feature.properties;

    if (networkType === 'metro') {
        // Metro routes have unique Route_ID
        return `metro_${props.Route_ID}`;
    } else {
        // Try to use geometry coordinates for uniqueness
        try {
            const coords = feature.geometry?.coordinates;
            if (coords && Array.isArray(coords) && coords.length > 0) {
                const firstCoord = coords[0];
                const lastCoord = coords[coords.length - 1];

                if (Array.isArray(firstCoord) && Array.isArray(lastCoord) &&
                    typeof firstCoord[0] === 'number' && typeof firstCoord[1] === 'number' &&
                    typeof lastCoord[0] === 'number' && typeof lastCoord[1] === 'number') {
                    const coordKey = `${firstCoord[0].toFixed(6)},${firstCoord[1].toFixed(6)}-${lastCoord[0].toFixed(6)},${lastCoord[1].toFixed(6)}`;
                    return `regional_${props.Name || 'unnamed'}_${props.Strategy}_${coordKey}`;
                }
            }
        } catch (error) {
            // Silently fall through to fallback
        }

        // Fallback: use Shape_Leng for uniqueness (stable across renders)
        return `regional_${props.Name || 'unnamed'}_${props.Strategy}_${props.Shape_Leng}`;
    }
}

// ============================================
// Rendering
// ============================================

function filterByHierarchy(geojsonData, visibleHierarchy) {
    if (!geojsonData) return null;

    return {
        ...geojsonData,
        features: geojsonData.features.filter(f => {
            const hierarchy = f.properties.Hierarchy;
            return visibleHierarchy[hierarchy] !== false;
        })
    };
}

function filterByLineStyle(geojsonData, visibleLineStyles, networkType) {
    if (!geojsonData) return null;

    return {
        ...geojsonData,
        features: geojsonData.features.filter(f => {
            const props = f.properties;

            if (networkType === 'metro') {
                // Metro: Check LTCN_Name
                const isFinal = props.LTCN_Name === 'Final LTCN';
                const isDraft = props.LTCN_Name === 'Draft LTCN';

                if (isFinal && !visibleLineStyles['Final/Existing']) return false;
                if (isDraft && !visibleLineStyles['Draft/Proposed']) return false;
            } else {
                // Regional: Check Infra_Clas
                const isExisting = props.Infra_Clas === 'Existing (adequate)' ||
                                   props.Infra_Clas === 'Existing (needs improvement)';
                const isProposed = props.Infra_Clas === 'Proposed';

                if (isExisting && !visibleLineStyles['Final/Existing']) return false;
                if (isProposed && !visibleLineStyles['Draft/Proposed']) return false;
            }

            return true;
        })
    };
}

// Filter cycling data by geographic area
function filterByGeographic(geojsonData, visibleGeographic, networkType) {
    if (!geojsonData) return null;

    return {
        ...geojsonData,
        features: geojsonData.features.filter(f => {
            const props = f.properties;

            if (networkType === 'metro') {
                // Filter by council (LGA_Name)
                const council = props.LGA_Name;
                return visibleGeographic.councils.has(council);
            } else {
                // Filter by region (Strategy)
                const region = props.Strategy;
                return visibleGeographic.regions.has(region);
            }
        })
    };
}

function renderCyclingLayers(metroData, regionalData) {
    if (!metroData || !regionalData) return;

    const layers = [];

    // Metro Layer (added first)
    if (state.visibleNetworks.metro) {
        let filtered = filterByHierarchy(metroData, state.visibleHierarchy);
        filtered = filterByLineStyle(filtered, state.visibleLineStyles, 'metro');
        filtered = filterByGeographic(filtered, state.visibleGeographic, 'metro');

        if (filtered && filtered.features.length > 0) {
            layers.push(new deck.GeoJsonLayer({
                id: 'cycling-metro',
                data: filtered,
                filled: false,
                stroked: true,
                getLineColor: d => {
                    const hierarchy = d.properties.Hierarchy;
                    const color = CONFIG.HIERARCHY_COLORS[hierarchy] || [128, 128, 128];

                    // Reduce opacity for non-selected routes
                    if (state.selectedRoute.id) {
                        const routeId = getRouteId(d, 'metro');
                        if (routeId !== state.selectedRoute.id) {
                            return [...color, 80]; // 31% opacity (dimmed)
                        }
                    }

                    return [...color, 200]; // 78% opacity (normal)
                },
                getLineWidth: d => {
                    const hierarchy = d.properties.Hierarchy;
                    return CONFIG.HIERARCHY_WIDTHS[hierarchy] || 2;
                },
                getDashArray: d => {
                    // Dashed for Draft, solid for Final
                    return d.properties.LTCN_Name === 'Draft LTCN' ? [6, 4] : [0, 0];
                },
                dashJustified: true,
                lineWidthMinPixels: 1,
                lineWidthMaxPixels: 8,
                lineWidthUnits: 'pixels',
                pickable: true,
                autoHighlight: true,
                highlightColor: [255, 255, 255, 128],
                onClick: e => {
                    if (e.object) {
                        state.routeClickHandled = true;
                        showRouteInfo(e, 'metro');
                    }
                },
                extensions: [new deck.PathStyleExtension({dash: true})]
            }));
        }
    }

    // Regional Layer (added second - gets picking priority)
    if (state.visibleNetworks.regional) {
        let filtered = filterByHierarchy(regionalData, state.visibleHierarchy);
        filtered = filterByLineStyle(filtered, state.visibleLineStyles, 'regional');
        filtered = filterByGeographic(filtered, state.visibleGeographic, 'regional');

        if (filtered && filtered.features.length > 0) {
            layers.push(new deck.GeoJsonLayer({
                id: 'cycling-regional',
                data: filtered,
                filled: false,
                stroked: true,
                getLineColor: d => {
                    const hierarchy = d.properties.Hierarchy;
                    const color = CONFIG.HIERARCHY_COLORS[hierarchy] || [128, 128, 128];

                    // Reduce opacity for non-selected routes
                    if (state.selectedRoute.id) {
                        const routeId = getRouteId(d, 'regional');
                        if (routeId !== state.selectedRoute.id) {
                            return [...color, 80]; // 31% opacity (dimmed)
                        }
                    }

                    return [...color, 200]; // 78% opacity (normal)
                },
                getLineWidth: d => {
                    const hierarchy = d.properties.Hierarchy;
                    return CONFIG.HIERARCHY_WIDTHS[hierarchy] || 2;
                },
                getDashArray: d => {
                    // Dashed for Proposed, solid for Existing (adequate or needs improvement)
                    const isProposed = d.properties.Infra_Clas === 'Proposed';
                    return isProposed ? [6, 4] : [0, 0];
                },
                dashJustified: true,
                lineWidthMinPixels: 1,
                lineWidthMaxPixels: 8,
                lineWidthUnits: 'pixels',
                pickable: true,
                autoHighlight: true,
                highlightColor: [255, 255, 255, 128],
                onClick: e => {
                    if (e.object) {
                        state.routeClickHandled = true;
                        showRouteInfo(e, 'regional');
                    }
                },
                extensions: [new deck.PathStyleExtension({dash: true})]
            }));
        }
    }

    // Update map overlay
    if (state.deckOverlay) map.removeControl(state.deckOverlay);
    state.deckOverlay = new deck.MapboxOverlay({ layers });
    map.addControl(state.deckOverlay);
}

// ============================================
// Popup Display
// ============================================

function showRouteInfo(e, networkType) {
    if (!e.object) {
        clearRouteInfo();
        return;
    }

    const props = e.object.properties;
    state.selectedRoute = {
        id: getRouteId(e.object, networkType),
        networkType: networkType
    };

    // Calculate length from Shape_Leng (meters to km)
    const lengthKm = props.Shape_Leng ? (props.Shape_Leng / 1000).toFixed(2) : 'N/A';

    let content;

    if (networkType === 'metro') {
        const status = props.LTCN_Name === 'Draft LTCN' ? 'Draft' : 'Final';
        const endorsed = props.Endorsed === 'Yes' ? 'Yes' : 'No';

        content = `
            <div class="popup-route-info">
                <div class="popup-label">Route ID:</div>
                <div class="popup-value">${props.Route_ID}</div>

                <div class="popup-label">Type:</div>
                <div class="popup-value">${props.Hierarchy}</div>

                <div class="popup-label">Status:</div>
                <div class="popup-value">${status}</div>

                <div class="popup-label">Council:</div>
                <div class="popup-value">${props.LGA_Name}</div>

                <div class="popup-label">Endorsed:</div>
                <div class="popup-value">${endorsed}</div>

                <div class="popup-label">Length:</div>
                <div class="popup-value">${lengthKm} km</div>
            </div>
        `;
    } else {
        // Regional network
        content = `
            <div class="popup-route-info">
                <div class="popup-label">Route:</div>
                <div class="popup-value">${props.Name || 'Unnamed'}</div>

                <div class="popup-label">Type:</div>
                <div class="popup-value">${props.Hierarchy}</div>

                <div class="popup-label">Class:</div>
                <div class="popup-value">${props.Class || 'N/A'}</div>

                <div class="popup-label">Status:</div>
                <div class="popup-value">${props.Infra_Clas}</div>

                <div class="popup-label">Region:</div>
                <div class="popup-value">${props.Strategy}</div>

                <div class="popup-label">Length:</div>
                <div class="popup-value">${lengthKm} km</div>
            </div>
        `;
    }

    // Update fixed info panel
    const emptyEl = document.getElementById('route-info-empty');
    const dataEl = document.getElementById('route-info-data');

    emptyEl.classList.add('hidden');
    emptyEl.innerHTML = ''; // Clear the prompt text
    dataEl.classList.remove('hidden');
    dataEl.innerHTML = content;

    // Re-render with opacity change
    renderCyclingLayers(state.metroData, state.regionalData);
}

function clearRouteInfo() {
    state.selectedRoute = {
        id: null,
        networkType: null
    };

    const emptyEl = document.getElementById('route-info-empty');
    const dataEl = document.getElementById('route-info-data');

    emptyEl.classList.remove('hidden');
    emptyEl.innerHTML = 'Click a route to view details'; // Restore the prompt text
    dataEl.classList.add('hidden');

    renderCyclingLayers(state.metroData, state.regionalData);
}

// ============================================
// Geolocation
// ============================================

function toggleGeolocation() {
    if (state.isTracking) {
        // Stop tracking
        if (state.watchId) {
            navigator.geolocation.clearWatch(state.watchId);
            state.watchId = null;
        }
        if (state.userLocationMarker) {
            state.userLocationMarker.remove();
            state.userLocationMarker = null;
        }
        state.isTracking = false;
        document.getElementById('location-btn').classList.remove('active');
    } else {
        // Start tracking
        if (!navigator.geolocation) {
            alert('Geolocation is not supported by your browser');
            return;
        }

        state.isTracking = true;
        document.getElementById('location-btn').classList.add('active');

        state.watchId = navigator.geolocation.watchPosition(
            (position) => {
                const { longitude, latitude } = position.coords;

                // Create or update marker
                if (!state.userLocationMarker) {
                    const el = document.createElement('div');
                    el.className = 'user-location-marker';
                    el.innerHTML = '<div class="location-dot"></div>';
                    state.userLocationMarker = new maplibregl.Marker({ element: el })
                        .setLngLat([longitude, latitude])
                        .addTo(map);
                } else {
                    state.userLocationMarker.setLngLat([longitude, latitude]);
                }

                // Center map on user location (only on first position)
                if (state.watchId) {
                    map.flyTo({
                        center: [longitude, latitude],
                        zoom: 13,
                        duration: 1000
                    });
                }
            },
            (error) => {
                console.error('Geolocation error:', error);
                alert('Unable to get your location');
                toggleGeolocation(); // Stop tracking
            },
            {
                enableHighAccuracy: true,
                timeout: 5000,
                maximumAge: 0
            }
        );
    }
}
