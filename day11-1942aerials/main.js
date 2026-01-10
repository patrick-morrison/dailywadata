/**
 * 1942 Aerials - Fremantle-Pinjarra
 * Patrick Morrison 2026
 */

(function () {
    'use strict';

    // Register COG protocol
    maplibregl.addProtocol('cog', MaplibreCOGProtocol.cogProtocol);

    // ============================================
    // State Management
    // ============================================
    const state = {
        map: null,
        cameras: [],
        cameraMarkers: []
    };

    // ============================================
    // Map Initialization
    // ============================================
    const { west, south, east, north } = window.PAGE_CONFIG.bounds;
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
                    tileSize: 256
                }
            },
            layers: [{
                id: 'esri-satellite-layer',
                type: 'raster',
                source: 'esri-satellite',
                minzoom: 0,
                maxzoom: 22
            }]
        },
        bounds: [[west, south], [east, north]],
        fitBoundsOptions: {
            padding: { top: 0, bottom: 0, left: window.innerWidth * -0.1, right: window.innerWidth * -0.1 }
        },
        attributionControl: {
            compact: true
        }
    });

    state.map = map;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    // ============================================
    // Load Data on Map Load
    // ============================================
    map.on('load', async () => {
        try {
            // Apply zoom again on load to ensure proper fitting
            const { west, south, east, north } = window.PAGE_CONFIG.bounds;
            map.fitBounds(
                [[west, south], [east, north]],
                {
                    padding: { top: 0, bottom: 0, left: window.innerWidth * -0.1, right: window.innerWidth * -0.1 },
                    duration: 0
                }
            );

            setLoadingText('Loading layers (10%)...');

            // Load orthomosaic FIRST so it's at the bottom
            setLoadingText('Loading orthomosaic (20%)...');
            map.addSource('orthomosaic-source', {
                type: 'raster',
                url: 'cog://orthomosaic_5m.tif',
                tileSize: 128,
                maxzoom: 22
            });

            map.addLayer({
                id: 'orthomosaic-layer',
                type: 'raster',
                source: 'orthomosaic-source',
                paint: {
                    'raster-opacity': 1.0,
                    'raster-resampling': 'linear'
                }
            });

            // Add pre-rendered DEM (colors + hillshading baked in)
            setLoadingText('Loading DEM (40%)...');
            map.addSource('dem-source', {
                type: 'raster',
                url: 'cog://terrain_5m.tif',
                tileSize: 128,
                maxzoom: 22
            });

            map.addLayer({
                id: 'dem-layer',
                type: 'raster',
                source: 'dem-source',
                layout: {
                    visibility: 'none'
                },
                paint: {
                    'raster-resampling': 'linear'
                }
            });

            setLoadingText('Loading camera positions (85%)...');
            await loadCameras();

            setLoadingText('Complete (100%)...');
            setupControls();
            hideLoading();

        } catch (error) {
            console.error('Error loading layers:', error);
            setLoadingText('Error loading data');
        }
    });

    // Context Menu (Right Click)
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
            const url = `${window.location.origin}${window.location.pathname}#${lat.toFixed(6)},${lng.toFixed(6)}`;
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
    // Load Cameras CSV
    // ============================================
    async function loadCameras() {
        try {
            const response = await fetch('cameras.csv');
            const text = await response.text();

            const lines = text.trim().split('\n');
            const headers = lines[0].split(',');

            state.cameras = lines.slice(1).map(line => {
                const values = parseCSVLine(line);
                const camera = {};
                headers.forEach((header, i) => {
                    camera[header.trim()] = values[i]?.trim() || '';
                });
                return camera;
            });

            console.log(`Loaded ${state.cameras.length} cameras`);
        } catch (error) {
            console.error('Error loading cameras:', error);
        }
    }

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

    function createCameraMarkers() {
        state.cameraMarkers.forEach(marker => marker.remove());
        state.cameraMarkers = [];

        state.cameras
            .filter(cam => cam.estimated_lat && cam.estimated_lon)
            .forEach(cam => {
                const el = document.createElement('div');
                el.className = 'camera-marker';

                const marker = new maplibregl.Marker({ element: el })
                    .setLngLat([parseFloat(cam.estimated_lon), parseFloat(cam.estimated_lat)])
                    .setPopup(new maplibregl.Popup({ offset: 15 })
                        .setHTML(createPopupContent(cam)));

                state.cameraMarkers.push(marker);
            });
    }

    function createPopupContent(camera) {
        return `
            ${camera.thumbnail_url ? `<img src="${camera.thumbnail_url}" class="popup-thumbnail" alt="Photo thumbnail">` : ''}
            <div class="popup-title">${camera.basename}</div>
            <div class="popup-meta"><strong>Frame:</strong> ${camera.frame} | <strong>Date:</strong> ${camera.date}</div>
            <div class="popup-meta"><strong>Film:</strong> ${camera.film_number}</div>
            <div class="popup-meta"><strong>Alt:</strong> ${camera.estimated_alt_m ? Math.round(camera.estimated_alt_m) + 'm' : 'N/A'}</div>
            <div class="popup-links">
                <a href="${camera.preview_url}" target="_blank" class="popup-link">Preview</a>
                <a href="${camera.source_url}" target="_blank" class="popup-link">Download</a>
            </div>
        `;
    }

    // ============================================
    // Controls
    // ============================================
    function setupControls() {
        document.getElementById('dem-toggle').addEventListener('change', (e) => {
            map.setLayoutProperty('dem-layer', 'visibility',
                e.target.checked ? 'visible' : 'none');
        });

        document.getElementById('ortho-toggle').addEventListener('change', (e) => {
            map.setLayoutProperty('orthomosaic-layer', 'visibility',
                e.target.checked ? 'visible' : 'none');
        });

        const opacitySlider = document.getElementById('ortho-opacity');
        const opacityValue = document.getElementById('ortho-opacity-value');

        opacitySlider.addEventListener('input', (e) => {
            const opacity = e.target.value / 100;
            opacityValue.textContent = e.target.value + '%';
            map.setPaintProperty('orthomosaic-layer', 'raster-opacity', opacity);
        });

        document.getElementById('cameras-toggle').addEventListener('change', (e) => {
            if (e.target.checked) {
                if (state.cameraMarkers.length === 0) createCameraMarkers();
                state.cameraMarkers.forEach(marker => marker.addTo(map));
            } else {
                state.cameraMarkers.forEach(marker => marker.remove());
            }
        });
    }

    // ============================================
    // Utilities
    // ============================================
    function setLoadingText(text) {
        const el = document.getElementById('loading-text');
        if (el) el.textContent = text;
    }

    function formatCoordinates(lng, lat) {
        const gmaps = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
        const latM = (Math.abs(lat) % 1) * 60;
        const lngM = (Math.abs(lng) % 1) * 60;
        const dm = `${Math.floor(Math.abs(lat))}° ${latM.toFixed(3)}' ${lat >= 0 ? 'N' : 'S'}, ${Math.floor(Math.abs(lng))}° ${lngM.toFixed(3)}' ${lng >= 0 ? 'E' : 'W'}`;
        return { gmaps, display: dm };
    }

    function hideLoading() {
        setTimeout(() => {
            document.getElementById('loading').classList.add('hidden');
            setTimeout(() => {
                document.getElementById('loading').style.display = 'none';
            }, 500);
        }, 800);
    }
})();
