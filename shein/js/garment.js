// Procedural 3D garments built from a design spec, rendered with three.js.
// Each pattern block is a 2D front silhouette, extruded with a soft bevel so it reads as a
// padded "flat sketch in 3D". Colour, print and fabric drive the material.
// One shared offscreen renderer makes card snapshots; the inspector opens a second, live one.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Right half of each silhouette, from top-centre to bottom-centre (x ≥ 0, y up). Mirrored for the left.
const OUTLINES = {
  tee: [[0, 1.6], [0.2, 1.72], [0.42, 1.7], [0.98, 1.4], [1.12, 1.08], [0.84, 0.92], [0.68, 1.1], [0.68, 0], [0, 0]],
  crop_top: [[0, 1.46], [0.2, 1.66], [0.38, 1.66], [0.74, 1.46], [0.82, 1.24], [0.6, 1.18], [0.56, 0.74], [0, 0.72]],
  hoodie: [[0, 2.06], [0.3, 1.98], [0.36, 1.74], [0.52, 1.68], [1.06, 1.36], [1.26, 0.42], [1.02, 0.36], [0.74, 1.14], [0.76, 0.16], [0.68, 0], [0, 0]],
  shirt: [[0, 1.56], [0.16, 1.76], [0.44, 1.7], [1.02, 1.4], [1.18, 0.36], [0.96, 0.32], [0.72, 1.12], [0.72, 0.06], [0.4, -0.04], [0, 0.04]],
  slip_dress: [[0, 1.3], [0.28, 1.44], [0.3, 1.86], [0.35, 1.86], [0.4, 1.42], [0.5, 1.3], [0.44, 0.9], [0.78, -0.64], [0, -0.68]],
  wrap_dress: [[0, 1.0], [0.2, 1.72], [0.42, 1.7], [0.86, 1.42], [0.98, 1.12], [0.72, 1.1], [0.6, 1.16], [0.48, 0.76], [0.92, -0.66], [0, -0.72]],
  a_line_skirt: [[0, 1.0], [0.5, 1.0], [0.52, 0.86], [0.96, -0.24], [0, -0.3]],
  wide_leg_trousers: [[0, 1.0], [0.56, 1.0], [0.58, 0.84], [0.76, -0.92], [0.2, -0.92], [0.04, 0.28], [0, 0.3]],
  blazer: [[0, 1.6], [0.2, 1.72], [0.5, 1.72], [1.06, 1.42], [1.18, 0.28], [0.94, 0.24], [0.74, 1.1], [0.76, 0], [0.08, -0.08], [0, 0.02]],
  tank_top: [[0, 1.38], [0.2, 1.62], [0.3, 1.66], [0.38, 1.42], [0.6, 1.2], [0.64, 0], [0, 0]],
  polo: [[0, 1.5], [0.14, 1.74], [0.42, 1.7], [0.96, 1.42], [1.1, 1.1], [0.84, 0.94], [0.68, 1.1], [0.68, 0], [0, 0]],
  bomber_jacket: [[0, 1.62], [0.22, 1.7], [0.5, 1.68], [1.08, 1.38], [1.24, 0.36], [1.0, 0.3], [0.76, 1.08], [0.78, 0.12], [0.7, 0], [0, 0]],
  maxi_gown: [[0, 1.3], [0.24, 1.5], [0.3, 1.86], [0.36, 1.86], [0.42, 1.44], [0.5, 1.3], [0.42, 0.8], [0.9, -1.6], [0, -1.66]],
  shorts: [[0, 1.0], [0.56, 1.0], [0.58, 0.84], [0.7, 0.1], [0.18, 0.06], [0.04, 0.5], [0, 0.52]],
  joggers: [[0, 1.0], [0.54, 1.0], [0.56, 0.84], [0.6, 0.0], [0.46, -0.9], [0.16, -0.9], [0.04, 0.28], [0, 0.3]],
  leggings: [[0, 1.0], [0.46, 1.0], [0.48, 0.6], [0.36, -0.95], [0.12, -0.95], [0.03, 0.3], [0, 0.32]],
  tailored_trousers: [[0, 1.0], [0.54, 1.0], [0.56, 0.84], [0.6, -0.95], [0.16, -0.95], [0.04, 0.28], [0, 0.3]],
};

function shapeFor(block, fit) {
  const right = OUTLINES[block] || OUTLINES.tee;
  const pts = [...right, ...right.slice(1, -1).reverse().map(([x, y]) => [-x, y])];
  const shape = new THREE.Shape();
  pts.forEach(([x, y], i) => {
    const X = x * fit.scaleX, Y = y * fit.scaleY;
    i ? shape.lineTo(X, Y) : shape.moveTo(X, Y);
  });
  shape.closePath();
  return shape;
}

// ---- print textures (drawn on a canvas tile, repeated over the garment) ----
const shade = (hex, amt) => {
  const c = new THREE.Color(hex);
  const hsl = {}; c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.min(1, Math.max(0, hsl.l + amt)));
  return `#${c.getHexString()}`;
};
const contrast = (hex) => (new THREE.Color(hex).getHSL({}).l > 0.55 ? shade(hex, -0.45) : shade(hex, 0.42));

function drawPrint(ctx, print, base, S) {
  const acc = contrast(base), acc2 = shade(base, 0.18);
  ctx.fillStyle = base; ctx.fillRect(0, 0, S, S);
  const dot = (x, y, r, c) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); };
  switch (print) {
    case 'stripe':
      ctx.fillStyle = acc; for (let y = 0; y < S; y += S / 4) ctx.fillRect(0, y, S, S / 10); break;
    case 'gingham':
      ctx.globalAlpha = 0.5; ctx.fillStyle = acc;
      for (let i = 0; i < S; i += S / 4) { ctx.fillRect(i, 0, S / 8, S); ctx.fillRect(0, i, S, S / 8); }
      ctx.globalAlpha = 1; break;
    case 'polka_dot':
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) dot((x + (y % 2) * 0.5) * S / 4 + S / 8, y * S / 4 + S / 8, S / 22, acc);
      break;
    case 'floral':
      for (const [x, y, c] of [[0.25, 0.25, acc], [0.75, 0.7, acc2], [0.7, 0.2, acc], [0.2, 0.78, acc2]]) {
        for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2; dot(x * S + Math.cos(a) * S / 18, y * S + Math.sin(a) * S / 18, S / 22, c); }
        dot(x * S, y * S, S / 34, shade(base, -0.25));
      }
      break;
    case 'leopard': {
      const rnd = mulberry(7);
      for (let i = 0; i < 16; i++) {
        const x = rnd() * S, y = rnd() * S, r = S / 26 + rnd() * S / 30;
        ctx.strokeStyle = shade(base, -0.4); ctx.lineWidth = S / 40;
        ctx.beginPath(); ctx.ellipse(x, y, r * 1.3, r, rnd() * 3, 0.3, Math.PI * 1.7); ctx.stroke();
        dot(x, y, r * 0.55, shade(base, -0.15));
      }
      break;
    }
    case 'y2k_graphic': {
      const star = (cx, cy, r, c) => {
        ctx.fillStyle = c; ctx.beginPath();
        for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2 - Math.PI / 2, rr = i % 2 ? r * 0.42 : r; ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
        ctx.fill();
      };
      star(S * 0.3, S * 0.3, S / 7, acc); star(S * 0.75, S * 0.72, S / 9, acc2); star(S * 0.78, S * 0.22, S / 14, acc); star(S * 0.22, S * 0.8, S / 14, acc2);
      break;
    }
    case 'abstract_swirl':
      ctx.lineWidth = S / 18; ctx.lineCap = 'round';
      [[acc, 0.2], [acc2, 0.6]].forEach(([c, o]) => {
        ctx.strokeStyle = c; ctx.beginPath(); ctx.moveTo(0, S * o);
        ctx.bezierCurveTo(S * 0.3, S * (o - 0.25), S * 0.6, S * (o + 0.35), S, S * o); ctx.stroke();
      });
      break;
  }
}

function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Fabric surface noise so denim/tweed/corduroy don't look like plastic.
function drawWeave(ctx, fabric, S) {
  const rnd = mulberry(fabric.length * 31);
  ctx.globalAlpha = { denim: 0.16, tweed: 0.28, corduroy: 0.2, linen: 0.12, french_terry: 0.08, twill: 0.12 }[fabric] ?? 0;
  if (!ctx.globalAlpha) return;
  if (fabric === 'corduroy') { ctx.fillStyle = '#000'; for (let x = 0; x < S; x += 8) ctx.fillRect(x, 0, 3, S); }
  else for (let i = 0; i < S * 6; i++) { ctx.fillStyle = rnd() > 0.5 ? '#fff' : '#000'; ctx.fillRect(rnd() * S, rnd() * S, 2, fabric === 'twill' || fabric === 'denim' ? 5 : 2); }
  ctx.globalAlpha = 1;
}

function printTexture(spec, colourHex) {
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  drawPrint(ctx, spec.print, colourHex, S);
  drawWeave(ctx, spec.fabric, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1.6, 1.6);
  t.anisotropy = 4;
  return t;
}

// ---- garment assembly ----
function buildGarment(catalog, spec) {
  const colourHex = catalog.colours[spec.colour]?.hex || '#888';
  const fabric = catalog.fabrics[spec.fabric] || { roughness: 0.8, sheen: 0.2 };
  const fit = catalog.fits[spec.fit] || catalog.fits.regular;
  const group = new THREE.Group();

  const mat = new THREE.MeshPhysicalMaterial({
    map: printTexture(spec, colourHex),
    roughness: fabric.roughness,
    sheen: fabric.sheen, sheenRoughness: 0.4, sheenColor: new THREE.Color(shade(colourHex, 0.25)),
    transparent: spec.fabric === 'mesh' || spec.fabric === 'chiffon',
    opacity: spec.fabric === 'mesh' ? 0.82 : spec.fabric === 'chiffon' ? 0.9 : 1,
    side: THREE.DoubleSide,
  });
  const trimMat = new THREE.MeshStandardMaterial({ color: shade(colourHex, -0.14), roughness: Math.min(1, fabric.roughness + 0.05) });
  const darkMat = new THREE.MeshStandardMaterial({ color: shade(colourHex, -0.32), roughness: 0.9 });
  const metal = new THREE.MeshStandardMaterial({ color: '#d8c7a0', metalness: 0.8, roughness: 0.3 });

  const body = new THREE.Mesh(new THREE.ExtrudeGeometry(shapeFor(spec.block, fit), {
    depth: 0.2, bevelEnabled: true, bevelThickness: 0.09, bevelSize: 0.07, bevelSegments: 5, curveSegments: 8,
  }), mat);
  group.add(body);

  const sx = fit.scaleX, sy = fit.scaleY, front = 0.33;
  const plate = (w, h, x, y, m, z = front) => {
    const g = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.04), m);
    g.position.set(x, y, z); return g;
  };
  const button = (x, y) => { const b = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), metal); b.position.set(x, y, front + 0.02); b.scale.z = 0.5; return b; };

  switch (spec.block) {
    case 'hoodie': {
      const face = new THREE.Mesh(new THREE.CircleGeometry(0.22, 24), darkMat);
      face.scale.set(1, 1.15, 1); face.position.set(0, 1.84 * sy, front - 0.02); group.add(face);
      const pocket = new THREE.Shape([[-0.42, 0.25], [0.42, 0.25], [0.3, 0.62], [-0.3, 0.62]].map(([x, y]) => new THREE.Vector2(x * sx, y * sy)));
      const p = new THREE.Mesh(new THREE.ExtrudeGeometry(pocket, { depth: 0.03, bevelEnabled: false }), trimMat);
      p.position.z = front - 0.01; group.add(p);
      group.add(plate(1.36 * sx, 0.14, 0, 0.07, trimMat, front - 0.02));
      break;
    }
    case 'shirt':
      group.add(plate(0.1, 1.5 * sy, 0, 0.8 * sy, trimMat));
      for (let i = 0; i < 5; i++) group.add(button(0, (1.4 - i * 0.3) * sy));
      break;
    case 'blazer': {
      for (const s of [-1, 1]) {
        const lapel = new THREE.Shape([[0, 0.7], [0.05 * s, 1.68], [0.22 * s, 1.68], [0.34 * s, 1.36], [0.24 * s, 1.26]].map(([x, y]) => new THREE.Vector2(x * sx, y * sy)));
        const l = new THREE.Mesh(new THREE.ExtrudeGeometry(lapel, { depth: 0.04, bevelEnabled: false }), trimMat);
        l.position.z = front - 0.01; group.add(l);
        group.add(plate(0.32 * sx, 0.05, 0.42 * s * sx, 0.5 * sy, trimMat));
      }
      group.add(button(0.03, 0.55 * sy), button(0.03, 0.32 * sy));
      break;
    }
    case 'wrap_dress':
      group.add(plate(1.0 * sx, 0.07, 0, 0.78 * sy, trimMat));
      { const tie = plate(0.06, 0.5, 0.42 * sx, 0.55 * sy, trimMat); tie.rotation.z = 0.25; group.add(tie); }
      break;
    case 'a_line_skirt':
    case 'wide_leg_trousers':
      group.add(plate(1.12 * sx, 0.14, 0, 0.93 * sy, trimMat));
      group.add(button(0, 0.93 * sy));
      break;
    case 'tailored_trousers':
      group.add(plate(1.08 * sx, 0.12, 0, 0.94 * sy, trimMat), button(0, 0.94 * sy));
      for (const k of [-1, 1]) { const crease = plate(0.012, 1.7 * sy, 0.36 * k * sx, -0.05 * sy, trimMat); crease.rotation.z = -0.02 * k; group.add(crease); }
      break;
    case 'joggers':
      group.add(plate(1.06 * sx, 0.16, 0, 0.93 * sy, trimMat));
      for (const k of [-1, 1]) { group.add(plate(0.32 * sx, 0.12, 0.31 * k * sx, -0.86 * sy, trimMat)); const cord = plate(0.02, 0.22, 0.07 * k, 0.78 * sy, darkMat); group.add(cord); }
      break;
    case 'leggings':
    case 'shorts':
      group.add(plate((spec.block === 'leggings' ? 0.94 : 1.12) * sx, 0.14, 0, 0.94 * sy, trimMat));
      break;
    case 'bomber_jacket': {
      const zip = plate(0.03, 1.58 * sy, 0, 0.84 * sy, metal); zip.position.z = front + 0.01; group.add(zip);
      group.add(plate(1.5 * sx, 0.16, 0, 0.07 * sy, trimMat, front - 0.02), plate(0.5 * sx, 0.1, 0, 1.66 * sy, trimMat, front - 0.03));
      for (const k of [-1, 1]) { const cuff = plate(0.28, 0.12, 1.12 * k * sx, 0.36 * sy, trimMat); cuff.rotation.z = 0.42 * k; group.add(cuff); }
      break;
    }
    case 'polo':
      for (const k of [-1, 1]) {
        const collar = new THREE.Shape([[0, 1.5], [0.06 * k, 1.74], [0.28 * k, 1.68], [0.18 * k, 1.5]].map(([x, y]) => new THREE.Vector2(x * sx, y * sy)));
        const c = new THREE.Mesh(new THREE.ExtrudeGeometry(collar, { depth: 0.04, bevelEnabled: false }), trimMat); c.position.z = front - 0.01; group.add(c);
      }
      group.add(plate(0.09, 0.42 * sy, 0, 1.3 * sy, trimMat), button(0, 1.42 * sy), button(0, 1.24 * sy));
      break;
    case 'maxi_gown':
      group.add(plate(0.9 * sx, 0.06, 0, 0.84 * sy, trimMat));
      break;
    case 'tank_top':
      { const neck = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.022, 8, 24, Math.PI), trimMat);
        neck.rotation.z = Math.PI; neck.position.set(0, 1.6 * sy, front - 0.02); group.add(neck); }
      break;
    case 'tee':
    case 'crop_top':
      { const neck = new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.025, 8, 24, Math.PI), trimMat);
        neck.rotation.z = Math.PI; neck.scale.setScalar(spec.block === 'tee' ? 1 : 0.9); neck.position.set(0, (spec.block === 'tee' ? 1.72 : 1.66) * sy, front - 0.02); group.add(neck); }
      break;
  }

  // centre and normalise height
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
  group.children.forEach((c) => c.position.sub(centre));
  const s = Math.min(2.45 / size.y, 2.25 / size.x);
  group.scale.setScalar(s);
  return group;
}

function makeScene() {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#ffffff', '#b8b0a6', 1.6));
  const key = new THREE.DirectionalLight('#ffffff', 2.2); key.position.set(2, 3, 4); scene.add(key);
  const rim = new THREE.DirectionalLight('#ffe7d6', 1.0); rim.position.set(-3, 1, -2); scene.add(rim);
  const camera = new THREE.PerspectiveCamera(30, 4 / 5, 0.1, 50);
  camera.position.set(0, 0, 6.2);
  return { scene, camera };
}

function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    if (o.material) { o.material.map?.dispose(); o.material.dispose(); }
  });
}

// ---- shared snapshot renderer (one WebGL context for all cards) ----
let snap;
const cache = new Map();
export function snapshot(catalog, spec, { w = 480, h = 600 } = {}) {
  const id = [spec.block, spec.fabric, spec.colour, spec.print, spec.fit, w, h].join('~');
  if (cache.has(id)) return cache.get(id);
  if (!snap) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    snap = { renderer, ...makeScene() };
  }
  snap.renderer.setSize(w, h, false);
  snap.camera.aspect = w / h; snap.camera.updateProjectionMatrix();
  const g = buildGarment(catalog, spec);
  g.rotation.y = -0.32; g.rotation.x = 0.05;
  snap.scene.add(g);
  snap.renderer.render(snap.scene, snap.camera);
  const url = snap.renderer.domElement.toDataURL('image/webp', 0.85);
  snap.scene.remove(g); disposeTree(g);
  cache.set(id, url);
  return url;
}

// ---- live inspector (drag to rotate) ----
export function openInspector(container, catalog, spec) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);
  const { scene, camera } = makeScene();
  camera.position.set(0, 0, 7.0); // wider stage than the card, so pull back to keep the whole garment in frame
  const g = buildGarment(catalog, spec);
  scene.add(g);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false; controls.autoRotate = true; controls.autoRotateSpeed = 2.2;
  controls.minDistance = 3.5; controls.maxDistance = 9;
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize); ro.observe(container);
  let raf;
  const loop = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
  loop();
  return () => {
    cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); disposeTree(g);
    renderer.dispose(); renderer.domElement.remove();
  };
}
