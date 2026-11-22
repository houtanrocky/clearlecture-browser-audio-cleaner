/* WAV reader for uncompressed PCM 16/24/32 bit or 32-bit IEEE float.
   Small slice reads, not a full-file decode. */
import {mixChannelFrame} from './audio.js';
function s(v,p,n) {return String.fromCharCode(...new Uint8Array(v.buffer,v.byteOffset+p,n));}
export async function readWavMetadata(file) {
  const header=new DataView(await file.slice(0,Math.min(file.size,1024*1024)).arrayBuffer());
  const container=s(header,0,4);
  if(container==='RF64'||container==='BW64')throw new Error('RF64/BW64 WAV is not supported; convert it to standard PCM WAV or use the local FFmpeg option.');
  if(container!=='RIFF'||s(header,8,4)!=='WAVE')throw new Error('This is not a standard RIFF/WAV audio file');
  let fmt=null, data=null;
  for(let p=12;p+8<=header.byteLength;) {
    const name=s(header,p,4), size=header.getUint32(p+4,true), from=p+8;
    if(name==='fmt ' && size>=16 && from+16<=header.byteLength) {
      let format=header.getUint16(from,true);
      // WAVE_FORMAT_EXTENSIBLE: honor only PCM and IEEE-float subformats.
      if(format===0xfffe && size>=40 && from+40<=header.byteLength) {
        const subtype=header.getUint16(from+24,true);
        format=subtype===1?1:subtype===3?3:subtype;
      }
      fmt={format,channels:header.getUint16(from+2,true),sampleRate:header.getUint32(from+4,true),
        blockAlign:header.getUint16(from+12,true),bits:header.getUint16(from+14,true)};
    }
    if(name==='data') {if(from>file.size)throw new Error('WAV data chunk starts beyond end of file');data={offset:from,bytes:Math.min(size,file.size-from)}; break;}
    if(from+size>header.byteLength)break;
    p=from+size+(size&1);
  }
  if(!fmt||!data)throw new Error('WAV fmt or data chunk not found in first 1MB');
  if(!([1,3].includes(fmt.format))||!([16,24,32].includes(fmt.bits)))throw new Error('WAV supports PCM 16/24/32-bit or IEEE float 32-bit only');
  if(fmt.format===3 && fmt.bits!==32)throw new Error('Only 32-bit floating point WAV is supported');
  if(fmt.channels<1 || fmt.channels>8 || fmt.sampleRate<8000 || fmt.sampleRate>192000)throw new Error('Unusual WAV audio format');
  if(fmt.blockAlign!==fmt.channels*(fmt.bits/8))throw new Error('WAV block alignment does not match its channel and sample format');
  if(data.bytes%fmt.blockAlign)throw new Error('WAV audio data ends with an incomplete sample frame');
  return {kind:'wav',...fmt,...data, frames:Math.floor(data.bytes/fmt.blockAlign),
    duration:data.bytes/fmt.blockAlign/fmt.sampleRate};
}
function decodeWavFrames(bytes,meta,count,channelMode) {
  const mono=new Float32Array(count),bytesPerSample=meta.bits/8;
  for(let i=0;i<count;i++)mono[i]=mixChannelFrame(meta.channels,c=>{
    const off=i*meta.blockAlign+c*bytesPerSample;
    if(meta.format===3)return bytes.getFloat32(off,true);
    if(meta.bits===16)return bytes.getInt16(off,true)/32768;
    if(meta.bits===24){let x=bytes.getUint8(off)|(bytes.getUint8(off+1)<<8)|(bytes.getUint8(off+2)<<16);if(x&0x800000)x-=0x1000000;return x/8388608;}
    return bytes.getInt32(off,true)/2147483648;
  },channelMode);
  return mono;
}
export async function readWavWindow(file,meta,startFrame,countFrames,channelMode='average') {
  const count=Math.max(0,Math.min(countFrames,meta.frames-startFrame)),out=new Float32Array(count),group=65536;
  for(let offset=0;offset<count;offset+=group) {
    const n=Math.min(group,count-offset),from=meta.offset+(startFrame+offset)*meta.blockAlign;
    const view=new DataView(await file.slice(from,from+n*meta.blockAlign).arrayBuffer());
    out.set(decodeWavFrames(view,meta,n,channelMode),offset);
  }
  return out;
}
export async function* wavFloatGroups(file,meta,groupFrames=65536,channelMode='average') {
  for(let start=0;start<meta.frames;start+=groupFrames) {
    const count=Math.min(groupFrames,meta.frames-start),from=meta.offset+start*meta.blockAlign;
    const bytes=new DataView(await file.slice(from,from+count*meta.blockAlign).arrayBuffer());
    yield {mono:decodeWavFrames(bytes,meta,count,channelMode),progress:(start+count)/meta.frames};
  }
}
export function wavHeader(sampleRate,dataBytes,channels=1) {
  if(!Number.isSafeInteger(dataBytes)||dataBytes<0||dataBytes>=0xFFFFFFFF-36)throw new Error('WAV output exceeds the standard 4GB RIFF limit; use a streaming RF64-capable local tool.');
  const b=new ArrayBuffer(44),v=new DataView(b), s=(p,x)=>{for(let i=0;i<x.length;i++)v.setUint8(p+i,x.charCodeAt(i));};
  s(0,'RIFF');v.setUint32(4,36+dataBytes,true);s(8,'WAVE');s(12,'fmt ');
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,channels,true);
  v.setUint32(24,sampleRate,true);v.setUint32(28,sampleRate*channels*2,true);
  v.setUint16(32,channels*2,true);v.setUint16(34,16,true);s(36,'data');v.setUint32(40,dataBytes,true);
  return new Uint8Array(b);
}
