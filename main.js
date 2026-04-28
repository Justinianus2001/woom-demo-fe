// Configuration - Load from config.js injected variables, fallback to localhost
const API_BASE = window.CONFIG.API_BASE;

// State
let currentSound = null;
let isPlaying = false;
let generatedMixBlob = null;
let generatedMixVersion = 'v1';
let generatedMixFormat = 'mp3';
let generatedMixMimeType = 'audio/mpeg';
let isMixing = false;
let heartbeatSourceMode = 'upload';
let trackNames = [];
let heartbeatNames = [];
let trackDisplayNames = {};
let heartbeatDisplayNames = {};
let trackLibraryStatusMessage = '';
let cachedPickedUpload = null;

// Tempo presets for both preview and server request
const speedMap = {
  Slow: 0.8,
  Normal: 1.0,
  Fast: 1.2
};

function buildTrackPath(trackName) {
  return `${API_BASE}/tracks/audio/${encodeURIComponent(trackName)}`;
}

function formatTime(secs) {
  if (isNaN(secs)) return '0:00';
  const minutes = Math.floor(secs / 60) || 0;
  const seconds = Math.floor(secs % 60) || 0;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

const SELECT_LABEL_MAX_LENGTH = 40;

function isGeneratedMixTrackName(trackName) {
  const normalized = String(trackName || '').trim().toLowerCase();
  if (!normalized) return false;

  return (
    /^mixed[-_][a-f0-9]{8,}(?:[-_][a-f0-9]{8,})*(?:\.[a-z0-9]+)?$/.test(normalized) ||
    /^v\d+_mixed(?:\.[a-z0-9]+)?$/.test(normalized)
  );
}

function getCompactSelectLabel(label, maxLength = SELECT_LABEL_MAX_LENGTH) {
  const text = String(label || '').trim();
  if (text.length <= maxLength) return text;

  const extensionMatch = text.match(/(\.[^.\s]{1,8})$/);
  const extension = extensionMatch ? extensionMatch[1] : '';
  const stem = extension ? text.slice(0, -extension.length) : text;
  const availableLength = Math.max(12, maxLength - extension.length - 3);

  return `${stem.slice(0, availableLength)}...${extension}`;
}

function syncSelectTitle(selectElement, displayNames) {
  if (!selectElement) return;

  const selectedValue = selectElement.value;
  selectElement.title = (displayNames && displayNames[selectedValue]) || selectedValue || '';
}

function normalizeMixFormat(rawFormat) {
  const fmt = String(rawFormat || '').trim().toLowerCase();
  return fmt === 'flac' ? 'flac' : 'mp3';
}

function resolveMixMimeType(format, providedMimeType = '') {
  if (providedMimeType && String(providedMimeType).trim()) {
    return String(providedMimeType).trim().toLowerCase();
  }
  return format === 'mp3' ? 'audio/mpeg' : 'audio/flac';
}

function getPreferredMixFormat() {
  const preferLossless = Boolean(window.CONFIG && window.CONFIG.PREFER_LOSSLESS_FLAC);
  if (!preferLossless) {
    return 'mp3';
  }

  try {
    if (typeof Howler !== 'undefined' && typeof Howler.codecs === 'function' && Howler.codecs('flac')) {
      return 'flac';
    }
  } catch (err) {
    console.warn('Cannot detect FLAC codec support, fallback to mp3:', err);
  }
  return 'mp3';
}

function getFileCacheKey(file) {
  if (!file) return '';
  const name = String(file.name || '').trim();
  const size = Number(file.size || 0);
  const modified = Number(file.lastModified || 0);
  return `${name}::${size}::${modified}`;
}

async function cachePickedUploadFile(file) {
  if (!file) {
    cachedPickedUpload = null;
    return null;
  }

  const cacheKey = getFileCacheKey(file);
  if (
    cachedPickedUpload
    && cachedPickedUpload.cacheKey === cacheKey
    && cachedPickedUpload.bytes
    && cachedPickedUpload.bytes.byteLength > 0
  ) {
    return cachedPickedUpload;
  }

  const fileBuffer = await file.arrayBuffer();
  if (!fileBuffer || fileBuffer.byteLength <= 0) {
    throw new Error('Selected heartbeat file cannot be read or is empty.');
  }

  cachedPickedUpload = {
    cacheKey,
    name: file.name || 'heartbeat.wav',
    type: file.type || 'audio/wav',
    bytes: new Uint8Array(fileBuffer),
    size: fileBuffer.byteLength,
  };

  return cachedPickedUpload;
}

function clearPickedUploadCache() {
  cachedPickedUpload = null;
}

function applyGeneratedMix(base64Data, version, audioFormat, mimeType) {
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let j = 0; j < binaryString.length; j++) {
    bytes[j] = binaryString.charCodeAt(j);
  }

  const resolvedFormat = normalizeMixFormat(audioFormat || generatedMixFormat);
  const resolvedMime = resolveMixMimeType(resolvedFormat, mimeType || generatedMixMimeType);

  generatedMixBlob = new Blob([bytes], { type: resolvedMime });
  generatedMixVersion = version || 'v1';
  generatedMixFormat = resolvedFormat;
  generatedMixMimeType = resolvedMime;
}

function mapProcessingPhase(message = '', status = 'progress') {
  const msg = (message || '').toLowerCase();

  if (status === 'done') {
    return { title: 'Completed', badge: 'READY' };
  }
  if (status === 'failed') {
    return { title: 'Failed', badge: 'FAILED' };
  }

  if (msg.includes('analyzing heartbeat')) {
    return { title: 'Analyzing Heartbeat', badge: 'ANALYZING' };
  }
  if (msg.includes('analyzing track')) {
    return { title: 'Analyzing Track', badge: 'ANALYZING' };
  }
  if (msg.includes('preprocessing')) {
    return { title: 'Preprocessing Audio', badge: 'PREPROCESS' };
  }
  if (msg.includes('mixing heartbeat')) {
    return { title: 'Mixing Audio', badge: 'MIXING' };
  }
  if (msg.includes('validating')) {
    return { title: 'Validating Output', badge: 'VALIDATING' };
  }
  if (msg.includes('encoding')) {
    return { title: 'Encoding Audio', badge: 'ENCODING' };
  }

  return { title: 'Processing Audio', badge: 'PROCESSING' };
}

// Initialize Lucide Icons
lucide.createIcons();

// UI Elements
const trackSelect = document.getElementById('track-select');
const pickedInput = document.getElementById('picked-upload');
const pickedName = document.getElementById('picked-name');
const mixBtn = document.getElementById('mix-btn');
const statusText = document.getElementById('status-text');
const progressBar = document.getElementById('progress-bar');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');

// Player Elements
const currentTimeEl = document.getElementById('current-time');
const totalTimeEl = document.getElementById('total-time');
const playerProgressBar = document.getElementById('player-progress-bar');
const closePlayerBtn = document.getElementById('close-player-btn');
const mixGrid = document.getElementById('mix-grid');
const playerBar = document.getElementById('player-bar');
const playPauseBtn = document.getElementById('play-pause-btn');
const waveform = document.getElementById('waveform');
const volumeSlider = document.getElementById('volume-slider');
const skipPrevBtn = document.getElementById('skip-prev-btn');
const skipNextBtn = document.getElementById('skip-next-btn');
const downloadBtn = document.getElementById('download-btn');
const previewTrackBtn = document.getElementById('preview-track-btn');
const previewIcon = document.getElementById('preview-icon');
const heartbeatSelect = document.getElementById('heartbeat-select');
const previewHeartbeatBtn = document.getElementById('preview-heartbeat-btn');
const previewHeartbeatIcon = document.getElementById('preview-heartbeat-icon');
const heartbeatModeUploadInput = document.getElementById('heartbeat-mode-upload');
const heartbeatModeLibraryInput = document.getElementById('heartbeat-mode-library');
const heartbeatUploadWrap = document.getElementById('heartbeat-upload-wrap');
const heartbeatLibraryWrap = document.getElementById('heartbeat-library-wrap');
const trackStatusText = document.getElementById('track-status-text');
const heartbeatLibraryStatusText = document.getElementById('heartbeat-library-status-text');

console.log('Main.js: UI elements initialized. DownloadBtn:', downloadBtn);

if (skipPrevBtn) skipPrevBtn.classList.add('hidden');
if (skipNextBtn) skipNextBtn.classList.add('hidden');

let previewSound = null;
let previewKind = null;

const setPreviewButtonIdle = (kind) => {
  const icon = kind === 'heartbeat' ? previewHeartbeatIcon : previewIcon;
  const button = kind === 'heartbeat' ? previewHeartbeatBtn : previewTrackBtn;
  if (!icon || !button) return;

  icon.setAttribute('data-lucide', 'play-circle');
  icon.classList.remove('animate-spin');
  button.classList.remove('text-green-500', 'bg-green-50');
};

const stopPreview = () => {
  if (previewSound) {
    previewSound.stop();
    previewSound.unload();
    previewSound = null;
  }
  if (previewKind) {
    setPreviewButtonIdle(previewKind);
  }
  previewKind = null;
  lucide.createIcons();
};

const playPreview = (fileName, kind) => {
  if (!fileName) return;
  const icon = kind === 'heartbeat' ? previewHeartbeatIcon : previewIcon;
  const button = kind === 'heartbeat' ? previewHeartbeatBtn : previewTrackBtn;
  if (!icon || !button) return;

  if (previewSound) {
    stopPreview();
  }

  previewKind = kind;
  icon.setAttribute('data-lucide', 'loader-2');
  icon.classList.add('animate-spin');
  lucide.createIcons();

  previewSound = new Howl({
    src: [buildTrackPath(fileName)],
    html5: true,
    autoplay: true,
    onplay: () => {
      icon.setAttribute('data-lucide', 'pause-circle');
      icon.classList.remove('animate-spin');
      button.classList.add('text-green-500', 'bg-green-50');
      lucide.createIcons();

      setTimeout(() => {
        if (previewKind === kind && previewSound) {
          stopPreview();
        }
      }, 20000);
    },
    onend: stopPreview,
    onloaderror: () => {
      alert('Error loading track preview');
      stopPreview();
    },
    onplayerror: () => {
      alert('Error playing track preview');
      stopPreview();
    }
  });
};

previewTrackBtn.addEventListener('click', () => {
  if (previewKind === 'track') {
    stopPreview();
    return;
  }

  const trackName = trackSelect.value;
  playPreview(trackName, 'track');
});

if (previewHeartbeatBtn) {
  previewHeartbeatBtn.addEventListener('click', () => {
    if (previewKind === 'heartbeat') {
      stopPreview();
      return;
    }

    const heartbeatName = heartbeatSelect ? heartbeatSelect.value : '';
    playPreview(heartbeatName, 'heartbeat');
  });
}

trackSelect.addEventListener('change', () => {
  syncSelectTitle(trackSelect, trackDisplayNames);
  if (previewKind === 'track') stopPreview();
});

if (heartbeatSelect) {
  heartbeatSelect.addEventListener('change', () => {
    syncSelectTitle(heartbeatSelect, heartbeatDisplayNames);
    if (previewKind === 'heartbeat') stopPreview();
  });
}

const syncHeartbeatSourceControls = () => {
  if (!heartbeatModeUploadInput || !heartbeatModeLibraryInput) return;

  const uploadActive = heartbeatSourceMode === 'upload';
  const canUseLibrary = heartbeatNames.length > 0;
  const libraryActive = heartbeatSourceMode === 'library' && canUseLibrary;

  heartbeatModeUploadInput.checked = uploadActive;
  heartbeatModeLibraryInput.checked = libraryActive;
  heartbeatModeLibraryInput.disabled = !canUseLibrary;
};

const setHeartbeatSourceMode = (mode) => {
  if (mode === 'library' && heartbeatNames.length === 0) {
    heartbeatSourceMode = 'upload';
  } else {
    heartbeatSourceMode = mode;
  }

  if (heartbeatUploadWrap) {
    heartbeatUploadWrap.classList.toggle('hidden', heartbeatSourceMode !== 'upload');
  }
  if (heartbeatLibraryWrap) {
    heartbeatLibraryWrap.classList.toggle('hidden', heartbeatSourceMode !== 'library');
  }

  syncHeartbeatSourceControls();
};

if (heartbeatModeUploadInput) {
  heartbeatModeUploadInput.addEventListener('change', () => {
    if (heartbeatModeUploadInput.checked) setHeartbeatSourceMode('upload');
  });
}

if (heartbeatModeLibraryInput) {
  heartbeatModeLibraryInput.addEventListener('change', () => {
    if (heartbeatModeLibraryInput.checked) setHeartbeatSourceMode('library');
  });
}

const initTrackSelect = () => {
  trackSelect.innerHTML = '';
  trackStatusText.textContent = '';
  trackStatusText.classList.add('hidden');

  if (trackNames.length === 0) {
    trackSelect.disabled = true;
    previewTrackBtn.disabled = true;
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No tracks found on R2';
    opt.disabled = true;
    trackSelect.appendChild(opt);

    if (trackLibraryStatusMessage) {
      trackStatusText.textContent = `Unable to load tracks: ${trackLibraryStatusMessage}`;
      trackStatusText.classList.remove('hidden');
      trackStatusText.classList.remove('text-slate-500');
      trackStatusText.classList.add('text-amber-600');
    } else {
      trackStatusText.textContent = 'No tracks found on R2. Confirm the backend can access Cloudflare R2 or try again later.';
      trackStatusText.classList.remove('hidden');
      trackStatusText.classList.remove('text-amber-600');
      trackStatusText.classList.add('text-slate-500');
    }
    return;
  }

  trackSelect.disabled = false;
  previewTrackBtn.disabled = false;
  trackNames.forEach(track => {
    const opt = document.createElement('option');
    opt.value = track;
    const displayName = trackDisplayNames[track] || track;
    opt.textContent = getCompactSelectLabel(displayName);
    opt.title = displayName;
    trackSelect.appendChild(opt);
  });
  trackSelect.value = trackNames[0];
  syncSelectTitle(trackSelect, trackDisplayNames);
};

const initHeartbeatSelect = () => {
  if (!heartbeatSelect) return;

  heartbeatSelect.innerHTML = '';
  heartbeatLibraryStatusText.textContent = '';
  heartbeatLibraryStatusText.classList.add('hidden');

  if (heartbeatNames.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No heartbeat files found';
    heartbeatSelect.appendChild(opt);
    heartbeatSelect.disabled = true;
    if (previewHeartbeatBtn) previewHeartbeatBtn.disabled = true;
    setHeartbeatSourceMode('upload');

    heartbeatLibraryStatusText.textContent = 'Resource File library is empty. Upload a heartbeat recording or use Upload File mode.';
    heartbeatLibraryStatusText.classList.remove('hidden');
    heartbeatLibraryStatusText.classList.remove('text-amber-600');
    heartbeatLibraryStatusText.classList.add('text-slate-500');
    return;
  }

  heartbeatNames.forEach(track => {
    const opt = document.createElement('option');
    opt.value = track;
    const displayName = heartbeatDisplayNames[track] || track;
    opt.textContent = getCompactSelectLabel(displayName);
    opt.title = displayName;
    heartbeatSelect.appendChild(opt);
  });

  heartbeatSelect.disabled = false;
  heartbeatSelect.value = heartbeatNames[0];
  syncSelectTitle(heartbeatSelect, heartbeatDisplayNames);
  if (previewHeartbeatBtn) previewHeartbeatBtn.disabled = false;
};

const normalizeTrackLibrary = (tracks) => {
  const trackbeats = [];
  const heartbeats = [];
  const trackbeatLabels = {};
  const heartbeatLabels = {};
  const seenTrackLabels = new Set();
  const seenHeartbeatLabels = new Set();

  if (!Array.isArray(tracks)) {
    return { trackbeats, heartbeats, trackbeatLabels, heartbeatLabels };
  }

  tracks.forEach((item) => {
    if (!item) return;

    if (typeof item === 'string') {
      if (isGeneratedMixTrackName(item)) {
        return;
      }
      trackbeats.push(item);
      trackbeatLabels[item] = item;
      return;
    }

    const trackName = String(item.track_name || item.name || '').trim();
    if (!trackName) return;
    const displayName = String(item.display_name || item.original_name || trackName).trim() || trackName;

    if (isGeneratedMixTrackName(trackName) || isGeneratedMixTrackName(displayName)) {
      return;
    }

    const normalizedTrackName = trackName.toLowerCase();
    const normalizedDisplayName = displayName.toLowerCase();
    if (normalizedDisplayName === 'hb.wav' || (normalizedTrackName.endsWith('_hb.wav') && normalizedDisplayName === 'hb.wav')) {
      return;
    }

    const fileType = String(item.file_type || '').toLowerCase();
    const normalizedType = fileType.replace(/[\s_-]/g, '');
    const normalizedLabel = displayName.toLowerCase();
    if (normalizedType === 'heartbeat' || normalizedType === 'heartbeart') {
      if (seenHeartbeatLabels.has(normalizedLabel)) {
        return;
      }
      seenHeartbeatLabels.add(normalizedLabel);
      heartbeats.push(trackName);
      heartbeatLabels[trackName] = displayName;
      return;
    }

    if (seenTrackLabels.has(normalizedLabel)) {
      return;
    }
    seenTrackLabels.add(normalizedLabel);

    trackbeats.push(trackName);
    trackbeatLabels[trackName] = displayName;
  });

  return {
    trackbeats: [...new Set(trackbeats)],
    heartbeats: [...new Set(heartbeats)],
    trackbeatLabels,
    heartbeatLabels,
  };
};

let trackLoadStartTime = 0;
let trackLoadTimerInterval = null;

const showTrackLoadingState = () => {
  const trackOverlay = document.getElementById('track-loading-overlay');
  const heartbeatOverlay = document.getElementById('heartbeat-loading-overlay');
  const container = document.getElementById('track-status-container');
  const statusText = document.getElementById('track-status-text');
  const timer = document.getElementById('track-load-timer');

  if (trackOverlay) {
    trackOverlay.classList.add('active');
  }
  if (heartbeatOverlay) {
    heartbeatOverlay.classList.add('active');
  }
  if (container) {
    container.classList.add('visible');
  }
  if (statusText) {
    statusText.textContent = 'Loading tracks from R2 Storage...';
  }

  trackLoadStartTime = Date.now();
  if (trackLoadTimerInterval) clearInterval(trackLoadTimerInterval);

  trackLoadTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - trackLoadStartTime) / 1000);
    if (timer) {
      timer.textContent = `${elapsed}s`;
      // Pulse effect every second
      timer.classList.remove('timer-pulse');
      void timer.offsetWidth; // Trigger reflow
      timer.classList.add('timer-pulse');
    }
  }, 100);
};

const hideTrackLoadingState = () => {
  const trackOverlay = document.getElementById('track-loading-overlay');
  const heartbeatOverlay = document.getElementById('heartbeat-loading-overlay');
  const container = document.getElementById('track-status-container');
  const timer = document.getElementById('track-load-timer');

  if (trackOverlay) {
    trackOverlay.classList.remove('active');
  }
  if (heartbeatOverlay) {
    heartbeatOverlay.classList.remove('active');
  }
  if (container) {
    container.classList.remove('visible');
  }
  if (timer) {
    timer.classList.remove('timer-pulse');
  }

  if (trackLoadTimerInterval) {
    clearInterval(trackLoadTimerInterval);
    trackLoadTimerInterval = null;
  }
};

const fetchTrackLibrary = async () => {
  showTrackLoadingState();

  try {
    const response = await fetch(`${API_BASE}/tracks`, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`Cannot load track library (status ${response.status})`);
    }

    const payload = await response.json();
    const { trackbeats, heartbeats, trackbeatLabels, heartbeatLabels } = normalizeTrackLibrary(payload.tracks);
    trackNames = trackbeats;
    heartbeatNames = heartbeats;
    trackDisplayNames = trackbeatLabels;
    heartbeatDisplayNames = heartbeatLabels;

    console.log(`Loaded ${trackNames.length} tracks and ${heartbeatNames.length} heartbeats from API.`);
  } catch (error) {
    console.warn('Unable to load track library from API:', error);
    trackLibraryStatusMessage = error.message || 'Unknown error';
    trackNames = [];
    heartbeatNames = [];
    trackDisplayNames = {};
    heartbeatDisplayNames = {};
  } finally {
    hideTrackLoadingState();
  }

  initTrackSelect();
  initHeartbeatSelect();
  syncHeartbeatSourceControls();
};

function updateProgress() {
  if (currentSound && isPlaying) {
    if (!isDraggingProgress) {
      let seek = currentSound.seek() || 0;
      if (typeof seek !== 'number') seek = 0;

      currentTimeEl.innerText = formatTime(seek);
      if (currentSound.duration()) {
        playerProgressBar.value = (seek / currentSound.duration()) * 100 || 0;
      }
    }
    progressAnimFrame = requestAnimationFrame(updateProgress);
  }
}

let progressAnimFrame;
let isDraggingProgress = false;

// Server Healthcheck
const checkServerHealth = async () => {
  const btn = document.getElementById('mix-btn');
  const dot = document.getElementById('server-status-dot');
  const statusIndicatorText = document.getElementById('server-status-text');
  const btnText = document.getElementById('mix-btn-text');

  try {
    // Add a small timeout so it doesn't hang forever if server is sleeping
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`${API_BASE}/`, {
      method: 'GET',
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      btn.disabled = false;

      // Update Status Dot to Green
      dot.className = 'w-2.5 h-2.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse';
      statusIndicatorText.innerText = "SERVER READY";
      statusIndicatorText.className = "text-xs font-bold text-green-600 uppercase tracking-wider";

      // Update Button UI if not already updated and not currently mixing
      if (!isMixing && btnText && btnText.innerText !== "Generate Mixes") {
        btn.innerHTML = '<i data-lucide="wand-2"></i><span id="mix-btn-text">Generate Mixes</span>';
        lucide.createIcons();
      }
    } else {
      throw new Error("Server responded but not OK");
    }
  } catch (error) {
    btn.disabled = true;

    // Update Status Dot to Red
    dot.className = 'w-2.5 h-2.5 rounded-full bg-red-500 animate-[pulse_1s_ease-in-out_infinite] shadow-[0_0_8px_rgba(239,68,68,0.6)]';
    statusIndicatorText.innerText = "SERVER SLEEPING";
    statusIndicatorText.className = "text-xs font-bold text-red-500 uppercase tracking-wider";

    // Keep Button UI in waking state
    if (!isMixing && btnText && btnText.innerText !== "Waking Server...") {
      btn.innerHTML = '<i data-lucide="power" class="animate-pulse"></i><span id="mix-btn-text">Waking Server...</span>';
      lucide.createIcons();
    }
  }

  // Re-poll every 6 seconds regardless of status to keep status continuous
  setTimeout(checkServerHealth, 6000);
};

// Start healthcheck and initialize configured tracks on load
checkServerHealth();
initTrackSelect();
initHeartbeatSelect();
setHeartbeatSourceMode('upload');
fetchTrackLibrary();

// Setup Waveform
for (let i = 0; i < 40; i++) {
  const bar = document.createElement('div');
  bar.className = 'waveform-bar';
  bar.style.height = (20 + Math.random() * 60) + '%';
  waveform.appendChild(bar);
}

// File Selection Handlers
pickedInput.addEventListener('change', async (e) => {
  const selectedFile = e.target.files && e.target.files[0] ? e.target.files[0] : null;

  if (!selectedFile) {
    pickedName.innerText = 'Select heartbeat recording...';
    clearPickedUploadCache();
    return;
  }

  pickedName.innerText = selectedFile.name;
  clearPickedUploadCache();

  try {
    await cachePickedUploadFile(selectedFile);
    console.info('Heartbeat upload cached in memory for stable retries.');
  } catch (cacheErr) {
    console.warn('Unable to cache selected heartbeat file:', cacheErr);
  }
});

// Mix Generation Logic with Streaming
mixBtn.addEventListener('click', async () => {
  const pickedFile = pickedInput.files[0];
  const trackName = trackSelect.value;
  const heartbeatName = heartbeatSelect ? heartbeatSelect.value : '';
  const useLibraryHeartbeat = heartbeatSourceMode === 'library';

  if (!trackName) {
    alert("Please select a background music track.");
    return;
  }

  if (useLibraryHeartbeat) {
    if (!heartbeatName) {
      alert("Please choose a heartbeat track from Resource File.");
      return;
    }
  } else {
    if (!pickedFile) {
      alert("Please select a heartbeat file.");
      return;
    }

    if (pickedFile.size <= 0) {
      alert("The selected heartbeat file is empty. Please choose another file.");
      return;
    }

    // Prevent uploading excessively large files that might timeout or get rejected by the server
    if (pickedFile.size > 15 * 1024 * 1024) {
      alert("The chosen heartbeat file is too large (over 15MB). Please choose a shorter recording or use a more compressed format (e.g. m4a, mp3) to avoid connection errors.");
      return;
    }
  }

  isMixing = true;
  mixBtn.disabled = true;

  // Reset cards to waiting state and add processing animation
  document.querySelectorAll('.mix-card').forEach(card => {
    card.classList.add('opacity-40', 'grayscale', 'pointer-events-none', 'processing-card');
    const statusBadge = card.querySelector('.mix-status');
    statusBadge.innerText = "PROCESSING";
    statusBadge.classList.add('processing-status');
    statusBadge.classList.replace('text-green-500', 'text-slate-400');
    statusBadge.classList.replace('text-red-500', 'text-slate-400');
    statusBadge.classList.replace('border-green-200', 'border-slate-200');
    statusBadge.classList.replace('border-red-200', 'border-slate-200');
  });

  // Update button for inline animation - Strictly Disabled
  mixBtn.disabled = true;
  mixBtn.classList.add('mix-btn-active');
  mixBtn.innerHTML = `
    <div class="scanning-beam"></div>
    <div id="btn-liquid-fill" class="liquid-fill">
        <div class="liquid-wave"></div>
    </div>
    <div class="relative z-10 flex items-center gap-3">
        <i data-lucide="heart" class="heart-pulse-heavy size-6"></i>
        <span id="mix-btn-text" class="progress-text-glow font-bold tracking-wide">Orchestrating Style... <span id="btn-progress-perc">0%</span></span>
    </div>
  `;
  lucide.createIcons();

  // Create some initial particles for feedback
  for (let i = 0; i < 8; i++) {
    const p = document.createElement('div');
    p.className = 'floating-particle size-2 bg-primary/40 rounded-full';
    p.style.left = '50%';
    p.style.top = '50%';
    p.style.setProperty('--tw-translate-x', `${(Math.random() - 0.5) * 200}px`);
    p.style.setProperty('--tw-translate-y', `${(Math.random() - 0.5) * 200}px`);
    mixBtn.appendChild(p);
    setTimeout(() => p.remove(), 2000);
  }

  // Reset unified result for a new mix. The old multi-version pipeline is kept only in processor.py for rollback.
  generatedMixBlob = null;
  generatedMixFormat = getPreferredMixFormat();
  generatedMixMimeType = resolveMixMimeType(generatedMixFormat);

  const formData = new FormData();
  formData.append('track_name', trackName);
  formData.append('output_format', generatedMixFormat);
  const mixEndpoint = useLibraryHeartbeat ? '/mix-file' : '/mix-all';
  const shouldRefreshLibraryAfterMix = !useLibraryHeartbeat;

  try {
    statusText.classList.remove('hidden');
    if (useLibraryHeartbeat) {
      statusText.innerText = '⏳ Loading heartbeat from Resource File...';
      formData.append('heartbeat_name', heartbeatName);
    } else {
      // Always build upload payload from a cached in-memory copy.
      // This avoids zero-byte uploads on browsers that expose one-time file streams.
      statusText.innerText = '⏳ Preparing uploaded heartbeat...';
      try {
        const cachedUpload = await cachePickedUploadFile(pickedFile);
        if (!cachedUpload || cachedUpload.size <= 0) {
          throw new Error('Selected heartbeat file is empty.');
        }

        const fileBlob = new Blob(
          [cachedUpload.bytes],
          { type: cachedUpload.type || pickedFile.type || 'audio/wav' }
        );
        formData.append('picked', fileBlob, cachedUpload.name || pickedFile.name || 'heartbeat.wav');
      } catch (bufferErr) {
        clearPickedUploadCache();
        console.error('Failed to prepare upload heartbeat file:', bufferErr);
        throw new Error('Cannot read uploaded heartbeat file. Please re-select the file and try again.');
      }
    }

    // Initial ETA estimation
    statusText.innerText = "⏳ Estimating unified mix... (ETA ~30s)";
    progressBar.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressText.innerText = '0%';

    const startTime = Date.now();
    let doneCount = 0;
    let totalVersionCount = 1; // Unified pipeline only
    let lastMixError = '';

    const response = await fetch(`${API_BASE}${mixEndpoint}`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const errText = await response.text();
      let errorMsg = `Server error ${response.status}`;
      if (response.status === 413) {
        errorMsg = "File is too large for the server. Please trim your audio or use a smaller file.";
      } else if (response.status === 504) {
        errorMsg = "Server took too long to respond. The mix might still be generating, but the connection dropped.";
      } else {
        try {
          const maybeJson = JSON.parse(errText);
          if (maybeJson && maybeJson.detail) {
            errorMsg = maybeJson.detail;
          }
        } catch (_ignored) {
          if (errText && errText.trim()) {
            errorMsg = errText.trim();
          }
        }
      }
      throw new Error(errorMsg);
    }

    if (!response.body) {
      throw new Error('Streaming response is not available in this browser.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines[lines.length - 1];

      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        try {
          const result = JSON.parse(line);
          const { version, status, progress, data, message, error, audio_format, mime_type } = result;

          if (status === 'done' && data) {
            doneCount += 1;
            applyGeneratedMix(data, version, audio_format, mime_type);

            // update the single result card
            const card = document.getElementById('mix-result-card');
            if (card) {
              card.classList.remove('opacity-40', 'grayscale', 'pointer-events-none', 'processing-card');

              const statusBadge = document.getElementById('mix-result-status');
              const title = document.getElementById('mix-result-title');
              const description = document.getElementById('mix-result-description');
              if (statusBadge) {
                statusBadge.innerText = "READY";
                statusBadge.classList.remove('processing-status');
                statusBadge.classList.replace('text-slate-400', 'text-green-500');
                statusBadge.classList.replace('border-slate-200', 'border-green-200');
              }
              if (title) title.innerText = 'Unified Heartbeat Mix Ready';
              if (description) {
                description.innerText = 'A single stabilized mix is ready to play. The output keeps the heartbeat intro, BPM sync limit, and 432Hz tuning in one unified pipeline.';
              }
            }
          }

          if (progress) {
            const [current, total] = progress.split('/').map(Number);
            totalVersionCount = total; // Sync with server's reality
            const perc = Math.round((current / total) * 100);
            const phase = mapProcessingPhase(message, status);

            // Inline Button Update (The source of truth)
            const btnFill = document.getElementById('btn-liquid-fill');
            const btnPercText = document.getElementById('btn-progress-perc');
            if (btnFill) btnFill.style.height = `${perc}%`;
            if (btnPercText) btnPercText.innerText = `${perc}%`;

            progressFill.style.width = `${perc}%`;
            progressText.innerText = `${perc}%`;

            const statusBadge = document.getElementById('mix-result-status');
            if (statusBadge && status !== 'done' && status !== 'failed') {
              statusBadge.innerText = phase.badge;
            }

            // Recalculate ETA based on steps, not just finished versions
            const elapsed = (Date.now() - startTime) / 1000;
            if (current > 0) {
              const avgPerStep = elapsed / current;
              const remainingSteps = total - current;
              const eta = Math.round(avgPerStep * remainingSteps);
              statusText.innerText = `⏳ ${phase.title} • ${perc}% (ETA ${eta}s)`;
            }
          }

          if (status === 'failed') {
            const failureReason = String(error || message || '').trim();
            if (failureReason) {
              lastMixError = failureReason;
              statusText.innerText = `❌ Mixing failed: ${failureReason}`;
            }

            const card = document.getElementById('mix-result-card');
            if (card) {
              const statusBadge = document.getElementById('mix-result-status');
              if (statusBadge) {
                statusBadge.innerText = "FAILED";
                statusBadge.classList.remove('processing-status');
                statusBadge.classList.replace('text-slate-400', 'text-red-500');
                statusBadge.classList.replace('border-slate-200', 'border-red-200');
              }
              card.classList.add('opacity-40', 'pointer-events-none');
              card.classList.remove('processing-card');
            }
          }
        } catch (e) {
          console.error('Error parsing line:', line, e);
        }
      }
    }

    // Process any remaining text in the buffer after the stream ends
    if (buffer.trim()) {
      try {
        const result = JSON.parse(buffer.trim());
        const { version, status, progress, data, message, error, audio_format, mime_type } = result;
        if (progress) {
          const [current, total] = progress.split('/').map(Number);
          const perc = Math.round((current / total) * 100);
          const phase = mapProcessingPhase(message, status);
          progressFill.style.width = `${perc}%`;
          progressText.innerText = `${perc}%`;
          statusText.innerText = `⏳ ${phase.title} • ${perc}%`;

          const btnFill = document.getElementById('btn-liquid-fill');
          const btnPercText = document.getElementById('btn-progress-perc');
          if (btnFill) btnFill.style.height = `${perc}%`;
          if (btnPercText) btnPercText.innerText = `${perc}%`;
        }
        if (status === 'done' && data) {
          doneCount += 1;
          applyGeneratedMix(data, version, audio_format, mime_type);

          const card = document.getElementById('mix-result-card');
          if (card) {
            card.classList.remove('opacity-40', 'grayscale', 'pointer-events-none', 'processing-card');
            const statusBadge = document.getElementById('mix-result-status');
            const title = document.getElementById('mix-result-title');
            const description = document.getElementById('mix-result-description');
            if (statusBadge) {
              statusBadge.innerText = "READY";
              statusBadge.classList.remove('processing-status');
              statusBadge.classList.replace('text-slate-400', 'text-green-500');
              statusBadge.classList.replace('border-slate-200', 'border-green-200');
            }
            if (title) title.innerText = 'Unified Heartbeat Mix Ready';
            if (description) {
              description.innerText = 'A single stabilized mix is ready to play. The output keeps the heartbeat intro, BPM sync limit, and 432Hz tuning in one unified pipeline.';
            }
          }
        } else if (status === 'failed') {
          const failureReason = String(error || message || '').trim();
          if (failureReason) {
            lastMixError = failureReason;
            statusText.innerText = `❌ Mixing failed: ${failureReason}`;
          }

          const card = document.getElementById('mix-result-card');
          if (card) {
            const statusBadge = document.getElementById('mix-result-status');
            if (statusBadge) {
              statusBadge.innerText = "FAILED";
              statusBadge.classList.remove('processing-status');
              statusBadge.classList.replace('text-slate-400', 'text-red-500');
              statusBadge.classList.replace('border-slate-200', 'border-red-200');
            }
            card.classList.add('opacity-40', 'pointer-events-none');
            card.classList.remove('processing-card');
          }
        }
      } catch (e) {
        console.error('Error parsing final buffer line:', buffer, e);
      }
    }

    if (generatedMixBlob) {
      statusText.innerText = `✨ Unified mix generated. Play the single result below.`;
    } else {
      statusText.innerText = lastMixError
        ? `❌ Mixing failed: ${lastMixError}`
        : "❌ Mixing failed.";
    }
    progressBar.classList.add('hidden');

  } catch (error) {
    console.error(error);
    statusText.innerText = `❌ ${error.message || "Network error or connection dropped."}`;
    progressBar.classList.add('hidden');
  } finally {
    if (shouldRefreshLibraryAfterMix) {
      fetchTrackLibrary();
    }

    isMixing = false;
    mixBtn.classList.remove('mix-btn-active');
    mixBtn.disabled = false;
    // Reset button icon
    mixBtn.innerHTML = '<i data-lucide="wand-2"></i><span id="mix-btn-text">Generate Mixes</span>';
    lucide.createIcons();
  }
});

// Single Result Card Click Handler
const resultCard = document.getElementById('mix-result-card');
if (resultCard) {
  resultCard.addEventListener('click', () => {
    playMix(resultCard);
  });
}

function playMix(cardElement) {
  const blob = generatedMixBlob;
  if (!blob) return;

  // Update Player Bar UI
  playerBar.classList.remove('translate-y-full');
  document.getElementById('now-playing-title').innerText = cardElement.querySelector('h3').innerText;
  document.getElementById('now-playing-subtitle').innerText = 'Unified V1';
  document.getElementById('mini-cover').querySelector('img').src = cardElement.querySelector('img').src;

  // Pause existing
  if (currentSound) currentSound.stop();

  // Create new sound
  const url = URL.createObjectURL(blob);
  const playbackFormats = generatedMixFormat === 'mp3' ? ['mp3'] : ['flac', 'mp3'];
  currentSound = new Howl({
    src: [url],
    format: playbackFormats,
    volume: volumeSlider.value,
    onplay: () => {
      isPlaying = true;
      updatePlayPauseUI();
      startWaveform();
    },
    onpause: () => {
      isPlaying = false;
      updatePlayPauseUI();
      stopWaveform();
    },
    onstop: () => {
      isPlaying = false;
      updatePlayPauseUI();
      stopWaveform();
    },
    onend: () => {
      isPlaying = false;
      updatePlayPauseUI();
      stopWaveform();
    },
    onloaderror: (id, error) => {
      console.error('Howler Load Error:', id, error);
      alert(`Audio load error: ${error}`);
    },
    onplayerror: (id, error) => {
      console.error('Howler Play Error:', id, error);
      alert(`Audio play error: ${error}`);
    }
  });

  currentSound.play();

  // Reset Progress UI
  playerProgressBar.value = 0;
  currentTimeEl.innerText = '0:00';
  totalTimeEl.innerText = '0:00';
  if (progressAnimFrame) cancelAnimationFrame(progressAnimFrame);

  currentSound.on('load', () => {
    totalTimeEl.innerText = formatTime(currentSound.duration());
  });

  currentSound.on('play', () => {
    progressAnimFrame = requestAnimationFrame(updateProgress);
    totalTimeEl.innerText = formatTime(currentSound.duration());
  });
}

// Player Controls
playerProgressBar.addEventListener('mousedown', () => isDraggingProgress = true);
playerProgressBar.addEventListener('touchstart', () => isDraggingProgress = true);
playerProgressBar.addEventListener('mouseup', () => isDraggingProgress = false);
playerProgressBar.addEventListener('touchend', () => isDraggingProgress = false);

playerProgressBar.addEventListener('input', (e) => {
  isDraggingProgress = true;
  if (currentSound && currentSound.duration()) {
    const seekTime = (parseFloat(e.target.value) / 100) * currentSound.duration();
    currentTimeEl.innerText = formatTime(seekTime);
  }
});

playerProgressBar.addEventListener('change', (e) => {
  if (currentSound && currentSound.duration()) {
    const seekTime = (parseFloat(e.target.value) / 100) * currentSound.duration();
    currentSound.seek(seekTime);
    if (!isPlaying) {
      currentSound.play();
    }
  }
  isDraggingProgress = false;
});

closePlayerBtn.addEventListener('click', () => {
  if (currentSound) currentSound.stop();
  playerBar.classList.add('translate-y-full');
});

playPauseBtn.addEventListener('click', () => {
  if (!currentSound) return;
  if (isPlaying) {
    currentSound.pause();
  } else {
    currentSound.play();
  }
});

volumeSlider.addEventListener('input', (e) => {
  if (currentSound) currentSound.volume(e.target.value);
});

function updatePlayPauseUI() {
  const playIcon = document.getElementById('play-icon');
  const pauseIcon = document.getElementById('pause-icon');

  if (isPlaying) {
    playIcon.style.display = 'none';
    pauseIcon.style.display = 'block';
  } else {
    playIcon.style.display = 'block';
    pauseIcon.style.display = 'none';
  }
}

function startWaveform() {
  document.querySelectorAll('.waveform-bar').forEach(bar => {
    bar.classList.add('pulse-wave');
  });
}

function stopWaveform() {
  document.querySelectorAll('.waveform-bar').forEach(bar => {
    bar.classList.remove('pulse-wave');
  });
}

// Skip Controls
if (skipPrevBtn) skipPrevBtn.disabled = true;
if (skipNextBtn) skipNextBtn.disabled = true;

// Tempo Control (inline)
const tempoSelect = document.getElementById('tempo-select');

tempoSelect.addEventListener('change', (e) => {
  if (!currentSound) return;
  const rate = speedMap[e.target.value] || 1.0;
  currentSound.rate(rate);
});

// Close Control
closePlayerBtn.addEventListener('click', () => {
  if (currentSound) {
    currentSound.stop();
  }
  playerBar.classList.add('translate-y-full');
});

// hook up download button
downloadBtn.addEventListener('click', async () => {
  if (!generatedMixBlob) {
    alert("Please generate the unified mix first before downloading.");
    return;
  }

  const chosen = tempoSelect.value;
  if (!chosen) {
    alert('Please choose a tempo.');
    return;
  }

  // send blob and speed to server
  const formData = new FormData();
  formData.append('file', generatedMixBlob, `unified-v1.${generatedMixFormat}`);
  formData.append('speeds', chosen); // single speed now

  try {
    downloadBtn.disabled = true;
    statusText.innerText = '⏳ Adjusting tempo...';
    const resp = await fetch(`${API_BASE}/adjust-bpm`, { method: 'POST', body: formData });
    if (!resp.ok) throw new Error('Server error adjusting tempo');
    const resultBlob = await resp.blob();

    // unzip using JSZip and trigger download
    const jszip = new JSZip();
    const zip = await jszip.loadAsync(resultBlob);
    for (const filename of Object.keys(zip.files)) {
      const fileBlob = await zip.file(filename).async('blob');
      const url = URL.createObjectURL(fileBlob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = filename; // names already include extension (should be .flac)
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    }
    statusText.innerText = '';
  } catch (e) {
    console.error(e);
    statusText.innerText = '❌ Tempo adjustment failed.';
  } finally {
    downloadBtn.disabled = false;
  }
});

console.log('Main.js script loaded completely.');
