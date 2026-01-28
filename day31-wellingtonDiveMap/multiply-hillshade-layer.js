/**
 * multiply-hillshade-layer.js — Custom WebGL hillshade renderer
 *
 * Renders a hillshade COG with multiply blend mode, providing
 * QGIS-quality hillshading that MapLibre doesn't natively support.
 */

// ============================================
// Hillshade Layer Factory
// ============================================

/**
 * Create a custom MapLibre layer that renders a hillshade COG
 * with multiply blend mode.
 *
 * @param {Object} options
 * @param {string} options.id - Layer ID
 * @param {string} options.cogUrl - URL to hillshade COG file
 * @param {number} options.opacity - Layer opacity (0-1), default 1.0
 * @param {boolean} options.deferLoading - If true, don't start COG loading in onAdd;
 *   call startLoading() explicitly after the map is visible.
 * @returns {CustomLayerInterface}
 */
function createMultiplyHillshadeLayer(options) {
    const layerId = options.id || 'multiply-hillshade';
    const cogUrl = options.cogUrl;
    let opacity = options.opacity !== undefined ? options.opacity : 1.0;
    const deferLoading = options.deferLoading || false;
    const pool = options.pool || null;

    // WebGL resources
    let program = null;
    let vertexBuffer = null;
    let texCoordBuffer = null;
    let texture = null;
    let imageLoaded = false;
    let mapRef = null;
    let glRef = null;

    // COG state for viewport-based reads
    let tiffRef = null;
    let storedNoDataValue = null;
    let storedSamplesPerPixel = null;
    let fullExtentEpsg3857 = null; // [minX, minY, maxX, maxY]
    let viewportToken = 0;         // For cancelling stale async reads
    let readInFlight = false;      // Prevent concurrent readRasters calls
    let pendingViewportUpdate = false; // Flag: moveend arrived while busy
    let moveendHandler = null;     // For cleanup on remove

    // Current texture bounds as [west, south, east, north] in lng/lat (WGS84)
    let boundsLngLat = null;

    // ============================================
    // Shaders
    // ============================================

    const vertexShaderSource = `#version 300 es
        in vec2 a_pos;
        in vec2 a_texCoord;
        out vec2 v_texCoord;
        uniform mat4 u_matrix;

        void main() {
            gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
            v_texCoord = a_texCoord;
        }
    `;

    const fragmentShaderSource = `#version 300 es
        precision highp float;
        in vec2 v_texCoord;
        out vec4 fragColor;
        uniform sampler2D u_hillshade;
        uniform float u_opacity;

        void main() {
            vec4 hillshade = texture(u_hillshade, v_texCoord);
            // Discard NoData pixels (stored with alpha = 0)
            if (hillshade.a < 0.5) {
                discard;
            }
            // Grayscale hillshade - use red channel for luminance
            float lum = hillshade.r;
            // Output for multiply blend: the luminance value will multiply the destination
            fragColor = vec4(lum, lum, lum, u_opacity);
        }
    `;

    // ============================================
    // Helpers
    // ============================================

    function compileShader(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error('Shader compile error:', gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    function createProgram(gl, vertexSource, fragmentSource) {
        const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
        const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

        if (!vertexShader || !fragmentShader) return null;

        const prog = gl.createProgram();
        gl.attachShader(prog, vertexShader);
        gl.attachShader(prog, fragmentShader);
        gl.linkProgram(prog);

        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.error('Program link error:', gl.getProgramInfoLog(prog));
            gl.deleteProgram(prog);
            return null;
        }

        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);

        return prog;
    }

    function webMercatorToLngLat(x, y) {
        const MERCATOR_EXTENT = 20037508.342789244;
        const lng = (x / MERCATOR_EXTENT) * 180;
        let lat = (y / MERCATOR_EXTENT) * 180;
        lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((lat * Math.PI) / 180)) - Math.PI / 2);
        return [lng, lat];
    }

    function lngLatToWebMercator(lng, lat) {
        const MERCATOR_EXTENT = 20037508.342789244;
        const x = (lng / 180) * MERCATOR_EXTENT;
        const y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180);
        return [x, (y / 180) * MERCATOR_EXTENT];
    }

    // ============================================
    // Texture Building
    // ============================================

    /**
     * Read rasters at a given resolution and create/replace the WebGL texture.
     *
     * @param {WebGLRenderingContext} gl
     * @param {GeoTIFF} tiff - GeoTIFF object (auto-selects best overview)
     * @param {number|null} noDataValue
     * @param {number} samplesPerPixel
     * @param {number} width - Requested output width
     * @param {number} height - Requested output height
     * @param {number[]} [bbox] - Optional [minX, minY, maxX, maxY] in EPSG:3857
     * @param {number} [token] - Viewport token; if provided, bail early when stale
     * @returns {boolean} false if the read was stale (token mismatch)
     */
    async function readAndCreateTexture(gl, tiff, noDataValue, samplesPerPixel, width, height, bbox, token) {
        // Bail before expensive read if a newer viewport request already arrived
        if (token !== undefined && token !== viewportToken) return false;

        const readOpts = { width, height, pool };
        if (bbox) readOpts.bbox = bbox;
        const rasters = await tiff.readRasters(readOpts);

        // Bail before expensive pixel work if a newer request superseded this one
        if (token !== undefined && token !== viewportToken) return false;

        // Yield a full frame so MapLibre can paint pending interactive updates
        // (e.g. measure point GeoJSON setData) before we block with pixel work.
        // readInFlight stays true in the caller so viewportToken can't change.
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

        // Use actual returned dimensions (should match requested, but be safe)
        const actualWidth = rasters.width || width;
        const actualHeight = rasters.height || height;

        const data = rasters[0];
        const alphaBand = samplesPerPixel >= 2 ? rasters[samplesPerPixel - 1] : null;

        const checkNoData = (val, alpha) => {
            if (alpha !== null && alpha === 0) return true;
            if (!Number.isFinite(val)) return true;
            if (noDataValue !== null && val === noDataValue) return true;
            if (noDataValue === null && val === 0) return true;
            return false;
        };

        const isNoData = new Uint8Array(data.length);
        let pixelData;

        if (data instanceof Uint8Array) {
            pixelData = data;
            for (let i = 0; i < data.length; i++) {
                isNoData[i] = checkNoData(data[i], alphaBand ? alphaBand[i] : null) ? 1 : 0;
            }
        } else if (data instanceof Float32Array || data instanceof Float64Array) {
            pixelData = new Uint8Array(data.length);
            let min = Infinity, max = -Infinity;
            for (let i = 0; i < data.length; i++) {
                isNoData[i] = checkNoData(data[i], alphaBand ? alphaBand[i] : null) ? 1 : 0;
                if (!isNoData[i]) {
                    if (data[i] < min) min = data[i];
                    if (data[i] > max) max = data[i];
                }
            }
            const range = max - min || 1;
            for (let i = 0; i < data.length; i++) {
                pixelData[i] = isNoData[i] ? 0 : Math.round(((data[i] - min) / range) * 255);
            }
        } else {
            pixelData = new Uint8Array(data.length);
            for (let i = 0; i < data.length; i++) {
                isNoData[i] = checkNoData(data[i], alphaBand ? alphaBand[i] : null) ? 1 : 0;
                pixelData[i] = Math.min(255, Math.max(0, data[i]));
            }
        }

        const rgbaData = new Uint8Array(actualWidth * actualHeight * 4);
        for (let i = 0; i < pixelData.length; i++) {
            const val = pixelData[i];
            rgbaData[i * 4] = val;
            rgbaData[i * 4 + 1] = val;
            rgbaData[i * 4 + 2] = val;
            rgbaData[i * 4 + 3] = isNoData[i] ? 0 : 255;
        }

        // Final stale check before touching GL state
        if (token !== undefined && token !== viewportToken) return false;

        // Create or replace the WebGL texture
        if (texture) {
            gl.deleteTexture(texture);
        }
        texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, actualWidth, actualHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgbaData);

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        return true;
    }

    // ============================================
    // COG Loading
    // ============================================

    /**
     * Open the hillshade COG, read metadata, create GL buffers,
     * do the initial viewport read, and wire up moveend for re-reads.
     */
    async function loadHillshadeImage(gl) {
        try {
            tiffRef = await GeoTIFF.fromUrl(cogUrl, {
                allowFullFile: false,
                cacheSize: 100
            });

            const image = await tiffRef.getImage();

            // Store metadata for viewport reads
            fullExtentEpsg3857 = image.getBoundingBox(); // [minX, minY, maxX, maxY]
            const fileDirectory = image.getFileDirectory();
            const gdalNoData = fileDirectory.GDAL_NODATA;
            storedNoDataValue = gdalNoData !== undefined ? parseFloat(gdalNoData) : null;
            storedSamplesPerPixel = image.getSamplesPerPixel();

            // Create GL buffers once
            vertexBuffer = gl.createBuffer();
            texCoordBuffer = gl.createBuffer();
            const texCoords = new Float32Array([
                0, 0,  1, 0,  0, 1,
                1, 0,  1, 1,  0, 1
            ]);
            gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);

            // Initial viewport read
            await loadHillshadeForViewport(gl);

            // Re-read on map movement (debounced)
            let debounceTimer = null;
            moveendHandler = () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => loadHillshadeForViewport(gl), 300);
            };
            mapRef.on('moveend', moveendHandler);

            // Trigger a re-read in case the viewport changed during COG loading
            // (e.g., nav plan restore called jumpTo before this handler existed)
            moveendHandler();

        } catch (error) {
            console.error('Failed to load hillshade COG:', error);
        }
    }

    // ============================================
    // Viewport Reading
    // ============================================

    /**
     * Read the hillshade for the current map viewport at screen-appropriate
     * resolution, using COG overviews automatically.
     */
    async function loadHillshadeForViewport(gl) {
        if (!tiffRef || !fullExtentEpsg3857 || !mapRef) return;

        if (readInFlight) { pendingViewportUpdate = true; return; }

        const token = ++viewportToken;
        pendingViewportUpdate = false;

        try {
            const mapBounds = mapRef.getBounds();
            const swMerc = lngLatToWebMercator(mapBounds.getWest(), mapBounds.getSouth());
            const neMerc = lngLatToWebMercator(mapBounds.getEast(), mapBounds.getNorth());

            // Expand viewport by 50% so panning doesn't show edges
            const padX = (neMerc[0] - swMerc[0]) * 0.5;
            const padY = (neMerc[1] - swMerc[1]) * 0.5;

            // Clamp expanded viewport to hillshade extent
            const [extMinX, extMinY, extMaxX, extMaxY] = fullExtentEpsg3857;
            const bboxMinX = Math.max(swMerc[0] - padX, extMinX);
            const bboxMinY = Math.max(swMerc[1] - padY, extMinY);
            const bboxMaxX = Math.min(neMerc[0] + padX, extMaxX);
            const bboxMaxY = Math.min(neMerc[1] + padY, extMaxY);

            if (bboxMinX >= bboxMaxX || bboxMinY >= bboxMaxY) return; // no overlap

            const bbox = [bboxMinX, bboxMinY, bboxMaxX, bboxMaxY];

            // Calculate screen pixel density for the visible area.
            // Web Mercator resolution at zoom z: 40075016.686 / (256 * 2^z) metres/px
            const zoom = mapRef.getZoom();
            const metersPerPixel = 40075016.686 / (256 * Math.pow(2, zoom));

            let reqWidth = Math.round((bboxMaxX - bboxMinX) / metersPerPixel);
            let reqHeight = Math.round((bboxMaxY - bboxMinY) / metersPerPixel);

            // Cap to avoid enormous textures
            const MAX_DIM = 2048;
            if (Math.max(reqWidth, reqHeight) > MAX_DIM) {
                const scale = MAX_DIM / Math.max(reqWidth, reqHeight);
                reqWidth = Math.max(1, Math.round(reqWidth * scale));
                reqHeight = Math.max(1, Math.round(reqHeight * scale));
            }

            readInFlight = true;
            const ok = await readAndCreateTexture(
                gl, tiffRef, storedNoDataValue, storedSamplesPerPixel,
                reqWidth, reqHeight, bbox, token
            );

            // readAndCreateTexture returns false if the token went stale
            if (!ok) return;

            // Update texture bounds to match the bbox we actually read
            const swLL = webMercatorToLngLat(bboxMinX, bboxMinY);
            const neLL = webMercatorToLngLat(bboxMaxX, bboxMaxY);
            boundsLngLat = [swLL[0], swLL[1], neLL[0], neLL[1]];

            imageLoaded = true;
            if (mapRef) mapRef.triggerRepaint();
        } catch (error) {
            if (token === viewportToken) {
                console.error('Failed to load hillshade for viewport:', error);
            }
        } finally {
            readInFlight = false;
            if (pendingViewportUpdate) {
                pendingViewportUpdate = false;
                if (moveendHandler) moveendHandler();
            }
        }
    }

    // ============================================
    // Vertex Update
    // ============================================

    function updateVertices(gl) {
        if (!boundsLngLat || !mapRef) return;

        const [west, south, east, north] = boundsLngLat;

        // Get current map center for relative coordinates
        const center = mapRef.getCenter();
        const centerMerc = maplibregl.MercatorCoordinate.fromLngLat(center);

        // Compute corner coordinates relative to center (small numbers = good precision)
        const sw = maplibregl.MercatorCoordinate.fromLngLat([west, south]);
        const ne = maplibregl.MercatorCoordinate.fromLngLat([east, north]);
        const nw = maplibregl.MercatorCoordinate.fromLngLat([west, north]);
        const se = maplibregl.MercatorCoordinate.fromLngLat([east, south]);

        // Quad vertices relative to center (two triangles)
        const vertices = new Float32Array([
            // Triangle 1
            nw.x - centerMerc.x, nw.y - centerMerc.y,  // top-left
            ne.x - centerMerc.x, ne.y - centerMerc.y,  // top-right
            sw.x - centerMerc.x, sw.y - centerMerc.y,  // bottom-left
            // Triangle 2
            ne.x - centerMerc.x, ne.y - centerMerc.y,  // top-right
            se.x - centerMerc.x, se.y - centerMerc.y,  // bottom-right
            sw.x - centerMerc.x, sw.y - centerMerc.y   // bottom-left
        ]);

        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);

        return centerMerc;
    }

    // ============================================
    // Layer Interface
    // ============================================

    return {
        id: layerId,
        type: 'custom',
        renderingMode: '2d',

        onAdd(map, gl) {
            mapRef = map;
            glRef = gl;

            // Create shader program
            program = createProgram(gl, vertexShaderSource, fragmentShaderSource);

            if (!program) {
                console.error('Failed to create hillshade shader program');
                return;
            }

            // Get attribute and uniform locations
            program.aPos = gl.getAttribLocation(program, 'a_pos');
            program.aTexCoord = gl.getAttribLocation(program, 'a_texCoord');
            program.uMatrix = gl.getUniformLocation(program, 'u_matrix');
            program.uHillshade = gl.getUniformLocation(program, 'u_hillshade');
            program.uOpacity = gl.getUniformLocation(program, 'u_opacity');

            // Load immediately unless deferred
            if (!deferLoading) {
                loadHillshadeImage(gl).then(() => {
                    map.triggerRepaint();
                });
            }
        },

        /** Start COG loading explicitly (when deferLoading=true). */
        startLoading() {
            if (glRef && mapRef && !imageLoaded) {
                loadHillshadeImage(glRef);
            }
        },

        onRemove(map, gl) {
            if (moveendHandler) map.off('moveend', moveendHandler);
            if (program) gl.deleteProgram(program);
            if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
            if (texCoordBuffer) gl.deleteBuffer(texCoordBuffer);
            if (texture) gl.deleteTexture(texture);
            tiffRef = null;
            mapRef = null;
            glRef = null;
        },

        render(gl, args) {
            if (!imageLoaded || !program || !texture) return;

            // Update vertices with coordinates relative to map center
            const centerMerc = updateVertices(gl);
            if (!centerMerc) return;

            // Save current WebGL state
            const previousBlendEnabled = gl.isEnabled(gl.BLEND);
            const previousBlendSrc = gl.getParameter(gl.BLEND_SRC_RGB);
            const previousBlendDst = gl.getParameter(gl.BLEND_DST_RGB);
            const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM);

            // Use our program
            gl.useProgram(program);

            // Set up multiply blend mode: result = src * dst
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.DST_COLOR, gl.ZERO);

            // Bind vertex positions
            gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
            gl.enableVertexAttribArray(program.aPos);
            gl.vertexAttribPointer(program.aPos, 2, gl.FLOAT, false, 0, 0);

            // Bind texture coordinates
            gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
            gl.enableVertexAttribArray(program.aTexCoord);
            gl.vertexAttribPointer(program.aTexCoord, 2, gl.FLOAT, false, 0, 0);

            // Bind texture
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, texture);

            // Create translated matrix to account for center-relative coordinates
            const baseMatrix = args.defaultProjectionData.mercatorMatrix || args.defaultProjectionData.mainMatrix;

            // Translate the matrix by the center offset
            // Matrix is column-major, so we modify elements [12] and [13] for translation
            const translatedMatrix = new Float32Array(baseMatrix);
            translatedMatrix[12] = baseMatrix[0] * centerMerc.x + baseMatrix[4] * centerMerc.y + baseMatrix[12];
            translatedMatrix[13] = baseMatrix[1] * centerMerc.x + baseMatrix[5] * centerMerc.y + baseMatrix[13];
            translatedMatrix[14] = baseMatrix[2] * centerMerc.x + baseMatrix[6] * centerMerc.y + baseMatrix[14];
            translatedMatrix[15] = baseMatrix[3] * centerMerc.x + baseMatrix[7] * centerMerc.y + baseMatrix[15];

            gl.uniformMatrix4fv(program.uMatrix, false, translatedMatrix);
            gl.uniform1i(program.uHillshade, 0);
            gl.uniform1f(program.uOpacity, opacity);

            // Draw the quad (6 vertices = 2 triangles)
            gl.drawArrays(gl.TRIANGLES, 0, 6);

            // Restore WebGL state
            if (!previousBlendEnabled) {
                gl.disable(gl.BLEND);
            }
            gl.blendFunc(previousBlendSrc, previousBlendDst);
            gl.useProgram(previousProgram);
        },

        setOpacity(newOpacity) {
            opacity = newOpacity;
        },

        getOpacity() {
            return opacity;
        }
    };
}

// Export for use in main.js
window.createMultiplyHillshadeLayer = createMultiplyHillshadeLayer;
