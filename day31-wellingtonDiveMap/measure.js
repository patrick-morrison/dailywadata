/**
 * measure.js — Measurement tool, depth probe, elevation profile, contour drag
 *
 * All measure-related state manipulation, panel UI, click/drag handlers,
 * and A* contour pathfinding interaction. Receives map, state, and config
 * as explicit parameters.
 */

import {
    haversineDistance,
    formatDistance,
    bearing,
    coordFromKey,
    lngLatToWebMercator,
    webMercatorToLngLat,
    getActiveWaterLevel,
    findShortestPath,
    MinHeap,
    simplifyPathRDP,
    smoothPathChaikin,
    _pointToLineDistance
} from './utils.js';

// ============================================
// Measure Tool Initialization
// ============================================

/**
 * Initialize measure and clear buttons, and add measure-related map
 * sources and layers.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 *
 * @mutates state.measureMode — toggled by button click
 * @mutates state.depthProbeMode — deactivated when measure mode activates
 */
export function initializeMeasureTool(map, state) {
    const measureBtn = document.getElementById('measure-btn');
    const clearBtn = document.getElementById('clear-btn');

    measureBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.measureMode = !state.measureMode;
        measureBtn.classList.toggle('active', state.measureMode);

        if (state.measureMode) {
            if (state.depthProbeMode) {
                state.depthProbeMode = false;
                document.getElementById('depth-probe-btn').classList.remove('active');
                document.body.classList.remove('depth-probe-active');
                if (state.depthProbeTooltip) state.depthProbeTooltip.style.display = 'none';
                hideDepthProbePopup(map, state);
            }
            document.body.classList.add('measure-mode-active');
            clearBtn.style.display = 'block';
            if (map.getLayer('survey-vertices-layer')) {
                map.setLayoutProperty('survey-vertices-layer', 'visibility', 'visible');
            }
        } else {
            document.body.classList.remove('measure-mode-active');
            clearMeasurements(map, state);
            if (map.getLayer('survey-vertices-layer')) {
                map.setLayoutProperty('survey-vertices-layer', 'visibility', 'none');
            }
        }

        measureBtn.blur();
    });

    clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearMeasurements(map, state);
    });

    // Add measure sources
    map.addSource('measure-line', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });

    map.addSource('measure-points', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });

    map.addLayer({
        id: 'measure-line-layer',
        type: 'line',
        source: 'measure-line',
        paint: {
            'line-color': '#FF00FF',
            'line-width': 3,
            'line-dasharray': [2, 2]
        }
    });

    // Invisible wider hit-target for line drag detection
    map.addLayer({
        id: 'measure-line-hit',
        type: 'line',
        source: 'measure-line',
        paint: {
            'line-color': 'transparent',
            'line-width': 16
        }
    });

    // Contour preview layer (shown during contour drag)
    map.addSource('measure-contour-preview', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });

    map.addLayer({
        id: 'measure-contour-preview-layer',
        type: 'line',
        source: 'measure-contour-preview',
        paint: {
            'line-color': '#FF44FF',
            'line-width': 3,
            'line-opacity': 0.8
        }
    });

    map.addLayer({
        id: 'measure-points-layer',
        type: 'circle',
        source: 'measure-points',
        paint: {
            'circle-radius': ['case', ['get', 'isContourAnchor'], 4, 6],
            'circle-color': ['case', ['get', 'isContourAnchor'], '#FF44FF', '#FF00FF'],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2
        }
    });

    // Profile hover position marker source
    map.addSource('profile-hover-marker', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });

    // Create direction arrow icon programmatically
    const arrowSize = 32;
    const arrowCanvas = document.createElement('canvas');
    arrowCanvas.width = arrowSize;
    arrowCanvas.height = arrowSize;
    const ctx = arrowCanvas.getContext('2d');
    ctx.fillStyle = '#FF00FF';
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.beginPath();
    // Arrow pointing up (bearing 0)
    ctx.moveTo(arrowSize / 2, 4);
    ctx.lineTo(arrowSize - 6, arrowSize - 6);
    ctx.lineTo(arrowSize / 2, arrowSize - 10);
    ctx.lineTo(6, arrowSize - 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Get image data from canvas for MapLibre
    const imageData = ctx.getImageData(0, 0, arrowSize, arrowSize);
    map.addImage('direction-arrow', {
        width: arrowSize,
        height: arrowSize,
        data: imageData.data
    });

    // Arrow marker using symbol layer with rotation
    map.addLayer({
        id: 'profile-hover-marker-layer',
        type: 'symbol',
        source: 'profile-hover-marker',
        layout: {
            'icon-image': 'direction-arrow',
            'icon-size': 0.75,
            'icon-rotate': ['get', 'bearing'],
            'icon-rotation-alignment': 'map',
            'icon-allow-overlap': true
        }
    });
}

// ============================================
// Clear Measurements
// ============================================

/**
 * Reset all measure state and clear map visualizations.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 *
 * @mutates state.measurePoints — reset to empty
 * @mutates state.measureSegments — reset to empty
 * @mutates state.measureTotalDistance — reset to 0
 * @mutates state.lastMeasureVertexKey — reset to null
 * @mutates state.draggingPointIndex — reset to null
 * @mutates state._suppressClick — reset to false
 * @mutates state.draggingContourSegment — reset to null
 * @mutates state.contourDragGrid — reset to null
 * @mutates state.contourPreviewCoords — reset to null
 */
export function clearMeasurements(map, state) {
    state.measurePoints = [];
    state.measureSegments = [];
    state.measureTotalDistance = 0;
    state.lastMeasureVertexKey = null;
    state.draggingPointIndex = null;
    state._suppressClick = false;
    state.draggingContourSegment = null;
    state.contourDragGrid = null;
    state.contourPreviewCoords = null;

    document.getElementById('clear-btn').style.display = 'none';
    document.getElementById('measure-panel').style.display = 'none';
    document.getElementById('measure-total').textContent = '0 m';
    document.getElementById('measure-items').innerHTML = '';

    map.getSource('measure-line').setData({ type: 'FeatureCollection', features: [] });
    map.getSource('measure-points').setData({ type: 'FeatureCollection', features: [] });
    map.getSource('survey-vertex-highlight').setData({ type: 'FeatureCollection', features: [] });
    map.getSource('measure-contour-preview').setData({ type: 'FeatureCollection', features: [] });

    // Clear profile hover marker
    const hoverSource = map.getSource('profile-hover-marker');
    if (hoverSource) {
        hoverSource.setData({ type: 'FeatureCollection', features: [] });
    }

    const profileEl = document.getElementById('measure-profile');
    if (profileEl) {
        // Clean up hover handlers
        if (profileEl._profileHoverCleanup) {
            profileEl._profileHoverCleanup();
            profileEl._profileHoverCleanup = null;
        }
        profileEl.classList.remove('visible');
        profileEl.innerHTML = '';
    }

    if (state.onNavPlanChange) state.onNavPlanChange();
}

// ============================================
// Delete Measure Point
// ============================================

/**
 * Delete a measure point by index. Removes the point and its adjacent
 * segments, re-joining neighbours with a straight line if in the middle.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 * @param {Object} config - Application config
 * @param {number} index - Index of the point to delete
 */
export function deleteMeasurePoint(map, state, config, index) {
    const points = state.measurePoints;
    const segs = state.measureSegments;

    if (index < 0 || index >= points.length) return;

    if (points.length <= 1) {
        clearMeasurements(map, state);
        return;
    }

    if (index === 0) {
        points.splice(0, 1);
        if (segs.length > 0) segs.splice(0, 1);
    } else if (index === points.length - 1) {
        points.splice(index, 1);
        if (segs.length > 0) segs.splice(index - 1, 1);
    } else {
        // Middle point: remove point and both adjacent segments,
        // replace with a single straight-line segment
        const prev = points[index - 1];
        const next = points[index + 1];
        const newCoords = [[prev.lng, prev.lat], [next.lng, next.lat]];
        const newDist = haversineDistance(newCoords[0], newCoords[1]);

        points.splice(index, 1);
        segs.splice(index - 1, 2, { coords: newCoords, distance: newDist });
    }

    state.measureTotalDistance = segs.reduce((sum, s) => sum + s.distance, 0);
    state.lastMeasureVertexKey = null;

    updateMeasureVisualization(map, state);
    rebuildMeasurePanel(state, config);
    updateElevationProfile(state, state._map);
    updateVertexHighlights(map, state);
}

// ============================================
// Add Measure Points
// ============================================

/**
 * Add a vertex-type point to the measure route (clicked on a survey vertex).
 * If the previous point was also a vertex, routes along the survey graph.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 * @param {string} clickedKey - Canonical vertex key
 *
 * @reads state.measurePoints — to check previous point
 * @reads state.lastMeasureVertexKey — previous vertex for graph routing
 * @reads state.graph — survey graph adjacency list
 * @mutates state.measurePoints — pushes new vertex point
 * @mutates state.measureSegments — pushes new segment
 * @mutates state.lastMeasureVertexKey — updated to clickedKey
 * @mutates state.measureTotalDistance — incremented by segment distance
 */
export function addMeasureVertex(map, state, clickedKey) {
    const [lng, lat] = coordFromKey(clickedKey);
    const point = { lng, lat, isVertex: true, vertexKey: clickedKey };

    let segmentDistance = 0;
    let segmentCoords = null;
    let segmentBearing = null;

    if (state.measurePoints.length > 0) {
        const prev = state.measurePoints[state.measurePoints.length - 1];

        if (prev.isVertex && prev.vertexKey && state.lastMeasureVertexKey) {
            const result = findShortestPath(state.graph, state.lastMeasureVertexKey, clickedKey);
            if (result) {
                segmentCoords = result.path.map(k => coordFromKey(k));
                segmentDistance = result.distance;
                segmentBearing = 'line';
            } else {
                segmentCoords = [[prev.lng, prev.lat], [lng, lat]];
                segmentDistance = haversineDistance([prev.lng, prev.lat], [lng, lat]);
                segmentBearing = bearing([prev.lng, prev.lat], [lng, lat]);
            }
        } else {
            segmentCoords = [[prev.lng, prev.lat], [lng, lat]];
            segmentDistance = haversineDistance([prev.lng, prev.lat], [lng, lat]);
            segmentBearing = bearing([prev.lng, prev.lat], [lng, lat]);
        }

        state.measureSegments.push({ coords: segmentCoords, distance: segmentDistance });
    }

    state.measurePoints.push(point);
    state.lastMeasureVertexKey = clickedKey;
    state.measureTotalDistance += segmentDistance;

    updateMeasurePanel(state, segmentDistance, segmentBearing);
    updateMeasureVisualization(map, state);
    updateVertexHighlights(map, state);
}

/**
 * Add a free-form (non-vertex) measurement point at the given location,
 * with a straight-line segment from the previous point.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 * @param {{ lng: number, lat: number }} lngLat - Click location
 *
 * @reads state.measurePoints — to check if a previous point exists
 * @mutates state.measurePoints — pushes new point { lng, lat, isVertex: false }
 * @mutates state.measureSegments — pushes new segment { coords, distance }
 * @mutates state.lastMeasureVertexKey — set to null (breaks vertex chain)
 * @mutates state.measureTotalDistance — incremented by segment distance
 */
export function addMeasureFreePoint(map, state, lngLat) {
    const point = { lng: lngLat.lng, lat: lngLat.lat, isVertex: false, vertexKey: null };

    let segmentDistance = 0;
    let segmentBearing = null;

    if (state.measurePoints.length > 0) {
        const prev = state.measurePoints[state.measurePoints.length - 1];
        const segmentCoords = [[prev.lng, prev.lat], [lngLat.lng, lngLat.lat]];
        segmentDistance = haversineDistance([prev.lng, prev.lat], [lngLat.lng, lngLat.lat]);
        segmentBearing = bearing([prev.lng, prev.lat], [lngLat.lng, lngLat.lat]);
        state.measureSegments.push({ coords: segmentCoords, distance: segmentDistance });
    }

    state.measurePoints.push(point);
    state.lastMeasureVertexKey = null;
    state.measureTotalDistance += segmentDistance;

    updateMeasurePanel(state, segmentDistance, segmentBearing);
    updateMeasureVisualization(map, state);
}

// ============================================
// Measure Panel
// ============================================

/**
 * Append a new entry to the measure panel for the latest point.
 *
 * @param {Object} state - Application state
 * @param {number} segmentDistance - Distance of the latest segment in meters
 * @param {number|string|null} segmentBearing - Bearing or 'line' or null
 *
 * @reads state.measurePoints — to determine point index
 * @reads state.measureTotalDistance — for total display
 */
export function updateMeasurePanel(state, segmentDistance, segmentBearing) {
    const measurePanel = document.getElementById('measure-panel');
    const measureTotal = document.getElementById('measure-total');
    const measureItems = document.getElementById('measure-items');

    const idx = state.measurePoints.length;
    const displayName = idx === 1 ? 'Start point' : `Point ${idx}`;

    measurePanel.style.display = 'block';
    document.getElementById('clear-btn').style.display = 'block';
    measureTotal.textContent = formatDistance(state.measureTotalDistance);

    const bearingHtml = segmentBearing === 'line'
        ? `<span class="measure-item-bearing">line</span>`
        : segmentBearing !== null
            ? `<span class="measure-item-bearing">${Math.round(segmentBearing)}\u00B0</span>`
            : '';

    const itemEl = document.createElement('div');
    itemEl.className = 'measure-item';
    itemEl.innerHTML = `
        <span class="measure-item-name">
            <span class="measure-item-dot" style="background: #FF00FF;"></span>
            ${displayName}
        </span>
        <span class="measure-item-info">
            ${bearingHtml}
            <span class="measure-item-distance">${formatDistance(segmentDistance)}</span>
        </span>
    `;
    measureItems.appendChild(itemEl);
    updateElevationProfile(state, state._map);
}

/**
 * Full rebuild of the measure panel from current measurePoints and measureSegments.
 * Needed when dragging changes distances/bearings of existing entries.
 *
 * @param {Object} state - Application state
 * @param {Object} config - Application config
 *
 * @reads state.measurePoints — all current measure points
 * @reads state.measureSegments — all current segments
 * @reads state.measureTotalDistance — total distance
 */
export function rebuildMeasurePanel(state, config) {
    const measurePanel = document.getElementById('measure-panel');
    const measureTotal = document.getElementById('measure-total');
    const measureItems = document.getElementById('measure-items');

    measureItems.innerHTML = '';

    if (state.measurePoints.length === 0) {
        measurePanel.style.display = 'none';
        return;
    }

    measurePanel.style.display = 'block';
    document.getElementById('clear-btn').style.display = 'block';
    measureTotal.textContent = formatDistance(state.measureTotalDistance);

    for (let i = 0; i < state.measurePoints.length; i++) {
        const displayName = i === 0 ? 'Start point' : `Point ${i + 1}`;
        let bearingHtml = '';

        if (i > 0) {
            const prev = state.measurePoints[i - 1];
            const curr = state.measurePoints[i];
            const seg = state.measureSegments[i - 1];

            if (seg.contourAHD !== undefined) {
                const contourDepth = getActiveWaterLevel(state, config) - seg.contourAHD;
                bearingHtml = `<span class="measure-item-bearing">${contourDepth.toFixed(1)}m contour</span>`;
            } else if (prev.isVertex && curr.isVertex && seg.coords.length > 2) {
                bearingHtml = `<span class="measure-item-bearing">line</span>`;
            } else {
                const b = bearing([prev.lng, prev.lat], [curr.lng, curr.lat]);
                bearingHtml = `<span class="measure-item-bearing">${Math.round(b)}\u00B0</span>`;
            }
        }

        const segDist = i > 0 ? state.measureSegments[i - 1].distance : 0;
        const itemEl = document.createElement('div');
        itemEl.className = 'measure-item';
        itemEl.innerHTML = `
            <span class="measure-item-name">
                <span class="measure-item-dot" style="background: #FF00FF;"></span>
                ${displayName}
            </span>
            <span class="measure-item-info">
                ${bearingHtml}
                <span class="measure-item-distance">${formatDistance(segDist)}</span>
            </span>
        `;
        measureItems.appendChild(itemEl);
    }
    updateElevationProfile(state, state._map);
}

// ============================================
// Vertex Highlights
// ============================================

/**
 * Update highlighted vertices (all selected vertex-type points).
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 *
 * @reads state.measurePoints — filters for vertex-type points
 */
export function updateVertexHighlights(map, state) {
    const features = state.measurePoints
        .filter(p => p.isVertex)
        .map(p => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
            properties: {}
        }));

    map.getSource('survey-vertex-highlight').setData({
        type: 'FeatureCollection',
        features
    });
}

// ============================================
// Measure Visualization
// ============================================

/**
 * Update line and point GeoJSON on the map for the current measure state.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 *
 * @reads state.measurePoints — point locations
 * @reads state.measureSegments — segment coordinates
 */
export function updateMeasureVisualization(map, state) {
    const pointFeatures = state.measurePoints.map((point, index) => ({
        type: 'Feature',
        geometry: {
            type: 'Point',
            coordinates: [point.lng, point.lat]
        },
        properties: { index, isVertex: point.isVertex, isContourAnchor: !!point.isContourAnchor }
    }));

    map.getSource('measure-points').setData({
        type: 'FeatureCollection',
        features: pointFeatures
    });

    if (state.measureSegments.length > 0) {
        let allCoords = [];
        for (const seg of state.measureSegments) {
            if (allCoords.length === 0) {
                allCoords = [...seg.coords];
            } else {
                allCoords.push(...seg.coords.slice(1));
            }
        }

        map.getSource('measure-line').setData({
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: allCoords
                },
                properties: {}
            }]
        });
    } else {
        map.getSource('measure-line').setData({ type: 'FeatureCollection', features: [] });
    }

    // Notify URL hash updater
    if (state.onNavPlanChange) state.onNavPlanChange();
}

// ============================================
// Elevation Profile
// ============================================

/**
 * Build and display an SVG elevation profile in the measure panel.
 * Shows depth below water surface along the measured route.
 *
 * @param {Object} state - Application state
 * @param {maplibregl.Map} [map] - Optional map instance for hover feature
 *
 * @reads state.measureSegments — segment coordinate data
 * @reads state.bathymetryLayer — for elevation queries
 */
export function updateElevationProfile(state, map) {
    const container = document.getElementById('measure-profile');
    if (!container) return;

    // Clean up previous hover handlers
    if (container._profileHoverCleanup) {
        container._profileHoverCleanup();
        container._profileHoverCleanup = null;
    }

    if (state.measureSegments.length === 0 || !state.bathymetryLayer) {
        container.classList.remove('visible');
        container.innerHTML = '';
        return;
    }

    const waterLevel = getActiveWaterLevel(state, state._config);

    const samples = [];
    let cumulativeDist = 0;

    for (const seg of state.measureSegments) {
        const coords = seg.coords;
        for (let i = 0; i < coords.length; i++) {
            if (i < coords.length - 1) {
                const [lng1, lat1] = coords[i];
                const [lng2, lat2] = coords[i + 1];
                const segDist = haversineDistance([lng1, lat1], [lng2, lat2]);
                const numSamples = Math.max(1, Math.ceil(segDist / 2));

                for (let s = 0; s < numSamples; s++) {
                    const t = s / numSamples;
                    const lng = lng1 + (lng2 - lng1) * t;
                    const lat = lat1 + (lat2 - lat1) * t;
                    const elev = state.bathymetryLayer.getElevationAtLngLat(lng, lat);
                    const depth = elev !== null ? Math.max(0, waterLevel - elev) : 0;

                    if (s === 0 && samples.length > 0) continue;
                    samples.push({ dist: cumulativeDist + segDist * t, depth });
                }
                cumulativeDist += segDist;
            }
        }
    }

    const lastCoord = state.measureSegments[state.measureSegments.length - 1].coords;
    const [fLng, fLat] = lastCoord[lastCoord.length - 1];
    const fElev = state.bathymetryLayer.getElevationAtLngLat(fLng, fLat);
    const fDepth = fElev !== null ? Math.max(0, waterLevel - fElev) : 0;
    samples.push({ dist: cumulativeDist, depth: fDepth });

    if (samples.length < 2) {
        container.classList.remove('visible');
        container.innerHTML = '';
        return;
    }

    const totalDist = samples[samples.length - 1].dist;
    let maxDepth = 0;
    for (const s of samples) {
        if (s.depth > maxDepth) maxDepth = s.depth;
    }
    maxDepth = Math.max(maxDepth, 1);

    const svgW = 260;
    const svgH = 80;
    const margin = { top: 4, right: 8, bottom: 16, left: 28 };
    const plotW = svgW - margin.left - margin.right;
    const plotH = svgH - margin.top - margin.bottom;

    const xScale = (d) => margin.left + (d / totalDist) * plotW;
    const yScale = (d) => margin.top + (d / maxDepth) * plotH;

    let pathD = `M ${xScale(samples[0].dist)} ${yScale(samples[0].depth)}`;
    for (let i = 1; i < samples.length; i++) {
        pathD += ` L ${xScale(samples[i].dist)} ${yScale(samples[i].depth)}`;
    }

    const fillD = pathD +
        ` L ${xScale(totalDist)} ${yScale(0)}` +
        ` L ${xScale(0)} ${yScale(0)} Z`;

    const yLabels = [];
    const yStep = maxDepth <= 5 ? 1 : maxDepth <= 15 ? 5 : 10;
    for (let d = 0; d <= maxDepth; d += yStep) {
        yLabels.push(d);
    }

    const xLabels = [];
    // Calculate step based on distance range
    let xStep = totalDist <= 50 ? 10 : totalDist <= 200 ? 50 : totalDist <= 500 ? 100 : 200;
    // Ensure minimum 40px spacing between labels to prevent overlap
    const minPixelSpacing = 40;
    const minStepForSpacing = (totalDist / plotW) * minPixelSpacing;
    // Round up to a nice number (10, 20, 50, 100, 200, 500, 1000, etc.)
    const niceSteps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    for (const ns of niceSteps) {
        if (ns >= minStepForSpacing) {
            xStep = Math.max(xStep, ns);
            break;
        }
    }
    for (let d = 0; d <= totalDist; d += xStep) {
        xLabels.push(d);
    }

    const svg = `<svg viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">
        <!-- Surface line -->
        <line class="profile-surface" x1="${margin.left}" y1="${yScale(0)}" x2="${xScale(totalDist)}" y2="${yScale(0)}"/>
        <!-- Depth fill -->
        <path class="profile-fill" d="${fillD}"/>
        <!-- Y-axis labels -->
        ${yLabels.map(d => `
            <line class="profile-axis" x1="${margin.left}" y1="${yScale(d)}" x2="${xScale(totalDist)}" y2="${yScale(d)}"/>
            <text class="profile-label" x="${margin.left - 3}" y="${yScale(d) + 3}" text-anchor="end">${d}m</text>
        `).join('')}
        <!-- X-axis labels -->
        ${xLabels.map(d => `
            <text class="profile-label" x="${xScale(d)}" y="${svgH - 2}" text-anchor="middle">${d >= 1000 ? (d / 1000).toFixed(1) + 'k' : d}m</text>
        `).join('')}
    </svg>`;

    container.innerHTML = svg;
    container.classList.add('visible');

    // Set up hover handlers if map is available
    console.log('updateElevationProfile: map =', !!map, 'state._map =', !!state._map);
    if (map) {
        setupProfileHoverHandlers(container, state, map);
    } else {
        console.warn('updateElevationProfile: no map provided, hover handlers not set up');
    }
}

// ============================================
// Profile Hover Feature
// ============================================

/**
 * Get the position, bearing, and depth at a given distance along the route.
 *
 * @param {Object} state - Application state
 * @param {number} targetDist - Distance along the route in meters
 * @returns {{ coord: [number, number], bearing: number, depth: number }|null}
 */
export function getPositionAtDistance(state, targetDist) {
    if (state.measureSegments.length === 0) return null;

    let cumulativeDist = 0;

    for (const seg of state.measureSegments) {
        const coords = seg.coords;
        for (let i = 0; i < coords.length - 1; i++) {
            const [lng1, lat1] = coords[i];
            const [lng2, lat2] = coords[i + 1];
            const segDist = haversineDistance([lng1, lat1], [lng2, lat2]);

            if (cumulativeDist + segDist >= targetDist) {
                // Target is within this sub-segment
                const t = (targetDist - cumulativeDist) / segDist;
                const lng = lng1 + (lng2 - lng1) * t;
                const lat = lat1 + (lat2 - lat1) * t;
                const segBearing = bearing([lng1, lat1], [lng2, lat2]);

                // Query depth from bathymetry layer
                let depth = 0;
                if (state.bathymetryLayer) {
                    const elev = state.bathymetryLayer.getElevationAtLngLat(lng, lat);
                    if (elev !== null) {
                        const waterLevel = getActiveWaterLevel(state, state._config);
                        depth = Math.max(0, waterLevel - elev);
                    }
                }

                return { coord: [lng, lat], bearing: segBearing, depth };
            }

            cumulativeDist += segDist;
        }
    }

    // If we got here, return the last point
    const lastSeg = state.measureSegments[state.measureSegments.length - 1];
    const lastCoord = lastSeg.coords[lastSeg.coords.length - 1];
    const [lng, lat] = lastCoord;

    let depth = 0;
    if (state.bathymetryLayer) {
        const elev = state.bathymetryLayer.getElevationAtLngLat(lng, lat);
        if (elev !== null) {
            const waterLevel = getActiveWaterLevel(state, state._config);
            depth = Math.max(0, waterLevel - elev);
        }
    }

    // Use bearing of last segment
    const lastCoords = lastSeg.coords;
    const finalBearing = lastCoords.length >= 2
        ? bearing(lastCoords[lastCoords.length - 2], lastCoords[lastCoords.length - 1])
        : 0;

    return { coord: [lng, lat], bearing: finalBearing, depth };
}

/**
 * Update the profile hover marker on the map.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {[number, number]} coord - [lng, lat] coordinates
 * @param {number} markerBearing - Bearing in degrees
 */
function updateProfileHoverMarker(map, coord, markerBearing) {
    const source = map.getSource('profile-hover-marker');
    if (!source) return;

    source.setData({
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            geometry: { type: 'Point', coordinates: coord },
            properties: { bearing: markerBearing }
        }]
    });
}

/**
 * Hide the profile hover marker on the map.
 *
 * @param {maplibregl.Map} map - The map instance
 */
function hideProfileHoverMarker(map) {
    const source = map.getSource('profile-hover-marker');
    if (!source) return;

    source.setData({ type: 'FeatureCollection', features: [] });
}

/**
 * Set up hover/touch handlers for the elevation profile SVG.
 *
 * @param {HTMLElement} container - The profile container element
 * @param {Object} state - Application state
 * @param {maplibregl.Map} map - The map instance
 */
function setupProfileHoverHandlers(container, state, map) {
    console.log('setupProfileHoverHandlers called', { container, map: !!map });

    // SVG dimensions from updateElevationProfile
    const svgW = 260;
    const margin = { left: 28, right: 8 };
    const plotW = svgW - margin.left - margin.right; // 224

    // Create hover line element (will be added to SVG)
    let hoverLine = null;

    // Create floating depth label
    let depthLabel = document.querySelector('.profile-hover-label');
    if (!depthLabel) {
        depthLabel = document.createElement('div');
        depthLabel.className = 'profile-hover-label';
        document.body.appendChild(depthLabel);
    }

    function handleHover(e) {
        console.log('handleHover called', e.type);

        const svg = container.querySelector('svg');
        if (!svg) {
            console.log('No SVG found');
            return;
        }

        // Get client coordinates
        let clientX, clientY;
        if (e.touches && e.touches.length > 0) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }

        // Convert screen position to SVG coordinates
        const rect = svg.getBoundingClientRect();
        const svgX = ((clientX - rect.left) / rect.width) * svgW;

        // Check if within plot area
        if (svgX < margin.left || svgX > svgW - margin.right) {
            hideMarker();
            return;
        }

        // Convert SVG X to distance along route
        const totalDist = state.measureTotalDistance;
        if (totalDist <= 0) {
            hideMarker();
            return;
        }

        const distFraction = (svgX - margin.left) / plotW;
        const targetDist = distFraction * totalDist;

        // Get position at distance
        const pos = getPositionAtDistance(state, targetDist);
        if (!pos) {
            hideMarker();
            return;
        }

        // Update map marker
        updateProfileHoverMarker(map, pos.coord, pos.bearing);

        // Update or create hover line on SVG
        if (!hoverLine) {
            hoverLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            hoverLine.classList.add('profile-hover-line');
        }
        if (!hoverLine.parentNode) {
            svg.appendChild(hoverLine);
        }

        const svgH = 80;
        const topMargin = 4;
        const bottomMargin = 16;
        hoverLine.setAttribute('x1', svgX);
        hoverLine.setAttribute('y1', topMargin);
        hoverLine.setAttribute('x2', svgX);
        hoverLine.setAttribute('y2', svgH - bottomMargin);

        // Update floating depth label
        depthLabel.textContent = `${pos.depth.toFixed(1)}m`;
        depthLabel.style.display = 'block';
        depthLabel.style.left = `${clientX}px`;
        depthLabel.style.top = `${clientY - 30}px`;
    }

    function hideMarker() {
        hideProfileHoverMarker(map);

        if (hoverLine && hoverLine.parentNode) {
            hoverLine.parentNode.removeChild(hoverLine);
        }

        if (depthLabel) {
            depthLabel.style.display = 'none';
        }
    }

    // Desktop events
    container.addEventListener('mousemove', handleHover);
    container.addEventListener('mouseleave', hideMarker);

    // Mobile events
    container.addEventListener('touchstart', handleHover, { passive: false });
    container.addEventListener('touchmove', handleHover, { passive: false });
    container.addEventListener('touchend', hideMarker);

    // Store cleanup function on container for later removal if needed
    container._profileHoverCleanup = () => {
        container.removeEventListener('mousemove', handleHover);
        container.removeEventListener('mouseleave', hideMarker);
        container.removeEventListener('touchstart', handleHover);
        container.removeEventListener('touchmove', handleHover);
        container.removeEventListener('touchend', hideMarker);
        hideMarker();
    };
}

// ============================================
// Depth Probe Tool
// ============================================

/**
 * Initialize the depth probe button and hover/touch handlers.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 *
 * @mutates state.depthProbeMode — toggled by button click
 * @mutates state.depthProbeTooltip — DOM element created
 * @mutates state.measureMode — deactivated when probe activates
 */
export function initializeDepthProbe(map, state) {
    const tooltip = document.createElement('div');
    tooltip.className = 'depth-probe-tooltip';
    document.body.appendChild(tooltip);
    state.depthProbeTooltip = tooltip;

    const probeBtn = document.getElementById('depth-probe-btn');
    const measureBtn = document.getElementById('measure-btn');

    probeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.depthProbeMode = !state.depthProbeMode;
        probeBtn.classList.toggle('active', state.depthProbeMode);

        if (state.depthProbeMode) {
            if (state.measureMode) {
                state.measureMode = false;
                measureBtn.classList.remove('active');
                document.body.classList.remove('measure-mode-active');
            }
            document.body.classList.add('depth-probe-active');
        } else {
            document.body.classList.remove('depth-probe-active');
            tooltip.style.display = 'none';
            hideDepthProbePopup(map, state);
        }

        probeBtn.blur();
    });

    let isTouching = false;

    map.on('mousemove', (e) => {
        if (!state.depthProbeMode || isTouching) return;
        showDepthProbeDesktop(state, e.lngLat, e.point);
    });

    map.getCanvas().addEventListener('mouseleave', () => {
        if (state.depthProbeMode) {
            tooltip.style.display = 'none';
        }
    });

    const canvas = map.getCanvas();
    const handleTouch = (e) => {
        if (!state.depthProbeMode) return;
        isTouching = true;
        tooltip.style.display = 'none';
        const touch = e.touches[0];
        if (!touch) return;
        const rect = canvas.getBoundingClientRect();
        const point = new maplibregl.Point(
            touch.clientX - rect.left,
            touch.clientY - rect.top
        );
        const lngLat = map.unproject(point);
        showDepthProbePopup(map, state, lngLat);
    };

    canvas.addEventListener('touchstart', handleTouch, { passive: true });
    canvas.addEventListener('touchmove', handleTouch, { passive: true });
    canvas.addEventListener('touchend', () => {
        setTimeout(() => { isTouching = false; }, 300);
    }, { passive: true });
}

/**
 * Compute the depth text for a given lngLat.
 *
 * @param {Object} state - Application state
 * @param {{ lng: number, lat: number }} lngLat - Location to probe
 * @returns {string} Formatted depth string
 *
 * @reads state.bathymetryLayer — for elevation query
 */
export function getDepthText(state, lngLat) {
    const elev = state.bathymetryLayer
        ? state.bathymetryLayer.getElevationAtLngLat(lngLat.lng, lngLat.lat)
        : null;

    if (elev === null) return 'No data';
    const waterLevel = getActiveWaterLevel(state, state._config);
    if (elev > waterLevel) return 'Above water';
    return `${(waterLevel - elev).toFixed(1)}m`;
}

/**
 * Desktop: lightweight fixed-position tooltip near cursor.
 */
function showDepthProbeDesktop(state, lngLat, screenPoint) {
    const tooltip = state.depthProbeTooltip;
    if (!tooltip) return;

    tooltip.textContent = getDepthText(state, lngLat);
    tooltip.style.display = 'block';
    tooltip.style.left = `${screenPoint.x}px`;
    tooltip.style.top = `${screenPoint.y}px`;
}

/**
 * Mobile: MapLibre Popup anchored to the touch lngLat.
 */
function showDepthProbePopup(map, state, lngLat) {
    const text = getDepthText(state, lngLat);

    if (!state.depthProbePopup) {
        state.depthProbePopup = new maplibregl.Popup({
            closeButton: false,
            closeOnClick: false,
            className: 'depth-probe-popup',
            anchor: 'bottom'
        });
        state.depthProbePopup.addTo(map);
    }

    state.depthProbePopup
        .setLngLat(lngLat)
        .setHTML(`<span class="depth-probe-popup-text">${text}</span>`);
}

/**
 * Remove the depth probe popup.
 */
function hideDepthProbePopup(map, state) {
    if (state.depthProbePopup) {
        state.depthProbePopup.remove();
        state.depthProbePopup = null;
    }
}

// ============================================
// A* Contour Pathfinding
// ============================================

/**
 * Find the nearest grid cell to (cx, cy) whose elevation is within
 * tolerance of targetElevation. Searches in expanding Chebyshev rings.
 *
 * @returns {number[]|null} [x, y] grid coordinates, or null if not found
 */
function findNearestOnContour(grid, width, height, cx, cy, targetElevation, tolerance, maxRadius) {
    cx = Math.max(0, Math.min(width - 1, cx));
    cy = Math.max(0, Math.min(height - 1, cy));

    const check = (x, y) => {
        if (x < 0 || x >= width || y < 0 || y >= height) return false;
        const e = grid[y * width + x];
        return Number.isFinite(e) && Math.abs(e - targetElevation) <= tolerance;
    };

    if (check(cx, cy)) return [cx, cy];

    for (let r = 1; r <= maxRadius; r++) {
        // Top and bottom rows of ring
        for (let dx = -r; dx <= r; dx++) {
            if (check(cx + dx, cy - r)) return [cx + dx, cy - r];
            if (check(cx + dx, cy + r)) return [cx + dx, cy + r];
        }
        // Left and right columns (excluding corners already checked)
        for (let dy = -r + 1; dy < r; dy++) {
            if (check(cx - r, cy + dy)) return [cx - r, cy + dy];
            if (check(cx + r, cy + dy)) return [cx + r, cy + dy];
        }
    }

    return null;
}

/**
 * A* contour pathfinding on a Float32 elevation grid.
 *
 * Snaps start/end to the nearest on-contour cells, then finds a path
 * between them that stays within tolerance of the target elevation.
 * The returned path starts and ends at the snapped on-contour positions
 * (not the input lngLat), so the caller should draw approach/depart
 * segments from the fixed measure points to the path endpoints.
 *
 * @param {Float32Array} grid - Elevation values (AHD), row-major
 * @param {number} width - Grid width in pixels
 * @param {number} height - Grid height in pixels
 * @param {number[]} bbox - [minX, minY, maxX, maxY] in EPSG:3857
 * @param {number} startLng - Start longitude (WGS84)
 * @param {number} startLat - Start latitude (WGS84)
 * @param {number} endLng - End longitude (WGS84)
 * @param {number} endLat - End latitude (WGS84)
 * @param {number} targetElevation - Target AHD elevation to follow
 * @param {number} [tolerance=0.5] - Max elevation deviation in meters
 * @returns {Array|null} Array of [lng, lat] coordinates, or null if no path
 */
export function findContourPath(grid, width, height, bbox, startLng, startLat, endLng, endLat, targetElevation, tolerance = 0.5) {
    const totalPixels = width * height;

    const toGrid = (lng, lat) => {
        const [mx, my] = lngLatToWebMercator(lng, lat);
        const x = Math.floor((mx - bbox[0]) / (bbox[2] - bbox[0]) * width);
        const y = Math.floor((bbox[3] - my) / (bbox[3] - bbox[1]) * height);
        return [x, y];
    };

    const fromGrid = (x, y) => {
        const mx = bbox[0] + (x / width) * (bbox[2] - bbox[0]);
        const my = bbox[3] - (y / height) * (bbox[3] - bbox[1]);
        return webMercatorToLngLat(mx, my);
    };

    const [rawStartX, rawStartY] = toGrid(startLng, startLat);
    const [rawEndX, rawEndY] = toGrid(endLng, endLat);

    // Snap to nearest on-contour cells — approach/depart segments bridge
    // any gap between the fixed measure points and the contour
    const maxSnap = Math.max(width, height);
    const start = findNearestOnContour(grid, width, height, rawStartX, rawStartY, targetElevation, tolerance, maxSnap);
    const end = findNearestOnContour(grid, width, height, rawEndX, rawEndY, targetElevation, tolerance, maxSnap);

    if (!start || !end) return null;

    const [startX, startY] = start;
    const [endX, endY] = end;

    if (startX === endX && startY === endY) {
        const pt = fromGrid(startX, startY);
        return [pt, [...pt]];
    }

    const straightDist = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2);
    const maxIterations = Math.min(80000, Math.max(10000, Math.ceil(straightDist * 150)));

    const visited = new Uint8Array(totalPixels);
    const gScores = new Float32Array(totalPixels);
    gScores.fill(Infinity);

    const startIdx = startY * width + startX;
    gScores[startIdx] = 0;

    const minHeap = new MinHeap();
    const startH = Math.sqrt((startX - endX) ** 2 + (startY - endY) ** 2);
    minHeap.push({ x: startX, y: startY, idx: startIdx, g: 0, h: startH, f: startH, parent: null });

    let iterations = 0;

    const neighborOffsets = [
        { dx: -1, dy: -1, cost: 1.414 }, { dx: 0, dy: -1, cost: 1 }, { dx: 1, dy: -1, cost: 1.414 },
        { dx: -1, dy: 0, cost: 1 },                                    { dx: 1, dy: 0, cost: 1 },
        { dx: -1, dy: 1, cost: 1.414 },  { dx: 0, dy: 1, cost: 1 },  { dx: 1, dy: 1, cost: 1.414 }
    ];

    while (!minHeap.isEmpty() && iterations++ < maxIterations) {
        const current = minHeap.pop();

        if (visited[current.idx] === 1) continue;
        visited[current.idx] = 1;

        if (Math.abs(current.x - endX) <= 2 && Math.abs(current.y - endY) <= 2) {
            const path = [];
            let node = current;
            while (node) {
                path.unshift(fromGrid(node.x, node.y));
                node = node.parent;
            }
            return smoothPathChaikin(simplifyPathRDP(path));
        }

        for (let i = 0; i < 8; i++) {
            const { dx, dy, cost } = neighborOffsets[i];
            const nx = current.x + dx;
            const ny = current.y + dy;

            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

            const nIdx = ny * width + nx;
            if (visited[nIdx] === 1) continue;

            const elevation = grid[nIdx];
            if (!Number.isFinite(elevation)) continue;

            const diff = Math.abs(elevation - targetElevation);
            if (diff > tolerance) continue;

            const normalizedDiff = diff / tolerance;
            const depthPenalty = normalizedDiff * normalizedDiff * 8.0;

            const goalDx = endX - current.x;
            const goalDy = endY - current.y;
            const goalDist = Math.sqrt(goalDx * goalDx + goalDy * goalDy);
            let directnessPenalty = 0;
            if (goalDist > 0) {
                const dot = (dx * goalDx + dy * goalDy) / (Math.sqrt(dx * dx + dy * dy) * goalDist);
                directnessPenalty = (1 - dot) * 0.25;
            }

            const g = current.g + cost + depthPenalty + directnessPenalty;

            if (g < gScores[nIdx]) {
                gScores[nIdx] = g;
                const h = Math.sqrt((nx - endX) ** 2 + (ny - endY) ** 2);
                minHeap.push({ x: nx, y: ny, idx: nIdx, g, h, f: g + h, parent: current });
            }
        }
    }

    return null;
}

// ============================================
// Contour Grid Loading (for A* drag)
// ============================================

/**
 * Async load contour source at native resolution for the bounding box
 * covering two endpoints + padding. Stores result in state.contourDragGrid.
 *
 * @param {Object} state - Application state
 * @param {{ lng: number, lat: number }} ptA - First endpoint
 * @param {{ lng: number, lat: number }} ptB - Second endpoint
 *
 * @reads state.contourTiff — GeoTIFF object reference
 * @reads state.contourBbox — full extent bbox
 * @reads state.contourNoData — NoData value
 * @mutates state.contourDragGrid — stores loaded grid data
 * @mutates state.contourDragGridLoading — loading flag
 */
export async function loadContourGridForDrag(state, ptA, ptB) {
    if (!state.contourTiff || !state.contourBbox) return;

    state.contourDragGridLoading = true;

    try {
        const [axM, ayM] = lngLatToWebMercator(ptA.lng, ptA.lat);
        const [bxM, byM] = lngLatToWebMercator(ptB.lng, ptB.lat);

        const minX = Math.min(axM, bxM);
        const maxX = Math.max(axM, bxM);
        const minY = Math.min(ayM, byM);
        const maxY = Math.max(ayM, byM);

        // Generous padding so the A* can find contours that curve away from
        // the direct line between endpoints
        const span = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2);
        const pad = Math.max(300, span * 1.0);
        const [srcMinX, srcMinY, srcMaxX, srcMaxY] = state.contourBbox;
        const bbox = [
            Math.max(minX - pad, srcMinX),
            Math.max(minY - pad, srcMinY),
            Math.min(maxX + pad, srcMaxX),
            Math.min(maxY + pad, srcMaxY)
        ];

        if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
            state.contourDragGridLoading = false;
            return;
        }

        // Use 2x overview resolution for routing — higher res than display
        // (which uses 8x) but accessed efficiently via bbox reads
        const resX = state.contourPixelSizeX ? state.contourPixelSizeX : 0.5;
        const resY = state.contourPixelSizeY ? state.contourPixelSizeY : 0.5;

        const rasters = await state.contourTiff.readRasters({
            bbox,
            resX,
            resY,
            pool: state.geoTiffPool
        });

        const rawGrid = rasters[0];
        const width = rasters.width;
        const height = rasters.height;

        const grid = new Float32Array(rawGrid.length);
        const noDataValue = state.contourNoData;
        for (let i = 0; i < rawGrid.length; i++) {
            const val = rawGrid[i];
            if (val === noDataValue || val >= 1e5 || !Number.isFinite(val)) {
                grid[i] = Number.NaN;
            } else {
                grid[i] = val;
            }
        }

        state.contourDragGrid = { grid, width, height, bbox };
        console.log(`Contour drag grid loaded: ${width}x${height} (${(rawGrid.length * 4 / 1024).toFixed(0)}KB)`);
    } catch (error) {
        console.error('Failed to load contour drag grid:', error);
    } finally {
        state.contourDragGridLoading = false;
    }
}

// ============================================
// Click and Drag Handlers
// ============================================

/**
 * Initialize all click/drag event handlers for measurement, contour drag,
 * and cursor feedback.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 * @param {Object} config - Application config
 * @param {Object} callbacks - Cross-module callbacks
 * @param {Function} callbacks.addMeasureVertex - (clickedKey) => void
 * @param {Function} callbacks.addMeasureFreePoint - (lngLat) => void
 */
export function initializeClickHandlers(map, state, config, callbacks) {
    // Vertex click handler
    map.on('click', 'survey-vertices-layer', (e) => {
        if (!state.measureMode) return;
        if (state._suppressClick) return;
        if (e.features.length === 0) return;
        e.originalEvent._vertexHandled = true;
        const key = e.features[0].properties.key;
        callbacks.addMeasureVertex(key);
    });

    // General map click
    map.on('click', (e) => {
        if (!state.measureMode) return;
        if (state._suppressClick) return;
        if (e.originalEvent._vertexHandled) return;
        callbacks.addMeasureFreePoint(e.lngLat);
    });

    // --- Drag handlers for free-form measure points ---

    function handlePointDragStart(e) {
        if (!state.measureMode) return;
        if (e.features.length === 0) return;
        const feat = e.features[0];
        if (feat.properties.isVertex) return;

        e.preventDefault();
        state.draggingPointIndex = feat.properties.index;
        state._dragMoved = false;
        state._dragStartScreen = { x: e.point.x, y: e.point.y };
        state._suppressClick = true;
        map.dragPan.disable();
        map.getCanvas().style.cursor = 'grabbing';
    }

    map.on('mousedown', 'measure-points-layer', handlePointDragStart);
    map.on('touchstart', 'measure-points-layer', handlePointDragStart);

    function handlePointDragMove(e) {
        if (state.draggingPointIndex === null) return;

        // Distinguish click from drag: require > 3px movement
        if (!state._dragMoved) {
            const dx = e.point.x - state._dragStartScreen.x;
            const dy = e.point.y - state._dragStartScreen.y;
            if (dx * dx + dy * dy <= 9) return;
            state._dragMoved = true;
        }

        const i = state.draggingPointIndex;
        const pt = state.measurePoints[i];
        pt.lng = e.lngLat.lng;
        pt.lat = e.lngLat.lat;

        // Dragging invalidates contour anchor status
        if (pt.isContourAnchor) {
            pt.isContourAnchor = false;
        }

        if (i > 0) {
            const prev = state.measurePoints[i - 1];
            const seg = state.measureSegments[i - 1];
            seg.coords = [[prev.lng, prev.lat], [pt.lng, pt.lat]];
            seg.distance = haversineDistance([prev.lng, prev.lat], [pt.lng, pt.lat]);
            // Contour path is invalidated — now a straight line
            delete seg.contourAHD;
        }

        if (i < state.measurePoints.length - 1) {
            const next = state.measurePoints[i + 1];
            const seg = state.measureSegments[i];
            seg.coords = [[pt.lng, pt.lat], [next.lng, next.lat]];
            seg.distance = haversineDistance([pt.lng, pt.lat], [next.lng, next.lat]);
            delete seg.contourAHD;
        }

        state.measureTotalDistance = state.measureSegments.reduce((sum, s) => sum + s.distance, 0);

        updateMeasureVisualization(map, state);
        rebuildMeasurePanel(state, config);
    }

    map.on('mousemove', handlePointDragMove);
    map.on('touchmove', handlePointDragMove);

    function handlePointDragEnd() {
        if (state.draggingPointIndex === null) return;

        const idx = state.draggingPointIndex;
        const wasDrag = state._dragMoved;

        state.draggingPointIndex = null;
        state._dragMoved = false;
        state._dragStartScreen = null;
        map.dragPan.enable();
        if (state.measureMode) {
            map.getCanvas().style.cursor = 'crosshair';
        }

        if (!wasDrag) {
            // Click without drag — delete the point
            deleteMeasurePoint(map, state, config, idx);
        }

        setTimeout(() => { state._suppressClick = false; }, 0);
    }

    globalThis.addEventListener('mouseup', handlePointDragEnd);
    globalThis.addEventListener('touchend', handlePointDragEnd);

    // --- Contour drag: mousedown/touchstart on measure line segment ---
    function handleContourDragStart(e) {
        if (!state.measureMode) return;
        if (state.measureSegments.length === 0) return;
        if (state.draggingPointIndex !== null) return;

        const clickLng = e.lngLat.lng;
        const clickLat = e.lngLat.lat;
        let bestSegIdx = -1;
        let bestDist = Infinity;

        for (let si = 0; si < state.measureSegments.length; si++) {
            const seg = state.measureSegments[si];
            const coords = seg.coords;
            for (let ci = 0; ci < coords.length - 1; ci++) {
                const [ax, ay] = coords[ci];
                const [bx, by] = coords[ci + 1];
                const d = _pointToLineDistance([clickLng, clickLat], [ax, ay], [bx, by]);
                if (d < bestDist) {
                    bestDist = d;
                    bestSegIdx = si;
                }
            }
        }

        if (bestSegIdx < 0 || bestDist > 0.0001) return;

        const pointAIndex = bestSegIdx;
        const pointBIndex = bestSegIdx + 1;
        const ptA = state.measurePoints[pointAIndex];
        const ptB = state.measurePoints[pointBIndex];

        if (ptA.isVertex && ptB.isVertex) return;

        e.preventDefault();
        state.draggingContourSegment = { segmentIndex: bestSegIdx, pointAIndex, pointBIndex };
        state._suppressClick = true;
        state.contourDragGrid = null;
        state.contourPreviewCoords = null;
        map.dragPan.disable();
        map.getCanvas().style.cursor = 'crosshair';

        loadContourGridForDrag(state, ptA, ptB);
    }

    map.on('mousedown', 'measure-line-hit', handleContourDragStart);
    map.on('touchstart', 'measure-line-hit', handleContourDragStart);

    // Contour drag preview
    function handleContourDragMove(e) {
        if (state.draggingContourSegment === null) return;

        const mouseElev = state.bathymetryLayer
            ? state.bathymetryLayer.getElevationAtLngLat(e.lngLat.lng, e.lngLat.lat)
            : null;

        if (mouseElev === null) return;

        const waterLevel = getActiveWaterLevel(state, config);
        if (mouseElev > waterLevel) return;

        const targetElevation = mouseElev;

        if (state.contourDragGrid) {
            const { grid, width, height, bbox } = state.contourDragGrid;
            const { pointAIndex, pointBIndex } = state.draggingContourSegment;
            const ptA = state.measurePoints[pointAIndex];
            const ptB = state.measurePoints[pointBIndex];

            const contourPath = findContourPath(
                grid, width, height, bbox,
                ptA.lng, ptA.lat, ptB.lng, ptB.lat,
                targetElevation
            );

            if (contourPath && contourPath.length >= 2) {
                state.contourPreviewCoords = contourPath;
                state._contourPreviewElevation = targetElevation;

                const features = [];
                const contourStart = contourPath[0];
                const contourEnd = contourPath[contourPath.length - 1];

                features.push({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: [[ptA.lng, ptA.lat], contourStart] },
                    properties: { type: 'approach' }
                });

                features.push({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: contourPath },
                    properties: { type: 'contour' }
                });

                features.push({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: [contourEnd, [ptB.lng, ptB.lat]] },
                    properties: { type: 'depart' }
                });

                map.getSource('measure-contour-preview').setData({
                    type: 'FeatureCollection',
                    features
                });
            } else {
                map.getSource('measure-contour-preview').setData({ type: 'FeatureCollection', features: [] });
                state.contourPreviewCoords = null;
            }
        }
    }

    map.on('mousemove', handleContourDragMove);
    map.on('touchmove', handleContourDragMove);

    // Contour drag finalize
    function handleContourDragEnd() {
        if (state.draggingContourSegment === null) return;

        const { segmentIndex, pointAIndex, pointBIndex } = state.draggingContourSegment;

        if (state.contourPreviewCoords && state.contourPreviewCoords.length >= 2) {
            const contourPath = state.contourPreviewCoords;
            const targetElevation = state._contourPreviewElevation;
            const contourStart = contourPath[0];
            const contourEnd = contourPath[contourPath.length - 1];
            const ptA = state.measurePoints[pointAIndex];
            const ptB = state.measurePoints[pointBIndex];

            const approachCoords = [[ptA.lng, ptA.lat], contourStart];
            const approachDist = haversineDistance(approachCoords[0], approachCoords[1]);

            let contourDist = 0;
            for (let i = 0; i < contourPath.length - 1; i++) {
                contourDist += haversineDistance(contourPath[i], contourPath[i + 1]);
            }

            const departCoords = [contourEnd, [ptB.lng, ptB.lat]];
            const departDist = haversineDistance(departCoords[0], departCoords[1]);

            const anchorA = {
                lng: contourStart[0], lat: contourStart[1],
                isVertex: false, vertexKey: null, isContourAnchor: true
            };
            const anchorB = {
                lng: contourEnd[0], lat: contourEnd[1],
                isVertex: false, vertexKey: null, isContourAnchor: true
            };

            state.measureSegments.splice(segmentIndex, 1,
                { coords: approachCoords, distance: approachDist },
                { coords: contourPath, distance: contourDist, contourAHD: targetElevation },
                { coords: departCoords, distance: departDist }
            );

            state.measurePoints.splice(pointBIndex, 0, anchorA, anchorB);

            state.measureTotalDistance = state.measureSegments.reduce((sum, s) => sum + s.distance, 0);
        }

        state.draggingContourSegment = null;
        state.contourDragGrid = null;
        state.contourPreviewCoords = null;
        delete state._contourPreviewElevation;
        map.dragPan.enable();
        if (state.measureMode) {
            map.getCanvas().style.cursor = 'crosshair';
        }

        map.getSource('measure-contour-preview').setData({ type: 'FeatureCollection', features: [] });

        updateMeasureVisualization(map, state);
        rebuildMeasurePanel(state, config);
        updateElevationProfile(state, state._map);

        setTimeout(() => { state._suppressClick = false; }, 0);
    }

    globalThis.addEventListener('mouseup', handleContourDragEnd);
    globalThis.addEventListener('touchend', handleContourDragEnd);

    // --- Cursor feedback ---

    map.on('mouseenter', 'survey-vertices-layer', () => {
        if (state.measureMode && state.draggingPointIndex === null) {
            map.getCanvas().style.cursor = 'pointer';
        }
    });

    map.on('mouseleave', 'survey-vertices-layer', () => {
        if (state.measureMode && state.draggingPointIndex === null) {
            map.getCanvas().style.cursor = 'crosshair';
        }
    });

    map.on('mouseenter', 'measure-points-layer', (e) => {
        if (!state.measureMode || state.draggingPointIndex !== null) return;
        if (e.features.length > 0 && !e.features[0].properties.isVertex) {
            map.getCanvas().style.cursor = 'grab';
        }
    });

    map.on('mouseleave', 'measure-points-layer', () => {
        if (state.measureMode && state.draggingPointIndex === null) {
            map.getCanvas().style.cursor = 'crosshair';
        }
    });

    map.on('mouseenter', 'measure-line-hit', () => {
        if (state.measureMode && state.draggingPointIndex === null && state.draggingContourSegment === null) {
            map.getCanvas().style.cursor = 'ns-resize';
        }
    });

    map.on('mouseleave', 'measure-line-hit', () => {
        if (state.measureMode && state.draggingPointIndex === null && state.draggingContourSegment === null) {
            map.getCanvas().style.cursor = 'crosshair';
        }
    });
}

// ============================================
// Nav Plan URL Encoding / Decoding
// ============================================

function r(n, dp) {
    const f = 10 ** dp;
    return Math.round(n * f) / f;
}

/**
 * Encode the current nav plan (measure state + view) into a URL-safe string.
 * Returns null if there is no nav plan to encode.
 *
 * Uses v3 format with LZ-string compression and deferred contour regeneration.
 * Contour segments store only the target elevation, not the full coordinate chain.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 * @param {Object} config - Application config
 * @returns {string|null} Compressed nav plan string, or null
 */
export function encodeNavPlan(map, state, config) {
    if (state.measurePoints.length === 0) return null;

    const plan = {
        v: 3,
        w: state.useCurrentLevel ? null : r(state.customStorageGL, 2),
        c: [r(map.getCenter().lng, 6), r(map.getCenter().lat, 6), r(map.getZoom(), 1)],
        p: state.measurePoints.map(pt => {
            if (pt.isVertex) return [r(pt.lng, 6), r(pt.lat, 6), 1, pt.vertexKey];
            if (pt.isContourAnchor) return [r(pt.lng, 6), r(pt.lat, 6), 2];
            return [r(pt.lng, 6), r(pt.lat, 6), 0];
        }),
        s: state.measureSegments.map((seg, i) => {
            console.log(`Encoding segment ${i}: coords=${seg.coords.length}, contourAHD=${seg.contourAHD}`);
            // v3: contour segments store only elevation, path regenerated at runtime
            // Check this FIRST since contour placeholders may have only 2 coords
            if (seg.contourAHD !== undefined) {
                return { a: r(seg.contourAHD, 2) };
            }
            // Straight line (2 coords, no contourAHD)
            if (seg.coords.length === 2) {
                return 0;
            }
            // Non-contour multi-point segment (e.g., vertex-to-vertex path)
            return { c: seg.coords.map(([lng, lat]) => [r(lng, 6), r(lat, 6)]) };
        })
    };

    const json = JSON.stringify(plan);
    // v3: LZ-string compression to URI-safe format
    return '3.' + LZString.compressToEncodedURIComponent(json);
}

/**
 * Decode a nav plan string back into a plan object.
 * Supports v1 (base64 JSON), v2 (LZ-string, full coords), and v3 (LZ-string, deferred contours).
 *
 * @param {string} encoded - Encoded nav plan string
 * @returns {{plan: Object, needsUpgrade: boolean}|null} Decoded plan with upgrade info, or null on failure
 */
export function decodeNavPlan(encoded) {
    try {
        let plan;
        let needsUpgrade = false;

        if (encoded.startsWith('3.')) {
            // v3: LZ-string compressed, deferred contours
            const json = LZString.decompressFromEncodedURIComponent(encoded.slice(2));
            if (!json) return null;
            plan = JSON.parse(json);
        } else if (encoded.startsWith('2.')) {
            // v2: LZ-string compressed, full coords
            const json = LZString.decompressFromEncodedURIComponent(encoded.slice(2));
            if (!json) return null;
            plan = JSON.parse(json);
            needsUpgrade = true;
        } else {
            // v1: URL-safe base64 JSON
            let b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4) b64 += '=';
            plan = JSON.parse(atob(b64));
            needsUpgrade = true;
        }

        if (plan.v !== 1 && plan.v !== 2 && plan.v !== 3) return null;
        return { plan, needsUpgrade };
    } catch {
        return null;
    }
}

/**
 * Restore a nav plan from a decoded plan object into application state.
 * Rebuilds measure points, segments, panel and visualization.
 *
 * For v3 plans, contour segments may only have elevation (no coords) and will
 * be marked as pending regeneration. Call regeneratePendingContours() once
 * contour COG data is available.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 * @param {Object} config - Application config
 * @param {Object} plan - Decoded plan object from decodeNavPlan
 * @returns {boolean} True if there are pending contours to regenerate
 */
export function restoreNavPlan(map, state, config, plan) {
    // Restore water level
    if (plan.w !== null && plan.w !== undefined) {
        state.useCurrentLevel = false;
        state.customStorageGL = plan.w;
        const slider = document.getElementById('water-level-slider');
        const lockCheckbox = document.getElementById('water-level-lock');
        if (slider) slider.value = plan.w;
        if (lockCheckbox) lockCheckbox.checked = false;
    }

    // Restore map view
    if (plan.c) {
        map.jumpTo({ center: [plan.c[0], plan.c[1]], zoom: plan.c[2] });
    }

    // Restore points
    state.measurePoints = plan.p.map(entry => ({
        lng: entry[0],
        lat: entry[1],
        isVertex: entry[2] === 1,
        vertexKey: entry[2] === 1 ? entry[3] : null,
        isContourAnchor: entry[2] === 2
    }));

    // Restore segments
    let hasPendingContours = false;
    console.log('Restoring segments, plan.v =', plan.v, ', segments:', plan.s.map(s => s === 0 ? '0' : JSON.stringify(s)));
    state.measureSegments = plan.s.map((seg, i) => {
        const ptA = state.measurePoints[i];
        const ptB = state.measurePoints[i + 1];

        if (seg === 0) {
            // Straight line segment
            const coords = [[ptA.lng, ptA.lat], [ptB.lng, ptB.lat]];
            return { coords, distance: haversineDistance(coords[0], coords[1]) };
        }

        if (seg.a !== undefined && !seg.c) {
            // v3 deferred contour: only elevation, needs regeneration
            // Create placeholder straight line for now
            console.log(`Segment ${i}: deferred contour at ${seg.a}m AHD`);
            hasPendingContours = true;
            const coords = [[ptA.lng, ptA.lat], [ptB.lng, ptB.lat]];
            return {
                coords,
                distance: haversineDistance(coords[0], coords[1]),
                contourAHD: seg.a,
                pendingRegeneration: true
            };
        }

        // Full coordinate chain (v1/v2 or non-contour multi-point)
        const coords = seg.c;
        let distance = 0;
        for (let j = 0; j < coords.length - 1; j++) {
            distance += haversineDistance(coords[j], coords[j + 1]);
        }
        const result = { coords, distance };
        if (seg.a !== undefined) result.contourAHD = seg.a;
        return result;
    });
    console.log('hasPendingContours =', hasPendingContours);

    state.measureTotalDistance = state.measureSegments.reduce((sum, s) => sum + s.distance, 0);
    state.lastMeasureVertexKey = null;
    state.hasPendingContours = hasPendingContours;

    // Activate measure mode UI
    state.measureMode = true;
    const measureBtn = document.getElementById('measure-btn');
    if (measureBtn) measureBtn.classList.add('active');
    document.body.classList.add('measure-mode-active');
    const clearBtn = document.getElementById('clear-btn');
    if (clearBtn) clearBtn.style.display = 'block';

    updateMeasureVisualization(map, state);
    rebuildMeasurePanel(state, config);
    updateElevationProfile(state, state._map);
    updateVertexHighlights(map, state);

    return hasPendingContours;
}

/**
 * Load a native-resolution contour grid for the area between two points.
 * Similar to loadContourGridForDrag but returns the grid instead of storing in state.
 *
 * @param {Object} state - Application state
 * @param {Object} ptA - Start point {lng, lat}
 * @param {Object} ptB - End point {lng, lat}
 * @returns {Promise<{grid, width, height, bbox}|null>} Grid data or null on failure
 */
async function loadContourGridForSegment(state, ptA, ptB) {
    if (!state.contourTiff || !state.contourBbox) return null;

    try {
        const [axM, ayM] = lngLatToWebMercator(ptA.lng, ptA.lat);
        const [bxM, byM] = lngLatToWebMercator(ptB.lng, ptB.lat);

        const minX = Math.min(axM, bxM);
        const maxX = Math.max(axM, bxM);
        const minY = Math.min(ayM, byM);
        const maxY = Math.max(ayM, byM);

        // Generous padding so the A* can find contours that curve away
        const span = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2);
        const pad = Math.max(300, span * 1.0);
        const [srcMinX, srcMinY, srcMaxX, srcMaxY] = state.contourBbox;
        const bbox = [
            Math.max(minX - pad, srcMinX),
            Math.max(minY - pad, srcMinY),
            Math.min(maxX + pad, srcMaxX),
            Math.min(maxY + pad, srcMaxY)
        ];

        if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) return null;

        const resX = state.contourPixelSizeX || 0.5;
        const resY = state.contourPixelSizeY || 0.5;

        const rasters = await state.contourTiff.readRasters({
            bbox,
            resX,
            resY,
            pool: state.geoTiffPool
        });

        const rawGrid = rasters[0];
        const width = rasters.width;
        const height = rasters.height;

        const grid = new Float32Array(rawGrid.length);
        const noDataValue = state.contourNoData;
        for (let i = 0; i < rawGrid.length; i++) {
            const val = rawGrid[i];
            if (val === noDataValue || val >= 1e5 || !Number.isFinite(val)) {
                grid[i] = Number.NaN;
            } else {
                grid[i] = val;
            }
        }

        return { grid, width, height, bbox };
    } catch (error) {
        console.error('Failed to load contour grid for segment:', error);
        return null;
    }
}

/**
 * Regenerate contour paths for segments marked as pending.
 * Call this once contour COG data (state.contourTiff) is available.
 *
 * @param {maplibregl.Map} map - The map instance
 * @param {Object} state - Application state
 * @param {Object} config - Application config
 */
export async function regeneratePendingContours(map, state, config) {
    if (!state.hasPendingContours) return;
    if (!state.contourTiff) {
        console.warn('Cannot regenerate contours: COG not loaded yet');
        return;
    }

    console.log('Regenerating pending contour paths...');
    let anyRegenerated = false;

    for (let i = 0; i < state.measureSegments.length; i++) {
        const seg = state.measureSegments[i];
        if (!seg.pendingRegeneration) continue;

        const ptA = state.measurePoints[i];
        const ptB = state.measurePoints[i + 1];

        // Load native-resolution grid for this segment's area
        const gridData = await loadContourGridForSegment(state, ptA, ptB);
        if (!gridData) {
            console.warn(`Could not load grid for segment ${i}`);
            delete seg.pendingRegeneration;
            delete seg.contourAHD;
            continue;
        }

        const { grid, width, height, bbox } = gridData;
        const contourPath = findContourPath(
            grid, width, height, bbox,
            ptA.lng, ptA.lat, ptB.lng, ptB.lat,
            seg.contourAHD
        );

        if (contourPath && contourPath.length >= 2) {
            // Update segment with regenerated path
            seg.coords = contourPath;
            let distance = 0;
            for (let j = 0; j < contourPath.length - 1; j++) {
                distance += haversineDistance(contourPath[j], contourPath[j + 1]);
            }
            seg.distance = distance;
            delete seg.pendingRegeneration;
            anyRegenerated = true;
            console.log(`Regenerated contour segment ${i} at ${seg.contourAHD}m AHD (${contourPath.length} points)`);
        } else {
            // Contour path couldn't be found - keep as straight line
            console.warn(`Could not regenerate contour path for segment ${i} at ${seg.contourAHD}m AHD`);
            delete seg.pendingRegeneration;
            delete seg.contourAHD; // No longer a contour segment
        }
    }

    if (anyRegenerated) {
        state.measureTotalDistance = state.measureSegments.reduce((sum, s) => sum + s.distance, 0);
        state.hasPendingContours = false;

        updateMeasureVisualization(map, state);
        rebuildMeasurePanel(state, config);
        updateElevationProfile(state, state._map);

        // Update URL with regenerated paths (will re-encode as v3)
        if (state.onNavPlanChange) state.onNavPlanChange();
        console.log('Contour regeneration complete');
    }
}
