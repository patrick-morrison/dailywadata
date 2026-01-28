/**
 * Custom MapLibre layer that renders bathymetry from a COG with viewport-based reads.
 *
 * Instead of tiling via maplibre-cog-protocol (many small HTTP range requests),
 * this fetches the entire COG once (allowFullFile: true, ~6 MB) and then reads
 * from the in-memory cache on each viewport change — effectively instant.
 *
 * The turbo colormap and water-level masking are applied in JavaScript when
 * building the RGBA texture. On water-level change, the cached elevation data
 * is re-colored without any new COG reads.
 */

/**
 * @param {Object} options
 * @param {string} options.id - Layer ID
 * @param {string} options.cogUrl - URL to bathymetry COG file
 * @param {number} options.opacity - Layer opacity (0-1), default 1.0
 * @param {Function} options.getWaterLevel - () => current water level in m AHD
 * @param {Function} options.getDepthRange - () => [minDepth, maxDepth]
 * @param {number} options.noDataThreshold - Values >= this are NoData (default 1e5)
 * @param {number[][]} options.colormap - Array of [r,g,b] triples, 0-1 range
 * @returns {CustomLayerInterface}
 */
function createBathymetryLayer(options) {
    const layerId = options.id || 'bathymetry';
    const cogUrl = options.cogUrl;
    let opacity = options.opacity !== undefined ? options.opacity : 1.0;
    const getWaterLevel = options.getWaterLevel;
    const getDepthRange = options.getDepthRange;
    const noDataThreshold = options.noDataThreshold || 1e5;
    const colormap = options.colormap;

    // WebGL resources
    let program = null;
    let vertexBuffer = null;
    let texCoordBuffer = null;
    let texture = null;
    let imageLoaded = false;
    let mapRef = null;
    let glRef = null;

    // COG state
    let tiffRef = null;
    let storedNoDataValue = null;
    let fullExtentEpsg3857 = null; // [minX, minY, maxX, maxY]
    let viewportToken = 0;
    let moveendHandler = null;

    // Cached elevation data for re-coloring on water level change
    let cachedElevation = null; // Float32Array
    let cachedWidth = 0;
    let cachedHeight = 0;
    let cachedBbox = null; // [minX, minY, maxX, maxY] EPSG:3857

    // Current texture bounds as [west, south, east, north] in lng/lat
    let boundsLngLat = null;

    // ── Shaders ──────────────────────────────────────────────────────────────

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
        uniform sampler2D u_texture;
        uniform float u_opacity;

        void main() {
            vec4 color = texture(u_texture, v_texCoord);
            if (color.a < 0.5) {
                discard;
            }
            fragColor = vec4(color.rgb, u_opacity);
        }
    `;

    // ── Helpers ──────────────────────────────────────────────────────────────

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
        const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
        if (!vs || !fs) return null;

        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);

        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.error('Program link error:', gl.getProgramInfoLog(prog));
            gl.deleteProgram(prog);
            return null;
        }
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return prog;
    }

    function webMercatorToLngLat(x, y) {
        const E = 20037508.342789244;
        const lng = (x / E) * 180;
        let lat = (y / E) * 180;
        lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((lat * Math.PI) / 180)) - Math.PI / 2);
        return [lng, lat];
    }

    function lngLatToWebMercator(lng, lat) {
        const E = 20037508.342789244;
        const x = (lng / 180) * E;
        const y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180);
        return [x, (y / 180) * E];
    }

    // ── Colormap ─────────────────────────────────────────────────────────────

    /**
     * Map a depth value to an RGB color using the supplied colormap.
     * Shallow (0) → red end, deep (maxDepth) → blue/purple end.
     */
    function depthToRGB(depth, minDepth, maxDepth) {
        const normalized = (depth - minDepth) / (maxDepth - minDepth);
        const clamped = Math.max(0, Math.min(1, normalized));
        const inverted = 1 - clamped; // shallow = red (high index), deep = blue (low index)

        const index = inverted * (colormap.length - 1);
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        const frac = index - lower;

        const cL = colormap[lower];
        const cU = colormap[upper];
        return [
            Math.round((cL[0] + (cU[0] - cL[0]) * frac) * 255),
            Math.round((cL[1] + (cU[1] - cL[1]) * frac) * 255),
            Math.round((cL[2] + (cU[2] - cL[2]) * frac) * 255)
        ];
    }

    // ── Texture building ─────────────────────────────────────────────────────

    /**
     * Build an RGBA texture from cached elevation data using current water level.
     * Returns the Uint8Array of RGBA pixels.
     */
    function buildRGBA(elevation, width, height) {
        const waterLevel = getWaterLevel();
        const [minDepth, maxDepth] = getDepthRange();
        const rgba = new Uint8Array(width * height * 4);

        for (let i = 0; i < elevation.length; i++) {
            const elev = elevation[i];
            const off = i * 4;

            // NoData / above water → transparent
            if (!Number.isFinite(elev) || elev >= noDataThreshold ||
                elev === storedNoDataValue || elev > waterLevel) {
                // rgba is zero-initialized → already [0,0,0,0]
                continue;
            }

            const depth = waterLevel - elev;
            const [r, g, b] = depthToRGB(depth, minDepth, maxDepth);
            rgba[off] = r;
            rgba[off + 1] = g;
            rgba[off + 2] = b;
            rgba[off + 3] = 255;
        }
        return rgba;
    }

    /**
     * Upload RGBA data to the WebGL texture.
     */
    function uploadTexture(gl, rgba, width, height) {
        if (texture) gl.deleteTexture(texture);
        texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0,
            gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    // ── COG loading ──────────────────────────────────────────────────────────

    let textureSeq = 0;

    async function loadBathymetryImage(gl) {
        try {
            console.log('Loading bathymetry COG:', cogUrl);
            console.time('⏱️ bathy: GeoTIFF.fromUrl');
            tiffRef = await GeoTIFF.fromUrl(cogUrl, {
                allowFullFile: true,   // Fetch entire 6 MB file in one request
                cacheSize: 100
            });
            console.timeEnd('⏱️ bathy: GeoTIFF.fromUrl');

            console.time('⏱️ bathy: getImage');
            const image = await tiffRef.getImage();
            console.timeEnd('⏱️ bathy: getImage');

            fullExtentEpsg3857 = image.getBoundingBox();
            const fd = image.getFileDirectory();
            const gdalNoData = fd.GDAL_NODATA;
            storedNoDataValue = gdalNoData !== undefined ? parseFloat(gdalNoData) : null;

            const nativeWidth = image.getWidth();
            const nativeHeight = image.getHeight();
            const sw = webMercatorToLngLat(fullExtentEpsg3857[0], fullExtentEpsg3857[1]);
            const ne = webMercatorToLngLat(fullExtentEpsg3857[2], fullExtentEpsg3857[3]);
            console.log(`Bathymetry: ${nativeWidth}×${nativeHeight}, bounds: [${sw[0].toFixed(4)}, ${sw[1].toFixed(4)}] → [${ne[0].toFixed(4)}, ${ne[1].toFixed(4)}]`);
            console.log('NoData:', storedNoDataValue);

            // Create GL buffers
            vertexBuffer = gl.createBuffer();
            texCoordBuffer = gl.createBuffer();
            const texCoords = new Float32Array([
                0, 0, 1, 0, 0, 1,
                1, 0, 1, 1, 0, 1
            ]);
            gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);

            // Initial viewport read
            await loadBathymetryForViewport(gl);

            // Re-read on map movement (debounced)
            let debounceTimer = null;
            moveendHandler = () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => loadBathymetryForViewport(gl), 200);
            };
            mapRef.on('moveend', moveendHandler);

            // Trigger a re-read in case the viewport changed during COG loading
            // (e.g., nav plan restore called jumpTo before this handler existed)
            moveendHandler();

        } catch (error) {
            console.error('Failed to load bathymetry COG:', error);
        }
    }

    async function loadBathymetryForViewport(gl) {
        if (!tiffRef || !fullExtentEpsg3857 || !mapRef) return;

        const token = ++viewportToken;

        try {
            const mapBounds = mapRef.getBounds();
            const swMerc = lngLatToWebMercator(mapBounds.getWest(), mapBounds.getSouth());
            const neMerc = lngLatToWebMercator(mapBounds.getEast(), mapBounds.getNorth());

            // Expand viewport by 50% for pan buffer
            const padX = (neMerc[0] - swMerc[0]) * 0.5;
            const padY = (neMerc[1] - swMerc[1]) * 0.5;

            // Clamp to COG extent
            const [extMinX, extMinY, extMaxX, extMaxY] = fullExtentEpsg3857;
            const bboxMinX = Math.max(swMerc[0] - padX, extMinX);
            const bboxMinY = Math.max(swMerc[1] - padY, extMinY);
            const bboxMaxX = Math.min(neMerc[0] + padX, extMaxX);
            const bboxMaxY = Math.min(neMerc[1] + padY, extMaxY);

            if (bboxMinX >= bboxMaxX || bboxMinY >= bboxMaxY) return;

            const bbox = [bboxMinX, bboxMinY, bboxMaxX, bboxMaxY];

            // Screen pixel density
            const zoom = mapRef.getZoom();
            const metersPerPixel = 40075016.686 / (256 * Math.pow(2, zoom));

            let reqWidth = Math.round((bboxMaxX - bboxMinX) / metersPerPixel);
            let reqHeight = Math.round((bboxMaxY - bboxMinY) / metersPerPixel);

            // Cap texture size
            const MAX_DIM = 2048;
            if (Math.max(reqWidth, reqHeight) > MAX_DIM) {
                const scale = MAX_DIM / Math.max(reqWidth, reqHeight);
                reqWidth = Math.max(1, Math.round(reqWidth * scale));
                reqHeight = Math.max(1, Math.round(reqHeight * scale));
            }

            const seq = ++textureSeq;
            const label = `viewport z${zoom.toFixed(1)} ${reqWidth}×${reqHeight}`;
            const timerRead = `⏱️ bathy: readRasters #${seq} (${label})`;
            const timerColor = `⏱️ bathy: colormap #${seq} (${label})`;

            console.time(timerRead);
            const rasters = await tiffRef.readRasters({ bbox, width: reqWidth, height: reqHeight });
            console.timeEnd(timerRead);

            if (token !== viewportToken) return; // stale

            const actualWidth = rasters.width || reqWidth;
            const actualHeight = rasters.height || reqHeight;

            // Cache the raw elevation for re-coloring on water level change
            const elevation = new Float32Array(rasters[0].length);
            for (let i = 0; i < rasters[0].length; i++) {
                elevation[i] = rasters[0][i];
            }
            cachedElevation = elevation;
            cachedWidth = actualWidth;
            cachedHeight = actualHeight;
            cachedBbox = bbox;

            console.time(timerColor);
            const rgba = buildRGBA(elevation, actualWidth, actualHeight);
            console.timeEnd(timerColor);

            if (token !== viewportToken) return; // stale

            uploadTexture(gl, rgba, actualWidth, actualHeight);

            // Update bounds
            const swLL = webMercatorToLngLat(bboxMinX, bboxMinY);
            const neLL = webMercatorToLngLat(bboxMaxX, bboxMaxY);
            boundsLngLat = [swLL[0], swLL[1], neLL[0], neLL[1]];

            imageLoaded = true;
            console.log(`Bathymetry texture (${label}): ${actualWidth}×${actualHeight}`);
            if (mapRef) mapRef.triggerRepaint();

        } catch (error) {
            if (token === viewportToken) {
                console.error('Failed to load bathymetry viewport:', error);
            }
        }
    }

    // ── Vertex update ────────────────────────────────────────────────────────

    function updateVertices(gl) {
        if (!boundsLngLat || !mapRef) return null;

        const [west, south, east, north] = boundsLngLat;
        const center = mapRef.getCenter();
        const centerMerc = maplibregl.MercatorCoordinate.fromLngLat(center);

        const sw = maplibregl.MercatorCoordinate.fromLngLat([west, south]);
        const ne = maplibregl.MercatorCoordinate.fromLngLat([east, north]);
        const nw = maplibregl.MercatorCoordinate.fromLngLat([west, north]);
        const se = maplibregl.MercatorCoordinate.fromLngLat([east, south]);

        const vertices = new Float32Array([
            nw.x - centerMerc.x, nw.y - centerMerc.y,
            ne.x - centerMerc.x, ne.y - centerMerc.y,
            sw.x - centerMerc.x, sw.y - centerMerc.y,
            ne.x - centerMerc.x, ne.y - centerMerc.y,
            se.x - centerMerc.x, se.y - centerMerc.y,
            sw.x - centerMerc.x, sw.y - centerMerc.y
        ]);

        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
        return centerMerc;
    }

    // ── Layer interface ──────────────────────────────────────────────────────

    return {
        id: layerId,
        type: 'custom',
        renderingMode: '2d',

        onAdd(map, gl) {
            mapRef = map;
            glRef = gl;

            program = createProgram(gl, vertexShaderSource, fragmentShaderSource);
            if (!program) {
                console.error('Failed to create bathymetry shader program');
                return;
            }

            program.aPos = gl.getAttribLocation(program, 'a_pos');
            program.aTexCoord = gl.getAttribLocation(program, 'a_texCoord');
            program.uMatrix = gl.getUniformLocation(program, 'u_matrix');
            program.uTexture = gl.getUniformLocation(program, 'u_texture');
            program.uOpacity = gl.getUniformLocation(program, 'u_opacity');

            loadBathymetryImage(gl).then(() => {
                map.triggerRepaint();
            });
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
            cachedElevation = null;
        },

        render(gl, args) {
            if (!imageLoaded || !program || !texture) return;

            const centerMerc = updateVertices(gl);
            if (!centerMerc) return;

            // Save GL state
            const prevBlend = gl.isEnabled(gl.BLEND);
            const prevSrc = gl.getParameter(gl.BLEND_SRC_RGB);
            const prevDst = gl.getParameter(gl.BLEND_DST_RGB);
            const prevSrcA = gl.getParameter(gl.BLEND_SRC_ALPHA);
            const prevDstA = gl.getParameter(gl.BLEND_DST_ALPHA);
            const prevProg = gl.getParameter(gl.CURRENT_PROGRAM);

            gl.useProgram(program);

            // Standard alpha blending
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

            gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
            gl.enableVertexAttribArray(program.aPos);
            gl.vertexAttribPointer(program.aPos, 2, gl.FLOAT, false, 0, 0);

            gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
            gl.enableVertexAttribArray(program.aTexCoord);
            gl.vertexAttribPointer(program.aTexCoord, 2, gl.FLOAT, false, 0, 0);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, texture);

            const baseMatrix = args.defaultProjectionData.mercatorMatrix ||
                args.defaultProjectionData.mainMatrix;
            const mat = new Float32Array(baseMatrix);
            mat[12] = baseMatrix[0] * centerMerc.x + baseMatrix[4] * centerMerc.y + baseMatrix[12];
            mat[13] = baseMatrix[1] * centerMerc.x + baseMatrix[5] * centerMerc.y + baseMatrix[13];
            mat[14] = baseMatrix[2] * centerMerc.x + baseMatrix[6] * centerMerc.y + baseMatrix[14];
            mat[15] = baseMatrix[3] * centerMerc.x + baseMatrix[7] * centerMerc.y + baseMatrix[15];

            gl.uniformMatrix4fv(program.uMatrix, false, mat);
            gl.uniform1i(program.uTexture, 0);
            gl.uniform1f(program.uOpacity, opacity);

            gl.drawArrays(gl.TRIANGLES, 0, 6);

            // Restore GL state
            if (!prevBlend) gl.disable(gl.BLEND);
            gl.blendFuncSeparate(prevSrc, prevDst, prevSrcA, prevDstA);
            gl.useProgram(prevProg);
        },

        setOpacity(v) { opacity = v; },
        getOpacity() { return opacity; },

        /**
         * Query the cached elevation at a given lng/lat.
         * Returns elevation in metres AHD, or null if outside data / no data.
         */
        getElevationAtLngLat(lng, lat) {
            if (!cachedElevation || !cachedBbox) return null;
            const [mx, my] = lngLatToWebMercator(lng, lat);
            const [minX, minY, maxX, maxY] = cachedBbox;
            if (mx < minX || mx > maxX || my < minY || my > maxY) return null;
            // Row 0 = north (maxY), so invert Y
            const px = (mx - minX) / (maxX - minX) * cachedWidth;
            const py = (maxY - my) / (maxY - minY) * cachedHeight;
            const ix = Math.floor(px), iy = Math.floor(py);
            if (ix < 0 || ix >= cachedWidth || iy < 0 || iy >= cachedHeight) return null;
            const elev = cachedElevation[iy * cachedWidth + ix];
            if (!Number.isFinite(elev) || elev >= noDataThreshold || elev === storedNoDataValue) return null;
            return elev;
        },

        /**
         * Re-color the cached elevation data with the current water level.
         * Call after the water level slider changes — no COG re-read needed.
         */
        recolor() {
            if (!cachedElevation || !glRef) return;
            console.time('⏱️ bathy: recolor');
            const rgba = buildRGBA(cachedElevation, cachedWidth, cachedHeight);
            uploadTexture(glRef, rgba, cachedWidth, cachedHeight);
            console.timeEnd('⏱️ bathy: recolor');
            if (mapRef) mapRef.triggerRepaint();
        }
    };
}

window.createBathymetryLayer = createBathymetryLayer;
