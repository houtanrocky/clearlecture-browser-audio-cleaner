/* Small, auditable MP4/M4A AAC-LC demuxer. No npm dependencies.
   Only reads the moov metadata and small ranges of compressed audio.
   Not intended to support fragmented MP4, DRM or non-AAC tracks. */
function u32(v,p) { return v.getUint32(p,false); }
function ascii(v,p,n=4) { return String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset+p,n)); }
function bigU64(v,p) {
  const n=(BigInt(u32(v,p))<<32n)|BigInt(u32(v,p+4));
  if(n>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('MP4 box or media offset exceeds the safe integer range');
  return Number(n);
}

function* boxes(v,start,end) {
  for (let p=start; p+8<=end;) {
    const size32=u32(v,p), type=ascii(v,p+4);
    const header=size32===1?16:8;
    if (p+header>end) break;
    const size=size32===1?bigU64(v,p+8):size32===0?end-p:size32;
    if(size<header || p+size>end) throw new Error(`Invalid MP4 box ${type} at ${p}`);
    yield {type, start:p, data:p+header, end:p+size, size};
    p+=size;
  }
}
function one(v,root,type) { return [...boxes(v,root.data,root.end)].find(x=>x.type===type); }
function required(x,label) { if(!x) throw new Error(`Missing MP4 metadata: ${label}`); return x; }
function parseEsds(v,esds) {
  // ISO 14496 ES_Descriptor (03) -> DecoderConfigDescriptor (04) -> DecSpecificInfo (05).
  const data=new Uint8Array(v.buffer,v.byteOffset+esds.data+4,esds.end-esds.data-4);
  function desc(off,end,wanted) {
    while(off<end) {
      if(off>=data.length) return null;
      const tag=data[off++]; let len=0, b=0;
      for(let j=0;j<4;j++) { if(off>=end)return null; b=data[off++]; len=(len<<7)|(b&0x7f); if(!(b&128))break; }
      const at=off, stop=Math.min(off+len,end);
      if(tag===wanted) return data.slice(at,stop);
      if(tag===3) { // ES ID + flags, optional dependency / URL / OCR fields
        let n=at+3; const flags=data[at+2]||0;
        if(flags&0x80)n+=2;
        if(flags&0x40)n+=1+(data[n]||0);
        if(flags&0x20)n+=2;
        const r=desc(n,stop,wanted); if(r)return r;
      } else if(tag===4) { const r=desc(at+13,stop,wanted); if(r)return r; }
      off=stop;
    }
    return null;
  }
  return desc(0,data.length,5);
}
function readTable(v, box, elementSize, read) {
  const n=u32(v,box.data+4), first=box.data+8;
  if(n>8_000_000 || first+n*elementSize>box.end) throw new Error('Invalid or excessively large MP4 sample table');
  return Array.from({length:n},(_,i)=>read(first+i*elementSize));
}
function parseEditList(v,track,movieTimescale,mediaTimescale,sampleRate,mediaDuration) {
  const edts=one(v,track,'edts');
  if(!edts)return {duration:mediaDuration,mediaStartFrames:0,leadingSilenceFrames:0,playableFrames:Math.round(mediaDuration*sampleRate)};
  const elst=required(one(v,edts,'elst'),'elst');
  if(elst.data+8>elst.end)throw new Error('Truncated MP4 edit list');
  const version=v.getUint8(elst.data),count=u32(v,elst.data+4),entryBytes=version===1?20:version===0?12:0;
  if(!entryBytes||count<1||count>2||elst.data+8+count*entryBytes>elst.end)throw new Error('Unsupported or malformed MP4 edit list; this file uses edits that cannot be safely aligned.');
  let leadingTicks=0,mediaEdit=null;
  for(let i=0;i<count;i++) {
    const at=elst.data+8+i*entryBytes;
    const segment=version===1?Number(v.getBigUint64(at,false)):u32(v,at);
    const mediaTime=version===1?Number(v.getBigInt64(at+8,false)):v.getInt32(at+4,false);
    const rateAt=at+(version===1?16:8),rate=v.getInt16(rateAt,false),fraction=v.getInt16(rateAt+2,false);
    if(!Number.isSafeInteger(segment)||rate!==1||fraction!==0)throw new Error('Unsupported MP4 edit-list duration or playback rate.');
    if(mediaTime===-1&&!mediaEdit)leadingTicks+=segment;
    else if(mediaTime>=0&&!mediaEdit)mediaEdit={segment,mediaTime};
    else throw new Error('This MP4 contains multiple or reordered media edits; it cannot be safely aligned by this browser build.');
  }
  if(!mediaEdit)throw new Error('MP4 edit list contains no playable audio segment.');
  const duration=(leadingTicks+mediaEdit.segment)/movieTimescale;
  return {duration,mediaStartFrames:Math.round(mediaEdit.mediaTime*sampleRate/mediaTimescale),
    leadingSilenceFrames:Math.round(leadingTicks*sampleRate/movieTimescale),playableFrames:Math.round(duration*sampleRate)};
}

export async function readMp4Metadata(file) {
  let pos=0,moov=null;
  while(pos+8<=file.size) {
    const h=new DataView(await file.slice(pos,Math.min(file.size,pos+16)).arrayBuffer());
    if(h.byteLength<8)throw new Error('Truncated MP4 box header');
    const s=u32(h,0), typ=ascii(h,4), header=s===1?16:8;
    if(s===1&&h.byteLength<16)throw new Error('Truncated extended MP4 box header');
    const size=s===1?bigU64(h,8):s===0?file.size-pos:s;
    if(size<header || pos+size>file.size) throw new Error('MP4 file is malformed or truncated');
    if(typ==='moov') { moov={pos,size}; break; }
    pos+=size;
  }
  if(!moov) throw new Error('Could not find MP4 moov metadata');
  if(moov.size>64*1024*1024) throw new Error('MP4 metadata is unusually large');
  const v=new DataView(await file.slice(moov.pos,moov.pos+moov.size).arrayBuffer());
  const moovBox=[...boxes(v,0,v.byteLength)].find(x=>x.type==='moov');
  const mvhd=required(one(v,moovBox,'mvhd'),'mvhd'),movieVersion=v.getUint8(mvhd.data);
  if(movieVersion>1)throw new Error('Unsupported MP4 movie header version');
  const movieTimescale=u32(v,mvhd.data+(movieVersion===1?20:12));
  if(!movieTimescale)throw new Error('Invalid MP4 movie timescale');
  for(const trak of boxes(v,moovBox.data,moovBox.end)) {
    if(trak.type!=='trak')continue;
    const mdia=one(v,trak,'mdia'); if(!mdia) continue;
    const hdlr=one(v,mdia,'hdlr'); if(!hdlr || ascii(v,hdlr.data+8)!=='soun')continue;
    const mdhd=required(one(v,mdia,'mdhd'),'mdhd');
    const ver=v.getUint8(mdhd.data), timescale=u32(v,mdhd.data+(ver===1?20:12));
    if(ver>1)throw new Error('Unsupported MP4 media header version');
    if(!timescale)throw new Error('Invalid MP4 media timescale');
    const minf=required(one(v,mdia,'minf'),'minf');
    const stbl=required(one(v,minf,'stbl'),'stbl');
    const stsd=required(one(v,stbl,'stsd'),'stsd');
    if(stsd.data+8>stsd.end||u32(v,stsd.data+4)!==1)throw new Error('Only one MP4 sample description is supported');
    const entryStart=stsd.data+8;
    if(entryStart+8>stsd.end)throw new Error('Truncated MP4 audio sample description');
    const entrySize=u32(v,entryStart), entryType=ascii(v,entryStart+4);
    if(entrySize<36||entryStart+entrySize>stsd.end)throw new Error('Invalid MP4 audio sample description');
    if(entryType!=='mp4a') throw new Error(`Audio codec ${entryType} is not yet supported. Use an AAC-LC .m4a file or WAV.`);
    const channels=v.getUint16(entryStart+24,false);
    const sampleRate=u32(v,entryStart+32)>>>16;
    let asc=null;
    if(entrySize>=36) {
      for(const child of boxes(v,entryStart+36,entryStart+entrySize)) {
        if(child.type==='esds')asc=parseEsds(v,child);
      }
    }
    if(!asc || asc.length<2) throw new Error('AAC decoder configuration was not found in M4A file');
    const objectType=(asc[0]>>3)&31;
    if(objectType!==2)throw new Error(`AAC profile ${objectType} is not supported by this minimal demuxer (AAC-LC required)`);
    const stsz=required(one(v,stbl,'stsz'),'stsz');
    const fixedSize=u32(v,stsz.data+4), sampleCount=u32(v,stsz.data+8);
    if(sampleCount>3_000_000)throw new Error('This M4A has too many audio packets for the bounded metadata table. Split the file or use the local FFmpeg option.');
    const sizes=new Uint32Array(sampleCount);
    if(fixedSize)sizes.fill(fixedSize);
    else {
      if(stsz.data+12+4*sampleCount>stsz.end)throw new Error('Truncated MP4 stsz table');
      for(let i=0;i<sampleCount;i++)sizes[i]=u32(v,stsz.data+12+i*4);
    }
    const stco=one(v,stbl,'stco'), co64=one(v,stbl,'co64');
    const offsetBox=required(stco||co64,'stco/co64');
    const chunkOffsets=readTable(v,offsetBox,stco?4:8,at=>stco?u32(v,at):bigU64(v,at));
    const stscBox=required(one(v,stbl,'stsc'),'stsc');
    const stsc=readTable(v,stscBox,12,at=>({first:u32(v,at),count:u32(v,at+4),description:u32(v,at+8)}));
    const sttsBox=required(one(v,stbl,'stts'),'stts');
    const stts=readTable(v,sttsBox,8,at=>({count:u32(v,at),delta:u32(v,at+4)}));
    if(sampleCount===0)throw new Error('M4A contains no AAC audio packets');
    if(!stsc.length||stsc[0].first!==1||stsc.some((x,j)=>x.count===0||x.description!==1||(j&&x.first<=stsc[j-1].first)))throw new Error('Invalid MP4 sample-to-chunk table');
    if(stts.some(x=>x.count===0||x.delta===0)||stts.reduce((n,x)=>n+x.count,0)!==sampleCount)throw new Error('MP4 decode-time table does not match the AAC sample count');
    const offsets=new Float64Array(sampleCount);
    let i=0,part=0;
    for(let ch=0;ch<chunkOffsets.length;ch++) {
      while(part+1<stsc.length && ch+1>=stsc[part+1].first)part++;
      const per=stsc[part]?.count||0;
      let o=chunkOffsets[ch];
      for(let k=0;k<per && i<sampleCount;k++,i++) { offsets[i]=o; o+=sizes[i]; }
    }
    if(i!==sampleCount)throw new Error('MP4 chunk/sample tables do not match');
    let totalBig=0n;for(const item of stts)totalBig+=BigInt(item.count)*BigInt(item.delta);
    if(totalBig>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('MP4 duration exceeds the safe timestamp range');
    const totalUnits=Number(totalBig);
    const edit=parseEditList(v,trak,movieTimescale,timescale,sampleRate,totalUnits/timescale);
    return {kind:'aac', codec:'mp4a.40.2',sampleRate,channels,timescale,sizes,offsets,stts,
      asc,sampleCount,duration:edit.duration,...edit};
  }
  throw new Error('No AAC audio track was found in this MP4/M4A file');
}

export function mp4SampleIndexAt(meta,seconds) {
  const target=Math.max(0,seconds*meta.timescale);let units=0,index=0;
  for(const run of meta.stts) {
    const span=run.count*run.delta;
    if(target<units+span)return Math.min(meta.sampleCount,index+Math.floor((target-units)/run.delta));
    units+=span;index+=run.count;
  }
  return meta.sampleCount;
}

export async function* mp4SampleGroups(file,meta,maxBytes=320*1024,startIndex=0,endIndex=meta.sampleCount) {
  startIndex=Math.max(0,Math.min(meta.sampleCount,startIndex|0));endIndex=Math.max(startIndex,Math.min(meta.sampleCount,endIndex|0));
  let index=startIndex,t=0,tt=0,ttRemain=meta.stts[0]?.count||0,skip=startIndex;
  while(tt<meta.stts.length&&skip>=meta.stts[tt].count){t+=meta.stts[tt].count*meta.stts[tt].delta;skip-=meta.stts[tt].count;tt++;}
  if(tt<meta.stts.length){t+=skip*meta.stts[tt].delta;ttRemain=meta.stts[tt].count-skip;}
  while(index<endIndex) {
    let from=meta.offsets[index], end=from, last=index;
    while(last<endIndex) {
      const off=meta.offsets[last], size=meta.sizes[last];
      if(last!==index && (off<from || off>end+16*1024 || off+size-from>maxBytes))break;
      end=Math.max(end,off+size); last++;
    }
    if(end>file.size)throw new Error('AAC sample extends beyond file');
    const data=new Uint8Array(await file.slice(from,end).arrayBuffer());
    const samples=[];
    for(let j=index;j<last;j++) {
      if(ttRemain===0) {tt++;ttRemain=meta.stts[tt]?.count||0;}
      const delta=meta.stts[tt]?.delta||1024;
      samples.push({bytes:data.subarray(meta.offsets[j]-from,meta.offsets[j]-from+meta.sizes[j]),
        timestamp:Math.round(t*1e6/meta.timescale),duration:Math.round(delta*1e6/meta.timescale)});
      t+=delta;ttRemain--;
    }
    yield {samples,progress:last/meta.sampleCount};
    index=last;
  }
}
