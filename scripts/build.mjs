import {cp,mkdir,rm} from 'node:fs/promises';
const root=new URL('../',import.meta.url),out=new URL('../dist/',import.meta.url);
await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
for(const name of ['index.html','styles.css','_headers','manifest.webmanifest','favicon.svg','sw.js','src','README.md']) await cp(new URL(name,root),new URL(name,out),{recursive:true});
console.log('Static site copied to dist/. Deploy that directory as a Cloudflare Pages static site.');
