import * as graphMod from './graph.js';
import * as inputMod from './input.js';
import * as historyMod from './history.js';
import * as stateMod from './state.js';
import { expandWord } from './api.js';

const {
  init: initGraph, createRoot, createChildren, undoLastExpand,
  clearAll, rebuildAllDOM, fitView, setNodeLoading, showToast, zoomAt,
  setOnExpandRequest, setOnGraphChanged,
} = graphMod;

const { init: initInput, setMode, transitionToDocked } = inputMod;
const { init: initHistory, renderDrawer, updateLatestHistory, loadAll } = historyMod;
const { graph, serializeGraph, restoreGraph, interaction } = stateMod;

// ============================================
// Theme
// ============================================
const KEY_THEME = 'creative-muse-theme';

function initTheme() {
  const saved = localStorage.getItem(KEY_THEME);
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
  } else {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  }

  document.getElementById('theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(KEY_THEME, next);
  });
}

// ============================================
// Handlers
// ============================================
async function onWordSubmit(word) {
  const pairs = await expandWord(word);
  createRoot(word, pairs);
  setMode('docked');
  updateLatestHistory(word, serializeGraph());
  renderDrawer(onHistoryRestore);
}

async function onNodeExpand(nodeId, word) {
  setNodeLoading(nodeId, true);
  try {
    const pairs = await expandWord(word);
    createChildren(nodeId, pairs);
    updateLatestHistory(graph.rootWord, serializeGraph());
    renderDrawer(onHistoryRestore);
  } catch (err) {
    showToast(err.message || '联想失败，请重试');
  } finally {
    setNodeLoading(nodeId, false);
  }
}

function onHistoryRestore(id) {
  const entries = loadAll();
  const entry = entries.find((e) => e.id === id);
  if (!entry || !entry.snapshot) return;
  clearAll();
  restoreGraph(entry.snapshot);
  rebuildAllDOM();
  transitionToDocked();
}

// ============================================
// Controls
// ============================================
function initControls() {
  const svgEl = document.getElementById('canvas');

  document.getElementById('ctrl-zoom-in').addEventListener('click', () => {
    zoomAt(svgEl.clientWidth / 2, svgEl.clientHeight / 2, 1.25);
  });

  document.getElementById('ctrl-zoom-out').addEventListener('click', () => {
    zoomAt(svgEl.clientWidth / 2, svgEl.clientHeight / 2, 0.8);
  });

  document.getElementById('ctrl-fit').addEventListener('click', fitView);

  document.getElementById('ctrl-clear').addEventListener('click', () => {
    if (graph.nodes.size === 0) return;
    if (confirm('确定要清空画布吗？')) clearAll();
  });
}

// ============================================
// Keyboard
// ============================================
function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'z' && !e.target.closest('input')) {
      e.preventDefault();
      undoLastExpand();
      if (graph.rootWord) {
        updateLatestHistory(graph.rootWord, serializeGraph());
        renderDrawer(onHistoryRestore);
      }
    }

    if (e.key === 'Escape' && interaction.selectedNodeId) {
      const prevId = interaction.selectedNodeId;
      interaction.selectedNodeId = null;
      const n = stateMod.nodeById(prevId);
      if (n) graphMod.updateNodeDOM(n);
    }
  });
}

// ============================================
// Init
// ============================================
(function init() {
  initTheme();
  initGraph();
  initInput(onWordSubmit);
  initHistory();
  initControls();
  initKeyboard();

  // Register graph callbacks
  setOnExpandRequest(onNodeExpand);
  setOnGraphChanged(() => {
    if (graph.rootWord) {
      updateLatestHistory(graph.rootWord, serializeGraph());
      renderDrawer(onHistoryRestore);
    }
  });

  renderDrawer(onHistoryRestore);
})();
