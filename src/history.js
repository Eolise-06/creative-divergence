import { serializeGraph } from './state.js';

const KEY_HISTORY = 'creative-muse-history';
const MAX_ENTRIES = 50;

export function loadAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY_HISTORY) || '[]');
  } catch {
    return [];
  }
}

function saveAll(entries) {
  try {
    localStorage.setItem(KEY_HISTORY, JSON.stringify(entries));
  } catch {
    // localStorage full — remove oldest entries
    const trimmed = entries.slice(0, MAX_ENTRIES);
    localStorage.setItem(KEY_HISTORY, JSON.stringify(trimmed));
  }
}

export function updateLatestHistory(word, snapshot) {
  const entries = loadAll();

  // Requirement #23: verify word matches history[0].word before updating in-place
  if (entries.length > 0 && entries[0].word === word) {
    entries[0].timestamp = Date.now();
    entries[0].snapshot = snapshot;
    saveAll(entries);
    return;
  }

  // New entry or different word — prepend
  entries.unshift({
    id: generateId(),
    word,
    timestamp: Date.now(),
    snapshot: snapshot || serializeGraph(),
  });

  // Deduplicate by word (keep newest)
  const seen = new Set();
  const deduped = [];
  for (const e of entries) {
    if (!seen.has(e.word)) {
      seen.add(e.word);
      deduped.push(e);
    }
  }
  saveAll(deduped.slice(0, MAX_ENTRIES));
}

export function deleteEntry(id) {
  const entries = loadAll().filter((e) => e.id !== id);
  saveAll(entries);
}

function generateId() {
  return 'h' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return diffMin + '分钟前';
  if (diffMin < 1440) return Math.floor(diffMin / 60) + '小时前';

  const month = d.getMonth() + 1;
  const day = d.getDate();
  return month + '/' + day;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

let onRestoreCallback = null;

export function renderDrawer(onRestore) {
  onRestoreCallback = onRestore;
  const entries = loadAll();
  const list = document.getElementById('drawer-list');
  if (!list) return;

  if (entries.length === 0) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = entries
    .map(
      (e) => `
    <div class="history-item" data-id="${escapeHtml(e.id)}">
      <span class="history-word">${escapeHtml(e.word)}</span>
      <span class="history-time">${formatTime(e.timestamp)}</span>
      <button class="history-restore" data-action="restore" title="恢复">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
        </svg>
      </button>
      <button class="history-delete" data-action="delete" title="删除">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>`
    )
    .join('');

  // Delegate click events
  list.onclick = (e) => {
    const item = e.target.closest('.history-item');
    if (!item) return;
    const id = item.dataset.id;

    if (e.target.closest('[data-action="restore"]')) {
      if (onRestoreCallback) onRestoreCallback(id);
      closeDrawer();
    } else if (e.target.closest('[data-action="delete"]')) {
      deleteEntry(id);
      renderDrawer(onRestore);
    }
  };
}

// ============================================
// Drawer open/close
// ============================================
export function openDrawer() {
  const drawer = document.getElementById('history-drawer');
  const overlay = document.getElementById('drawer-overlay');
  if (drawer) drawer.classList.remove('closed');
  if (overlay) overlay.classList.remove('hidden');
  renderDrawer(onRestoreCallback);
}

export function closeDrawer() {
  const drawer = document.getElementById('history-drawer');
  const overlay = document.getElementById('drawer-overlay');
  if (drawer) drawer.classList.add('closed');
  if (overlay) overlay.classList.add('hidden');
}

export function toggleDrawer() {
  const drawer = document.getElementById('history-drawer');
  if (drawer && !drawer.classList.contains('closed')) {
    closeDrawer();
  } else {
    openDrawer();
  }
}

export function init() {
  const toggleBtn = document.getElementById('history-toggle');
  const closeBtn = document.getElementById('drawer-close');
  const overlay = document.getElementById('drawer-overlay');

  if (toggleBtn) toggleBtn.addEventListener('click', toggleDrawer);
  if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
  if (overlay) overlay.addEventListener('click', closeDrawer);

  // Close drawer on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  // Start closed
  const drawer = document.getElementById('history-drawer');
  if (drawer) drawer.classList.add('closed');
  if (overlay) overlay.classList.add('hidden');
}
