import {beforeEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
let sent:any[],enabled:boolean,unlocked:boolean,fail:boolean,changed:((c:any,a:string)=>void)|undefined;
const drain=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
const field=(id:string,value:string)=>(document.getElementById(id) as HTMLInputElement).value=value;
const submit=async(id:string)=>{document.getElementById(id)!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await drain();};
beforeEach(async()=>{
 vi.resetModules();document.documentElement.innerHTML=readFileSync('public/options.html','utf8');sent=[];enabled=false;unlocked=true;fail=false;
 vi.stubGlobal('confirm',vi.fn(()=>true));
 vi.stubGlobal('chrome',{storage:{onChanged:{addListener:(fn:any)=>{changed=fn;}}},runtime:{sendMessage:(m:any,cb:any)=>{
  sent.push(m);if(m.type==='qf.get_profiles'){queueMicrotask(()=>cb({type:'qf.profiles',profiles:[{id:'synthetic-legacy',kind:'login',url:'https://example.test',username:'synthetic',password:'Synthetic-legacy',updatedAt:1}]}));return;}if(fail&&m.type!=='qf.vault_status'){queueMicrotask(()=>cb({type:'qf.error',message:'synthetic failure'}));return;}
  if(m.type==='qf.vault_setup')enabled=true;if(m.type==='qf.vault_lock')unlocked=false;if(m.type==='qf.vault_unlock')unlocked=true;
  queueMicrotask(()=>cb({type:'qf.vault_status',enabled,unlocked,expiresAt:null}));
 }}});
 (await import('../src/options/vault-controls')).initializeVaultControls();await drain();
});
it('reads status without migrating until explicit matched master password and risk acknowledgment',async()=>{
 expect(sent.map(x=>x.type)).toEqual(['qf.vault_status','qf.get_profiles']);field('vault-new','Synthetic-Master-42!');field('vault-confirm','Synthetic-Master-42!');
 await submit('vault-setup');expect(sent.some(x=>x.type==='qf.vault_setup')).toBe(false);
 field('vault-new','Synthetic-Master-42!');field('vault-confirm','Synthetic-Master-42!');(document.getElementById('vault-ack') as HTMLInputElement).checked=true;
 await submit('vault-setup');expect(sent).toContainEqual(expect.objectContaining({type:'qf.vault_setup',password:'Synthetic-Master-42!'}));
 expect((document.getElementById('vault-new') as HTMLInputElement).value).toBe('');expect(document.body.textContent).not.toContain('Synthetic-Master-42!');
});
it('requires matching new passwords and never replaces data after a cancelled setup',async()=>{
 field('vault-new','Synthetic-Master-42!');field('vault-confirm','different');(document.getElementById('vault-ack') as HTMLInputElement).checked=true;
 await submit('vault-setup');expect(sent.some(x=>x.type==='qf.vault_setup')).toBe(false);
 field('vault-new','Synthetic-Master-42!');field('vault-confirm','Synthetic-Master-42!');vi.mocked(confirm).mockReturnValue(false);
 await submit('vault-setup');expect(sent.some(x=>x.type==='qf.vault_setup')).toBe(false);
});
it('reports a failed unlock without retaining the entered master password',async()=>{
 enabled=true;unlocked=false;fail=true;field('vault-password','Synthetic-Master-42!');await submit('vault-unlock');
 expect(document.getElementById('vault-error')!.textContent).toContain('synthetic failure');expect((document.getElementById('vault-password') as HTMLInputElement).value).toBe('');
});

it('clears typed master passwords and refreshes lock state on a generation change',async()=>{
 enabled=true;unlocked=true;document.getElementById('vault-refresh')!.click();await drain();
 field('vault-change-old','Synthetic-Master-42!');field('vault-change-new','Synthetic-New-Master!');
 unlocked=false;changed!({'qf.generation':{newValue:'new'}},'local');await drain();
 expect((document.getElementById('vault-change-old') as HTMLInputElement).value).toBe('');
 expect((document.getElementById('vault-change-new') as HTMLInputElement).value).toBe('');
 expect(document.getElementById('vault-unlock')!.hidden).toBe(false);
 expect(document.getElementById('vault-status')!.textContent).toContain('已加密并锁定');
});
it('masks the management unlock input before typing and clears it even if it was revealed',async()=>{
 enabled=true;unlocked=false;document.getElementById('vault-refresh')!.click();await drain();field('vault-password','Synthetic8!');const input=document.getElementById('vault-password') as HTMLInputElement;const eye=document.getElementById('vault-password-reveal')!;
 eye.click();expect(input.type).toBe('text');input.dispatchEvent(new Event('input'));expect(input.type).toBe('password');eye.click();await submit('vault-unlock');expect(input.value).toBe('');expect(input.type).toBe('password');
});
it('shows legacy password count and focuses explicit setup without migrating automatically',async()=>{
 expect(document.getElementById('legacy-vault-warning')!.hidden).toBe(false);
 expect(document.getElementById('legacy-vault-count')!.textContent).toContain('1');
 document.getElementById('legacy-vault-migrate')!.click();expect(document.activeElement?.id).toBe('vault-new');expect(sent.some(x=>x.type==='qf.vault_setup')).toBe(false);
});
