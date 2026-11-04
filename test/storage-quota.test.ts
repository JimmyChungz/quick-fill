import {webcrypto} from 'node:crypto';
import {beforeEach, expect, it, vi} from 'vitest';

const KEY='qf.stored.v1', CORRUPT='qf.vault.corrupt-backup.v1';
const fixture={version:1,profiles:[{id:'synthetic',kind:'login',url:'https://example.test',username:'synthetic-user',password:'synthetic-password',updatedAt:1}],blacklist:[]};
let local:Record<string,unknown>, session:Record<string,unknown>;
// Chrome counts serialized values and key names. The production estimator is
// deliberately separate and adds conservative overhead plus reserve capacity.
const bytes=(data:Record<string,unknown>)=>Object.entries(data).reduce((sum,[key,value])=>sum+Buffer.byteLength(key)+Buffer.byteLength(JSON.stringify(value)),0);
beforeEach(()=>{
 vi.resetModules();vi.stubGlobal('crypto',webcrypto);local={[KEY]:structuredClone(fixture),'qf.generation':'synthetic-generation'};session={'qf.pending.v2':{id:'synthetic-pending'}};
 const area=(data:Record<string,unknown>)=>({
  get:async(keys:string|string[]|null)=>structuredClone(keys===null?data:Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in data).map(k=>[k,data[k]]))),
  set:async(updates:Record<string,unknown>)=>{Object.assign(data,structuredClone(updates));},
  remove:async(keys:string|string[])=>{for(const key of Array.isArray(keys)?keys:[keys])delete data[key];},
 });
 vi.stubGlobal('chrome',{storage:{local:{...area(local),QUOTA_BYTES:10*1024*1024,getBytesInUse:async(keys:string|string[]|null)=>bytes(keys===null?local:Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in local).map(k=>[k,local[k]])))},session:area(session)},alarms:{create:async()=>{}}});
});

it('rejects an oversized plaintext import without changing existing local or session data',async()=>{
 const storage=await import('../src/lib/storage');
 const before=structuredClone({local,session});
 // Under the record limit and each field limit, but over the platform byte limit.
 const records=Array.from({length:50},(_,i)=>({...fixture.profiles[0],id:`large-${i}`,password:'密'.repeat(60000)}));
 await expect(storage.importProfiles(records)).rejects.toThrow('密码库容量不足');
 expect({local,session}).toEqual(before);
});

it('preflights the final migration before writing its recovery copy',async()=>{
 const vault=await import('../src/background/vault');
 local['synthetic.other']='x'.repeat(8*1024*1024-900);
 const before=structuredClone({local,session});
 await expect(vault.setupVault('Synthetic-Master-42!')).rejects.toThrow('密码库容量不足');
 expect({local,session}).toEqual(before);
});

it('includes the old primary at the backup-write peak even when the final store would fit',async()=>{
 const vault=await import('../src/background/vault');
 // Valid legacy records may contain unknown metadata; migration canonicalizes
 // it away, but the old primary still occupies disk until the final write.
 local[KEY]={...fixture,syntheticPadding:'x'.repeat(8*1024*1024-500)};
 const before=structuredClone({local,session});
 await expect(vault.setupVault('Synthetic-Master-42!')).rejects.toThrow('密码库容量不足');
 expect({local,session}).toEqual(before);
});

it('preserves unlock, generation and backups when password change exceeds available capacity',async()=>{
 const vault=await import('../src/background/vault');
 await vault.setupVault('Synthetic-Master-42!');
 local['synthetic.other']='x'.repeat(9*1024*1024);
 const before=structuredClone({local,session});
 await expect(vault.changeVaultPassword('Synthetic-Master-42!','Synthetic-New-Master-42!')).rejects.toThrow('密码库容量不足');
 expect({local,session}).toEqual(before);
});

it('preflights corrupt-primary forensic preservation together with recovery and primary writes',async()=>{
 const vault=await import('../src/background/vault');
 await vault.setupVault('Synthetic-Master-42!');const backup=await vault.exportVault();
 local[KEY]={broken:'x'.repeat(4*1024*1024)};
 local[CORRUPT]={existing:'synthetic-forensic-copy'};
 const before=structuredClone({local,session});
 await expect(vault.restoreVault(backup,'Synthetic-Master-42!')).rejects.toThrow('密码库容量不足');
 expect({local,session}).toEqual(before);
});

it('rejects an encrypted repository write without replacing current data or its unlock state',async()=>{
 const vault=await import('../src/background/vault'), storage=await import('../src/lib/storage');
 await vault.setupVault('Synthetic-Master-42!');local['synthetic.other']='x'.repeat(9*1024*1024);
 const before=structuredClone({local,session});
 await expect(storage.upsertProfile({...fixture.profiles[0]!,password:'synthetic-new-password'} as any)).rejects.toThrow('密码库容量不足');
 expect({local,session}).toEqual(before);
});


it('accounts for UTF-8 bytes and leaves twenty percent of the advertised quota unused',async()=>{
 const {ensureLocalCapacity}=await import('../src/lib/storage-quota');
 (chrome.storage.local as any).QUOTA_BYTES=1000;
 for(const key of Object.keys(local))delete local[key];
 // The UTF-8 value exceeds 800 bytes despite having only 270 characters.
 await expect(ensureLocalCapacity({synthetic:'密'.repeat(270)})).rejects.toThrow('密码库容量不足');
 await expect(ensureLocalCapacity({synthetic:'x'.repeat(700)})).resolves.toBeUndefined();
 expect(local).toEqual({});
});

it('subtracts the old values of replacements while still including unrelated local keys',async()=>{
 const {ensureLocalCapacity}=await import('../src/lib/storage-quota');
 local.syntheticOld='x'.repeat(9*1024*1024);
 await expect(ensureLocalCapacity({syntheticOld:'small'})).resolves.toBeUndefined();
 local.syntheticOther='x'.repeat(9*1024*1024);
 await expect(ensureLocalCapacity({syntheticOld:'small'})).rejects.toThrow('密码库容量不足');
});

it('uses the ten MiB default and all stored data when byte accounting is unavailable',async()=>{
 const {ensureLocalCapacity}=await import('../src/lib/storage-quota');
 delete (chrome.storage.local as any).getBytesInUse;
 delete (chrome.storage.local as any).QUOTA_BYTES;
 local.syntheticOther='x'.repeat(9*1024*1024);
 const before=structuredClone(local);
 await expect(ensureLocalCapacity({synthetic:'small'})).rejects.toThrow('密码库容量不足');
 expect(local).toEqual(before);
});
