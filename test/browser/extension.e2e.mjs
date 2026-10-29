import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {createFixtureServer} from '../../qa/login-fixture-server.mjs';
const root=resolve(import.meta.dirname,'../..'),build=join(root,'.build/extension');
const id='neilinbkkjgcnflgamepebchiapfcibm',password='Synthetic8!';
const evidence={browser:null,profile:'isolated temporary test profile',originalUserProfileUsed:false,originalSiteAcceptance:'NOT_EXECUTED',cases:[]};
async function poll(fn,timeout=12000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(e){last=e;}await new Promise(r=>setTimeout(r,80));}throw last??Error('condition did not become true');}
async function message(page,value){return page.evaluate(value=>chrome.runtime.sendMessage(value),value);}
async function count(page){const result=await message(page,{type:'qf.get_profiles'});assert.equal(result.type,'qf.profiles');return result.profiles.length;}
async function trace(page){const result=await message(page,{type:'qf.trace_read'});return result.events??[];}
// CDP can inspect the CLOSED shadow root in this disposable synthetic browser.
// Locate the rendered control, then use a real mouse click; font metrics differ
// across macOS and Linux, so a hard-coded viewport coordinate is not reliable.
async function clickSave(page){
 const cdp=await page.context().newCDPSession(page);
 try{
  const point=await poll(async()=>{
   const {root}=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});
   const buttons=[];
   function visit(node){
    const attrs=node.attributes??[];
    if(node.nodeName==='BUTTON'&&attrs.some((a,i)=>i%2===0&&a==='class'&&attrs[i+1].split(/\s+/).includes('primary')))buttons.push(node);
    for(const child of [...(node.children??[]),...(node.shadowRoots??[]),...(node.contentDocument?[node.contentDocument]:[])])visit(child);
   }
   visit(root);assert.equal(buttons.length,1,'exactly one synthetic save control must be present');
   const {model}=await cdp.send('DOM.getBoxModel',{nodeId:buttons[0].nodeId});
   const q=model.content;
   return {x:(q[0]+q[2]+q[4]+q[6])/4,y:(q[1]+q[3]+q[5]+q[7])/4};
  });
  if(!evidence.saveControlPoint){evidence.saveControlPoint=point;console.log("[browser] save control center",JSON.stringify(point));}
  await page.mouse.click(point.x,point.y);
 }finally{await cdp.detach();}
}
const geometry=`<!doctype html><meta charset=utf-8><title>Synthetic geometry</title><body style="margin:30px;height:3000px"><form><label>Email<input id=email type=email autocomplete=email></label><input id=off autocomplete=street-address style="position:absolute;left:-100000px"><input id=tiny autocomplete=tel style="position:absolute;width:1px;height:1px;clip-path:inset(50%)"><input id=below autocomplete=tel style="position:absolute;top:1800px;left:30px;width:200px;height:30px"><div style="width:1px;height:1px;overflow:hidden"><input id=fixed autocomplete=tel style="position:fixed;left:500px;top:100px;width:200px;height:30px"></div><div style="width:1px;height:1px;overflow:hidden;transform:translateZ(0)"><input id=clipped-fixed autocomplete=tel style="position:fixed;left:200px;top:100px;width:200px;height:30px"></div></form></body>`;

test('isolated Chromium MV3: capture, scoped fill, private inline unlock and restart', {timeout:180000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'qf05-browser-profile-'));
 const fixtures=createFixtureServer();
 const server=createServer((req,res)=>{if(req.url==='/geometry'){res.writeHead(200,{'Content-Type':'text/html'});res.end(geometry);}else {if(req.url==='/csp-login'){res.setHeader('Content-Security-Policy',"frame-src 'none'");req.url='/native';}fixtures.emit('request',req,res);}});
 await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
 const origin=`http://127.0.0.1:${server.address().port}`;
 let context;
 const launch=()=>chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,viewport:{width:1280,height:800},args:[`--disable-extensions-except=${build}`,`--load-extension=${build}`]});
 try{
  context=await launch();evidence.browser=context.browser()?.version()??'Chromium';
  let worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');assert.equal(worker.url().split('/')[2],id);
  const options=await context.newPage();await options.goto(`chrome-extension://${id}/options.html`);
  const diagnostics=await context.newPage();await diagnostics.goto(`chrome-extension://${id}/diagnostics.html`);
  const page=await context.newPage();
  // Real extension APIs in its own UI context, no mocked Chrome storage.
  assert.equal(await count(options),0);
  assert.equal((await message(options,{type:'qf.vault_setup',password})).enabled,true);
  for(const [flow,repetitions] of [['native',10],['spa',3]]){
   for(let i=0;i<repetitions;i++){
    await message(diagnostics,{type:'qf.trace_set',enabled:true});
    await page.goto(`${origin}/${flow}`);await page.bringToFront();
    await page.locator('#username').fill(`synthetic-${flow}-${i}`);await page.locator('#password').fill('Synthetic-only-42!');
    const before=await count(options);
    await page.getByRole('heading',{level:1}).click();
    await page.getByRole('button',{name:flow==='native'?'Log in':'Continue',exact:true}).click();
    if(flow==='spa'){await page.getByRole('heading',{name:'SPA replacement complete',exact:true}).waitFor();await poll(()=>page.evaluate(()=>document.documentElement.lastElementChild?.tagName==='DIV'));}
    await poll(async()=>(await trace(diagnostics)).some(e=>e.event==='banner_shown'));
    // Exercise the visible control without changing the closed production root.
    if(flow==='native'&&i===0)await page.screenshot({path:join(root,'release-evidence/browser-save-preview.png')});
    await clickSave(page);
    await poll(async()=>(await count(options))===before+1);
    const events=await poll(async()=>{const events=await trace(diagnostics);return events.some(e=>e.event==='pending_save_ack')?events:null;});
    for(const event of ['save_click','pending_save_sent','pending_save_ack'])assert(events.some(e=>e.event===event));
   }
   evidence.cases.push({case:flow+' capture and save ACK',attempts:repetitions,status:'PASS'});console.log('[browser]',flow,'capture PASS',repetitions);
  }
  for(const path of ['signup','change-password','two-password']){
   await message(diagnostics,{type:'qf.trace_set',enabled:true});await page.goto(`${origin}/${path}`);
   const inputs=page.locator('input');for(let i=0;i<await inputs.count();i++){const input=inputs.nth(i);if(await input.isVisible())await input.fill('Synthetic-only-42!');}
   await page.locator('button[type=submit]').click();await new Promise(r=>setTimeout(r,200));
   assert(!(await trace(diagnostics)).some(e=>e.event==='pending_put_sent'));evidence.cases.push({case:path+' negative',status:'PASS'});
  }
  // Exact repeat stays quiet; a changed password updates the same record.
  await message(diagnostics,{type:'qf.trace_set',enabled:true});await page.goto(`${origin}/native`);
  await page.locator('#username').fill('synthetic-native-0');await page.locator('#password').fill('Synthetic-only-42!');await page.getByRole('button',{name:'Log in',exact:true}).click();
  await new Promise(r=>setTimeout(r,200));assert.equal(await count(options),13);assert(!(await trace(diagnostics)).some(e=>e.event==='banner_shown'));
  await message(diagnostics,{type:'qf.trace_set',enabled:true});await page.goto(`${origin}/native`);
  await page.locator('#username').fill('synthetic-native-0');await page.locator('#password').fill('Synthetic-changed-42!');await page.getByRole('button',{name:'Log in',exact:true}).click();
  await poll(async()=>(await trace(diagnostics)).some(e=>e.event==='banner_shown'));await clickSave(page);
  await poll(async()=>{const res=await message(options,{type:'qf.get_profiles'});return res.profiles.find(p=>p.username==='synthetic-native-0')?.password==='Synthetic-changed-42!';});assert.equal(await count(options),13);
  evidence.cases.push({case:'exact deduplication and same-account password update',status:'PASS'});
  for(const method of ['enter','requestSubmit']){
   await message(diagnostics,{type:'qf.trace_set',enabled:true});await page.goto(`${origin}/constraints`);const before=await count(options);
   await page.locator('#username').fill(`synthetic-${method}@example.test`);await page.locator('#password').fill('Synthetic-only-42!');
   if(method==='enter')await page.locator('#password').press('Enter');else {await page.getByRole('heading',{level:1}).click();await page.getByRole('button',{name:'Call requestSubmit()',exact:true}).click();}
   await poll(async()=>(await trace(diagnostics)).some(e=>e.event==='banner_shown'));await clickSave(page);await poll(async()=>(await count(options))===before+1);
  }
  evidence.cases.push({case:'Enter and native requestSubmit',status:'PASS'});
  for (const label of ['Connexion','ログイン','Iniciar sesión']) {
   await message(diagnostics,{type:'qf.trace_set',enabled:true});await page.goto(`${origin}/spa-localized`);const before=await count(options);
   await page.locator('#login-label').selectOption({label});await page.locator('#username').fill(`synthetic-${label}`);await page.locator('#password').fill('Synthetic-localized-42!');
   await page.getByRole('heading',{level:1}).click();await page.locator('#localized-login').click();
   await poll(async()=>(await trace(diagnostics)).some(e=>e.event==='banner_shown'));await clickSave(page);await poll(async()=>(await count(options))===before+1);
  }
  evidence.cases.push({case:'localized formless login controls',attempts:3,status:'PASS'});
  await message(diagnostics,{type:'qf.trace_set',enabled:true});await page.goto(`${origin}/spa-enter`);const beforeEnter=await count(options);
  await page.locator('#username').fill('synthetic-formless-enter');await page.locator('#password').fill('Synthetic-formless-42!');await page.locator('#password').press('Enter');
  await poll(async()=>(await trace(diagnostics)).some(e=>e.event==='banner_shown'));await clickSave(page);await poll(async()=>(await count(options))===beforeEnter+1);
  evidence.cases.push({case:'semantic formless password Enter',status:'PASS'});
  for (const control of ['subscribe','register','create-account','show-password','cancel','back']) {
   await message(diagnostics,{type:'qf.trace_set',enabled:true});await page.goto(`${origin}/spa-localized`);
   await page.locator('#username').fill('synthetic-negative');await page.locator('#password').fill('Synthetic-negative-42!');await page.getByRole('heading',{level:1}).click();await page.locator(`#${control}`).click();
   await new Promise(resolve=>setTimeout(resolve,100));assert(!(await trace(diagnostics)).some(e=>e.event==='pending_put_sent'));
  }
  evidence.cases.push({case:'localized auxiliary/registration controls do not capture',attempts:6,status:'PASS'});

  await message(diagnostics,{type:'qf.trace_set',enabled:true});await page.goto(`${origin}/constraints`);await page.locator('#username').fill('invalid-email');await page.locator('#password').fill('Synthetic-only-42!');await page.getByRole('heading',{level:1}).click();await page.getByRole('button',{name:'Call requestSubmit()',exact:true}).click();
  await new Promise(r=>setTimeout(r,200));assert(!(await trace(diagnostics)).some(e=>e.event==='pending_put_sent'));evidence.cases.push({case:'invalid native constraints do not capture',status:'PASS'});
  // Two simultaneous operations must remain actionable independently.
  const other=await context.newPage();const beforeTabs=await count(options);await message(diagnostics,{type:'qf.trace_set',enabled:true});
  for(const [target,account] of [[page,'synthetic-tab-a'],[other,'synthetic-tab-b']]){
   await target.goto(`${origin}/native`);await target.locator('#username').fill(account);await target.locator('#password').fill('Synthetic-only-42!');await target.getByRole('button',{name:'Log in',exact:true}).click();
  }
  await poll(async()=>(await trace(diagnostics)).filter(e=>e.event==='banner_shown').length>=2);
  await clickSave(page);await poll(async()=>(await count(options))===beforeTabs+1);
  await clickSave(other);await poll(async()=>(await count(options))===beforeTabs+2);await other.close();evidence.cases.push({case:'two-tab independent save operations',status:'PASS'});
  // Seed a synthetic identity through an authorized management request.
  let profiles=await message(options,{type:'qf.get_profiles'});
  await message(options,{type:'qf.update_profile',generation:profiles.generation,create:true,profile:{id:'synthetic-identity',kind:'identity',label:'Synthetic identity',fields:{email:'synthetic@example.test',tel:'synthetic-phone','street-address':'synthetic-address'},updatedAt:Date.now()}});
  const identityEditor=await context.newPage();await identityEditor.goto(`chrome-extension://${id}/popup.html?editor=identity&id=synthetic-identity`);await identityEditor.locator('#ni-label').waitFor({state:'visible'});await identityEditor.locator('#ni-label').fill('Edited after actual fill');
  await page.goto(`${origin.replace('127.0.0.1','localhost')}/geometry`);await page.bringToFront();await page.locator('#email').click();
  await page.screenshot({path:join(root,'release-evidence/browser-geometry-preview.png')});
  const bounds=await page.locator('#email').boundingBox();await page.mouse.click(bounds.x+80,bounds.y+bounds.height+28);
  await poll(async()=>(await page.locator('#email').inputValue())==='synthetic@example.test');
  assert.equal(await page.locator('#off').inputValue(),'');assert.equal(await page.locator('#tiny').inputValue(),'');assert.equal(await page.locator('#below').inputValue(),'synthetic-phone');assert.equal(await page.locator('#fixed').inputValue(),'synthetic-phone');assert.equal(await page.locator('#clipped-fixed').inputValue(),'');
  evidence.cases.push({case:'real layout excludes offscreen/clipped fields, keeps below-fold and visible fixed overlays',status:'PASS'});
  await identityEditor.locator('#ni-save').click();await identityEditor.getByText('已保存。可以返回管理页面或关闭此标签页。',{exact:true}).waitFor();await identityEditor.close();evidence.cases.push({case:'persistent editor save after real page fill has no false conflict',status:'PASS'});
  const expectedRecordCount=await count(options);
  // Trusted frame master input must never reach the page DOM or its key events.
  const setup=await message(options,{type:'qf.vault_status'});assert.equal(setup.enabled,true,JSON.stringify(setup));const locked=await message(options,{type:'qf.vault_lock'});assert.equal(locked.unlocked,false,JSON.stringify(locked));
  await page.goto(`${origin}/native`);await page.bringToFront();
  await page.evaluate(()=>{window.__parentKeyCount=0;document.addEventListener('keydown',()=>window.__parentKeyCount++);});
  let unlock=await poll(()=>page.frames().find(frame=>frame.url().startsWith(`chrome-extension://${id}/unlock.html?`)));
  await unlock.locator('#password').fill('Wrong-pass');await unlock.getByRole('button',{name:'解锁并继续'}).click();await poll(async()=>await unlock.locator('#status').textContent().then(t=>t?.includes('主密码不正确')));
  await unlock.locator('#password').pressSequentially(password);
  assert.equal(await page.evaluate(()=>window.__parentKeyCount),0);assert.equal(await page.locator('#password').inputValue(),'');
  await page.screenshot({path:join(root,'release-evidence/browser-inline-unlock-preview.png')});
  await unlock.getByRole('button',{name:'解锁并继续'}).click();
  await poll(async()=>(await message(options,{type:'qf.vault_status'})).unlocked);
  assert.equal(await count(options),expectedRecordCount);evidence.cases.push({case:'cross-origin inline unlock and parent key/DOM isolation',status:'PASS'});
  // Close/reopen the isolated browser, not the user's Chrome. Session secrets
  // must be gone while the encrypted synthetic records survive on local disk.
  await context.close();context=null;context=await launch();
  worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  const options2=await context.newPage();await options2.goto(`chrome-extension://${id}/options.html`);
  const status=await message(options2,{type:'qf.vault_status'});assert.equal(status.enabled,true);assert.equal(status.unlocked,false);
  const reopened=await context.newPage();await reopened.goto(`${origin}/native`);await reopened.bringToFront();
  unlock=await poll(()=>reopened.frames().find(frame=>frame.url().startsWith(`chrome-extension://${id}/unlock.html?`)));
  await unlock.locator('#password').fill(password);await unlock.getByRole('button',{name:'解锁并继续'}).click();
  await poll(async()=>(await message(options2,{type:'qf.vault_status'})).unlocked);assert.equal(await count(options2),expectedRecordCount);
  evidence.cases.push({case:'isolated browser restart relocks and offers inline unlock; encrypted records retained',status:'PASS'});
  await worker.evaluate(()=>{globalThis.__qfIdleProbe=true;});await new Promise(r=>setTimeout(r,42000));
  const suspended=await worker.evaluate(()=>globalThis.__qfIdleProbe===undefined);assert.equal(await count(options2),expectedRecordCount);
  evidence.cases.push({case:'requests after 42 seconds idle',status:'PASS',actualSuspensionObserved:suspended});
  // Stop only workers in this disposable browser profile, then verify a real
  // fresh worker can still use the trusted session without data loss.
  const cdp=await context.newCDPSession(options2);
  await cdp.send('ServiceWorker.enable');await cdp.send('ServiceWorker.stopAllWorkers');
  await poll(async()=>{try{return await count(options2)===expectedRecordCount;}catch{return false;}});
  const resumed=await poll(()=>context.serviceWorkers().find(value=>value.url()===worker.url()));
  assert.equal(await resumed.evaluate(()=>globalThis.__qfIdleProbe),undefined);
  assert.equal((await message(options2,{type:'qf.vault_status'})).unlocked,true);
  await cdp.detach();evidence.cases.push({case:'actual worker stop/restart retains trusted unlock and encrypted records',status:'PASS'});

  evidence.status='PASS';
 }catch(error){evidence.status='FAIL';evidence.failure=String(error.message).slice(0,800);
  if(context){try{const diag=context.pages().find(p=>p.url().includes('/diagnostics.html'));if(diag)evidence.failureTrace=await trace(diag);const fixture=context.pages().find(p=>p.url().startsWith(origin));if(fixture){evidence.failureDom=await fixture.evaluate(()=>({lastElement:document.documentElement.lastElementChild?.tagName,bodyChildren:document.body.children.length,headings:Array.from(document.querySelectorAll('h1')).map(e=>e.textContent)}));await fixture.screenshot({path:join(root,'release-evidence/browser-failure-synthetic.png')});}}catch{}}
  throw error;}
 finally{
  if(context)await context.close();await new Promise(resolve=>server.close(resolve));await rm(profile,{recursive:true,force:true});
  await mkdir(join(root,'release-evidence'),{recursive:true});await writeFile(join(root,'release-evidence/browser-e2e.json'),JSON.stringify(evidence,null,2)+'\n');
 }
});
