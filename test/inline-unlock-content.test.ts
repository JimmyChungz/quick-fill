import {afterEach,beforeEach,expect,it,vi} from 'vitest';
let listeners:any[],requests:Array<(r:any)=>void>,disposers:Array<()=>void>;
const drain=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const id='neilinbkkjgcnflgamepebchiapfcibm';
beforeEach(()=>{
 vi.resetModules();document.body.innerHTML='';listeners=[];requests=[];disposers=[];
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
 vi.stubGlobal('chrome',{runtime:{id,onMessage:{addListener:(fn:any)=>listeners.push(fn),removeListener:()=>{}},sendMessage:(m:any,cb:any)=>{if(m.type==='qf.unlock_prompt')requests.push(cb);}}});
});
it('retries after lock invalidation arrives while the first prompt request is still pending',async()=>{
 const {attachInlineUnlock}=await import('../src/content/inline-unlock');const dispose=attachInlineUnlock(async()=>{});disposers.push(dispose);
 expect(requests).toHaveLength(1);
 listeners[0]({type:'qf.data_changed',locked:true},{id});
 requests[0]!({locked:true,expiresAt:Date.now()+120000,nonce:'first',url:`chrome-extension://${id}/unlock.html?nonce=first`});await drain();
 expect(requests).toHaveLength(2);
 requests[1]!({locked:true,expiresAt:Date.now()+120000,nonce:'second',url:`chrome-extension://${id}/unlock.html?nonce=second`});await drain();
 expect(document.documentElement.lastElementChild?.tagName).toBe('DIV');dispose();
});

afterEach(()=>{for(const dispose of disposers)dispose();vi.useRealTimers();vi.restoreAllMocks();});
it.each(['focus','visible'])('renews an expired connected prompt on %s without a typing-disrupting timer',async trigger=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(1000000);
 const {attachInlineUnlock}=await import('../src/content/inline-unlock');const dispose=attachInlineUnlock(async()=>{});disposers.push(dispose);
 requests[0]!({locked:true,expiresAt:Date.now()+120000,nonce:'first',url:`chrome-extension://${id}/unlock.html?nonce=first`});await drain();
 const original=document.documentElement.lastElementChild!;expect(original.tagName).toBe('DIV');
 vi.setSystemTime(1120001);
 expect(original.isConnected).toBe(true);expect(requests).toHaveLength(1);
 if(trigger==='visible')document.dispatchEvent(new Event('visibilitychange'));
 else {const input=document.createElement('input');document.body.append(input);input.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));}
 expect(original.isConnected).toBe(false);expect(requests).toHaveLength(2);
 requests[1]!({locked:true,expiresAt:Date.now()+120000,nonce:'renewed',url:`chrome-extension://${id}/unlock.html?nonce=renewed`});await drain();
 expect(document.documentElement.lastElementChild?.tagName).toBe('DIV');dispose();
});
it.each([undefined,NaN,Infinity,-1])('does not attach a prompt with invalid expiry %s',async expiresAt=>{
 const {attachInlineUnlock}=await import('../src/content/inline-unlock');const dispose=attachInlineUnlock(async()=>{});disposers.push(dispose);
 requests[0]!({locked:true,expiresAt,nonce:'first',url:`chrome-extension://${id}/unlock.html?nonce=first`});await drain();
 expect(document.documentElement.lastElementChild?.tagName).not.toBe('DIV');dispose();
});
it.each(['lock','dispose'])('does not restore stale focus after %s invalidates unlock completion',async action=>{
 let finish!:()=>void;const refreshed=new Promise<void>(resolve=>{finish=resolve;});
 const {attachInlineUnlock}=await import('../src/content/inline-unlock');const dispose=attachInlineUnlock(()=>refreshed);disposers.push(dispose);
 requests[0]!({locked:true,expiresAt:Date.now()+120000,nonce:'first',url:`chrome-extension://${id}/unlock.html?nonce=first`});await drain();
 const input=document.createElement('input');document.body.append(input);input.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));const focus=vi.spyOn(input,'focus');
 listeners[0]({type:'qf.data_changed',locked:false},{id});
 if(action==='lock')listeners[0]({type:'qf.data_changed',locked:true},{id});else dispose();
 finish();await drain();expect(focus).not.toHaveBeenCalled();dispose();
});
