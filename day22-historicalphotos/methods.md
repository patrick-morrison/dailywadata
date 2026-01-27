# Methods: Quest 3 Performance Optimization

To achieve 72/90 FPS on Meta Quest 3 with Gaussian Splats, we applied a strict optimization pipeline to reduce GPU scale and memory bandwidth.

## 1. Scene Optimization (Thinning & Data Size)
The raw output from `Apple ML-Sharp` contains ~1.2M splats. To guarantee performance under the <800k budget without destroying visual softness, we developed a custom pruning pipeline.

**Automated Pipeline:**
We created `pipeline.py` to automate the entire process from image to optimized splat.

```bash
# Run on a single image
python pipeline.py my_image.jpg output_folder

# Run on a directory of images
python pipeline.py input_images/ output_gaussians/optimized
```

**What the pipeline does:**
1.  **Generate**: Runs `Apple ML-Sharp` at high resolution (1536px) to capture maximum detail.
2.  **Thin**: Uses `prune.py` to filter noise (opacity > 0.1) and then randomly subsample points to hit exactly **550,000** splats.
3.  **Optimize**: Uses [`splat-transform`](https://github.com/playcanvas/splat-transform) to convert to `.sog` format and strip Spherical Harmonics (SH) bands (diffuse only), reducing file size by ~70%.

**Current settings for this project:**
```bash
python pipeline.py images/ splats/ --count 550000 --opacity 0.1
```

## 2. Renderer Optimization (SparkJS)
We configured the `SparkRenderer` in `viewer/index.js` with settings specifically for mobile VR (see [SparkJS Performance Guide](https://sparkjs.dev/docs/performance/)):

1.  **`antialiasing: false`**: Standard MSAA is expensive and provides little benefit for splats.
2.  **`maxStdDev: Math.sqrt(5)`**: Reduces the screen-space footprint of each splat to reduce overdraw.
3.  **`scene.add(spark)`**: Ensures the renderer is correctly hooked into the Three.js scene graph.

## Highlights
Featured images for the collection:
- 009963PD.jpg - Hay Street east from William Street, ca. 1906
- 022986PD.jpg - Using cross-cut saw, timber felling, South-West, 1930s?
- BA533/215.jpg - Perth City Baths
- 371945PD.jpg - Greater Union Innaloo Megaplex, 3 April 1998
- 009248PD.jpg - Picnicking at Lovers Walk, Peppermint Grove, ca. 1905
- 000763D.jpg - Jetty, Broome, 1961
- 009606PD.jpg - Railway refreshment room, Perth Railway Station, 1903-1905?
- 011486D.jpg - Jetty, Broome, 1961
- 095645PD.jpg - Shopping centre
- 111595PD.jpg - Royal Visit 1954 - crowds, State to Treasury Buildings with banner "God Save The Queen", Perth, 1954
- 133661PD.jpg - Stirling Highway, Nedlands, 1963
- 145664PD.jpg - Rear of Perth Railway Station, 14 April 1960
- 271037PD.jpg - People sitting by street with "Perth" billboard, ca. 1970s
- BA318/96/189.jpg - Minnawarra Quarry
- BA421/25.jpg - Aerial view of Fraser Avenue and Havelock Street, West Perth, 27 February 1981
