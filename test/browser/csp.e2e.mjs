import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {chromium} from 'playwright';
const root=resolve(import.meta.dirname,'../..'),id='neilinbkkjgcnflgamepebchiapfcibm';
test('on-page unlock remains usable on a site which disallows frames',{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'qf05-csp-profile-'));const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"frame-src 'none'"});res.end('<!doctype html><title>Synthetic CSP login</title><h1>Synthetic CSP login</h1><input autocomplete=username><input type=password>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));let ctx;
 try{ctx=await chromium.launchPersistentContext(dir,{headless:true,channel:'chromium',args:[`--disable-extensions-except=${join(root,'.build/extension')}`,`--load-extension=${join(root,'.build/extension')}`]});await (ctx.serviceWorkers()[0]?Promise.resolve():ctx.waitForEvent('serviceworker'));const options=await ctx.newPage();await options.goto(`chrome-extension://${id}/options.html`);
  await options.evaluate(()=>chrome.runtime.sendMessage({type:'qf.vault_setup',password:'Synthetic8!'}));await options.evaluate(()=>chrome.runtime.sendMessage({type:'qf.vault_lock'}));const page=await ctx.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.bringToFront();
  let frame;for(let n=0;n<40;n++){frame=page.frames().find(f=>f.url().startsWith(`chrome-extension://${id}/unlock.html?`));if(frame)break;await new Promise(r=>setTimeout(r,100));}
  assert(frame,'no trusted unlock surface rendered under frame-src none');await frame.locator('#password').waitFor({timeout:3000});
  await writeFile(join(root,'release-evidence/browser-csp.json'),JSON.stringify({status:'PASS',browser:'isolated Chromium',sitePolicy:"frame-src 'none'",trustedFrame:true},null,2));
 }finally{if(ctx)await ctx.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
