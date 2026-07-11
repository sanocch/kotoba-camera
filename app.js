'use strict';

const els = {
  camera: document.querySelector('#camera'),
  snapshot: document.querySelector('#snapshot'),
  overlay: document.querySelector('#ocrOverlay'),
  guide: document.querySelector('#guide'),
  status: document.querySelector('#status'),
  freeze: document.querySelector('#freezeButton'),
  retake: document.querySelector('#retakeButton'),
  recognize: document.querySelector('#recognizeButton'),
  progressWrap: document.querySelector('#progressWrap'),
  progress: document.querySelector('#progress'),
  progressText: document.querySelector('#progressText'),
  resultsPanel: document.querySelector('#resultsPanel'),
  tokens: document.querySelector('#tokens'),
  actionPanel: document.querySelector('#actionPanel'),
  selectedText: document.querySelector('#selectedText'),
  languageBadge: document.querySelector('#languageBadge'),
  clearSelection: document.querySelector('#clearSelectionButton'),
  japaneseActions: document.querySelector('#japaneseActions'),
  englishActions: document.querySelector('#englishActions'),
  mixedActions: document.querySelector('#mixedActions'),
  showReading: document.querySelector('#showReadingButton'),
  speakJapanese: document.querySelector('#speakJapaneseButton'),
  speakEnglish: document.querySelector('#speakEnglishButton'),
  translate: document.querySelector('#translateButton'),
  speakMixed: document.querySelector('#speakMixedButton'),
  translateMixed: document.querySelector('#translateMixedButton'),
  output: document.querySelector('#output'),
  privacyDialog: document.querySelector('#privacyDialog'),
  privacyButton: document.querySelector('#privacyButton'),
  closePrivacy: document.querySelector('#closePrivacyButton'),
  imageInput: document.querySelector('#imageInput'),
  rotate: document.querySelector('#rotateButton'),
  speechRate: document.querySelector('#speechRate'),
  speechRateValue: document.querySelector('#speechRateValue'),
  ocrMode: document.querySelector('#ocrMode'),
  layoutMode: document.querySelector('#layoutMode'),
  openStandalone: document.querySelector('#openStandaloneButton'),
  liveScanToggle: document.querySelector('#liveScanToggle'),
  scanNow: document.querySelector('#scanNowButton'),
  liveScanBadge: document.querySelector('#liveScanBadge'),
  stage: document.querySelector('#stage')
};

const state = {
  stream: null,
  frozen: false,
  words: [],
  selectedIds: new Set(),
  tokenizer: null,
  tokenizerPromise: null,
  rotation: 0,
  busy: false,
  liveWorker: null,
  liveWorkerPromise: null,
  liveTimer: null,
  liveScanning: false,
  liveWords: [],
  liveFrameWidth: 0,
  liveFrameHeight: 0,
  liveGeneration: 0
};

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    els.status.textContent = 'このブラウザではカメラを利用できません。「画像を選ぶ」を使ってください。';
    els.freeze.disabled = true;
    return;
  }
  stopCamera();
  resetRecognition();
  state.rotation = 0;
  els.rotate.hidden = true;
  els.status.textContent = 'カメラの使用を許可してください';
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    });
    els.camera.srcObject = state.stream;
    await els.camera.play();
    state.frozen = false;
    els.camera.hidden = false;
    els.snapshot.hidden = true;
    els.guide.hidden = false;
    els.freeze.hidden = false;
    els.freeze.disabled = false;
    els.retake.hidden = true;
    els.recognize.hidden = true;
    els.status.textContent = '文字にかざしてください。枠が出たら、読みたい文字をタップできます。';
    startLiveScanning();
  } catch (error) {
    console.error(error);
    els.status.textContent = cameraErrorMessage(error);
  }
}

function stopCamera() {
  stopLiveScanning();
  if (!state.stream) return;
  state.stream.getTracks().forEach(track => track.stop());
  state.stream = null;
}

function cameraErrorMessage(error) {
  if (!window.isSecureContext) return 'カメラはHTTPSまたはlocalhostで開いたときだけ利用できます。';
  if (error?.name === 'NotAllowedError') return 'カメラの使用が許可されていません。ブラウザ設定から許可してください。';
  if (error?.name === 'NotFoundError') return '利用できるカメラが見つかりません。';
  return 'カメラを開始できませんでした。ページを再読み込みしてください。';
}

async function freezeFrame(options = {}) {
  const video = els.camera;
  const canvas = els.snapshot;

  if (state.busy || state.frozen) return;
  els.freeze.disabled = true;
  els.status.textContent = '押した瞬間の映像を固定しています…';

  try {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForVideoReady(video);
    }
    await waitForRenderedVideoFrame(video);

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error('video-size-unavailable');

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', {
      alpha: false,
      desynchronized: false,
      willReadFrequently: true
    });
    if (!ctx) throw new Error('canvas-context-unavailable');

    // ボタンを押した時点のフレームを、アプリ内のCanvasへコピーする。
    // createImageBitmapが使える端末では、映像フレームを先に独立させてから描画する。
    if (typeof createImageBitmap === 'function') {
      try {
        const frame = await createImageBitmap(video);
        ctx.drawImage(frame, 0, 0, width, height);
        frame.close?.();
      } catch (bitmapError) {
        console.warn('createImageBitmap fallback:', bitmapError);
        ctx.drawImage(video, 0, 0, width, height);
      }
    } else {
      ctx.drawImage(video, 0, 0, width, height);
    }

    // カメラを止める前に、静止画を画面上へ出して描画を確定させる。
    state.frozen = true;
    canvas.hidden = false;
    video.hidden = true;
    els.guide.hidden = true;
    els.freeze.hidden = true;
    els.retake.hidden = false;
    els.recognize.hidden = false;
    els.rotate.hidden = false;
    els.overlay.replaceChildren();
    els.liveScanBadge.hidden = true;
    els.status.textContent = options.skipRecognition ? '選んだ文字を処理できます。静止画はアプリ内だけに保持しています。' : 'この静止画を画面内に保持しています。文字認識を開始します。';

    await waitForCanvasPaint();

    // 静止画が見えた後で、裏側のカメラだけを停止する。
    video.pause();
    stopCamera();
    video.srcObject = null;

    // さらに1回描画を待ち、表示中の静止画をそのままOCRへ渡す。
    await waitForCanvasPaint();
    if (!options.skipRecognition) window.setTimeout(() => recognizeText(), 150);
  } catch (error) {
    console.error(error);
    state.frozen = false;
    canvas.hidden = true;
    video.hidden = false;
    els.guide.hidden = false;
    els.status.textContent = '画面を固定できませんでした。もう一度押すか、「画像を選ぶ」を使ってください。';
    els.freeze.hidden = false;
    els.freeze.disabled = false;
  }
}



async function ensureLiveWorker() {
  if (state.liveWorker) return state.liveWorker;
  if (state.liveWorkerPromise) return state.liveWorkerPromise;
  state.liveWorkerPromise = Tesseract.createWorker(['jpn', 'eng'], 1, {
    logger: message => {
      if (!state.frozen && state.liveScanning && message.status === 'recognizing text') {
        const pct = Math.round((message.progress || 0) * 100);
        els.liveScanBadge.textContent = `文字を探しています ${pct}%`;
      }
    }
  }).then(async worker => {
    await worker.setParameters({
      preserve_interword_spaces: '1',
      tessedit_pageseg_mode: '11'
    });
    state.liveWorker = worker;
    return worker;
  }).catch(error => {
    state.liveWorkerPromise = null;
    throw error;
  });
  return state.liveWorkerPromise;
}

function startLiveScanning() {
  stopLiveScanning();
  if (!els.liveScanToggle?.checked || state.frozen || !state.stream) {
    els.liveScanBadge.hidden = true;
    return;
  }
  state.liveGeneration += 1;
  const generation = state.liveGeneration;
  els.liveScanBadge.hidden = false;
  els.liveScanBadge.textContent = '文字認識を準備しています';
  scanLiveFrame(generation);
  state.liveTimer = window.setInterval(() => scanLiveFrame(generation), 2800);
}

function stopLiveScanning() {
  state.liveGeneration += 1;
  if (state.liveTimer) window.clearInterval(state.liveTimer);
  state.liveTimer = null;
  state.liveScanning = false;
  state.liveWords = [];
  els.liveScanBadge.hidden = true;
  if (!state.frozen) els.overlay.replaceChildren();
}

async function scanLiveFrame(generation = state.liveGeneration) {
  if (state.liveScanning || state.frozen || !state.stream || !els.liveScanToggle?.checked) return;
  const video = els.camera;
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return;
  state.liveScanning = true;
  els.liveScanBadge.hidden = false;
  els.liveScanBadge.textContent = '文字を探しています';

  try {
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    const maxWidth = 960;
    const scale = Math.min(1, maxWidth / sourceWidth);
    const scanCanvas = document.createElement('canvas');
    scanCanvas.width = Math.max(1, Math.round(sourceWidth * scale));
    scanCanvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const ctx = scanCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);

    const worker = await ensureLiveWorker();
    if (generation !== state.liveGeneration || state.frozen) return;
    const result = await worker.recognize(scanCanvas, {}, { blocks: true });
    if (generation !== state.liveGeneration || state.frozen) return;

    const words = extractWords(result.data)
      .filter(word => word.bbox && word.text && Number(word.confidence || 0) >= 28)
      .filter(word => /[A-Za-z0-9ぁ-んァ-ヶ一-龯々]/.test(word.text))
      .slice(0, 80);

    state.liveWords = words;
    state.liveFrameWidth = scanCanvas.width;
    state.liveFrameHeight = scanCanvas.height;
    renderLiveWords();
    els.liveScanBadge.textContent = words.length ? `${words.length}個の文字を検出` : '文字が見つかりません';
  } catch (error) {
    console.error('live OCR:', error);
    els.liveScanBadge.textContent = '文字探索を再試行します';
  } finally {
    state.liveScanning = false;
  }
}

function renderLiveWords() {
  if (state.frozen) return;
  els.overlay.replaceChildren();
  for (const word of state.liveWords) {
    const box = document.createElement('button');
    box.type = 'button';
    box.className = 'word-box live';
    box.dataset.label = word.text;
    box.setAttribute('aria-label', `${word.text}を選択して画面を固定`);
    positionLiveBox(box, word.bbox);
    box.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      selectLiveWord(word).catch(console.error);
    });
    els.overlay.append(box);
  }
}

function positionLiveBox(element, bbox) {
  const stageRect = els.stage.getBoundingClientRect();
  const mediaWidth = state.liveFrameWidth;
  const mediaHeight = state.liveFrameHeight;
  if (!stageRect.width || !stageRect.height || !mediaWidth || !mediaHeight) return;

  // CSS object-fit: cover と同じ拡大率・切り抜き量を使う。
  const scale = Math.max(stageRect.width / mediaWidth, stageRect.height / mediaHeight);
  const renderedWidth = mediaWidth * scale;
  const renderedHeight = mediaHeight * scale;
  const offsetX = (stageRect.width - renderedWidth) / 2;
  const offsetY = (stageRect.height - renderedHeight) / 2;

  element.style.left = `${offsetX + bbox.x0 * scale}px`;
  element.style.top = `${offsetY + bbox.y0 * scale}px`;
  element.style.width = `${Math.max(22, (bbox.x1 - bbox.x0) * scale)}px`;
  element.style.height = `${Math.max(22, (bbox.y1 - bbox.y0) * scale)}px`;
}

async function selectLiveWord(word) {
  if (state.frozen || !word?.text) return;
  stopLiveScanning();
  els.status.textContent = `「${word.text}」を選びました。画面を固定しています…`;
  await freezeFrame({ skipRecognition: true });
  if (!state.frozen) return;

  const scaleX = els.snapshot.width / state.liveFrameWidth;
  const scaleY = els.snapshot.height / state.liveFrameHeight;
  const selectedWord = {
    id: 0,
    text: word.text,
    confidence: word.confidence || 0,
    bbox: {
      x0: word.bbox.x0 * scaleX,
      y0: word.bbox.y0 * scaleY,
      x1: word.bbox.x1 * scaleX,
      y1: word.bbox.y1 * scaleY
    }
  };
  state.words = [selectedWord];
  state.selectedIds = new Set([0]);
  renderWords();
  els.resultsPanel.hidden = true;
  updateSelectionUI();
  els.status.textContent = `選択した文字：${word.text}`;
  els.actionPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function repositionLiveBoxes() {
  if (!state.frozen && state.liveWords.length) renderLiveWords();
}

function waitForCanvasPaint() {
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function waitForVideoReady(video) {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('video-ready-timeout')), 3000);
    const done = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('loadeddata', done);
      video.removeEventListener('playing', done);
      resolve();
    };
    video.addEventListener('loadeddata', done, { once: true });
    video.addEventListener('playing', done, { once: true });
  });
}

function waitForRenderedVideoFrame(video) {
  return new Promise(resolve => {
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => resolve());
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('canvas-blob-failed')), 'image/jpeg', 0.95);
  });
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('snapshot-image-failed'));
    image.src = URL.createObjectURL(blob);
  });
}

async function recognizeText() {
  if (!state.frozen) return;
  resetRecognition();
  setBusy(true, 'OCRを準備しています', 0);

  let worker;
  try {
    worker = await Tesseract.createWorker(['jpn', 'eng'], 1, {
      logger: message => {
        const progress = typeof message.progress === 'number' ? message.progress : 0;
        setBusy(true, localizeOcrStatus(message.status), progress);
      }
    });

    const candidates = getOrientationCandidates();
    let best = null;

    for (let index = 0; index < candidates.length; index++) {
      const angle = candidates[index];
      const source = createRotatedCanvas(els.snapshot, angle);
      const psm = getPageSegmentationMode(angle);
      await worker.setParameters({
        preserve_interword_spaces: '1',
        tessedit_pageseg_mode: String(psm)
      });

      setBusy(true, `${orientationLabel(angle)}を認識しています（${index + 1}/${candidates.length}）`, index / candidates.length);
      const result = await worker.recognize(source, {}, { blocks: true });
      const words = extractWords(result.data).map(word => ({
        ...word,
        bbox: word.bbox ? mapRotatedBboxToOriginal(word.bbox, angle, els.snapshot.width, els.snapshot.height) : null
      }));
      const score = scoreRecognition(words, result.data.text || '');
      if (!best || score > best.score) best = { words, score, angle };
    }

    state.words = best?.words || [];
    if (!state.words.length) {
      els.status.textContent = '文字を認識できませんでした。明るくして、文字に近づいて撮り直してください。';
      return;
    }

    renderWords();
    els.resultsPanel.hidden = false;
    const direction = best.angle === 0 ? '横書き' : '縦書き';
    els.status.textContent = `${direction}として${state.words.length}個の文字領域を認識しました。`;
    els.resultsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    console.error(error);
    els.status.textContent = '文字認識に失敗しました。通信状態を確認して、もう一度試してください。';
  } finally {
    try { await worker?.terminate(); } catch (_) {}
    setBusy(false);
  }
}

function getOrientationCandidates() {
  const mode = els.layoutMode?.value || 'auto';
  if (mode === 'horizontal') return [0];
  if (mode === 'vertical') return [90, 270];
  if (mode === 'textbook') return [90, 270, 0];
  return [0, 90, 270];
}

function getPageSegmentationMode(angle) {
  const selected = Number(els.ocrMode.value || 3);
  if (selected !== 3) return selected;
  return angle === 0 ? 3 : 6;
}

function orientationLabel(angle) {
  return angle === 0 ? '横書き候補' : angle === 90 ? '縦書き候補（右回転）' : '縦書き候補（左回転）';
}

function createRotatedCanvas(source, angle) {
  if (angle === 0) return source;
  const canvas = document.createElement('canvas');
  canvas.width = source.height;
  canvas.height = source.width;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (angle === 90) {
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
  } else {
    ctx.translate(0, canvas.height);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(source, 0, 0);
  return canvas;
}

function mapRotatedBboxToOriginal(bbox, angle, originalWidth, originalHeight) {
  if (angle === 0) return bbox;
  if (angle === 90) {
    return {
      x0: Math.max(0, bbox.y0),
      y0: Math.max(0, originalHeight - bbox.x1),
      x1: Math.min(originalWidth, bbox.y1),
      y1: Math.min(originalHeight, originalHeight - bbox.x0)
    };
  }
  return {
    x0: Math.max(0, originalWidth - bbox.y1),
    y0: Math.max(0, bbox.x0),
    x1: Math.min(originalWidth, originalWidth - bbox.y0),
    y1: Math.min(originalHeight, bbox.x1)
  };
}

function scoreRecognition(words, fullText) {
  const useful = words.filter(word => /[A-Za-z0-9ぁ-んァ-ヶ一-龯々]/.test(word.text));
  const chars = useful.reduce((sum, word) => sum + word.text.replace(/\s/g, '').length, 0);
  const confidence = useful.length ? useful.reduce((sum, word) => sum + Number(word.confidence || 0), 0) / useful.length : 0;
  const replacementPenalty = (fullText.match(/[�□]/g) || []).length * 8;
  return chars * 2 + useful.length * 3 + confidence * 0.25 - replacementPenalty;
}

function extractWords(data) {
  const found = [];
  const blocks = data.blocks || [];
  let id = 0;
  for (const block of blocks) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        for (const word of line.words || []) {
          const text = (word.text || '').trim();
          if (!text) continue;
          found.push({
            id: id++,
            text,
            bbox: word.bbox,
            confidence: word.confidence ?? 0
          });
        }
      }
    }
  }

  if (!found.length && data.text) {
    return data.text.split(/\s+/).filter(Boolean).map(text => ({ id: id++, text, bbox: null, confidence: 0 }));
  }
  return found;
}

function renderWords() {
  els.tokens.replaceChildren();
  els.overlay.replaceChildren();

  for (const word of state.words) {
    const token = document.createElement('button');
    token.type = 'button';
    token.className = 'token';
    token.textContent = word.text;
    token.dataset.id = String(word.id);
    token.addEventListener('click', () => toggleWord(word.id));
    els.tokens.append(token);

    if (word.bbox) {
      const box = document.createElement('button');
      box.type = 'button';
      box.className = 'word-box';
      box.dataset.id = String(word.id);
      box.setAttribute('aria-label', `${word.text}を選択`);
      positionBox(box, word.bbox);
      box.addEventListener('click', () => toggleWord(word.id));
      els.overlay.append(box);
    }
  }
}

function positionBox(element, bbox) {
  const stageRect = els.stage.getBoundingClientRect();
  const width = els.snapshot.width;
  const height = els.snapshot.height;
  if (!stageRect.width || !stageRect.height || !width || !height) return;
  const scale = Math.max(stageRect.width / width, stageRect.height / height);
  const offsetX = (stageRect.width - width * scale) / 2;
  const offsetY = (stageRect.height - height * scale) / 2;
  element.style.left = `${offsetX + bbox.x0 * scale}px`;
  element.style.top = `${offsetY + bbox.y0 * scale}px`;
  element.style.width = `${Math.max(18, (bbox.x1 - bbox.x0) * scale)}px`;
  element.style.height = `${Math.max(18, (bbox.y1 - bbox.y0) * scale)}px`;
}

function toggleWord(id) {
  if (state.selectedIds.has(id)) state.selectedIds.delete(id);
  else state.selectedIds.add(id);
  updateSelectionUI();
}

function updateSelectionUI() {
  document.querySelectorAll('[data-id]').forEach(el => {
    el.classList.toggle('selected', state.selectedIds.has(Number(el.dataset.id)));
  });

  const selected = selectedWords();
  if (!selected.length) {
    els.actionPanel.hidden = true;
    hideOutput();
    return;
  }

  const text = joinSelectedText(selected);
  const type = detectLanguage(text);
  els.selectedText.textContent = text;
  els.languageBadge.textContent = type === 'ja' ? '日本語' : type === 'en' ? '英語' : '日本語・英語が混在';
  els.japaneseActions.hidden = type !== 'ja';
  els.englishActions.hidden = type !== 'en';
  els.mixedActions.hidden = type !== 'mixed';
  els.actionPanel.hidden = false;
  hideOutput();
}

function selectedWords() {
  return state.words.filter(word => state.selectedIds.has(word.id));
}

function joinSelectedText(words) {
  return words.map(word => word.text).join(' ').replace(/\s+([、。,.!?！？])/g, '$1');
}

function detectLanguage(text) {
  const hasJapanese = /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
  const hasEnglish = /[A-Za-z]/.test(text);
  if (hasJapanese && hasEnglish) return 'mixed';
  return hasJapanese ? 'ja' : 'en';
}

function loadTokenizer() {
  if (state.tokenizer) return Promise.resolve(state.tokenizer);
  if (state.tokenizerPromise) return state.tokenizerPromise;

  state.tokenizerPromise = new Promise((resolve, reject) => {
    kuromoji.builder({
      dicPath: 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/'
    }).build((error, tokenizer) => {
      if (error) return reject(error);
      state.tokenizer = tokenizer;
      resolve(tokenizer);
    });
  });
  return state.tokenizerPromise;
}

async function showReading() {
  const originalText = joinSelectedText(selectedWords()).trim();
  if (!originalText) return;

  showOutput('読みを調べています…');
  els.showReading.disabled = true;

  try {
    const tokenizer = await loadTokenizer();
    // OCRが日本語の単語間に入れた空白は、解析前に除く。
    // 英数字の語中の空白は残す。
    const analysisText = originalText.replace(/(?<=[ぁ-んァ-ヶ一-龯々〆ヵヶ])\s+(?=[ぁ-んァ-ヶ一-龯々〆ヵヶ])/g, '');
    const tokens = tokenizer.tokenize(analysisText);
    renderReadingResult(originalText, tokens);
  } catch (error) {
    console.error(error);
    showOutput('読みを取得できませんでした。通信状態を確認して、もう一度押してください。');
  } finally {
    els.showReading.disabled = false;
  }
}

function renderReadingResult(originalText, tokens) {
  els.output.replaceChildren();
  els.output.hidden = false;
  els.output.classList.add('reading-output');

  const label = document.createElement('div');
  label.className = 'output-label';
  label.textContent = 'ふりがな';

  const rubyLine = document.createElement('div');
  rubyLine.className = 'ruby-line';
  rubyLine.setAttribute('aria-label', `${originalText}の読み`);

  const readingParts = [];
  for (const token of tokens) {
    const surface = token.surface_form || '';
    const rawReading = token.reading && token.reading !== '*' ? token.reading : surface;
    const reading = katakanaToHiragana(rawReading);
    readingParts.push(reading);

    if (/[一-龯々〆ヵヶ]/.test(surface) && reading && reading !== surface) {
      const ruby = document.createElement('ruby');
      ruby.append(document.createTextNode(surface));
      const rt = document.createElement('rt');
      rt.textContent = reading;
      ruby.append(rt);
      rubyLine.append(ruby);
    } else {
      rubyLine.append(document.createTextNode(surface));
    }
  }

  const plainLabel = document.createElement('div');
  plainLabel.className = 'output-label plain-reading-label';
  plainLabel.textContent = '読み';

  const plainReading = document.createElement('div');
  plainReading.className = 'plain-reading';
  plainReading.textContent = readingParts.join('');

  els.output.append(label, rubyLine, plainLabel, plainReading);
}

function katakanaToHiragana(text) {
  return String(text || '').replace(/[ァ-ヶ]/g, char => String.fromCharCode(char.charCodeAt(0) - 0x60));
}

function speak(text, lang) {
  if (!('speechSynthesis' in window)) {
    showOutput('このブラウザは読み上げに対応していません。');
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.rate = Number(els.speechRate.value || 0.8);
  utterance.pitch = 1;
  const voices = window.speechSynthesis.getVoices();
  const voice = voices.find(item => item.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
  if (voice) utterance.voice = voice;
  window.speechSynthesis.speak(utterance);
}

async function translateText(text) {
  if (!text.trim()) return;
  showOutput('翻訳しています…');

  try {
    if ('Translator' in self && typeof self.Translator?.create === 'function') {
      const availability = await self.Translator.availability({ sourceLanguage: 'en', targetLanguage: 'ja' });
      if (availability !== 'unavailable') {
        const translator = await self.Translator.create({ sourceLanguage: 'en', targetLanguage: 'ja' });
        const translated = await translator.translate(text);
        showOutput(`${text}\n${translated}`);
        return;
      }
    }

    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|ja`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Translation HTTP ${response.status}`);
    const data = await response.json();
    const translated = data?.responseData?.translatedText;
    if (!translated) throw new Error('No translation returned');
    showOutput(`${text}\n${decodeHtml(translated)}`);
  } catch (error) {
    console.error(error);
    showOutput('翻訳できませんでした。通信状態または翻訳サービスの利用制限を確認してください。');
  }
}

function englishOnly(text) {
  return (text.match(/[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*)*/g) || []).join(' ');
}

function decodeHtml(value) {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = value;
  return textarea.value;
}

function showOutput(text) {
  els.output.classList.remove('reading-output');
  els.output.textContent = text;
  els.output.hidden = false;
}

function hideOutput() {
  els.output.classList.remove('reading-output');
  els.output.hidden = true;
  els.output.textContent = '';
}

function resetRecognition() {
  state.words = [];
  state.selectedIds.clear();
  els.overlay.replaceChildren();
  els.tokens.replaceChildren();
  els.resultsPanel.hidden = true;
  els.actionPanel.hidden = true;
  hideOutput();
}

function setBusy(isBusy, text = '', progress = 0) {
  els.progressWrap.hidden = !isBusy;
  els.progress.value = progress;
  els.progressText.textContent = text;
  els.recognize.disabled = isBusy;
  els.retake.disabled = isBusy;
}

function localizeOcrStatus(status) {
  const map = {
    'loading tesseract core': 'OCR本体を読み込んでいます',
    'initializing tesseract': 'OCRを初期化しています',
    'loading language traineddata': '日本語・英語辞書を読み込んでいます',
    'initializing api': '認識機能を準備しています',
    'recognizing text': '文字を認識しています'
  };
  return map[status] || '処理しています';
}


async function loadImageFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    els.status.textContent = '画像ファイルを選んでください。';
    return;
  }
  stopCamera();
  resetRecognition();
  const bitmap = await createImageBitmap(file);
  const maxSide = 2200;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  els.snapshot.width = Math.round(bitmap.width * scale);
  els.snapshot.height = Math.round(bitmap.height * scale);
  els.snapshot.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, els.snapshot.width, els.snapshot.height);
  bitmap.close?.();
  state.frozen = true;
  state.rotation = 0;
  els.camera.hidden = true;
  els.snapshot.hidden = false;
  els.guide.hidden = true;
  els.freeze.hidden = true;
  els.retake.hidden = false;
  els.recognize.hidden = false;
  els.rotate.hidden = false;
  els.status.textContent = '画像を一時的に読み込みました。端末内には新しく保存していません。';
}

function rotateSnapshot() {
  if (!state.frozen || !els.snapshot.width) return;
  const source = document.createElement('canvas');
  source.width = els.snapshot.width; source.height = els.snapshot.height;
  source.getContext('2d').drawImage(els.snapshot, 0, 0);
  els.snapshot.width = source.height; els.snapshot.height = source.width;
  const ctx = els.snapshot.getContext('2d', { alpha: false });
  ctx.translate(els.snapshot.width / 2, els.snapshot.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  resetRecognition();
  els.status.textContent = '画像を90度回転しました。';
}

function setupStandaloneHint() {
  const embedded = window.self !== window.top;
  els.openStandalone.hidden = !embedded;
  if (embedded) els.status.textContent = '埋め込み画面でカメラが開かない場合は「別画面で開く」を押してください。';
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('./sw.js').catch(console.warn);
  }
}

els.freeze.addEventListener('click', () => freezeFrame());
els.retake.addEventListener('click', startCamera);
els.recognize.addEventListener('click', recognizeText);
els.clearSelection.addEventListener('click', () => {
  state.selectedIds.clear();
  updateSelectionUI();
});
els.showReading.addEventListener('click', showReading);
els.speakJapanese.addEventListener('click', () => speak(joinSelectedText(selectedWords()), 'ja-JP'));
els.speakEnglish.addEventListener('click', () => speak(joinSelectedText(selectedWords()), 'en-US'));
els.translate.addEventListener('click', () => translateText(joinSelectedText(selectedWords())));
els.speakMixed.addEventListener('click', () => speak(joinSelectedText(selectedWords()), 'ja-JP'));
els.translateMixed.addEventListener('click', () => translateText(englishOnly(joinSelectedText(selectedWords()))));
els.privacyButton.addEventListener('click', () => els.privacyDialog.showModal());
els.closePrivacy.addEventListener('click', () => els.privacyDialog.close());
els.imageInput.addEventListener('change', event => loadImageFile(event.target.files?.[0]).catch(error => { console.error(error); els.status.textContent = '画像を開けませんでした。'; }));
els.rotate.addEventListener('click', rotateSnapshot);
els.speechRate.addEventListener('input', () => { els.speechRateValue.value = els.speechRate.value; });
els.layoutMode?.addEventListener('change', () => { if (state.frozen) els.status.textContent = '文字の向きを変更しました。「文字を認識する」を押すと再認識します。'; });
els.openStandalone.addEventListener('click', () => window.open(window.location.href, '_blank', 'noopener'));
els.liveScanToggle?.addEventListener('change', () => {
  if (els.liveScanToggle.checked) startLiveScanning();
  else stopLiveScanning();
});
els.scanNow?.addEventListener('click', () => scanLiveFrame(state.liveGeneration));
window.addEventListener('resize', repositionLiveBoxes);

window.addEventListener('pagehide', () => { stopCamera(); state.liveWorker?.terminate().catch(() => {}); });
window.addEventListener('load', () => { setupStandaloneHint(); registerServiceWorker(); startCamera(); });
