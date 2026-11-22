import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeWindow,summarizeWindows} from '../src/analysis.js';

test('representative-window analyzer reports bounded metrics and chart data',()=>{
  const rate=48000,samples=Float32Array.from({length:rate*2},(_,i)=>.12*Math.sin(2*Math.PI*220*i/rate)+.025*Math.sin(2*Math.PI*60*i/rate));
  const result=analyzeWindow(samples,rate);
  assert.ok(result.rms>0&&result.rms<.2);assert.ok(result.peak<.2);
  assert.equal(result.waveform.length,512);assert.equal(result.spectrum.length,48);
  assert.equal(result.humFrequency,60);assert.ok(result.quietWindowDbFS<0);
  assert.ok(result.activityPercent>=0&&result.activityPercent<=100);
});

test('window summaries label suggestions as presets and retain middle preview',()=>{
  const samples=Float32Array.from({length:48000},(_,i)=>.12*Math.sin(i*.04));
  const w=analyzeWindow(samples,24000),summary=summarizeWindows([{...w,label:'Beginning'},w,{...w,label:'End'}],24000,1,'PCM WAV',3);
  assert.equal(summary.windowCount,3);assert.equal(summary.preview,w);assert.ok(['gentle','balanced'].includes(summary.recommendation.preset));
});
