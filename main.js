// Configuration - Load from config.js injected variables, fallback to localhost
const API_BASE = window.CONFIG.API_BASE;

// State
let currentSound = null;
let isPlaying = false;
let audioBlobs = { v1: null, v2: null, v3: null, v4: null };
let activeVersion = null;

// Tempo presets for both preview and server request
const speedMap = {
  Slow: 0.8,
  Normal: 1.0,
  Fast: 1.2
};

function formatTime(secs) {
  if (isNaN(secs)) return '0:00';
  const minutes = Math.floor(secs / 60) || 0;
  const seconds = Math.floor(secs % 60) || 0;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
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

console.log('Main.js: UI elements initialized. DownloadBtn:', downloadBtn);

let previewSound = null;
let isPreviewing = false;

const stopTrackPreview = () => {
  if (previewSound) {
    previewSound.stop();
    previewSound.unload();
    previewSound = null;
  }
  isPreviewing = false;
  previewIcon.setAttribute('data-lucide', 'play-circle');
  previewTrackBtn.classList.remove('text-green-500', 'bg-green-50');
  lucide.createIcons();
};

previewTrackBtn.addEventListener('click', () => {
  if (isPreviewing) {
    stopTrackPreview();
    return;
  }

  const trackName = trackSelect.value;
  if (!trackName) return;

  isPreviewing = true;
  previewIcon.setAttribute('data-lucide', 'loader-2');
  previewIcon.classList.add('animate-spin');
  lucide.createIcons();

  previewSound = new Howl({
    src: [`${API_BASE}/tracks/${trackName}`],
    html5: true,
    autoplay: true,
    onplay: () => {
      previewIcon.setAttribute('data-lucide', 'pause-circle');
      previewIcon.classList.remove('animate-spin');
      previewTrackBtn.classList.add('text-green-500', 'bg-green-50');
      lucide.createIcons();

      // Stop preview after 20 seconds
      setTimeout(() => {
        if (isPreviewing && previewSound) stopTrackPreview();
      }, 20000);
    },
    onend: stopTrackPreview,
    onloaderror: () => {
      alert('Error loading track preview');
      stopTrackPreview();
    },
    onplayerror: () => {
      alert('Error playing track preview');
      stopTrackPreview();
    }
  });
});

trackSelect.addEventListener('change', () => {
  if (isPreviewing) stopTrackPreview();
});

// Load available tracks on startup
const loadTracks = async () => {
  try {
    const resp = await fetch(`${API_BASE}/tracks`);
    const data = await resp.json();
    trackSelect.innerHTML = '';
    if (data.tracks && data.tracks.length > 0) {
      data.tracks.forEach(track => {
        const opt = document.createElement('option');
        opt.value = track;
        opt.textContent = track;
        trackSelect.appendChild(opt);
      });
      trackSelect.value = data.tracks[0];
    } else {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No tracks available';
      opt.disabled = true;
      trackSelect.appendChild(opt);
    }
  } catch (e) {
    console.error('Error loading tracks:', e);
    trackSelect.innerHTML = '<option>Error loading tracks</option>';
  }
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

      // Update Button UI if not already updated
      if (btnText && btnText.innerText !== "Generate Mixes") {
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
    if (btnText && btnText.innerText !== "Waking Server...") {
      btn.innerHTML = '<i data-lucide="power" class="animate-pulse"></i><span id="mix-btn-text">Waking Server...</span>';
      lucide.createIcons();
    }
  }

  // Re-poll every 6 seconds regardless of status to keep status continuous
  setTimeout(checkServerHealth, 6000);
};

// Start healthcheck and load tracks on load
checkServerHealth();
loadTracks();

// Setup Waveform
for (let i = 0; i < 40; i++) {
  const bar = document.createElement('div');
  bar.className = 'waveform-bar';
  bar.style.height = (20 + Math.random() * 60) + '%';
  waveform.appendChild(bar);
}

// File Selection Handlers
pickedInput.addEventListener('change', (e) => {
  if (e.target.files[0]) pickedName.innerText = e.target.files[0].name;
});

// Mix Generation Logic with Streaming
mixBtn.addEventListener('click', async () => {
  const pickedFile = pickedInput.files[0];
  const trackName = trackSelect.value;

  if (!trackName) {
    alert("Please select a background music track.");
    return;
  }

  if (!pickedFile) {
    alert("Please select a heartbeat file.");
    return;
  }

  mixBtn.disabled = true;

  // Reset cards to waiting state
  document.querySelectorAll('.mix-card').forEach(card => {
    card.classList.add('opacity-40', 'grayscale', 'pointer-events-none');
    const statusBadge = card.querySelector('.mix-status');
    statusBadge.innerText = "WAITING";
    statusBadge.classList.replace('text-green-500', 'text-slate-400');
    statusBadge.classList.replace('text-red-500', 'text-slate-400');
    statusBadge.classList.replace('border-green-200', 'border-slate-200');
    statusBadge.classList.replace('border-red-200', 'border-slate-200');
  });

  // Initial ETA estimation (roughly 8-10s per version if parallelized)
  statusText.innerText = "⏳ Estimating... (ETA ~30s)";
  progressBar.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressText.innerText = '0/4';

  const startTime = Date.now();
  let doneCount = 0;
  const totalCount = 4;

  const formData = new FormData();
  formData.append('picked', pickedFile);
  formData.append('track_name', trackName);

  try {
    const response = await fetch(`${API_BASE}/mix-all`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) throw new Error("Server error during mixing.");

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
          const { version, status, progress, data } = result;

          if (status === 'done' && data) {
            doneCount += 1;
            // decode audio
            const binaryString = atob(data);
            const bytes = new Uint8Array(binaryString.length);
            for (let j = 0; j < binaryString.length; j++) {
              bytes[j] = binaryString.charCodeAt(j);
            }
            const blob = new Blob([bytes], { type: 'audio/flac' });
            audioBlobs[version] = blob;

            // update card (only this version)
            const card = document.querySelector(`.mix-card[data-version="${version}"]`);
            card.classList.remove('opacity-40', 'grayscale', 'pointer-events-none');

            const statusBadge = card.querySelector('.mix-status');
            statusBadge.innerText = "READY";
            statusBadge.classList.replace('text-slate-400', 'text-green-500');
            statusBadge.classList.replace('border-slate-200', 'border-green-200');

            // update progress bar + ETA
            const [current, total] = progress.split('/').map(Number);
            progressFill.style.width = `${(current / total) * 100}%`;
            progressText.innerText = progress;

            // Recalculate ETA
            const elapsed = (Date.now() - startTime) / 1000;
            const avg = elapsed / doneCount;
            const remaining = totalCount - doneCount;
            const eta = Math.round(avg * remaining);
            statusText.innerText = `⏳ ${doneCount}/${totalCount} done — ETA ${eta}s`;

          } else if (status === 'failed') {
            const card = document.querySelector(`.mix-card[data-version="${version}"]`);
            const statusBadge = card.querySelector('.mix-status');
            statusBadge.innerText = "FAILED";
            statusBadge.classList.replace('text-slate-400', 'text-red-500');
            statusBadge.classList.replace('border-slate-200', 'border-red-200');
            card.classList.add('opacity-40', 'pointer-events-none');
          }
        } catch (e) {
          console.error('Error parsing line:', line, e);
        }
      }
    }

    const successCount = Object.values(audioBlobs).filter(b => b !== null).length;
    if (successCount > 0) {
      statusText.innerText = `✨ ${successCount}/${totalCount} styles generated! Choose one below.`;
    } else {
      statusText.innerText = "❌ All mixing methods failed.";
    }
    progressBar.classList.add('hidden');

  } catch (error) {
    console.error(error);
    statusText.innerText = "❌ Something went wrong.";
    progressBar.classList.add('hidden');
  } finally {
    mixBtn.disabled = false;
  }
});

// Card Click Handler
document.querySelectorAll('.mix-card').forEach(card => {
  card.addEventListener('click', () => {
    const version = card.getAttribute('data-version');
    playMix(version, card);
  });
});

function playMix(version, cardElement) {
  const blob = audioBlobs[version];
  if (!blob) return;

  // Update Player Bar UI
  playerBar.classList.remove('translate-y-full');
  document.getElementById('now-playing-title').innerText = cardElement.querySelector('h3').innerText;
  document.getElementById('now-playing-subtitle').innerText = cardElement.querySelector('.text-primary, .text-accent, .text-sage, .text-slate-600').innerText;
  document.getElementById('mini-cover').querySelector('img').src = cardElement.querySelector('img').src;

  // Pause existing
  if (currentSound) currentSound.stop();

  // Create new sound
  const url = URL.createObjectURL(blob);
  currentSound = new Howl({
    src: [url],
    format: ['flac'],
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
    }
  });

  currentSound.play();
  activeVersion = version;

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
  activeVersion = null;
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
const versionsOrder = ['v1', 'v2', 'v3', 'v4'];

skipPrevBtn.addEventListener('click', () => {
  if (!activeVersion) return;
  let currentIndex = versionsOrder.indexOf(activeVersion);
  let nextIndex = (currentIndex - 1 + versionsOrder.length) % versionsOrder.length;

  // Allow skipping through successfully generated versions
  while (!audioBlobs[versionsOrder[nextIndex]] && nextIndex !== currentIndex) {
    nextIndex = (nextIndex - 1 + versionsOrder.length) % versionsOrder.length;
  }

  if (nextIndex !== currentIndex && audioBlobs[versionsOrder[nextIndex]]) {
    const card = document.querySelector(`.mix-card[data-version="${versionsOrder[nextIndex]}"]`);
    playMix(versionsOrder[nextIndex], card);
  }
});

skipNextBtn.addEventListener('click', () => {
  if (!activeVersion) return;
  let currentIndex = versionsOrder.indexOf(activeVersion);
  let nextIndex = (currentIndex + 1) % versionsOrder.length;

  while (!audioBlobs[versionsOrder[nextIndex]] && nextIndex !== currentIndex) {
    nextIndex = (nextIndex + 1) % versionsOrder.length;
  }

  if (nextIndex !== currentIndex && audioBlobs[versionsOrder[nextIndex]]) {
    const card = document.querySelector(`.mix-card[data-version="${versionsOrder[nextIndex]}"]`);
    playMix(versionsOrder[nextIndex], card);
  }
});

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
  activeVersion = null;
});

// hook up download button
downloadBtn.addEventListener('click', async () => {
  if (!activeVersion) {
    alert("Please select a mix to play first before downloading.");
    return;
  }
  if (!audioBlobs[activeVersion]) {
    alert("Audio for this version is not ready yet.");
    return;
  }

  const chosen = tempoSelect.value;
  if (!chosen) {
    alert('Please choose a tempo.');
    return;
  }

  // send blob and speed to server
  const blob = audioBlobs[activeVersion];
  const formData = new FormData();
  formData.append('file', blob, `${activeVersion}.flac`); // rename extension to flac
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
