/**
 * Day 6 - Ancient Australian Coastlines
 * Sea Level Visualization Tool
 * 
 * Optimized for: no-flicker updates, always-interactive, fast preview
 */

// ============================================
// Constants & Configuration
// ============================================

const CONFIG = {
    // Clipped to Australia extent, Web Mercator projection, +10m to -150m range
    COG_URL: 'bathytopo_aus.tif',
    PREVIEW_URL: 'bathytopo_preview.tif',
    CURVE_URL: window.PAGE_CONFIG?.curveUrl || 'curve_grant2012.csv',
    ENVIRO_BLEND_URL: window.PAGE_CONFIG?.enviroBlendUrl || 'enviroblend.jpg',

    // Data encoding: pixel = (depth + 150) * 255 / 160
    // Decode: depth = (pixel * 160 / 255) - 150
    DEPTH_MIN: -150,
    DEPTH_MAX: 10,

    // Beach blend width in meters
    BEACH_BLEND_WIDTH: 3,

    // Bounds in WGS84 (from clipped file)
    BOUNDS: {
        west: 110.346,
        south: -44.22,
        east: 159.03,
        north: -8.0
    },

    // Hillshade parameters
    SUN_AZIMUTH: 315,
    SUN_ALTITUDE: 45,
    EXAGGERATION: 200,
    HILLSHADE_MIN_DEPTH: -130,

    // Ocean color palette (extended to -150m)
    OCEAN_COLORS: [
        { depth: 0, color: [100, 180, 220, 180] },
        { depth: -20, color: [60, 140, 190, 200] },
        { depth: -50, color: [40, 100, 160, 210] },
        { depth: -80, color: [25, 70, 120, 220] },
        { depth: -130, color: [15, 40, 80, 230] },
        { depth: -150, color: [10, 30, 60, 240] }
    ],

    // Beach color
    BEACH_COLOR: [210, 190, 140, 220],

    // Ancient land colors (exposed seafloor, extended to -150m)
    LAND_COLORS: [
        { depth: 10, color: [200, 180, 150, 180] },
        { depth: 0, color: [180, 160, 130, 200] },
        { depth: -20, color: [160, 140, 110, 210] },
        { depth: -50, color: [140, 120, 90, 220] },
        { depth: -80, color: [120, 100, 75, 225] },
        { depth: -130, color: [100, 85, 65, 230] },
        { depth: -150, color: [90, 75, 60, 235] }
    ],

    ENVIRO_BLEND_STRENGTH: .6,

    ANIMATION_SPEED: 50,
};

// ============================================
// State Management
// ============================================

const state = {
    tiff: null,
    image: null,
    rasterData: null,
    rasterWidth: 0,
    rasterHeight: 0,
    bounds: null,

    // Persistent canvases (no recreating)
    hillshadeCanvas: null,
    seaCanvas: null,

    // Single deck.gl overlay (no remove/add)
    deckOverlay: null,

    // Precomputed hillshade values
    hillshadeValues: null,

    // Current hillshade image URL (cached)
    hillshadeImageUrl: null,

    // Enviro blend image (for land tinting)
    enviroBlendImage: null,
    enviroBlendData: null,
    enviroBlendWidth: 0,
    enviroBlendHeight: 0,

    // Sea level curve data
    curveData: [],

    // Current values
    currentSeaLevel: 0,
    currentAge: 0,

    // Loading state
    isLoading: true,
    isFullResLoaded: false,
    isFullResLoading: false,
    introHasPlayed: false,

    // Animation
    isPlaying: false,
    playDirection: -1,  // -1 = move towards Now (decreasing age, moving right)
    animationTimer: null,

    // Measurement
    isMeasuring: false,
    measurePoints: [],
    measureMarkers: [],
    measurePreview: null,

    // Chart
    chart: null,

    // Render scheduling
    pendingRender: null,
    seaRenderToken: 0,
    rasterToken: 0,
    fullResPromise: null
};

// ============================================
// Map Initialization
// ============================================

const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        sources: {
            'esri-satellite': {
                type: 'raster',
                tiles: [
                    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
                ],
                tileSize: 256,
                maxzoom: 7,
                attribution: '© Esri, Maxar, Earthstar Geographics'
            }
        },
        layers: [{
            id: 'satellite',
            type: 'raster',
            source: 'esri-satellite'
        }]
    },
    center: [134, -28],
    minZoom: 1,  // Allow zooming out much further
    maxZoom: 7,
    maxPitch: 0,
    dragRotate: false,
    attributionControl: false
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

// ============================================
// Initialization
// ============================================

map.on('load', async () => {
    // Fit map to data bounds immediately
    const initialBounds = getInitialFitBounds();
    map.fitBounds([
        [initialBounds.west, initialBounds.south], // Southwest
        [initialBounds.east, initialBounds.north]  // Northeast
    ], {
        padding: 20,
        duration: 0  // Instant, no animation
    });

    // Setup UI immediately (map is always interactive)
    setupSliders();
    setupMeasureTool();
    setupAnimation();

    // Initialize single deck.gl overlay (never removed)
    // Keep interleaved false so deck layers (including measure lines) render on top
    state.deckOverlay = new deck.MapboxOverlay({
        layers: [],
        interleaved: false
    });
    map.addControl(state.deckOverlay);

    try {
        // Show initial loading state
        showProgress('Loading curve data...', 10);
        await new Promise(resolve => setTimeout(resolve, 0)); // Yield to UI

        // Load curve data (small, fast)
        await loadSeaLevelCurve();

        showProgress('Initializing chart...', 30);
        await new Promise(resolve => setTimeout(resolve, 0)); // Yield to UI

        // Initialize chart AFTER curve data loads (prevents squashed Y-axis)
        initializeChart();

        showProgress('Loading preview...', 50);
        await new Promise(resolve => setTimeout(resolve, 0)); // Yield to UI

        // Load preview first (469KB - instant)
        await loadPreview();

        // Initial render with preview data
        scheduleRender();

        // Load full resolution before showing the explore button
        await loadFullResolution();

        if (state.rasterData) {
            showProgress('Ready', 100);
        } else {
            showProgress('Failed to load', 0);
        }

    } catch (error) {
        console.error('Initialization failed:', error);
        showProgress('Failed to load', 0);
    }
});

// ============================================
// Loading Functions
// ============================================

function showProgress(text, percent) {
    const el = document.getElementById('loading-text');
    if (el) {
        el.textContent = percent > 0 && percent < 100 ? `${text} (${Math.round(percent)}%)` : text;
    }

    if (percent >= 100 || text === 'Ready') {
        // Hide loading indicator, show buttons
        const buttonsLoading = document.getElementById('buttons-loading');
        const welcomeButtons = document.getElementById('welcome-buttons');

        if (buttonsLoading) buttonsLoading.classList.add('hidden');
        if (welcomeButtons) welcomeButtons.classList.remove('hidden');

        state.isLoading = false;

        // Setup button handlers
        setupWelcomeButtons();
    }
}

function getInitialFitBounds() {
    if (window.innerWidth < 768) {
        const width = CONFIG.BOUNDS.east - CONFIG.BOUNDS.west;
        const height = CONFIG.BOUNDS.north - CONFIG.BOUNDS.south;
        return {
            west: CONFIG.BOUNDS.west,
            south: CONFIG.BOUNDS.south + (height * 0.25),
            east: CONFIG.BOUNDS.west + (width / 3),
            north: CONFIG.BOUNDS.north
        };
    }
    return CONFIG.BOUNDS;
}

function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function runExploreIntro() {
    if (state.introHasPlayed) return;
    state.introHasPlayed = true;

    if (state.isPlaying) stopAnimation();

    const startAge = 0;
    const targetAge = 22;
    const duration = 800;
    const startTime = performance.now();

    updateAge(startAge);

    const step = (now) => {
        const t = Math.min(1, (now - startTime) / duration);
        const eased = easeInOutCubic(t);
        const age = startAge + (targetAge - startAge) * eased;
        updateAge(age);

        if (t < 1) {
            requestAnimationFrame(step);
        }
    };

    requestAnimationFrame(step);
}

function queueHillshadeCompute(rasterToken) {
    const token = rasterToken;
    const start = () => {
        if (token !== state.rasterToken) return;
        const data = state.rasterData;
        if (!data || !state.rasterWidth || !state.rasterHeight) return;

        computeHillshade(data, state.rasterWidth, state.rasterHeight, {
            chunkRows: 16,
            shouldCancel: () => token !== state.rasterToken
        }).then((values) => {
            if (!values || token !== state.rasterToken) return;
            state.hillshadeValues = values;
            renderHillshadeToCanvas(token);
        });
    };

    if ('requestIdleCallback' in window) {
        requestIdleCallback(() => start(), { timeout: 1200 });
    } else {
        setTimeout(start, 100);
    }
}

function setupWelcomeButtons() {
    const exploreBtn = document.getElementById('explore-btn');
    const guideMeBtn = document.getElementById('guide-me-btn');
    const welcomeScreen = document.getElementById('welcome-screen');

    if (exploreBtn) {
        exploreBtn.addEventListener('click', () => {
            welcomeScreen.classList.add('hidden');
            runExploreIntro();
        });
    }

    if (guideMeBtn) {
        guideMeBtn.addEventListener('click', () => {
            // TODO: Wire up "Guide Me" tour
            welcomeScreen.classList.add('hidden');
            console.log('Guide Me clicked - will implement guided tour');
        });
    }
}

async function loadSeaLevelCurve() {
    const response = await fetch(CONFIG.CURVE_URL);
    const text = await response.text();
    state.curveData = text.trim().split('\n').slice(1).map(line => {
        const [age, seaLevel] = line.split(',').map(Number);
        return { age, seaLevel };
    }).filter(d => !isNaN(d.age) && !isNaN(d.seaLevel));
    console.log(`Loaded ${state.curveData.length} curve data points`);
}

async function loadEnviroBlendImage() {
    if (state.enviroBlendImage) return;

    try {
        const img = new Image();
        img.src = CONFIG.ENVIRO_BLEND_URL;
        await img.decode();
        state.enviroBlendImage = img;
    } catch (e) {
        console.warn('Enviro blend image load failed:', e.message);
    }
}

function updateEnviroBlendData(targetWidth, targetHeight) {
    if (!state.enviroBlendImage) return;
    if (state.enviroBlendData &&
        state.enviroBlendWidth === targetWidth &&
        state.enviroBlendHeight === targetHeight) {
        return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(state.enviroBlendImage, 0, 0, targetWidth, targetHeight);
    const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
    state.enviroBlendData = imageData.data;
    state.enviroBlendWidth = targetWidth;
    state.enviroBlendHeight = targetHeight;
}

async function prepareEnviroBlend(targetWidth, targetHeight, rasterToken = state.rasterToken) {
    const token = rasterToken;
    await loadEnviroBlendImage();
    if (token !== state.rasterToken) return;
    updateEnviroBlendData(targetWidth, targetHeight);
    if (state.enviroBlendData) scheduleRender();
}

async function loadPreview() {
    try {
        showProgress('Downloading preview...', 60);
        const response = await fetch(CONFIG.PREVIEW_URL);
        if (!response.ok) throw new Error('Preview fetch failed');

        showProgress('Processing data...', 70);
        await new Promise(resolve => setTimeout(resolve, 0)); // Yield to UI

        const buffer = await response.arrayBuffer();
        const previewTiff = await GeoTIFF.fromArrayBuffer(buffer);
        const previewImage = await previewTiff.getImage();
        const width = previewImage.getWidth();
        const height = previewImage.getHeight();

        const rasters = await previewImage.readRasters();

        showProgress('Converting elevation data...', 80);
        await new Promise(resolve => setTimeout(resolve, 0)); // Yield to UI

        // Convert to depth values using new encoding: (pixel * 160 / 255) - 150
        // Process in chunks to avoid blocking
        const data = new Float32Array(rasters[0].length);
        const chunkSize = 50000; // Process 50k pixels at a time
        for (let start = 0; start < rasters[0].length; start += chunkSize) {
            const end = Math.min(start + chunkSize, rasters[0].length);
            for (let i = start; i < end; i++) {
                const pixel = rasters[0][i];
                data[i] = pixel === 0 ? NaN : (pixel * 160 / 255) - 150;
            }
            if (start + chunkSize < rasters[0].length) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        state.rasterData = data;
        state.rasterWidth = width;
        state.rasterHeight = height;
        state.bounds = CONFIG.BOUNDS;

        state.rasterToken += 1;
        const rasterToken = state.rasterToken;
        state.hillshadeValues = null;
        state.hillshadeBitmap = null;
        state.hillshadeImageUrl = null;

        prepareEnviroBlend(width, height, rasterToken);

        // Create persistent canvases
        state.hillshadeCanvas = document.createElement('canvas');
        state.hillshadeCanvas.width = width;
        state.hillshadeCanvas.height = height;

        state.seaCanvas = document.createElement('canvas');
        state.seaCanvas.width = width;
        state.seaCanvas.height = height;

        showProgress('Finalizing...', 90);
        await new Promise(resolve => setTimeout(resolve, 0)); // Yield to UI

        // Initial render to display data
        scheduleRender();

        console.log('Preview loaded:', width, 'x', height);

    } catch (e) {
        console.warn('Preview load failed:', e.message);
        await loadFullResolution();
    }
}

async function loadFullResolution() {
    if (state.isFullResLoaded) return;
    if (state.isFullResLoading && state.fullResPromise) return state.fullResPromise;

    state.isFullResLoading = true;
    state.fullResPromise = (async () => {
        showProgress('Loading full detail...', 60);

        try {
            // Use fetch for better browser compatibility
            const response = await fetch(CONFIG.COG_URL);
            if (!response.ok) throw new Error('Full file fetch failed');
            const buffer = await response.arrayBuffer();
            state.tiff = await GeoTIFF.fromArrayBuffer(buffer);
            state.image = await state.tiff.getImage();

            const width = state.image.getWidth();
            const height = state.image.getHeight();

            // Load at reasonable resolution
            const maxDim = 2048;
            const scale = Math.min(1, maxDim / Math.max(width, height));
            const targetWidth = Math.round(width * scale);
            const targetHeight = Math.round(height * scale);

            showProgress('Processing...', 80);

            const rasters = await state.image.readRasters({
                width: targetWidth,
                height: targetHeight,
                resampleMethod: 'bilinear'
            });

            // Convert to depth using new encoding
            // Process in chunks to avoid blocking
            const data = new Float32Array(rasters[0].length);
            const chunkSize = 50000; // Process 50k pixels at a time
            for (let start = 0; start < rasters[0].length; start += chunkSize) {
                const end = Math.min(start + chunkSize, rasters[0].length);
                for (let i = start; i < end; i++) {
                    const pixel = rasters[0][i];
                    data[i] = pixel === 0 ? NaN : (pixel * 160 / 255) - 150;
                }
                if (start + chunkSize < rasters[0].length) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }

            // Update state
            state.rasterData = data;
            state.rasterWidth = targetWidth;
            state.rasterHeight = targetHeight;

            state.rasterToken += 1;
            const rasterToken = state.rasterToken;

            prepareEnviroBlend(targetWidth, targetHeight, rasterToken);

            // Recreate canvases at new size
            state.hillshadeCanvas = document.createElement('canvas');
            state.hillshadeCanvas.width = targetWidth;
            state.hillshadeCanvas.height = targetHeight;

            state.seaCanvas = document.createElement('canvas');
            state.seaCanvas.width = targetWidth;
            state.seaCanvas.height = targetHeight;

            state.hillshadeValues = null;
            state.hillshadeBitmap = null;
            state.hillshadeImageUrl = null; // Force re-render

            // Re-render with full data first
            scheduleRender();

            // Recompute hillshade in the background
            queueHillshadeCompute(rasterToken);

            state.isFullResLoaded = true;
        } catch (e) {
            console.error('Full resolution load failed:', e);
        } finally {
            state.isFullResLoading = false;
            state.fullResPromise = null;
        }
    })();

    return state.fullResPromise;
}

// ============================================
// Rendering (Optimized - No Flicker)
// ============================================

let lastRenderTime = 0;
const MIN_RENDER_INTERVAL = 50;  // ms between renders

function scheduleRender() {
    // Debounce renders to avoid excessive updates
    if (state.pendingRender) return;

    const now = performance.now();
    const timeSinceLastRender = now - lastRenderTime;
    const delay = Math.max(0, MIN_RENDER_INTERVAL - timeSinceLastRender);

    state.pendingRender = setTimeout(() => {
        state.pendingRender = null;
        lastRenderTime = performance.now();
        renderFrame();
    }, delay);
}

function renderFrame() {
    if (!state.rasterData) return;

    const renderToken = ++state.seaRenderToken;
    renderSeaLevelToCanvas(state.currentSeaLevel);

    // Use createImageBitmap for better performance (async)
    createImageBitmap(state.seaCanvas).then(bitmap => {
        if (renderToken !== state.seaRenderToken) {
            if (bitmap.close) bitmap.close();
            return;
        }
        state.seaBitmap = bitmap;
        updateDeckLayers();
    });
}

async function renderHillshadeToCanvas(rasterToken = state.rasterToken) {
    const token = rasterToken;
    const { hillshadeCanvas, hillshadeValues, rasterData, rasterWidth, rasterHeight } = state;
    if (!hillshadeCanvas || !hillshadeValues) return;

    const ctx = hillshadeCanvas.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.createImageData(rasterWidth, rasterHeight);

    // Process in chunks to avoid blocking UI
    const totalPixels = rasterWidth * rasterHeight;
    const chunkSize = 20000; // Process 20k pixels at a time

    for (let start = 0; start < totalPixels; start += chunkSize) {
        if (token !== state.rasterToken) return;
        const end = Math.min(start + chunkSize, totalPixels);

        for (let i = start; i < end; i++) {
            const px = i * 4;
            const depth = rasterData[i];

            if (isNaN(depth) || depth < CONFIG.HILLSHADE_MIN_DEPTH) {
                imageData.data[px + 3] = 0;
                continue;
            }

            const shade = hillshadeValues[i];
            // Stronger hillshade effect
            if (shade < 0.5) {
                // Shadow (darker)
                imageData.data[px] = 0;
                imageData.data[px + 1] = 0;
                imageData.data[px + 2] = 0;
                imageData.data[px + 3] = Math.round((0.5 - shade) * 220);
            } else {
                // Highlight (lighter)
                imageData.data[px] = 255;
                imageData.data[px + 1] = 255;
                imageData.data[px + 2] = 255;
                imageData.data[px + 3] = Math.round((shade - 0.5) * 150);
            }
        }

        // Yield to UI after each chunk
        if (end < totalPixels) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    if (token !== state.rasterToken) return;
    ctx.putImageData(imageData, 0, 0);

    // Use createImageBitmap for better performance
    createImageBitmap(hillshadeCanvas).then(bitmap => {
        if (token !== state.rasterToken) {
            if (bitmap.close) bitmap.close();
            return;
        }
        state.hillshadeBitmap = bitmap;
        console.log('Hillshade created');
    });
}

function renderSeaLevelToCanvas(seaLevel) {
    const { seaCanvas, rasterData, rasterWidth, rasterHeight } = state;
    if (!seaCanvas || !rasterData) return;

    const ctx = seaCanvas.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.createImageData(rasterWidth, rasterHeight);
    const enviroBlendData = state.enviroBlendData;
    const hasEnviroBlend = !!enviroBlendData &&
        state.enviroBlendWidth === rasterWidth &&
        state.enviroBlendHeight === rasterHeight;
    const enviroBlendStrength = CONFIG.ENVIRO_BLEND_STRENGTH;

    // Round sea level to avoid flickering from floating point precision issues
    seaLevel = Math.round(seaLevel * 2) / 2;  // Round to nearest 0.5m

    const beachBlendWidth = CONFIG.BEACH_BLEND_WIDTH;
    const [beachR, beachG, beachB, beachA] = CONFIG.BEACH_COLOR;

    for (let i = 0; i < rasterWidth * rasterHeight; i++) {
        const px = i * 4;
        const depth = rasterData[i];

        if (isNaN(depth)) {
            imageData.data[px + 3] = 0;
            continue;
        }

        let baseR = 0;
        let baseG = 0;
        let baseB = 0;
        let baseA = 0;

        if (depth > seaLevel) {
            // Above current sea level = ancient exposed land
            if (depth <= CONFIG.DEPTH_MAX) {
                const color = getLandColor(depth);
                if (hasEnviroBlend) {
                    const blend = enviroBlendStrength;
                    baseR = Math.round(color[0] * (1 - blend) + enviroBlendData[px] * blend);
                    baseG = Math.round(color[1] * (1 - blend) + enviroBlendData[px + 1] * blend);
                    baseB = Math.round(color[2] * (1 - blend) + enviroBlendData[px + 2] * blend);
                    baseA = color[3];
                } else {
                    baseR = color[0];
                    baseG = color[1];
                    baseB = color[2];
                    baseA = color[3];
                }
            }
        } else {
            // Ocean
            if (seaLevel >= 0 && depth < 0) {
                // When sea level is above present (0m), depths below 0 are dry land - make transparent
                baseA = 0;
            } else if (seaLevel < 0) {
                // Sea level dropped below present, ocean is transparent to show exposed land
                baseA = 0;
            } else {
                // Show ocean color for depths between 0 and sea level
                const color = getOceanColor(depth - seaLevel);
                baseR = color[0];
                baseG = color[1];
                baseB = color[2];
                baseA = color[3];
            }
        }

        let outR = baseR;
        let outG = baseG;
        let outB = baseB;
        let outA = baseA;

        const distance = Math.abs(depth - seaLevel);
        if (distance <= beachBlendWidth) {
            const blend = 1 - smoothstep(0, beachBlendWidth, distance);
            outR = Math.round(baseR * (1 - blend) + beachR * blend);
            outG = Math.round(baseG * (1 - blend) + beachG * blend);
            outB = Math.round(baseB * (1 - blend) + beachB * blend);
            outA = Math.round(baseA * (1 - blend) + beachA * blend);
        }

        imageData.data[px] = outR;
        imageData.data[px + 1] = outG;
        imageData.data[px + 2] = outB;
        imageData.data[px + 3] = outA;
    }

    ctx.putImageData(imageData, 0, 0);

}

function updateDeckLayers() {
    if (!state.deckOverlay || !state.bounds) return;

    const { bounds, seaBitmap, hillshadeBitmap } = state;
    const boundsArray = [bounds.west, bounds.south, bounds.east, bounds.north];

    const layers = [];

    // Sea level layer (below hillshade)
    if (seaBitmap) {
        layers.push(new deck.BitmapLayer({
            id: 'sea-level',
            bounds: boundsArray,
            image: seaBitmap,
            opacity: 0.98
        }));
    }

    // Hillshade layer (on top)
    if (hillshadeBitmap) {
        layers.push(new deck.BitmapLayer({
            id: 'hillshade',
            bounds: boundsArray,
            image: hillshadeBitmap,
            opacity: 0.98
        }));
    }

    const measureLineData = state.measurePoints.length >= 2
        ? [{ path: state.measurePoints }]
        : [];
    layers.push(new deck.PathLayer({
        id: 'measure-line',
        data: measureLineData,
        getPath: (d) => d.path,
        getColor: [255, 255, 255, 230],
        widthUnits: 'pixels',
        getWidth: 3,
        pickable: false,
        capRounded: true,
        jointRounded: true
    }));

    const measurePreviewData = state.measurePreview
        ? [{ path: state.measurePreview }]
        : [];
    layers.push(new deck.PathLayer({
        id: 'measure-preview',
        data: measurePreviewData,
        getPath: (d) => d.path,
        getColor: [255, 255, 255, 160],
        widthUnits: 'pixels',
        getWidth: 2,
        pickable: false,
        capRounded: true,
        jointRounded: true
    }));

    // Update layers in place (no flicker!)
    state.deckOverlay.setProps({ layers });
}

// ============================================
// Color Functions
// ============================================

function smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

function getOceanColor(relativeDepth) {
    const stops = CONFIG.OCEAN_COLORS;
    for (let i = 0; i < stops.length - 1; i++) {
        if (relativeDepth >= stops[i + 1].depth) {
            const t = (relativeDepth - stops[i].depth) / (stops[i + 1].depth - stops[i].depth);
            const c1 = stops[i].color, c2 = stops[i + 1].color;
            return [
                Math.round(c1[0] + t * (c2[0] - c1[0])),
                Math.round(c1[1] + t * (c2[1] - c1[1])),
                Math.round(c1[2] + t * (c2[2] - c1[2])),
                Math.round(c1[3] + t * (c2[3] - c1[3]))
            ];
        }
    }
    return stops[stops.length - 1].color;
}

function getLandColor(depth) {
    const stops = CONFIG.LAND_COLORS;
    const darken = 0.9;
    for (let i = 0; i < stops.length - 1; i++) {
        if (depth >= stops[i + 1].depth) {
            const t = (depth - stops[i].depth) / (stops[i + 1].depth - stops[i].depth);
            const c1 = stops[i].color, c2 = stops[i + 1].color;
            return [
                Math.round((c1[0] + t * (c2[0] - c1[0])) * darken),
                Math.round((c1[1] + t * (c2[1] - c1[1])) * darken),
                Math.round((c1[2] + t * (c2[2] - c1[2])) * darken),
                Math.round(c1[3] + t * (c2[3] - c1[3]))
            ];
        }
    }
    const last = stops[stops.length - 1].color;
    return [
        Math.round(last[0] * darken),
        Math.round(last[1] * darken),
        Math.round(last[2] * darken),
        last[3]
    ];
}

async function computeHillshade(data, width, height, options = {}) {
    const hillshade = new Float32Array(width * height);
    const azimuthRad = CONFIG.SUN_AZIMUTH * Math.PI / 180;
    const altitudeRad = CONFIG.SUN_ALTITUDE * Math.PI / 180;
    const sunX = Math.sin(azimuthRad) * Math.cos(altitudeRad);
    const sunY = Math.cos(azimuthRad) * Math.cos(altitudeRad);
    const sunZ = Math.sin(altitudeRad);

    const cellSizeX = (state.bounds?.east - state.bounds?.west || 80) / width * 111000;
    const cellSizeY = (state.bounds?.north - state.bounds?.south || 52) / height * 111000;
    const cellSize = (cellSizeX + cellSizeY) / 2;

    // Process in chunks to avoid blocking the UI
    const chunkSize = options.chunkRows ?? 20; // Process rows in smaller chunks
    for (let startY = 1; startY < height - 1; startY += chunkSize) {
        if (options.shouldCancel?.()) return null;
        const endY = Math.min(startY + chunkSize, height - 1);

        for (let y = startY; y < endY; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = y * width + x;
                const z = data[idx];

                if (isNaN(z)) {
                    hillshade[idx] = 0.5;
                    continue;
                }

                const zL = data[idx - 1] || z;
                const zR = data[idx + 1] || z;
                const zU = data[(y - 1) * width + x] || z;
                const zD = data[(y + 1) * width + x] || z;

                if (isNaN(zL) || isNaN(zR) || isNaN(zU) || isNaN(zD)) {
                    hillshade[idx] = 0.5;
                    continue;
                }

                const dzdx = ((zR - zL) * CONFIG.EXAGGERATION) / (2 * cellSize);
                const dzdy = ((zD - zU) * CONFIG.EXAGGERATION) / (2 * cellSize);
                const shade = ((-dzdx * sunX - dzdy * sunY + sunZ) / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1));
                hillshade[idx] = Math.max(0, Math.min(1, shade * 0.5 + 0.5));
            }
        }

        // Yield to UI every chunk
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    return hillshade;
}

// ============================================
// Sea Level Updates
// ============================================

function updateSeaLevel(seaLevel) {
    // Clamp to valid range
    seaLevel = Math.max(-130, Math.min(20, seaLevel));

    state.currentSeaLevel = seaLevel;
    document.getElementById('level-value').textContent = seaLevel.toFixed(0);
    const seaLevelSlider = document.getElementById('sea-level-slider');
    if (seaLevelSlider) seaLevelSlider.value = seaLevel;

    // Only update input if user is not currently typing in it
    const seaLevelInput = document.getElementById('sea-level-input');
    if (seaLevelInput && document.activeElement !== seaLevelInput) {
        seaLevelInput.value = seaLevel.toFixed(0);
    }

    updateChartHighlight(state.currentAge, seaLevel);
    scheduleRender();
}

function updateAge(age) {
    // Clamp to valid range
    age = Math.max(0, Math.min(150, age));

    state.currentAge = age;
    const seaLevel = interpolateSeaLevel(age);
    state.currentSeaLevel = seaLevel;

    document.getElementById('age-value').textContent = age.toFixed(1);
    document.getElementById('level-value').textContent = seaLevel.toFixed(0);
    const ageSlider = document.getElementById('age-slider');
    if (ageSlider) ageSlider.value = age;

    // Only update input if user is not currently typing in it
    const ageInput = document.getElementById('age-input');
    if (ageInput && document.activeElement !== ageInput) {
        ageInput.value = age.toFixed(1);
    }

    const seaLevelSlider = document.getElementById('sea-level-slider');
    if (seaLevelSlider) seaLevelSlider.value = seaLevel;

    // Only update input if user is not currently typing in it
    const seaLevelInput = document.getElementById('sea-level-input');
    if (seaLevelInput && document.activeElement !== seaLevelInput) {
        seaLevelInput.value = seaLevel.toFixed(0);
    }

    updateChartHighlight(age, seaLevel);
    scheduleRender();
}

function interpolateSeaLevel(age) {
    const data = state.curveData;
    if (data.length === 0) return 0;

    for (let i = 0; i < data.length - 1; i++) {
        if (age >= data[i].age && age <= data[i + 1].age) {
            const t = (age - data[i].age) / (data[i + 1].age - data[i].age);
            return data[i].seaLevel + t * (data[i + 1].seaLevel - data[i].seaLevel);
        }
    }

    if (age <= data[0].age) return data[0].seaLevel;
    return data[data.length - 1].seaLevel;
}

// ============================================
// Chart
// ============================================

function initializeChart() {
    const ctx = document.getElementById('sea-level-chart').getContext('2d');
    const chartData = state.curveData; // Use all data points for rendering

    state.chart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: 'Sea Level',
                data: chartData.map(d => ({ x: d.age, y: d.seaLevel })),
                borderColor: '#2563eb',
                backgroundColor: 'rgba(37, 99, 235, 0.1)',
                fill: true,
                tension: 0.3,
                pointRadius: 1.5,    // Show data points
                pointBackgroundColor: '#2563eb',
                pointBorderColor: '#ffffff',
                pointBorderWidth: 0.5,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,  // Disable initial animations to prevent freeze
            interaction: { mode: 'index', intersect: false },
            onClick: handleChartClick,
            layout: {
                padding: 0  // Let Chart.js use natural padding
            },
            scales: {
                x: {
                    type: 'linear',
                    min: 0,
                    max: 150,
                    reverse: true,
                    ticks: {
                        color: 'rgba(0,0,0,0.5)',
                        callback: v => v === 0 ? 'Now' : v + 'ka',
                        padding: 4  // Tighter spacing for X-axis labels
                    },
                    grid: { color: 'rgba(0,0,0,0.08)' }
                },
                y: {
                    position: 'right',
                    min: -130,
                    max: 20,
                    ticks: {
                        stepSize: 20,
                        color: 'rgba(0,0,0,0.5)',
                        callback: v => v + 'm',
                        padding: 4  // Tighter spacing for Y-axis labels
                    },
                    grid: { color: 'rgba(0,0,0,0.08)' }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: { enabled: false },
                annotation: {
                    animations: {
                        numbers: { duration: 0 }  // Instant annotation updates
                    },
                    annotations: {
                        currentLine: {
                            type: 'line',
                            xMin: 0, xMax: 0,
                            borderColor: '#1a1a1a',
                            borderWidth: 2
                        },
                        currentPoint: {
                            type: 'point',
                            xValue: 0,
                            yValue: 0,
                            backgroundColor: '#ffffff',
                            radius: 6,
                            borderColor: '#2563eb',
                            borderWidth: 3
                        }
                    }
                }
            }
        }
    });

    // After chart is created, sync slider padding with chart's plot area
    syncSliderPadding();

    // Setup drag interaction
    setupChartDrag();
}

function syncSliderPadding() {
    if (!state.chart) return;

    // Get the chart's plot area dimensions
    const chartArea = state.chart.chartArea;
    if (!chartArea) return;

    const { left, right, top, bottom } = chartArea;
    const canvas = state.chart.canvas;
    const canvasWidth = canvas.offsetWidth;
    const canvasHeight = canvas.offsetHeight;

    // Calculate padding
    const paddingLeft = left;
    const paddingRight = canvasWidth - right;
    const paddingTop = top;
    const paddingBottom = canvasHeight - bottom;

    // Apply to CSS custom properties
    document.documentElement.style.setProperty('--chart-pad-left', `${paddingLeft}px`);
    document.documentElement.style.setProperty('--chart-pad-right', `${paddingRight}px`);
    document.documentElement.style.setProperty('--chart-pad-top', `${paddingTop}px`);
    document.documentElement.style.setProperty('--chart-pad-bottom', `${paddingBottom}px`);
}

// Chart interaction handlers
function handleChartClick(event, elements, chart) {
    const chartArea = chart.chartArea;
    if (!chartArea) return;

    // Get click position relative to canvas
    const rect = chart.canvas.getBoundingClientRect();
    const x = event.native.clientX - rect.left;
    const y = event.native.clientY - rect.top;

    // Check if click is within plot area
    if (x < chartArea.left || x > chartArea.right || y < chartArea.top || y > chartArea.bottom) {
        return;
    }

    // Convert pixel position to data values
    const xScale = chart.scales.x;
    const yScale = chart.scales.y;
    const age = xScale.getValueForPixel(x);
    const seaLevel = yScale.getValueForPixel(y);

    // Update age (which will update sea level from curve)
    updateAge(Math.max(0, Math.min(150, age)));
}

// Setup drag interaction on chart
function setupChartDrag() {
    if (!state.chart) return;

    const canvas = state.chart.canvas;
    let isDragging = false;

    const handleMove = (e) => {
        if (!isDragging) return;

        const chartArea = state.chart.chartArea;
        if (!chartArea) return;

        const rect = canvas.getBoundingClientRect();
        const clientX = e.clientX ?? e.touches?.[0]?.clientX;
        const clientY = e.clientY ?? e.touches?.[0]?.clientY;

        if (clientX == null || clientY == null) return;

        const x = clientX - rect.left;
        const clampedX = Math.max(chartArea.left, Math.min(chartArea.right, x));

        // Convert to data values
        const xScale = state.chart.scales.x;
        const age = xScale.getValueForPixel(clampedX);

        // Update age
        updateAge(Math.max(0, Math.min(150, age)));
    };

    const handleStart = (e) => {
        const chartArea = state.chart.chartArea;
        if (!chartArea) return;

        const rect = canvas.getBoundingClientRect();
        const clientX = e.clientX ?? e.touches?.[0]?.clientX;
        const clientY = e.clientY ?? e.touches?.[0]?.clientY;
        if (clientX == null || clientY == null) return;

        const x = clientX - rect.left;
        const y = clientY - rect.top;
        if (x < chartArea.left || x > chartArea.right || y < chartArea.top || y > chartArea.bottom) {
            return;
        }

        isDragging = true;
        canvas.style.cursor = 'grabbing';
        handleMove(e); // Update immediately on click
    };

    const handleEnd = () => {
        isDragging = false;
        canvas.style.cursor = '';
    };

    // Mouse events
    canvas.addEventListener('mousedown', handleStart);
    canvas.addEventListener('mousemove', handleMove);
    canvas.addEventListener('mouseup', handleEnd);
    canvas.addEventListener('mouseleave', handleEnd);

    // Touch events for mobile
    canvas.addEventListener('touchstart', handleStart, { passive: true });
    canvas.addEventListener('touchmove', handleMove, { passive: true });
    canvas.addEventListener('touchend', handleEnd, { passive: true });
}

function updateChartHighlight(age, seaLevel) {
    if (!state.chart) return;
    const annotations = state.chart.options.plugins.annotation.annotations;
    annotations.currentLine.xMin = age;
    annotations.currentLine.xMax = age;
    annotations.currentPoint.xValue = age;
    annotations.currentPoint.yValue = seaLevel;
    state.chart.update('none');
}

// ============================================
// Sliders
// ============================================

function setupSliders() {
    const ageSlider = document.getElementById('age-slider');
    const seaLevelSlider = document.getElementById('sea-level-slider');
    const ageInput = document.getElementById('age-input');
    const seaLevelInput = document.getElementById('sea-level-input');
    if (!ageSlider || !seaLevelSlider || !ageInput || !seaLevelInput) return;

    // Age slider -> updates age AND sea level (follows curve)
    ageSlider.addEventListener('input', (e) => {
        updateAge(parseFloat(e.target.value));
    });

    // Age text input -> updates age AND sea level (follows curve)
    ageInput.addEventListener('input', (e) => {
        let value = parseFloat(e.target.value);
        if (isNaN(value)) return;
        // Don't clamp during typing - allow user to enter full number
        // Clamping happens on blur
        updateAge(value);
    });

    ageInput.addEventListener('blur', (e) => {
        // Format to 1 decimal on blur
        let value = parseFloat(e.target.value);
        if (isNaN(value)) value = 0;
        value = Math.max(0, Math.min(150, value));
        e.target.value = value.toFixed(1);
    });

    // Sea level slider -> ONLY updates sea level (doesn't change age)
    seaLevelSlider.addEventListener('input', (e) => {
        const level = parseFloat(e.target.value);
        updateSeaLevel(level);
    });

    // Sea level text input -> ONLY updates sea level (doesn't change age)
    seaLevelInput.addEventListener('input', (e) => {
        let value = parseFloat(e.target.value);
        if (isNaN(value)) return;
        // Don't clamp during typing - allow user to enter full number
        // Clamping happens on blur
        updateSeaLevel(value);
    });

    seaLevelInput.addEventListener('blur', (e) => {
        // Format to 0 decimals on blur
        let value = parseFloat(e.target.value);
        if (isNaN(value)) value = 0;
        value = Math.max(-130, Math.min(20, value));
        e.target.value = value.toFixed(0);
    });
}

// ============================================
// Animation
// ============================================

function setupAnimation() {
    document.getElementById('play-btn').addEventListener('click', () => {
        if (state.isPlaying) stopAnimation();
        else startAnimation();
    });
}

function startAnimation() {
    state.isPlaying = true;
    document.getElementById('play-btn').classList.add('playing');

    state.animationTimer = setInterval(() => {
        let newAge = state.currentAge + (0.2 * state.playDirection);  // playDirection = 1 = forward
        if (newAge > 150) newAge = 0;  // Loop back to present when reaching end
        if (newAge < 0) newAge = 150;
        updateAge(newAge);
    }, CONFIG.ANIMATION_SPEED);
}

function stopAnimation() {
    state.isPlaying = false;
    document.getElementById('play-btn').classList.remove('playing');
    clearInterval(state.animationTimer);
}

// ============================================
// Measurement Tool
// ============================================

function setupMeasureTool() {
    const measureBtn = document.getElementById('measure-btn');

    measureBtn.addEventListener('click', () => {
        state.isMeasuring = !state.isMeasuring;
        measureBtn.classList.toggle('active', state.isMeasuring);
        map.getCanvas().style.cursor = state.isMeasuring ? 'crosshair' : '';
        if (!state.isMeasuring) clearMeasurement();
    });

    document.getElementById('measure-clear').addEventListener('click', clearMeasurement);

    map.on('click', (e) => {
        if (!state.isMeasuring) return;

        const { lng, lat } = e.lngLat;

        // Click 1: Start new measurement (clear any previous)
        if (state.measurePoints.length === 0) {
            state.measurePoints.push([lng, lat]);
            // Preview line will start tracking on mousemove
        }
        // Click 2: Complete the measurement
        else if (state.measurePoints.length === 1) {
            state.measurePoints.push([lng, lat]);
            state.measurePreview = null;
            updateMeasurementLine();
            updateMeasurementDisplay();
            // Preview stops tracking (handled in mousemove)
        }
        // Click 3: Start fresh measurement (clear previous, add new first point)
        else if (state.measurePoints.length === 2) {
            state.measurePoints = [[lng, lat]];
            state.measurePreview = null;
            updateDeckLayers();
            document.getElementById('measure-display').classList.add('hidden');
            // Preview line will start tracking on mousemove
        }
    });

    // Mouse move handler for preview line
    map.on('mousemove', (e) => {
        // Only show preview when measuring and have exactly 1 point (tracking active)
        if (!state.isMeasuring || state.measurePoints.length !== 1) {
            if (state.measurePreview) {
                state.measurePreview = null;
                updateDeckLayers();
            }
            return;
        }

        const { lng, lat } = e.lngLat;
        const firstPoint = state.measurePoints[0];
        state.measurePreview = [firstPoint, [lng, lat]];
        updateDeckLayers();
    });
}

function clearMeasurement() {
    state.measurePoints = [];
    state.measurePreview = null;
    updateDeckLayers();

    document.getElementById('measure-display').classList.add('hidden');
}

function updateMeasurementLine() {
    // Update deck.gl layers to include measure line on top
    updateDeckLayers();
}

function updateMeasurementDisplay() {
    let totalDistance = 0;
    for (let i = 1; i < state.measurePoints.length; i++) {
        totalDistance += haversineDistance(state.measurePoints[i - 1], state.measurePoints[i]);
    }
    document.getElementById('measure-value').textContent = totalDistance.toFixed(1);
    document.getElementById('measure-display').classList.remove('hidden');
}

function haversineDistance([lon1, lat1], [lon2, lat2]) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
