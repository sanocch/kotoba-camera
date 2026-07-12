'use strict';

const $ = (s) => document.querySelector(s);
const els = {
  camera: $('#camera'), canvas: $('#analysisCanvas'), stage: $('#stage'), overlay: $('#ocrOverlay'),
  dim: $('#dimLayer'), guide: $('#guide'), status: $('#status'), scan: $('#scanButton'), resume: $('#resumeButton'),
  progressWrap: $('#progressWrap'), progress: $('#progress'), progressText: $('#progressText'),
  panel: $('#selectionPanel'), selectedText: $('#selectedText'), hint: $('#selectionHint'),
  speak: $('#speakButton'), clear: $('#clearSelectionButton'), layout: $('#layoutMode'),
  rate: $('#speechRate'), rateValue: $('#speechRateValue'), privacy: $('#privacyDialog'),
  privacyButton: $('#privacyButton'), closePrivacy: $('#closePrivacyButton'),
  zoomSlider: $('#zoomSlider'), zoomOut: $('#zoomOutButton'), zoomIn: $('#zoomInButton'), zoomValue: $('#zoomValue')
};

const state = {
  stream: null, worker: null, busy: false, locked: false, units: [], startIndex: null, endIndex: null,
  frameWidth: 0, frameHeight: 0, zoom: 1, pinchStartDistance: 0, pinchStartZoom: 1,
  displayRect: null
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
    els.status.textContent = 'ピンチまたは＋−で拡大し、点線枠に文字を入れてください。';
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

function getGuideRect() {
  const stageRect = els.stage.getBoundingClientRect();
  const guideRect = els.guide.getBoundingClientRect();
  return {
    x: guideRect.left - stageRect.left,
    y: guideRect.top - stageRect.top,
    width: guideRect.width,
    height: guideRect.height
  };
}

function visibleVideoCrop(videoW, videoH) {
  const stageRect = els.stage.getBoundingClientRect();
  const stageAspect = stageRect.width / stageRect.height;
  const videoAspect = videoW / videoH;
  let baseW, baseH, baseX, baseY;
  if (videoAspect > stageAspect) {
    baseH = videoH; baseW = videoH * stageAspect; baseX = (videoW - baseW) / 2; baseY = 0;
  } else {
    baseW = videoW; baseH = videoW / stageAspect; baseX = 0; baseY = (videoH - baseH) / 2;
  }
  const zoomW = baseW / state.zoom;
  const zoomH = baseH / state.zoom;
  const zoomX = baseX + (baseW - zoomW) / 2;
  const zoomY = baseY + (baseH - zoomH) / 2;
  return { x: zoomX, y: zoomY, width: zoomW, height: zoomH, stageWidth: stageRect.width, stageHeight: stageRect.height };
}

function guideSourceCrop(videoW, videoH) {
  const visible = visibleVideoCrop(videoW, videoH);
  const g = getGuideRect();
  return {
    x: visible.x + (g.x / visible.stageWidth) * visible.width,
    y: visible.y + (g.y / visible.stageHeight) * visible.height,
    width: (g.width / visible.stageWidth) * visible.width,
    height: (g.height / visible.stageHeight) * visible.height,
    guide: g
  };
}

async function scanCurrentView() {
  if (state.busy || state.locked || !state.stream) return;
  els.scan.disabled = true; clearBoxes(); resetSelection();
  try {
    const worker = await initWorker();
    await waitForVideo(els.camera);
    const vw = els.camera.videoWidth, vh = els.camera.videoHeight;
    if (!vw || !vh) throw new Error('no-video-size');

    const crop = guideSourceCrop(vw, vh);
    const targetW = 1500;
    const targetH = Math.max(400, Math.round(targetW * crop.height / crop.width));
    state.frameWidth = targetW; state.frameHeight = targetH; state.displayRect = crop.guide;
    els.canvas.width = targetW; els.canvas.height = targetH;
    const ctx = els.canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(els.camera, crop.x, crop.y, crop.width, crop.height, 0, 0, targetW, targetH);

    const candidates = els.layout.value === 'vertical' ? [90, 270] : els.layout.value === 'auto' ? [0, 90, 270] : [0];
    let best = null;
    for (let i = 0; i < candidates.length; i++) {
      const angle = candidates[i];
      const source = rotatedCanvas(els.canvas, angle);
      await worker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: angle === 0 ? '6' : '6' });
      setBusy(true, `点線枠の文字を探しています（${i + 1}/${candidates.length}）`, i / candidates.length);
      const result = await worker.recognize(source, {}, { blocks: true });
      const units = extractUnits(result.data).map((u, index) => ({
        ...u, index, bbox: mapBbox(u.bbox, angle, targetW, targetH)
      })).filter(u => u.text && u.bbox && Number(u.confidence || 0) >= 25 && /[A-Za-z0-9ぁ-んァ-ヶ一-龯々、。！？,.!?]/.test(u.text));
      const score = scoreResult(units);
      if (!best || score > best.score) best = { units, score };
    }
    state.units = best?.units || [];
    if (!state.units.length) {
      els.status.textContent = '点線枠の中で文字を見つけられませんでした。文字を大きく映して、もう一度試してください。';
      return;
    }
    renderBoxes();
    els.status.textContent = '青い枠から、読みたい最初のことばをタップしてください。';
  } catch (e) {
    console.error(e); els.status.textContent = '文字認識に失敗しました。もう一度試してください。';
  } finally {
    setBusy(false); els.scan.disabled = false;
  }
}

function extractUnits(data) {
  // Google Lensに近い見え方にするため、原則として「単語」単位で枠を作る。
  // 日本語OCRが一語を細かく分割した場合は、同じ行で近接する枠を結合する。
  const raw = [];
  let lineIndex = 0;
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const word of line.words || []) {
          const text = (word.text || '').replace(/\s+/g, '').trim();
          if (!text || !word.bbox) continue;
          raw.push({ text, bbox: word.bbox, confidence: word.confidence ?? 0, lineIndex });
        }
        lineIndex += 1;
      }
    }
  }
  return mergeNearbyJapaneseWords(raw);
}

function mergeNearbyJapaneseWords(words) {
  const merged = [];
  for (const word of words) {
    const prev = merged.at(-1);
    if (!prev || prev.lineIndex !== word.lineIndex) {
      merged.push({ ...word });
      continue;
    }
    const prevHeight = Math.max(1, prev.bbox.y1 - prev.bbox.y0);
    const wordHeight = Math.max(1, word.bbox.y1 - word.bbox.y0);
    const gap = word.bbox.x0 - prev.bbox.x1;
    const bothJapanese = /[ぁ-んァ-ヶ一-龯々]/.test(prev.text) && /[ぁ-んァ-ヶ一-龯々]/.test(word.text);
    const close = gap >= -Math.min(prevHeight, wordHeight) * .15 && gap <= Math.max(prevHeight, wordHeight) * .28;
    const compact = (prev.text + word.text).length <= 10;
    if (bothJapanese && close && compact) {
      prev.text += word.text;
      prev.bbox = {
        x0: Math.min(prev.bbox.x0, word.bbox.x0), y0: Math.min(prev.bbox.y0, word.bbox.y0),
        x1: Math.max(prev.bbox.x1, word.bbox.x1), y1: Math.max(prev.bbox.y1, word.bbox.y1)
      };
      prev.confidence = Math.min(prev.confidence, word.confidence);
    } else {
      merged.push({ ...word });
    }
  }
  return merged;
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
    els.guide.hidden = true; els.dim.hidden = true; els.scan.hidden = true; els.resume.hidden = false;
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
  els.status.textContent = 'ピンチまたは＋−で拡大し、点線枠に文字を入れてください。';
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
  const d = state.displayRect || getGuideRect();
  const sx = d.width / state.frameWidth, sy = d.height / state.frameHeight;
  el.style.left = `${d.x + bbox.x0 * sx}px`; el.style.top = `${d.y + bbox.y0 * sy}px`;
  el.style.width = `${Math.max(22, (bbox.x1 - bbox.x0) * sx)}px`; el.style.height = `${Math.max(24, (bbox.y1 - bbox.y0) * sy)}px`;
}
function repositionBoxes() { if (state.units.length) { state.displayRect = getGuideRect(); renderBoxes(); } }
function clearBoxes() { els.overlay.replaceChildren(); }
function resetSelection() { state.startIndex = null; state.endIndex = null; els.panel.hidden = true; els.selectedText.textContent = '文字を選んでください'; els.speak.hidden = true; els.clear.hidden = true; }

function setZoom(value) {
  state.zoom = Math.min(4, Math.max(1, Number(value)));
  els.zoomSlider.value = state.zoom.toFixed(1);
  els.zoomValue.value = `${state.zoom.toFixed(1)}×`;
  els.stage.style.setProperty('--camera-zoom', state.zoom);
  clearBoxes();
  if (!state.locked) els.status.textContent = '点線枠に読みたい文字を入れて、「文字を探す」を押してください。';
}

function touchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

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
els.zoomSlider.addEventListener('input', () => setZoom(els.zoomSlider.value));
els.zoomOut.addEventListener('click', () => setZoom(state.zoom - 0.25));
els.zoomIn.addEventListener('click', () => setZoom(state.zoom + 0.25));
els.stage.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2 && !state.locked) {
    e.preventDefault(); state.pinchStartDistance = touchDistance(e.touches); state.pinchStartZoom = state.zoom;
  }
}, { passive: false });
els.stage.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && !state.locked && state.pinchStartDistance) {
    e.preventDefault(); setZoom(state.pinchStartZoom * touchDistance(e.touches) / state.pinchStartDistance);
  }
}, { passive: false });
els.stage.addEventListener('touchend', () => { state.pinchStartDistance = 0; }, { passive: true });
window.addEventListener('resize', repositionBoxes);
window.addEventListener('pagehide', async () => { stopCamera(); window.speechSynthesis.cancel(); try { await state.worker?.terminate(); } catch {} });
window.addEventListener('load', () => { setZoom(1); startCamera(); });

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(console.error));
