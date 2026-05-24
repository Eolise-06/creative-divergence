export const graph = {
  nodes: new Map(),
  rootId: null,
  rootWord: '',
};

export const viewport = {
  panX: 0,
  panY: 0,
  zoom: 1,
};

export const interaction = {
  selectedNodeId: null,
  draggingNodeId: null,
  isPanning: false,
  lastPointerX: 0,
  lastPointerY: 0,
  dragDistance: 0,
};

export const undoStack = [];
export const MAX_UNDO = 50;

export function allNodes() {
  return graph.nodes.values();
}

export function rootNode() {
  return graph.nodes.get(graph.rootId);
}

export function nodeById(id) {
  return graph.nodes.get(id);
}

export function addNode(node) {
  graph.nodes.set(node.id, node);
}

export function removeSubtree(nodeId) {
  const node = graph.nodes.get(nodeId);
  if (!node) return;
  for (const childId of node.children) {
    removeSubtree(childId);
  }
  graph.nodes.delete(nodeId);
}

export function serializeGraph() {
  return {
    nodes: Array.from(graph.nodes.entries()),
    rootId: graph.rootId,
    rootWord: graph.rootWord,
    panX: viewport.panX,
    panY: viewport.panY,
    zoom: viewport.zoom,
  };
}

export function restoreGraph(snapshot) {
  graph.nodes = new Map(snapshot.nodes);
  graph.rootId = snapshot.rootId;
  graph.rootWord = snapshot.rootWord;
  viewport.panX = snapshot.panX;
  viewport.panY = snapshot.panY;
  viewport.zoom = snapshot.zoom;
}

export function worldToScreen(wx, wy) {
  return {
    x: wx * viewport.zoom + viewport.panX,
    y: wy * viewport.zoom + viewport.panY,
  };
}

export function screenToWorld(sx, sy) {
  return {
    x: (sx - viewport.panX) / viewport.zoom,
    y: (sy - viewport.panY) / viewport.zoom,
  };
}

export function getViewportTransform() {
  return `translate(${viewport.panX}, ${viewport.panY}) scale(${viewport.zoom})`;
}
