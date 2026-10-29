import {expect,it,vi} from 'vitest';
import {installChromeMock,loginProfile,STORE_KEY} from './helpers/chrome-mock';
it('shows matching suggestions when initial metadata arrives after the first real focus',async()=>{
 vi.resetModules();const h=installChromeMock({[STORE_KEY]:{version:1,profiles:[loginProfile({url:location.origin})],blacklist:[]}});
 document.body.innerHTML='<form><input name=username><input type=password></form>';
 const original=chrome.runtime.sendMessage;let release:(()=>void)|undefined;
 vi.spyOn(chrome.runtime,'sendMessage').mockImplementation(((msg:any,cb:any)=>{
  if(msg.type==='qf.content_profiles')return (original as any)(msg,(response:any)=>{release=()=>cb(response);});
  return (original as any)(msg,cb);
 })as any);
 await import('../src/content/index');
 const {Suggest}=await import('../src/content/suggest');const input=document.querySelector<HTMLInputElement>('input')!;input.focus();
 expect(Suggest.current()?.isShown()??false).toBe(false);expect(release).toBeTypeOf('function');release!();
 await new Promise(resolve=>setTimeout(resolve,0));
 expect(Suggest.current()?.isShown()).toBe(true);
 h.deliver({type:'qf.data_changed',generation:'locked',locked:true});
 vi.restoreAllMocks();
});
