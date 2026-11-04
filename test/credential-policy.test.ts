import type {LoginProfile} from '../src/lib/types';
import {beforeEach,expect,it,vi} from 'vitest';
import {installChromeMock,loginProfile,STORE_KEY,PAGE_SENDER} from './helpers/chrome-mock';
import {webcrypto} from 'node:crypto';
let h:ReturnType<typeof installChromeMock>,listener:any;
const call=(message:any,sender:any=PAGE_SENDER)=>new Promise<any>(reply=>listener({generation:'0',...message},sender,reply));
const content={id:PAGE_SENDER.id,url:'https://site.example/login',frameId:0,tab:{id:7}};
beforeEach(async()=>{
 vi.resetModules();vi.stubGlobal('crypto',webcrypto);h=installChromeMock();
 Object.assign(chrome.runtime,{onMessage:{addListener(fn:any){listener=fn;}},onInstalled:{addListener(){}}});
 Object.assign(chrome.tabs,{query:async()=>[],sendMessage:async()=>{}});
 await import('../src/background/service-worker');
});
it.each(['update','import','pending'])('fresh install cannot persist login passwords through %s before setup',async route=>{
 const profile=loginProfile({password:'Synthetic-policy-secret'}) as LoginProfile;let message:any;
 if(route==='update')message={type:'qf.update_profile',profile,create:true};
 else if(route==='import')message={type:'qf.import',payload:{version:1,profiles:[profile]}};
 else{await call({type:'qf.capture_begin',id:'synthetic-policy'},content);await call({type:'qf.pending_put',id:'synthetic-policy',candidate:{origin:'https://site.example',username:'synthetic',password:profile.password}},content);message={type:'qf.pending_save',id:'synthetic-policy'};}
 const before=structuredClone(h.store.get(STORE_KEY));const result=await call(message,route==='pending'?content:PAGE_SENDER);
 expect(result).toMatchObject({type:'qf.error',message:expect.stringContaining('加密')});expect(h.store.get(STORE_KEY)).toEqual(before);expect(JSON.stringify(h.store.get(STORE_KEY) ?? null)).not.toContain('Synthetic-policy-secret');
});
it('preserves legacy data for reading and rejects new plaintext credential updates',async()=>{
 const previous={version:1,profiles:[loginProfile()],blacklist:[]};h.store.set(STORE_KEY,previous);
 expect((await call({type:'qf.get_profiles'})).profiles).toEqual(previous.profiles);
 expect(await call({type:'qf.update_profile',profile:loginProfile({password:'Synthetic-changed'})})).toMatchObject({type:'qf.error'});
 expect(h.store.get(STORE_KEY)).toEqual(previous);
});
it('allows identity-only writes without silently setting a master password',async()=>{
 const result=await call({type:'qf.update_profile',create:true,profile:{id:'synthetic-id',kind:'identity',label:'Synthetic',fields:{email:'synthetic@example.test'},updatedAt:1}});
 expect(result.type).toBe('qf.profiles');expect((await call({type:'qf.vault_status'})).enabled).toBe(false);
});
it('explicit eight-character setup enables encrypted credential persistence',async()=>{
 const setup=await call({type:'qf.vault_setup',password:'Synth8!!'});expect(setup.enabled).toBe(true);
 expect((await call({type:'qf.update_profile',generation:setup.generation,profile:loginProfile({password:'Synthetic-policy-secret'}),create:true})).type).toBe('qf.profiles');
 expect(JSON.stringify(h.store.get(STORE_KEY) ?? null)).not.toContain('Synthetic-policy-secret');
});
it.each(['current-password','new-password'])('identity credential field %s is rejected instead of bypassing encryption',async token=>{
 const profile={id:'synthetic-bypass',kind:'identity',label:'Synthetic',fields:{[token]:'Synthetic-bypass-secret'},updatedAt:1};
 expect(await call({type:'qf.import',payload:{version:1,profiles:[profile]}})).toMatchObject({type:'qf.profiles',imported:0,rejected:1});
 expect(JSON.stringify(h.store.get(STORE_KEY) ?? null)).not.toContain('Synthetic-bypass-secret');
 expect(await call({type:'qf.update_profile',profile,create:true})).toMatchObject({type:'qf.error'});
 expect(JSON.stringify(h.store.get(STORE_KEY) ?? null)).not.toContain('Synthetic-bypass-secret');
});
