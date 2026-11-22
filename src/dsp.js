/* Streaming, browser-only lecture voice enhancement.
   High-pass + low-pass, isolated spike repair, adaptive STFT noise suppression,
   gentle AGC + peak compression and streaming half-rate anti-alias resampling.
   No ML weights.
   Output is PCM16 chunks; no audio needs to be uploaded. */

export function fft(re,im,inverse=false) {
  const n=re.length;
  if(n<2 || (n&(n-1)))throw new Error('FFT size must be a power of two');
  for(let i=1,j=0;i<n;i++) {
    let bit=n>>1;while(j&bit){j^=bit;bit>>=1;}j^=bit;
    if(i<j) {let x=re[i];re[i]=re[j];re[j]=x; x=im[i];im[i]=im[j];im[j]=x;}
  }
  for(let len=2;len<=n;len<<=1) {
    const a=(inverse?2:-2)*Math.PI/len, c0=Math.cos(a),s0=Math.sin(a);
    for(let i=0;i<n;i+=len) {
      let c=1,s=0;
      for(let j=0;j<len/2;j++) {
        const e=i+j,o=e+len/2;
        const r=re[o]*c-im[o]*s, k=re[o]*s+im[o]*c;
        re[o]=re[e]-r; im[o]=im[e]-k;
        re[e]+=r; im[e]+=k;
        const nc=c*c0-s*s0; s=s*c0+c*s0;c=nc;
      }
    }
  }
  if(inverse)for(let i=0;i<n;i++){re[i]/=n; im[i]/=n;}
}
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

/** Replace only isolated, polarity-independent sample spikes; speech transients
 * lasting multiple samples (including plosives) are left alone. */
export function repairIsolatedClick(previous2, current, next, threshold=0.24) {
  const neighbours=(previous2+next)*0.5;
  return Math.abs(current-neighbours)>threshold &&
    Math.abs(current)>Math.abs(previous2)*2.5 && Math.abs(current)>Math.abs(next)*2.5
      ? neighbours : current;
}

export class VoiceProcessor {
  constructor(sampleRate, options={}, onPcm=()=>{}) {
    this.sampleRate=sampleRate;
    this.outputRate=sampleRate>=32000 && sampleRate%2===0?sampleRate/2:sampleRate;
    this.decimation=sampleRate/this.outputRate;
    this.strength=clamp(Number(options.strength??0.52),0,1);
    this.modules={highpass:true,hum:true,clickRepair:true,denoise:true,leveling:true,limiter:true,...(options.modules||{})};
    this.humFilters=(options.humFrequencies||[]).filter(f=>Number.isFinite(f)&&f>20&&f<sampleRate*.45).map(f=>this._makeNotch(f,30));
    this.onPcm=onPcm;
    this.N=1024;this.H=512;this.frame=new Float32Array(this.N);
    this.pos=this.H; // prefix half a frame of zeros; strip first output hop
    this.skip=this.H;
    this.ola=new Float32Array(this.N);this.norm=new Float32Array(this.N);
    this.re=new Float64Array(this.N);this.im=new Float64Array(this.N);
    this.win=new Float32Array(this.N);
    for(let i=0;i<this.N;i++)this.win[i]=Math.sqrt(0.5-0.5*Math.cos(2*Math.PI*i/this.N));
    this.noise=new Float32Array(this.N/2+1);
    this.mask=new Float32Array(this.N/2+1).fill(1);
    this.frameIndex=0;
    this.hpPrev=0; this.inPrev=0;this.lpPrev=0;this.lpPrev2=0;
    this.hpA=(1/(2*Math.PI*85))/(1/(2*Math.PI*85)+1/sampleRate);
    const lpHz=Math.min(this.outputRate*.34,7600);
    this.lpA=1-Math.exp(-2*Math.PI*lpHz/sampleRate);
    this.resampleRadius=this.decimation===1?0:15;
    this.resampleTaps=this.decimation===1?null:this._makeResampleTaps(31,0.18);
    this.resampleHistory=this.decimation===1?null:new Float32Array(31);
    this.resampleInputFrames=0;this.resampleNextCenter=0;
    this.spikePrev2=0;this.spikePrev=0;
    this.rms2=0.009;this.agcGain=1;
    this.rmsA=1-Math.exp(-1/(sampleRate*0.40));
    this.agcA=1-Math.exp(-1/(sampleRate*0.40));
    this.peak=0;this.inputPeak=0;this.clipped=0;this.inputCount=0;this.inputSquares=0;this.outputSquares=0;
    this.out=new Int16Array(32768);this.outCount=0;this.outputSamples=0;this.renderedFrames=0;
    this.decimSum=0;this.decimCount=0;
  }
  push(samples) {
    for(let i=0;i<samples.length;i++) {
      const x=Number.isFinite(samples[i])?clamp(samples[i],-2,2):0;
      this.inputPeak=Math.max(this.inputPeak,Math.abs(x));if(Math.abs(x)>=0.998)this.clipped++;
      this.inputCount++;
      // One-pole high-pass + low-pass, with speech-friendly bandwidth.
      this.inputSquares+=x*x;
      let hp=this.modules.highpass?this.hpA*(this.hpPrev+x-this.inPrev):x;this.hpPrev=hp;this.inPrev=x;
      if(this.modules.hum)for(const f of this.humFilters)hp=this._notchSample(hp,f);
      const lp1=this.lpPrev+this.lpA*(hp-this.lpPrev);this.lpPrev=lp1;
      const lp=this.modules.lowpass===false?hp:(this.lpPrev2+this.lpA*(lp1-this.lpPrev2));this.lpPrev2=lp;
      // Interpolate isolated sample spikes; do not edit transients spanning words.
      const y=this.spikePrev;
      const neighbors=(this.spikePrev2+lp)*0.5;
      const fixed=this.modules.clickRepair?repairIsolatedClick(this.spikePrev2,y,lp):lp;
      this.spikePrev2=y;this.spikePrev=lp;
      // Hold the first sample for one look-ahead step. The DSP frame therefore
      // receives sample zero at timeline zero instead of a leading zero.
      if(!this.modules.clickRepair)this._feed(fixed);
      else if(this.inputCount>1)this._feed(fixed);
    }
  }
  _feed(v) {
    this.frame[this.pos++]=v;
    if(this.pos===this.N) {this._frame();this.frame.copyWithin(0,this.H);this.pos=this.H;}
  }
  _frame() {
    const N=this.N,H=this.H,re=this.re,im=this.im;
    let energy=0;
    for(let i=0;i<N;i++) {const x=this.frame[i]*this.win[i];re[i]=x;im[i]=0;energy+=x*x;}
    fft(re,im);
    const quiet=Math.sqrt(energy/N)<0.021;
    const floor=0.46-0.30*this.strength;
    for(let k=0;k<=N/2;k++) {
      const mag=Math.hypot(re[k],im[k]);let noise=this.noise[k];
      if(this.frameIndex===0)noise=mag;
      else {
        // Slower updates on non-quiet frames protect ongoing speech.
        const update=mag<noise?0.065:(quiet?0.004:0.00015);
        noise+=(mag-noise)*update;
      }
      this.noise[k]=noise;
      const subtract=(0.6+1.85*this.strength)*noise;
      let g=this.modules.denoise?clamp(1-subtract/(mag+1e-9),floor,1):1;
      // Temporal smoothing reduces warbly musical-noise artifacts.
      g=this.mask[k]=this.mask[k]*0.58+g*0.42;
      re[k]*=g;im[k]*=g;
      if(k>0 && k<N/2){re[N-k]*=g;im[N-k]*=g;}
    }
    this.frameIndex++;
    fft(re,im,true);
    for(let i=0;i<N;i++) {
      const w=this.win[i];this.ola[i]+=re[i]*w;this.norm[i]+=w*w;
    }
    for(let i=0;i<H;i++) {
      let out=this.ola[i]/Math.max(1e-5,this.norm[i]);
      if(this.skip>0) {this.skip--;continue;}
      if(this.renderedFrames++ >= this.inputCount)continue;
      this.rms2+=(out*out-this.rms2)*this.rmsA;
      const rms=Math.sqrt(Math.max(0,this.rms2));
      const goal=!this.modules.leveling||rms<0.009?1:clamp(0.105/(rms+0.013),0.72,3.0);
      this.agcGain+=(goal-this.agcGain)*this.agcA;
      out*=this.agcGain;
      // Soft peak compression without global hard clipping.
      const a=Math.abs(out);
      if(this.modules.limiter&&a>0.65)out=Math.sign(out)*(0.65+(a-0.65)*0.23);
      out=clamp(out,-0.975,0.975);
      this._resampleFeed(out);
    }
    this.ola.copyWithin(0,H);this.ola.fill(0,H);
    this.norm.copyWithin(0,H);this.norm.fill(0,H);
  }
  _write(x) {
    const pcm=Math.round(clamp(x,-1,1)*32767),normalized=pcm/32768;
    this.out[this.outCount++]=pcm;this.outputSquares+=normalized*normalized;
    this.peak=Math.max(this.peak,Math.abs(normalized));
    this.outputSamples++;
    if(this.outCount===this.out.length)this._emit();
  }
  _makeResampleTaps(length,cutoff) {
    const taps=new Float32Array(length),middle=(length-1)/2;let total=0;
    for(let i=0;i<length;i++) {
      const x=i-middle,sinc=x===0?1:Math.sin(2*Math.PI*cutoff*x)/(2*Math.PI*cutoff*x);
      const window=0.42-0.5*Math.cos(2*Math.PI*i/(length-1))+0.08*Math.cos(4*Math.PI*i/(length-1));
      taps[i]=2*cutoff*sinc*window;total+=taps[i];
    }
    for(let i=0;i<length;i++)taps[i]/=total;
    return taps;
  }
  _makeNotch(freq,q) {
    const w=2*Math.PI*freq/this.sampleRate,alpha=Math.sin(w)/(2*q),a0=1+alpha;
    return {b0:1/a0,b1:-2*Math.cos(w)/a0,b2:1/a0,a1:-2*Math.cos(w)/a0,a2:(1-alpha)/a0,x1:0,x2:0,y1:0,y2:0};
  }
  _notchSample(x,f) {
    const y=f.b0*x+f.b1*f.x1+f.b2*f.x2-f.a1*f.y1-f.a2*f.y2;
    f.x2=f.x1;f.x1=x;f.y2=f.y1;f.y1=y;return y;
  }
  _resampleFeed(sample) {
    if(this.decimation===1){this._write(sample);return;}
    const i=this.resampleInputFrames++,history=this.resampleHistory,taps=this.resampleTaps;
    history[i%history.length]=sample;
    const center=i-this.resampleRadius,targetFrames=Math.ceil(this.inputCount/this.decimation);
    if(center<0||center>=targetFrames*this.decimation||center%this.decimation!==0||center<this.resampleNextCenter)return;
    let y=0;
    for(let k=0;k<taps.length;k++) {
      const source=center+k-this.resampleRadius;
      if(source>=0)y+=history[source%history.length]*taps[k];
    }
    this._write(y);this.resampleNextCenter=center+this.decimation;
  }
  _emit() {
    if(this.outCount===0)return;
    const bytes=new Uint8Array(this.outCount*2),v=new DataView(bytes.buffer);
    for(let i=0;i<this.outCount;i++)v.setInt16(i*2,this.out[i],true);
    this.onPcm(bytes);
    this.outCount=0;
  }
  finish() {
    // Flush final window; fix exact input/output frame count (including partial hop).
    const needed=this.H+this.N-this.pos;
    for(let i=0;i<needed;i++)this._feed(i===0?this.spikePrev:0);
    const targetSamples=Math.ceil(this.inputCount/this.decimation);
    while(this.outputSamples<targetSamples)this._resampleFeed(0);
    this._emit();
    return {sampleRate:this.outputRate,outputSamples:this.outputSamples,
      inputPeak:this.inputPeak,outputPeak:this.peak,clippedInputSamples:this.clipped,
      inputRms:Math.sqrt(this.inputSquares/Math.max(1,this.inputCount)),
      outputRms:Math.sqrt(this.outputSquares/Math.max(1,this.outputSamples))};
  }
}
