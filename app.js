'use strict';

const $ = (s) => document.querySelector(s);
const els = {
  camera: $('#camera'), canvas: $('#analysisCanvas'), stage: $('#stage'), overlay: $('#ocrOverlay'),
  dim: $('#dimLayer'), guide: $('#guide'), status: $('#status'), scan: $('#scanButton'), resume: $('#resumeButton'),
  progressWrap: $('#progressWrap'), progress: $('#progress'), progressText: $('#progressText'),
  panel: $('#selectionPanel'), selectedText: $('#selectedText'), hint: $('#selectionHint'),
  speak: $('#speakButton'), clear: $('#clearSelectionButton'), layout: $('#layoutMode'),
  rate: $('#speechRate'), rateValue: $('#speechRateValue'), privacy: $('#privacyDialog'),
  privacyButton: $('#privacyButton'), closePrivacy: $('#closePrivacyButton')
};

const state = {
  stream: null, worker: null, busy: false, locked: false, units: [], startIndex: null, endIndex: null,
  frameWidth: 0, frameHeight: 0
};

async function startCamera() {
  stopCamera(); resetSelection(); clearBoxes();
  if (!navigator.mediaDevices?.getUserMedia) {
    els.status.textContent = 'このブラウザではカメラを利用できません。'; return;
  }
  try {
    els.status.textContent = 'カメラの使用を許可してください';
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    });
    els.camera.srcObject = state.stream;
    await els.camera.play();
    await waitForVideo(els.camera);
    state.locked = false;
    els.scan.disabled = false; els.scan.hidden = false; els.resume.hidden = true;
    els.guide.hidden = false; els.dim.hidden = true;
    els.status.textContent = '文字にかざし、端末を止めて「文字を探す」を押してください。';
    initWorker().catch(console.error);
  } catch (e) {
    console.error(e); els.status.textContent = cameraErrorMessage(e);
  }
}

function stopCamera() {
  state.stream?.getTracks().forEach(t => t.stop()); state.stream = null; els.camera.srcObject = null;
}

async function initWorker() {
  if (state.worker) return state.worker;
  setBusy(true, '文字認識を準備しています', 0);
  state.worker = await Tesseract.createWorker(['jpn', 'eng'], 1, {
    logger: m => {
      if (typeof m.progress === 'number') setBusy(true, localizeStatus(m.status), m.progress);
    }
  });
  setBusy(false);
  return state.worker;
}

async function scanCurrentView() {
  if (state.busy || state.locked || !state.stream) return;
  els.scan.disabled = true; clearBoxes(); resetSelection();
  try {
    const worker = await initWorker();
    await waitForVideo(els.camera);
    const w = els.camera.videoWidth, h = els.camera.videoHeight;
    if (!w || !h) throw new Error('no-video-size');
    state.frameWidth = w; state.frameHeight = h;
    els.canvas.width = w; els.canvas.height = h;
    const ctx = els.canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.drawImage(els.camera, 0, 0, w, h);

    const candidates = els.layout.value === 'vertical' ? [90, 270] : els.layout.value === 'auto' ? [0, 90, 270] : [0];
    let best = null;
    for (let i = 0; i < candidates.length; i++) {
      const angle = candidates[i];
      const source = rotatedCanvas(els.canvas, angle);
      await worker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: angle === 0 ? '3' : '6' });
      setBusy(true, `文字を探しています（${i + 1}/${candidates.length}）`, i / candidates.length);
      const result = await worker.recognize(source, {}, { blocks: true });
      const units = extractUnits(result.data).map((u, index) => ({
        ...u, index, bbox: mapBbox(u.bbox, angle, w, h)
      })).filter(u => u.text && u.bbox && /[A-Za-z0-9ぁ-んァ-ヶ一-龯々、。！？,.!?]/.test(u.text));
      const score = scoreResult(units);
      if (!best || score > best.score) best = { units, score };
    }
    state.units = best?.units || [];
    if (!state.units.length) {
      els.status.textContent = '文字を見つけられませんでした。近づいて、もう一度押してください。';
      return;
    }
    renderBoxes();
    els.status.textContent = '白い枠が文字に合っていれば、読みたい最初の文字をタップしてください。';
  } catch (e) {
    console.error(e); els.status.textContent = '文字認識に失敗しました。もう一度試してください。';
  } finally {
    setBusy(false); els.scan.disabled = false;
  }
}

function extractUnits(data) {
  const units = [];
  for (const block of data.blocks || []) for (const para of block.paragraphs || []) for (const line of para.lines || []) for (const word of line.words || []) {
    const symbols = (word.symbols || []).filter(s => (s.text || '').trim());
    if (symbols.length) for (const s of symbols) units.push({ text: s.text.trim(), bbox: s.bbox, confidence: s.confidence ?? word.confidence ?? 0 });
    else if ((word.text || '').trim()) units.push({ text: word.text.trim(), bbox: word.bbox, confidence: word.confidence ?? 0 });
  }
  return units;
}

function renderBoxes() {
  clearBoxes();
  for (const unit of state.units) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'word-box'; b.dataset.index = String(unit.index);
    b.setAttribute('aria-label', `${unit.text}を選択`);
    positionBox(b, unit.bbox);
    b.addEventListener('click', () => chooseIndex(unit.index));
    els.overlay.appendChild(b);
  }
}

async function chooseIndex(index) {
  if (!state.locked) {
    state.locked = true;
    els.camera.pause();
    els.guide.hidden = true; els.dim.hidden = false; els.scan.hidden = true; els.resume.hidden = false;
    els.panel.hidden = false;
  }
  if (state.startIndex === null) {
    state.startIndex = index; state.endIndex = index;
    els.hint.textContent = '最後の文字をタップしてください。一文字だけなら、そのまま読み上げられます。';
  } else if (state.endIndex === state.startIndex) {
    state.endIndex = index;
    els.hint.textContent = '選んだ範囲を読み上げます。';
  } else {
    state.startIndex = index; state.endIndex = index;
    els.hint.textContent = '最後の文字をタップしてください。';
  }
  updateRangeUI();
}

function selectedRange() {
  if (state.startIndex === null) return [];
  const a = Math.min(state.startIndex, state.endIndex ?? state.startIndex);
  const b = Math.max(state.startIndex, state.endIndex ?? state.startIndex);
  return state.units.filter(u => u.index >= a && u.index <= b);
}
function selectedString() { return selectedRange().map(u => u.text).join('').replace(/\s+/g, '').trim(); }

function updateRangeUI() {
  const range = selectedRange();
  document.querySelectorAll('.word-box').forEach(el => {
    const i = Number(el.dataset.index), selected = range.some(u => u.index === i);
    el.classList.toggle('range-selected', selected);
    el.classList.toggle('range-start', i === state.startIndex);
    el.classList.toggle('range-end', i === state.endIndex);
  });
  if (!range.length) return;
  els.selectedText.textContent = selectedString(); els.speak.hidden = false; els.clear.hidden = false;
}

function clearSelectionOnly() {
  state.startIndex = null; state.endIndex = null;
  els.selectedText.textContent = '文字を選んでください';
  els.hint.textContent = '最初の文字をタップしてください。';
  els.speak.hidden = true; els.clear.hidden = true;
  document.querySelectorAll('.word-box').forEach(el => el.classList.remove('range-selected', 'range-start', 'range-end'));
}

async function resumeLive() {
  window.speechSynthesis.cancel(); clearSelection(); clearBoxes();
  state.locked = false; els.dim.hidden = true; els.guide.hidden = false;
  els.panel.hidden = true; els.scan.hidden = false; els.resume.hidden = true;
  await els.camera.play();
  els.status.textContent = '文字にかざし、端末を止めて「文字を探す」を押してください。';
}

function speakSelection() {
  const text = selectedString(); if (!text) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = /[ぁ-んァ-ヶ一-龯]/.test(text) ? 'ja-JP' : 'en-US';
  u.rate = Number(els.rate.value || 0.8);
  u.onstart = () => { els.status.textContent = '読み上げています'; els.speak.textContent = '🔊 読み上げ中'; els.speak.disabled = true; };
  u.onend = () => { els.status.textContent = '読み終わりました。'; els.speak.textContent = '🔊 もう一度読む'; els.speak.disabled = false; };
  u.onerror = () => { els.status.textContent = '読み上げられませんでした。音量を確認してください。'; els.speak.textContent = '🔊 読み上げる'; els.speak.disabled = false; };
  window.speechSynthesis.speak(u);
}

function positionBox(el, bbox) {
  const r = els.stage.getBoundingClientRect(), w = state.frameWidth, h = state.frameHeight;
  const scale = Math.max(r.width / w, r.height / h), ox = (r.width - w * scale) / 2, oy = (r.height - h * scale) / 2;
  el.style.left = `${ox + bbox.x0 * scale}px`; el.style.top = `${oy + bbox.y0 * scale}px`;
  el.style.width = `${Math.max(26, (bbox.x1 - bbox.x0) * scale)}px`; el.style.height = `${Math.max(28, (bbox.y1 - bbox.y0) * scale)}px`;
}
function repositionBoxes() { if (state.units.length) renderBoxes(); }
function clearBoxes() { els.overlay.replaceChildren(); }
function resetSelection() { state.startIndex = null; state.endIndex = null; els.panel.hidden = true; els.selectedText.textContent = '文字を選んでください'; els.speak.hidden = true; els.clear.hidden = true; }

function rotatedCanvas(src, angle) {
  if (angle === 0) return src;
  const c = document.createElement('canvas'); c.width = src.height; c.height = src.width;
  const x = c.getContext('2d', { alpha: false }); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  if (angle === 90) { x.translate(c.width, 0); x.rotate(Math.PI / 2); }
  else { x.translate(0, c.height); x.rotate(-Math.PI / 2); }
  x.drawImage(src, 0, 0); return c;
}
function mapBbox(b, angle, ow, oh) {
  if (angle === 0) return b;
  if (angle === 90) return { x0: b.y0, y0: oh - b.x1, x1: b.y1, y1: oh - b.x0 };
  return { x0: ow - b.y1, y0: b.x0, x1: ow - b.y0, y1: b.x1 };
}
function scoreResult(units) {
  const chars = units.reduce((n, u) => n + u.text.length, 0);
  const conf = units.length ? units.reduce((n, u) => n + Number(u.confidence || 0), 0) / units.length : 0;
  return chars * 3 + units.length * 2 + conf * .2;
}
function setBusy(on, text = '', value = 0) { state.busy = on; els.progressWrap.hidden = !on; els.progress.value = value; els.progressText.textContent = text; els.scan.disabled = on; }
function localizeStatus(s) { return ({ 'loading tesseract core': '認識機能を読み込んでいます', 'initializing tesseract': '認識機能を準備しています', 'loading language traineddata': '日本語・英語の辞書を読み込んでいます', 'initializing api': '辞書を準備しています', 'recognizing text': '文字を認識しています' })[s] || '処理しています'; }
function waitForVideo(v) { return new Promise((resolve, reject) => { if (v.readyState >= 2 && v.videoWidth) return resolve(); const t = setTimeout(() => reject(new Error('video-timeout')), 5000); v.addEventListener('loadeddata', () => { clearTimeout(t); resolve(); }, { once: true }); }); }
function cameraErrorMessage(e) { if (!window.isSecureContext) return 'カメラはHTTPSで開いたときだけ利用できます。'; if (e?.name === 'NotAllowedError') return 'カメラが許可されていません。'; return 'カメラを開始できませんでした。'; }

els.scan.addEventListener('click', scanCurrentView);
els.resume.addEventListener('click', resumeLive);
els.speak.addEventListener('click', speakSelection);
els.clear.addEventListener('click', clearSelectionOnly);
els.rate.addEventListener('input', () => { els.rateValue.value = els.rate.value; });
els.privacyButton.addEventListener('click', () => els.privacy.showModal());
els.closePrivacy.addEventListener('click', () => els.privacy.close());
window.addEventListener('resize', repositionBoxes);
window.addEventListener('pagehide', async () => { stopCamera(); window.speechSynthesis.cancel(); try { await state.worker?.terminate(); } catch {} });
window.addEventListener('load', startCamera);
