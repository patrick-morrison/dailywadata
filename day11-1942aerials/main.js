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
        cameraMarkers: [],
        locationMarker: null
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
        attributionControl: false
    });

    state.map = map;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    // ============================================
    // Load Data on Map Load
    // ============================================
    map.on('load', async () => {
        try {
            // Check for URL hash location
            const hashLocation = parseHashLocation();

            // Apply zoom again on load to ensure proper fitting
            const { west, south, east, north } = window.PAGE_CONFIG.bounds;

            if (!hashLocation) {
                map.fitBounds(
                    [[west, south], [east, north]],
                    {
                        padding: { top: 0, bottom: 0, left: window.innerWidth * -0.1, right: window.innerWidth * -0.1 },
                        duration: 0
                    }
                );
            }

            // Load orthomosaic FIRST so it's at the bottom
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

            await loadCameras();

            // Add camera layer as GeoJSON
            addCameraLayer();

            setupControls();

            // Handle URL hash location after everything is loaded
            if (hashLocation) {
                showLocationMarker(hashLocation.lat, hashLocation.lng);
            }

        } catch (error) {
            console.error('Error loading layers:', error);
        }
    });

    // Context Menu (Right Click) and Long Press
    let longPressTimer;
    let longPressStartPos;

    map.on('touchstart', (e) => {
        if (e.originalEvent.touches.length === 1) {
            longPressStartPos = { x: e.point.x, y: e.point.y };
            longPressTimer = setTimeout(() => {
                showContextMenu(e);
            }, 500);
        }
    });

    map.on('touchmove', () => {
        clearTimeout(longPressTimer);
    });

    map.on('touchend', () => {
        clearTimeout(longPressTimer);
    });

    map.on('contextmenu', (e) => {
        showContextMenu(e);
    });

    function showContextMenu(e) {
        const existing = document.getElementById('context-menu');
        if (existing) existing.remove();

        // Remove location marker when opening context menu elsewhere
        if (state.locationMarker) {
            state.locationMarker.remove();
            state.locationMarker = null;
        }

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
    }

    // ============================================
    // Camera Layer (GeoJSON)
    // ============================================
    function addCameraLayer() {
        const geojson = {
            type: 'FeatureCollection',
            features: state.cameras
                .filter(cam => cam.estimated_lat && cam.estimated_lon)
                .map(cam => ({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: [parseFloat(cam.estimated_lon), parseFloat(cam.estimated_lat)]
                    },
                    properties: cam
                }))
        };

        map.addSource('cameras-source', {
            type: 'geojson',
            data: geojson
        });

        map.addLayer({
            id: 'cameras-layer',
            type: 'circle',
            source: 'cameras-source',
            layout: {
                visibility: 'none'
            },
            paint: {
                'circle-radius': 8,
                'circle-color': '#1e40af',
                'circle-stroke-width': 2,
                'circle-stroke-color': '#ffffff',
                'circle-opacity': 0.8
            }
        });

        // Click handler for popups
        map.on('click', 'cameras-layer', (e) => {
            const coordinates = e.features[0].geometry.coordinates.slice();
            const props = e.features[0].properties;

            // Ensure that if the map is zoomed out such that multiple
            // copies of the feature are visible, the popup appears
            // over the copy being pointed to.
            while (Math.abs(e.lngLat.lng - coordinates[0]) > 180) {
                coordinates[0] += e.lngLat.lng > coordinates[0] ? 360 : -360;
            }

            new maplibregl.Popup()
                .setLngLat(coordinates)
                .setHTML(createPopupContent(props))
                .addTo(map);
        });

        // Change cursor on hover
        map.on('mouseenter', 'cameras-layer', () => {
            map.getCanvas().style.cursor = 'pointer';
        });

        map.on('mouseleave', 'cameras-layer', () => {
            map.getCanvas().style.cursor = '';
        });
    }

    function createPopupContent(camera) {
        return `
            ${camera.thumbnail_url ? `<img src="${camera.thumbnail_url}" class="popup-thumbnail" alt="Photo thumbnail">` : ''}
            <div class="popup-title">${camera.basename}</div>
            <div class="popup-meta"><strong>Frame:</strong> ${camera.frame} | <strong>Date:</strong> ${camera.date}</div>
            <div class="popup-meta"><strong>Film:</strong> ${camera.film_number}</div>
            <div class="popup-meta"><strong>Alt:</strong> ${camera.estimated_alt_m ? Math.round(camera.estimated_alt_m) + 'm' : 'N/A'}</div>
            <div class="popup-meta"><strong>Source:</strong> Geoscience Australia</div>
            <div class="popup-links">
                <a href="${camera.preview_url}" target="_blank" class="popup-link">Preview</a>
                <a href="${camera.source_url}" target="_blank" class="popup-link">Download</a>
            </div>
        `;
    }

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

    // ============================================
    // Controls
    // ============================================
    function setupControls() {
        const aerialToggle = document.getElementById('aerial-toggle');
        const demToggle = document.getElementById('dem-toggle');
        const layerSliderMobile = document.getElementById('layer-opacity');
        const layerSliderDesktop = document.getElementById('layer-opacity-desktop');
        const sliderOverlay = document.querySelector('.slider-overlay');
        const sliderContainer = document.querySelector('.slider-container');

        // Function to update slider visibility
        const updateSliderVisibility = () => {
            // Always show sliders regardless of layer state
            // (removed conditional display logic)
        };

        // Function to update the active layer opacity
        const updateOpacity = (value) => {
            const opacity = value / 100;
            if (aerialToggle.checked) {
                map.setPaintProperty('orthomosaic-layer', 'raster-opacity', opacity);
            } else if (demToggle.checked) {
                map.setPaintProperty('dem-layer', 'raster-opacity', opacity);
            }
        };

        // Aerial toggle - make mutually exclusive with DEM
        aerialToggle.addEventListener('change', (e) => {
            if (e.target.checked) {
                // Turn off DEM
                demToggle.checked = false;
                map.setLayoutProperty('dem-layer', 'visibility', 'none');
                map.setLayoutProperty('orthomosaic-layer', 'visibility', 'visible');

                // If slider is at 0, reset to 100
                if (layerSliderMobile.value === '0') {
                    layerSliderMobile.value = 100;
                    layerSliderDesktop.value = 100;
                }

                // Update opacity
                updateOpacity(layerSliderMobile.value);
            } else {
                map.setLayoutProperty('orthomosaic-layer', 'visibility', 'none');
            }
            updateSliderVisibility();
        });

        // DEM toggle - make mutually exclusive with aerial
        demToggle.addEventListener('change', (e) => {
            if (e.target.checked) {
                // Turn off aerial
                aerialToggle.checked = false;
                map.setLayoutProperty('orthomosaic-layer', 'visibility', 'none');
                map.setLayoutProperty('dem-layer', 'visibility', 'visible');

                // If slider is at 0, reset to 100
                if (layerSliderMobile.value === '0') {
                    layerSliderMobile.value = 100;
                    layerSliderDesktop.value = 100;
                }

                // Update opacity
                updateOpacity(layerSliderMobile.value);
            } else {
                map.setLayoutProperty('dem-layer', 'visibility', 'none');
            }
            updateSliderVisibility();
        });

        // Unified layer blend sliders (mobile and desktop)
        layerSliderMobile.addEventListener('input', (e) => {
            updateOpacity(e.target.value);
            layerSliderDesktop.value = e.target.value;
        });

        layerSliderDesktop.addEventListener('input', (e) => {
            updateOpacity(e.target.value);
            layerSliderMobile.value = e.target.value;
        });

        // Camera layer toggle
        document.getElementById('cameras-toggle').addEventListener('change', (e) => {
            map.setLayoutProperty('cameras-layer', 'visibility',
                e.target.checked ? 'visible' : 'none');
        });

        // Slider is always visible now (no need to initialize visibility)

        // Add geolocation button
        const geoControl = new maplibregl.GeolocateControl({
            positionOptions: {
                enableHighAccuracy: true
            },
            trackUserLocation: true,
            showUserHeading: true
        });
        map.addControl(geoControl, 'bottom-right');

        // Add attribution in top-right
        map.addControl(new maplibregl.AttributionControl({
            customAttribution: 'Aerial imagery © Geoscience Australia',
            compact: true
        }), 'top-right');
    }

    // ============================================
    // URL Hash Location Handling
    // ============================================
    function parseHashLocation() {
        const hash = window.location.hash.slice(1);
        if (!hash) return null;

        const parts = hash.split(',');
        if (parts.length === 2) {
            const lat = parseFloat(parts[0]);
            const lng = parseFloat(parts[1]);
            if (!isNaN(lat) && !isNaN(lng)) {
                return { lat, lng };
            }
        }
        return null;
    }

    function showLocationMarker(lat, lng) {
        // Remove existing marker if present
        if (state.locationMarker) {
            state.locationMarker.remove();
            state.locationMarker = null;
        }

        // Add a custom marker for the shared location
        const el = document.createElement('div');
        el.className = 'location-marker';
        el.innerHTML = '📍';

        state.locationMarker = new maplibregl.Marker({ element: el })
            .setLngLat([lng, lat])
            .setSubpixelPositioning(true)  // Enable subpixel positioning for smooth panning
            .addTo(map);

        // Zoom to the location
        map.flyTo({
            center: [lng, lat],
            zoom: 15,
            duration: 2000
        });
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
})();
