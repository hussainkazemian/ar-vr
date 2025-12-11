import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

let container, camera, scene, renderer;
let controls;
let moveState = { forward: 0, back: 0, left: 0, right: 0 };
let moveSpeed = 6; // units per second
let lastTime = performance.now();
// No demo geometries; we'll only show HDR and loaded models.
let worldGroup; // holds all loaded models as a single group

// Helper to prefix asset URLs with the correct base path in dev/prod
// Note: new URL(relative, base) requires base to be an absolute URL; here we join strings safely.
const assetUrl = (path) => {
    const base = (import.meta.env.BASE_URL || '/');
    const baseNorm = base.endsWith('/') ? base : base + '/';
    const pathNorm = String(path || '').replace(/^\/+/, '');
    return baseNorm + pathNorm;
};

init();

function init() {
    // prefer attaching renderer to existing #app element in index.html
    container = document.getElementById('app');
    if (!container) {
        container = document.createElement('div');
        document.body.appendChild(container);
    }
    // make sure the container fills available space
    container.style.width = '100%';
    container.style.height = '100%';
    container.style.margin = '0';
    container.style.padding = '0';

    // Scene
    scene = new THREE.Scene();
    worldGroup = new THREE.Group();
    worldGroup.name = 'WorldGroup';
    scene.add(worldGroup);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    // color management & tone mapping
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    // make canvas scale to container
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    container.appendChild(renderer.domElement);

    // Camera
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    // place the camera so the full grid is visible on load
    camera.position.set(0, 6, 12);

    // Environment map (EXR/HDR) -> PMREM for proper PBR lighting
    // Primary: Qwantani Night (public/HDR/qwantani_night_4k.exr)
    // Secondary: Rogaland Clear Night, then fallback to bundled spooky bamboo
    setupEnvironment(
        assetUrl('HDR/qwantani_night_4k.exr'),
        assetUrl('HDR/rogland_clear_night_4k.exr'),
        assetUrl('spooky_bamboo_morning_4k.exr')
    );

    // Load background and car models (bottle removed).
    // Background: public/models/background/background.glb
    loadGLTF(assetUrl('models/background/background.glb'), (model) => {
        // Center and drop to floor; adjust size as needed for your asset
        normalizeCenterAndFloor(model, { targetSize: 12, yFloor: true });
        // Frame entire world group
        fitCameraToObject(camera, worldGroup, controls, 1.25);
    });
    // Car scene: public/models/car_scene/scene.gltf
    loadGLTF(assetUrl('models/car_scene/scene.gltf'), (model) => {
        normalizeCenterAndFloor(model, { targetSize: 6, yFloor: true });
        // Re-frame to include all loaded models
        fitCameraToObject(camera, worldGroup, controls, 1.25);
    });

    // No sample geometries — the scene showcases HDR lighting and external models only.

    // Light and helpers
    const light = new THREE.HemisphereLight(0xffffbb, 0x080820, 1);
    scene.add(light);

    // Optional: axes helper for reference (comment out to hide)
    // const axesHelper = new THREE.AxesHelper(5);
    // scene.add(axesHelper);

    // Start render loop
    renderer.setAnimationLoop(animate);

    // Orbit controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; // smoothes camera movement
    controls.dampingFactor = 0.05;
    // start looking at origin (where geometries will be centered)
    controls.target.set(0, 0.6, 0);
    controls.update();

    // WASD movement state
    initWASDControls();

    // HUD for controls
    createHUD();

    // Handle resize
    window.addEventListener('resize', onWindowResize, false);
}

function setupEnvironment(primaryPath, secondaryPath, fallbackPath) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();

    const onLoaded = (tex) => {
        const envMap = pmrem.fromEquirectangular(tex).texture;
        scene.environment = envMap;
        scene.background = envMap; // comment this if you want a solid color background
        tex.dispose();
        pmrem.dispose();
        console.log('Environment map set from', currentPath);
    };

    let currentPath = primaryPath;

    const loadByExtension = (path, onSuccess, onError) => {
        if (!path) return onError?.(new Error('No environment path provided'));
        const lower = path.toLowerCase();
        if (lower.endsWith('.exr')) {
            new EXRLoader().load(path, onSuccess, undefined, onError);
        } else if (lower.endsWith('.hdr')) {
            new RGBELoader().load(path, onSuccess, undefined, onError);
        } else {
            onError?.(new Error('Unsupported environment file: ' + path));
        }
    };

    const tryLoad = (paths) => {
        if (!paths.length) return console.error('No environment loaded (all paths failed).');
        currentPath = paths[0];
        loadByExtension(currentPath, (texture) => onLoaded(texture), (err) => {
            console.warn('Failed to load environment at', currentPath, err);
            tryLoad(paths.slice(1));
        });
    };

    const paths = [primaryPath, secondaryPath, fallbackPath].filter(Boolean);
    tryLoad(paths);
}

function loadGLTF(path, onModelLoaded) {
    const loader = new GLTFLoader();
    loader.load(
        path,
        (gltf) => {
            const model = gltf.scene || gltf.scenes[0];
            // Ensure metric scale (1 unit = 1 meter). Adjust only if needed.
            model.scale.set(1, 1, 1);
            model.position.set(0, 0, 0);
            model.traverse((obj) => {
                if (obj.isMesh) {
                    obj.castShadow = true;
                    obj.receiveShadow = true;
                    if (obj.material) {
                        // Make sure color space is correct
                        if (obj.material.map) obj.material.map.colorSpace = THREE.SRGBColorSpace;
                        if (obj.material.emissiveMap) obj.material.emissiveMap.colorSpace = THREE.SRGBColorSpace;
                    }
                }
            });
            worldGroup.add(model);
            console.log('GLTF loaded:', path);
            if (typeof onModelLoaded === 'function') {
                try { onModelLoaded(model, gltf); } catch (e) { console.warn('onModelLoaded handler error', e); }
            }
        },
        (progress) => {
            // console.log('GLTF load', (progress.loaded / progress.total) * 100, '%');
        },
        (error) => {
            console.error('Error loading GLTF:', error);
        }
    );
}

// Places `model` so its bottom rests just above the top of `base`, using bounding boxes.
function autoPlaceAbove(model, base, margin = 0.1) {
    const baseBox = new THREE.Box3().setFromObject(base);
    const modelBox = new THREE.Box3().setFromObject(model);
    if (!baseBox.isEmpty() && !modelBox.isEmpty()) {
        const baseTop = baseBox.max.y;
        const modelBottom = modelBox.min.y;
        const deltaY = baseTop + margin - modelBottom;
        model.position.y += deltaY;
    } else {
        // Fallback: lift it a bit if bounding boxes fail
        model.position.y += 1.0 + margin;
    }
}

// Scales model uniformly so its largest dimension equals targetSize (meters),
// optionally centers it at world origin and drops it so bottom touches y=0.
function normalizeCenterAndFloor(model, { targetSize = 5, yFloor = true } = {}) {
    const box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) return;
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = maxDim > 0 ? targetSize / maxDim : 1;
    model.scale.multiplyScalar(scale);

    // Recompute box after scaling
    const newBox = new THREE.Box3().setFromObject(model);
    const center = new THREE.Vector3();
    newBox.getCenter(center);

    // Move model so its center sits at origin on X/Z (keep relative Y for floor step)
    model.position.x -= center.x;
    model.position.z -= center.z;

    if (yFloor) {
        const afterBox = new THREE.Box3().setFromObject(model);
        const bottom = afterBox.min.y;
        model.position.y -= bottom; // lift so bottom sits at y=0
    }
}

// Frames camera and controls to fit the object nicely on screen.
function fitCameraToObject(camera, object, controls, offset = 1.25) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;

    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);

    // Compute distance from FOV and object size (fit vertically, consider aspect for horizontal)
    const maxSize = Math.max(size.x, size.y, size.z);
    const fov = THREE.MathUtils.degToRad(camera.fov);
    let distance = (maxSize / 2) / Math.tan(fov / 2);
    if (camera.aspect < 1) {
        // portrait-ish: back up a bit more
        distance = distance / camera.aspect;
    }
    distance *= offset;

    // Place camera along its current look direction, at computed distance from center
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion); // camera forward
    const newPos = center.clone().add(dir.multiplyScalar(distance));
    camera.position.copy(newPos);

    camera.near = Math.max(0.01, distance / 100);
    camera.far = Math.max(5000, distance * 100);
    camera.updateProjectionMatrix();

    if (controls) {
        controls.target.copy(center);
        controls.update();
    }
}

function createHUD() {
    const hud = document.createElement('div');
    hud.id = 'wasd-hud';
    hud.style.position = 'fixed';
    hud.style.left = '90px';
    // hud.style.top = '50%';
    hud.style.transform = 'translateY(-50%)';
    hud.style.maxWidth = '220px';
    hud.style.padding = '10px 12px';
    hud.style.background = 'rgba(0,0,0,0.6)';
    hud.style.color = '#fff';
    hud.style.fontFamily = 'sans-serif';
    hud.style.fontSize = '13px';
    hud.style.borderRadius = '6px';
    hud.style.zIndex = '9999';
    hud.innerHTML = `
    <div style="font-weight:600;margin-bottom:6px;">Controls</div>
    <div>W / S - forward / back</div>
    <div>A / D - left / right</div>
    <div style="margin-top:6px; font-size:12px; opacity:0.9">Click canvas to focus. Use mouse to orbit.</div>
    <div style="margin-top:8px; text-align:right;"><button id="hud-hide" style="background:#fff;color:#000;border:none;padding:4px 6px;border-radius:4px;cursor:pointer">Hide</button></div>
  `;
    document.body.appendChild(hud);

    const btn = document.getElementById('hud-hide');
    btn.addEventListener('click', () => {
        hud.style.display = 'none';
    });
}

// No sample geometry creation; we focus on environment + imported models.

function animate() {
    const now = performance.now();
    const delta = (now - lastTime) / 1000; // seconds
    lastTime = now;

    // apply WASD movement
    updateMovement(delta);

    // update controls for damping
    if (controls) controls.update();

    renderer.render(scene, camera);
}

function initWASDControls() {
    window.addEventListener('keydown', (e) => {
        switch (e.code) {
            case 'KeyW': moveState.forward = 1; break;
            case 'KeyS': moveState.back = 1; break;
            case 'KeyA': moveState.left = 1; break;
            case 'KeyD': moveState.right = 1; break;
        }
    });
    window.addEventListener('keyup', (e) => {
        switch (e.code) {
            case 'KeyW': moveState.forward = 0; break;
            case 'KeyS': moveState.back = 0; break;
            case 'KeyA': moveState.left = 0; break;
            case 'KeyD': moveState.right = 0; break;
        }
    });
}

function updateMovement(delta) {
    const dir = new THREE.Vector3();
    // forward/back relative to camera direction (ignore y)
    camera.getWorldDirection(dir);
    dir.y = 0;
    dir.normalize();

    const right = new THREE.Vector3();
    right.crossVectors(camera.up, dir).normalize();

    const move = new THREE.Vector3();
    if (moveState.forward) move.add(dir);
    if (moveState.back) move.sub(dir);
    if (moveState.left) move.addScaledVector(right, 1);
    if (moveState.right) move.addScaledVector(right, -1);

    if (move.lengthSq() > 0) {
        move.normalize();
        move.multiplyScalar(moveSpeed * delta);
        camera.position.add(move);
        // also move the controls target so orbit center follows camera movements
        controls.target.add(move);
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}
