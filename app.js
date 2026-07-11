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
  closePrivacy: document.querySelector('#closePrivacyButton')
};

const state = {
  stream: null,
  frozen: false,
  words: [],
  selectedIds: new Set(),
  tokenizer: null,
  tokenizerPromise: null
};

async function startCamera() {
  stopCamera();
  resetRecognition();
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
    els.status.textContent = '文字を枠内に入れて「画面を止める」を押してください';
  } catch (error) {
    console.error(error);
    els.status.textContent = cameraErrorMessage(error);
  }
}

function stopCamera() {
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

function freezeFrame() {
  const video = els.camera;
  const canvas = els.snapshot;
  if (!video.videoWidth || !video.videoHeight) return;

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  state.frozen = true;
  stopCamera();
  video.hidden = true;
  canvas.hidden = false;
  els.guide.hidden = true;
  els.freeze.hidden = true;
  els.retake.hidden = false;
  els.recognize.hidden = false;
  els.status.textContent = '画像は保存されていません。文字認識を開始できます。';
}

async function recognizeText() {
  if (!state.frozen) return;
  resetRecognition();
  setBusy(true, 'OCRを準備しています', 0);

  try {
    const worker = await Tesseract.createWorker(['jpn', 'eng'], 1, {
      logger: message => {
        const progress = typeof message.progress === 'number' ? message.progress : 0;
        setBusy(true, localizeOcrStatus(message.status), progress);
      }
    });

    await worker.setParameters({
      preserve_interword_spaces: '1',
      tessedit_pageseg_mode: '3'
    });

    const result = await worker.recognize(els.snapshot, {}, { blocks: true });
    await worker.terminate();

    state.words = extractWords(result.data);
    if (!state.words.length) {
      els.status.textContent = '文字を認識できませんでした。明るくして、文字に近づいて撮り直してください。';
      return;
    }

    renderWords();
    els.resultsPanel.hidden = false;
    els.status.textContent = `${state.words.length}個の文字領域を認識しました。`;
    els.resultsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    console.error(error);
    els.status.textContent = '文字認識に失敗しました。通信状態を確認して、もう一度試してください。';
  } finally {
    setBusy(false);
  }
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
  const width = els.snapshot.width;
  const height = els.snapshot.height;
  element.style.left = `${(bbox.x0 / width) * 100}%`;
  element.style.top = `${(bbox.y0 / height) * 100}%`;
  element.style.width = `${((bbox.x1 - bbox.x0) / width) * 100}%`;
  element.style.height = `${((bbox.y1 - bbox.y0) / height) * 100}%`;
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
  const text = joinSelectedText(selectedWords());
  showOutput('読みを調べています…');
  try {
    const tokenizer = await loadTokenizer();
    const tokens = tokenizer.tokenize(text);
    const reading = tokens.map(token => katakanaToHiragana(token.reading || token.surface_form)).join('');
    showOutput(`${text}\n${reading}`);
  } catch (error) {
    console.error(error);
    showOutput('読みを取得できませんでした。通信状態を確認してください。');
  }
}

function katakanaToHiragana(text) {
  return text.replace(/[ァ-ヶ]/g, char => String.fromCharCode(char.charCodeAt(0) - 0x60));
}

function speak(text, lang) {
  if (!('speechSynthesis' in window)) {
    showOutput('このブラウザは読み上げに対応していません。');
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.rate = 0.85;
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
  els.output.textContent = text;
  els.output.hidden = false;
}

function hideOutput() {
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

els.freeze.addEventListener('click', freezeFrame);
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
window.addEventListener('pagehide', stopCamera);
window.addEventListener('load', startCamera);
