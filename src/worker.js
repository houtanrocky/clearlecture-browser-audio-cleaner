import {readMp4Metadata,mp4SampleGroups,mp4SampleIndexAt} from './mp4.js';
import {readWavMetadata,wavFloatGroups,readWavWindow} from './wav.js';
import {VoiceProcessor} from './dsp.js';
import {compactBitrate, opusConfig, OggOpusEncoder} from './opus.js';
import {mixChannelFrame} from './audio.js';
import {analyzeWindow,summarizeWindows} from './analysis.js';

let running=false, cancelled=false, pending=0,processor=null,bytesWritten=0,opus=null;
let resolveDrain=null;
const post=(type,detail={})=>self.postMessage({type,...detail});
const analysisWindows=duration=>{
  const width=Math.min(2,Math.max(.25,duration)),last=Math.max(0,duration-width);
  return [...new Set([0,Math.max(0,(duration-width)/2),last].map(x=>Math.round(x*1000)/1000))].map((start,i)=>({start,duration:Math.min(width,Math.max(0,duration-start)),label:['Beginning','Middle','End'][i]}));
};
async function decodeAnalysisWindow(file,meta,startTime,windowDuration,channelMode) {
  const mediaStart=(meta.mediaStartFrames||0)/meta.sampleRate+Math.max(0,startTime-(meta.leadingSilenceFrames||0)/meta.sampleRate);
  const first=mp4SampleIndexAt(meta,mediaStart),last=Math.min(meta.sampleCount,mp4SampleIndexAt(meta,mediaStart+windowDuration)+2);
  if(first>=last)return new Float32Array();
  const chunks=[];let frameCount=0,error=null,decoder;
  try {
    const config={codec:meta.codec,sampleRate:meta.sampleRate,numberOfChannels:meta.channels,description:meta.asc};
    const support=await AudioDecoder.isConfigSupported(config);if(!support.supported)throw new Error('This browser cannot decode AAC-LC for analysis');
    decoder=new AudioDecoder({output(audio){try{
      const remain=Math.max(0,Math.ceil((windowDuration+.25)*meta.sampleRate)-frameCount);if(!remain)return;
      const take=Math.min(remain,audio.numberOfFrames),planes=Array.from({length:audio.numberOfChannels},(_,ch)=>{const p=new Float32Array(audio.numberOfFrames);audio.copyTo(p,{planeIndex:ch,format:'f32-planar'});return p;}),mono=new Float32Array(take);
      for(let i=0;i<take;i++)mono[i]=mixChannelFrame(planes.length,ch=>planes[ch][i],channelMode);
      chunks.push(mono);frameCount+=take;
    }catch(e){error=e;}finally{audio.close();}},error(e){error=e;}});
    decoder.configure(config);
    for await(const group of mp4SampleGroups(file,meta,320*1024,first,last)) {
      if(cancelled)throw new Error('Cancelled');
      for(const sample of group.samples){while(decoder.decodeQueueSize>24)await new Promise(r=>setTimeout(r,5));if(error)throw error;decoder.decode(new EncodedAudioChunk({type:'key',timestamp:sample.timestamp,duration:sample.duration,data:sample.bytes}));}
    }
    await decoder.flush();if(error)throw error;
  } finally {try{decoder?.close();}catch{}}
  const result=new Float32Array(frameCount);let at=0;for(const chunk of chunks){result.set(chunk,at);at+=chunk.length;}
  return result;
}
async function analyzeFile(file,channelMode='average') {
  cancelled=false;
  try {
    const ext=file.name.split('.').pop().toLowerCase();let meta,format,windows=[];
    post('analysis-phase',{message:'Reading audio metadata'});
    if(ext==='wav') {
      meta=await readWavMetadata(file);if(!meta.frames)throw new Error('This WAV contains no audio samples');format='PCM WAV';
      for(const w of analysisWindows(meta.duration)) {
        if(cancelled)throw new Error('Cancelled');const start=Math.min(meta.frames,Math.floor(w.start*meta.sampleRate)),count=Math.min(Math.floor(w.duration*meta.sampleRate),meta.frames-start);
        const audio=await readWavWindow(file,meta,start,count,channelMode);windows.push({...analyzeWindow(audio,meta.sampleRate),label:w.label});
      }
    } else if(['m4a','m4b','mp4'].includes(ext)) {
      if(typeof AudioDecoder==='undefined')throw new Error('WebCodecs AAC analysis is unavailable in this browser');
      meta=await readMp4Metadata(file);format='AAC-LC in M4A';
      for(const w of analysisWindows(meta.duration)) {
        if(cancelled)throw new Error('Cancelled');const audio=await decodeAnalysisWindow(file,meta,w.start,w.duration,channelMode);
        windows.push({...analyzeWindow(audio,meta.sampleRate),label:w.label});
      }
    } else throw new Error('Analysis supports PCM WAV and AAC-LC M4A/MP4 only.');
    if(cancelled)throw new Error('Cancelled');
    const analysis=summarizeWindows(windows,meta.sampleRate,meta.channels,format,meta.duration);
    post('analysis',{analysis});
  } catch(e) {post(cancelled?'analysis-cancelled':'analysis-error',{message:String(e?.message||e)});}
}
function trackWrite(bytes) {
  // Browser main thread acknowledges file writes. Backpressure caps memory.
  bytesWritten+=bytes.byteLength;pending++;
  self.postMessage({type:'output',data:bytes.buffer},[bytes.buffer]);
}
async function drain(max=8) {
  while(!cancelled && (pending>max || opus?.encoder.encodeQueueSize>4))await new Promise(resolve=>{
    resolveDrain=resolve;
    setTimeout(()=>{if(resolveDrain===resolve)resolveDrain=null;resolve();},40);
  });
  if(cancelled)throw new Error('Cancelled');
  if(opus?.error)throw opus.error;
}
async function startProcessor(meta, settings, sourceBytes, format) {
  const rate=meta.sampleRate;
  if(!Number.isFinite(rate)||rate<8000||rate>192000)throw new Error('Unsupported audio sample rate');
  const hum=settings.analysis?.humFrequency||0,humFrequencies=hum?[hum,hum*2,hum*3,hum*4].filter(f=>f<rate*.45):[];
  processor=new VoiceProcessor(rate,{...settings,humFrequencies},bytes=>{
    if(opus)opus.push(bytes);
    else trackWrite(bytes);
  });
  const sampleRate=processor.outputRate;
  let bitrate;
  if(settings.exportFormat==='opus') {
    bitrate=compactBitrate(sourceBytes,meta.duration);
    const config=opusConfig(sampleRate,bitrate);
    let supported=false;
    try {supported=typeof AudioEncoder==='function'&&(await AudioEncoder.isConfigSupported(config)).supported;}catch{}
    if(!supported) {
      throw new Error('Compact export is unavailable for this recording in this browser. Choose WAV to continue.');
    }
    opus=new OggOpusEncoder(config,trackWrite);
  }
  post('ready',{sampleRate});
  post('details',{duration:meta.duration,channels:meta.channels,inputRate:rate,format,bitrate});
}
async function work(file,settings) {
  if(running)throw new Error('Already processing');
  running=true;cancelled=false;bytesWritten=0;pending=0;
  const extension=file.name.split('.').pop().toLowerCase();
  let decoder=null;
  try {
    if(['m4a','mp4','m4b'].includes(extension)) {
      if(typeof AudioDecoder==='undefined')throw new Error('This browser lacks WebCodecs AudioDecoder. Use an updated Chrome, Edge or Safari on HTTPS/localhost.');
      post('phase',{message:'Reading M4A metadata'});
      const meta=await readMp4Metadata(file);
      if(meta.channels<1||meta.channels>8)throw new Error('Unsupported channel count');
      const config={codec:meta.codec,sampleRate:meta.sampleRate,numberOfChannels:meta.channels,description:meta.asc};
      const support=await AudioDecoder.isConfigSupported(config);
      if(!support.supported)throw new Error('This browser cannot decode AAC-LC for this recording');
      await startProcessor(meta,settings,file.size,'AAC-LC in M4A');
      let decoderError=null;
      let primingLeft=meta.mediaStartFrames||0,mediaFramesKept=0;
      const mediaFramesTarget=meta.playableFrames||Math.round(meta.duration*meta.sampleRate);
      decoder=new AudioDecoder({
        output(audio) {
          try {
            if(audio.sampleRate!==meta.sampleRate)throw new Error('AAC decoder changed the sample rate unexpectedly');
            const skip=Math.min(primingLeft,audio.numberOfFrames);primingLeft-=skip;
            const take=Math.min(audio.numberOfFrames-skip,mediaFramesTarget-mediaFramesKept);
            if(take<=0)return;
            const mono=new Float32Array(take);
            const planes=Array.from({length:audio.numberOfChannels},(_,ch)=>{
              const plane=new Float32Array(audio.numberOfFrames);audio.copyTo(plane,{planeIndex:ch,format:'f32-planar'});return plane;
            });
            for(let i=0;i<take;i++)mono[i]=mixChannelFrame(planes.length,ch=>planes[ch][i+skip],settings.channelMode);
            processor.push(mono);mediaFramesKept+=take;
          } catch(error){decoderError=error;}
          finally {audio.close();}
        },
        error(error){decoderError=error;}
      });
      decoder.configure(config);
      post('phase',{message:'Decoding, denoising and exporting'});
      let silenceLeft=meta.leadingSilenceFrames||0;
      const zeroBlock=new Float32Array(16384);
      while(silenceLeft>0) {
        if(cancelled)throw new Error('Cancelled');
        const n=Math.min(silenceLeft,zeroBlock.length);processor.push(zeroBlock.subarray(0,n));silenceLeft-=n;await drain();
      }
      for await(const group of mp4SampleGroups(file,meta)) {
        if(cancelled)throw new Error('Cancelled');
        if(decoderError)throw decoderError;
        for(const s of group.samples) {
          await drain();
          while(decoder.decodeQueueSize>32) {
            await new Promise(r=>setTimeout(r,8));
            if(decoderError)throw decoderError;
            if(cancelled)throw new Error('Cancelled');
          }
          decoder.decode(new EncodedAudioChunk({type:'key',timestamp:s.timestamp,duration:s.duration,data:s.bytes}));
        }
        await drain();
        post('progress',{fraction:group.progress});
      }
      await decoder.flush();decoder.close();decoder=null;
      if(decoderError)throw decoderError;
      let missing=mediaFramesTarget-mediaFramesKept;
      while(missing>0) {
        if(cancelled)throw new Error('Cancelled');
        const n=Math.min(missing,zeroBlock.length);processor.push(zeroBlock.subarray(0,n));missing-=n;await drain();
      }
    } else if(extension==='wav') {
      post('phase',{message:'Reading WAV header'});
      const meta=await readWavMetadata(file);
      if(meta.frames===0)throw new Error('This WAV contains no audio samples');
      await startProcessor(meta,settings,file.size,'PCM WAV');
      post('phase',{message:'Cleaning and exporting audio'});
      for await(const group of wavFloatGroups(file,meta,65536,settings.channelMode)) {
        if(cancelled)throw new Error('Cancelled');
        processor.push(group.mono);await drain();
        post('progress',{fraction:group.progress});
      }
    } else throw new Error('Please use an AAC-LC M4A or uncompressed WAV. Other formats are not enabled in this dependency-free build.');
    if(cancelled)throw new Error('Cancelled');
    const report=processor.finish();
    if(opus)await opus.finish();
    await drain(0);
    post('done',{report,bytesWritten});
  } catch(e) {
    post(cancelled?'cancelled':'error',{message:String(e?.message||e)});
  } finally {try{decoder?.close();opus?.close();}catch{}opus=null;running=false;}
}
self.onmessage=event=>{
  const m=event.data;
  if(m.type==='start')work(m.file,m.settings);
  else if(m.type==='analyze')analyzeFile(m.file,m.channelMode);
  else if(m.type==='ack') {pending=Math.max(0,pending-1);const r=resolveDrain;resolveDrain=null;r?.();}
  else if(m.type==='cancel') {cancelled=true;const r=resolveDrain;resolveDrain=null;r?.();}
};
