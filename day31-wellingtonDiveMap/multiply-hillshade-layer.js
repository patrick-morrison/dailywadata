/**
 * Custom MapLibre layer that renders a hillshade COG with multiply blend mode.
 * This provides QGIS-quality hillshading that MapLibre doesn't natively support.
 */

/**
 * Creates a custom MapLibre layer that renders a hillshade COG
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

    // WebGL resources
    let program = null;
    let vertexBuffer = null;
    let texCoordBuffer = null;
    let texture = null;
    let imageLoaded = false;
    let mapRef = null;
    let glRef = null;

    // Image bounds as [west, south, east, north] in lng/lat (WGS84)
    let boundsLngLat = null;

    // Shader sources
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

    /**
     * Compile a shader from source
     */
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

    /**
     * Create shader program
     */
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

        // Clean up shaders (they're linked into program now)
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);

        return prog;
    }

    /**
     * Convert Web Mercator to WGS84 lng/lat
     */
    function webMercatorToLngLat(x, y) {
        const MERCATOR_EXTENT = 20037508.342789244;
        const lng = (x / MERCATOR_EXTENT) * 180;
        let lat = (y / MERCATOR_EXTENT) * 180;
        lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((lat * Math.PI) / 180)) - Math.PI / 2);
        return [lng, lat];
    }

    /**
     * Read rasters at a given resolution and create/replace the WebGL texture.
     * Returns the GeoTIFF image reference for reuse.
     */
    async function readAndCreateTexture(gl, tiff, noDataValue, samplesPerPixel, width, height, label) {
        console.time(`⏱️ hillshade: readRasters (${label})`);
        const rasters = await tiff.readRasters({ width, height });
        console.timeEnd(`⏱️ hillshade: readRasters (${label})`);

        const data = rasters[0];
        const alphaBand = samplesPerPixel >= 2 ? rasters[samplesPerPixel - 1] : null;

        const checkNoData = (val, alpha) => {
            if (alpha !== null && alpha === 0) return true;
            if (!Number.isFinite(val)) return true;
            if (noDataValue !== null && val === noDataValue) return true;
            if (noDataValue === null && val === 0) return true;
            return false;
        };

        console.time(`⏱️ hillshade: processPixels (${label})`);
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

        const rgbaData = new Uint8Array(width * height * 4);
        for (let i = 0; i < pixelData.length; i++) {
            const val = pixelData[i];
            rgbaData[i * 4] = val;
            rgbaData[i * 4 + 1] = val;
            rgbaData[i * 4 + 2] = val;
            rgbaData[i * 4 + 3] = isNoData[i] ? 0 : 255;
        }
        console.timeEnd(`⏱️ hillshade: processPixels (${label})`);

        // Create or replace the WebGL texture
        if (texture) {
            gl.deleteTexture(texture);
        }
        texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgbaData);

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        console.log(`Hillshade texture created (${label}): ${width}×${height}`);
    }

    /**
     * Load the hillshade COG with progressive quality:
     * 1. First pass: low-res (~2048px) for instant display
     * 2. Second pass: full native resolution for crisp detail
     */
    async function loadHillshadeImage(gl) {
        try {
            console.log('Loading hillshade COG:', cogUrl);
            console.time('⏱️ hillshade: GeoTIFF.fromUrl');
            const tiff = await GeoTIFF.fromUrl(cogUrl, {
                allowFullFile: false,
                cacheSize: 100
            });
            console.timeEnd('⏱️ hillshade: GeoTIFF.fromUrl');

            console.time('⏱️ hillshade: getImage');
            const image = await tiff.getImage();
            console.timeEnd('⏱️ hillshade: getImage');
            const imageBounds = image.getBoundingBox();

            // Convert to lng/lat for precision
            const sw = webMercatorToLngLat(imageBounds[0], imageBounds[1]);
            const ne = webMercatorToLngLat(imageBounds[2], imageBounds[3]);
            boundsLngLat = [sw[0], sw[1], ne[0], ne[1]];

            const fileDirectory = image.getFileDirectory();
            const gdalNoData = fileDirectory.GDAL_NODATA;
            const noDataValue = gdalNoData !== undefined ? parseFloat(gdalNoData) : null;
            const samplesPerPixel = image.getSamplesPerPixel();

            const nativeWidth = image.getWidth();
            const nativeHeight = image.getHeight();

            console.log('Hillshade bounds (lng/lat):', boundsLngLat);
            console.log('NoData value:', noDataValue, '| Samples per pixel:', samplesPerPixel);

            // --- Pass 1: Low-res for quick display ---
            const MAX_DIM_LOW = 2048;
            const scaleLow = Math.min(1, MAX_DIM_LOW / Math.max(nativeWidth, nativeHeight));
            const lowWidth = Math.round(nativeWidth * scaleLow);
            const lowHeight = Math.round(nativeHeight * scaleLow);

            // Create buffers on first load
            vertexBuffer = gl.createBuffer();
            texCoordBuffer = gl.createBuffer();
            const texCoords = new Float32Array([
                0, 0,  1, 0,  0, 1,
                1, 0,  1, 1,  0, 1
            ]);
            gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);

            console.log(`Hillshade native: ${nativeWidth}×${nativeHeight}`);

            await readAndCreateTexture(gl, tiff, noDataValue, samplesPerPixel, lowWidth, lowHeight, 'low-res');
            imageLoaded = true;

            // Trigger repaint so the low-res version appears immediately
            if (mapRef) mapRef.triggerRepaint();

            // --- Pass 2: Full native resolution ---
            // Yield to browser first so the low-res frame renders
            await new Promise(resolve => requestAnimationFrame(resolve));

            await readAndCreateTexture(gl, tiff, noDataValue, samplesPerPixel, nativeWidth, nativeHeight, 'full-res');

            // Trigger repaint to swap in the high-res texture
            if (mapRef) mapRef.triggerRepaint();

        } catch (error) {
            console.error('Failed to load hillshade COG:', error);
        }
    }

    /**
     * Update vertex buffer with coordinates relative to map center
     * This avoids precision issues by using small numbers
     */
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

    return {
        id: layerId,
        type: 'custom',
        renderingMode: '2d',

        /**
         * Called when the layer is added to the map
         */
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

        /**
         * Explicitly start loading the hillshade COG.
         * Call this after the map is visible when deferLoading=true.
         */
        startLoading() {
            if (glRef && mapRef && !imageLoaded) {
                loadHillshadeImage(glRef);
            }
        },

        /**
         * Called when the layer is removed from the map
         */
        onRemove(map, gl) {
            if (program) gl.deleteProgram(program);
            if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
            if (texCoordBuffer) gl.deleteBuffer(texCoordBuffer);
            if (texture) gl.deleteTexture(texture);
            mapRef = null;
            glRef = null;
        },

        /**
         * Called during each render frame
         */
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

        /**
         * Set the opacity of the hillshade layer
         */
        setOpacity(newOpacity) {
            opacity = newOpacity;
        },

        /**
         * Get current opacity
         */
        getOpacity() {
            return opacity;
        }
    };
}

// Export for use in main.js
window.createMultiplyHillshadeLayer = createMultiplyHillshadeLayer;
