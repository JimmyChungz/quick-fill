import {webcrypto} from 'node:crypto';
import {beforeAll,beforeEach,expect,it,vi} from 'vitest';
import type {VaultEnvelope} from '../src/lib/vault-crypto';

const KEY='qf.stored.v1',BACKUP='qf.vault.backup.v1',GENERATION='qf.generation',UNLOCK='qf.vault.unlock.v1';
const OLD_PASSWORD='Synthetic-Old-Master!',NEW_PASSWORD='Synthetic-New-Master!';
const original={version:1,profiles:[{id:'synthetic-old',kind:'login',url:'https://example.test',username:'synthetic-user',password:'synthetic-old-secret',updatedAt:1}],blacklist:[]};
const restored={...original,profiles:[{...original.profiles[0]!,id:'synthetic-restored',password:'synthetic-restored-secret'}]};
let oldVault:Awaited<ReturnType<typeof import('../src/lib/vault-crypto').createVault>>;
let external:typeof oldVault;
let local:Record<string,unknown>,session:Record<string,unknown>,stopAfter:string|undefined,dead:boolean,committed:boolean;

beforeAll(async()=>{
 vi.stubGlobal('crypto',webcrypto);
 const {createVault}=await import('../src/lib/vault-crypto');
 oldVault=await createVault(original,OLD_PASSWORD);external=await createVault(restored,NEW_PASSWORD);
});
beforeEach(()=>{
 vi.resetModules();vi.stubGlobal('crypto',webcrypto);
 local={};session={};dead=false;committed=false;stopAfter=undefined;
 const checkAlive=()=>{if(dead)throw Error('synthetic worker terminated');};
 // A boundary applies the storage operation, then kills the old context. All
 // later API calls fail too, including catch/finally cleanup, so execution
 // cannot accidentally repair the simulated crash before module reimport.
 const boundary=(name:string)=>{if(stopAfter===name){dead=true;throw Error('synthetic worker terminated');}};
 const area=(data:Record<string,unknown>,name:string)=>({
  get:async(keys:string|string[]|null)=>{
   checkAlive();const result=structuredClone(keys===null?data:Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in data).map(k=>[k,data[k]])));
   if(name==='local'&&keys===BACKUP)boundary('backup-readback');
   if(name==='local'&&keys===KEY&&committed)boundary('primary-readback');
   return result;
  },
  set:async(updates:Record<string,unknown>)=>{
   checkAlive();Object.assign(data,structuredClone(updates));
   if(name==='local'&&KEY in updates){committed=true;boundary('primary-write-with-generation');}
   if(name==='local'&&BACKUP in updates)boundary('backup-write');
   if(name==='session'&&UNLOCK in updates)boundary('unlock-write');
  },
  remove:async(keys:string|string[])=>{
   checkAlive();for(const key of Array.isArray(keys)?keys:[keys])delete data[key];
   if(name==='session')boundary('pending-remove');
  },
 });
 vi.stubGlobal('chrome',{storage:{local:area(local,'local'),session:area(session,'session')},alarms:{create:async()=>{checkAlive();boundary('expiry-alarm');}}});
});

const boundaries=['backup-write','backup-readback','primary-write-with-generation','primary-readback','pending-remove','expiry-alarm','unlock-write'] as const;
const operations=['setup','restore','change-password'] as const;
for(const operation of operations){
 it.each(boundaries)(`${operation}: restart after %s retains decryptable data and coherent generation`,async(boundary)=>{
  local[KEY]=operation==='setup'?structuredClone(original):structuredClone(oldVault.envelope);
  local[GENERATION]='synthetic-before';
  if(operation!=='setup'){
   local[BACKUP]=structuredClone(oldVault.envelope);
   session[UNLOCK]={salt:oldVault.envelope.kdf.salt,material:oldVault.material,expiresAt:Date.now()+15*60*1000};
  }
  session['qf.pending.v2']={synthetic:{generation:'synthetic-before',password:'synthetic-pending-secret'}};
  const before=structuredClone(local[KEY]);
  const vault=await import('../src/background/vault');
  stopAfter=boundary;
  const installing=operation==='setup'?vault.setupVault(NEW_PASSWORD)
   :operation==='restore'?vault.restoreVault(external.envelope,NEW_PASSWORD)
   :vault.changeVaultPassword(OLD_PASSWORD,NEW_PASSWORD);
  await expect(installing).rejects.toThrow('synthetic worker terminated');
  expect(dead).toBe(true);
  if(committed)expect(local[GENERATION]).not.toBe('synthetic-before');
  else{expect(local[KEY]).toEqual(before);expect(local[GENERATION]).toBe('synthetic-before');}
  const wasCommitted=committed;
  // Reimport discards all module globals/queues. Storage session deliberately
  // survives a worker restart, as in Chrome; no test cleanup repairs the disk.
  vi.resetModules();dead=false;stopAfter=undefined;
  const fresh=await import('../src/background/vault');
  const {decryptVault,deriveVaultKey}=await import('../src/lib/vault-crypto');
  const backup=local[BACKUP] as VaultEnvelope;
  const backupPassword=operation==='restore'?OLD_PASSWORD:NEW_PASSWORD;
  expect(await decryptVault(backup,await deriveVaultKey(backupPassword,backup.kdf.salt))).toEqual(original);
  if(operation==='setup'&&!wasCommitted)expect(await fresh.readVaultData()).toEqual(original);
  else{
   await fresh.unlockVault(wasCommitted?NEW_PASSWORD:OLD_PASSWORD);
   expect(await fresh.readVaultData()).toEqual(operation==='restore'&&wasCommitted?restored:original);
   const disk=JSON.stringify(local);
   expect(disk).not.toContain('synthetic-old-secret');expect(disk).not.toContain('synthetic-restored-secret');expect(disk).not.toContain('material');
  }
  // Retrying an interrupted restore commits exactly the imported ID once.
  if(operation==='restore'){
   await fresh.restoreVault(external.envelope,NEW_PASSWORD);
   expect(await fresh.readVaultData()).toEqual(restored);
   expect((await fresh.readVaultData() as typeof restored).profiles.map(p=>p.id)).toEqual(['synthetic-restored']);
  }
 });
}

it('a rejected backup write leaves both the old primary and healthy recovery unchanged',async()=>{
 local[KEY]=structuredClone(oldVault.envelope);local[BACKUP]=structuredClone(oldVault.envelope);local[GENERATION]='synthetic-before';
 const before=structuredClone(local);
 const set=chrome.storage.local.set.bind(chrome.storage.local);
 chrome.storage.local.set=async(updates)=>{if(BACKUP in updates)throw Error('synthetic rejected backup');return set(updates);};
 const vault=await import('../src/background/vault');
 await expect(vault.restoreVault(external.envelope,NEW_PASSWORD)).rejects.toThrow('synthetic rejected backup');
 vi.resetModules();expect(local).toEqual(before);
 const fresh=await import('../src/background/vault');await fresh.unlockVault(OLD_PASSWORD);expect(await fresh.readVaultData()).toEqual(original);
});

it('interrupted restore of a tag-tampered primary retains healthy recovery and encrypted forensic bytes',async()=>{
 const tampered=structuredClone(oldVault.envelope);
 tampered.cipher.data=(tampered.cipher.data[0]==='A'?'B':'A')+tampered.cipher.data.slice(1);
 local[KEY]=tampered;local[BACKUP]=structuredClone(oldVault.envelope);local[GENERATION]='synthetic-before';
 session[UNLOCK]={salt:oldVault.envelope.kdf.salt,material:oldVault.material,expiresAt:Date.now()+15*60*1000};
 const vault=await import('../src/background/vault');stopAfter='backup-write';
 await expect(vault.restoreVault(external.envelope,NEW_PASSWORD)).rejects.toThrow('synthetic worker terminated');
 vi.resetModules();dead=false;stopAfter=undefined;
 const {decryptVault}=await import('../src/lib/vault-crypto');
 expect(local[KEY]).toEqual(tampered);expect(local[GENERATION]).toBe('synthetic-before');
 expect(await decryptVault(local[BACKUP],oldVault.key)).toEqual(original);
 expect(await decryptVault(local['qf.vault.corrupt-backup.v1'],external.key)).toEqual(tampered);
 const fresh=await import('../src/background/vault');await fresh.restoreVault(external.envelope,NEW_PASSWORD);
 expect(await fresh.readVaultData()).toEqual(restored);
 expect(Object.keys(local).filter(k=>k.includes('backup'))).toHaveLength(2);
});
