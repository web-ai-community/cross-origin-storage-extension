// Copyright 2026 Google LLC.
// SPDX-License-Identifier: Apache-2.0

// Groups of characters used to probe which glyphs a font actually contains.
// Each group has a name, a short sample for the coverage label, and a larger
// test string iterated character-by-character against the canvas.
const CHAR_GROUPS = [
  {
    name: 'Basic Latin',
    test: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  },
  {
    name: 'Digits & Symbols',
    test: '0123456789.,!?;:\'"()[]{}/@#$%&*+-=<>',
  },
  {
    name: 'Latin Extended',
    test: 'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝßàáâãäåæçèéêëìíîïñòóôõöøùúûüýÿ',
  },
  {
    name: 'Greek',
    test: 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω',
  },
  {
    name: 'Cyrillic',
    test: 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЫЭЮЯабвгдеёжзийклмнопрстуфхцчшщыэюя',
  },
  {
    name: 'Arabic',
    test: 'ابتثجحخدذرزسشصضطظعغفقكلمنهوي',
  },
  {
    name: 'Hebrew',
    test: 'אבגדהוזחטיכלמנסעפצקרשת',
  },
  {
    name: 'Devanagari',
    test: 'अआइईउऊएऐओऔकखगघचछजझटठडढणतथदधनपफबभमयरलवशषसह',
  },
  {
    name: 'CJK',
    test: '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成',
  },
  {
    name: 'Emoji',
    test: '😀😂😍🤔😎🎉🌍❤✅🔥🚀💡🎵🌟🎨',
  },
];

// Returns, for a loaded font family, the subset of each group's characters
// that the font actually renders itself (vs. falling back to system fonts).
// Uses a canvas pixel-difference technique: if drawing a character with
// "ourFont, fakeFallback" differs from "fakeFallback" alone, the font has a
// glyph for that character.
function detectCoverage(fontFamily) {
  const canvas = document.createElement('canvas');
  canvas.width = 24;
  canvas.height = 24;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const FAKE = '"__cos_no_such_font__", monospace';

  function alphaSum(imageData) {
    let s = 0;
    for (let i = 3; i < imageData.data.length; i += 4) s += imageData.data[i];
    return s;
  }

  function hasGlyph(char) {
    ctx.clearRect(0, 0, 24, 24);
    ctx.font = `18px "${fontFamily}", ${FAKE}`;
    ctx.fillStyle = '#000';
    ctx.fillText(char, 2, 18);
    const withFont = alphaSum(ctx.getImageData(0, 0, 24, 24));

    ctx.clearRect(0, 0, 24, 24);
    ctx.font = `18px ${FAKE}`;
    ctx.fillText(char, 2, 18);
    const withFallback = alphaSum(ctx.getImageData(0, 0, 24, 24));

    return withFont !== withFallback;
  }

  return CHAR_GROUPS.map((group) => ({
    name: group.name,
    covered: [...group.test].filter(hasGlyph),
  })).filter((g) => g.covered.length >= 4);
}

async function renderFont(container, dataURL) {
  const fontFamily = `cos-preview-${Date.now()}`;
  const fontFace = new FontFace(fontFamily, `url("${dataURL}")`);

  try {
    await fontFace.load();
  } catch (err) {
    const p = document.createElement('p');
    p.className = 'viewer-error';
    p.textContent = `Could not load font: ${err.message}`;
    container.append(p);
    return;
  }
  document.fonts.add(fontFace);

  const groups = detectCoverage(fontFamily);

  if (groups.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'No recognizable glyphs detected.';
    container.append(p);
    return;
  }

  const summary = document.createElement('p');
  summary.className = 'font-coverage';
  summary.textContent = `Detected: ${groups.map((g) => g.name).join(', ')}`;
  container.append(summary);

  const hasLatin = groups.some((g) => g.name === 'Basic Latin');
  const digitsGroup = groups.find((g) => g.name === 'Digits & Symbols');

  function sampleRow(px, text, label, dir) {
    const row = document.createElement('div');
    row.className = 'font-sample-row';
    if (label) {
      const l = document.createElement('span');
      l.className = 'font-sample-label';
      l.textContent = label;
      row.append(l);
    }
    const s = document.createElement('span');
    s.className = 'font-sample-text';
    s.style.cssText = `font-size: ${px}px; font-family: "${fontFamily}", serif;`;
    if (dir) s.dir = dir;
    s.textContent = text;
    row.append(s);
    return row;
  }

  // Large display: first covered chars across all groups
  const displayChars = groups.flatMap((g) => g.covered).slice(0, 14).join('');
  container.append(sampleRow(48, displayChars, ''));

  if (hasLatin) {
    container.append(sampleRow(28, 'The quick brown fox jumps over the lazy dog', ''));
    container.append(sampleRow(20, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'Uppercase'));
    container.append(sampleRow(20, 'abcdefghijklmnopqrstuvwxyz', 'Lowercase'));
  }
  if (digitsGroup) {
    container.append(sampleRow(20, digitsGroup.covered.join(''), 'Digits & Symbols'));
  }
  for (const g of groups) {
    if (g.name === 'Basic Latin' || g.name === 'Digits & Symbols') continue;
    const dir = ['Arabic', 'Hebrew'].includes(g.name) ? 'rtl' : undefined;
    container.append(sampleRow(24, g.covered.slice(0, 40).join(''), g.name, dir));
  }
}

function renderImage(container, dataURL) {
  const wrap = document.createElement('div');
  wrap.className = 'image-preview';
  const img = document.createElement('img');
  img.src = dataURL;
  img.alt = 'Resource preview';
  wrap.append(img);
  container.append(wrap);
}

function renderText(container, text) {
  const pre = document.createElement('pre');
  pre.textContent = text;
  container.append(pre);
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function getExtensionFromMimeType(mimeType) {
  const base = (mimeType || '').split(';')[0].trim().toLowerCase();
  const overrides = {
    'image/jpeg': '.jpg',
    'image/svg+xml': '.svg',
    'audio/mpeg': '.mp3',
    'application/octet-stream': '.bin',
    'text/javascript': '.js',
  };
  if (overrides[base]) return overrides[base];
  const subtype = base.split('/')[1] || '';
  return subtype ? `.${subtype}` : '';
}

function formatTimestamp(tsString) {
  return new Date(tsString).toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function renderUsage(container, origins, accessHistory) {
  if (origins.length === 0) {
    const p = document.createElement('p');
    p.className = 'never-accessed-note';
    p.textContent = 'Manually added — no access recorded yet.';
    container.append(p);
    return;
  }

  const h3 = document.createElement('h3');
  h3.textContent = `Used by ${origins.length} origin${origins.length !== 1 ? 's' : ''}`;
  container.append(h3);

  for (const origin of origins) {
    const timestamps = accessHistory[origin] || [];
    const wrap = document.createElement('div');
    wrap.className = 'usage-origin';

    const name = document.createElement('div');
    name.className = 'usage-origin-name';
    name.textContent = origin;
    wrap.append(name);

    if (timestamps.length > 0) {
      const ul = document.createElement('ul');
      ul.className = 'usage-timestamps';
      for (const ts of timestamps) {
        const li = document.createElement('li');
        li.textContent = formatTimestamp(ts);
        ul.append(li);
      }
      wrap.append(ul);
    } else {
      const note = document.createElement('span');
      note.className = 'usage-timestamps';
      note.style.color = 'light-dark(#888, #aaa)';
      note.textContent = 'No access recorded';
      wrap.append(note);
    }

    container.append(wrap);
  }
}

function showDeleteDialog(origins) {
  return new Promise((resolve) => {
    const msg = document.getElementById('dialog-message');
    msg.innerHTML = '';

    const h1 = document.createElement('h1');
    h1.textContent = 'Are you sure you want to delete this resource?';
    msg.append(h1);

    if (origins.length > 0) {
      const p = document.createElement('p');
      p.textContent = `This resource is used by the following ${origins.length === 1 ? 'origin' : 'origins'}:`;
      const ul = document.createElement('ul');
      for (const origin of origins) {
        const li = document.createElement('li');
        li.textContent = origin;
        ul.append(li);
      }
      msg.append(p, ul);
    }

    const dialog = document.getElementById('delete-dialog');
    const closeListener = () => {
      dialog.removeEventListener('close', closeListener);
      resolve(dialog.returnValue === 'confirm');
    };
    dialog.addEventListener('close', closeListener);
    dialog.showModal();
  });
}

let toastTimer;
function showToast(message) {
  const toast = document.getElementById('toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

async function saveResource(hash, mimeType) {
  const cosCache = await caches.open('cos-storage');
  const response = await cosCache.match(`https://cos.example.com/SHA-256_${hash}`);
  if (!response) {
    showToast('Resource not found in cache.');
    return;
  }
  const blob = await response.blob();
  const ext = getExtensionFromMimeType(mimeType);
  const pickerOpts = { suggestedName: `resource-${hash.slice(0, 8)}${ext}` };
  if (ext) {
    pickerOpts.types = [{ description: 'Resource file', accept: { [mimeType]: [ext] } }];
  }
  try {
    const fileHandle = await showSaveFilePicker(pickerOpts);
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    showToast('Resource saved to disk.');
  } catch (err) {
    if (err.name !== 'AbortError') showToast(`Error saving file: ${err.message}`);
  }
}

(async () => {
  const params = new URLSearchParams(location.search);
  const hash = params.get('hash');

  const loading = document.getElementById('loading');
  const viewer = document.getElementById('viewer');
  const metaMime = document.getElementById('meta-mime');
  const metaSize = document.getElementById('meta-size');
  const metaHash = document.getElementById('meta-hash');
  const contentArea = document.getElementById('content-area');

  if (!hash) {
    loading.textContent = 'No resource hash specified.';
    return;
  }

  let result;
  try {
    result = await chrome.runtime.sendMessage({
      action: 'getResourceForViewer',
      data: { hash },
    });
  } catch (err) {
    loading.textContent = `Error communicating with extension: ${err.message}`;
    return;
  }

  if (result?.error || !result?.data) {
    loading.textContent = result?.error ?? 'Resource not found.';
    return;
  }

  const { mimeType, text, dataURL, size, origins = [], accessHistory = {} } = result.data;

  document.title = `COS Viewer — ${mimeType || 'unknown'} (${hash.slice(0, 8)}…)`;
  loading.hidden = true;
  viewer.hidden = false;

  metaMime.textContent = mimeType || 'unknown type';
  if (size != null) metaSize.textContent = formatBytes(size);
  metaHash.textContent = hash;

  renderUsage(document.getElementById('usage-section'), origins, accessHistory);

  const copyBtn = document.getElementById('copy-btn');
  const saveBtn = document.getElementById('save-btn');
  const deleteBtn = document.getElementById('delete-btn');

  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(hash);
    showToast('Hash copied to clipboard.');
  });

  saveBtn.addEventListener('click', () => saveResource(hash, mimeType));

  deleteBtn.addEventListener('click', async () => {
    const confirmed = await showDeleteDialog(origins);
    if (!confirmed) return;
    const resp = await chrome.runtime.sendMessage({
      action: 'deleteResource',
      data: { hash: { algorithm: 'SHA-256', value: hash } },
    });
    if (resp?.data?.success) {
      showToast('Resource deleted.');
      [copyBtn, saveBtn, deleteBtn].forEach((b) => (b.disabled = true));
      contentArea.innerHTML = '<p class="empty-state">This resource has been deleted.</p>';
    } else {
      showToast('Delete failed.');
    }
  });

  const base = (mimeType || '').split(';')[0].trim().toLowerCase();

  if (
    base.startsWith('font/') ||
    base.startsWith('application/font-') ||
    base === 'application/x-font-ttf' ||
    base === 'application/x-font-otf' ||
    base === 'application/font-woff' ||
    base === 'application/font-woff2'
  ) {
    await renderFont(contentArea, dataURL);
  } else if (base.startsWith('image/')) {
    renderImage(contentArea, dataURL);
  } else {
    renderText(contentArea, text ?? '');
  }
})();
