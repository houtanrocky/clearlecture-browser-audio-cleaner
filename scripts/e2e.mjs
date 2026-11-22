import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';

if(typeof WebSocket==='undefined')throw new Error('The dependency-free browser test needs Node.js 22 or newer (built-in WebSocket support).');
const projectRoot=fileURLToPath(new URL('../',import.meta.url)),port=Number(process.env.PORT||4179),origin=`http://127.0.0.1:${port}`;
const browserCandidates=[process.env.CLEARLECTURE_BROWSER,process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'];
const browserPath=browserCandidates.find(p=>p&&existsSync(p));
const externalCdp=process.env.CLEARLECTURE_CDP_URL;
if(!browserPath&&!externalCdp)throw new Error('Install Chromium/Edge and set CLEARLECTURE_BROWSER, or provide CLEARLECTURE_CDP_URL for an existing local debug session.');
const profile=await mkdtemp(join(tmpdir(),'clearlecture-e2e-'));
const server=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))],{cwd:projectRoot,env:{...process.env,PORT:String(port)},stdio:'ignore',windowsHide:true});
let browser=null,cdp=null;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await sleep(100);}throw new Error(`Timed out waiting for ${label}`);}
class CDP {
  constructor(ws){this.ws=ws;this.seq=0;this.waiters=new Map();this.events=[];ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id&&this.waiters.has(m.id)){const w=this.waiters.get(m.id);this.waiters.delete(m.id);m.error?w.reject(new Error(m.error.message)):w.resolve(m.result);}else this.events.push(m);});}
  static async connect(url){const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});return new CDP(ws);}
  send(method,params={},sessionId){const id=++this.seq;return new Promise((resolve,reject)=>{this.waiters.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
  async evaluate(expression){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},this.sessionId);if(r.exceptionDetails)throw new Error(r.exceptionDetails.text||'Browser evaluation failed');return r.result?.value;}
  close(){this.ws.close();}
}
async function evaluate(expr){return cdp.evaluate(expr);}
async function waitAppDone(label){return until(async()=>evaluate(`(()=>{const done=!document.querySelector('#result').hidden;const error=!document.querySelector('#error').hidden;return done?{done:true}:error?{error:document.querySelector('#error').textContent}:null})()`),label);}
async function injectFixture(){return evaluate(`(async()=>{const r=await fetch('/tests/fixture.m4a');if(!r.ok)throw new Error('fixture unavailable');const f=new File([await r.arrayBuffer()],'fixture.m4a',{type:'audio/mp4'});const d=new DataTransfer();d.items.add(f);const i=document.querySelector('#audio-file');i.files=d.files;i.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#download-mode').checked=true;return true})()`);}
try {
  await until(async()=>{try{const r=await fetch(origin);return r.ok;}catch{return false;}},'local static server',10000);
  let version;
  if(externalCdp)version=await (await fetch(new URL('/json/version',externalCdp))).json();
  else {
    const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const debugPort=probe.address().port;await new Promise(resolve=>probe.close(resolve));
    let browserLog='';
    try{browser=spawn(browserPath,['--headless=new','--no-first-run','--no-default-browser-check','--disable-gpu','--remote-allow-origins=*',`--user-data-dir=${profile}`,`--remote-debugging-port=${debugPort}`,'about:blank'],{stdio:['ignore','pipe','pipe'],windowsHide:true});}
    catch(error){throw new Error(`Could not launch the browser (${error.code}). Set CLEARLECTURE_CDP_URL to an existing local Chromium debug endpoint to run this smoke test without spawning a browser.`);}
    browser.stderr.on('data',chunk=>{browserLog+=chunk.toString();});browser.stdout.on('data',chunk=>{browserLog+=chunk.toString();});
    version=await until(async()=>{if(browser.exitCode!==null)throw new Error(`Browser exited (${browser.exitCode}): ${browserLog}`);try{return await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();}catch{return null;}},'Chromium DevTools protocol',20000);
  }
  const rootCdp=await CDP.connect(version.webSocketDebuggerUrl);
  const {targetId}=await rootCdp.send('Target.createTarget',{url:'about:blank'});
  const attached=await rootCdp.send('Target.attachToTarget',{targetId,flatten:true});
  cdp=rootCdp;cdp.sessionId=attached.sessionId;
  await cdp.send('Page.enable',{},cdp.sessionId);await cdp.send('Runtime.enable',{},cdp.sessionId);
  await cdp.send('Page.navigate',{url:origin},cdp.sessionId);
  await until(()=>evaluate(`document.readyState==='complete'&&!!document.querySelector('#start')`),'app page');
  await cdp.send('Network.enable',{},cdp.sessionId);
  // Record that app work makes no cross-origin network requests.
  const startEvents=cdp.events.length;
  const feature=await evaluate(`({decoder:typeof AudioDecoder==='function',worker:typeof Worker==='function',picker:typeof showSaveFilePicker==='function'})`);
  if(!feature.decoder||!feature.worker)throw new Error(`Required browser capabilities missing: ${JSON.stringify(feature)}`);

  await injectFixture();
  await evaluate(`(()=>{document.querySelector('#start').click();document.querySelector('#cancel').click();return true})()`);
  await until(async()=>evaluate(`(()=>{const c=document.querySelector('#cancel').hidden;const p=document.querySelector('#progress-wrap').hidden;return c&&p?true:null})()`),'cancellation cleanup',10000);
  const afterCancel=await evaluate(`({resultHidden:document.querySelector('#result').hidden,startEnabled:!document.querySelector('#start').disabled,error:document.querySelector('#error').textContent})`);
  if(!afterCancel.resultHidden||!afterCancel.startEnabled||afterCancel.error)throw new Error(`Cancel state invalid: ${JSON.stringify(afterCancel)}`);

  await evaluate(`document.querySelector('#start').click()`);
  const completed=await waitAppDone('AAC fixture processing');
  if(completed.error)throw new Error(`AAC processing failed: ${completed.error}`);
  const metrics=await evaluate(`(async()=>{const bytes=await(await fetch(document.querySelector('#preview').src)).arrayBuffer();window.__clearlectureOutput=bytes;const view=new DataView(bytes);const context=new AudioContext();const decoded=await context.decodeAudioData(bytes.slice(0));const pcm=new Int16Array(bytes,44);let peak=0,rms=0;for(const sample of pcm){const x=sample/32768;peak=Math.max(peak,Math.abs(x));rms+=x*x;}await context.close();return {riff:view.getUint32(0,false)===0x52494646,wave:view.getUint32(8,false)===0x57415645,format:view.getUint16(20,true),channels:view.getUint16(22,true),rate:view.getUint32(24,true),bytes:bytes.byteLength,frames:pcm.length,duration:decoded.duration,decodedRate:decoded.sampleRate,peak,rms:Math.sqrt(rms/pcm.length)}})()`);
  if(!metrics.riff||!metrics.wave||metrics.format!==1||metrics.channels!==1||metrics.rate!==24000||Math.abs(metrics.duration-10)>0.08||metrics.rms<0.001||metrics.peak>0.98)throw new Error(`AAC→WAV checks failed: ${JSON.stringify(metrics)}`);

  await cdp.send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:profile},cdp.sessionId);
  await evaluate(`document.querySelector('#download').click()`);
  const downloadedPath=join(profile,'fixture_cleaned.wav');
  const downloaded=await until(async()=>{try{const b=await readFile(downloadedPath);return b.length===metrics.bytes?b:null;}catch{return null;}},'downloaded WAV file',10000);
  if(downloaded.readUInt32BE(0)!==0x52494646||downloaded.readUInt32BE(8)!==0x57415645)throw new Error('Downloaded file is not a RIFF/WAVE file.');

  await evaluate(`(()=>{const f=new File([window.__clearlectureOutput],'reopened.wav',{type:'audio/wav'});const d=new DataTransfer();d.items.add(f);const i=document.querySelector('#audio-file');i.files=d.files;i.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#download-mode').checked=true;document.querySelector('#start').click();return true})()`);
  const wavDone=await waitAppDone('reopened WAV processing');
  if(wavDone.error)throw new Error(`Reopened WAV processing failed: ${wavDone.error}`);
  await evaluate(`(()=>{document.querySelector('#start-again').click();return true})()`);

  // No app network requests are necessary; the app fixture request is same-origin.
  const network=cdp.events.slice(startEvents).filter(m=>m.method==='Network.requestWillBeSent').map(m=>m.params.request.url).filter(url=>new URL(url).origin!==origin);
  if(network.length)throw new Error(`Unexpected cross-origin requests: ${network.join(', ')}`);
  console.log(JSON.stringify({browser:browserPath||externalCdp,capabilities:feature,cancelRetry:true,aacToWav:metrics,downloadBytes:downloaded.length,wavReopen:true,externalRequests:0},null,2));
} finally {
  cdp?.close();
  if(browser&&!browser.killed){if(process.platform==='win32')spawnSync('taskkill',['/pid',String(browser.pid),'/t','/f'],{stdio:'ignore'});else browser.kill('SIGTERM');}
  await sleep(250);
  try{await rm(profile,{recursive:true,force:true});}catch{}
  server.kill('SIGTERM');
}
