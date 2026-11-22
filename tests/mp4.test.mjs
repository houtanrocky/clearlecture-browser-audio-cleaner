import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readMp4Metadata,mp4SampleGroups} from '../src/mp4.js';
import {readWavMetadata,wavFloatGroups} from '../src/wav.js';

test('read synthetic AAC-LC M4A metadata and packets',async()=>{
  const file=new Blob([readFileSync(new URL('./fixture.m4a',import.meta.url))]);
  const meta=await readMp4Metadata(file);
  assert.equal(meta.codec,'mp4a.40.2');assert.equal(meta.sampleRate,48000);
  assert.equal(meta.channels,1);assert.equal(meta.duration,10);
  assert.equal(meta.mediaStartFrames,1024);assert.equal(meta.playableFrames,480000);
  assert.ok(meta.sampleCount>400);
  let packets=0;
  for await(const group of mp4SampleGroups(file,meta)){
    packets+=group.samples.length;
    for(const sample of group.samples)assert.ok(sample.bytes.byteLength>0);
  }
  assert.equal(packets,meta.sampleCount);
});
test('reject unsupported or malformed multi-edit AAC timelines',async()=>{
  const bytes=readFileSync(new URL('./fixture.m4a',import.meta.url));
  const at=bytes.indexOf('elst');assert.ok(at>0);
  bytes.writeUInt32BE(3,at+8);
  await assert.rejects(readMp4Metadata(new Blob([bytes])),/edit list/i);
});
test('MP4 range reads retain original packet timestamps',async()=>{
  const file=new Blob([readFileSync(new URL('./fixture.m4a',import.meta.url))]),meta=await readMp4Metadata(file);
  const all=[];for await(const group of mp4SampleGroups(file,meta))all.push(...group.samples);
  const start=120,end=155,part=[];for await(const group of mp4SampleGroups(file,meta,320*1024,start,end))part.push(...group.samples);
  assert.equal(part.length,end-start);assert.equal(part[0].timestamp,all[start].timestamp);assert.equal(part.at(-1).timestamp,all[end-1].timestamp);
});
test('stream read synthetic WAV samples',async()=>{
  const file=new Blob([readFileSync(new URL('./fixture.wav',import.meta.url))]);
  const meta=await readWavMetadata(file);
  assert.equal(meta.sampleRate,48000);assert.equal(meta.channels,1);
  let count=0;
  for await(const group of wavFloatGroups(file,meta)){
    count+=group.mono.length;
    assert.ok(group.mono.every(Number.isFinite));
  }
  assert.equal(count,480000);
});

test('streaming WAV reader can select one stereo channel',async()=>{
  const b=new ArrayBuffer(52),v=new DataView(b),put=(p,s)=>[...s].forEach((c,i)=>v.setUint8(p+i,c.charCodeAt(0)));
  put(0,'RIFF');v.setUint32(4,44,true);put(8,'WAVE');put(12,'fmt ');v.setUint32(16,16,true);
  v.setUint16(20,1,true);v.setUint16(22,2,true);v.setUint32(24,8000,true);v.setUint32(28,32000,true);v.setUint16(32,4,true);v.setUint16(34,16,true);
  put(36,'data');v.setUint32(40,8,true);v.setInt16(44,8192,true);v.setInt16(46,-8192,true);v.setInt16(48,16384,true);v.setInt16(50,-16384,true);
  const f=new Blob([b]),m=await readWavMetadata(f);
  const left=[];for await(const g of wavFloatGroups(f,m,65536,'left'))left.push(...g.mono);
  const right=[];for await(const g of wavFloatGroups(f,m,65536,'right'))right.push(...g.mono);
  assert.deepEqual(left,[0.25,0.5]);assert.deepEqual(right,[-0.25,-0.5]);
});
