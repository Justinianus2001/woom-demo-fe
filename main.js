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

// Initialize Lucide Icons
lucide.createIcons();

// UI Elements
const assetInput = document.getElementById('asset-upload');
const pickedInput = document.getElementById('picked-upload');
const assetName = document.getElementById('asset-name');
const pickedName = document.getElementById('picked-name');
const mixBtn = document.getElementById('mix-btn');
const statusText = document.getElementById('status-text');
const mixGrid = document.getElementById('mix-grid');
const playerBar = document.getElementById('player-bar');
const playPauseBtn = document.getElementById('play-pause-btn');
const waveform = document.getElementById('waveform');
const volumeSlider = document.getElementById('volume-slider');
const skipPrevBtn = document.getElementById('skip-prev-btn');
const skipNextBtn = document.getElementById('skip-next-btn');
const downloadBtn = document.getElementById('download-btn');
const currentTimeEl = document.getElementById('current-time');
const totalTimeEl = document.getElementById('total-time');
const progressBar = document.getElementById('progress-bar');
const closePlayerBtn = document.getElementById('close-player-btn');
const tempoSelect = document.getElementById('tempo-select');

let progressAnimFrame;
let isDraggingProgress = false;

function formatTime(secs) {
    if (isNaN(secs)) return '0:00';
    const minutes = Math.floor(secs / 60) || 0;
    const seconds = Math.floor(secs % 60) || 0;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

function updateProgress() {
    if (currentSound && isPlaying) {
        if (!isDraggingProgress) {
            let seek = currentSound.seek() || 0;
            if (typeof seek !== 'number') seek = 0;
            
            currentTimeEl.innerText = formatTime(seek);
            if (currentSound.duration()) {
                progressBar.value = (seek / currentSound.duration()) * 100 || 0;
            }
        }
        progressAnimFrame = requestAnimationFrame(updateProgress);
    }
}

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

    // Re-poll every 10 seconds regardless of status to keep status continuous
    setTimeout(checkServerHealth, 10000);
};

// Start healthcheck on load
checkServerHealth();

// Setup Waveform
for (let i = 0; i < 40; i++) {
    const bar = document.createElement('div');
    bar.className = 'waveform-bar';
    bar.style.height = (20 + Math.random() * 60) + '%';
    waveform.appendChild(bar);
}

// File Selection Handlers
assetInput.addEventListener('change', (e) => {
    if (e.target.files[0]) assetName.innerText = e.target.files[0].name;
});
pickedInput.addEventListener('change', (e) => {
    if (e.target.files[0]) pickedName.innerText = e.target.files[0].name;
});

// Mix Generation Logic
mixBtn.addEventListener('click', async () => {
    const assetFile = assetInput.files[0];
    const pickedFile = pickedInput.files[0];

    if (!assetFile || !pickedFile) {
        alert("Please select both a music file and a heartbeat file.");
        return;
    }

    mixBtn.disabled = true;
    statusText.innerText = "⏳ Mixing magic in progress...";
    mixGrid.classList.add('opacity-50', 'grayscale', 'pointer-events-none');

    const formData = new FormData();
    formData.append('asset', assetFile);
    formData.append('picked', pickedFile);

    try {
        const response = await fetch(`${API_BASE}/mix-all`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) throw new Error("Server error during mixing.");

        statusText.innerText = "📦 Unzipping your journey...";
        const blob = await response.blob();
        const jszip = new JSZip();
        const zip = await jszip.loadAsync(blob);

        // Map files from ZIP with existence checks
        const versions = ["v1", "v2", "v3", "v4"];
        let successCount = 0;

        for (const v of versions) {
            const zipFile = zip.file(`${v}_mixed.mp3`);
            const card = document.querySelector(`.mix-card[data-version="${v}"]`);
            const statusBadge = card.querySelector('.mix-status');

            if (zipFile) {
                const fileBlob = await zipFile.async("blob");
                audioBlobs[v] = fileBlob;
                successCount++;

                // Update UI for success
                statusBadge.innerText = "READY";
                statusBadge.classList.replace('text-slate-400', 'text-green-500');
                statusBadge.classList.replace('border-slate-200', 'border-green-200');
                card.classList.remove('opacity-40');
            } else {
                audioBlobs[v] = null;
                // Update UI for failure
                statusBadge.innerText = "FAILED";
                statusBadge.classList.replace('text-slate-400', 'text-red-500');
                statusBadge.classList.replace('border-slate-200', 'border-red-200');
                card.classList.add('opacity-40', 'pointer-events-none');
            }
        }

        if (successCount > 0) {
            statusText.innerText = `✨ ${successCount}/4 styles generated! Choose one below.`;
            mixGrid.classList.remove('opacity-50', 'grayscale', 'pointer-events-none');
        } else {
            statusText.innerText = "❌ All mixing methods failed.";
        }

    } catch (error) {
        console.error(error);
        statusText.innerText = "❌ Something went wrong.";
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
    
    // Reset Progress Bar UI
    progressBar.value = 0;
    currentTimeEl.innerText = '0:00';
    totalTimeEl.innerText = '0:00';
    if (progressAnimFrame) cancelAnimationFrame(progressAnimFrame);

    currentSound = new Howl({
        src: [url],
        format: ['mp3'],
        volume: volumeSlider.value,
        rate: speedMap[tempoSelect.value] || 1.0,
        onload: () => {
            totalTimeEl.innerText = formatTime(currentSound.duration());
        },
        onplay: () => {
            isPlaying = true;
            updatePlayPauseUI();
            startWaveform();
            totalTimeEl.innerText = formatTime(currentSound.duration());
            progressAnimFrame = requestAnimationFrame(updateProgress);
        },
        onpause: () => {
            isPlaying = false;
            updatePlayPauseUI();
            stopWaveform();
            if (progressAnimFrame) cancelAnimationFrame(progressAnimFrame);
        },
        onstop: () => {
            isPlaying = false;
            updatePlayPauseUI();
            stopWaveform();
            if (progressAnimFrame) cancelAnimationFrame(progressAnimFrame);
            progressBar.value = 0;
            currentTimeEl.innerText = '0:00';
        },
        onend: () => {
            isPlaying = false;
            updatePlayPauseUI();
            stopWaveform();
            if (progressAnimFrame) cancelAnimationFrame(progressAnimFrame);
            progressBar.value = 0;
            currentTimeEl.innerText = '0:00';
        }
    });

    currentSound.play();
    activeVersion = version;
}

// Player Controls
progressBar.addEventListener('mousedown', () => isDraggingProgress = true);
progressBar.addEventListener('touchstart', () => isDraggingProgress = true);
progressBar.addEventListener('mouseup', () => isDraggingProgress = false);
progressBar.addEventListener('touchend', () => isDraggingProgress = false);

progressBar.addEventListener('input', (e) => {
    isDraggingProgress = true;
    if (currentSound && currentSound.duration()) {
        const seekTime = (parseFloat(e.target.value) / 100) * currentSound.duration();
        currentTimeEl.innerText = formatTime(seekTime);
    }
});

progressBar.addEventListener('change', (e) => {
    if (currentSound && currentSound.duration()) {
        const seekTime = (parseFloat(e.target.value) / 100) * currentSound.duration();
        currentSound.seek(seekTime);
        if (!isPlaying) {
            currentSound.play();
        }
    }
    isDraggingProgress = false;
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

// Tempo Control
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

// Download Control
downloadBtn.addEventListener('click', async () => {
    if (!activeVersion || !audioBlobs[activeVersion]) return;

    const chosen = tempoSelect.value;
    if (!chosen) {
        alert('Please choose a tempo.');
        return;
    }

    // send blob and speed to server
    const blob = audioBlobs[activeVersion];
    const formData = new FormData();
    formData.append('file', blob, `${activeVersion}.mp3`);
    formData.append('speeds', chosen); // single speed

    try {
        downloadBtn.disabled = true;
        const previousStatus = statusText.innerText;
        statusText.innerText = '⏳ Adjusting tempo & downloading...';
        
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
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 100);
        }
        statusText.innerText = '✅ Download complete!';
        setTimeout(() => { if (statusText.innerText === '✅ Download complete!') statusText.innerText = previousStatus; }, 3000);
    } catch (e) {
        console.error(e);
        statusText.innerText = '❌ Tempo adjustment failed.';
    } finally {
        downloadBtn.disabled = false;
    }
});
