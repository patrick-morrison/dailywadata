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
    BATHYMETRY_COG_URL: 'AbrolhosBathy_cog.tif',
    TRAIL_COLORS: {
        'Beacon Island Dive Trail': '#FF6B6B',
        'Turtle Bay Dive Trail': '#4ECDC4',
        'Anemone Lump Dive Trail': '#FFE66D',
        'Coral Patches Dive Trail': '#95E1D3',
        'Morley Island Dive Trail': '#F38181',
        'Rootail Coral Drive Trail': '#AA96DA',
        'Long Island Dive Trail': '#88D8B0'
    },
    CONTOUR_COLOR: '#000000',  // Single color for all contours
    CONTOUR_INTERVALS: {
        14: 5,   // Zoom 14-15: 5m intervals
        16: 2    // Zoom 16+: 2m intervals
    },
    CONTOUR_RANGE: [0, -55]  // Min and max depth (only underwater)
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
    selectedTrail: null,      // Currently selected trail for highlighting
    contoursCache: new Map(), // Cache generated contours
    isGeneratingContours: false,
    geoTiffImage: null        // Cached GeoTIFF image reference
};

// ============================================
// Utilities
// ============================================

// Turbo colormap (QGIS-compatible)
// Source: https://gist.github.com/mikhailov-work/ee72ba4191942acecc03fe6da94fc73f
const TURBO_COLORMAP = [
    [0.18995, 0.07176, 0.23217], [0.20415, 0.10652, 0.31844],
    [0.22500, 0.16354, 0.45096], [0.24539, 0.23044, 0.59142],
    [0.26280, 0.30639, 0.72968], [0.27701, 0.45152, 0.92347],
    [0.27603, 0.49132, 0.95857], [0.26592, 0.55979, 0.99583],
    [0.25425, 0.58950, 0.99896], [0.23874, 0.61931, 0.99485],
    [0.21382, 0.65886, 0.97959], [0.18625, 0.69775, 0.95498],
    [0.15173, 0.74472, 0.91416], [0.12151, 0.78896, 0.86581],
    [0.10026, 0.82955, 0.81389], [0.09320, 0.87211, 0.75237],
    [0.10815, 0.90142, 0.70599], [0.14391, 0.92680, 0.65448],
    [0.18491, 0.94484, 0.60713], [0.22877, 0.95304, 0.58199],
    [0.27597, 0.97092, 0.51653], [0.32006, 0.97974, 0.47654],
    [0.36581, 0.98702, 0.43688], [0.41229, 0.99268, 0.39826],
    [0.45854, 0.99663, 0.36140], [0.50362, 0.99879, 0.32701],
    [0.54658, 0.99907, 0.29581], [0.59891, 0.99638, 0.26038],
    [0.65394, 0.98775, 0.22835], [0.71577, 0.96875, 0.20815],
    [0.78563, 0.93579, 0.20336], [0.47960, 0.01583, 0.01055]
];

/**
 * Map elevation value to RGB color using Turbo colormap
 * @param {number} elevation - Elevation in meters
 * @param {number} minElev - Minimum elevation in dataset
 * @param {number} maxElev - Maximum elevation in dataset
 * @returns {Array} RGB values [0-255]
 */
function getTurboColor(elevation, minElev, maxElev) {
    // Normalize elevation to 0-1 range
    const normalized = (elevation - minElev) / (maxElev - minElev);
    const clamped = Math.max(0, Math.min(1, normalized));

    // Map to colormap index
    const index = clamped * (TURBO_COLORMAP.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const fraction = index - lower;

    // Interpolate between colors
    const colorLower = TURBO_COLORMAP[lower];
    const colorUpper = TURBO_COLORMAP[upper];

    return [
        Math.round((colorLower[0] + (colorUpper[0] - colorLower[0]) * fraction) * 255),
        Math.round((colorLower[1] + (colorUpper[1] - colorLower[1]) * fraction) * 255),
        Math.round((colorLower[2] + (colorUpper[2] - colorLower[2]) * fraction) * 255)
    ];
}

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

        // Apply Turbo color ramp to bathymetry COG
        const cogUrl = CONFIG.BATHYMETRY_COG_URL;
        const minElev = -57.712;  // From gdalinfo
        const maxElev = 0;   // From gdalinfo

        MaplibreCOGProtocol.setColorFunction(cogUrl, (pixel, color, metadata) => {
            const elevation = pixel[0];

            // Handle NoData values (1e+06)
            if (elevation === metadata.noData || elevation >= 1e5) {
                color.set([0, 0, 0, 0]); // Transparent
                return;
            }

            // Don't render areas above sea level (elevation > 0)
            if (elevation > 0) {
                color.set([0, 0, 0, 0]); // Transparent
                return;
            }

            // Get Turbo color for this elevation
            const [r, g, b] = getTurboColor(elevation, minElev, maxElev);
            color.set([r, g, b, 255]);
        });

        // Resource is available, add the layer
        map.addSource('bathymetry-source', {
            type: 'raster',
            url: `cog://${cogUrl}`,
            tileSize: 256
        });

        map.addSource('hillshade-source', {
            type: 'raster-dem',
            url: `cog://${cogUrl}`,
            tileSize: 256
        });

        map.addLayer({
            id: 'hillshade-layer',
            type: 'hillshade',
            source: 'hillshade-source',
            paint: {
                'hillshade-illumination-direction': 45,
                'hillshade-shadow-color': '#000000',
                'hillshade-highlight-color': '#FFFFFF',
                'hillshade-accent-color': '#000000',
                'hillshade-exaggeration': 0.05
            },
            layout: {
                visibility: state.layerVisibility.hillshade ? 'visible' : 'none'
            },
        }, 'dive-trails-layer'); // Insert below dive trails

        map.addLayer({
            id: 'bathymetry-layer',
            type: 'raster',
            source: 'bathymetry-source',
            paint: {
                'raster-opacity': state.layerOpacity.bathymetry,
                'raster-resampling': 'nearest'
            },
            layout: {
                visibility: state.layerVisibility.bathymetry ? 'visible' : 'none'
            }
        }, 'hillshade-layer'); // Insert below hillshade



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

/**
 * Debounce helper function
 */
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Initialize client-side contour generation from bathymetry COG
 */
async function initializeContourGeneration() {
    const legendControl = document.querySelector('.layer-control[data-layer="contours"]');

    try {
        // Load GeoTIFF once at startup
        const tiff = await GeoTIFF.fromUrl(CONFIG.BATHYMETRY_COG_URL, {
            allowFullFile: false,  // Only fetch needed ranges
            cacheSize: 100  // Cache up to 100 tiles
        });

        state.geoTiffImage = await tiff.getImage();

        // Show legend control
        if (legendControl) {
            legendControl.style.display = 'block';
        }

        // Generate initial contours only if zoomed in enough
        if (map.getZoom() >= Math.min(...Object.keys(CONFIG.CONTOUR_INTERVALS).map(Number))) {
            await generateContoursForViewport();
        }

        // Regenerate on map movement (debounced)
        map.on('moveend', debounce(generateContoursForViewport, 300));

    } catch (error) {
        console.warn('Contour generation unavailable - elevation data not accessible', error);
        state.layerVisibility.contours = false;
    }
}

/**
 * Generate contours for current viewport from bathymetry elevation data
 */
async function generateContoursForViewport() {
    if (state.isGeneratingContours || !state.geoTiffImage) return;
    if (!state.layerVisibility.contours) return;

    const zoom = Math.floor(map.getZoom());

    // Only generate contours at configured minimum zoom level
    const minContourZoom = Math.min(...Object.keys(CONFIG.CONTOUR_INTERVALS).map(Number));
    if (zoom < minContourZoom) return;

    const bounds = map.getBounds();

    // Determine contour interval based on zoom
    let interval = 10;  // Default
    for (const [zoomThreshold, int] of Object.entries(CONFIG.CONTOUR_INTERVALS).sort((a, b) => b[0] - a[0])) {
        if (zoom >= parseInt(zoomThreshold)) {
            interval = int;
            break;
        }
    }

    // Check cache
    const cacheKey = `${zoom}-${interval}-${bounds.toString()}`;
    if (state.contoursCache.has(cacheKey)) {
        const cached = state.contoursCache.get(cacheKey);
        map.getSource('contours-source').setData(cached);
        return;
    }

    state.isGeneratingContours = true;
    document.getElementById('contours-loading')?.classList.add('active');

    try {
        // Get image metadata for proper coordinate transformation
        const imageBbox = state.geoTiffImage.getBoundingBox();
        const imageWidth = state.geoTiffImage.getWidth();
        const imageHeight = state.geoTiffImage.getHeight();

        // Helper function: WGS84 to Web Mercator (EPSG:3857)
        const lngLatToWebMercator = (lng, lat) => {
            const x = (lng * 20037508.34) / 180;
            let y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180);
            y = (y * 20037508.34) / 180;
            return [x, y];
        };

        // Convert map bounds from WGS84 to Web Mercator (to match GeoTIFF projection)
        const [minX, minY] = lngLatToWebMercator(bounds.getWest(), bounds.getSouth());
        const [maxX, maxY] = lngLatToWebMercator(bounds.getEast(), bounds.getNorth());

        // Add 10% buffer to avoid edge artifacts
        const bufferX = (maxX - minX) * 0.5;
        const bufferY = (maxY - minY) * 0.5;

        // Calculate pixel window within the GeoTIFF (with buffer)
        const left = Math.floor(((minX - bufferX - imageBbox[0]) / (imageBbox[2] - imageBbox[0])) * imageWidth);
        const right = Math.ceil(((maxX + bufferX - imageBbox[0]) / (imageBbox[2] - imageBbox[0])) * imageWidth);
        const top = Math.floor(((imageBbox[3] - (maxY + bufferY)) / (imageBbox[3] - imageBbox[1])) * imageHeight);
        const bottom = Math.ceil(((imageBbox[3] - (minY - bufferY)) / (imageBbox[3] - imageBbox[1])) * imageHeight);

        // Clamp to image bounds
        const windowLeft = Math.max(0, left);
        const windowTop = Math.max(0, top);
        const windowRight = Math.min(imageWidth, right);
        const windowBottom = Math.min(imageHeight, bottom);
        const windowWidth = windowRight - windowLeft;
        const windowHeight = windowBottom - windowTop;

        // Determine target resolution (higher zoom = more detail)
        const isMobile = window.innerWidth <= 768;
        const baseResolution = isMobile ? 256 : 512;
        const targetPixels = Math.min(
            baseResolution * Math.pow(2, Math.max(0, zoom - 15)),
            isMobile ? 1024 : 2048
        );

        // Calculate aspect ratio
        const aspectRatio = windowWidth / windowHeight;
        let width, height;
        if (aspectRatio > 1) {
            width = targetPixels;
            height = Math.floor(targetPixels / aspectRatio);
        } else {
            height = targetPixels;
            width = Math.floor(targetPixels * aspectRatio);
        }

        // Read elevation data using pixel window
        const data = await state.geoTiffImage.readRasters({
            window: [windowLeft, windowTop, windowRight, windowBottom],
            width,
            height,
            fillValue: -9999,
            resampleMethod: 'linear'
        });

        const elevationGrid = data[0];  // First band

        // Calculate actual geographic extent of the window in Web Mercator
        const actualMinX = imageBbox[0] + (windowLeft / imageWidth) * (imageBbox[2] - imageBbox[0]);
        const actualMaxX = imageBbox[0] + (windowRight / imageWidth) * (imageBbox[2] - imageBbox[0]);
        const actualMaxY = imageBbox[3] - (windowTop / imageHeight) * (imageBbox[3] - imageBbox[1]);
        const actualMinY = imageBbox[3] - (windowBottom / imageHeight) * (imageBbox[3] - imageBbox[1]);

        // Generate threshold values
        const thresholds = [];
        for (let elev = CONFIG.CONTOUR_RANGE[0]; elev > CONFIG.CONTOUR_RANGE[1]; elev -= interval) {
            thresholds.push(elev);
        }

        // Generate contours using d3-contour
        const contourGenerator = d3.contours()
            .size([width, height])
            .thresholds(thresholds)
            .smooth(true);  // Smooth contour lines

        const contourMultiPolygons = contourGenerator(elevationGrid);

        // Helper function: Web Mercator to WGS84
        const webMercatorToLngLat = (x, y) => {
            const lng = (x / 20037508.34) * 180;
            let lat = (y / 20037508.34) * 180;
            lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((lat * Math.PI) / 180)) - Math.PI / 2);
            return [lng, lat];
        };

        // Convert to GeoJSON LineStrings with proper coordinates
        const features = [];

        // Calculate viewport bounds in Web Mercator for edge filtering
        const viewportMinX = lngLatToWebMercator(bounds.getWest(), bounds.getSouth())[0];
        const viewportMaxX = lngLatToWebMercator(bounds.getEast(), bounds.getNorth())[0];
        const viewportMinY = lngLatToWebMercator(bounds.getWest(), bounds.getSouth())[1];
        const viewportMaxY = lngLatToWebMercator(bounds.getEast(), bounds.getNorth())[1];

        for (const multiPolygon of contourMultiPolygons) {
            if (multiPolygon.coordinates.length === 0) continue;

            for (const polygon of multiPolygon.coordinates) {
                for (const ring of polygon) {
                    // Check if contour is adjacent to NoData values
                    let nearNoData = false;
                    const samplePoints = Math.min(ring.length, 20); // Sample every Nth point
                    const step = Math.max(1, Math.floor(ring.length / samplePoints));

                    for (let i = 0; i < ring.length; i += step) {
                        const [x, y] = ring[i];
                        const px = Math.floor(x);
                        const py = Math.floor(y);

                        // Check surrounding pixels for NoData
                        for (let dy = -1; dy <= 1; dy++) {
                            for (let dx = -1; dx <= 1; dx++) {
                                const checkX = px + dx;
                                const checkY = py + dy;
                                if (checkX >= 0 && checkX < width && checkY >= 0 && checkY < height) {
                                    const idx = checkY * width + checkX;
                                    const value = elevationGrid[idx];
                                    if (value === -9999 || value >= 1e5) {
                                        nearNoData = true;
                                        break;
                                    }
                                }
                            }
                            if (nearNoData) break;
                        }
                        if (nearNoData) break;
                    }

                    if (nearNoData) continue; // Skip contours near NoData

                    // Transform pixel coordinates to geographic coordinates
                    const geoCoords = ring.map(([x, y]) => {
                        // Convert pixel to Web Mercator
                        const mercatorX = actualMinX + (x / width) * (actualMaxX - actualMinX);
                        const mercatorY = actualMaxY - (y / height) * (actualMaxY - actualMinY);
                        // Convert Web Mercator to WGS84
                        return webMercatorToLngLat(mercatorX, mercatorY);
                    });

                    // Filter out contours that are entirely outside or on the edge of viewport
                    // Check if any point is within the viewport (with small margin)
                    const margin = (viewportMaxX - viewportMinX) * 0.01; // 1% margin
                    let hasInteriorPoint = false;

                    for (const [lng, lat] of geoCoords) {
                        const [mx, my] = lngLatToWebMercator(lng, lat);
                        if (mx > viewportMinX + margin && mx < viewportMaxX - margin &&
                            my > viewportMinY + margin && my < viewportMaxY - margin) {
                            hasInteriorPoint = true;
                            break;
                        }
                    }

                    if (!hasInteriorPoint) continue; // Skip edge contours

                    features.push({
                        type: 'Feature',
                        properties: {
                            ELEV: multiPolygon.value,
                            interval
                        },
                        geometry: {
                            type: 'LineString',
                            coordinates: geoCoords
                        }
                    });
                }
            }
        }

        const geojson = {
            type: 'FeatureCollection',
            features
        };

        // Update map
        if (map.getSource('contours-source')) {
            map.getSource('contours-source').setData(geojson);
        }

        // Cache result (limit cache size)
        if (state.contoursCache.size > 20) {
            const firstKey = state.contoursCache.keys().next().value;
            state.contoursCache.delete(firstKey);
        }
        state.contoursCache.set(cacheKey, geojson);

    } catch (error) {
        console.error('Failed to generate contours:', error);
    } finally {
        state.isGeneratingContours = false;
        document.getElementById('contours-loading')?.classList.remove('active');
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

        // Add bathymetry layer
        await addBathymetryLayer();

        // Add empty contours source (will be populated dynamically)
        map.addSource('contours-source', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });

        // Add contour line layer
        map.addLayer({
            id: 'contours-layer',
            type: 'line',
            source: 'contours-source',
            paint: {
                'line-color': CONFIG.CONTOUR_COLOR,
                'line-width': [
                    'case',
                    ['==', ['%', ['get', 'ELEV'], 10], 0],
                    2,
                    1
                ],
                'line-opacity': 0.6
            },
            layout: {
                visibility: state.layerVisibility.contours ? 'visible' : 'none'
            },
            minzoom: Math.min(...Object.keys(CONFIG.CONTOUR_INTERVALS).map(Number)),
        }, 'dive-trails-layer');

        // Add contour labels layer
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
                'symbol-spacing': 50,
                'text-rotation-alignment': 'map',
                'text-pitch-alignment': 'viewport',
                'text-max-angle': 30,
                'text-padding': 10,
                visibility: state.layerVisibility.contours ? 'visible' : 'none'
            },
            minzoom: Math.min(...Object.keys(CONFIG.CONTOUR_INTERVALS).map(Number)),
        }, 'dive-trails-layer');

        // Initialize client-side contour generation
        await initializeContourGeneration();

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
            } else if (layerId === 'bathymetry') {
                // Check if layer exists before updating
                if (map.getLayer(`bathymetry-layer`)) {
                    map.setLayoutProperty(`bathymetry-layer`, 'visibility', visibility);
                }
                if (map.getLayer(`hillshade-layer`)) {
                    map.setLayoutProperty(`hillshade-layer`, 'visibility', visibility);
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

/**
 * Get elevation at a specific geographic coordinate from the GeoTIFF
 * @param {number} lng - Longitude
 * @param {number} lat - Latitude
 * @returns {Promise<number|null>} Elevation in meters, or null if unavailable
 */
async function getElevationAtPoint(lng, lat) {
    if (!state.geoTiffImage) return null;

    try {
        const imageBbox = state.geoTiffImage.getBoundingBox();
        const imageWidth = state.geoTiffImage.getWidth();
        const imageHeight = state.geoTiffImage.getHeight();

        // Convert WGS84 to Web Mercator
        const x = (lng * 20037508.34) / 180;
        let y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180);
        y = (y * 20037508.34) / 180;

        // Check if point is within GeoTIFF bounds
        if (x < imageBbox[0] || x > imageBbox[2] || y < imageBbox[1] || y > imageBbox[3]) {
            return null;
        }

        // Convert Web Mercator to pixel coordinates
        const pixelX = Math.floor(((x - imageBbox[0]) / (imageBbox[2] - imageBbox[0])) * imageWidth);
        const pixelY = Math.floor(((imageBbox[3] - y) / (imageBbox[3] - imageBbox[1])) * imageHeight);

        // Clamp to image bounds
        const clampedX = Math.max(0, Math.min(imageWidth - 1, pixelX));
        const clampedY = Math.max(0, Math.min(imageHeight - 1, pixelY));

        // Read a small 3x3 window around the point for averaging
        const windowSize = 3;
        const halfWindow = Math.floor(windowSize / 2);
        const windowLeft = Math.max(0, clampedX - halfWindow);
        const windowTop = Math.max(0, clampedY - halfWindow);
        const windowRight = Math.min(imageWidth, clampedX + halfWindow + 1);
        const windowBottom = Math.min(imageHeight, clampedY + halfWindow + 1);

        const data = await state.geoTiffImage.readRasters({
            window: [windowLeft, windowTop, windowRight, windowBottom],
            width: windowRight - windowLeft,
            height: windowBottom - windowTop,
            resampleMethod: 'linear'
        });

        const values = data[0];

        // Average valid values (exclude NoData)
        let sum = 0;
        let count = 0;
        for (let i = 0; i < values.length; i++) {
            const val = values[i];
            if (val !== -9999 && val < 1e5) {
                sum += val;
                count++;
            }
        }

        if (count === 0) return null;
        return sum / count;

    } catch (error) {
        console.warn('Failed to get elevation at point:', error);
        return null;
    }
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

async function addMeasurePoint(lngLat, type = 'custom', segmentData = null) {
    const measurePanel = document.getElementById('measure-panel');
    const measureTotal = document.getElementById('measure-total');
    const measureItems = document.getElementById('measure-items');

    let distance = 0;
    let displayName = '';
    let color = '#0891b2';
    let elevation = null;

    if (type === 'segment' && segmentData) {
        // Adding a trail segment
        distance = segmentData.properties.distance;
        displayName = `${segmentData.properties.trailName.replace(' Dive Trail', '').replace(' Drive Trail', '')} ${segmentData.properties.startMarker}→${segmentData.properties.endMarker}`;
        color = CONFIG.TRAIL_COLORS[segmentData.properties.trailName] || '#888888';

        // Get elevation at start of segment
        const segmentCoords = segmentData.geometry.coordinates;
        elevation = await getElevationAtPoint(segmentCoords[0][0], segmentCoords[0][1]);

        state.measurePoints.push({
            type: 'segment',
            segmentData: segmentData,
            distance: distance,
            elevation: elevation
        });

    } else {
        // Adding a custom point
        // Get elevation at this point
        elevation = await getElevationAtPoint(lngLat.lng, lngLat.lat);

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
            distance: distance,
            elevation: elevation
        });
    }

    state.totalDistance += distance;

    // Update UI
    measurePanel.style.display = 'block';
    measureTotal.textContent = formatDistance(state.totalDistance);

    // Format depth display
    let depthDisplay = '';
    if (elevation !== null) {
        const depthValue = Math.abs(elevation);
        depthDisplay = `<span class="measure-item-depth">${depthValue.toFixed(1)}m</span>`;
    }

    // Add item to list
    const itemEl = document.createElement('div');
    itemEl.className = 'measure-item';
    itemEl.innerHTML = `
        <span class="measure-item-name">
            <span class="measure-item-dot" style="background: ${color};"></span>
            ${displayName}
        </span>
        <span class="measure-item-info">
            <span class="measure-item-distance">${formatDistance(distance)}</span>
            ${depthDisplay}
        </span>
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
