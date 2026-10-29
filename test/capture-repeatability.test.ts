import {beforeAll,beforeEach,expect,it} from 'vitest';
import {installChromeMock,type Harness} from './helpers/chrome-mock';
import {SaveBanner} from '../src/content/save-banner';
let cap:typeof import('../src/content/capture'),h:Harness;
const drain=async()=>{for(let n=0;n<4;n++)await new Promise(r=>setTimeout(r,0));};
beforeAll(async()=>{h=installChromeMock();cap=await import('../src/content/capture');cap.attachCapture();});
beforeEach(()=>{document.body.innerHTML='';cap._resetForTests();h.store.clear();h.sent.length=0;});
it.each(['native','spa'])('keeps ten distinct %s capture/dismiss operations isolated without losing prompts',async(kind)=>{
 for(let attempt=0;attempt<10;attempt++){
  document.body.innerHTML=kind==='native'?'<form><input autocomplete="username"><input type="password"></form>':'<section role="form"><div><input autocomplete="username"></div><div><input type="password"></div><div><button type="button">Continue</button></div></section>';
  const [account,pw]=Array.from(document.querySelectorAll<HTMLInputElement>('input'));
  account!.value=`synthetic-${attempt}`;pw!.value='Synthetic-only-password';cap.recordPasswordFocus(pw!);cap.trackInput(pw!);
  if(kind==='native')document.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true}));else document.querySelector('button')!.click();
  await drain();expect(SaveBanner.current()?.isShown()).toBe(true);
  await SaveBanner.current()!.dismiss();await drain();expect(SaveBanner.current()).toBeNull();
 }
 const puts=h.sent.filter(m=>m.type==='qf.pending_put');expect(puts).toHaveLength(10);expect(new Set(puts.map(m=>m.id)).size).toBe(10);
});
