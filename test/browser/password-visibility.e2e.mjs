import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
const root=resolve(import.meta.dirname,'../..'),id='neilinbkkjgcnflgamepebchiapfcibm',master='Synth8!!';
async function checkEye(page,fieldId,buttonId){
 const input=page.locator(`#${fieldId}`),eye=page.locator(`#${buttonId}`);await input.fill(master);assert.equal(await input.getAttribute('type'),'password');
 const ib=await input.boundingBox(),eb=await eye.boundingBox();assert(ib&&eb&&eb.x>ib.x&&eb.x+eb.width<=ib.x+ib.width+1,'eye is inside right edge of password field');
 await eye.click();assert.equal(await input.getAttribute('type'),'text');assert.equal(await eye.getAttribute('aria-pressed'),'true');
 const revealed=await input.boundingBox();assert(revealed&&Math.abs(revealed.height-ib.height)<1&&Math.abs(revealed.width-ib.width)<1,'revealing must not move or resize the field');
 assert.equal(await eye.locator('.eye-open').isVisible(),true);assert.equal(await eye.locator('.eye-closed').isVisible(),false);
 await input.press('End');await input.press('x');assert.equal(await input.getAttribute('type'),'password');assert.equal(await eye.getAttribute('aria-pressed'),'false');
 assert.equal(await input.inputValue(),master+'x');await input.press('Backspace');assert.equal(await input.inputValue(),master);
 await eye.click();assert.equal(await input.getAttribute('type'),'text');await eye.click();assert.equal(await input.getAttribute('type'),'password');
}
test('temporary password viewing across all unlock surfaces and explicit legacy migration',{timeout:60000},async()=>{
 const profile=await mkdtemp(join(tmpdir(),'qf061-password-ui-'));const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><input autocomplete=username><input type=password>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));let context;
 try{
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,viewport:{width:1000,height:850},args:[`--disable-extensions-except=${join(root,'.build/extension')}`,`--load-extension=${join(root,'.build/extension')}`]});
  if(!context.serviceWorkers()[0])await context.waitForEvent('serviceworker');
  const options=await context.newPage();await options.goto(`chrome-extension://${id}/options.html`);
  // Seed only this disposable test profile to represent an existing legacy user.
  await options.evaluate(()=>chrome.storage.local.set({'qf.stored.v1':{version:1,profiles:[{id:'synthetic-legacy',kind:'login',url:'https://example.test',username:'synthetic',password:'Synthetic-Legacy-Secret',updatedAt:1}],blacklist:[]}}));await options.reload();
  await options.locator('#legacy-vault-warning').waitFor({state:'visible'});assert.match(await options.locator('#legacy-vault-count').textContent(),/1/);
  const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);await popup.locator('#popup-legacy-warning').waitFor({state:'visible'});
  assert.equal(await options.evaluate(async()=> (await chrome.storage.local.get('qf.stored.v1'))['qf.stored.v1'].format),undefined);
  await options.bringToFront();await options.locator('#legacy-vault-migrate').click();assert.equal(await options.locator('#vault-new').evaluate(e=>e===document.activeElement),true);
  await options.locator('#vault-new').fill(master);await options.locator('#vault-confirm').fill(master);await options.locator('#vault-ack').check();options.once('dialog',dialog=>dialog.accept());await options.getByRole('button',{name:'设置主密码并加密现有记录',exact:true}).click();
  await options.getByText('加密迁移完成，请立即导出并妥善保存加密备份。',{exact:true}).waitFor();
  assert.equal(await options.evaluate(async()=>JSON.stringify(await chrome.storage.local.get(null)).includes('Synthetic-Legacy-Secret')),false);
  await options.evaluate(()=>chrome.runtime.sendMessage({type:'qf.vault_lock'}));await options.reload();await options.locator('#vault-password').waitFor({state:'visible'});
  await checkEye(options,'vault-password','vault-password-reveal');await options.screenshot({path:join(root,'release-evidence/management-password-eye.png')});await options.getByRole('button',{name:'解锁15分钟',exact:true}).click();
  await options.getByText('已加密并解锁。此解锁会话最多15分钟；后台休眠不会延长时间。',{exact:true}).waitFor();assert.equal(await options.locator('#vault-password').inputValue(),'');
  await options.evaluate(()=>chrome.runtime.sendMessage({type:'qf.vault_lock'}));await popup.reload();await popup.bringToFront();await popup.locator('#popup-master-password').waitFor({state:'visible'});await checkEye(popup,'popup-master-password','popup-master-reveal');await popup.screenshot({path:join(root,'release-evidence/popup-password-eye.png')});await popup.locator('#popup-unlock').click();await popup.getByText('synthetic',{exact:true}).waitFor();
  assert.equal(await popup.locator('#popup-master-password').inputValue(),'');assert.equal(await popup.locator('#popup-master-password').getAttribute('type'),'password');
  await options.evaluate(()=>chrome.runtime.sendMessage({type:'qf.vault_lock'}));const web=await context.newPage();await web.goto(`http://127.0.0.1:${server.address().port}/`);await web.bringToFront();
  let frame;for(let n=0;n<60;n++){frame=web.frames().find(f=>f.url().startsWith(`chrome-extension://${id}/unlock.html?`));if(frame)break;await new Promise(r=>setTimeout(r,80));}assert(frame,'trusted unlock frame exists');
  await checkEye(frame,'password','password-reveal');await web.screenshot({path:join(root,'release-evidence/inline-password-eye.png')});await frame.locator('#unlock').click();
  for(let n=0;n<60;n++){if((await options.evaluate(()=>chrome.runtime.sendMessage({type:'qf.vault_status'}))).unlocked)break;await new Promise(r=>setTimeout(r,80));}
  const data=await options.evaluate(()=>chrome.runtime.sendMessage({type:'qf.get_profiles'}));assert.equal(data.profiles.length,1);assert.equal(data.profiles[0].password,'Synthetic-Legacy-Secret');
  await mkdir(join(root,'release-evidence'),{recursive:true});await writeFile(join(root,'release-evidence/password-visibility-browser.json'),JSON.stringify({status:'PASS',surfaces:['management unlock','popup unlock','extension-origin inline unlock'],cases:['eye right of field','explicit reveal/open icon','typing remasks/closed icon','repeat click hides','eight-character master works','submit clears/masks','legacy count shown without auto migration','explicit setup encrypts and retains synthetic record'],profile:'isolated synthetic only'},null,2)+'\n');
 }finally{if(context)await context.close();await new Promise(r=>server.close(r));await rm(profile,{recursive:true,force:true});}
});
