/* ══════════════════════════════════════════════
   VOICELOG — app.js (Complete Functional Logic)
══════════════════════════════════════════════ */

// Detect if we are running on a different port (e.g. Live Server on 5500) and point to 5000
const API_BASE = (window.location.port !== '5000' && window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') 
                ? 'http://127.0.0.1:5000/api' 
                : '/api';

const DRIVER_ID = localStorage.getItem('vl_uid') || 'driver1';

// Helper: get auth token (set by Firebase SDK in index.html when logged in)
function getAuthHeaders() {
    const token = window._VL_AUTH_TOKEN;
    if (!token) return { 'Content-Type': 'application/json' };
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

/* ──── STATE ──── */
let state = {
    currentPage: 'voice',
    tasks: {},
    driver: {},
    mapMini: null,
    mapFull: null,
    recognition: null,
    autoSpeak: true,
    voiceLang: 'en-US',
    filterStatus: 'all',
    searchQuery: '',
    isWakeWordActive: false,
    wakeWordRec: null,
    currentPosition: null, // [lat, lng]
    navigationSteps: [],
    currentStepIndex: 0,
    tasks: {},
    locationWatchId: null,
    isMainMicActive: false, // Prevents wake-word collision
    routePolyline: null,   // Persisted best-route polyline
    routePathPoints: null, // Persisted path coordinates for re-render
    chatLogs: [],          // Recent AI interaction logs
    isAISpeaking: false,   // Prevents feedback loops
};

let lastProcessedCommand = '';
let lastProcessedTime = 0;

function isDuplicateCommand(cmd) {
    if (!cmd) return false;
    const now = Date.now();
    const cleanCmd = cmd.trim().toLowerCase();
    if (cleanCmd === lastProcessedCommand && (now - lastProcessedTime < 2500)) {
        console.log("De-duplicating command:", cmd);
        return true;
    }
    lastProcessedCommand = cleanCmd;
    lastProcessedTime = now;
    return false;
}


/* ──── INIT ──── */
document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    initTopBar();
    initVoice();
    initChips();
    initMaps();
    initTasksPage();
    initSettings();
    initNotifications();
    fetchAll();
    monitorBattery();
    initWakeWord();
    initWakeLock();
    startGpsTracking();
    autoGreetDriver();

    // ── Real-time Firebase events (fired by index.html Firebase SDK block) ──
    window.addEventListener('vl-tasks-update', (e) => {
        state.tasks = e.detail || {};
        renderDriverStatus();
        renderNextDelivery();
        renderTaskPreview();
        renderTasksPage();
        renderRouteStops();
        updateDynamicMarkers();
        showToast('Tasks updated by admin in real-time!', 'success');
    });
    window.addEventListener('vl-driver-update', (e) => {
        state.driver = e.detail || {};
        renderDriverStatus();
    });

    window.addEventListener('vl-notification', (e) => {
        const notif = e.detail;
        showToast(`🔔 Admin Message: ${notif.message}`, 'primary');
        speak(`New message from Admin: ${notif.message}`);
        
        // Mark as read via API
        fetch(`${API_BASE}/notifications/${DRIVER_ID}/${notif.id}/read`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${window._VL_AUTH_TOKEN}` }
        }).catch(console.error);
    });

});

/* ════════════════════════════════
   NAVIGATION ROUTER
════════════════════════════════ */
function initNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            navigateTo(item.dataset.page);
            // Close mobile sidebar after nav
            document.getElementById('sidebar').classList.remove('mobile-open');
        });
    });

    // Menu toggle (mobile + collapse)
    document.getElementById('menu-toggle').addEventListener('click', () => {
        const sidebar = document.getElementById('sidebar');
        if (window.innerWidth <= 768) {
            sidebar.classList.toggle('mobile-open');
        } else {
            sidebar.classList.toggle('collapsed');
            const isCollapsed = sidebar.classList.contains('collapsed');
            document.querySelector('.main-panel').style.marginLeft = isCollapsed ? '72px' : 'var(--sidebar-w)';
        }
    });
}

window.navigateTo = function(page) {
    state.currentPage = page;

    // Update nav items active state
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === page);
    });

    // Show/hide page sections
    document.querySelectorAll('.page').forEach(p => {
        p.classList.toggle('active', p.id === `page-${page}`);
    });

    // Update page title
    const titles = {
        voice: 'Voice Dashboard',
        map: 'Delivery Map',
        tasks: 'Delivery Tasks',
        admin: 'Admin Overview',
        settings: 'Settings',
    };
    document.getElementById('page-title').textContent = titles[page] || page;

    // Lazy-init map full when tab becomes visible
    if (page === 'map') {
        if (!state.mapFull) {
            setTimeout(() => initMapFull(), 50);
        } else {
            setTimeout(() => {
                state.mapFull.invalidateSize();
                updateDynamicMarkers(); 
            }, 100);
        }
    }
    if (page === 'workview') {
        buildWorkview();
    }
};

/* ════════════════════════════════
   TOP BAR
════════════════════════════════ */
function initTopBar() {
    // Nothing extra needed — handled by network/battery monitors
}

function monitorNetwork() {
    const update = () => {
        const online = navigator.onLine;
        const el = document.getElementById('network-status');
        const label = document.getElementById('network-label');
        el.className = `status-pill ${online ? 'online' : 'offline'}`;
        label.textContent = online ? 'Online' : 'Offline';
    };
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
}

function monitorBattery() {
    if ('getBattery' in navigator) {
        navigator.getBattery().then(battery => {
            const update = () => {
                const pct = Math.round(battery.level * 100);
                document.getElementById('battery-label').textContent = `${pct}%`;
                const icons = {
                    75: 'fa-battery-three-quarters',
                    50: 'fa-battery-half',
                    25: 'fa-battery-quarter',
                    0:  'fa-battery-empty',
                };
                // pick right icon
                const icon = pct > 75 ? 'fa-battery-full' : pct > 50 ? 'fa-battery-three-quarters' : pct > 25 ? 'fa-battery-half' : 'fa-battery-quarter';
                const el = document.querySelector('.status-pill.battery i');
                el.className = `fas ${icon}`;
            };
            update();
            battery.addEventListener('levelchange', update);
        });
    }
}

/* ════════════════════════════════
   NOTIFICATIONS
════════════════════════════════ */
function initNotifications() {
    const btn = document.getElementById('notif-btn');
    const panel = document.getElementById('notif-panel');

    btn.addEventListener('click', (e) => {
        panel.classList.toggle('open');
        e.stopPropagation();
    });
    document.addEventListener('click', (e) => {
        if (!panel.contains(e.target) && e.target !== btn) {
            panel.classList.remove('open');
        }
    });

    document.getElementById('clear-notifs').addEventListener('click', () => {
        if (window._VL_CLEAR_NOTIFS) window._VL_CLEAR_NOTIFS();
        panel.classList.remove('open');
    });

    window.addEventListener('vl-notifications-list', (e) => {
        const notifs = e.detail || {};
        const listEl = document.getElementById('notif-list');
        const countEl = document.getElementById('notif-count');
        
        const notifArray = Object.entries(notifs).map(([id, n]) => ({id, ...n}))
                                .sort((a,b) => b.timestamp - a.timestamp); // newest first
        
        if (!notifArray.length) {
            listEl.innerHTML = '<p style="padding:16px;text-align:center;color:var(--text-muted);font-size:0.85rem">No new notifications</p>';
            countEl.textContent = '0';
            countEl.style.display = 'none';
            return;
        }

        const unreadCount = notifArray.filter(n => !n.read).length;
        countEl.textContent = unreadCount;
        countEl.style.display = unreadCount > 0 ? 'flex' : 'none';

        listEl.innerHTML = notifArray.map(n => `
            <div class="notif-item ${n.read ? '' : 'unread'}">
                <i class="fas fa-bell text-primary"></i>
                <div>
                    <b>Admin Message</b>
                    <p>${n.message}</p>
                    <span style="font-size:0.7rem;color:var(--text-muted)">${new Date(n.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                </div>
            </div>
        `).join('');
    });
}

let _lastCmdProcessed = { text: '', time: 0 };
function isDuplicateCommand(cmd) {
    if (!cmd) return false;
    const now = Date.now();
    const cleanCmd = cmd.toLowerCase().trim();
    if (_lastCmdProcessed.text === cleanCmd && (now - _lastCmdProcessed.time) < 3500) {
        return true;
    }
    _lastCmdProcessed = { text: cleanCmd, time: now };
    return false;
}

/* ════════════════════════════════
   WAKE WORD & WAKE LOCK
   (Hey Log)
════════════════════════════════ */
function initWakeWord() {

    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) return;

    let originalOnEnd = null;

    const wakeRec = new SpeechRec();
    wakeRec.continuous = true;
    wakeRec.interimResults = true;
    wakeRec.lang = state.voiceLang;

    // Fuzzy variants for "Hey Log"
    const HE_LOG_VARIANTS = ['hey log', 'hello log', 'hey long', 'hey look', 'hey lock', 'hey love', 'hey law', 'hey lo'];

    wakeRec.onresult = (e) => {
        // Prevent feedback loops: ignore voice if AI is speaking or main mic is active
        if (state.isAISpeaking || state.isMainMicActive) return;

        for (let i = e.resultIndex; i < e.results.length; ++i) {
            if (e.results[i].isFinal) {
                let command = e.results[i][0].transcript.trim();
                if (command.length < 3) continue;

                // Strip wake word prefix if present (any of HE_LOG_VARIANTS)
                let lowerCmd = command.toLowerCase();
                for (const v of HE_LOG_VARIANTS) {
                    if (lowerCmd.startsWith(v)) {
                        command = command.substring(v.length).trim();
                        break;
                    }
                }

                if (command.length >= 2) {
                    if (isDuplicateCommand(command)) continue;
                    console.log("WakeRec detected command:", command);
                    appendConvoMsg('driver', command);

                    // Visual feedback
                    const micRing = document.getElementById('mic-ring');
                    const micHint = document.getElementById('mic-hint');
                    if (micRing) {
                        micRing.classList.add('listening');
                        setTimeout(() => micRing.classList.remove('listening'), 1500);
                    }
                    if (micHint) {
                        micHint.textContent = "Processing...";
                        setTimeout(() => {
                            if (!state.isMainMicActive) {
                                micHint.textContent = "Say 'Hey Log' or any command...";
                            }
                        }, 2000);
                    }

                    processVoiceCommand(command);
                }
            }
        }

        // Update visual hint
        const micHint = document.getElementById('mic-hint');
        if (micHint && state.currentPage === 'voice' && !state.isMainMicActive) {
            micHint.textContent = "Listening for 'Hey Log' or any command...";
            micHint.classList.add('active');
        }
    };

    wakeRec.onerror = (e) => {
        if (e.error === 'aborted' || e.error === 'no-speech') return; // Silence common noise
        console.warn('Wake-word error:', e.error);

        // On network or other errors, try a restart
        if (e.error === 'network' || e.error === 'service-not-allowed') {
            state.isWakeWordActive = true;
        }
    };

    wakeRec.onend = () => {
        // Only restart if wake word is still active and we aren't using the main mic
        if (state.isWakeWordActive && !state.isMainMicActive) {
            setTimeout(() => {
                if (state.isWakeWordActive && !state.isMainMicActive) {
                    try { wakeRec.start(); } catch(err) {}
                }
            }, 300);
        }
    };
    originalOnEnd = wakeRec.onend;

    state.wakeWordRec = wakeRec;

    // Auto-start wake word detection immediately
    state.isWakeWordActive = true;
    try { wakeRec.start(); } catch(e) {}

    // ── HEARTBEAT: Keep-Alive ──
    // Chrome SpeechRec often dies silently or times out. 
    // This heartbeat ensures it's always running if active.
    setInterval(() => {
        if (state.isWakeWordActive && !state.isMainMicActive && !state.isAISpeaking) {
            try { 
                // Only start if not already running (starting twice throws an error)
                state.wakeWordRec.start(); 
            } catch(e) {
                // If it's already running, this catch is harmless
            }
        }
    }, 5000);
    
    // Sync toggle in settings UI
    const wakeToggle = document.getElementById('set-wake-word');
    if (wakeToggle) {
        wakeToggle.checked = true;
        wakeToggle.addEventListener('change', (e) => toggleWakeWord(e.target.checked));
    }
}

function toggleWakeWord(active) {
    state.isWakeWordActive = active;
    if (active && !state.isMainMicActive) {
        try { state.wakeWordRec.start(); } catch(e) {}
    } else {
        try { state.wakeWordRec.stop(); } catch(e) {}
    }
}

const SFX = {
    wake: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=', // Proxy beep
    success: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=' // Proxy success
};

function playSound(type) {
    // For now we use a simple synthetic beep if no assets.
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        
        if (type === 'wake') {
            osc.frequency.setValueAtTime(880, audioCtx.currentTime); 
            osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.1);
        } else {
            osc.frequency.setValueAtTime(440, audioCtx.currentTime); 
            osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.1);
        }
        
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
        
        osc.start();
        osc.stop(audioCtx.currentTime + 0.1);
    } catch(e) {}
}

function triggerVoiceDashboard(startMic = true) {
    navigateTo('voice');
    playSound('wake');
    if ('vibrate' in navigator) navigator.vibrate(100);
    
    // Visual cue
    const micHint = document.getElementById('mic-hint');
    if (micHint) {
        micHint.textContent = "I'm listening...";
        micHint.classList.remove('active');
        micHint.style.color = "var(--primary)";
    }

    if (startMic) {
        state.isMainMicActive = true;
        const micBtn = document.getElementById('mic-btn');
        if (micBtn && !micBtn.classList.contains('listening')) {
            // Short delay to ensure hardware release of wake listener
            setTimeout(() => {
                try { 
                    // Trigger click on mic button to start MediaRecorder
                    micBtn.click();
                } catch(e) {
                    console.warn("Mic start retry", e);
                }
            }, 300);
        }
    }
}

function autoGreetDriver() {
    const name = localStorage.getItem('vl_name') || 'Driver';
    const hours = new Date().getHours();
    const greeting = hours < 12 ? 'Good morning' : hours < 17 ? 'Good afternoon' : 'Good evening';
    const msg = `${greeting}, ${name}! Hands-free mode is active. You can say "Hey Log" anytime to give a command.`;
    
    setTimeout(() => {
        showToast(`🎙️ ${greeting}, ${name}! Hands-free mode is active.`, 'success');
        speak(msg);
    }, 1500);
}

function speak(text, onEndCallback = null) {
    if (!state.autoSpeak || !('speechSynthesis' in window)) {
        if (onEndCallback) onEndCallback();
        return;
    }
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = state.voiceLang;
    utt.rate = 1.0;
    
    utt.onstart = () => { state.isAISpeaking = true; };
    utt.onend = () => { 
        state.isAISpeaking = false; 
        if (onEndCallback) onEndCallback();
    };
    utt.onerror = () => {
        state.isAISpeaking = false;
        if (onEndCallback) onEndCallback();
    };

    window.speechSynthesis.speak(utt);
}

async function initWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            const wakeLock = await navigator.wakeLock.request('screen');
            console.log('Wake Lock is active');
        } catch (err) {
            console.warn(`Wake Lock error: ${err.name}, ${err.message}`);
        }
    }
}

/* ════════════════════════════════
   VOICE ASSISTANT
════════════════════════════════ */
function initVoice() {
    const micBtn = document.getElementById('mic-btn');
    const micRing = document.getElementById('mic-ring');
    const micHint = document.getElementById('mic-hint');

    // Secure context check
    if (!window.isSecureContext && location.hostname !== 'localhost') {
        showToast('Voice requires HTTPS or localhost in many browsers!', 'error');
    }

    let mediaRecorder = null;
    let audioChunks = [];
    let autoStopTimer = null;

    async function startRecording() {
        if (state.isMainMicActive) return; // Prevent double-start
        try {
            // Temporarily stop wake word detection to avoid mic conflicts
            state.isWakeWordActive = false;
            if (state.wakeWordRec) {
                try { state.wakeWordRec.stop(); } catch(e) {}
            }

            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);

            // Initialize local Speech Recognition to transcribe client-side
            let localSpeechRec = null;
            let transcribedText = '';
            const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (SpeechRec) {
                localSpeechRec = new SpeechRec();
                localSpeechRec.continuous = false;
                localSpeechRec.interimResults = false;
                localSpeechRec.lang = state.voiceLang;
                localSpeechRec.onresult = (event) => {
                    if (event.results.length > 0) {
                        transcribedText = event.results[0][0].transcript.trim();
                        console.log("Local speech recognition transcript:", transcribedText);
                    }
                };
                localSpeechRec.onerror = (e) => {
                    if (e.error !== 'aborted' && e.error !== 'no-speech') {
                        console.warn("Local SpeechRec error during recording:", e.error);
                    }
                };
            }

            // Web Audio API for auto silence detection
            let audioContext = null;
            let analyser = null;
            let source = null;
            try {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                source = audioContext.createMediaStreamSource(stream);
                analyser = audioContext.createAnalyser();
                analyser.fftSize = 256;
                source.connect(analyser);
            } catch (ae) {
                console.warn("Could not setup audio context for silence detection:", ae);
            }

            mediaRecorder.onstart = () => {
                state.isMainMicActive = true;
                micBtn.classList.add('listening');
                micRing.classList.add('listening');
                micHint.textContent = '🎤 Listening... (speak now)';
                document.getElementById('mic-icon').className = 'fas fa-stop';
                audioChunks = [];

                if (localSpeechRec) {
                    try { localSpeechRec.start(); } catch(err) {
                        console.warn("Could not start local SpeechRec:", err);
                    }
                }

                // Auto-stop after 8 seconds max as a safety backup
                autoStopTimer = setTimeout(() => {
                    if (mediaRecorder && mediaRecorder.state === 'recording') {
                        mediaRecorder.stop();
                    }
                }, 8000);

                // Auto silence detection logic
                if (analyser) {
                    let hasSpoken = false;
                    let silenceStart = null;
                    const threshold = 15; // Volume threshold
                    const silenceDuration = 1500; // Stop after 1.5 seconds of silence
                    const pcmData = new Uint8Array(analyser.frequencyBinCount);

                    function monitorAudioSilence() {
                        if (!mediaRecorder || mediaRecorder.state !== 'recording') return;

                        analyser.getByteFrequencyData(pcmData);
                        let maxVal = 0;
                        for (let i = 0; i < pcmData.length; i++) {
                            if (pcmData[i] > maxVal) maxVal = pcmData[i];
                        }

                        const now = Date.now();
                        if (maxVal > threshold) {
                            hasSpoken = true;
                            silenceStart = null;
                        } else if (hasSpoken) {
                            if (!silenceStart) {
                                silenceStart = now;
                            } else if (now - silenceStart > silenceDuration) {
                                console.log("Silence detected. Auto-stopping...");
                                mediaRecorder.stop();
                                return;
                            }
                        }
                        requestAnimationFrame(monitorAudioSilence);
                    }

                    // Start monitoring after 800ms to allow user to begin speaking
                    setTimeout(() => {
                        if (mediaRecorder && mediaRecorder.state === 'recording') {
                            requestAnimationFrame(monitorAudioSilence);
                        }
                    }, 800);
                }
            };

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) audioChunks.push(e.data);
            };

            mediaRecorder.onstop = () => {
                clearTimeout(autoStopTimer);
                if (audioContext) {
                    try { audioContext.close(); } catch(e) {}
                }
                resetMic();
                state.isMainMicActive = false;

                if (localSpeechRec) {
                    try { localSpeechRec.stop(); } catch(e) {}
                }

                // Short delay to allow speech recognition onresult to complete
                setTimeout(() => {
                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    const finalCmd = transcribedText || '';
                    if (finalCmd && isDuplicateCommand(finalCmd)) {
                        console.log("De-duplicating voice recording command:", finalCmd);
                        return;
                    }
                    if (finalCmd) {
                        appendConvoMsg('driver', finalCmd);
                    } else {
                        appendConvoMsg('driver', '🎤 Voice command sent...');
                    }
                    processAudioCommand(audioBlob, finalCmd);
                }, 300);

                // Stop all tracks to release mic hardware
                stream.getTracks().forEach(track => track.stop());

                // Restore wake word detection
                state.isWakeWordActive = true;
                if (state.wakeWordRec) {
                    setTimeout(() => {
                        if (state.isWakeWordActive && !state.isMainMicActive) {
                            try { state.wakeWordRec.start(); } catch(e) {}
                        }
                    }, 400);
                }
            };

            mediaRecorder.start();
        } catch (err) {
            console.error('Error accessing microphone', err);
            showToast('Microphone permission denied or not available.', 'error');
            resetMic();
            state.isMainMicActive = false;
        }
    }

    // Expose globally so wake word trigger can call it directly
    window.startRecording = startRecording;

    micBtn.addEventListener('click', () => {
        if (micBtn.classList.contains('listening')) {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
            }
        } else {
            startRecording();
        }
    });
}

function resetMic() {
    const micBtn = document.getElementById('mic-btn');
    const micRing = document.getElementById('mic-ring');
    const micHint = document.getElementById('mic-hint');
    micBtn.classList.remove('listening');
    micRing.classList.remove('listening');
    micHint.textContent = "Say 'Hey Log'...";
    micHint.classList.add('active');
    document.getElementById('mic-icon').className = 'fas fa-microphone';
}

function appendConvoMsg(type, text) {
    const box = document.getElementById('convo-box');
    // Remove placeholder
    const placeholder = box.querySelector('.convo-placeholder');
    if (placeholder) placeholder.remove();

    const div = document.createElement('div');
    div.className = `convo-msg ${type}`;
    
    if (type === 'driver') {
        div.innerHTML = `<div><div class="convo-label">Driver</div>${escHtml(text)}</div>`;
    } else {
        div.innerHTML = `<i class="fas fa-robot"></i><div><div class="convo-label">AI Assistant</div>${text}</div>`;
    }
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;

    // Track for Workview
    state.chatLogs.unshift({ type, text, time: Date.now() });
    if (state.chatLogs.length > 20) state.chatLogs.pop(); // keep last 20

    if (state.currentPage === 'workview') buildWorkview();
}

function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function initChips() {
    document.querySelectorAll('.chip[data-cmd]').forEach(chip => {
        chip.addEventListener('click', () => {
            const cmd = chip.dataset.cmd;
            if (isDuplicateCommand(cmd)) return;
            appendConvoMsg('driver', cmd);
            processVoiceCommand(cmd);
        });
    });
}

async function processAudioCommand(audioBlob, commandText) {
    try {
        const formData = new FormData();
        formData.append('audio', audioBlob, 'command.webm');
        formData.append('uid', DRIVER_ID);
        if (commandText) {
            formData.append('command', commandText);
        }

        const headers = { ...getAuthHeaders() };
        delete headers['Content-Type']; // Let browser set multipart boundary

        const res = await fetch(`${API_BASE}/processVoice`, {
            method: 'POST',
            headers: headers,
            body: formData,
        });
        const data = await res.json();
        await handleVoiceResponse(data);
    } catch (err) {
        appendConvoMsg('ai', 'Could not reach the server. Please check your connection.');
        showToast('Server error', 'error');
        state.isMainMicActive = false;
    }
}

async function processVoiceCommand(command) {
    if (!command || command.trim().length < 2) {
        console.log("Ignoring empty or too short voice command");
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/processVoice`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ command, uid: DRIVER_ID }),
        });
        const data = await res.json();
        await handleVoiceResponse(data);
    } catch (err) {
        appendConvoMsg('ai', 'Could not reach the server. Please check your connection.');
        showToast('Server error', 'error');
    } finally {
        // Ensure mic state is released even on error (if not already handled by onend)
        state.isMainMicActive = false;
    }
}

async function handleVoiceResponse(data) {
    // If data is an array, take the first element (common with N8N webhooks)
    if (Array.isArray(data) && data.length > 0) {
        data = data[0];
    }
    if (!data || typeof data !== 'object') {
        data = { reply: 'Command received.' };
    }

    // Extract text reply from all potential N8N response fields
    const replyText = data.reply || data.message || data.output || data.text || data.response || data.answer || data.fulfillmentText || data.result || '';
    data.reply = replyText;

    // Show text reply
    const displayMessage = replyText || 'Command processed successfully.';
    const replyHtml = escHtml(displayMessage);
    appendConvoMsg('ai', replyHtml);

    // Play Groq TTS audio from N8N if provided
    if (state.autoSpeak && (data.audio_base64 || data.audio_url)) {
        let audioSrc = data.audio_url;
        if (data.audio_base64) {
            let b64 = data.audio_base64;
            if (!b64.startsWith('data:')) b64 = 'data:audio/mp3;base64,' + b64;
            audioSrc = b64;
        }
        const audio = new Audio(audioSrc);
        state.isAISpeaking = true;
        audio.onended = () => { state.isAISpeaking = false; };
        audio.onerror  = () => { state.isAISpeaking = false; };
        audio.play().catch(e => { console.error('Audio play failed', e); state.isAISpeaking = false; });
    } else if (state.autoSpeak && 'speechSynthesis' in window && displayMessage) {
        speak(displayMessage); // Fallback to browser TTS
    }

    // Handle UI actions from N8N response
    if (data.action) {
        const act = data.action;
        if (act.type === 'UPDATE_UI' || act.type === 'UPDATE_STATUS') {
            await fetchAll();
            showToast(`Shipment ${act.shipmentId || ''} updated to "${act.status}" ✓`, 'success');
        } else if (act.type === 'HIGHLIGHT_SHIPMENT') {
            showToast(`Viewing shipment ${act.id}`, 'success');
            navigateTo('map');
            if (act.id) {
                setTimeout(() => {
                    const matchedTask = Object.values(state.tasks).find(t => 
                        String(t.shipmentId) === String(act.id)
                    );
                    if (matchedTask && matchedTask.latitude && matchedTask.longitude) {
                        if (state.mapFull) {
                            state.mapFull.setView([matchedTask.latitude, matchedTask.longitude], 15);
                            const marker = taskMarkers.find(m => {
                                const latLng = m.getLatLng();
                                return Math.abs(latLng.lat - matchedTask.latitude) < 0.0001 &&
                                       Math.abs(latLng.lng - matchedTask.longitude) < 0.0001;
                            });
                            if (marker) marker.openPopup();
                        }
                    }
                }, 600);
            }
        } else if (act.type === 'NAVIGATE') {
            showToast(`Navigating to ${act.address || 'next stop'}`, 'success');
            navigateTo('map');
            setTimeout(() => {
                // Resolve the target task: strictly by shipmentId, fallback to next pending
                let targetTask = null;
                if (act.shipmentId) {
                    targetTask = Object.values(state.tasks).find(t =>
                        String(t.shipmentId) === String(act.shipmentId)
                    );
                }
                if (!targetTask) {
                    targetTask = getNextPendingTask();
                }

                if (!targetTask) return;

                const targetId = String(targetTask.shipmentId);

                if (targetTask.latitude && targetTask.longitude) {
                    if (state.mapFull) {
                        state.mapFull.setView([targetTask.latitude, targetTask.longitude], 15);
                        // Find marker by its shipmentId tag — works even when multiple
                        // shipments share the same GPS coordinates
                        const marker = taskMarkers.find(m => m._shipmentId === targetId);
                        if (marker) marker.openPopup();
                    }
                } else {
                    // No GPS coords for this shipment — show a helpful toast
                    showToast(`📍 Next stop: Shipment ${targetId} at ${targetTask.address || 'address unknown'} — no GPS pin yet`, 'warning');
                }
            }, 700);
        } else if (act.type === 'NAVIGATE_SHORTEST') {
            calculateShortestPath();
            navigateTo('map');
        } else if (act.type === 'SHOW_STATS') {
            navigateTo('tasks');
        } else if (act.type === 'UPDATE_ETA') {
            showToast(`Delay logged. ETAs updated by +${act.minutes} mins`, 'warning');
        } else if (act.type === 'SWITCH_LANG') {
            state.voiceLang = act.lang;
            if (state.wakeWordRec) {
                try { state.wakeWordRec.stop(); } catch(e) {}
                state.wakeWordRec.lang = act.lang;
                if (state.isWakeWordActive) try { state.wakeWordRec.start(); } catch(e) {}
            }
            showToast(`🌐 Language switched to ${act.lang}`, 'success');
        } else if (act.type === 'TRACK_DRIVER') {
            showDriverOnMap(act.uid, act.name);
        } else if (act.type === 'NEXT_DIRECTION') {
            readNextDirection();
        } else if (act.type === 'REPEAT_DIRECTION') {
            repeatDirection();
        }
    }

    updateDynamicMarkers();
    state.isMainMicActive = false;
}

function startGpsTracking() {
    if ("geolocation" in navigator) {
        state.locationWatchId = navigator.geolocation.watchPosition((pos) => {
            const { latitude, longitude } = pos.coords;
            state.currentPosition = [latitude, longitude];
            updateMapPosition(latitude, longitude);
            syncLocationToFirebase(latitude, longitude);
        }, (err) => {
            console.warn("GPS error", err);
        }, {
            enableHighAccuracy: true,
            maximumAge: 10000,
            timeout: 5000
        });
    }
}

function syncLocationToFirebase(lat, lng) {
    fetch(`${API_BASE}/updateLocation`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ uid: DRIVER_ID, latitude: lat, longitude: lng })
    });
}

function updateMapPosition(lat, lng) {
    if (state.mapMini) state.mapMini.setView([lat, lng], 15);
    if (state.mapFull) {
        // Update driver marker
        if (window.driverMarker) {
            window.driverMarker.setLatLng([lat, lng]);
        } else {
            window.driverMarker = L.marker([lat, lng], {
                icon: L.divIcon({ className: 'driver-icon', html: '<i class="fas fa-truck" style="color:var(--primary); font-size:1.5rem;"></i>' })
            }).addTo(state.mapFull);
        }
    }
}

async function showDriverOnMap(uid, name) {
    navigateTo('map');
    if (!state.mapFull) {
        // Wait for map to init
        setTimeout(() => showDriverOnMap(uid, name), 500);
        return;
    }

    try {
        const headers = getAuthHeaders();
        const res = await fetch(`${API_BASE}/driver/location/${uid}`, { headers });
        const loc = await res.json();

        if (loc.latitude && loc.longitude) {
            const pos = [loc.latitude, loc.longitude];
            state.mapFull.setView(pos, 16);

            // Create or update special marker for tracked driver
            if (window.trackedDriverMarker) {
                window.trackedDriverMarker.setLatLng(pos);
            } else {
                window.trackedDriverMarker = L.marker(pos, {
                    icon: L.divIcon({ 
                        className: 'tracked-driver-icon', 
                        html: `<div class="marker-pin-label">${name}</div><i class="fas fa-truck-moving" style="color:var(--secondary); font-size:1.8rem;"></i>` 
                    })
                }).addTo(state.mapFull);
            }
            showToast(`Tracking ${name} live on map`, 'primary');
        }
    } catch (e) {
        console.error('Track driver error', e);
        showToast('Could not fetch driver location.', 'error');
    }
}

async function calculateShortestPath() {
    const tasks = Object.values(state.tasks).filter(t => {
        const s = String(t.status || '').toLowerCase();
        return s !== 'completed' && s !== 'delivered' && t.latitude && t.longitude;
    });

    // Auto-navigate to map and wait for it to initialize
    navigateTo('map');
    if (!state.mapFull) {
        await new Promise(resolve => setTimeout(resolve, 400));
        if (!state.mapFull) initMapFull();
    }

    if (tasks.length === 0) {
        const next = Object.values(state.tasks).find(t => {
            const s = String(t.status || '').toLowerCase();
            return s !== 'completed' && s !== 'delivered';
        });
        if (next) {
            speak(`I couldn't find coordinates to optimize the route, but your next stop is shipment ${next.shipmentId} at ${next.address}.`);
            navigateTo('map');
        } else {
            speak("You have no pending shipments to optimize.");
        }
        return;
    }

    const start = state.currentPosition || DRIVER_LATLNG;
    showToast('Calculating optimized route for your pending shipments...', 'primary');
    
    // Greedy Proximity Sorting (Nearest Neighbor)
    const optimizedTasks = [];
    let currentPos = start;
    let remaining = [...tasks];

    while (remaining.length > 0) {
        remaining.sort((a, b) => {
            const distA = Math.hypot(a.latitude - currentPos[0], a.longitude - currentPos[1]);
            const distB = Math.hypot(b.latitude - currentPos[0], b.longitude - currentPos[1]);
            return distA - distB;
        });
        const next = remaining.shift();
        optimizedTasks.push(next);
        currentPos = [next.latitude, next.longitude];
    }

    const pathPoints = [start, ...optimizedTasks.map(t => [t.latitude, t.longitude])];
    
    // Persist route for re-renders
    state.routePathPoints = pathPoints;
    
    // Convert optimized tasks into actionable directions
    state.navigationSteps = [
        `Start from your current position.`,
        ...optimizedTasks.map((t) => `Proceed to Shipment ${t.shipmentId} at ${t.address || 'the delivery location'}.`),
        "You have reached all your optimized destinations. Great job!"
    ];
    state.currentStepIndex = 0;

    renderNavigationGuidelines(state.navigationSteps);
    speak(state.navigationSteps[0] + " Your first stop is " + optimizedTasks[0].address);

    if (state.mapFull) {
        // Remove old route if exists
        if (state.routePolyline) {
            try { state.mapFull.removeLayer(state.routePolyline); } catch(e) {}
        }
        state.routePolyline = L.polyline(pathPoints, {
            color: '#1DB954', weight: 6, opacity: 0.9, dashArray: '5 10'
        }).addTo(state.mapFull);
        state.mapFull.fitBounds(state.routePolyline.getBounds(), { padding: [50, 50] });
        showToast(`Optimized route displayed — ${optimizedTasks.length} stops`, 'success');
    }
}

function renderNavigationGuidelines(steps) {
    const container = document.getElementById('route-stops');
    if (!container) return;
    
    container.innerHTML = `<h3><i class="fas fa-location-arrow"></i> Navigation Guidelines</h3>`;
    steps.forEach((step, idx) => {
        const div = document.createElement('div');
        div.className = 'route-stop guidance-step';
        div.style.borderLeft = '4px solid var(--success)';
        div.innerHTML = `
            <div class="route-stop-icon stop-done" style="background:var(--success)">
                <i class="fas ${idx === steps.length - 1 ? 'fa-flag-checkered' : 'fa-arrow-turn-up'}"></i>
            </div>
            <div class="route-stop-info">
                <p style="font-weight:600; font-size:0.9rem;">${step}</p>
                <div class="route-stop-time">${idx === 0 ? 'Now' : (idx * 2) + ' min'}</div>
            </div>
        `;
        container.appendChild(div);
    });
}

function readNextDirection() {
    state.currentStepIndex++;
    if (state.currentStepIndex >= state.navigationSteps.length) {
        speak("You have reached the end of your route guidelines.");
        return;
    }
    const step = state.navigationSteps[state.currentStepIndex];
    speak(step);
    showToast(`Guidance: ${step}`, 'success');
    
    // Highlight the current step in the UI
    const stepsUi = document.querySelectorAll('.guidance-step');
    stepsUi.forEach((el, i) => {
        el.style.opacity = (i === state.currentStepIndex) ? '1' : '0.5';
        el.style.background = (i === state.currentStepIndex) ? 'var(--primary-light)' : 'transparent';
    });
}

function repeatDirection() {
    const step = (state.navigationSteps && state.navigationSteps[state.currentStepIndex]) || "No active route to read directions from.";
    speak(step);
    showToast(`Repeating: ${step}`, 'success');
}

/* ════════════════════════════════
   DATA FETCHING
════════════════════════════════ */
async function fetchAll() {
    if (!window._VL_AUTH_TOKEN) return; // Wait for auth
    try {
        const headers = getAuthHeaders();
        const [driverRes, tasksRes] = await Promise.all([
            fetch(`${API_BASE}/driverStatus/${DRIVER_ID}`, { headers }),
            fetch(`${API_BASE}/tasks/${DRIVER_ID}`,        { headers }),
        ]);

        state.driver = await driverRes.json();
        state.tasks  = await tasksRes.json();

        renderDriverStatus();
        renderNextDelivery();
        renderTaskPreview();
        renderTasksPage();
        renderRouteStops();
        updateWorkviewKPIs();

    } catch (e) {
        if (e.message !== 'NO_TOKEN') {
            console.error('Data fetch error', e);
        }
    }
}

function renderDriverStatus() {
    const d = state.driver;
    const name = d.name || 'Driver';
    document.getElementById('ds-name').textContent = name;
    document.getElementById('sidebar-driver-name').textContent = name;
    document.getElementById('stat-completed').textContent = d.completed || 0;
    document.getElementById('stat-pending').textContent   = d.pending   || 0;
    document.getElementById('stat-total').textContent = (d.completed || 0) + (d.pending || 0);
}

/**
 * Returns the true next pending task — sorts by numeric shipment ID
 * and double-checks status, mirroring the backend get_active_task() logic.
 */
function getNextPendingTask() {
    const DONE = new Set(['completed', 'delivered']);
    const candidates = Object.values(state.tasks).filter(t => {
        const s = String(t.status || '').toLowerCase();
        return !DONE.has(s);
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
        const idA = parseInt(String(a.shipmentId), 10) || Infinity;
        const idB = parseInt(String(b.shipmentId), 10) || Infinity;
        return idA - idB;
    });
    return candidates[0];
}

function renderNextDelivery() {
    const next = getNextPendingTask();
    if (next) {
        document.getElementById('nd-id').textContent   = `Shipment ${next.shipmentId}`;
        document.getElementById('nd-addr').textContent = next.address || '—';
        document.getElementById('nd-eta').textContent  = `Status: ${next.status}`;
        const markBtn = document.getElementById('nd-mark-btn');
        markBtn.dataset.shipment = next.shipmentId;
        const actionLabel = getStatusActionLabel(next.status);
        markBtn.innerHTML = `<i class="fas fa-circle-check"></i> ${actionLabel}`;
        markBtn.onclick = () => markDelivered(next.shipmentId);
    } else {
        document.getElementById('nd-id').textContent   = 'All deliveries done!';
        document.getElementById('nd-addr').textContent = '—';
        document.getElementById('nd-eta').textContent  = '✓';
        document.getElementById('nd-mark-btn').innerHTML = `<i class="fas fa-check"></i> Completed`;
    }
}

function renderTaskPreview() {
    const container = document.getElementById('voice-task-list');
    const tasks = Object.values(state.tasks);
    container.innerHTML = '';

    if (tasks.length === 0) {
        container.innerHTML = '<div class="loading-tasks">No tasks assigned</div>';
        return;
    }

    tasks.forEach(t => renderTaskItem(t, container));
}

function taskStatusClass(status) {
    const s = String(status).toLowerCase();
    if (s === 'completed' || s === 'delivered') return 'completed';
    if (s === 'in progress' || s === 'in transit' || s === 'picked up') return 'in-progress';
    return 'pending';
}

function taskStatusIcon(status) {
    const s = String(status).toLowerCase();
    if (s === 'completed' || s === 'delivered') return 'fa-check';
    if (s === 'in progress' || s === 'in transit') return 'fa-truck';
    if (s === 'picked up') return 'fa-box';
    return 'fa-clock';
}

function getNextStatus(current) {
    const s = String(current || 'Pending').toLowerCase();
    if (s === 'pending') return 'Picked Up';
    if (s === 'picked up') return 'In Transit';
    if (s === 'in transit') return 'Delivered';
    return null;
}

function getStatusActionLabel(current) {
    const next = getNextStatus(current);
    if (!next) return 'Completed ✓';
    return `Mark ${next}`;
}

function renderTaskItem(t, container) {
    const cls  = taskStatusClass(t.status);
    const icon = taskStatusIcon(t.status);
    const div = document.createElement('div');
    div.className = 'task-item';
    div.innerHTML = `
        <div class="task-status-dot ${cls}"><i class="fas ${icon}"></i></div>
        <div class="task-info">
            <h4>Shipment ${t.shipmentId}</h4>
            <p>${t.address || 'Address not available'}</p>
        </div>
        <div class="task-meta">
            <span class="task-badge ${cls}">${t.status}</span>
            <div class="task-eta"><i class="far fa-clock"></i> ${t.eta || '--'}</div>
        </div>
    `;
    container.appendChild(div);
}

/* ════════════════════════════════
   FULL TASKS PAGE
════════════════════════════════ */
function initTasksPage() {
    document.querySelectorAll('.filter-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            state.filterStatus = tab.dataset.filter;
            renderTasksPage();
        });
    });

    document.getElementById('task-search').addEventListener('input', (e) => {
        state.searchQuery = e.target.value.toLowerCase();
        renderTasksPage();
    });
}

function renderTasksPage() {
    const grid = document.getElementById('tasks-grid');
    if (!grid) return;
    grid.innerHTML = '';

    let tasks = Object.entries(state.tasks).map(([id, t]) => ({ id, ...t }));

    if (state.filterStatus !== 'all') {
        tasks = tasks.filter(t => t.status === state.filterStatus);
    }
    if (state.searchQuery) {
        tasks = tasks.filter(t =>
            t.shipmentId?.toString().includes(state.searchQuery) ||
            (t.address || '').toLowerCase().includes(state.searchQuery)
        );
    }

    if (tasks.length === 0) {
        grid.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;padding:12px">No tasks match your filter.</p>';
        return;
    }

    tasks.forEach(t => {
        const cls   = taskStatusClass(t.status);
        const icon  = taskStatusIcon(t.status);
        const isDone = cls === 'completed';
        const nextStatus = getNextStatus(t.status);
        const actionLabel = getStatusActionLabel(t.status);
        
        const card = document.createElement('div');
        card.className = 'task-card-full';
        card.innerHTML = `
            <div class="task-card-header">
                <div class="task-card-id">
                    <i class="fas ${icon} text-${cls === 'completed' ? 'success' : cls === 'in-progress' ? 'primary' : 'warning'}"></i>
                    &nbsp; Shipment ${t.shipmentId}
                </div>
                <span class="task-badge ${cls}">${t.status}</span>
            </div>
            <div class="task-card-body">
                <div class="task-card-row"><i class="fas fa-location-dot"></i><span>${t.address || '—'}</span></div>
                <div class="task-card-row"><i class="fas fa-clock"></i><span>ETA: ${t.eta || '—'}</span></div>
            </div>
            <div class="task-card-footer">
                <button class="deliver-btn" ${isDone ? 'disabled' : ''} data-shipment="${t.shipmentId}">
                    <i class="fas ${isDone ? 'fa-circle-check' : 'fa-arrow-right'}"></i> ${actionLabel}
                </button>
                <button class="detail-btn" data-shipment="${t.shipmentId}">
                    <i class="fas fa-eye"></i> Details
                </button>
            </div>
        `;

        if (!isDone) {
            card.querySelector('.deliver-btn').addEventListener('click', () => markDelivered(t.shipmentId));
        }
        card.querySelector('.detail-btn').addEventListener('click', () => showShipmentDetail(t));

        grid.appendChild(card);
    });
}

/* ════════════════════════════════
   STATUS UPDATE (Sequential: Pending → Picked Up → In Transit → Delivered)
════════════════════════════════ */
async function markDelivered(shipmentId) {
    // Find current status of the task
    const taskEntry = Object.values(state.tasks).find(t => String(t.shipmentId) === String(shipmentId));
    const currentStatus = taskEntry ? taskEntry.status : 'Pending';
    const nextStatus = getNextStatus(currentStatus);

    if (!nextStatus) {
        showToast(`Shipment ${shipmentId} is already delivered!`, 'warning');
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/updateShipment`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ shipmentId: String(shipmentId), status: nextStatus }),
        });
        const data = await res.json();
        if (data.success) {
            const statusEmoji = { 'Picked Up': '📦', 'In Transit': '🚛', 'Delivered': '✅' };
            showToast(`Shipment ${shipmentId}: ${statusEmoji[nextStatus] || ''} ${nextStatus}`, 'success');
            speak(`Shipment ${shipmentId} is now ${nextStatus}.`);
            await fetchAll();
        } else {
            showToast('Update failed: ' + (data.error || 'Unknown error'), 'error');
        }
    } catch (e) {
        showToast('Server error', 'error');
    }
}

function showShipmentDetail(task) {
    const detail = `
Shipment ID: ${task.shipmentId}
Address: ${task.address || 'N/A'}
Status: ${task.status}
ETA: ${task.eta || 'N/A'}
    `.trim();
    showToast(`Shipment ${task.shipmentId}: ${task.status} — ${task.address}`, 'success');
}

/* ════════════════════════════════
   MAPS
════════════════════════════════ */
let DRIVER_LATLNG = [13.0827, 80.2707]; // Default fallback (Chennai)
let taskMarkers = [];

const TILE_URL  = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/">OSM</a>';

function driverIcon() {
    return L.divIcon({
        className: '',
        html: `<div style="
            width:18px;height:18px;border-radius:50%;
            background:#0D6EFD;border:3px solid white;
            box-shadow:0 2px 8px rgba(13,110,253,0.5)">
        </div>`,
        iconSize: [18, 18], iconAnchor: [9, 9],
    });
}

function stopIcon(status) {
    const s = String(status || '').toLowerCase();
    const color = (s === 'completed' || s === 'delivered') ? '#1DB954'
                : (s === 'in transit' || s === 'in progress') ? '#F59E0B'
                : (s === 'picked up') ? '#8B5CF6'
                : '#9CA3AF';
    return L.divIcon({
        className: '',
        html: `<div style="
            width:14px;height:14px;border-radius:50%;
            background:${color};border:2px solid white;
            box-shadow:0 1px 5px rgba(0,0,0,0.3)">
        </div>`,
        iconSize: [14, 14], iconAnchor: [7, 7],
    });
}

function initMaps() {
    if (document.getElementById('map-mini')) {
        const center = state.currentPosition || DRIVER_LATLNG;
        state.mapMini = L.map('map-mini', { zoomControl: false, dragging: false, scrollWheelZoom: false, attributionControl: false })
            .setView(center, 12);
        L.tileLayer(TILE_URL, { attribution: TILE_ATTR }).addTo(state.mapMini);
        
        // We will add markers dynamically in updateDynamicMarkers()
        updateDynamicMarkers();
    }
}

function updateDynamicMarkers() {
    const tasks = Object.values(state.tasks);
    const center = state.currentPosition || DRIVER_LATLNG;

    // Update Mini Map
    if (state.mapMini) {
        // Clear old markers if any (simplified for prototype)
        state.mapMini.eachLayer(layer => {
            if (layer instanceof L.Marker || layer instanceof L.Polyline) {
                if (!layer._url) state.mapMini.removeLayer(layer); // don't remove tile layer
            }
        });

        L.marker(center, { icon: driverIcon() }).addTo(state.mapMini);
        
        const taskCoords = [center];
        tasks.forEach(t => {
            if (t.latitude && t.longitude) {
                const pos = [t.latitude, t.longitude];
                L.marker(pos, { icon: stopIcon(t.status) }).addTo(state.mapMini);
                taskCoords.push(pos);
            }
        });
        
        if (taskCoords.length > 1) {
            L.polyline(taskCoords, { color: '#0D6EFD', weight: 2, dashArray: '5 8', opacity: 0.6 }).addTo(state.mapMini);
        }
    }

    // Update Full Map
    if (state.mapFull) {
        // Remove existing task markers (not the route)
        taskMarkers.forEach(m => state.mapFull.removeLayer(m));
        taskMarkers = [];

        tasks.forEach(t => {
            if (t.latitude && t.longitude) {
                const pos = [t.latitude, t.longitude];
                const m = L.marker(pos, { icon: stopIcon(t.status) }).addTo(state.mapFull);
                m.bindPopup(`<b>Shipment ${t.shipmentId}</b><br>${t.address || 'Delivery Address'}<br><i>Status: ${t.status}</i>`);
                m._shipmentId = String(t.shipmentId); // Tag marker for direct lookup
                taskMarkers.push(m);
            }
        });

        // Re-draw the persisted best-route if it was calculated
        if (state.routePathPoints && state.routePathPoints.length > 1) {
            if (state.routePolyline) {
                try { state.mapFull.removeLayer(state.routePolyline); } catch(e) {}
            }
            state.routePolyline = L.polyline(state.routePathPoints, {
                color: '#1DB954', weight: 6, opacity: 0.9, dashArray: '5 10'
            }).addTo(state.mapFull);
        }
    }
}

function initMapFull() {
    const center = state.currentPosition || DRIVER_LATLNG;
    state.mapFull = L.map('map-full').setView(center, 12);
    L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(state.mapFull);

    // Driver marker
    window.driverMarker = L.marker(center, { icon: driverIcon() }).addTo(state.mapFull);
    window.driverMarker.bindPopup('<b>Your Location</b>').openPopup();

    setTimeout(() => {
        state.mapFull.invalidateSize();
        updateDynamicMarkers();
    }, 200);
}

function simulateDriverMovement() {
    // Disabled simulation for real-time tracking
    return;
}

function renderRouteStops() {
    const container = document.getElementById('route-stops');
    if (!container) return;
    container.innerHTML = '';

    console.log("renderRouteStops: state.tasks =", state.tasks);
    const tasks = Object.values(state.tasks);
    
    // Driver position
    const driverDiv = document.createElement('div');
    driverDiv.className = 'route-stop';
    driverDiv.innerHTML = `
        <div class="route-stop-icon driver"><i class="fas fa-truck"></i></div>
        <div class="route-stop-info">
            <h4>Live Position</h4>
            <p>${state.currentPosition ? 'Tracking GPS' : 'Awaiting GPS...'}</p>
            <div class="route-stop-time">${state.currentPosition ? state.currentPosition[0].toFixed(4) + ', ' + state.currentPosition[1].toFixed(4) : '--'}</div>
        </div>
    `;
    container.appendChild(driverDiv);

    // Sort tasks: pending/in-progress first (by shipment ID), then completed
    const DONE_S = new Set(['completed', 'delivered']);
    const sortedTasks = [...tasks].sort((a, b) => {
        const aDone = DONE_S.has(String(a.status).toLowerCase());
        const bDone = DONE_S.has(String(b.status).toLowerCase());
        if (aDone !== bDone) return aDone ? 1 : -1; // pending first
        return (parseInt(String(a.shipmentId), 10) || 0) - (parseInt(String(b.shipmentId), 10) || 0);
    });

    sortedTasks.forEach((t, idx) => {
        const s = String(t.status || '').toLowerCase();
        const isDone = DONE_S.has(s);
        const isNext = !isDone;
        const cls  = isDone ? 'stop-done' : isNext ? 'stop-next' : 'stop-pending';
        const icon = isDone ? 'fa-check' : (s === 'in transit' || s === 'in progress') ? 'fa-truck' : s === 'picked up' ? 'fa-box' : 'fa-clock';
        const div = document.createElement('div');
        div.className = 'route-stop';
        div.innerHTML = `
            <div class="route-stop-icon ${cls}"><i class="fas ${icon}"></i></div>
            <div class="route-stop-info">
                <h4>Stop ${idx + 1}: Shipment ${t.shipmentId}</h4>
                <p>${t.address || 'Address N/A'}</p>
                <div class="route-stop-time">ETA: ${t.eta || '—'} · ${t.status}</div>
            </div>
        `;
        container.appendChild(div);
    });
}

/* ════════════════════════════════
   DRIVER WORKVIEW
════════════════════════════════ */
function buildWorkview() {
    updateWorkviewKPIs();
    buildWorkviewTimeline();
    buildWorkviewLogs();
}

function updateWorkviewKPIs() {
    const d = state.driver;
    const total = (d.completed || 0) + (d.pending || 0);
    const wvTotal = document.getElementById('wv-total');
    const wvDone = document.getElementById('wv-done');
    const wvPending = document.getElementById('wv-pending');
    if (wvTotal) wvTotal.textContent = total;
    if (wvDone) wvDone.textContent = d.completed || 0;
    if (wvPending) wvPending.textContent = d.pending || 0;
}

function buildWorkviewTimeline() {
    const chart = document.getElementById('bar-chart');
    const labels = document.getElementById('bar-labels');
    if (!chart || !labels) return;
    chart.innerHTML = '';
    labels.innerHTML = '';

    const tasks = Object.values(state.tasks).filter(t => t.status === 'Completed' || t.status === 'Delivered');
    if (tasks.length === 0) {
        chart.innerHTML = '<div style="width:100%;text-align:center;color:var(--muted);padding-top:40px;">No completed deliveries yet.</div>';
        return;
    }

    // Only map last 7 completed tasks for the bar chart
    const recentTasks = tasks.slice(-7);
    let maxVal = 0;
    
    recentTasks.forEach(t => {
        // ETA vs Actual comparison
        let minutesTaken = 30; // default fallback
        
        // Very basic time estimation just for visual chart if no explicit startTime/completedTime
        if (t.eta) {
            // Rough mapping just to have data (in a real app, use timestamps)
            minutesTaken = 15 + Math.floor(Math.random() * 20); 
        }
        if (minutesTaken > maxVal) maxVal = minutesTaken;
        t._mins = minutesTaken;
    });

    recentTasks.forEach(t => {
        const pct = (t._mins / (maxVal || 1)) * 100;
        const isLate = t._mins > 45; // Just a visual mock rule for demonstration
        
        const wrap = document.createElement('div');
        wrap.className = 'bar-wrap';
        wrap.innerHTML = `
            <span class="bar-val">${t._mins}m</span>
            <div class="bar" style="height:${Math.max(10, pct)}%;background:${isLate ? 'var(--warning)' : '#BFDBFE'}"></div>
        `;
        chart.appendChild(wrap);

        const lbl = document.createElement('span');
        lbl.textContent = `Ship ${t.shipmentId || '?'}`;
        lbl.style.fontSize = '0.6rem';
        labels.appendChild(lbl);
    });
}

function buildWorkviewLogs() {
    const list = document.getElementById('wv-ai-logs');
    if (!list) return;

    if (!state.chatLogs || state.chatLogs.length === 0) {
        list.innerHTML = '<li style="color:var(--muted);text-align:center;padding:20px;">No recent interactions.</li>';
        return;
    }

    // Get up to 4 most recent
    const recent = state.chatLogs.slice(0, 4);
    list.innerHTML = recent.map(log => {
        const icon = log.type === 'driver' ? '<i class="fas fa-user-circle text-primary"></i>' : '<i class="fas fa-robot text-success"></i>';
        const label = log.type === 'driver' ? 'You' : 'AI Assistant';
        const timeStr = new Date(log.time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        return `
            <li>
                ${icon}
                <div style="flex:1">
                    <div style="font-size:0.75rem;color:var(--muted);margin-bottom:2px"><b>${label}</b> · ${timeStr}</div>
                    <div style="font-size:0.85rem">${log.text}</div>
                </div>
            </li>
        `;
    }).join('');
}

/* ════════════════════════════════
   SETTINGS
════════════════════════════════ */
function initSettings() {
    // Save Profile
    document.getElementById('save-profile').addEventListener('click', () => {
        const name = document.getElementById('set-driver-name').value.trim();
        if (name) {
            document.getElementById('ds-name').textContent = name;
            document.getElementById('sidebar-driver-name').textContent = name;
            showToast('Profile saved successfully ✓', 'success');
        }
    });

    // Auto speak toggle
    document.getElementById('set-autospeak').addEventListener('change', (e) => {
        state.autoSpeak = e.target.checked;
    });

    // Language select
    document.getElementById('set-lang').addEventListener('change', (e) => {
        state.voiceLang = e.target.value;
        if (state.recognition) state.recognition.lang = state.voiceLang;
        showToast(`Voice language changed to ${e.target.options[e.target.selectedIndex].text}`, 'success');
    });

    // Firebase connect
    document.getElementById('connect-firebase').addEventListener('click', () => {
        const url = document.getElementById('set-db-url').value.trim();
        if (!url) { showToast('Please enter a Firebase Database URL', 'warning'); return; }
        showToast('Connecting to Firebase...', 'success');
        setTimeout(() => {
            showToast('Tip: Add serviceAccountKey.json to d:\\voicelog\\ and restart app.py', 'warning');
        }, 2000);
    });

    // File drop
    const dropZone = document.getElementById('key-drop');
    const fileInput = document.getElementById('key-upload');
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = 'var(--primary)'; });
    dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = ''; });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file && file.name === 'serviceAccountKey.json') {
            dropZone.innerHTML = `<i class="fas fa-check-circle text-success"></i><p>${file.name} ready — restart the server</p>`;
            showToast('Key file selected. Restart app.py to connect.', 'success');
        } else {
            showToast('Please drop the serviceAccountKey.json file', 'error');
        }
    });
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (file) {
            dropZone.innerHTML = `<i class="fas fa-check-circle text-success"></i><p>${file.name} selected</p>`;
            showToast('Key selected. Restart app.py to activate Firebase.', 'success');
        }
    });

    // nd-mark-btn in voice page
    document.getElementById('nd-mark-btn').addEventListener('click', function() {
        markDelivered(this.dataset.shipment);
    });
}

/* ════════════════════════════════
   TOAST
════════════════════════════════ */
let toastTimer;
function showToast(msg, type = 'success') {
    const toast = document.getElementById('toast');
    toast.className = `toast ${type} show`;
    const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : '⚠';
    toast.innerHTML = `<span>${icon}</span> ${msg}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}

window.doLogout = async function() {
    if (confirm('Are you sure you want to log out?')) {
        // Firebase logout if defined in index.html global scope
        if (window._VL_LOGOUT) {
            window._VL_LOGOUT();
        } else {
            localStorage.clear();
            window.location.href = '/login';
        }
    }
};
console.log("test update");