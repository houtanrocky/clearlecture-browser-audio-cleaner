import {wavHeader} from './wav.js';
import {compactBitrate, opusConfig} from './opus.js';
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
const $=(x)=>document.getElementById(x);
let selected=null, worker=null, analysisWorker=null, analysisData=null, saving=null, writeChain=Promise.resolve(),chunks=[],outputBytes=0;
let sampleRate=0,active=false, previewUrl=null, originalUrl=null,saveHandle=null,showingOriginal=false;
let strength=0.52;
const formats={
  opus:{label:'Opus',extension:'ogg',mime:'audio/ogg',description:'Compressed Opus audio'},
  wav:{label:'WAV',extension:'wav',mime:'audio/wav',description:'Uncompressed PCM16 WAV'}
};
const MEMORY_LIMIT=192*1024*1024;
const pickerAvailable=typeof window.showSaveFilePicker==='function';
$('download-mode').checked=!pickerAvailable;
if(!pickerAvailable)$('destination-option').hidden=true;
(async()=>{
  try {
    return !!$('preview').canPlayType('audio/ogg; codecs=opus')&&
      typeof AudioEncoder==='function'&&(await AudioEncoder.isConfigSupported(opusConfig(24000,48000))).supported;
  } catch {return false;}
})().then(supported=>{
  if(!supported) {
    $('export-format').value='wav';
    $('export-format').querySelector('[value="opus"]').disabled=true;
    $('format-help').textContent='This browser exports mono WAV. Compact Opus is unavailable.';
  }
  if(!active)refreshEstimate();
  return supported;
});
function refreshEstimate() {
  const seconds=analysisData?.duration;
  const compact=$('export-format').value==='opus';
  $('export-estimate').textContent=seconds>0
    ? 'Estimated size \u00b7 '+human(compact
      ? seconds*(compactBitrate(selected.size,seconds)/8+110)+512
      : seconds*wavOutputRate(analysisData.sampleRate)*2+44)
    : '';
}
const wavOutputRate=rate=>rate>=32000&&rate%2===0?rate/2:rate;
$('export-format').addEventListener('change',refreshEstimate);
const moduleSettings=()=>Object.fromEntries([...document.querySelectorAll('[data-module]')].map(x=>[x.dataset.module,x.checked]));
const presetStrength={gentle:.28,balanced:.52,strong:.82};
function setBusy(busy) {
  for(const el of [$('audio-file'),$('remove'),$('download-mode'),$('export-format'),$('channel-mode'),$('apply-recommendation'),...document.querySelectorAll('.preset'),...document.querySelectorAll('[data-module]')])el.disabled=busy;
  $('drop').setAttribute('aria-disabled',String(busy));$('drop').tabIndex=busy?-1:0;
}
const human=bytes=>bytes<1024*1024
  ? (bytes/1024).toFixed(bytes<10*1024?1:0)+' KB'
  : (bytes/1024/1024).toFixed(1)+' MB';
const duration=(sec)=>`${Math.floor(sec/60)}m ${Math.floor(sec%60)}s`;
function drawAnalysis(a) {
  const {sampleRate,channels,format,duration:seconds,peak,rms,quietWindowDbFS,activityPercent,clippedPercent,dcOffset,stationarity,humFrequency,recommendation,preview}=a;
  $('analysis-summary').textContent=[format,duration(seconds),channels===1?'Mono':channels+' channels',sampleRate.toLocaleString()+' Hz'].join(' \u00b7 ');
  $('analysis-measurements').textContent=
    'Quiet-window level '+quietWindowDbFS.toFixed(1)+' dBFS ('+stationarity+'). Estimated speech-like activity '+activityPercent.toFixed(0)+'%. '+
    (humFrequency?humFrequency+' Hz hum candidate. ':'No strong mains hum candidate. ')+
    'Peak '+(peak*100).toFixed(1)+'%. RMS '+(rms*100).toFixed(1)+'%. '+
    'Samples near full scale '+clippedPercent.toFixed(3)+'%. DC offset '+(dcOffset*100).toFixed(2)+'%.';
  $('analysis-suggestion').textContent=`Suggested preset: ${recommendation.preset[0].toUpperCase()+recommendation.preset.slice(1)}`;
  $('analysis-notes').replaceChildren(...recommendation.notes.map(note=>{const li=document.createElement('li');li.textContent=note;return li;}));
  $('apply-recommendation').hidden=Number(document.querySelector('.preset.active')?.dataset.strength)===presetStrength[recommendation.preset];
  for(const [id,data] of [['waveform',preview.waveform],['spectrum',preview.spectrum]]) {
    const canvas=$(id),ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);ctx.fillStyle='#102131';ctx.fillRect(0,0,w,h);ctx.strokeStyle='#89e0c6';ctx.fillStyle='#89e0c6';ctx.lineWidth=1;
    if(id==='waveform'){const mid=h/2;ctx.beginPath();ctx.moveTo(0,mid);ctx.lineTo(w,mid);ctx.strokeStyle='#405769';ctx.stroke();ctx.strokeStyle='#89e0c6';for(let i=0;i<data.length;i++){const x=(i+.5)*w/data.length;ctx.beginPath();ctx.moveTo(x,mid-data[i][1]*(h*.44));ctx.lineTo(x,mid-data[i][0]*(h*.44));ctx.stroke();}}
    else {const gap=1,bw=w/data.length;for(let i=0;i<data.length;i++){const db=data[i],bar=Math.max(1,((db+72)/72)*(h-8));ctx.globalAlpha=.35+.65*(db+72)/72;ctx.fillRect(i*bw+gap,h-bar,bw-gap,bar);}ctx.globalAlpha=1;}
  }
  $('analysis-results').hidden=false;
  refreshEstimate();
}
function analyzeSelection(file=selected) {
  analysisWorker?.terminate();analysisWorker=null;analysisData=null;$('analysis-results').hidden=true;refreshEstimate();
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
  clearResult();
  $('analysis-status').hidden=true;analyzeSelection(f);
}
$('audio-file').addEventListener('change',e=>setFile(e.target.files[0]));
$('remove').addEventListener('click',()=>{
  if(active)return;
  analysisWorker?.terminate();analysisWorker=null;analysisData=null;$('analysis-results').hidden=true;refreshEstimate();$('analysis-status').hidden=true;
  if(originalUrl)URL.revokeObjectURL(originalUrl);originalUrl=null;
  selected=null;clearResult();$('error').hidden=true;$('file-info').hidden=true;$('drop').hidden=false;
  $('audio-file').value='';$('start').disabled=true;drop.focus();
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
  if(analysisData)$('apply-recommendation').hidden=strength===presetStrength[analysisData.recommendation.preset];
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
async function displayError(message) {
  await resetWorker();
  $('error').textContent=message;
  $('error').hidden=false;
  $('progress-wrap').hidden=true;
  $('cancel').hidden=true;
  $('start').disabled=!selected;active=false;
  setBusy(false);
  chunks=[];outputBytes=0;
}
async function resetWorker() {
  worker?.terminate();
  worker=null;
  const destination=saving;
  saving=null;
  try{await destination?.abort();}catch{}
}
function clearResult() {
  $('result').hidden=true;
  const preview=$('preview');
  preview.pause();
  preview.removeAttribute('src');
  preview.load();
  if(previewUrl)URL.revokeObjectURL(previewUrl);
  previewUrl=null;
  $('download').removeAttribute('href');
}
function buildName(filename,format) {return `${filename.replace(/\.[^.]+$/,'').replace(/[\\/:*?"<>|]/g,'_')}_cleaned.${format.extension}`;}
async function start() {
  if(!selected||active||analysisWorker)return;
  $('error').hidden=true;clearResult();
  const file=selected;
  const exportFormat=$('export-format').value;
  const format=formats[exportFormat];
  const wav=exportFormat==='wav';
  saveHandle=null;chunks=[];outputBytes=0;
  if(!('Worker' in window)) {displayError('This browser does not support Web Workers.');return;}
  active=true;$('start').disabled=true;$('error').hidden=true;setBusy(true);
  const usePicker=pickerAvailable&&!$('download-mode').checked;
  if(usePicker) {
    try {
      saveHandle=await window.showSaveFilePicker({suggestedName:buildName(file.name,format),types:[
        {description:format.description,accept:{[format.mime]:['.'+format.extension]}}]});
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
  $('detail').textContent=saveHandle?'Writing directly to your selected file.':'The cleaned file will be ready to download when processing finishes.';
  writeChain=Promise.resolve();
  let current;
  try {
    current=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
  } catch(error) {
    await displayError(error.message);
    return;
  }
  worker=current;
  const fail=message=>{if(worker===current)return displayError(message);};
  current.onmessage=async e=>{
    if(worker!==current)return;
    const m=e.data;
    if(m.type==='ready'){
      sampleRate=m.sampleRate;
      if(saving&&wav) {
        writeChain=saving.write(new Uint8Array(44)).catch(error=>{
          return fail('Could not start the WAV file: '+error.message);
        });
      }
    } else if(m.type==='details'){
      const estimate=wav?m.duration*sampleRate*2+44:m.duration*(m.bitrate/8+110)+512;
      if(wav&&estimate>0xffffffff+8){displayError('This recording exceeds the WAV size limit. Try compact Opus export or split the recording.');return;}
      if(!saveHandle&&estimate>MEMORY_LIMIT){displayError('The estimated output exceeds the browser download limit. Use compact Opus or save directly to a file in Chrome or Edge.');return;}
      $('detail').textContent=[duration(m.duration),'Estimated '+format.label+' size '+human(estimate),saveHandle?'Saving directly to disk':'Browser download'].join(' \u00b7 ');
    } else if(m.type==='phase'){setProgress(Number($('percent').textContent.replace('%',''))||0,m.message);
    } else if(m.type==='progress'){setProgress(Math.min(99,Math.round(m.fraction*99)));
    } else if(m.type==='output'){
      const payload=new Uint8Array(m.data);
      outputBytes+=payload.length;
      if(!saveHandle&&outputBytes+(wav?44:0)>MEMORY_LIMIT){displayError('The output reached the browser download limit. Use a smaller recording or save directly to a file.');return;}
      writeChain=writeChain.then(async()=>{
        if(worker!==current)return;
        if(saving)await saving.write(payload);
        else chunks.push(payload);
        if(worker===current)current.postMessage({type:'ack'});
      }).catch(error=>fail('Could not write output audio: '+error.message));
    } else if(m.type==='done'){
      $('cancel').hidden=true;
      writeChain=writeChain.then(()=>{
        if(worker===current)return complete(m.report,m.bytesWritten,format,wav);
      }).catch(error=>fail(error.message));
    } else if(m.type==='cancelled'){
      await resetWorker();chunks=[];outputBytes=0;active=false;setBusy(false);$('cancel').hidden=true;$('progress-wrap').hidden=true;$('start').disabled=false;
    } else if(m.type==='error') {
      await displayError(m.message);
    }
  };
  current.onerror=e=>fail(e.message||'Worker failed.');
  current.postMessage({type:'start',file,settings:{strength,exportFormat,modules:moduleSettings(),channelMode:$('channel-mode').value,analysis:analysisData}});
}
async function complete(report,bytesWritten,format,wav) {
  if(outputBytes!==bytesWritten||!outputBytes||(wav&&outputBytes!==report.outputSamples*2))throw new Error(`Output length check failed (${outputBytes} bytes for ${report.outputSamples} samples). The incomplete file was not finalized.`);
  const header=wav?wavHeader(sampleRate,outputBytes):null;
  if(saving) {
    if(header)await saving.write({type:'write',position:0,data:header});
    await saving.close();saving=null;
    // Obtaining File does not copy it into JS memory; audio element can seek in it.
    try {
      const f=await saveHandle.getFile();previewUrl=URL.createObjectURL(f);
      $('preview').src=previewUrl;$('preview').hidden=false;
    } catch {$('preview').hidden=true;}
    $('download').hidden=true;
  } else {
    const blob=new Blob(header?[header,...chunks]:chunks,{type:format.mime});
    chunks=[];
    previewUrl=URL.createObjectURL(blob);
    $('download').href=previewUrl;$('download').download=buildName(selected.name,format);
    $('download').hidden=false;
    $('preview').src=previewUrl;$('preview').hidden=false;
  }
  active=false;setProgress(100,'Finished');$('cancel').hidden=true;
  setBusy(false);
  $('progress-wrap').hidden=true;$('result').hidden=false;
  const total=outputBytes+(header?.length??0);
  const change=Math.round(Math.abs(1-total/selected.size)*100);
  $('summary').textContent=[format.label+' \u00b7 '+human(total),
    change?change+'% '+(total<selected.size?'smaller':'larger')+' than the '+human(selected.size)+' original':'About the same size as the original',
    saveHandle?'Saved to your selected location':'Ready to download'].join(' | ');
  $('download').textContent='Download '+format.label;
  $('report').textContent=`Sample peak: ${(report.inputPeak*100).toFixed(1)}% → ${(report.outputPeak*100).toFixed(1)}%. RMS: ${(report.inputRms*100).toFixed(2)}% → ${(report.outputRms*100).toFixed(2)}%. Input samples at/near full scale: ${report.clippedInputSamples.toLocaleString()}. These are signal-level measurements, not proof of intelligibility improvement; listen to both versions.`;
  showingOriginal=false;$('ab-toggle').setAttribute('aria-pressed','false');$('ab-toggle').textContent='Listen to original';
  $('ab-toggle').hidden=!previewUrl;
  $('start').disabled=false;
  $('result').focus();
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
  analysisWorker?.terminate();analysisWorker=null;analysisData=null;$('analysis-results').hidden=true;refreshEstimate();$('analysis-status').hidden=true;
  clearResult();$('audio-file').value='';selected=null;
  $('file-info').hidden=true;$('drop').hidden=false;$('start').disabled=true;
  if(originalUrl)URL.revokeObjectURL(originalUrl);originalUrl=null;
  drop.focus();
});
