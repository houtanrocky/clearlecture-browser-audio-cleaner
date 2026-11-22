import {wavHeader} from './wav.js';
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
const $=(x)=>document.getElementById(x);
let selected=null, worker=null, analysisWorker=null, analysisData=null, saving=null, writeChain=Promise.resolve(),chunks=[],outputBytes=0;
let sampleRate=0,active=false, previewUrl=null, originalUrl=null, downloadUrl=null,saveHandle=null,failed=false,showingOriginal=false;
let strength=0.52;
const moduleSettings=()=>Object.fromEntries([...document.querySelectorAll('[data-module]')].map(x=>[x.dataset.module,x.checked]));
const presetStrength={gentle:.28,balanced:.52,strong:.82};
function setBusy(busy) {
  for(const el of [$('audio-file'),$('remove'),$('download-mode'),$('channel-mode'),$('apply-recommendation'),...document.querySelectorAll('.preset'),...document.querySelectorAll('[data-module]')])el.disabled=busy;
  $('drop').setAttribute('aria-disabled',String(busy));$('drop').tabIndex=busy?-1:0;
}
const human=(bytes)=>`${(bytes/1024/1024).toFixed(1)} MB`;
const duration=(sec)=>`${Math.floor(sec/60)}m ${Math.floor(sec%60)}s`;
function drawAnalysis(a) {
  const {sampleRate,channels,format,duration:seconds,peak,rms,quietWindowDbFS,activityPercent,clippedPercent,dcOffset,transientCandidates,stationarity,humFrequency,recommendation,preview}=a;
  $('analysis-summary').textContent=`${format} · ${sampleRate.toLocaleString()} Hz · ${channels} channel(s) · ${duration(seconds)} sampled across ${a.windowCount} window(s). Quiet-window level proxy ${quietWindowDbFS.toFixed(1)} dBFS; speech-like activity estimate ${activityPercent.toFixed(0)}%; ${clippedPercent.toFixed(3)}% samples near full scale; DC estimate ${(dcOffset*100).toFixed(2)}%. ${humFrequency?`${humFrequency} Hz hum candidate (${(a.humProminence*100).toFixed(1)}% of window RMS).`:'No strong 50/60/100/120 Hz hum candidate.'} Quiet-window level appears ${stationarity}. Peak ${(peak*100).toFixed(1)}%; RMS ${(rms*100).toFixed(1)}%.`;
  $('analysis-suggestion').textContent=`Suggested starting preset: ${recommendation.preset[0].toUpperCase()+recommendation.preset.slice(1)}`;
  $('analysis-notes').replaceChildren(...recommendation.notes.map(note=>{const li=document.createElement('li');li.textContent=note;return li;}));
  $('apply-recommendation').hidden=Number(document.querySelector('.preset.active')?.dataset.strength)===presetStrength[recommendation.preset];
  for(const [id,data] of [['waveform',preview.waveform],['spectrum',preview.spectrum]]) {
    const canvas=$(id),ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);ctx.fillStyle='#102131';ctx.fillRect(0,0,w,h);ctx.strokeStyle='#89e0c6';ctx.fillStyle='#89e0c6';ctx.lineWidth=1;
    if(id==='waveform'){const mid=h/2;ctx.beginPath();ctx.moveTo(0,mid);ctx.lineTo(w,mid);ctx.strokeStyle='#405769';ctx.stroke();ctx.strokeStyle='#89e0c6';for(let i=0;i<data.length;i++){const x=(i+.5)*w/data.length;ctx.beginPath();ctx.moveTo(x,mid-data[i][1]*(h*.44));ctx.lineTo(x,mid-data[i][0]*(h*.44));ctx.stroke();}}
    else {const gap=1,bw=w/data.length;for(let i=0;i<data.length;i++){const db=data[i],bar=Math.max(1,((db+72)/72)*(h-8));ctx.globalAlpha=.35+.65*(db+72)/72;ctx.fillRect(i*bw+gap,h-bar,bw-gap,bar);}ctx.globalAlpha=1;}
  }
  $('analysis-results').hidden=false;
}
function analyzeSelection(file=selected) {
  analysisWorker?.terminate();analysisWorker=null;analysisData=null;$('analysis-results').hidden=true;
  if(!file)return;
  if(!('Worker' in window)){$('analysis-status').textContent='Local sample analysis is unavailable in this browser.';$('analysis-status').hidden=false;$('start').disabled=false;return;}
  $('analysis-status').textContent='Analyzing short samples from the beginning, middle and end on this device…';$('analysis-status').hidden=false;$('start').disabled=true;
  const current=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});analysisWorker=current;
  current.onmessage=e=>{if(analysisWorker!==current||selected!==file)return;
    if(e.data.type==='analysis'){analysisData=e.data.analysis;drawAnalysis(analysisData);$('analysis-status').hidden=true;$('start').disabled=false;analysisWorker=null;current.terminate();}
    else if(e.data.type==='analysis-error'){$('analysis-status').textContent=`Sample analysis unavailable: ${e.data.message}. You can still process this supported file.`;$('analysis-status').hidden=false;$('start').disabled=false;analysisWorker=null;current.terminate();}
  };
  current.onerror=e=>{if(analysisWorker!==current)return;$('analysis-status').textContent=`Sample analysis failed: ${e.message||'worker error'}. You can still process this supported file.`;$('analysis-status').hidden=false;$('start').disabled=false;analysisWorker=null;current.terminate();};
  current.postMessage({type:'analyze',file,channelMode:$('channel-mode').value});
}
function setFile(f) {
  if(active)return;
  if(!f)return;
  selected=f;
  if(originalUrl)URL.revokeObjectURL(originalUrl);
  originalUrl=URL.createObjectURL(f);
  $('file-name').textContent=f.name;
  $('file-size').textContent=`${human(f.size)} · ${f.type||'Audio'}`;
  $('file-info').hidden=false;
  $('drop').hidden=true;
  $('start').disabled=true;
  $('error').hidden=true;
  $('result').hidden=true;
  $('analysis-status').hidden=true;analyzeSelection(f);
}
$('audio-file').addEventListener('change',e=>setFile(e.target.files[0]));
$('remove').addEventListener('click',()=>{
  if(active)return;
  analysisWorker?.terminate();analysisWorker=null;analysisData=null;$('analysis-results').hidden=true;$('analysis-status').hidden=true;
  if(originalUrl)URL.revokeObjectURL(originalUrl);originalUrl=null;
  selected=null;$('file-info').hidden=true;$('drop').hidden=false;
  $('audio-file').value='';$('start').disabled=true;
});
const drop=$('drop');
drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('over');});
drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('over');if(!active)setFile(e.dataTransfer.files[0]);});
drop.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();if(!active)$('audio-file').click();}});
document.querySelectorAll('.preset').forEach(b=>b.addEventListener('click',()=>{
  if(active)return;
  document.querySelectorAll('.preset').forEach(x=>{x.classList.remove('active');x.setAttribute('aria-pressed','false');});
  b.classList.add('active');b.setAttribute('aria-pressed','true');strength=Number(b.dataset.strength);
}));
$('channel-mode').addEventListener('change',()=>{if(selected&&!active)analyzeSelection(selected);});
$('apply-recommendation').addEventListener('click',()=>{
  if(!analysisData||active)return;const value=presetStrength[analysisData.recommendation.preset];strength=value;
  document.querySelectorAll('.preset').forEach(b=>{const chosen=Number(b.dataset.strength)===value;b.classList.toggle('active',chosen);b.setAttribute('aria-pressed',String(chosen));});$('apply-recommendation').hidden=true;
});
function setProgress(percent,message) {
  $('percent').textContent=`${Math.round(percent)}%`;
  $('bar').parentElement.setAttribute('aria-valuenow',String(Math.round(percent)));
  $('bar').style.width=`${percent}%`;
  if(message)$('phase').textContent=message;
}
function displayError(message) {
  $('error').textContent=message;
  $('error').hidden=false;
  $('progress-wrap').hidden=true;
  $('cancel').hidden=true;
  $('start').disabled=!selected;active=false;
  setBusy(false);
  chunks=[];outputBytes=0;
}
async function resetWorker() {
  try{worker?.terminate();}catch{}worker=null;
  try{await saving?.abort();}catch{}saving=null;
}
function buildName(filename) {return `${filename.replace(/\.[^.]+$/,'').replace(/[\\/:*?"<>|]/g,'_')}_cleaned.wav`;}
async function start() {
  if(!selected||active||analysisWorker)return;
  failed=false;
  $('error').hidden=true;$('result').hidden=true;
  const file=selected;
  saveHandle=null;chunks=[];outputBytes=0;
  if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null;}
  if(downloadUrl){URL.revokeObjectURL(downloadUrl);downloadUrl=null;}
  if(!('Worker' in window)) {displayError('This browser does not support Web Workers.');return;}
  active=true;$('start').disabled=true;$('error').hidden=true;setBusy(true);
  const usePicker=typeof window.showSaveFilePicker==='function' && !$('download-mode').checked;
  if(!usePicker&&!$('download-mode').checked){
    active=false;$('start').disabled=false;setBusy(false);
    displayError('This browser cannot write the WAV incrementally to a chosen file. Select “Use a browser download” to explicitly accept memory-backed export, or use recent Chrome/Edge for long recordings.');
    return;
  }
  if(usePicker) {
    try {
      saveHandle=await window.showSaveFilePicker({suggestedName:buildName(file.name),types:[
        {description:'16-bit PCM WAV',accept:{'audio/wav':['.wav']}}]});
      saving=await saveHandle.createWritable();
    } catch(e) {
      active=false;$('start').disabled=false;setBusy(false);
      if(e.name==='AbortError')return;
      displayError(`Could not open the save destination: ${e.message||'permission denied'}. Choose browser download explicitly to use memory-backed export.`);
      return;
    }
  }
  $('cancel').hidden=false;
  $('progress-wrap').hidden=false;setProgress(0,'Preparing recording…');
  $('detail').textContent=saveHandle?'Writing directly to your selected file.':'Your WAV will download when processing finishes. Long recordings use additional browser memory.';
  writeChain=Promise.resolve();
  worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
  worker.onmessage=e=>{const m=e.data;
    if(m.type==='ready'){
      sampleRate=m.sampleRate;
      if(saving)writeChain=writeChain.then(()=>saving.write(new Uint8Array(44)));
    } else if(m.type==='details'){
      const estimate=m.duration*sampleRate*2;
      if(estimate>=0xFFFFFFFF-36){worker?.postMessage({type:'cancel'});displayError('The estimated output exceeds the 4 GB standard WAV limit. Use the optional local FFmpeg workflow or split the source into shorter parts.');return;}
      if(!saveHandle&&estimate>192*1024*1024){worker?.postMessage({type:'cancel'});displayError('This recording would create a WAV larger than the 192 MB memory-export limit. Use recent Chrome/Edge and select a save location for streaming output, or use the optional local FFmpeg workflow.');return;}
      $('detail').textContent=`${duration(m.duration)} · ${m.inputRate.toLocaleString()} Hz · ${m.channels} channel(s) · ${m.format}. Estimated WAV: ${human(estimate)}. ${saveHandle?'Incremental direct-to-file export.':'Memory-backed browser download.'}`;
    } else if(m.type==='phase'){setProgress(Number($('percent').textContent.replace('%',''))||0,m.message);
    } else if(m.type==='progress'){setProgress(Math.min(99,Math.round(m.fraction*99)));
    } else if(m.type==='pcm'){
      const payload=new Uint8Array(m.data);
      outputBytes+=payload.length;
      writeChain=writeChain.then(async()=>{
        if(saving)await saving.write(payload);
        else chunks.push(payload);
        worker?.postMessage({type:'ack'});
      }).catch(e=>{failed=true;worker?.postMessage({type:'cancel'});displayError(`Could not write output audio: ${e.message}`);});
    } else if(m.type==='done'){
      writeChain=writeChain.then(()=>complete(m.report)).catch(e=>{displayError(e.message);resetWorker();});
    } else if(m.type==='cancelled'){
      resetWorker();chunks=[];outputBytes=0;active=false;setBusy(false);$('cancel').hidden=true;$('progress-wrap').hidden=true;$('start').disabled=false;
    } else if(m.type==='error') {
      writeChain=writeChain.then(()=>resetWorker());displayError(m.message);
    }
  };
  worker.onerror=e=>{displayError(e.message||'Worker failed.');resetWorker();};
  worker.postMessage({type:'start',file,settings:{strength,modules:moduleSettings(),channelMode:$('channel-mode').value,analysis:analysisData}});
}
async function complete(report) {
  if(failed)return;
  if(outputBytes!==report.outputSamples*2)throw new Error(`Output length check failed (${outputBytes} bytes for ${report.outputSamples} samples). The incomplete file was not finalized.`);
  const header=wavHeader(sampleRate,outputBytes);
  if(saving) {
    await saving.write({type:'write',position:0,data:header});
    await saving.close();saving=null;
    // Obtaining File does not copy it into JS memory; audio element can seek in it.
    try {
      const f=await saveHandle.getFile();previewUrl=URL.createObjectURL(f);
      $('preview').src=previewUrl;$('preview').hidden=false;
    } catch {$('preview').hidden=true;}
    $('download').hidden=true;
  } else {
    const blob=new Blob([header,...chunks],{type:'audio/wav'});
    chunks=[];
    downloadUrl=URL.createObjectURL(blob);previewUrl=downloadUrl;
    $('download').href=downloadUrl;$('download').download=buildName(selected.name);
    $('download').hidden=false;
    $('preview').src=previewUrl;$('preview').hidden=false;
  }
  active=false;setProgress(100,'Finished');$('cancel').hidden=true;
  setBusy(false);
  $('progress-wrap').hidden=true;$('result').hidden=false;
  $('summary').textContent=`${human(outputBytes+44)} WAV · ${sampleRate.toLocaleString()} Hz mono · ${saveHandle?'Saved to your selected location':'Ready to download'}.`;
  $('report').textContent=`Sample peak: ${(report.inputPeak*100).toFixed(1)}% → ${(report.outputPeak*100).toFixed(1)}%. RMS: ${(report.inputRms*100).toFixed(2)}% → ${(report.outputRms*100).toFixed(2)}%. Input samples at/near full scale: ${report.clippedInputSamples.toLocaleString()}. These are signal-level measurements, not proof of intelligibility improvement; listen to both versions.`;
  showingOriginal=false;$('ab-toggle').setAttribute('aria-pressed','false');$('ab-toggle').textContent='Listen to original';
  $('preview').src=previewUrl;
  $('start').disabled=false;
  worker?.terminate();worker=null;
}
$('start').addEventListener('click',start);
$('ab-toggle').addEventListener('click',()=>{
  if(!originalUrl||!previewUrl)return;
  const audio=$('preview'),time=audio.currentTime,wasPlaying=!audio.paused;
  showingOriginal=!showingOriginal;audio.src=showingOriginal?originalUrl:previewUrl;
  $('ab-toggle').textContent=showingOriginal?'Listen to cleaned audio':'Listen to original';
  $('ab-toggle').setAttribute('aria-pressed',String(showingOriginal));
  audio.addEventListener('loadedmetadata',()=>{audio.currentTime=Math.min(time,audio.duration||time);if(wasPlaying)audio.play().catch(()=>{});},{once:true});
});
$('cancel').addEventListener('click',()=>worker?.postMessage({type:'cancel'}));
$('start-again').addEventListener('click',()=>{
  analysisWorker?.terminate();analysisWorker=null;analysisData=null;$('analysis-results').hidden=true;$('analysis-status').hidden=true;
  $('result').hidden=true;$('audio-file').value='';selected=null;
  $('file-info').hidden=true;$('drop').hidden=false;$('start').disabled=true;
  if(originalUrl)URL.revokeObjectURL(originalUrl);originalUrl=null;
  if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=null;
  if(downloadUrl)URL.revokeObjectURL(downloadUrl);downloadUrl=null;
  $('preview').removeAttribute('src');$('download').removeAttribute('href');
  window.scrollTo({top:0,behavior:'smooth'});
});
