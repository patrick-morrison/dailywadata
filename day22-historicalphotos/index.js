import * as THREE from "three";
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { SplatMesh, SparkRenderer } from "@sparkjsdev/spark";

// DOM Elements
const canvasContainer = document.getElementById('canvas-container');
const imageSelect = document.getElementById('image-select');
const statusText = document.getElementById('status-text');

// Three.js State
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, canvasContainer.clientWidth / canvasContainer.clientHeight, 0.005, 5000); // Increased far plane
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local'); // Explicitly request local space for locking

// Initialize SparkRenderer to configure global splat settings
// SparkRenderer must be added to the scene to function correctly
const spark = new SparkRenderer({ renderer, maxStdDev: Math.sqrt(5) });
scene.add(spark);

let controls;
let currentSplat = null;
let splatGroup = new THREE.Group();
let animationFrameId = null; // Track animation to allow cancellation
scene.add(splatGroup);

init();

function init() {
    console.log("Initializing SparkJS Viewer...");

    // 1. Setup Renderer
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(canvasContainer.clientWidth, canvasContainer.clientHeight);
    canvasContainer.appendChild(renderer.domElement);

    // Setup AR Button
    const arButton = ARButton.createButton(renderer, {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['dom-overlay', 'local-floor'],
        domOverlay: { root: document.body }
    });
    document.body.appendChild(arButton);

    // Handle AR Session Start/End for scaling/positioning
    renderer.xr.addEventListener('sessionstart', () => {
        // Optimize for mobile AR: reduce resolution to fix lag
        renderer.xr.setFoveation(1.0); // Enable fixed foveated rendering (1.0 = max)
        renderer.setPixelRatio(1);

        // In Desktop mode, camera is at 0.035 looking at 0,0,0.
        // The splat is tiny (approx 4cm wide).
        // In AR, we want it to be a "window" size, e.g., 1 meter wide.
        // User requested native scale: "should be correct scale coming out of ml sharp"
        splatGroup.scale.set(1, 1, 1);

        // Position it floating in front of user (assuming 'local' or 'viewer' space initially)
        // usually z=-1 or so is good. 
        // We'll put it at eye level (approx) if using local-floor, or just in front if local.
        // Let's assume standard 'local' or 'viewer' relative start.
        // Position it floating in front of user
        // User requested "start me half a metre closer"
        // Previous: -0.3. +0.5 = 0.2.
        splatGroup.position.set(0, 0, 0.2);
        splatGroup.rotation.set(0, 0, 0); // Ensure it's facing camera? 
        // Note: Splat is already rotated Math.PI in X in loadSplat logic... wait.

        statusText.textContent = "AR Mode Active";
        // Hide UI overlay if needed, but we have dom-overlay enabled.
        document.getElementById('ui-overlay').style.display = 'none';
    });

    renderer.xr.addEventListener('sessionend', () => {
        // Restore high quality for desktop
        renderer.setPixelRatio(window.devicePixelRatio);

        // Reset to desktop scale/pos
        splatGroup.scale.set(1, 1, 1);
        splatGroup.position.set(0, 0, 0);
        statusText.textContent = "Exited AR Mode";
        document.getElementById('ui-overlay').style.display = 'block';
    });

    // 2. Setup Camera for "Window" effect
    camera.position.set(0, 0, 0.07); // Slightly closer than 0.1

    // 3. Setup Controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 0, -5); // Allow zooming forward 5 meters
    controls.saveState(); // Save this as the reset state
    // Map Left-click to Pan (for parallax side-to-side movement)
    // Remove rotation mapping
    controls.mouseButtons = {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: null
    };
    controls.touches = {
        ONE: THREE.TOUCH.PAN,
        TWO: THREE.TOUCH.DOLLY_PAN
    };
    controls.panSpeed = 0.25; // Slower, approx 1/3 of previous 0.7

    // Zoom/Dolly settings
    controls.enableZoom = true;
    controls.zoomSpeed = 2.0;
    controls.minDistance = 0.01;
    controls.maxDistance = 10.0; // Allow backing up significantly

    // 4. Animation Loop
    renderer.setAnimationLoop(() => {
        controls.update();
        renderer.render(scene, camera);
    });

    // 5. Handle Resize
    window.addEventListener('resize', onResize);

    // 6. Populate File List
    populateFileList();

    // Listen for user interaction to interrupt animation
    const stopAnimation = () => {
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
    };
    canvasContainer.addEventListener('mousedown', stopAnimation);
    canvasContainer.addEventListener('wheel', stopAnimation);
    canvasContainer.addEventListener('touchstart', stopAnimation);
}

function onResize() {
    camera.aspect = canvasContainer.clientWidth / canvasContainer.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(canvasContainer.clientWidth, canvasContainer.clientHeight);
}

function populateFileList() {
    const files = [
        '0998a351f324ac04274450514652acfe9d60a7a8.sog',
        '314779PD-Fountain-at-the-centre-of-the-Galleria-shopping-centre-Morley-December-1994.sog',
        '34c3f7e17af1866883c8ee86154c0a4a32f2b193-16x9-x0y84w1506h847.sog',
        '371964PD-The-lobby-and-the-Candy-Bar-at-Greater-Union-cinemas-at-the-Galleria-Morley-6-October-1998--2.sog',
        '73e62709f924fc6f9bcf50fe03c297109e3f8fba.sog'
    ];

    files.forEach(file => {
        const option = document.createElement('option');
        option.value = `./splats/${file}`;
        option.textContent = file;
        if (file.startsWith('34c3f')) {
            option.selected = true;
        }
        imageSelect.appendChild(option);
    });

    imageSelect.addEventListener('change', (e) => {
        if (e.target.value) {
            loadSplat(e.target.value);
        }
    });

    // Auto-load the selected default
    if (imageSelect.value) {
        loadSplat(imageSelect.value);
    } else {
        statusText.textContent = "Select an image to start.";
    }
}

async function loadSplat(url) {
    statusText.textContent = `Loading ${url.split('/').pop()} (Optimized: 750k)...`;

    // Cleanup previous
    if (currentSplat) {
        splatGroup.remove(currentSplat);
        if (currentSplat.dispose) currentSplat.dispose();
        currentSplat = null;
    }

    try {
        // Create new SplatMesh
        const splat = new SplatMesh({ url: url });

        // SparkJS loads progressively. Add to our group.
        splatGroup.add(splat);
        currentSplat = splat;

        // Correct Orientation: SHARP outputs OpenCV-style (Y-down). Three.js is Y-up.
        // Rotation around X by 180 degrees usually fixes inverted visuals.
        splat.rotation.x = Math.PI;

        // Wait for the splat to be fully loaded and initialized before showing it
        await splat.initialized;

        statusText.textContent = "Loaded. Left-click drag to pan (parallax).";

        // Reset view and animate in
        // Start further back to show parallax effect
        // Reset view and animate in
        // Target is set deep (-5) so we can zoom "into" the scene
        camera.position.set(0, 0, 0.3);
        controls.target.set(0, 0, -5);
        controls.update();

        // Smooth "roll in" animation
        animateCameraTo(0, 0, 0.07, 500); // Snappy 0.5s roll-in to 0.07

    } catch (err) {
        console.error("Error loading splat:", err);
        statusText.textContent = "Error loading. Check console.";
    }
}

function animateCameraTo(x, y, z, duration) {
    const startPos = camera.position.clone();
    const endPos = new THREE.Vector3(x, y, z);
    const startTime = performance.now();

    function update() {
        const now = performance.now();
        const progress = Math.min((now - startTime) / duration, 1);

        // Simple ease-out cubic
        const ease = 1 - Math.pow(1 - progress, 3);

        camera.position.lerpVectors(startPos, endPos, ease);
        controls.update(); // Important for OrbitControls to sync

        if (progress < 1) {
            requestAnimationFrame(update);
        }
    }
    requestAnimationFrame(update);
}
