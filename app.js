// NABOKO MVP — app.js (complete, DOM-ready, robust WebAudio, front/rear toggle, high-throughput scanning)
// Requirements: html5-qrcode included and index.html contains:
// optional: <button id="start-button">Start NABOKO</button>
// optional: <button id="toggle-camera" style="display:none;">Switch to Rear Camera</button>
// required: <div id="qr-reader" style="width:320px; display:none;"></div>
// required: <div id="hits"></div>

(function () {
  // --------- Configurable constants (tuned for throughput)
  const AUDIO_CTX = new (window.AudioContext || window.webkitAudioContext)();
  let DEBOUNCE_MS = 250;                   // lower debounce for faster repeats
  const MAX_SIMULTANEOUS_VOICES = 10;      // allow more concurrent voices
  const QR_CONFIG = { fps: 20, qrbox: 220 };
  const FRAME_WINDOW_MS = 50;              // gather decoded frames for 50ms windows
  const STAGGER_MS = 12;                   // tiny start stagger to avoid CPU spikes

  // --------- State
  let figuresMap = {};        // { id: { id, label, role, sound } }
  let audioBuffers = {};      // { "sounds/C.mp3": AudioBuffer }
  let lastPlayed = {};        // { "qr-001": timestamp }

  // DOM elements will be resolved after DOMContentLoaded
  let startBtn = null;
  let toggleBtn = null;
  const readerDivId = 'qr-reader';

  // --------- 1. Load JSON mapping
  async function loadMapping() {
    const res = await fetch('data/figures.json');
    if (!res.ok) throw new Error('Failed to load data/figures.json: ' + res.status);
    const json = await res.json();
    (json.figures || []).forEach(f => { figuresMap[f.id] = Object.assign({}, f, { id: f.id }); });
    console.log('Loaded mapping keys:', Object.keys(figuresMap));
  }

  // --------- 2. Preload audio (robust decodeAudioData handling)
  async function loadAudio(url) {
    if (audioBuffers[url]) return audioBuffers[url];

    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Failed to fetch audio: ' + url + ' status=' + resp.status);
    const ab = await resp.arrayBuffer();

    // Try promise-based decode first; fallback to callback style for older Safari
    try {
      const decoded = await AUDIO_CTX.decodeAudioData(ab);
      audioBuffers[url] = decoded;
      return decoded;
    } catch (err) {
      return new Promise((resolve, reject) => {
        try {
          AUDIO_CTX.decodeAudioData(ab, decoded => {
            audioBuffers[url] = decoded;
            resolve(decoded);
          }, decodeErr => {
            console.error('decodeAudioData callback error for', url, decodeErr);
            reject(decodeErr);
          });
        } catch (e) {
          console.error('decodeAudioData fallback failed for', url, e);
          reject(e);
        }
      });
    }
  }

  // --------- 3. Play an AudioBuffer with graceful fallback for panner
  function playBuffer(audioBuf, pan = 0, when = 0) {
    try {
      const src = AUDIO_CTX.createBufferSource();
      src.buffer = audioBuf;

      let node;
      if (typeof AUDIO_CTX.createStereoPanner === 'function') {
        const panner = AUDIO_CTX.createStereoPanner();
        try { panner.pan.value = pan; } catch (e) { /* ignore */ }
        node = panner;
      } else {
        node = AUDIO_CTX.createGain();
      }

      src.connect(node);
      node.connect(AUDIO_CTX.destination);
      src.start(AUDIO_CTX.currentTime + when);
    } catch (e) {
      console.error('playBuffer error', e);
    }
  }

  // --------- 4. High-throughput handleDecodedArray
  async function handleDecodedArray(decodedArray) {
    // decodedArray: array of decodedText strings (may contain duplicates)
    const now = Date.now();

    // Build ordered unique list preserving first occurrence
    const seen = new Set();
    const uniqueOrdered = [];
    for (const raw of decodedArray) {
      const id = (raw || '').trim();
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      uniqueOrdered.push(id);
    }

    // Filter by mapping and debounce timestamp
    const playableMetas = [];
    for (const id of uniqueOrdered) {
      const meta = figuresMap[id];
      if (!meta) continue;
      const last = lastPlayed[id] || 0;
      if (now - last < DEBOUNCE_MS) continue;
      lastPlayed[id] = now;
      playableMetas.push(meta);
    }

    if (playableMetas.length === 0) return;

    const toPlay = playableMetas.slice(0, MAX_SIMULTANEOUS_VOICES);
    console.log('To play', toPlay.map(p => ({ id: p.id, sound: p.sound })));

    // Ensure buffers are loaded (parallel)
    await Promise.all(toPlay.map(async m => {
      if (!audioBuffers[m.sound]) {
        try {
          await loadAudio(m.sound);
          console.log('Loaded audio for', m.sound);
        } catch (e) {
          console.warn('Failed to load audio', m.sound, e);
        }
      }
    }));

    // Play with tiny staggering and panning
    toPlay.forEach((m, idx) => {
      const buf = audioBuffers[m.sound];
      if (!buf) { console.warn('Missing buffer for', m.sound); return; }
      const pan = (idx / Math.max(1, toPlay.length - 1)) * 2 - 1; // -1..1
      const when = (idx * STAGGER_MS) / 1000;
      playBuffer(buf, pan, when);
      showUIHit(m);
    });
  }

  // --------- 5. Simple UI feedback function
  function showUIHit(meta) {
    const out = document.getElementById('hits');
    if (!out) return;
    const el = document.createElement('div');
    el.className = 'hit';
    el.textContent = `${meta.label} (${meta.role})`;
    out.prepend(el);
    setTimeout(() => el.remove(), 1500);
  }

  // --------- 6. Scanner + camera selection (high-throughput onSuccess)
  let html5QrCodeInstance = null;
  let usingFacing = 'user';

  async function pickCameraIdForFacing(facing) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter(d => d.kind === 'videoinput');
      if (videoInputs.length === 0) return null;
      if (facing === 'environment') {
        const match = videoInputs.find(d => /back|rear|environment|wide|ultrawide/i.test(d.label));
        if (match) return match.deviceId;
      } else {
        const front = videoInputs.find(d => /front|user|selfie/i.test(d.label));
        if (front) return front.deviceId;
      }
      return facing === 'environment' ? videoInputs[videoInputs.length - 1].deviceId : videoInputs[0].deviceId;
    } catch (e) {
      console.warn('Could not enumerate devices', e);
      return null;
    }
  }

  async function startScanner(facingPref = 'user') {
    if (html5QrCodeInstance) {
      try { await html5QrCodeInstance.stop(); } catch (e) { /* ignore */ }
      try { html5QrCodeInstance.clear(); } catch (e) { /* ignore */ }
      html5QrCodeInstance = null;
    }

    html5QrCodeInstance = new Html5Qrcode(readerDivId, false);

    let constraints;
    const id = await pickCameraIdForFacing(facingPref);
    if (id) constraints = { deviceId: { exact: id } };
    else constraints = { facingMode: facingPref };

    const rd = document.getElementById(readerDivId);
    if (rd) rd.style.display = 'block';
    if (toggleBtn) toggleBtn.style.display = 'inline-block';

    let frameBuffer = []; // collects decoded strings within FRAME_WINDOW_MS
    let frameTimer = null;

    function onSuccess(decodedText /*, decodedResult */) {
      const id = (decodedText || '').trim();
      if (!id) return;
      frameBuffer.push(id);
      if (frameTimer) return;
      frameTimer = setTimeout(() => {
        const batch = frameBuffer.slice();
        frameBuffer = [];
        frameTimer = null;
        handleDecodedArray(batch).catch(err => console.error(err));
      }, FRAME_WINDOW_MS);
    }

    function onError(err) {
      // ignore noisy errors
    }

    try {
      await html5QrCodeInstance.start(constraints, QR_CONFIG, onSuccess, onError);
      usingFacing = facingPref;
      if (toggleBtn) toggleBtn.textContent = usingFacing === 'user' ? 'Switch to Rear Camera' : 'Switch to Front Camera';
      console.log('Scanner started (high-throughput)', constraints);
    } catch (err) {
      console.error('Failed to start scanner with constraints', constraints, err);
      if (constraints && constraints.deviceId) {
        try {
          await html5QrCodeInstance.start({ facingMode: facingPref }, QR_CONFIG, onSuccess, onError);
          usingFacing = facingPref;
          if (toggleBtn) toggleBtn.textContent = usingFacing === 'user' ? 'Switch to Rear Camera' : 'Switch to Front Camera';
        } catch (e) {
          console.error('Fallback start also failed', e);
        }
      }
    }
  }

  // Toggle camera handler (safe)
  function setupToggle() {
    if (!toggleBtn) return;
    toggleBtn.addEventListener('click', async () => {
      const newFacing = usingFacing === 'user' ? 'environment' : 'user';
      toggleBtn.disabled = true;
      try { await startScanner(newFacing); } finally { toggleBtn.disabled = false; }
    });
  }

  // --------- Diagnostics helper (exposed on window)
  async function diagnosticPlayTest(url = 'sounds/C.mp3') {
    console.log('diagnosticPlayTest start for', url);
    try {
      if (AUDIO_CTX.state === 'suspended') {
        console.log('resuming audio context');
        await AUDIO_CTX.resume();
      }
      const r = await fetch(url);
      console.log('fetch', url, 'status', r.status, 'type', r.headers.get('content-type'), 'len', r.headers.get('content-length'));
      if (!r.ok) throw new Error('fetch failed ' + r.status);
      const buf = await loadAudio(url);
      console.log('decoded duration', buf && buf.duration);
      playBuffer(buf, 0);
      console.log('played', url);
    } catch (e) {
      console.error('diagnostic error', e);
    }
  }
  window.nabokoDiagnosticPlayTest = diagnosticPlayTest;

  // --------- 7. Boot / initialization (DOM-ready aware)
  async function boot() {
    try { await loadMapping(); } catch (e) { console.error('Failed loadMapping', e); return; }

    // Resolve DOM elements now that DOM is ready
    startBtn = document.getElementById('start-button');
    toggleBtn = document.getElementById('toggle-camera');

    setupToggle();

    if (startBtn) {
      // Mobile flow: wait for user gesture, resume audio and preload
      startBtn.addEventListener('click', async function onStart() {
        try {
          if (AUDIO_CTX.state === 'suspended') {
            await AUDIO_CTX.resume();
            console.log('AudioContext resumed');
          } else {
            console.log('AudioContext state:', AUDIO_CTX.state);
          }
        } catch (e) {
          console.warn('Audio resume failed', e);
        }

        // Preload all sounds (best-effort)
        try {
          const urls = Array.from(new Set(Object.values(figuresMap).map(f => f.sound)));
          console.log('Preloading sounds:', urls);
          await Promise.all(urls.map(u => loadAudio(u).catch(err => { console.warn('Preload failed for', u, err); })));
          console.log('Preload complete');
        } catch (e) {
          console.warn('Preload error', e);
        }

        startBtn.style.display = 'none';
        await startScanner('user').catch(err => console.error('Scanner start failed', err));
      });
    } else {
      // Desktop / no Start button flow: try auto-resume and auto-start
      try {
        if (AUDIO_CTX.state === 'suspended') {
          try { await AUDIO_CTX.resume(); console.log('AudioContext resumed (auto)'); } catch (e) { /* ignore */ }
        }
        const urls = Array.from(new Set(Object.values(figuresMap).map(f => f.sound)));
        await Promise.all(urls.map(u => loadAudio(u).catch(() => {})));
      } catch (e) { /* ignore preload errors */ }

      // Start scanner automatically for desktop
      startScanner('user').catch(err => console.error('Auto scanner start failed', err));
    }
  }

  // Wait for DOM then boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Expose tuning controls for runtime debugging (optional)
  window.nabokoTuning = {
    setDebounce(ms) { DEBOUNCE_MS = Number(ms) || DEBOUNCE_MS; console.log('DEBOUNCE_MS set to', DEBOUNCE_MS); },
    setFrameWindow(ms) { /* not dynamic in this build */ console.warn('Frame window is fixed in code'); },
    setMaxVoices(n) { /* not dynamic */ console.warn('Max voices fixed in code'); }
  };
})();
