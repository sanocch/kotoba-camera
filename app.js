'use strict';

const els={
  camera:document.querySelector('#camera'),snapshot:document.querySelector('#snapshot'),display:document.querySelector('#displayCanvas'),overlay:document.querySelector('#ocrOverlay'),stage:document.querySelector('#stage'),guide:document.querySelector('#guide'),status:document.querySelector('#status'),freeze:document.querySelector('#freezeButton'),retake:document.querySelector('#retakeButton'),progressWrap:document.querySelector('#progressWrap'),progress:document.querySelector('#progress'),progressText:document.querySelector('#progressText'),selectionPanel:document.querySelector('#selectionPanel'),selectedText:document.querySelector('#selectedText'),selectionHint:document.querySelector('#selectionHint'),speak:document.querySelector('#speakButton'),clear:document.querySelector('#clearSelectionButton'),layoutMode:document.querySelector('#layoutMode'),speechRate:document.querySelector('#speechRate'),speechRateValue:document.querySelector('#speechRateValue'),privacyDialog:document.querySelector('#privacyDialog'),privacyButton:document.querySelector('#privacyButton'),closePrivacy:document.querySelector('#closePrivacyButton')
};

const state={stream:null,frozen:false,busy:false,units:[],startIndex:null,endIndex:null,bestAngle:0};

async function startCamera(){
  stopCamera(); resetAll();
  if(!navigator.mediaDevices?.getUserMedia){els.status.textContent='このブラウザではカメラを利用できません。';return;}
  els.status.textContent='カメラの使用を許可してください';
  try{
    state.stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}}});
    els.camera.srcObject=state.stream; await els.camera.play();
    els.camera.hidden=false; els.snapshot.hidden=true; els.display.hidden=true; els.guide.hidden=false; els.freeze.hidden=false; els.freeze.disabled=false; els.retake.hidden=true;
    els.status.textContent='文字にかざして「画像を止める」を押してください。';
  }catch(error){console.error(error);els.status.textContent=cameraErrorMessage(error);}
}

function stopCamera(){if(state.stream){state.stream.getTracks().forEach(t=>t.stop());state.stream=null;}els.camera.srcObject=null;}
function cameraErrorMessage(error){if(!window.isSecureContext)return'カメラはHTTPSで開いたときだけ利用できます。';if(error?.name==='NotAllowedError')return'カメラが許可されていません。ブラウザの設定で許可してください。';if(error?.name==='NotFoundError')return'利用できるカメラが見つかりません。';return'カメラを開始できませんでした。';}

async function freezeFrame(){
  if(state.busy||state.frozen)return; els.freeze.disabled=true; els.status.textContent='画像を固定しています…';
  try{
    if(els.camera.readyState<HTMLMediaElement.HAVE_CURRENT_DATA)await waitVideo(els.camera);
    await waitFrame(els.camera);
    const w=els.camera.videoWidth,h=els.camera.videoHeight;if(!w||!h)throw new Error('no-size');
    els.snapshot.width=w;els.snapshot.height=h;els.display.width=w;els.display.height=h;
    const ctx=els.snapshot.getContext('2d',{alpha:false,willReadFrequently:true});
    if(typeof createImageBitmap==='function'){
      try{const frame=await createImageBitmap(els.camera);ctx.drawImage(frame,0,0,w,h);frame.close?.();}catch{ctx.drawImage(els.camera,0,0,w,h);}
    }else ctx.drawImage(els.camera,0,0,w,h);
    els.display.getContext('2d',{alpha:false}).drawImage(els.snapshot,0,0);
    state.frozen=true;els.display.hidden=false;els.camera.hidden=true;els.snapshot.hidden=true;els.guide.hidden=true;els.freeze.hidden=true;els.retake.hidden=false;
    await paint();els.camera.pause();stopCamera();await paint();
    els.status.textContent='文字を探しています。少し待ってください。';
    window.setTimeout(recognizeText,120);
  }catch(error){console.error(error);state.frozen=false;els.freeze.hidden=false;els.freeze.disabled=false;els.status.textContent='画像を固定できませんでした。もう一度試してください。';}
}

async function recognizeText(){
  if(!state.frozen)return; setBusy(true,'文字認識を準備しています',0); let worker;
  try{
    worker=await Tesseract.createWorker(['jpn','eng'],1,{logger:m=>{if(typeof m.progress==='number')setBusy(true,localizeStatus(m.status),m.progress);}});
    const candidates=getCandidates();let best=null;
    for(let i=0;i<candidates.length;i++){
      const angle=candidates[i],source=rotatedCanvas(els.snapshot,angle);
      await worker.setParameters({preserve_interword_spaces:'1',tessedit_pageseg_mode:angle===0?'3':'6'});
      setBusy(true,`${angle===0?'横書き':'縦書き'}を確認しています（${i+1}/${candidates.length}）`,i/candidates.length);
      const result=await worker.recognize(source,{}, {blocks:true});
      const units=extractUnits(result.data).map((u,index)=>({...u,index,bbox:u.bbox?mapBbox(u.bbox,angle,els.snapshot.width,els.snapshot.height):null}));
      const score=scoreResult(units,result.data.text||'');if(!best||score>best.score)best={units,score,angle};
    }
    state.units=(best?.units||[]).filter(u=>u.text&&u.bbox&&/[A-Za-z0-9ぁ-んァ-ヶ一-龯々、。！？,.!?]/.test(u.text));state.bestAngle=best?.angle||0;
    if(!state.units.length){drawNormal();els.status.textContent='文字を認識できませんでした。文字に近づき、明るい場所で撮り直してください。';return;}
    drawDimmedWithReadableAreas();renderBoxes();els.selectionPanel.hidden=false;els.status.textContent='白い枠の中から、読みたい最初の文字をタップしてください。';
  }catch(error){console.error(error);drawNormal();els.status.textContent='文字認識に失敗しました。通信状態を確認して撮り直してください。';}
  finally{try{await worker?.terminate();}catch{}setBusy(false);}
}

function extractUnits(data){
  const units=[];
  for(const block of data.blocks||[])for(const para of block.paragraphs||[])for(const line of para.lines||[])for(const word of line.words||[]){
    const symbols=(word.symbols||[]).filter(s=>(s.text||'').trim());
    if(symbols.length){for(const s of symbols)units.push({text:(s.text||'').trim(),bbox:s.bbox,confidence:s.confidence??word.confidence??0});}
    else{const text=(word.text||'').trim();if(text)units.push({text,bbox:word.bbox,confidence:word.confidence??0});}
  }
  return units;
}

function renderBoxes(){els.overlay.replaceChildren();for(const unit of state.units){const b=document.createElement('button');b.type='button';b.className='word-box';b.dataset.index=String(unit.index);b.setAttribute('aria-label',`${unit.text}を選択`);positionBox(b,unit.bbox);b.addEventListener('click',()=>chooseIndex(unit.index));els.overlay.append(b);}updateRangeUI();}

function chooseIndex(index){
  if(state.startIndex===null){state.startIndex=index;state.endIndex=index;els.selectionHint.textContent='最後の文字をタップしてください。この一文字だけなら、そのまま読み上げられます。';}
  else if(state.endIndex===state.startIndex){state.endIndex=index;els.selectionHint.textContent='選んだ範囲を読み上げます。範囲を変えるときは「選び直す」を押してください。';}
  else{state.startIndex=index;state.endIndex=index;els.selectionHint.textContent='最後の文字をタップしてください。';}
  updateRangeUI();
}

function selectedRange(){if(state.startIndex===null)return[];const a=Math.min(state.startIndex,state.endIndex??state.startIndex),b=Math.max(state.startIndex,state.endIndex??state.startIndex);return state.units.filter(u=>u.index>=a&&u.index<=b);}
function selectedString(){return selectedRange().map(u=>u.text).join('').replace(/\s+/g,'').trim();}

function updateRangeUI(){
  const range=selectedRange();document.querySelectorAll('.word-box').forEach(el=>{const i=Number(el.dataset.index);const selected=range.some(u=>u.index===i);el.classList.toggle('range-selected',selected);el.classList.toggle('range-start',i===state.startIndex);el.classList.toggle('range-end',i===state.endIndex);});
  if(!range.length){els.selectedText.textContent='文字を選んでください';els.speak.hidden=true;els.clear.hidden=true;return;}
  els.selectedText.textContent=selectedString();els.speak.hidden=false;els.clear.hidden=false;redrawSelectionEmphasis();
}

function clearSelection(){state.startIndex=null;state.endIndex=null;els.selectedText.textContent='文字を選んでください';els.selectionHint.textContent='最初の文字をタップしてください。';els.speak.hidden=true;els.clear.hidden=true;drawDimmedWithReadableAreas();updateRangeUI();}

function speakSelection(){const text=selectedString();if(!text)return;window.speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text);u.lang=/[ぁ-んァ-ヶ一-龯]/.test(text)?'ja-JP':'en-US';u.rate=Number(els.speechRate.value||0.8);u.onstart=()=>{els.status.textContent='読み上げています';els.speak.textContent='🔊 読み上げ中';els.speak.disabled=true;};u.onend=()=>{els.status.textContent='読み終わりました。';els.speak.textContent='🔊 もう一度読む';els.speak.disabled=false;};u.onerror=()=>{els.status.textContent='読み上げられませんでした。端末の音量を確認してください。';els.speak.textContent='🔊 読み上げる';els.speak.disabled=false;};window.speechSynthesis.speak(u);}

function drawNormal(){const ctx=els.display.getContext('2d',{alpha:false});ctx.clearRect(0,0,els.display.width,els.display.height);ctx.drawImage(els.snapshot,0,0);}
function drawDimmedWithReadableAreas(){
  const ctx=els.display.getContext('2d',{alpha:false});drawNormal();ctx.fillStyle='rgba(0,0,0,.58)';ctx.fillRect(0,0,els.display.width,els.display.height);
  for(const u of state.units){if(!u.bbox)continue;const p=5,x=Math.max(0,u.bbox.x0-p),y=Math.max(0,u.bbox.y0-p),w=Math.min(els.snapshot.width-x,u.bbox.x1-u.bbox.x0+p*2),h=Math.min(els.snapshot.height-y,u.bbox.y1-u.bbox.y0+p*2);ctx.drawImage(els.snapshot,x,y,w,h,x,y,w,h);}
}
function redrawSelectionEmphasis(){drawDimmedWithReadableAreas();const ctx=els.display.getContext('2d',{alpha:false});for(const u of selectedRange()){const p=8,x=Math.max(0,u.bbox.x0-p),y=Math.max(0,u.bbox.y0-p),w=Math.min(els.snapshot.width-x,u.bbox.x1-u.bbox.x0+p*2),h=Math.min(els.snapshot.height-y,u.bbox.y1-u.bbox.y0+p*2);ctx.drawImage(els.snapshot,x,y,w,h,x,y,w,h);ctx.strokeStyle='#facc15';ctx.lineWidth=Math.max(3,els.snapshot.width/400);ctx.strokeRect(x,y,w,h);}}

function positionBox(el,bbox){const r=els.stage.getBoundingClientRect(),w=els.snapshot.width,h=els.snapshot.height;if(!r.width||!w)return;const scale=Math.max(r.width/w,r.height/h),ox=(r.width-w*scale)/2,oy=(r.height-h*scale)/2;el.style.left=`${ox+bbox.x0*scale}px`;el.style.top=`${oy+bbox.y0*scale}px`;el.style.width=`${Math.max(22,(bbox.x1-bbox.x0)*scale)}px`;el.style.height=`${Math.max(24,(bbox.y1-bbox.y0)*scale)}px`;}
function repositionBoxes(){if(state.frozen&&state.units.length)renderBoxes();}

function getCandidates(){const m=els.layoutMode.value;if(m==='horizontal')return[0];if(m==='vertical')return[90,270];if(m==='textbook')return[90,270,0];return[0,90,270];}
function rotatedCanvas(src,angle){if(angle===0)return src;const c=document.createElement('canvas');c.width=src.height;c.height=src.width;const x=c.getContext('2d',{alpha:false});x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);if(angle===90){x.translate(c.width,0);x.rotate(Math.PI/2);}else{x.translate(0,c.height);x.rotate(-Math.PI/2);}x.drawImage(src,0,0);return c;}
function mapBbox(b,angle,ow,oh){if(angle===0)return b;if(angle===90)return{x0:Math.max(0,b.y0),y0:Math.max(0,oh-b.x1),x1:Math.min(ow,b.y1),y1:Math.min(oh,oh-b.x0)};return{x0:Math.max(0,ow-b.y1),y0:Math.max(0,b.x0),x1:Math.min(ow,ow-b.y0),y1:Math.min(oh,b.x1)};}
function scoreResult(units,text){const useful=units.filter(u=>/[A-Za-z0-9ぁ-んァ-ヶ一-龯々]/.test(u.text));const chars=useful.reduce((n,u)=>n+u.text.length,0),conf=useful.length?useful.reduce((n,u)=>n+Number(u.confidence||0),0)/useful.length:0;return chars*3+useful.length*2+conf*.2-(text.match(/[�□]/g)||[]).length*8;}

function setBusy(on,text='',value=0){state.busy=on;els.progressWrap.hidden=!on;els.progress.value=value;els.progressText.textContent=text;els.retake.disabled=on;}
function localizeStatus(s){return({'loading tesseract core':'認識機能を読み込んでいます','initializing tesseract':'認識機能を準備しています','loading language traineddata':'日本語・英語の辞書を読み込んでいます','initializing api':'辞書を準備しています','recognizing text':'文字を認識しています'})[s]||'処理しています';}
function waitVideo(v){return new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('timeout')),4000);const done=()=>{clearTimeout(t);res();};v.addEventListener('loadeddata',done,{once:true});v.addEventListener('playing',done,{once:true});});}
function waitFrame(v){return new Promise(res=>{if(typeof v.requestVideoFrameCallback==='function')v.requestVideoFrameCallback(()=>res());else requestAnimationFrame(()=>requestAnimationFrame(res));});}
function paint(){return new Promise(res=>requestAnimationFrame(()=>requestAnimationFrame(res)));}
function resetAll(){state.frozen=false;state.busy=false;state.units=[];state.startIndex=null;state.endIndex=null;els.overlay.replaceChildren();els.selectionPanel.hidden=true;els.progressWrap.hidden=true;window.speechSynthesis.cancel();}
function registerSW(){if('serviceWorker'in navigator&&window.isSecureContext)navigator.serviceWorker.register('./sw.js').catch(console.warn);}

els.freeze.addEventListener('click',freezeFrame);els.retake.addEventListener('click',startCamera);els.speak.addEventListener('click',speakSelection);els.clear.addEventListener('click',clearSelection);els.speechRate.addEventListener('input',()=>{els.speechRateValue.value=els.speechRate.value;});els.privacyButton.addEventListener('click',()=>els.privacyDialog.showModal());els.closePrivacy.addEventListener('click',()=>els.privacyDialog.close());window.addEventListener('resize',repositionBoxes);window.addEventListener('pagehide',()=>{stopCamera();window.speechSynthesis.cancel();});window.addEventListener('load',()=>{registerSW();startCamera();});
