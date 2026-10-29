import {beforeEach,expect,it,vi} from 'vitest';
let local:Record<string,any>,session:Record<string,any>,stopped:boolean,failEmptyPrimary:boolean;
beforeEach(()=>{
 vi.resetModules();stopped=false;failEmptyPrimary=false;local={'qf.stored.v1':{version:1,profiles:[{id:'synthetic',kind:'login',url:'https://example.test',username:'synthetic',password:'synthetic-secret',updatedAt:1}],blacklist:[]},'qf.vault.backup.v1':{format:'qf-vault',cipher:'synthetic opaque backup'},'qf.vault.corrupt-backup.v1':{format:'qf-vault',cipher:'synthetic opaque forensic'}};session={'qf.pending.v2':{old:'candidate'},'qf.capture-permits':{old:'permit'},'qf.receipts':{old:'receipt'}};
 const area=(data:Record<string,any>)=>({get:async(k:string)=>{if(stopped)throw Error('worker stopped');return {[k]:structuredClone(data[k])};},set:async(o:any)=>{if(stopped)throw Error('worker stopped');if(data===local&&o['qf.stored.v1']?.profiles.length===0&&failEmptyPrimary)throw Error('final empty-primary commit failed');Object.assign(data,structuredClone(o));if(data===local&&o['qf.stored.v1']?.profiles.length===0)stopped=true;},remove:async(keys:string|string[])=>{if(stopped)throw Error('worker stopped');for(const key of Array.isArray(keys)?keys:[keys])delete data[key];}});
 vi.stubGlobal('chrome',{storage:{local:area(local),session:area(session)}});
});
it('a worker stopping immediately after empty-primary commit cannot leave old recovery copies or pending secrets',async()=>{
 const storage=await import('../src/lib/storage');try{await storage.clearAll();}catch{}
 expect(local['qf.stored.v1'].profiles).toEqual([]);
 expect(local['qf.vault.backup.v1']).toBeUndefined();expect(local['qf.vault.corrupt-backup.v1']).toBeUndefined();
 expect(session['qf.pending.v2']).toBeUndefined();expect(session['qf.capture-permits']).toBeUndefined();expect(session['qf.receipts']).toBeUndefined();
 expect(typeof local['qf.generation']).toBe('string');
 stopped=false;vi.resetModules();expect((await (await import('../src/lib/storage')).getStored()).profiles).toEqual([]);
});
it('a failed final empty-primary commit keeps the old primary and can be retried',async()=>{
 failEmptyPrimary=true;
 const storage=await import('../src/lib/storage');
 await expect(storage.clearAll()).rejects.toThrow('final empty-primary commit failed');
 expect(local['qf.stored.v1'].profiles).toHaveLength(1);
 expect(local['qf.vault.backup.v1']).toBeUndefined();expect(local['qf.vault.corrupt-backup.v1']).toBeUndefined();
 expect(session['qf.pending.v2']).toBeUndefined();expect(session['qf.capture-permits']).toBeUndefined();expect(session['qf.receipts']).toBeUndefined();
 expect(typeof local['qf.generation']).toBe('string');
 failEmptyPrimary=false;
 await storage.clearAll();
 expect(local['qf.stored.v1'].profiles).toEqual([]);
 stopped=false;vi.resetModules();expect((await (await import('../src/lib/storage')).getStored()).profiles).toEqual([]);
});
