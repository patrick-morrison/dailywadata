/**
 * Abrolhos Islands Dive Trails
 * Interactive map with measurement tool
 */

// ============================================
// Configuration
// ============================================

const CONFIG = {
    INITIAL_VIEW: {
        lng: 113.82,
        lat: -28.57,
        zoom: 10
    },
    GEOJSON_URL: 'Abrolhos_Is_Dive_Trail_Markers_DPIRD_086_WA_GDA94_Public.geojson',
    CONTOURS_URL: 'https://cdn.arenleishman.com/Contours_WGS84.geojson',
    BATHYMETRY_COG_URL: 'https://cdn.arenleishman.com/AbrolhosBathy_cog.tif',
    TRAIL_COLORS: {
        'Beacon Island Dive Trail': '#FF6B6B',
        'Turtle Bay Dive Trail': '#4ECDC4',
        'Anemone Lump Dive Trail': '#FFE66D',
        'Coral Patches Dive Trail': '#95E1D3',
        'Morley Island Dive Trail': '#F38181',
        'Rootail Coral Drive Trail': '#AA96DA',
        'Long Island Dive Trail': '#88D8B0'
    },
    CONTOUR_COLOR: '#000000'  // Single color for all contours
};

// ============================================
// State
// ============================================

const state = {
    layerVisibility: {
        bathymetry: true,
        contours: true
    },
    layerOpacity: {
        bathymetry: 0.5
    },
    measureMode: false,
    measurePoints: [],        // Array of {lngLat, type: 'custom'|'segment', segmentData?}
    totalDistance: 0,
    activePopup: null,
    originalData: null,
    segmentsData: null,
    selectedTrail: null       // Currently selected trail for highlighting
};

// ============================================
// Utilities
// ============================================

/**
 * Calculate distance between two points using Haversine formula
 * @param {Array} coord1 - [lng, lat]
 * @param {Array} coord2 - [lng, lat]
 * @returns {number} Distance in meters
 */
function haversineDistance([lon1, lat1], [lon2, lat2]) {
    const R = 6371000; // Earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Format distance for display
 * @param {number} meters
 * @returns {string}
 */
function formatDistance(meters) {
    if (meters >= 1000) {
        return `${(meters / 1000).toFixed(2)} km`;
    }
    return `${meters.toFixed(1)} m`;
}

/**
 * Transform point markers to line segments
 * @param {Object} geojson - Original point GeoJSON
 * @returns {Object} GeoJSON FeatureCollection of line segments
 */
function transformPointsToSegments(geojson) {
    // Group features by trail name
    const trailGroups = {};
    geojson.features.forEach(feature => {
        const name = feature.properties.name;
        if (!trailGroups[name]) trailGroups[name] = [];
        trailGroups[name].push(feature);
    });

    // Sort each trail by marker number
    Object.keys(trailGroups).forEach(name => {
        trailGroups[name].sort((a, b) =>
            parseInt(a.properties.marker) - parseInt(b.properties.marker)
        );
    });

    // Create individual LINE SEGMENTS
    const segmentFeatures = [];
    Object.entries(trailGroups).forEach(([trailName, points]) => {
        for (let i = 0; i < points.length - 1; i++) {
            const start = points[i].geometry.coordinates;
            const end = points[i + 1].geometry.coordinates;
            const distance = haversineDistance(start, end);

            segmentFeatures.push({
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: [start, end]
                },
                properties: {
                    trailName: trailName,
                    segmentIndex: i,
                    startMarker: points[i].properties.marker,
                    endMarker: points[i + 1].properties.marker,
                    distance: distance
                }
            });
        }
    });

    return {
        type: 'FeatureCollection',
        features: segmentFeatures
    };
}

// ============================================
// Map Initialization
// ============================================

// Register COG protocol for bathymetry raster
maplibregl.addProtocol('cog', MaplibreCOGProtocol.cogProtocol);

const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
            'esri-satellite': {
                type: 'raster',
                tiles: [
                    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
                ],
                tileSize: 256,
                maxzoom: 16,
                attribution: 'Esri, Maxar, Earthstar Geographics'
            }
        },
        layers: [
            {
                id: 'satellite-layer',
                type: 'raster',
                source: 'esri-satellite',
                minzoom: 0
            }
        ]
    },
    center: [CONFIG.INITIAL_VIEW.lng, CONFIG.INITIAL_VIEW.lat],
    zoom: CONFIG.INITIAL_VIEW.zoom,
    minZoom: 8,
    maxZoom: 20,
    maxPitch: 0,
    dragRotate: false,
    attributionControl: false
});

// Add attribution control (compact)
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

// Add navigation control
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

// ============================================
// Bathymetry Layer (CDN dependency)
// ============================================

async function addBathymetryLayer() {
    const legendControl = document.querySelector('.layer-control[data-layer="bathymetry"]');

    try {
        // Test if resource is available with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const testResponse = await fetch(CONFIG.BATHYMETRY_COG_URL, {
            method: 'HEAD',
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!testResponse.ok) {
            throw new Error('Resource not available');
        }

        // Resource is available, add the layer
        map.addSource('bathymetry-source', {
            type: 'raster',
            url: `cog://${CONFIG.BATHYMETRY_COG_URL}`,
            tileSize: 256
        });

        map.addLayer({
            id: 'bathymetry-layer',
            type: 'raster',
            source: 'bathymetry-source',
            paint: {
                'raster-opacity': state.layerOpacity.bathymetry,
                'raster-resampling': 'linear'
            },
            layout: {
                visibility: state.layerVisibility.bathymetry ? 'visible' : 'none'
            }
        }, 'dive-trails-layer'); // Insert below dive trails

        // Layer added successfully, show the legend control
        if (legendControl) {
            legendControl.style.display = 'block';
        }
    } catch (error) {
        // Failed to load, keep legend hidden and log warning
        console.warn('Bathymetry layer unavailable - CDN resource not accessible', error);
        state.layerVisibility.bathymetry = false;
    }
}

// ============================================
// Contours Layer (CDN dependency)
// ============================================

async function addContoursLayer() {
    const legendControl = document.querySelector('.layer-control[data-layer="contours"]');

    try {
        // Try to load and add the layer with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const contoursResponse = await fetch(CONFIG.CONTOURS_URL, {
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!contoursResponse.ok) {
            throw new Error('Resource not available');
        }

        const contoursData = await contoursResponse.json();

        map.addSource('contours-source', {
            type: 'geojson',
            data: contoursData
        });

        // Add contour lines
        map.addLayer({
            id: 'contours-layer',
            type: 'line',
            source: 'contours-source',
            paint: {
                'line-color': CONFIG.CONTOUR_COLOR,
                'line-width': [
                    'case',
                    ['==', ['%', ['get', 'ELEV'], 10], 0], // Every 10m
                    2,
                    1
                ],
                'line-opacity': 0.6
            },
            layout: {
                visibility: state.layerVisibility.contours ? 'visible' : 'none'
            },
            minzoom: 11  // Only show when zoomed in
        }, 'dive-trails-layer'); // Insert below dive trails

        // Add contour labels
        map.addLayer({
            id: 'contours-labels',
            type: 'symbol',
            source: 'contours-source',
            paint: {
                'text-color': CONFIG.CONTOUR_COLOR,
                'text-halo-color': '#ffffff',
                'text-halo-width': 2,
                'text-opacity': 0.9
            },
            layout: {
                'text-field': ['concat', ['get', 'ELEV'], 'm'],
                'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
                'text-size': 11,
                'symbol-placement': 'line',
                'symbol-spacing': 200,  // Distance between repeated labels along the line (in pixels)
                'text-rotation-alignment': 'map',
                'text-pitch-alignment': 'viewport',
                'text-max-angle': 30,
                'text-padding': 10,  // Reduced from 50 to allow more labels
                visibility: state.layerVisibility.contours ? 'visible' : 'none'
            },
            minzoom: 12  // Only show labels when zoomed in more
        }, 'dive-trails-layer');

        // Layers added successfully, show the legend control
        if (legendControl) {
            legendControl.style.display = 'block';
        }
    } catch (error) {
        // Failed to load, keep legend hidden and log warning
        console.warn('Contours layer unavailable - CDN resource not accessible', error);
        state.layerVisibility.contours = false;
    }
}

// ============================================
// Data Loading and Layer Setup
// ============================================

map.on('load', async () => {
    try {
        // Load GeoJSON data
        const response = await fetch(CONFIG.GEOJSON_URL);
        state.originalData = await response.json();

        // Transform points to segments
        state.segmentsData = transformPointsToSegments(state.originalData);

        // Add segments source
        map.addSource('dive-trail-segments', {
            type: 'geojson',
            data: state.segmentsData
        });

        // Add markers source (original points)
        map.addSource('dive-trail-markers', {
            type: 'geojson',
            data: state.originalData
        });

        // Add measure line source (for custom waypoints)
        map.addSource('measure-line', {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: []
            }
        });

        // Add measure points source
        map.addSource('measure-points', {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: []
            }
        });

        // Build color expression for trails
        const colorExpression = ['match', ['get', 'trailName']];
        Object.entries(CONFIG.TRAIL_COLORS).forEach(([name, color]) => {
            colorExpression.push(name, color);
        });
        colorExpression.push('#888888'); // default

        // Add trail segments layer (visible)
        map.addLayer({
            id: 'dive-trails-layer',
            type: 'line',
            source: 'dive-trail-segments',
            paint: {
                'line-color': colorExpression,
                'line-width': 4,
                'line-opacity': 0.9
            }
        });

        // Add invisible hit area layer for easier clicking (wider than visible line)
        map.addLayer({
            id: 'dive-trails-hitarea',
            type: 'line',
            source: 'dive-trail-segments',
            paint: {
                'line-color': '#000000',
                'line-width': 20,  // Much wider for easy clicking
                'line-opacity': 0  // Invisible
            }
        });

        // Add highlighted segments layer (for measure mode)
        map.addLayer({
            id: 'dive-trails-highlight',
            type: 'line',
            source: 'dive-trail-segments',
            paint: {
                'line-color': '#ffffff',
                'line-width': 8,
                'line-opacity': 0
            },
            filter: ['==', ['get', 'segmentIndex'], -1] // Initially hide all
        });

        // Build color expression for markers
        const markerColorExpression = ['match', ['get', 'name']];
        Object.entries(CONFIG.TRAIL_COLORS).forEach(([name, color]) => {
            markerColorExpression.push(name, color);
        });
        markerColorExpression.push('#888888');

        // Add markers layer
        map.addLayer({
            id: 'dive-markers-layer',
            type: 'circle',
            source: 'dive-trail-markers',
            paint: {
                'circle-radius': [
                    'interpolate', ['linear'], ['zoom'],
                    10, 4,
                    15, 8
                ],
                'circle-color': markerColorExpression,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2,
                'circle-opacity': 0.9
            }
        });

        // Add measure line layer (dashed line for custom points)
        map.addLayer({
            id: 'measure-line-layer',
            type: 'line',
            source: 'measure-line',
            paint: {
                'line-color': '#0891b2',
                'line-width': 3,
                'line-dasharray': [2, 2]
            }
        });

        // Add measure points layer
        map.addLayer({
            id: 'measure-points-layer',
            type: 'circle',
            source: 'measure-points',
            paint: {
                'circle-radius': 6,
                'circle-color': '#0891b2',
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2
            }
        });

        // Add bathymetry and contours layers (only if CDN resources are available)
        await addBathymetryLayer();
        await addContoursLayer();

        // Hide loading overlay
        document.getElementById('loading').classList.add('hidden');

        // Initialize UI handlers
        initializeLegendToggles();
        initializeLayerControls();
        initializeMeasureTool();
        initializeClickHandlers();
        initializeMobileToggle();

    } catch (error) {
        console.error('Error loading data:', error);
        document.getElementById('loading-text').textContent = 'Error loading data';
    }
});

// ============================================
// Legend Zoom Handlers
// ============================================

function initializeLegendToggles() {
    const colorItems = document.querySelectorAll('.color-item[data-trail]');

    colorItems.forEach(item => {
        item.addEventListener('click', () => {
            const trailName = item.dataset.trail;
            zoomToTrail(trailName);

            // Update selected state
            state.selectedTrail = trailName;
            colorItems.forEach(ci => ci.classList.remove('selected'));
            item.classList.add('selected');
        });
    });
}

function zoomToTrail(trailName) {
    // Get all markers for this trail
    const trailMarkers = state.originalData.features.filter(
        feature => feature.properties.name === trailName
    );

    if (trailMarkers.length === 0) return;

    // Calculate bounds
    const coords = trailMarkers.map(f => f.geometry.coordinates);
    const lngs = coords.map(c => c[0]);
    const lats = coords.map(c => c[1]);

    const bounds = [
        [Math.min(...lngs), Math.min(...lats)], // Southwest
        [Math.max(...lngs), Math.max(...lats)]  // Northeast
    ];

    // Responsive padding based on screen size
    const isMobile = window.innerWidth <= 768;
    const padding = isMobile
        ? { top: 120, bottom: 250, left: 50, right: 50 } // Mobile: account for title and bottom legend
        : { top: 100, bottom: 100, left: 400, right: 100 }; // Desktop: account for sidebar

    // Zoom to bounds with padding
    map.fitBounds(bounds, {
        padding: padding,
        maxZoom: 15,
        duration: 1000
    });
}

// ============================================
// Layer Controls (Bathymetry & Contours)
// ============================================

function initializeLayerControls() {
    const layerControls = document.querySelectorAll('.layer-control[data-layer]');

    layerControls.forEach(control => {
        const layerId = control.dataset.layer;

        // Skip non-bathymetry/contours layers
        if (layerId !== 'bathymetry' && layerId !== 'contours') return;

        const checkbox = control.querySelector('input[type="checkbox"]');
        const opacitySlider = control.querySelector('.opacity-slider');
        const opacityValue = control.querySelector('.opacity-value');

        // Toggle layer visibility
        checkbox.addEventListener('change', () => {
            state.layerVisibility[layerId] = checkbox.checked;
            const visibility = checkbox.checked ? 'visible' : 'none';

            if (layerId === 'contours') {
                // Toggle both contour lines and labels (check if they exist)
                if (map.getLayer('contours-layer')) {
                    map.setLayoutProperty('contours-layer', 'visibility', visibility);
                }
                if (map.getLayer('contours-labels')) {
                    map.setLayoutProperty('contours-labels', 'visibility', visibility);
                }
            } else {
                // Check if layer exists before updating
                if (map.getLayer(`${layerId}-layer`)) {
                    map.setLayoutProperty(`${layerId}-layer`, 'visibility', visibility);
                }
            }
        });

        // Update layer opacity (only for layers with opacity sliders)
        if (opacitySlider) {
            opacitySlider.addEventListener('input', () => {
                const opacity = parseFloat(opacitySlider.value) / 100;
                state.layerOpacity[layerId] = opacity;
                opacityValue.textContent = `${opacitySlider.value}%`;

                // Check if layer exists before updating
                if (layerId === 'bathymetry' && map.getLayer('bathymetry-layer')) {
                    map.setPaintProperty('bathymetry-layer', 'raster-opacity', opacity);
                }
            });
        }
    });
}

// ============================================
// Measure Tool
// ============================================

function initializeMeasureTool() {
    const measureBtn = document.getElementById('measure-btn');
    const clearBtn = document.getElementById('clear-btn');
    const measurePanel = document.getElementById('measure-panel');

    measureBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.measureMode = !state.measureMode;
        measureBtn.classList.toggle('active', state.measureMode);

        if (state.measureMode) {
            document.body.classList.add('measure-mode-active');
            clearBtn.style.display = 'block';
        } else {
            document.body.classList.remove('measure-mode-active');
        }

        // Remove focus to prevent button staying highlighted
        measureBtn.blur();
    });

    clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearMeasurements();
    });
}

function clearMeasurements() {
    state.measurePoints = [];
    state.totalDistance = 0;

    // Clear measure panel
    document.getElementById('measure-panel').style.display = 'none';
    document.getElementById('measure-total').textContent = '0 m';
    document.getElementById('measure-items').innerHTML = '';

    // Clear map layers
    map.getSource('measure-line').setData({
        type: 'FeatureCollection',
        features: []
    });
    map.getSource('measure-points').setData({
        type: 'FeatureCollection',
        features: []
    });

    // Clear highlight
    map.setFilter('dive-trails-highlight', ['==', ['get', 'segmentIndex'], -1]);
    map.setPaintProperty('dive-trails-highlight', 'line-opacity', 0);
}

function addMeasurePoint(lngLat, type = 'custom', segmentData = null) {
    const measurePanel = document.getElementById('measure-panel');
    const measureTotal = document.getElementById('measure-total');
    const measureItems = document.getElementById('measure-items');

    let distance = 0;
    let displayName = '';
    let color = '#0891b2';

    if (type === 'segment' && segmentData) {
        // Adding a trail segment
        distance = segmentData.properties.distance;
        displayName = `${segmentData.properties.trailName.replace(' Dive Trail', '').replace(' Drive Trail', '')} ${segmentData.properties.startMarker}→${segmentData.properties.endMarker}`;
        color = CONFIG.TRAIL_COLORS[segmentData.properties.trailName] || '#888888';

        state.measurePoints.push({
            type: 'segment',
            segmentData: segmentData,
            distance: distance
        });

    } else {
        // Adding a custom point
        if (state.measurePoints.length > 0) {
            const lastPoint = state.measurePoints[state.measurePoints.length - 1];
            let lastCoord;

            if (lastPoint.type === 'segment') {
                // Use end of last segment
                lastCoord = lastPoint.segmentData.geometry.coordinates[1];
            } else {
                lastCoord = [lastPoint.lngLat.lng, lastPoint.lngLat.lat];
            }

            distance = haversineDistance(lastCoord, [lngLat.lng, lngLat.lat]);
            displayName = `Custom point`;
        } else {
            displayName = `Start point`;
        }

        state.measurePoints.push({
            type: 'custom',
            lngLat: lngLat,
            distance: distance
        });
    }

    state.totalDistance += distance;

    // Update UI
    measurePanel.style.display = 'block';
    measureTotal.textContent = formatDistance(state.totalDistance);

    // Add item to list
    const itemEl = document.createElement('div');
    itemEl.className = 'measure-item';
    itemEl.innerHTML = `
        <span class="measure-item-name">
            <span class="measure-item-dot" style="background: ${color};"></span>
            ${displayName}
        </span>
        <span class="measure-item-distance">${formatDistance(distance)}</span>
    `;
    measureItems.appendChild(itemEl);

    // Update map visualization
    updateMeasureVisualization();
}

function updateMeasureVisualization() {
    // Build arrays for custom points and lines
    const customPoints = [];
    const lineCoords = [];

    state.measurePoints.forEach((point, index) => {
        if (point.type === 'custom') {
            customPoints.push({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [point.lngLat.lng, point.lngLat.lat]
                },
                properties: { index }
            });

            // Add to line coords if we have a previous point
            if (lineCoords.length > 0 || index > 0) {
                lineCoords.push([point.lngLat.lng, point.lngLat.lat]);
            } else {
                lineCoords.push([point.lngLat.lng, point.lngLat.lat]);
            }
        } else if (point.type === 'segment') {
            // Add segment endpoints to line coords for continuity
            if (lineCoords.length === 0) {
                lineCoords.push(point.segmentData.geometry.coordinates[0]);
            }
            lineCoords.push(point.segmentData.geometry.coordinates[1]);
        }
    });

    // Update custom points
    map.getSource('measure-points').setData({
        type: 'FeatureCollection',
        features: customPoints
    });

    // Update measure line (connects all points including through segments)
    const lineFeature = lineCoords.length >= 2 ? {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: lineCoords
            },
            properties: {}
        }]
    } : { type: 'FeatureCollection', features: [] };

    map.getSource('measure-line').setData(lineFeature);

    // Highlight selected segments
    const segmentIndices = state.measurePoints
        .filter(p => p.type === 'segment')
        .map(p => `${p.segmentData.properties.trailName}-${p.segmentData.properties.segmentIndex}`);

    if (segmentIndices.length > 0) {
        // Build a filter that matches any of the selected segments
        const segmentFilters = state.measurePoints
            .filter(p => p.type === 'segment')
            .map(p => ['all',
                ['==', ['get', 'trailName'], p.segmentData.properties.trailName],
                ['==', ['get', 'segmentIndex'], p.segmentData.properties.segmentIndex]
            ]);

        if (segmentFilters.length === 1) {
            map.setFilter('dive-trails-highlight', segmentFilters[0]);
        } else {
            map.setFilter('dive-trails-highlight', ['any', ...segmentFilters]);
        }
        map.setPaintProperty('dive-trails-highlight', 'line-opacity', 0.5);
    }
}

// ============================================
// Click Handlers
// ============================================

function initializeClickHandlers() {
    // Segment click handler (using wider hit area for easier clicking)
    map.on('click', 'dive-trails-hitarea', (e) => {
        if (e.features.length === 0) return;

        const feature = e.features[0];

        if (state.measureMode) {
            // Add segment to measurement
            addMeasurePoint(e.lngLat, 'segment', feature);
        } else {
            // Show popup with segment info
            showSegmentPopup(e.lngLat, feature);
        }
    });

    // Marker click handler
    map.on('click', 'dive-markers-layer', (e) => {
        if (e.features.length === 0) return;

        const feature = e.features[0];
        const props = feature.properties;

        if (state.measureMode) {
            // In measure mode, clicking a marker adds it as a custom point
            addMeasurePoint(e.lngLat, 'custom');
        } else {
            // Show marker popup
            const content = `
                <div class="segment-popup">
                    <div class="popup-title">${props.name}</div>
                    <div class="popup-row">
                        <span class="popup-label">Marker</span>
                        ${props.marker}
                    </div>
                    <div class="popup-row">
                        <span class="popup-label">Position</span>
                        ${props.latitude_ddm}, ${props.longitude_ddm}
                    </div>
                </div>
            `;

            if (state.activePopup) state.activePopup.remove();
            state.activePopup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
                .setLngLat(e.lngLat)
                .setHTML(content)
                .addTo(map);
        }
    });

    // General map click (for custom measure points)
    map.on('click', (e) => {
        if (!state.measureMode) return;

        // Check if we clicked on a feature (using hitarea for trails)
        const features = map.queryRenderedFeatures(e.point, {
            layers: ['dive-trails-hitarea', 'dive-markers-layer']
        });

        // If no features clicked, add custom point
        if (features.length === 0) {
            addMeasurePoint(e.lngLat, 'custom');
        }
    });

    // Cursor changes (using hitarea for wider hover detection)
    map.on('mouseenter', 'dive-trails-hitarea', () => {
        if (!state.measureMode) {
            map.getCanvas().style.cursor = 'pointer';
        }
    });

    map.on('mouseleave', 'dive-trails-hitarea', () => {
        if (!state.measureMode) {
            map.getCanvas().style.cursor = '';
        }
    });

    map.on('mouseenter', 'dive-markers-layer', () => {
        if (!state.measureMode) {
            map.getCanvas().style.cursor = 'pointer';
        }
    });

    map.on('mouseleave', 'dive-markers-layer', () => {
        if (!state.measureMode) {
            map.getCanvas().style.cursor = '';
        }
    });
}

function showSegmentPopup(lngLat, feature) {
    const props = feature.properties;
    const distance = props.distance;

    const content = `
        <div class="segment-popup">
            <div class="popup-title">${props.trailName}</div>
            <div class="popup-row">
                <span class="popup-label">Segment</span>
                Marker ${props.startMarker} → ${props.endMarker}
            </div>
            <div class="popup-distance">${formatDistance(distance)}</div>
        </div>
    `;

    if (state.activePopup) state.activePopup.remove();
    state.activePopup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
        .setLngLat(lngLat)
        .setHTML(content)
        .addTo(map);
}

// ============================================
// Mobile Toggle
// ============================================

function initializeMobileToggle() {
    const titleCard = document.querySelector('.title-card');

    titleCard.addEventListener('click', (e) => {
        if (window.innerWidth <= 768) {
            // Only toggle if clicking on the title itself, not links
            if (e.target.tagName !== 'A') {
                titleCard.classList.toggle('expanded');
            }
        }
    });
}
