import {
  graph, viewport, interaction, undoStack, MAX_UNDO,
  addNode, removeSubtree, nodeById, rootNode, allNodes,
  worldToScreen, screenToWorld, getViewportTransform,
} from './state.js';

// ============================================
// DOM refs (set on init)
// ============================================
let svgEl, transformLayer, edgesLayer, nodesLayer;

// ============================================
// Callbacks (set by main.js)
// ============================================
let _onExpandRequest = null;
let _onGraphChanged = null;

export function setOnExpandRequest(fn) { _onExpandRequest = fn; }
export function setOnGraphChanged(fn) { _onGraphChanged = fn; }
export function getOnExpandRequest() { return _onExpandRequest; }
export function getOnGraphChanged() { return _onGraphChanged; }
export { zoomAt };

// ============================================
// Physics state (internal to graph.js)
// ============================================
const physicsObjects = new Map();      // childNodeId -> PhysicsBody
const parentHistory = new Map();       // parentId -> [{x, y, time}]
const HISTORY_MAX_LENGTH = 120;
const HISTORY_MAX_AGE = 2000;
let physicsActive = false;
let lastPhysicsTime = 0;

// ============================================
// Constants
// ============================================
const NODE_RADIUS = 48;
const ROOT_NODE_RADIUS = 62;
const SCREEN_HIT_RADIUS = 32;
const DRAG_THRESHOLD = 3;              // px before drag vs click distinction
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5.0;
const CHILD_LAYOUT_RADIUS = 170;
const ROOT_CHILD_LAYOUT_RADIUS = 240;

// ============================================
// DOM element cache
// ============================================
const nodeElements = new Map();   // nodeId -> SVG <g>
const edgeElements = new Map();   // edgeKey -> SVG <path>

// ============================================
// Initialization
// ============================================
export function init() {
  svgEl = document.getElementById('canvas');
  transformLayer = document.getElementById('transform-layer');
  edgesLayer = document.getElementById('edges-layer');
  nodesLayer = document.getElementById('nodes-layer');

  applyTransform();

  // Wheel zoom on SVG
  svgEl.addEventListener('wheel', onWheel, { passive: false });

  // Document-level pointer events for pan and drag
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);

  // Double-click to fit view
  svgEl.addEventListener('dblclick', fitView);
}

// ============================================
// Transform utilities
// ============================================
export function applyTransform() {
  transformLayer.setAttribute('transform', getViewportTransform());
  updateZoomDisplay();
}

function clampZoom(z) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

function zoomAt(cursorSx, cursorSy, factor) {
  const worldBefore = screenToWorld(cursorSx, cursorSy);
  const newZoom = clampZoom(viewport.zoom * factor);
  viewport.panX = cursorSx - worldBefore.x * newZoom;
  viewport.panY = cursorSy - worldBefore.y * newZoom;
  viewport.zoom = newZoom;
  applyTransform();
  renderAllEdges();
}

function updateZoomDisplay() {
  const display = document.getElementById('zoom-display');
  if (display) {
    display.textContent = Math.round(viewport.zoom * 100) + '%';
  }
}

// ============================================
// Hit testing
// ============================================
function hitTestNode(worldX, worldY) {
  const worldRadius = SCREEN_HIT_RADIUS / viewport.zoom;
  const hitThreshold = worldRadius * worldRadius;

  // Iterate in reverse DOM order (top-rendered = last-tested = highest z)
  // For each node, compute distance
  for (const node of graph.nodes.values()) {
    const dx = worldX - node.x;
    const dy = worldY - node.y;
    if (dx * dx + dy * dy <= hitThreshold) {
      return node;
    }
  }
  return null;
}

// ============================================
// Exclusion filter
// ============================================
function isExcludedTarget(e) {
  return (
    e.target.closest('#input-area') ||
    e.target.closest('#history-drawer') ||
    e.target.closest('#controls') ||
    e.target.closest('.drawer-overlay') ||
    e.target.closest('#theme-toggle') ||
    e.target.closest('#history-toggle') ||
    e.target.closest('#toast')
  );
}

function isSVGInside(e) {
  const rect = svgEl.getBoundingClientRect();
  return (
    e.clientX >= rect.left &&
    e.clientX <= rect.right &&
    e.clientY >= rect.top &&
    e.clientY <= rect.bottom
  );
}

// ============================================
// Event handlers
// ============================================
function onWheel(e) {
  e.preventDefault();
  const rect = svgEl.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const factor = e.deltaY > 0 ? 0.9 : 1.1;
  zoomAt(sx, sy, factor);
}

function onPointerDown(e) {
  if (isExcludedTarget(e)) return;
  if (e.button !== 0) return; // left button only

  const rect = svgEl.getBoundingClientRect();
  if (!isSVGInside(e)) return;

  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const world = screenToWorld(sx, sy);
  const hitNode = hitTestNode(world.x, world.y);

  if (hitNode) {
    startNodeDrag(hitNode, e);
  } else {
    startCanvasPan(e);
    // Deselect when clicking empty space
    if (interaction.selectedNodeId !== null) {
      const prevId = interaction.selectedNodeId;
      interaction.selectedNodeId = null;
      updateNodeDOM(nodeById(prevId));
    }
  }
}

function onPointerMove(e) {
  if (interaction.draggingNodeId) {
    handleNodeDrag(e);
    return;
  }

  if (interaction.isPanning) {
    const dx = e.clientX - interaction.lastPointerX;
    const dy = e.clientY - interaction.lastPointerY;
    viewport.panX += dx;
    viewport.panY += dy;
    interaction.lastPointerX = e.clientX;
    interaction.lastPointerY = e.clientY;
    applyTransform();
    renderAllEdges();
    return;
  }
}

function onPointerUp(e) {
  if (interaction.draggingNodeId) {
    endNodeDrag(e);
  }

  if (interaction.isPanning) {
    interaction.isPanning = false;
    svgEl.classList.remove('grabbing');
  }
}

// ============================================
// Canvas panning
// ============================================
function startCanvasPan(e) {
  interaction.isPanning = true;
  interaction.lastPointerX = e.clientX;
  interaction.lastPointerY = e.clientY;
  interaction.dragDistance = 0;
  svgEl.classList.add('grabbing');
}

// ============================================
// Node dragging
// ============================================
function startNodeDrag(node, e) {
  interaction.draggingNodeId = node.id;
  interaction.dragDistance = 0;
  interaction.dragStartX = e.clientX;
  interaction.dragStartY = e.clientY;

  // Visual state
  const el = nodeElements.get(node.id);
  if (el) el.classList.add('dragging');

  // If dragging parent with children, activate physics
  if (node.children.length > 0) {
    activatePhysics(node.id);
    recordParentPosition(node.id, node.x, node.y);
  }

  svgEl.classList.add('grabbing');
}

function handleNodeDrag(e) {
  const node = nodeById(interaction.draggingNodeId);
  if (!node) return;

  const rect = svgEl.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const world = screenToWorld(sx, sy);

  interaction.dragDistance += Math.abs(e.clientX - (interaction._lastX || e.clientX))
    + Math.abs(e.clientY - (interaction._lastY || e.clientY));
  interaction._lastX = e.clientX;
  interaction._lastY = e.clientY;

  node.x = world.x;
  node.y = world.y;

  updateNodePositionDOM(node);

  if (node.children.length > 0) {
    recordParentPosition(node.id, node.x, node.y);
    if (!physicsActive) activatePhysics(node.id);
  }

  updateEdgesForNode(node.id);
  updateIncomingEdgesForNode(node.id);
}

function endNodeDrag(e) {
  const nodeId = interaction.draggingNodeId;
  const node = nodeById(nodeId);

  // Check if it was a click (not a drag)
  if (node && interaction.dragDistance < DRAG_THRESHOLD) {
    handleNodeClick(node);
  }

  // Release drag state
  interaction.draggingNodeId = null;
  interaction._lastX = undefined;
  interaction._lastY = undefined;
  svgEl.classList.remove('grabbing');

  // Remove dragging visual class
  if (node) {
    const el = nodeElements.get(node.id);
    if (el) el.classList.remove('dragging');
  }

  // Let physics coast to settle
  // (physicsActive remains true; rAF loop settles itself)

  if (_onGraphChanged) _onGraphChanged();
}

// ============================================
// Node click handling
// ============================================
function handleNodeClick(node) {
  if (interaction.selectedNodeId === node.id) {
    // Deselect
    interaction.selectedNodeId = null;
    updateNodeDOM(node);
  } else {
    // Deselect previous
    if (interaction.selectedNodeId) {
      const prev = nodeById(interaction.selectedNodeId);
      if (prev) updateNodeDOM(prev);
    }
    // Select this
    interaction.selectedNodeId = node.id;
    updateNodeDOM(node);
  }
}

export function handleExpandClick(nodeId) {
  const node = nodeById(nodeId);
  if (!node) return;

  if (node.expanded) {
    // Fold: hide children
    collapseNode(node);
  } else {
    // Expand: fetch children via callback
    const word = node.zh || node.en;
    if (_onExpandRequest) {
      _onExpandRequest(nodeId, word);
    }
  }
}

function collapseNode(node) {
  // Hide child DOM elements
  for (const childId of node.children) {
    const el = nodeElements.get(childId);
    if (el) el.style.display = 'none';
    // Recursively hide grandchildren
    hideSubtree(childId);
  }
  // Hide edges from this parent
  for (const childId of node.children) {
    const key = `${node.id}->${childId}`;
    const edgeEl = edgeElements.get(key);
    if (edgeEl) edgeEl.style.display = 'none';
  }
}

function hideSubtree(nodeId) {
  const n = nodeById(nodeId);
  if (!n || !n.expanded) return;
  for (const childId of n.children) {
    const el = nodeElements.get(childId);
    if (el) el.style.display = 'none';
    hideSubtree(childId);
  }
}

function expandNode(node) {
  // Show child DOM elements
  for (const childId of node.children) {
    const el = nodeElements.get(childId);
    if (el) el.style.display = '';
    // Recursively show grandchildren that were expanded
    showSubtreeIfExpanded(childId);
  }
  // Show edges
  for (const childId of node.children) {
    const key = `${node.id}->${childId}`;
    const edgeEl = edgeElements.get(key);
    if (edgeEl) edgeEl.style.display = '';
  }
}

function showSubtreeIfExpanded(nodeId) {
  const n = nodeById(nodeId);
  if (!n || !n.expanded) return;
  for (const childId of n.children) {
    const el = nodeElements.get(childId);
    if (el) el.style.display = '';
    showSubtreeIfExpanded(childId);
  }
  // Show edges for expanded children
  for (const childId of n.children) {
    const key = `${nodeId}->${childId}`;
    const edgeEl = edgeElements.get(key);
    if (edgeEl) edgeEl.style.display = '';
  }
}

// ============================================
// Node creation
// ============================================
let nodeIdCounter = 0;
function generateId() {
  return 'n' + Date.now() + '_' + (nodeIdCounter++);
}

export function createRoot(word, pairs) {
  // Clear existing
  clearAll();

  // Create root node at world center (screen center converted to world)
  const centerW = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
  const rootNode = {
    id: generateId(),
    zh: word,
    en: word,
    x: centerW.x,
    y: centerW.y,
    parentId: null,
    children: [],
    expanded: false,
    childCount: 0,
    isRoot: true,
    createdAt: performance.now(),
  };
  addNode(rootNode);
  graph.rootId = rootNode.id;
  graph.rootWord = word;

  renderNodeElement(rootNode);

  // Create child nodes from pairs
  const offsets = computeOffsets(pairs.length, ROOT_CHILD_LAYOUT_RADIUS);
  const childIds = [];
  const now = performance.now();

  for (let i = 0; i < pairs.length; i++) {
    const childNode = {
      id: generateId(),
      zh: pairs[i].zh,
      en: pairs[i].en,
      x: rootNode.x + offsets[i].x,
      y: rootNode.y + offsets[i].y,
      parentId: rootNode.id,
      children: [],
      expanded: false,
      childCount: 0,
      isRoot: false,
      offsetX: offsets[i].x,
      offsetY: offsets[i].y,
      createdAt: now + i * 60, // stagger entry animation
    };
    addNode(childNode);
    childIds.push(childNode.id);

    // Stagger render with tiny delay for entry animation cascade
    setTimeout(() => renderNodeElement(childNode), i * 60);
    setTimeout(() => renderEdge(rootNode.id, childNode.id), i * 60);
  }

  rootNode.children = childIds;
  rootNode.expanded = true;
  rootNode.childCount = childIds.length;

  updateNodeDOM(rootNode);
  hideWelcomeHint();
}

export function createChildren(parentId, pairs) {
  const parent = nodeById(parentId);
  if (!parent || parent.expanded) return;

  const offsets = computeOffsets(pairs.length, CHILD_LAYOUT_RADIUS);
  const childIds = [];
  const now = performance.now();

  for (let i = 0; i < pairs.length; i++) {
    const childNode = {
      id: generateId(),
      zh: pairs[i].zh,
      en: pairs[i].en,
      x: parent.x + offsets[i].x,
      y: parent.y + offsets[i].y,
      parentId: parent.id,
      children: [],
      expanded: false,
      childCount: 0,
      isRoot: false,
      offsetX: offsets[i].x,
      offsetY: offsets[i].y,
      createdAt: now + i * 60,
    };
    addNode(childNode);
    childIds.push(childNode.id);

    setTimeout(() => renderNodeElement(childNode), i * 60);
    setTimeout(() => renderEdge(parent.id, childNode.id), i * 60);
  }

  parent.children = childIds;
  parent.expanded = true;
  parent.childCount = childIds.length;

  // Record undo
  undoStack.push({
    type: 'expand',
    parentId: parent.id,
    childIds: [...childIds],
  });
  if (undoStack.length > MAX_UNDO) undoStack.shift();

  updateNodeDOM(parent);
}

function computeOffsets(count, radius) {
  const offsets = [];
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    offsets.push({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    });
  }
  return offsets;
}

// ============================================
// SVG Rendering
// ============================================
function renderNodeElement(node) {
  // Remove existing element
  const existing = nodeElements.get(node.id);
  if (existing) existing.remove();

  const ns = 'http://www.w3.org/2000/svg';
  const g = document.createElementNS(ns, 'g');
  g.setAttribute('id', `node-${node.id}`);
  g.setAttribute('data-node-id', node.id);
  g.classList.add('node-group');
  if (node.isRoot) g.classList.add('root-node');
  if (node.id === interaction.selectedNodeId) g.classList.add('selected');
  if (node.expanded) g.classList.add('expanded-parent');

  const radius = node.isRoot ? ROOT_NODE_RADIUS : NODE_RADIUS;

  // Glass circle
  const circle = document.createElementNS(ns, 'circle');
  circle.setAttribute('r', radius);
  circle.setAttribute('cx', 0);
  circle.setAttribute('cy', 0);
  circle.classList.add('node-circle');
  g.appendChild(circle);

  // Chinese text
  const zhText = document.createElementNS(ns, 'text');
  zhText.classList.add('node-zh');
  if (node.isRoot) zhText.classList.add('node-root');
  zhText.setAttribute('y', -4);
  zhText.textContent = node.zh;
  g.appendChild(zhText);

  // English text
  const enText = document.createElementNS(ns, 'text');
  enText.classList.add('node-en');
  if (node.isRoot) enText.classList.add('node-root');
  enText.setAttribute('y', 16);
  enText.textContent = node.en;
  g.appendChild(enText);

  // Expand button group (shown on selection)
  const btnGroup = document.createElementNS(ns, 'g');
  btnGroup.classList.add('expand-btn-group');
  btnGroup.setAttribute('transform', `translate(0, ${radius + 22})`);

  const btnBg = document.createElementNS(ns, 'circle');
  btnBg.classList.add('expand-btn-bg');
  btnBg.setAttribute('r', 14);
  btnBg.setAttribute('cx', 0);
  btnBg.setAttribute('cy', 0);
  btnGroup.appendChild(btnBg);

  const btnIcon = document.createElementNS(ns, 'path');
  btnIcon.classList.add('expand-btn-icon');
  if (node.expanded) {
    // Show minus/horiz line for collapse
    btnIcon.setAttribute('d', 'M -6 0 L 6 0');
  } else {
    // Show plus for expand
    btnIcon.setAttribute('d', 'M -6 0 L 6 0 M 0 -6 L 0 6');
  }
  btnGroup.appendChild(btnIcon);

  // Click handler on button
  btnGroup.style.pointerEvents = 'auto';
  btnGroup.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
  btnGroup.addEventListener('pointerup', (e) => {
    e.stopPropagation();
    e.preventDefault();
    handleExpandClick(node.id);
  });

  g.appendChild(btnGroup);

  // Badge for collapsed nodes that have children
  if (node.children.length > 0 && !node.expanded) {
    const badge = createBadgeElement(ns, node.children.length, radius);
    g.appendChild(badge);
  }

  // Entry animation
  g.classList.add('node-enter');

  // Float animation (on inner group so transform-based physics can still work)
  // We use a wrapper: g contains inner float group with all content
  // Actually, simpler: position directly on g with transform, float via separate mechanism
  // For simplicity, float is applied when not dragging
  const floatDuration = 2.5 + Math.random() * 2;
  const floatDelay = Math.random() * 3;
  g.style.setProperty('--float-duration', floatDuration + 's');
  g.style.setProperty('--float-delay', floatDelay + 's');
  g.classList.add('node-float');

  g.addEventListener('animationend', (ev) => {
    if (ev.animationName === 'nodeEnter') {
      g.classList.remove('node-enter');
    }
  });

  // Position
  g.setAttribute('transform', `translate(${node.x}, ${node.y})`);

  nodesLayer.appendChild(g);
  nodeElements.set(node.id, g);
}

function createBadgeElement(ns, count, nodeRadius) {
  const badgeG = document.createElementNS(ns, 'g');
  badgeG.classList.add('node-badge-group');
  badgeG.setAttribute('transform', `translate(${nodeRadius - 4}, ${-nodeRadius + 4})`);

  const circle = document.createElementNS(ns, 'circle');
  circle.classList.add('node-badge');
  circle.setAttribute('r', 11);
  circle.setAttribute('cx', 0);
  circle.setAttribute('cy', 0);
  badgeG.appendChild(circle);

  const text = document.createElementNS(ns, 'text');
  text.classList.add('node-badge-text');
  text.textContent = count > 99 ? '99+' : String(count);
  badgeG.appendChild(text);

  return badgeG;
}

export function updateNodeDOM(node) {
  const g = nodeElements.get(node.id);
  if (!g) return;

  const radius = node.isRoot ? ROOT_NODE_RADIUS : NODE_RADIUS;

  // Update selection class
  if (node.id === interaction.selectedNodeId) {
    g.classList.add('selected');
  } else {
    g.classList.remove('selected');
  }

  // Update expanded class
  if (node.expanded) {
    g.classList.add('expanded-parent');
  } else {
    g.classList.remove('expanded-parent');
  }

  // Update expand button icon
  const btnGroup = g.querySelector('.expand-btn-group');
  if (btnGroup) {
    btnGroup.setAttribute('transform', `translate(0, ${radius + 22})`);
    const btnIcon = btnGroup.querySelector('.expand-btn-icon');
    if (btnIcon && node.expanded) {
      btnIcon.setAttribute('d', 'M -6 0 L 6 0');
    } else if (btnIcon) {
      btnIcon.setAttribute('d', 'M -6 0 L 6 0 M 0 -6 L 0 6');
    }
  }

  // Update badge
  const existingBadge = g.querySelector('.node-badge-group');
  if (existingBadge) existingBadge.remove();

  if (node.children.length > 0 && !node.expanded) {
    const ns = 'http://www.w3.org/2000/svg';
    const badge = createBadgeElement(ns, node.children.length, radius);
    g.appendChild(badge);
  }

  updateNodePositionDOM(node);
}

function updateNodePositionDOM(node) {
  const g = nodeElements.get(node.id);
  if (!g) return;
  g.setAttribute('transform', `translate(${node.x}, ${node.y})`);
}

function renderEdge(parentId, childId) {
  const key = `${parentId}->${childId}`;
  const existing = edgeElements.get(key);
  if (existing) existing.remove();

  const ns = 'http://www.w3.org/2000/svg';
  const path = document.createElementNS(ns, 'path');
  path.classList.add('edge-path');
  path.setAttribute('data-edge', key);

  const pNode = nodeById(parentId);
  const cNode = nodeById(childId);
  if (pNode && cNode) {
    path.setAttribute('d', buildEdgePath(pNode, cNode));
  }

  edgesLayer.appendChild(path);
  edgeElements.set(key, path);
}

function updateEdgeDOM(parentId, childId) {
  const key = `${parentId}->${childId}`;
  const path = edgeElements.get(key);
  if (!path) return;

  const pNode = nodeById(parentId);
  const cNode = nodeById(childId);
  if (pNode && cNode) {
    path.setAttribute('d', buildEdgePath(pNode, cNode));
  }
}

export function buildEdgePath(parent, child) {
  const x1 = parent.x;
  const y1 = parent.y;
  const x2 = child.x;
  const y2 = child.y;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const offset = Math.min(dist * 0.35, 80);

  const nx = dist > 0.01 ? -dy / dist : 0;
  const ny = dist > 0.01 ? dx / dist : 0;

  const cp1x = x1 + dx * 0.25 + nx * offset;
  const cp1y = y1 + dy * 0.25 + ny * offset;
  const cp2x = x2 - dx * 0.25 - nx * offset;
  const cp2y = y2 - dy * 0.25 - ny * offset;

  return `M ${x1},${y1} C ${cp1x},${cp1y} ${cp2x},${cp2y} ${x2},${y2}`;
}

function renderAllEdges() {
  for (const [key, path] of edgeElements) {
    const [pId, cId] = key.split('->');
    const pNode = nodeById(pId);
    const cNode = nodeById(cId);
    if (pNode && cNode) {
      path.setAttribute('d', buildEdgePath(pNode, cNode));
    }
  }
}

function updateEdgesForNode(parentId) {
  const node = nodeById(parentId);
  if (!node) return;

  for (const childId of node.children) {
    updateEdgeDOM(parentId, childId);
    // Also update edges from this child to its children
    updateEdgesForNode(childId);
  }
}

function updateIncomingEdgesForNode(nodeId) {
  const node = nodeById(nodeId);
  if (!node || !node.parentId) return;

  updateEdgeDOM(node.parentId, nodeId);
  updateIncomingEdgesForNode(node.parentId);
}

// ============================================
// Physics
// ============================================
function recordParentPosition(parentId, x, y) {
  let history = parentHistory.get(parentId);
  if (!history) {
    history = [];
    parentHistory.set(parentId, history);
  }
  history.push({ x, y, time: performance.now() });

  while (history.length > HISTORY_MAX_LENGTH) history.shift();
  while (history.length > 1 && history[0].time < performance.now() - HISTORY_MAX_AGE) {
    history.shift();
  }
}

function getDelayedParentPosition(parentId, delayMs) {
  const history = parentHistory.get(parentId);
  if (!history || history.length === 0) {
    const parent = nodeById(parentId);
    return parent ? { x: parent.x, y: parent.y } : { x: 0, y: 0 };
  }

  const targetTime = performance.now() - delayMs;

  let before = history[0];
  for (let i = 1; i < history.length; i++) {
    const entry = history[i];
    if (entry.time >= targetTime) {
      const range = entry.time - before.time;
      if (range > 0.001) {
        const t = (targetTime - before.time) / range;
        return {
          x: before.x + (entry.x - before.x) * t,
          y: before.y + (entry.y - before.y) * t,
        };
      }
      return { x: entry.x, y: entry.y };
    }
    before = entry;
  }
  return { x: history[0].x, y: history[0].y };
}

function activatePhysics(parentId) {
  const parent = nodeById(parentId);
  if (!parent) return;

  for (const childId of parent.children) {
    if (physicsObjects.has(childId)) continue;

    const child = nodeById(childId);
    if (!child) continue;

    const index = parent.children.indexOf(childId);
    physicsObjects.set(childId, {
      nodeId: childId,
      parentId,
      offsetX: child.offsetX,
      offsetY: child.offsetY,
      stiffness: 0.07 + Math.random() * 0.02,
      damping: -0.32 - index * 0.018,
      staggerDelay: index * 40,
      collisionK: 0.12,
      vx: 0,
      vy: 0,
    });
  }

  if (!physicsActive) {
    physicsActive = true;
    lastPhysicsTime = performance.now();
    requestAnimationFrame(physicsTick);
  }
}

function physicsTick(timestamp) {
  if (!physicsActive) return;

  const rawDt = (timestamp - lastPhysicsTime) / 1000;
  const dt = Math.min(rawDt, 0.05);
  lastPhysicsTime = timestamp;

  let anyMoving = false;
  const MOVING_THRESHOLD = 0.008;
  const POSITION_THRESHOLD = 0.04;
  const MIN_DIST = 70;
  const collisionThreshold = MIN_DIST * MIN_DIST;

  // If not dragging and no physics objects, stop
  if (physicsObjects.size === 0 && !interaction.draggingNodeId) {
    physicsActive = false;
    return;
  }

  for (const [childId, body] of physicsObjects) {
    const child = nodeById(childId);
    if (!child) {
      physicsObjects.delete(childId);
      continue;
    }

    const parent = nodeById(body.parentId);
    if (!parent) {
      physicsObjects.delete(childId);
      continue;
    }

    // Desired position
    let desiredX, desiredY;
    if (interaction.draggingNodeId === body.parentId) {
      const delayed = getDelayedParentPosition(body.parentId, body.staggerDelay);
      desiredX = delayed.x + body.offsetX;
      desiredY = delayed.y + body.offsetY;
    } else {
      desiredX = parent.x + body.offsetX;
      desiredY = parent.y + body.offsetY;
    }

    const dx = desiredX - child.x;
    const dy = desiredY - child.y;

    let ax = body.stiffness * dx + body.damping * body.vx;
    let ay = body.stiffness * dy + body.damping * body.vy;

    // Collision avoidance with siblings
    const siblings = parent.children;
    for (const sibId of siblings) {
      if (sibId === childId) continue;
      const sib = nodeById(sibId);
      if (!sib) continue;

      const sdx = child.x - sib.x;
      const sdy = child.y - sib.y;
      const distSq = sdx * sdx + sdy * sdy;

      if (distSq < collisionThreshold && distSq > 0.01) {
        const dist = Math.sqrt(distSq);
        const overlap = MIN_DIST - dist;
        const nx = sdx / dist;
        const ny = sdy / dist;
        ax += nx * overlap * body.collisionK;
        ay += ny * overlap * body.collisionK;
      }
    }

    // Semi-implicit Euler
    body.vx += ax * dt;
    body.vy += ay * dt;
    child.x += body.vx * dt;
    child.y += body.vy * dt;

    updateNodePositionDOM(child);

    const speed = Math.sqrt(body.vx * body.vx + body.vy * body.vy);
    const distToTarget = Math.sqrt(dx * dx + dy * dy);
    if (speed > MOVING_THRESHOLD || distToTarget > POSITION_THRESHOLD) {
      anyMoving = true;
    }

    // Update edges for this child
    if (child.children.length > 0) {
      updateEdgesForNode(child.id);
    }
    if (child.parentId) {
      updateEdgeDOM(child.parentId, child.id);
    }
  }

  // If parent is not being dragged and everything is settled, stop
  if (!anyMoving && !interaction.draggingNodeId) {
    // Snap all to exact positions
    for (const [childId, body] of physicsObjects) {
      const child = nodeById(childId);
      const parent = nodeById(body.parentId);
      if (child && parent) {
        child.x = parent.x + body.offsetX;
        child.y = parent.y + body.offsetY;
        body.vx = 0;
        body.vy = 0;
        updateNodePositionDOM(child);
      }
      // Update edges
      const c = nodeById(childId);
      if (c && c.parentId) updateEdgeDOM(c.parentId, childId);
      if (c) updateEdgesForNode(childId);
    }
    physicsObjects.clear();
    parentHistory.clear();
    physicsActive = false;
    return;
  }

  requestAnimationFrame(physicsTick);
}

// ============================================
// Undo
// ============================================
export function undoLastExpand() {
  const action = undoStack.pop();
  if (!action) return;

  const parent = nodeById(action.parentId);
  if (!parent) return;

  // Remove child nodes
  for (const childId of action.childIds) {
    removeSubtree(childId);
    const el = nodeElements.get(childId);
    if (el) el.remove();
    nodeElements.delete(childId);

    // Remove child's edges (from it to its children)
    for (const [key, edgeEl] of edgeElements) {
      if (key.startsWith(childId + '->')) {
        edgeEl.remove();
        edgeElements.delete(key);
      }
    }
  }

  // Remove edges from parent to these children
  for (const childId of action.childIds) {
    const key = `${action.parentId}->${childId}`;
    const edgeEl = edgeElements.get(key);
    if (edgeEl) {
      edgeEl.remove();
      edgeElements.delete(key);
    }
  }

  parent.children = [];
  parent.expanded = false;
  parent.childCount = 0;

  // Deselect if selected node was in removed subtree
  if (interaction.selectedNodeId && !nodeById(interaction.selectedNodeId)) {
    interaction.selectedNodeId = null;
  }

  updateNodeDOM(parent);
}

// ============================================
// Clear all
// ============================================
export function clearAll() {
  graph.nodes.clear();
  graph.rootId = null;
  graph.rootWord = '';
  undoStack.length = 0;
  interaction.selectedNodeId = null;
  interaction.draggingNodeId = null;
  interaction.isPanning = false;
  physicsObjects.clear();
  parentHistory.clear();
  physicsActive = false;

  // Clear DOM
  while (nodesLayer.firstChild) nodesLayer.firstChild.remove();
  while (edgesLayer.firstChild) edgesLayer.firstChild.remove();
  nodeElements.clear();
  edgeElements.clear();

  showWelcomeHint();
}

// ============================================
// Fit view
// ============================================
export function fitView() {
  if (graph.nodes.size === 0) {
    viewport.panX = 0;
    viewport.panY = 0;
    viewport.zoom = 1;
    applyTransform();
    renderAllEdges();
    return;
  }

  // Compute bounds of all nodes
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of allNodes()) {
    const r = node.isRoot ? ROOT_NODE_RADIUS : NODE_RADIUS;
    minX = Math.min(minX, node.x - r);
    minY = Math.min(minY, node.y - r);
    maxX = Math.max(maxX, node.x + r);
    maxY = Math.max(maxY, node.y + r);
  }

  const graphW = maxX - minX;
  const graphH = maxY - minY;
  const padding = 80;

  const svgW = svgEl.clientWidth;
  const svgH = svgEl.clientHeight;

  const scaleX = (svgW - padding * 2) / graphW;
  const scaleY = (svgH - padding * 2) / graphH;
  const newZoom = clampZoom(Math.min(scaleX, scaleY));

  // Center the graph
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  viewport.zoom = newZoom;
  viewport.panX = svgW / 2 - centerX * newZoom;
  viewport.panY = svgH / 2 - centerY * newZoom;

  applyTransform();
  renderAllEdges();
}

// ============================================
// Welcome hint
// ============================================
function showWelcomeHint() {
  const hint = document.getElementById('welcome-hint');
  if (hint) hint.classList.remove('hidden');
}

function hideWelcomeHint() {
  const hint = document.getElementById('welcome-hint');
  if (hint) hint.classList.add('hidden');
}

// ============================================
// Restore from history (rebuild all DOM)
// ============================================
export function rebuildAllDOM() {
  // Clear DOM
  while (nodesLayer.firstChild) nodesLayer.firstChild.remove();
  while (edgesLayer.firstChild) edgesLayer.firstChild.remove();
  nodeElements.clear();
  edgeElements.clear();

  // Rebuild all nodes
  for (const node of allNodes()) {
    renderNodeElement(node);
  }

  // Rebuild all edges
  for (const node of allNodes()) {
    if (node.parentId) {
      renderEdge(node.parentId, node.id);
    }
  }

  hideWelcomeHint();
  applyTransform();
}

// ============================================
// Show loading state on node
// ============================================
export function setNodeLoading(nodeId, loading) {
  const g = nodeElements.get(nodeId);
  if (!g) return;

  if (loading) {
    const ns = 'http://www.w3.org/2000/svg';
    const existing = g.querySelector('.node-loading-ring');
    if (existing) return;

    const node = nodeById(nodeId);
    const radius = node && node.isRoot ? ROOT_NODE_RADIUS : NODE_RADIUS;

    const ring = document.createElementNS(ns, 'circle');
    ring.classList.add('node-loading-ring');
    ring.setAttribute('r', radius + 4);
    ring.setAttribute('cx', 0);
    ring.setAttribute('cy', 0);
    g.appendChild(ring);
  } else {
    const ring = g.querySelector('.node-loading-ring');
    if (ring) ring.remove();
  }
}

// ============================================
// Show toast message
// ============================================
export function showToast(msg, duration = 3000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => {
    toast.classList.add('hidden');
  }, duration);
}
