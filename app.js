import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { IFCLoader } from 'web-ifc-three';

const $ = id => document.getElementById(id);
const viewer = $('viewer');
const status = $('status');
const toast = $('toast');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdde3e6);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
camera.position.set(12, 10, 12);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.localClippingEnabled = true;
viewer.appendChild(renderer.domElement);
const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.inset = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
viewer.appendChild(labelRenderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
scene.add(new THREE.HemisphereLight(0xffffff, 0x58636d, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.position.set(15, 30, 20);
scene.add(sun);
const grid = new THREE.GridHelper(100, 100, 0x666666, 0xb7b7b7);
scene.add(grid);

const loader = new IFCLoader();
loader.ifcManager.setWasmPath('https://cdn.jsdelivr.net/npm/web-ifc@0.0.43/');
let model = null, modelID = null, spatial = null, selectedID = null;
let hiddenIDs = new Set(), isolatedIDs = null, mode = 'select';
let measurePoints = [], measureObjects = [];
const raycaster = new THREE.Raycaster(), mouse = new THREE.Vector2();
const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
let clipOn = false;

function say(message, error = false) {
  status.textContent = message;
  toast.textContent = message;
  toast.style.background = error ? '#92111b' : '#000';
  toast.classList.add('show');
  clearTimeout(say.timer);
  say.timer = setTimeout(() => toast.classList.remove('show'), 2800);
}
function resize() {
  const r = viewer.getBoundingClientRect();
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
  renderer.setSize(r.width, r.height, false);
  labelRenderer.setSize(r.width, r.height);
}
window.addEventListener('resize', resize);
resize();
(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
})();

async function openIFC(file) {
  if (!file || !file.name.toLowerCase().endsWith('.ifc')) return say('Please select an .ifc file.', true);
  say(`Loading ${file.name}…`);
  $('drop-zone').style.display = 'none';
  clearModel();
  const url = URL.createObjectURL(file);
  try {
    model = await loader.loadAsync(url, e => {
      if (e.total) status.textContent = `Loading ${Math.round(e.loaded / e.total * 100)}%`;
    });
    modelID = model.modelID;
    scene.add(model);
    spatial = await loader.ifcManager.getSpatialStructure(modelID, true);
    buildTree(spatial);
    buildCategories(spatial);
    fitModel();
    say(`${file.name} loaded`);
  } catch (err) {
    console.error(err);
    $('drop-zone').style.display = 'grid';
    say('The IFC could not be opened. Check the browser console.', true);
  } finally {
    URL.revokeObjectURL(url);
  }
}
function clearModel() {
  if (model) {
    scene.remove(model);
    try { loader.ifcManager.close(modelID); } catch {}
    model = null;
  }
  clearSelection();
  hiddenIDs.clear();
  isolatedIDs = null;
  spatial = null;
  modelID = null;
  $('model-tree').innerHTML = '';
  $('categories').innerHTML = '';
  $('properties').innerHTML = '<p class="muted">Select an element to inspect its IFC properties.</p>';
  clearMeasurements();
}
function fitModel() {
  if (!model) return;
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const maximum = Math.max(size.x, size.y, size.z) || 10;
  camera.near = Math.max(maximum / 10000, 0.01);
  camera.far = maximum * 100;
  camera.updateProjectionMatrix();
  camera.position.copy(centre).add(new THREE.Vector3(maximum * 0.9, maximum * 0.7, maximum * 0.9));
  controls.target.copy(centre);
  controls.update();
  grid.position.y = box.min.y - 0.01;
  grid.scale.setScalar(Math.max(maximum / 50, 0.2));
  clipPlane.constant = centre.y;
}
function leafIDs(node, output = []) {
  if (node.expressID !== undefined && (!node.children || !node.children.length)) output.push(node.expressID);
  (node.children || []).forEach(child => leafIDs(child, output));
  return output;
}
function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
function buildTree(root) {
  const host = $('model-tree');
  host.innerHTML = '';
  host.appendChild(treeNode(root, true));
  updateEyeButtons();
}
function treeNode(node, open = false) {
  const details = document.createElement('details');
  details.dataset.id = node.expressID;
  details.open = open;
  const summary = document.createElement('summary');
  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = `${node.type || 'ITEM'} · ${node.expressID}`;
  label.addEventListener('click', e => {
    e.stopPropagation();
    if (node.expressID !== undefined) selectByID(node.expressID, true);
  });
  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'eye-button';
  eye.textContent = '◉';
  eye.title = 'Hide this item and its contents';
  eye.dataset.ids = leafIDs(node, []).join(',');
  eye.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const ids = eye.dataset.ids.split(',').filter(Boolean).map(Number);
    const currentlyVisible = ids.some(id => !hiddenIDs.has(id));
    ids.forEach(id => currentlyVisible ? hiddenIDs.add(id) : hiddenIDs.delete(id));
    isolatedIDs = null;
    refreshVisibility();
    updateEyeButtons();
    say(currentlyVisible ? 'Model item hidden' : 'Model item shown');
  });
  summary.append(label, eye);
  details.appendChild(summary);
  (node.children || []).forEach(child => details.appendChild(treeNode(child, false)));
  return details;
}
function updateEyeButtons() {
  document.querySelectorAll('.eye-button').forEach(eye => {
    const ids = eye.dataset.ids.split(',').filter(Boolean).map(Number);
    const allHidden = ids.length && ids.every(id => hiddenIDs.has(id));
    eye.classList.toggle('hidden', allHidden);
    eye.textContent = allHidden ? '⊘' : '◉';
    eye.title = allHidden ? 'Show this item and its contents' : 'Hide this item and its contents';
  });
}
function buildCategories(root) {
  const map = new Map();
  (function walk(node) {
    if (node.expressID !== undefined && (!node.children || !node.children.length)) {
      const key = node.type || 'IFCITEM';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(node.expressID);
    }
    (node.children || []).forEach(walk);
  })(root);
  const host = $('categories');
  host.innerHTML = '';
  [...map.entries()].sort().forEach(([name, ids]) => {
    const row = document.createElement('div');
    row.className = 'category-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.addEventListener('change', () => {
      ids.forEach(id => checkbox.checked ? hiddenIDs.delete(id) : hiddenIDs.add(id));
      isolatedIDs = null;
      refreshVisibility();
      updateEyeButtons();
    });
    const label = document.createElement('label');
    label.textContent = name;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = ids.length;
    row.append(checkbox, label, badge);
    host.appendChild(row);
  });
}
function hit(event) {
  if (!model) return null;
  const r = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - r.left) / r.width) * 2 - 1;
  mouse.y = -((event.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObject(model, true);
  if (!hits.length) return null;
  const h = hits[0];
  const id = loader.ifcManager.getExpressId(h.object.geometry, h.faceIndex);
  return { ...h, id };
}
renderer.domElement.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const h = hit(e);
  if (!h) return;
  if (mode === 'measure') addMeasurePoint(h.point);
  else selectByID(h.id, true);
});
async function selectByID(id, showProps) {
  if (id === undefined || id === null || !model) return;
  selectedID = id;
  clearHighlight();
  loader.ifcManager.createSubset({
    modelID,
    ids: [id],
    removePrevious: true,
    customID: 'highlight',
    material: new THREE.MeshBasicMaterial({ color: 0xffed00, depthTest: false, transparent: true, opacity: 0.78 })
  });
  if (showProps) await showProperties(id);
  document.querySelectorAll('.tree .selected').forEach(n => n.classList.remove('selected'));
  const match = document.querySelector(`.tree details[data-id="${id}"]`);
  if (match) {
    match.classList.add('selected');
    let parent = match.parentElement;
    while (parent && parent.tagName === 'DETAILS') {
      parent.open = true;
      parent = parent.parentElement;
    }
  }
}
function clearHighlight() {
  if (modelID !== null) try { loader.ifcManager.removeSubset(modelID, null, 'highlight'); } catch {}
}
function clearSelection() {
  selectedID = null;
  clearHighlight();
}
async function showProperties(id) {
  const host = $('properties');
  host.innerHTML = '<p class="muted">Loading properties…</p>';
  try {
    const identity = await loader.ifcManager.getItemProperties(modelID, id, true);
    const groups = [
      ['Identity', identity],
      ['Property sets', await loader.ifcManager.getPropertySets(modelID, id, true)],
      ['Type', await loader.ifcManager.getTypeProperties(modelID, id, true)],
      ['Materials', await loader.ifcManager.getMaterialsProperties(modelID, id, true)]
    ];
    host.innerHTML = '';
    groups.forEach(([title, data], index) => host.appendChild(renderProperties(title, data, index === 0)));
    document.querySelector('[data-tab="properties"]').click();
  } catch (err) {
    console.error(err);
    host.innerHTML = '<p class="muted">Properties could not be read for this element.</p>';
  }
}
function primitive(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if ('value' in value) return value.value;
    if ('Name' in value && value.Name?.value) return value.Name.value;
    return JSON.stringify(value, (k, x) => ['expressID', 'type'].includes(k) ? x : (typeof x === 'object' && x && 'value' in x ? x.value : x)).slice(0, 500);
  }
  return value;
}
function renderProperties(title, data, open = false) {
  const group = document.createElement('details');
  group.className = 'property-group';
  group.open = open;
  const summary = document.createElement('summary');
  summary.textContent = title;
  group.appendChild(summary);
  const list = Array.isArray(data) ? data : [data];
  let count = 0;
  for (const object of list) {
    if (!object || typeof object !== 'object') continue;
    for (const [key, value] of Object.entries(object)) {
      if (['expressID', 'type'].includes(key) || value === null || value === undefined) continue;
      const row = document.createElement('div');
      row.className = 'property-row';
      row.innerHTML = `<span>${escapeHTML(key)}</span><span>${escapeHTML(primitive(value))}</span>`;
      group.appendChild(row);
      if (++count > 120) break;
    }
    if (count > 120) break;
  }
  if (!count) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.style.padding = '0 10px';
    p.textContent = 'No values returned.';
    group.appendChild(p);
  }
  return group;
}
function refreshVisibility() {
  if (!model) return;
  try { loader.ifcManager.removeSubset(modelID, null, 'visibility'); } catch {}
  const all = leafIDs(spatial, []);
  const ids = isolatedIDs ? [...isolatedIDs] : all.filter(id => !hiddenIDs.has(id));
  model.visible = false;
  if (ids.length) loader.ifcManager.createSubset({ modelID, ids, removePrevious: true, customID: 'visibility', scene, applyBVH: false });
}
$('hide-btn').onclick = () => {
  if (selectedID === null) return say('Select an element first.', true);
  hiddenIDs.add(selectedID);
  isolatedIDs = null;
  clearSelection();
  refreshVisibility();
  updateEyeButtons();
  say('Selected element hidden');
};
$('isolate-btn').onclick = () => {
  if (selectedID === null) return say('Select an element first.', true);
  isolatedIDs = new Set([selectedID]);
  refreshVisibility();
  say('Selected element isolated');
};
$('show-all-btn').onclick = () => {
  hiddenIDs.clear();
  isolatedIDs = null;
  if (model) model.visible = true;
  try { loader.ifcManager.removeSubset(modelID, null, 'visibility'); } catch {}
  document.querySelectorAll('#categories input').forEach(x => x.checked = true);
  updateEyeButtons();
  say('All elements restored');
};
function setMode(newMode) {
  mode = newMode;
  document.querySelectorAll('.tool').forEach(b => b.classList.remove('active'));
  $(newMode === 'measure' ? 'measure-tool' : 'select-tool').classList.add('active');
  say(newMode === 'measure' ? 'Measurement: select two points' : 'Selection tool active');
}
$('select-tool').onclick = () => setMode('select');
$('measure-tool').onclick = () => { clearMeasurements(); setMode('measure'); };
function addMeasurePoint(point) {
  measurePoints.push(point.clone());
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 16), new THREE.MeshBasicMaterial({ color: 0xe30613, depthTest: false }));
  dot.position.copy(point);
  scene.add(dot);
  measureObjects.push(dot);
  if (measurePoints.length === 2) {
    const [a, b] = measurePoints;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: 0xe30613, depthTest: false }));
    scene.add(line);
    measureObjects.push(line);
    const distance = a.distanceTo(b);
    const labelElement = document.createElement('div');
    labelElement.className = 'measure-label';
    labelElement.textContent = `${distance.toFixed(3)} model units`;
    const label = new CSS2DObject(labelElement);
    label.position.copy(a.clone().add(b).multiplyScalar(0.5));
    scene.add(label);
    measureObjects.push(label);
    say(`Distance: ${distance.toFixed(3)} model units`);
    setMode('select');
  }
}
function clearMeasurements() {
  measureObjects.forEach(object => scene.remove(object));
  measureObjects = [];
  measurePoints = [];
}
$('clip-tool').onclick = () => {
  if (!model) return say('Open a model first.', true);
  clipOn = !clipOn;
  renderer.clippingPlanes = clipOn ? [clipPlane] : [];
  $('clip-tool').classList.toggle('active', clipOn);
  say(clipOn ? 'Horizontal section enabled.' : 'Section disabled.');
};
$('file-input').addEventListener('change', e => openIFC(e.target.files[0]));
['dragenter', 'dragover'].forEach(type => viewer.addEventListener(type, e => { e.preventDefault(); $('drop-zone').classList.add('drag'); }));
['dragleave', 'drop'].forEach(type => viewer.addEventListener(type, e => { e.preventDefault(); $('drop-zone').classList.remove('drag'); }));
viewer.addEventListener('drop', e => openIFC(e.dataTransfer.files[0]));
$('fit-btn').onclick = fitModel;
$('theme-btn').onclick = () => {
  document.body.classList.toggle('dark');
  scene.background = new THREE.Color(document.body.classList.contains('dark') ? 0x101416 : 0xdde3e6);
};
$('fullscreen-btn').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
$('collapse-tree').onclick = () => document.querySelectorAll('.tree details').forEach(d => d.open = false);
$('tree-search').addEventListener('input', e => {
  const query = e.target.value.toLowerCase();
  document.querySelectorAll('.tree details').forEach(details => {
    const text = details.querySelector(':scope > summary .tree-label')?.textContent.toLowerCase() || '';
    details.style.display = !query || text.includes(query) ? '' : 'none';
    if (query && text.includes(query)) {
      let parent = details.parentElement;
      while (parent && parent.tagName === 'DETAILS') {
        parent.style.display = '';
        parent.open = true;
        parent = parent.parentElement;
      }
    }
  });
});
document.querySelectorAll('.tab').forEach(tab => tab.onclick = () => {
  document.querySelectorAll('.tab,.tab-content').forEach(x => x.classList.remove('active'));
  tab.classList.add('active');
  $(tab.dataset.tab + '-tab').classList.add('active');
});
