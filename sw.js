const CACHE='clearlecture-static-v2';
const ASSETS=['./','./index.html','./styles.css','./manifest.webmanifest','./favicon.svg','./src/main.js','./src/worker.js','./src/analysis.js','./src/audio.js','./src/dsp.js','./src/mp4.js','./src/wav.js'];
const REQUIRED=ASSETS.filter(path=>!path.endsWith('.svg'));
const CACHE_URLS=new Set(ASSETS.map(path=>new URL(path,self.location.href).href));
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  await Promise.all(REQUIRED.map(async path=>{const response=await fetch(path);if(!response.ok)throw new Error(`Unable to cache required app asset: ${path}`);await cache.put(path,response);}));
  try{const icon=await fetch('./favicon.svg');if(icon.ok)await cache.put('./favicon.svg',icon);}catch{}
  await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||!CACHE_URLS.has(url.href))return;
  event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request).then(response=>{
    if(response.ok) {const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));}
    return response;
  })));
});
