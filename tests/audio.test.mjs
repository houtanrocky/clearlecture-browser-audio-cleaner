import test from 'node:test';
import assert from 'node:assert/strict';
import {mixChannelFrame} from '../src/audio.js';

test('stereo downmix selection handles average, left and right modes',()=>{
  const pair=[0.25,-0.75];
  assert.equal(mixChannelFrame(2,c=>pair[c],'average'),-0.25);
  assert.equal(mixChannelFrame(2,c=>pair[c],'left'),0.25);
  assert.equal(mixChannelFrame(2,c=>pair[c],'right'),-0.75);
  assert.equal(mixChannelFrame(1,()=>0.4,'right'),0.4);
});

test('stereo downmix replaces non-finite channel samples with silence',()=>{
  assert.equal(mixChannelFrame(2,c=>c?NaN:0.6,'average'),0.3);
});
