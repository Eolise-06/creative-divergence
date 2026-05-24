let mode = 'center'; // 'center' | 'docked'
let onSubmitCallback = null;

export function init(onSubmit) {
  onSubmitCallback = onSubmit;

  const form = document.getElementById('input-form');
  const input = document.getElementById('word-input');
  const errorEl = document.getElementById('input-error');
  const submitBtn = document.getElementById('submit-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const word = input.value.trim();

    if (!word) {
      showError('请输入一个词语');
      return;
    }

    if (word.length > 30) {
      showError('词语过长，最多30个字符');
      return;
    }

    hideError();

    // Show loading
    submitBtn.disabled = true;
    submitBtn.classList.add('loading');

    try {
      await onSubmitCallback(word);
    } catch (err) {
      showError(err.message || '请求失败，请重试');
    } finally {
      submitBtn.disabled = false;
      submitBtn.classList.remove('loading');
    }
  });

  // Clear error on input
  input.addEventListener('input', () => {
    hideError();
  });
}

function showError(msg) {
  const errorEl = document.getElementById('input-error');
  if (errorEl) {
    errorEl.textContent = msg;
    errorEl.style.opacity = '1';
  }
}

function hideError() {
  const errorEl = document.getElementById('input-error');
  if (errorEl) {
    errorEl.style.opacity = '0';
    errorEl.textContent = '';
  }
}

export function setMode(newMode) {
  mode = newMode;
  const container = document.getElementById('input-area');
  if (!container) return;

  if (mode === 'center') {
    container.classList.add('input-center');
    container.classList.remove('input-docked');
  } else {
    container.classList.remove('input-center');
    container.classList.add('input-docked');
  }
}

export function transitionToDocked() {
  setMode('docked');
}

export function getMode() {
  return mode;
}
