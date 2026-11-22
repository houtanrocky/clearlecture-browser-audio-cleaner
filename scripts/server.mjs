import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {extname,join,normalize,relative,isAbsolute} from 'node:path';
const base=process.cwd(),port=Number(process.env.PORT||4173);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.md':'text/markdown; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json; charset=utf-8'};
createServer(async(req,res)=>{
  try {const raw=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^[/\\]+/,''),path=normalize(raw),file=join(base,!path||path==='.'?'index.html':path),rel=relative(base,file);if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/')))throw new Error('Invalid path');
    const info=await stat(file);if(!info.isFile())throw new Error('Not found');res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream','cache-control':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer','permissions-policy':'geolocation=(), microphone=(), camera=()','content-security-policy':"default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; connect-src 'self' blob:; media-src 'self' blob:; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"});res.end(await readFile(file));
  } catch {res.writeHead(404);res.end('Not found');}
}).listen(port,()=>console.log(`ClearLecture at http://localhost:${port}`));
