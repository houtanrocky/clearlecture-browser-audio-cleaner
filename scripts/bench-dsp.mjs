import {VoiceProcessor} from '../src/dsp.js';

const minutes=Number(process.argv[2]||60),sampleRate=48000,blockSize=16384;
if(!Number.isFinite(minutes)||minutes<=0||minutes>120)throw new Error('Pass a duration in minutes from 0 to 120.');
const totalSamples=Math.round(minutes*60*sampleRate),started=process.hrtime.bigint();
let writtenBytes=0,seed=0x13579bdf,startRss=process.memoryUsage().rss,peakRss=startRss;
const processor=new VoiceProcessor(sampleRate,{strength:0.52},bytes=>{writtenBytes+=bytes.byteLength;});
let cursor=0,phase=0;
while(cursor<totalSamples) {
  const n=Math.min(blockSize,totalSamples-cursor),block=new Float32Array(n);
  for(let i=0;i<n;i++) {
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const noise=(seed/0x100000000-0.5)*0.012;
    const t=cursor+i,active=(t%(sampleRate*5))<sampleRate*4;
    block[i]=active?0.12*Math.sin(phase+i*2*Math.PI*220/sampleRate)+0.035*Math.sin(phase+i*2*Math.PI*660/sampleRate)+noise:noise;
  }
  phase=(phase+n*2*Math.PI*220/sampleRate)%(2*Math.PI);
  processor.push(block);cursor+=n;
  if(cursor%(sampleRate*10)<blockSize)peakRss=Math.max(peakRss,process.memoryUsage().rss);
}
const report=processor.finish();
const seconds=Number(process.hrtime.bigint()-started)/1e9;
const expectedBytes=Math.ceil(totalSamples/2)*2;
if(writtenBytes!==expectedBytes||report.outputSamples!==Math.ceil(totalSamples/2))throw new Error(`Length mismatch: ${writtenBytes} bytes, expected ${expectedBytes}.`);
console.log(JSON.stringify({scope:'DSP-only; synthetic 48 kHz mono input; output discarded after byte counting',minutes,sampleRate,totalSamples,outputRate:report.sampleRate,outputSamples:report.outputSamples,outputBytes:writtenBytes,elapsedSeconds:Number(seconds.toFixed(2)),realtimeFactor:Number((minutes*60/seconds).toFixed(2)),startRssMiB:Number((startRss/1024/1024).toFixed(1)),maxRssMiB:Number((peakRss/1024/1024).toFixed(1)),endRssMiB:Number((process.memoryUsage().rss/1024/1024).toFixed(1)),maxSamplePeak:Number(report.outputPeak.toFixed(4))},null,2));
