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
let captionMesh = null; // VR Caption Display
let loadingMesh = null; // VR Loading Spinner

scene.add(splatGroup);

// Create the Caption Box for VR
function createCaptionBox() {
    // High res canvas for text
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');

    const texture = new THREE.CanvasTexture(canvas);
    // texture.minFilter = THREE.LinearFilter; // Better text quality

    // Create plane
    // Aspect ratio 4:1. Size in meters: 0.6m width, 0.15m height
    const geometry = new THREE.PlaneGeometry(0.6, 0.15);
    const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide
    });

    captionMesh = new THREE.Mesh(geometry, material);

    // Position: "Floating at the entrance below my vision"
    // Splat is at (0, 0, -1.2). Users head at (0,0,0).
    // Put "just in front" (0.5m) and "very low" (-0.6m)
    captionMesh.position.set(0, -0.6, -0.5);
    // Tilted up steep to face user
    captionMesh.rotation.x = -Math.PI / 3; // -60 degrees

    scene.add(captionMesh);

    // Initial draw
    updateCaptionTexture("Select an image...");
}

function updateCaptionTexture(text) {
    if (!captionMesh) return;

    const canvas = captionMesh.material.map.image;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Background: Rounded Rectangle
    ctx.fillStyle = "rgba(0, 0, 0, 0.9)";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = 10;

    // RoundRect function
    const r = 50; // radius
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(w - r, 0);
    ctx.quadraticCurveTo(w, 0, w, r);
    ctx.lineTo(w, h - r);
    ctx.quadraticCurveTo(w, h, w - r, h);
    ctx.lineTo(r, h);
    ctx.quadraticCurveTo(0, h, 0, h - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Text
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Auto-fit font size
    let fontSize = 90;
    ctx.font = `${fontSize}px "Instrument Serif", serif`;

    // Simple word wrap (or just fit width)
    // For simplicity, let's just draw it. ID + Caption can be long.
    // Try to break into 2 lines if too long?

    const maxTextWidth = w - 120;
    let textWidth = ctx.measureText(text).width;

    if (textWidth > maxTextWidth) {
        // Simple scale down if too long
        const scale = maxTextWidth / textWidth;
        fontSize = Math.floor(fontSize * scale);
        ctx.font = `500 ${fontSize}px "Segoe UI", Roboto, sans-serif`;
    }

    ctx.fillText(text, w / 2, h / 2);

    // Update texture
    captionMesh.material.map.needsUpdate = true;
}

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
        // Standard WebXR "Forward" is -Z
        splatGroup.position.set(0, 0, -1.2);
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
    const clock = new THREE.Clock();

    renderer.setAnimationLoop(() => {
        if (loadingMesh && loadingMesh.visible) {
            loadingMesh.rotation.z -= 0.1;
        }

        controls.update();
        renderer.render(scene, camera);
    });

    // 5. Handle Resize
    window.addEventListener('resize', onResize);

    // 6. Populate File List
    populateFileList();

    // 7. Initialize Caption
    createCaptionBox();

    // 8. VR Spinner
    createVRSpinner();

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

const loadingSpinner = document.getElementById('loading-spinner');

async function populateFileList() {
    imageSelect.innerHTML = '<option disabled selected>Loading list...</option>';

    try {
        const response = await fetch('image_list.csv');
        const text = await response.text();

        // Simple CSV parser
        // Assumes header row "filename,caption"
        // Handles basic quotes if they exist
        const lines = text.split('\n').filter(l => l.trim() !== '');
        const data = [];

        // Skip header
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            // Naive split by comma won't work perfectly with quoted captions containing commas
            // Regex to match CSV fields:
            const matches = line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g);
            // Actually, simpler approach for this specific file format:
            // filename, "caption"
            const firstComma = line.indexOf(',');
            if (firstComma > -1) {
                const filename = line.substring(0, firstComma).trim();
                let caption = line.substring(firstComma + 1).trim();

                // Remove quotes if present
                if (caption.startsWith('"') && caption.endsWith('"')) {
                    caption = caption.substring(1, caption.length - 1);
                }

                // Clean up double quotes inside
                caption = caption.replace(/""/g, '"');

                data.push({ filename, caption });
            }
        }

        imageSelect.innerHTML = '';
        data.forEach((item, index) => {
            const option = document.createElement('option');
            option.value = `./splats/${item.filename.replace('.jpg', '.sog').replace('.png', '.sog')}`;
            option.textContent = item.caption;

            // Select first by default
            if (index === 0) option.selected = true;

            imageSelect.appendChild(option);
        });

        // Auto-load first
        if (imageSelect.value) {
            loadSplat(imageSelect.value);
        }

        // Add change listener
        imageSelect.addEventListener('change', (e) => {
            if (e.target.value) loadSplat(e.target.value);
        });

    } catch (err) {
        console.error("Error loading CSV:", err);
        statusText.textContent = "Error loading image list.";
    }
}



async function loadSplat(url) {
    const loadId = ++currentLoadId;
    statusText.textContent = `Loading ${url.split('/').pop()} ...`;

    // Update VR Caption (Find text from Select option)
    const select = document.getElementById('image-select');
    // If loading from URL directly and not select change, might need to find option
    // But usually driven by select.
    if (select.value === url) {
        const text = select.options[select.selectedIndex].text;
        updateCaptionTexture(text);
    } else {
        // Try to find it? Or just filename
        updateCaptionTexture(url.split('/').pop().replace('.sog', ''));
    }

    // Cleanup immediately
    if (currentSplat) {
        splatGroup.remove(currentSplat);
        if (currentSplat.dispose) currentSplat.dispose();
        currentSplat = null;
    }

    // Show spinner
    if (loadingSpinner) loadingSpinner.style.display = 'block';
    if (loadingMesh) loadingMesh.visible = true;

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

        // Hide spinner
        if (loadingSpinner) loadingSpinner.style.display = 'none';
        if (loadingMesh) loadingMesh.visible = false;

    } catch (err) {
        if (loadId === currentLoadId) {
            console.error("Error loading splat:", err);
            statusText.textContent = "Error loading. Check console.";
            // Hide spinner on error
            if (loadingSpinner) loadingSpinner.style.display = 'none';
            if (loadingMesh) loadingMesh.visible = false;
        }
    }
}

function createVRSpinner() {
    // Simple Ring
    const geometry = new THREE.RingGeometry(0.04, 0.05, 32);
    const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.8
    });
    loadingMesh = new THREE.Mesh(geometry, material);

    // Position near caption but slightly above/center
    loadingMesh.position.set(0, -0.4, -0.5); // float above caption
    loadingMesh.visible = false; // hidden by default

    scene.add(loadingMesh);
}



function navigateImages(direction) {
    console.log("Navigating images:", direction); // DEBUG
    const select = document.getElementById('image-select');
    if (!select || select.options.length === 0) {
        console.warn("No select element or options found!"); // DEBUG
        return;
    }

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
