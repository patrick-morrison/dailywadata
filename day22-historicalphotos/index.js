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
// Dilate splats to fill gaps ("black splotches") caused by lower point count
spark.splatScale = 5.0;
scene.add(spark);

let controls;
let currentSplat = null;
let splatGroup = new THREE.Group();
let animationFrameId = null; // Track animation to allow cancellation
let placementPending = false;
let currentLoadId = 0; // Fixes ReferenceError by initializing before use
scene.add(splatGroup);

init();

function init() {
    console.log("Initializing SparkJS Viewer...");

    // 1. Setup Renderer
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(canvasContainer.clientWidth, canvasContainer.clientHeight);
    canvasContainer.appendChild(renderer.domElement);

    // 4. Setup XR Controllers for Input
    const controller1 = renderer.xr.getController(0);
    controller1.addEventListener('select', onControllerSelect);
    controller1.addEventListener('connected', function (event) {
        this.userData.handedness = event.data.handedness;
        console.log("Controller 0 connected:", this.userData.handedness);
    });
    scene.add(controller1);

    const controller2 = renderer.xr.getController(1);
    controller2.addEventListener('select', onControllerSelect);
    controller2.addEventListener('connected', function (event) {
        this.userData.handedness = event.data.handedness;
        console.log("Controller 1 connected:", this.userData.handedness);
    });
    scene.add(controller2);

    // 5. Setup AR Button
    const arButton = ARButton.createButton(renderer, {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['dom-overlay', 'local-floor'],
        domOverlay: { root: document.body }
    });

    // ... (rest of AR Button setup)

    // ...

    function onControllerSelect(event) {
        const controller = event.target;
        const handedness = controller.userData.handedness;

        console.log("Select event on controller:", handedness);

        if (handedness === 'left') {
            navigateImages(-1);
        } else if (handedness === 'right') {
            navigateImages(1);
        } else {
            // Fallback or unknown
            console.warn("Unknown handedness for select event");
            // Maybe default to next?
            navigateImages(1);
        }
    }

    // Wrap in container for better styling control
    const arContainer = document.createElement('div');
    arContainer.id = 'ar-button-container';
    arContainer.appendChild(arButton);
    document.body.appendChild(arContainer);

    // Custom message for unsupported devices
    if ('xr' in navigator) {
        navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
            if (!supported) {
                setupWebXRLink(arButton);
            }
        });
    } else {
        setupWebXRLink(arButton);
    }

    function setupWebXRLink(button) {
        button.textContent = 'Please use VR Headset';
        button.style.display = 'block';
        button.style.opacity = '1.0';
        button.style.cursor = 'default';
        button.disabled = false;
        button.title = "Learn about WebXR";

        // Remove existing listeners by cloning (simple way to clear ARButton events)
        const newButton = button.cloneNode(true);
        button.parentNode.replaceChild(newButton, button);

        // Strictly remove link behavior
        newButton.removeAttribute('href');
        newButton.onclick = (e) => {
            e.preventDefault();
            return false;
        };
    }

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
        // User requested "start me half a metre closer" -> +0.5 shift (from -0.3 to 0.2)
        // Now requested "2m closer" -> +2.0 shift (from 0.2 to 2.2)
        // Position it floating in front of user
        // Reverting to simple fixed placement relative to usage start (local space)
        splatGroup.position.set(0, 0, 1.2);
        splatGroup.rotation.set(0, 0, 0);

        statusText.textContent = "AR Mode Active";
        // Hide UI overlay if needed, but we have dom-overlay enabled.
        document.getElementById('ui-overlay').style.display = 'none';

        // Listen for controller inputs (Left=Prev, Right=Next)
        // inputSource.handedness: 'left' or 'right'
        // 'select' event corresponds to Trigger/Pinch release. 'selectstart' for press.
        // Using 'select' for singular action.
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
    const totalImages = 128; // We have 128 images now

    // Clear existing options if any (though usually empty on init)
    imageSelect.innerHTML = '';

    for (let i = 1; i <= totalImages; i++) {
        const fileName = `${i}.sog`;
        const option = document.createElement('option');
        option.value = `./splats/${fileName}`;
        option.textContent = `Image ${i}`;

        // Select the first one by default
        if (i === 1) {
            option.selected = true;
        }
        imageSelect.appendChild(option);
    }

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
    const loadId = ++currentLoadId;
    statusText.textContent = `Loading ${url.split('/').pop()} ...`;

    // Cleanup immediately
    if (currentSplat) {
        splatGroup.remove(currentSplat);
        if (currentSplat.dispose) currentSplat.dispose();
        currentSplat = null;
    }

    try {
        // Create new SplatMesh
        const splat = new SplatMesh({ url: url });

        // Wait for initialize
        await splat.initialized;

        // Check if another load started while we waited
        if (loadId !== currentLoadId) {
            // Stale load, discard
            if (splat.dispose) splat.dispose();
            return;
        }

        // Add to group
        splatGroup.add(splat);
        currentSplat = splat;

        // Orientation fix (SHARP often Y-down, Three Y-up => X rot 180)
        splat.rotation.x = Math.PI;

        // Reset view and animate in
        camera.position.set(0, 0, 0.3);
        controls.target.set(0, 0, -5);
        controls.update();

        animateCameraTo(0, 0, 0.07, 500);

    } catch (err) {
        if (loadId === currentLoadId) {
            console.error("Error loading splat:", err);
            statusText.textContent = "Error loading. Check console.";
        }
    }
}

function onXRSelect(event) {
    const handedness = event.inputSource.handedness;
    if (handedness === 'left') {
        navigateImages(-1);
    } else if (handedness === 'right') {
        navigateImages(1);
    }
}

function navigateImages(direction) {
    const select = document.getElementById('image-select');
    if (!select || select.options.length === 0) return;

    let newIndex = select.selectedIndex + direction;

    // Wrap around
    if (newIndex < 0) newIndex = select.options.length - 1;
    if (newIndex >= select.options.length) newIndex = 0;

    select.selectedIndex = newIndex;
    loadSplat(select.value);
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
