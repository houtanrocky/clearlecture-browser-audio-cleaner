import test from 'node:test';
import assert from 'node:assert/strict';
import {fft,VoiceProcessor,repairIsolatedClick} from '../src/dsp.js';
import {wavHeader} from '../src/wav.js';

// Tiny tests run with Node alone. For the full M4A path, use the browser smoke test.
test('FFT inverse round-trip',()=>{
  const r=new Float64Array(1024),im=new Float64Array(1024);
  for(let i=0;i<r.length;i++)r[i]=Math.sin(i*.04)+0.5*Math.cos(i*.1);
  const orig=r.slice();fft(r,im);fft(r,im,true);
  let max=0;for(let i=0;i<r.length;i++)max=Math.max(max,Math.abs(r[i]-orig[i]));
  assert.ok(max<1e-10,`FFT round trip error ${max}`);
});
test('processor outputs correctly shaped PCM16 chunks',()=>{
  const blocks=[];const p=new VoiceProcessor(48000,{strength:.5},b=>blocks.push(b));
  const seconds=2,rate=48000,n=seconds*rate;
  const a=new Float32Array(n);
  for(let i=0;i<n;i++)a[i]=.12*Math.sin(2*Math.PI*220*i/rate)+.015*Math.sin(2*Math.PI*900*i/rate);
  p.push(a);const info=p.finish();
  assert.equal(info.sampleRate,24000);
  const bytes=blocks.reduce((s,b)=>s+b.byteLength,0);
  assert.ok(bytes>1.9*24000*2 && bytes<2.1*24000*2,`Unexpected output byte count: ${bytes}`);
  assert.ok(info.outputPeak<=.98);
  assert.ok(info.inputPeak<=.14);
});
test('RIFF header is 44 bytes and expresses PCM mono',()=>{
  const h=wavHeader(24000,48000);const v=new DataView(h.buffer);
  assert.equal(h.byteLength,44);assert.equal(v.getUint32(24,true),24000);
  assert.equal(v.getUint16(22,true),1);assert.equal(v.getUint32(40,true),48000);
});
test('standard RIFF output refuses sizes beyond its 4GB capacity',()=>{
  assert.throws(()=>wavHeader(24000,0xFFFFFFFF),/4GB RIFF limit/);
});
test('small input flushes to exactly the right output duration',()=>{
  for(const n of [1,20,510,512,513,1024,2223,48000]){
    let count=0;
    const p=new VoiceProcessor(48000,{strength:.52},b=>count+=b.length);
    const a=new Float32Array(n);
    for(let i=0;i<n;i++)a[i]=.1*Math.sin(i*.2);
    p.push(a);const info=p.finish();
    assert.equal(count,Math.ceil(n/2)*2,`Unexpected bytes for ${n} samples`);
    assert.equal(info.outputSamples,Math.ceil(n/2));
  }
});
test('STFT overlap-add reconstructs an untreated signal closely',()=>{
  const rate=24000,n=17003,blocks=[];
  const p=new VoiceProcessor(rate,{strength:0,modules:{highpass:false,lowpass:false,clickRepair:false,denoise:false,leveling:false,limiter:false}},b=>blocks.push(b));
  const input=Float32Array.from({length:n},(_,i)=>0.31*Math.sin(i*.031)+0.09*Math.sin(i*.177));
  p.push(input);p.finish();
  const out=new Int16Array(blocks.reduce((a,b)=>a+b.length,0)/2);let at=0;
  for(const b of blocks){const v=new DataView(b.buffer,b.byteOffset,b.byteLength);for(let i=0;i<b.length;i+=2)out[at++]=v.getInt16(i,true);}
  assert.equal(out.length,n);
  let max=0;for(let i=100;i<n-100;i++)max=Math.max(max,Math.abs(input[i]-out[i]/32767));
  assert.ok(max<0.00008,`reconstruction error ${max}`);
});
test('streamed chunk boundaries do not change the cleaned output',()=>{
  const input=Float32Array.from({length:12347},(_,i)=>.11*Math.sin(i*.08)+.02*Math.sin(i*.013));
  const render=sizes=>{const chunks=[],p=new VoiceProcessor(24000,{strength:.35},b=>chunks.push(b));let at=0;for(const size of sizes){p.push(input.subarray(at,Math.min(input.length,at+size)));at+=size;}if(at<input.length)p.push(input.subarray(at));p.finish();return Buffer.concat(chunks.map(x=>Buffer.from(x)));};
  assert.deepEqual(render([input.length]),render([1,511,7,1023,4096,3,1200]));
});
test('isolated clicks are repaired while multi-sample transients remain',()=>{
  assert.equal(repairIsolatedClick(.01,.9,.02),.015);
  assert.equal(repairIsolatedClick(.05,.2,.3),.2);
});
test('silence and non-finite input stay finite, quiet and exact length',()=>{
  const n=1003,blocks=[],p=new VoiceProcessor(24000,{strength:.5},b=>blocks.push(b));
  const x=new Float32Array(n);x[10]=NaN;x[20]=Infinity;p.push(x);const report=p.finish();
  assert.equal(report.outputSamples,n);assert.equal(report.outputPeak,0);assert.equal(report.outputRms,0);
  const pcm=Buffer.concat(blocks.map(b=>Buffer.from(b)));assert.ok(pcm.every(v=>v===0));
});
test('half-rate resampling suppresses frequencies above the output Nyquist',()=>{
  const chunks=[],p=new VoiceProcessor(48000,{modules:{highpass:false,lowpass:false,clickRepair:false,denoise:false,leveling:false,limiter:false}},b=>chunks.push(b));
  const input=Float32Array.from({length:48000},(_,i)=>0.5*Math.sin(2*Math.PI*14000*i/48000));
  p.push(input);const report=p.finish();let squares=0,count=0;
  for(const chunk of chunks){const view=new DataView(chunk.buffer,chunk.byteOffset,chunk.byteLength);for(let i=0;i<chunk.byteLength;i+=2){const x=view.getInt16(i,true)/32768;squares+=x*x;count++;}}
  assert.equal(count,24000);assert.ok(Math.sqrt(squares/count)<0.01,'aliased out-of-band tone remains audible');
  assert.ok(report.outputRms<0.01,'reported RMS must describe the exported resampled PCM');
});
test('detected hum notch attenuates mains tone while retaining speech band',()=>{
  const render=hum=>{const chunks=[],p=new VoiceProcessor(48000,{humFrequencies:hum?[60]:[],modules:{highpass:false,lowpass:false,clickRepair:false,denoise:false,leveling:false,limiter:false}},b=>chunks.push(b));const input=Float32Array.from({length:48000},(_,i)=>.1*Math.sin(2*Math.PI*60*i/48000)+.1*Math.sin(2*Math.PI*1000*i/48000));p.push(input);p.finish();const result=new Float32Array(24000);let at=0;for(const b of chunks){const v=new DataView(b.buffer,b.byteOffset,b.byteLength);for(let i=0;i<b.length;i+=2)result[at++]=v.getInt16(i,true)/32768;}return result;};
  const amplitude=(samples,freq)=>{let re=0,im=0;for(let i=0;i<samples.length;i++){const a=2*Math.PI*freq*i/24000;re+=samples[i]*Math.cos(a);im-=samples[i]*Math.sin(a);}return 2*Math.hypot(re,im)/samples.length;};
  const before=render(false),after=render(true);
  assert.ok(amplitude(after,60)<amplitude(before,60)*.2);
  assert.ok(amplitude(after,1000)>amplitude(before,1000)*.9);
});
