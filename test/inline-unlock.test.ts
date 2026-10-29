import {webcrypto} from 'node:crypto';
import {beforeEach,expect,it,vi} from 'vitest';
let local:Record<string,any>,session:Record<string,any>,tabUrl:string;
const id='neilinbkkjgcnflgamepebchiapfcibm',pass='Synthetic8!';
const top=():any=>({id,frameId:0,tab:{id:7},url:'https://example.test/login'});
const frame=(nonce:string):any=>({id,frameId:1,tab:{id:7},origin:`chrome-extension://${id}`,url:`chrome-extension://${id}/unlock.html?nonce=${nonce}`});
beforeEach(async()=>{
 vi.resetModules();vi.stubGlobal('crypto',webcrypto);tabUrl='https://example.test/login';local={};session={};
 const area=(data:Record<string,any>)=>({get:async(k:string)=>({[k]:structuredClone(data[k])}),set:async(v:any)=>{Object.assign(data,structuredClone(v));},remove:async(k:string|string[])=>{for(const key of Array.isArray(k)?k:[k])delete data[key];}});
 vi.stubGlobal('chrome',{runtime:{id,getURL:(path:string)=>`chrome-extension://${id}/${path}`},storage:{local:area(local),session:area(session)},tabs:{get:async()=>({id:7,url:tabUrl})},alarms:{create:async()=>{}}});
 const vault=await import('../src/background/vault');await vault.setupVault(pass);await vault.lockVault();
});
it('only returns an extension frame URL to a locked top-level page, never a master password',async()=>{
 const {handleInlineUnlock}=await import('../src/background/inline-unlock');const result=await handleInlineUnlock({type:'qf.unlock_prompt'},top(),async()=>{}) as any;
 expect(result.expiresAt).toBe(session['qf.inline-unlock.v1']['7'].expiresAt);expect(result.expiresAt).toBeGreaterThan(Date.now());
 expect(result.locked).toBe(true);expect(result.url).toBe(`chrome-extension://${id}/unlock.html?nonce=${result.nonce}`);expect(JSON.stringify(result)).not.toContain(pass);
});
it('unlocks from the scoped extension iframe and consumes every prompt after success',async()=>{
 const {handleInlineUnlock}=await import('../src/background/inline-unlock');const broadcast=vi.fn(async()=>{});
 const prompt=await handleInlineUnlock({type:'qf.unlock_prompt'},top(),broadcast) as any;
 await expect(handleInlineUnlock({type:'qf.inline_unlock_submit',nonce:prompt.nonce,password:pass},frame(prompt.nonce),broadcast)).resolves.toMatchObject({type:'qf.ok'});
 expect(broadcast).toHaveBeenCalledOnce();expect(session['qf.inline-unlock.v1']).toBeUndefined();
 await expect(handleInlineUnlock({type:'qf.unlock_prompt'},top(),broadcast)).resolves.toMatchObject({locked:false});
});
it.each(['webpage','top-extension','other-tab','opaque-origin','wrong-nonce','navigated','expired','generation'])('rejects a %s unlock without unlocking',async(kind)=>{
 const {handleInlineUnlock}=await import('../src/background/inline-unlock');const prompt=await handleInlineUnlock({type:'qf.unlock_prompt'},top(),async()=>{}) as any;
 const sender:any=frame(prompt.nonce);let nonce=prompt.nonce;
 if(kind==='webpage'){sender.url='https://example.test/login';sender.origin='https://example.test';}
 if(kind==='top-extension')sender.frameId=0;if(kind==='other-tab')sender.tab.id=8;if(kind==='opaque-origin')sender.origin='null';
 if(kind==='wrong-nonce')nonce='wrong';if(kind==='navigated')tabUrl='https://other.test/';if(kind==='expired')session['qf.inline-unlock.v1']['7'].expiresAt=0;if(kind==='generation')local['qf.generation']='changed';
 await expect(handleInlineUnlock({type:'qf.inline_unlock_submit',nonce,password:pass},sender,async()=>{})).rejects.toThrow();
 expect((await (await import('../src/background/vault')).vaultStatus()).unlocked).toBe(false);
});
it('keeps wrong passwords local to the frame and bounds retry attempts',async()=>{
 const {handleInlineUnlock}=await import('../src/background/inline-unlock');const prompt=await handleInlineUnlock({type:'qf.unlock_prompt'},top(),async()=>{}) as any;
 for(let i=0;i<5;i++)await expect(handleInlineUnlock({type:'qf.inline_unlock_submit',nonce:prompt.nonce,password:'Wrong-pass'},frame(prompt.nonce),async()=>{})).rejects.toThrow();
 await expect(handleInlineUnlock({type:'qf.inline_unlock_submit',nonce:prompt.nonce,password:pass},frame(prompt.nonce),async()=>{})).rejects.toThrow('尝试次数');
});
