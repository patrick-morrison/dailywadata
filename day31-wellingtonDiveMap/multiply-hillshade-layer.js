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
 * @returns {CustomLayerInterface}
 */
function createMultiplyHillshadeLayer(options) {
    const layerId = options.id || 'multiply-hillshade';
    const cogUrl = options.cogUrl;
    let opacity = options.opacity !== undefined ? options.opacity : 1.0;

    // WebGL resources
    let program = null;
    let vertexBuffer = null;
    let texCoordBuffer = null;
    let texture = null;
    let imageLoaded = false;

    // Image bounds in Web Mercator (EPSG:3857)
    let imageBounds = null;

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
     * Convert Web Mercator coordinates to MapLibre's internal Mercator units
     * MapLibre uses a coordinate system where the world is a unit square [0, 1] x [0, 1]
     */
    function webMercatorToMapLibre(x, y) {
        // Web Mercator extent: -20037508.34 to 20037508.34
        const MERCATOR_EXTENT = 20037508.342789244;
        const mlX = (x + MERCATOR_EXTENT) / (2 * MERCATOR_EXTENT);
        const mlY = (MERCATOR_EXTENT - y) / (2 * MERCATOR_EXTENT);
        return [mlX, mlY];
    }

    /**
     * Load the hillshade COG and create texture
     */
    async function loadHillshadeImage(gl) {
        try {
            console.log('Loading hillshade COG:', cogUrl);

            const tiff = await GeoTIFF.fromUrl(cogUrl, {
                allowFullFile: true,
                cacheSize: 100
            });

            const image = await tiff.getImage();
            imageBounds = image.getBoundingBox(); // [minX, minY, maxX, maxY] in EPSG:3857

            // Get NoData value from image metadata
            const fileDirectory = image.getFileDirectory();
            const gdalNoData = fileDirectory.GDAL_NODATA;
            const noDataValue = gdalNoData !== undefined ? parseFloat(gdalNoData) : null;

            // Check number of bands - might have an alpha channel
            const samplesPerPixel = image.getSamplesPerPixel();

            console.log('Hillshade bounds (EPSG:3857):', imageBounds);
            console.log('NoData value:', noDataValue);
            console.log('Samples per pixel:', samplesPerPixel);

            // Read the full image data
            const width = image.getWidth();
            const height = image.getHeight();

            console.log(`Hillshade dimensions: ${width}x${height}`);

            const rasters = await image.readRasters({
                width: width,
                height: height
            });

            // Get the first band (grayscale hillshade)
            const data = rasters[0];
            // Check for alpha band (2nd band for grayscale+alpha, or 4th for RGBA)
            const alphaBand = samplesPerPixel >= 2 ? rasters[samplesPerPixel - 1] : null;

            console.log('Has alpha band:', alphaBand !== null);

            // Track which pixels are NoData
            const isNoData = new Array(data.length);

            // Helper to check if a value is NoData
            const checkNoData = (val, alpha) => {
                // If we have an alpha band, use it
                if (alpha !== null && alpha === 0) return true;
                if (!Number.isFinite(val)) return true;
                if (noDataValue !== null && val === noDataValue) return true;
                // For hillshades without explicit noData, treat 0 as noData
                // (pure black is almost never valid hillshade data)
                if (noDataValue === null && val === 0) return true;
                return false;
            };

            // Determine data type and normalize to 0-255
            let pixelData;
            if (data instanceof Uint8Array) {
                pixelData = data;
                for (let i = 0; i < data.length; i++) {
                    const alpha = alphaBand ? alphaBand[i] : null;
                    isNoData[i] = checkNoData(data[i], alpha);
                }
            } else if (data instanceof Float32Array || data instanceof Float64Array) {
                // Normalize float data to 0-255
                pixelData = new Uint8Array(data.length);
                let min = Infinity, max = -Infinity;
                for (let i = 0; i < data.length; i++) {
                    const alpha = alphaBand ? alphaBand[i] : null;
                    isNoData[i] = checkNoData(data[i], alpha);
                    if (!isNoData[i]) {
                        min = Math.min(min, data[i]);
                        max = Math.max(max, data[i]);
                    }
                }
                const range = max - min || 1;
                for (let i = 0; i < data.length; i++) {
                    if (isNoData[i]) {
                        pixelData[i] = 0;
                    } else {
                        pixelData[i] = Math.round(((data[i] - min) / range) * 255);
                    }
                }
            } else {
                // Handle other integer types (Int16, Int32, etc.)
                pixelData = new Uint8Array(data.length);
                for (let i = 0; i < data.length; i++) {
                    const alpha = alphaBand ? alphaBand[i] : null;
                    isNoData[i] = checkNoData(data[i], alpha);
                    pixelData[i] = Math.min(255, Math.max(0, data[i]));
                }
            }

            // Create RGBA texture data (grayscale with alpha)
            // NoData pixels get alpha = 0, valid pixels get alpha = 255
            const rgbaData = new Uint8Array(width * height * 4);
            for (let i = 0; i < pixelData.length; i++) {
                const val = pixelData[i];
                rgbaData[i * 4] = val;     // R
                rgbaData[i * 4 + 1] = val; // G
                rgbaData[i * 4 + 2] = val; // B
                rgbaData[i * 4 + 3] = isNoData[i] ? 0 : 255; // A: 0 for NoData, 255 for valid
            }

            // Create WebGL texture
            texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA,
                width,
                height,
                0,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                rgbaData
            );

            // Set texture parameters
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

            // Create vertex buffer with quad covering the image bounds
            // Convert bounds to MapLibre coordinates
            const [minX, minY, maxX, maxY] = imageBounds;
            const bottomLeft = webMercatorToMapLibre(minX, minY);
            const topRight = webMercatorToMapLibre(maxX, maxY);

            // Quad vertices (two triangles)
            const vertices = new Float32Array([
                // Triangle 1
                bottomLeft[0], topRight[1],   // top-left
                topRight[0], topRight[1],     // top-right
                bottomLeft[0], bottomLeft[1], // bottom-left
                // Triangle 2
                topRight[0], topRight[1],     // top-right
                topRight[0], bottomLeft[1],   // bottom-right
                bottomLeft[0], bottomLeft[1]  // bottom-left
            ]);

            vertexBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

            // Texture coordinates
            const texCoords = new Float32Array([
                // Triangle 1
                0, 0,  // top-left
                1, 0,  // top-right
                0, 1,  // bottom-left
                // Triangle 2
                1, 0,  // top-right
                1, 1,  // bottom-right
                0, 1   // bottom-left
            ]);

            texCoordBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);

            imageLoaded = true;
            console.log('Hillshade texture loaded successfully');

        } catch (error) {
            console.error('Failed to load hillshade COG:', error);
        }
    }

    return {
        id: layerId,
        type: 'custom',
        renderingMode: '2d',

        /**
         * Called when the layer is added to the map
         */
        onAdd(map, gl) {
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

            // Load the hillshade image asynchronously
            loadHillshadeImage(gl).then(() => {
                map.triggerRepaint();
            });
        },

        /**
         * Called when the layer is removed from the map
         */
        onRemove(map, gl) {
            if (program) gl.deleteProgram(program);
            if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
            if (texCoordBuffer) gl.deleteBuffer(texCoordBuffer);
            if (texture) gl.deleteTexture(texture);
        },

        /**
         * Called during each render frame
         */
        render(gl, args) {
            if (!imageLoaded || !program || !texture) return;

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

            // Set uniforms
            gl.uniformMatrix4fv(program.uMatrix, false, args.defaultProjectionData.mainMatrix);
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
