import {fft} from './dsp.js';

const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const percentile=(a,p)=>{if(!a.length)return 0;const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor((s.length-1)*p))];};

/** Descriptive metrics for a short representative mono window. Estimates are
 * deliberately labeled as proxies; they are not speech intelligibility scores. */
export function analyzeWindow(samples,sampleRate) {
  if(!Number.isFinite(sampleRate)||sampleRate<8000||sampleRate>192000)throw new Error('Unsupported analysis sample rate');
  if(!samples?.length)return {peak:0,rms:0,quietWindowDbFS:-120,activityPercent:0,clippedPercent:0,dcOffset:0,transientCandidates:0,stationarity:'not enough audio',humFrequency:0,humProminence:0,waveform:[],spectrum:[]};
  const frame=Math.max(1,Math.round(sampleRate*.02)),rmsFrames=[];
  let peak=0,square=0,dc=0,clipped=0,transientCandidates=0,previous=0;
  for(let i=0;i<samples.length;i++) {
    const x=Number.isFinite(samples[i])?samples[i]:0,ax=Math.abs(x);peak=Math.max(peak,ax);square+=x*x;dc+=x;if(ax>=.998)clipped++;
    if(i>1&&i<samples.length-1&&ax>.35&&ax>Math.abs(previous)*5&&ax>Math.abs(samples[i+1])*5)transientCandidates++;
    previous=x;
    if((i+1)%frame===0||i===samples.length-1) {
      const end=i+1,start=Math.max(0,end-frame);let e=0;for(let j=start;j<end;j++){const v=Number.isFinite(samples[j])?samples[j]:0;e+=v*v;}
      rmsFrames.push(Math.sqrt(e/Math.max(1,end-start)));
    }
  }
  const rms=Math.sqrt(square/samples.length),floor=percentile(rmsFrames,.1),threshold=Math.max(.006,floor*2.8,.02*percentile(rmsFrames,.9));
  const active=rmsFrames.filter(x=>x>threshold).length,quiet=rmsFrames.filter(x=>x<=Math.max(threshold,floor*2)).map(x=>x);
  const qMean=quiet.reduce((a,b)=>a+b,0)/Math.max(1,quiet.length),qVar=quiet.reduce((a,b)=>a+(b-qMean)**2,0)/Math.max(1,quiet.length),cv=Math.sqrt(qVar)/Math.max(1e-8,qMean);
  const candidates=[50,60,100,120].filter(f=>f<sampleRate/2),hum=candidates.map(f=>[f,goertzel(samples,sampleRate,f)]).sort((a,b)=>b[1]-a[1]);
  const humProminence=hum.length?hum[0][1]/Math.max(rms,1e-8):0,humFrequency=humProminence>.025&&hum[0][1]>.001?hum[0][0]:0;
  const waveform=makeWaveform(samples,512),spectrum=makeSpectrum(samples);
  return {peak,rms,quietWindowDbFS:20*Math.log10(Math.max(floor,1e-6)),activityPercent:100*active/rmsFrames.length,
    clippedPercent:100*clipped/samples.length,dcOffset:dc/samples.length,transientCandidates,
    stationarity:quiet.length<4?'uncertain':cv<.45?'steady':'changing',humFrequency,humProminence,waveform,spectrum};
}
function goertzel(samples,rate,freq) {
  const omega=2*Math.PI*freq/rate,coeff=2*Math.cos(omega);let q0=0,q1=0,q2=0;
  for(let i=0;i<samples.length;i++){q0=coeff*q1-q2+(Number.isFinite(samples[i])?samples[i]:0);q2=q1;q1=q0;}
  const power=Math.max(0,q1*q1+q2*q2-coeff*q1*q2);
  return Math.sqrt(power)*2/samples.length;
}
function makeWaveform(samples,buckets) {
  const out=new Array(Math.min(buckets,samples.length)),step=samples.length/out.length;
  for(let b=0;b<out.length;b++){const a=Math.floor(b*step),z=Math.max(a+1,Math.floor((b+1)*step));let min=1,max=-1;for(let i=a;i<z;i++){const x=Number.isFinite(samples[i])?samples[i]:0;min=Math.min(min,x);max=Math.max(max,x);}out[b]=[min,max];}
  return out;
}
function makeSpectrum(samples) {
  const n=2048,re=new Float64Array(n),im=new Float64Array(n),start=Math.max(0,Math.floor(samples.length/2-n/2)),count=Math.min(n,samples.length);
  for(let i=0;i<count;i++){const x=Number.isFinite(samples[start+i])?samples[start+i]:0;re[i]=x*(.5-.5*Math.cos(2*Math.PI*i/Math.max(1,count)));}
  fft(re,im);const bins=n/2,bands=48,powers=[];let maxPower=0;
  for(let b=0;b<bands;b++){const lo=Math.max(1,Math.floor((b/bands)**2*bins)),hi=Math.max(lo+1,Math.floor(((b+1)/bands)**2*bins));let p=0;for(let k=lo;k<Math.min(hi,bins);k++)p+=re[k]*re[k]+im[k]*im[k];powers.push(p);maxPower=Math.max(maxPower,p);}
  return powers.map(p=>clamp(10*Math.log10(Math.max(p,1e-18)/Math.max(maxPower,1e-18)),-72,0));
}

export function recommendTreatment(metrics) {
  const preset=metrics.clippedPercent>.05?'gentle':metrics.activityPercent<20&&metrics.quietWindowDbFS>-48?'gentle':'balanced';
  const notes=[];
  if(metrics.humFrequency)notes.push(`A ${metrics.humFrequency} Hz hum candidate was found; the mains-hum notch is enabled.`);
  if(metrics.transientCandidates)notes.push(`${metrics.transientCandidates} isolated transient candidate(s) found; automatic repair is conservative and may leave pen clicks.`);
  if(metrics.clippedPercent>.05)notes.push('Clipping is present in the source; clipped waveform detail cannot be restored. Gentle processing is recommended.');
  if(metrics.stationarity==='changing')notes.push('Quiet-window level varies across the sample; moving sounds may remain because suppressing them can damage speech.');
  if(!notes.length)notes.push('No strong hum or clipping candidate was found in the sampled windows. Balanced is the conservative starting point.');
  return {preset,notes};
}

export function summarizeWindows(windows,sampleRate,channels,format,duration) {
  if(!windows.length)throw new Error('No representative audio windows could be analyzed');
  const floors=windows.map(w=>w.quietWindowDbFS).sort((a,b)=>a-b),hum=windows.filter(w=>w.humFrequency).sort((a,b)=>b.humProminence-a.humProminence)[0];
  const metrics={sampleRate,channels,format,duration,
    peak:Math.max(...windows.map(w=>w.peak)),rms:Math.sqrt(windows.reduce((s,w)=>s+w.rms*w.rms,0)/windows.length),
    quietWindowDbFS:floors[Math.floor(floors.length/2)],activityPercent:windows.reduce((s,w)=>s+w.activityPercent,0)/windows.length,
    clippedPercent:windows.reduce((s,w)=>s+w.clippedPercent,0)/windows.length,dcOffset:windows.reduce((s,w)=>s+w.dcOffset,0)/windows.length,
    transientCandidates:windows.reduce((s,w)=>s+w.transientCandidates,0),stationarity:windows.some(w=>w.stationarity==='changing')?'changing':windows.every(w=>w.stationarity==='steady')?'steady':'uncertain',
    humFrequency:hum?.humFrequency||0,humProminence:hum?.humProminence||0,
    windowCount:windows.length,preview:windows[Math.floor(windows.length/2)]};
  return {...metrics,recommendation:recommendTreatment(metrics)};
}
