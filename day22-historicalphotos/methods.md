# Methods: Quest 3 Performance Optimization

To achieve 72/90 FPS on Meta Quest 3 with Gaussian Splats, we applied a strict optimization pipeline to reduce GPU scale and memory bandwidth.

## 1. Scene Optimization (Thinning & Data Size)
The raw output from `ml-sharp` contains ~1.2M splats. To guarantee performance under the <800k budget without destroying visual softness, we developed a custom pruning pipeline.

**Automated Pipeline:**
We created `pipeline.py` to automate the entire process from image to optimized splat.

```bash
# Run on a single image
python pipeline.py my_image.jpg output_folder

# Run on a directory of images
python pipeline.py input_images/ output_gaussians/optimized
```

**What the pipeline does:**
1.  **Generate**: Runs `ml-sharp` at high resolution (1536px) to capture maximum detail.
2.  **Thin**: Uses `prune.py` to filter noise (opacity > 0.1) and then randomly subsample points to hit exactly **750,000** splats.
3.  **Optimize**: Uses `splat-transform` to strip Spherical Harmonics (SH) bands (diffuse only), reducing file size by ~70%.

## 2. Renderer Optimization (SparkJS)
We configured the `SparkRenderer` in `viewer/index.js` with settings specifically for mobile VR:

1.  **`antialiasing: false`**: Standard MSAA is expensive and provides little benefit for splats.
2.  **`maxStdDev: Math.sqrt(5)`**: Reduces the screen-space footprint of each splat to reduce overdraw.
3.  **`scene.add(spark)`**: Ensures the renderer is correctly hooked into the Three.js scene graph.
