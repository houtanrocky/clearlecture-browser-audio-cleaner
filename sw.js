const CACHE='clearlecture-static-v4';
const ASSETS=['./','./index.html','./styles.css','./manifest.webmanifest','./favicon.svg','./src/main.js','./src/worker.js','./src/analysis.js','./src/audio.js','./src/dsp.js','./src/mp4.js','./src/wav.js','./src/opus.js'];
const CACHE_URLS=new Set(ASSETS.map(path=>new URL(path,self.location.href).href));
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  await Promise.all(ASSETS.map(async path=>{const response=await fetch(path,{cache:'reload'});if(!response.ok)throw new Error(`Unable to cache required app asset: ${path}`);await cache.put(path,response);}));
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
