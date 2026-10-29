import {readFileSync} from 'node:fs';
import {beforeEach,expect,it,vi} from 'vitest';
const nonce='synthetic-nonce';let sent:any[],posted:any[];
const drain=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
beforeEach(async()=>{
 vi.resetModules();history.replaceState({},'',`/unlock.html?nonce=${nonce}`);document.documentElement.innerHTML=readFileSync('public/unlock.html','utf8');sent=[];posted=[];
 vi.spyOn(window,'postMessage').mockImplementation((data:any)=>{posted.push(data);});
 vi.stubGlobal('chrome',{runtime:{sendMessage:(m:any,cb:any)=>{sent.push(m);queueMicrotask(()=>cb(m.type==='qf.inline_unlock_status'?{locked:true}:{type:'qf.ok'}));}}});
 await import('../src/unlock/unlock');await drain();
});
it('sends the master password only to the worker, clears it and posts only nonce/result to the parent',async()=>{
 const input=document.getElementById('password') as HTMLInputElement;input.value='Synthetic8!';
 document.getElementById('unlock-form')!.dispatchEvent(new Event('submit',{cancelable:true}));await drain();
 expect(sent).toContainEqual(expect.objectContaining({type:'qf.inline_unlock_submit',password:'Synthetic8!',nonce}));
 expect(input.value).toBe('');expect(posted).toEqual([{type:'qf.inline_unlock_done',nonce,result:'unlocked'}]);expect(JSON.stringify(posted)).not.toContain('Synthetic8!');
});
it('reveals only on eye click, remasks before continued typing and after submit',async()=>{
 const input=document.getElementById('password') as HTMLInputElement;const eye=document.getElementById('password-reveal') as HTMLButtonElement;
 input.value='Synthetic8!';eye.click();expect(input.type).toBe('text');input.dispatchEvent(new InputEvent('beforeinput',{data:'x',inputType:'insertText'}));expect(input.type).toBe('password');
 eye.click();document.getElementById('unlock-form')!.dispatchEvent(new Event('submit',{cancelable:true}));await drain();expect(input.type).toBe('password');expect(eye.getAttribute('aria-pressed')).toBe('false');expect(input.value).toBe('');
});
