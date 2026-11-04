import {webcrypto} from 'node:crypto';
import {beforeEach, expect, it, vi} from 'vitest';
let local:Record<string,unknown>, session:Record<string,unknown>, failDataWrite:boolean;
const KEY='qf.stored.v1';
const fixture={version:1,profiles:[{id:'synthetic',kind:'login',url:'https://example.test',username:'synthetic-user',password:'synthetic-password',updatedAt:1}],blacklist:[]};
beforeEach(()=>{
 vi.resetModules();vi.stubGlobal('crypto',webcrypto);local={[KEY]:structuredClone(fixture)};session={};failDataWrite=false;
 const area=(data:Record<string,unknown>)=>({get:async(k:string)=>({[k]:structuredClone(data[k])}),set:async(o:Record<string,unknown>)=>{if(data===local&&KEY in o&&failDataWrite)throw Error('synthetic write failure');Object.assign(data,structuredClone(o));},remove:async(keys:string|string[])=>{for(const k of Array.isArray(keys)?keys:[keys])delete data[k];}});
 vi.stubGlobal('chrome',{storage:{local:area(local),session:area(session)},alarms:{create:async()=>{}}});
});
it('migrates only on explicit setup, keeps logical v1, and persists no readable credential/master key',async()=>{
 const vault=await import('../src/background/vault');const storage=await import('../src/lib/storage');
 expect(await storage.getStored()).toEqual(fixture);
 await vault.setupVault('Synthetic-Master-42!');
 const disk=JSON.stringify(local);expect(disk).not.toContain('synthetic-password');expect(disk).not.toContain('Synthetic-Master');expect(disk).not.toContain('material');
 expect(await storage.getStored()).toEqual(fixture);expect((local[KEY] as any).format).toBe('qf-vault');
 expect(local['qf.vault.backup.v1']).toBeDefined();
 await storage.upsertProfile({...fixture.profiles[0]!,password:'synthetic-changed'} as any);
 expect(JSON.stringify(local)).not.toContain('synthetic-changed');
 expect((await storage.getStored()).profiles[0]).toMatchObject({password:'synthetic-changed'});
});
it('locks, rejects wrong password without writes, and unlocks with the right password',async()=>{
 const vault=await import('../src/background/vault');const storage=await import('../src/lib/storage');
 await vault.setupVault('Synthetic-Master-42!');await vault.lockVault();const before=JSON.stringify(local);
 await expect(storage.getStored()).rejects.toThrow();
 await expect(vault.unlockVault('Wrong-Master-42!')).rejects.toThrow();expect(JSON.stringify(local)).toBe(before);
 await vault.unlockVault('Synthetic-Master-42!');expect(await storage.getStored()).toEqual(fixture);
});
it('keeps original plaintext data intact when the final migration write fails',async()=>{
 const vault=await import('../src/background/vault');failDataWrite=true;
 await expect(vault.setupVault('Synthetic-Master-42!')).rejects.toThrow();expect(local[KEY]).toEqual(fixture);
});
it('changes master password and restores authenticated encrypted backup',async()=>{
 const vault=await import('../src/background/vault');const storage=await import('../src/lib/storage');
 await vault.setupVault('Synthetic-Master-42!');const backup=await vault.exportVault();
 await vault.changeVaultPassword('Synthetic-Master-42!','Synthetic-New-Master!');await vault.lockVault();
 await expect(vault.unlockVault('Synthetic-Master-42!')).rejects.toThrow();await vault.unlockVault('Synthetic-New-Master!');
 await vault.restoreVault(backup,'Synthetic-Master-42!');expect(await storage.getStored()).toEqual(fixture);
}, 15000); // Multiple production-cost PBKDF2 derivations run under full-suite contention.
it('never turns clear-all into an unencrypted store',async()=>{
 const vault=await import('../src/background/vault');const storage=await import('../src/lib/storage');
 await vault.setupVault('Synthetic-Master-42!');await storage.clearAll();
 expect((local[KEY] as any).format).toBe('qf-vault');expect((await storage.getStored()).profiles).toEqual([]);
});
it('expires the memory-only session and rejects malformed ciphertext without resetting records',async()=>{
 const vault=await import('../src/background/vault');const storage=await import('../src/lib/storage');
 await vault.setupVault('Synthetic-Master-42!');const now=Date.now();const clock=vi.spyOn(Date,'now').mockReturnValue(now+16*60*1000);
 await expect(storage.getStored()).rejects.toThrow();expect((await vault.vaultStatus()).unlocked).toBe(false);clock.mockRestore();
 const bad=structuredClone(local[KEY]) as any;bad.cipher.data='invalid';local[KEY]=bad;
 await expect(vault.unlockVault('Synthetic-Master-42!')).rejects.toThrow();expect(local[KEY]).toEqual(bad);
});
it('restores a valid encrypted backup even when the current encrypted or legacy store is corrupt',async()=>{
 const vault=await import('../src/background/vault');const storage=await import('../src/lib/storage');
 await vault.setupVault('Synthetic-Master-42!');const backup=await vault.exportVault();
 local[KEY]={format:'qf-vault',version:1,cipher:{data:'invalid'}};
 await vault.restoreVault(backup,'Synthetic-Master-42!');expect(await storage.getStored()).toEqual(fixture);
 local[KEY]={version:99,broken:'synthetic-sensitive-original'};
 await vault.restoreVault(backup,'Synthetic-Master-42!');expect(await storage.getStored()).toEqual(fixture);
 expect(JSON.stringify(local)).not.toContain('synthetic-sensitive-original');
});
it('does not leave an unlock secret active when expiry-alarm scheduling fails',async()=>{
 const vault=await import('../src/background/vault');await vault.setupVault('Synthetic-Master-42!');await vault.lockVault();
 (chrome.alarms as any).create=async()=>{throw Error('synthetic alarm failure');};
 await expect(vault.unlockVault('Synthetic-Master-42!')).rejects.toThrow();expect((await vault.vaultStatus()).unlocked).toBe(false);
});
it('exports the authenticated private recovery copy when the primary is malformed',async()=>{
 const vault=await import('../src/background/vault');await vault.setupVault('Synthetic-Master-42!');const expected=await vault.exportVault();
 local[KEY]={format:'qf-vault',broken:true};await expect(vault.exportVault()).rejects.toThrow();expect(await vault.exportVault(true)).toEqual(expected);
});
it('accepts Chrome-style reordered object keys during encrypted backup and primary readback',async()=>{
 const original=chrome.storage.local.get;
 const reorder=(v:any):any=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,reorder(v[k])])):v;
 (chrome.storage.local as any).get=async(k:any)=>reorder(await (original as any)(k));
 const vault=await import('../src/background/vault');const storage=await import('../src/lib/storage');
 await vault.setupVault('Synthetic-Master-42!');expect(await storage.getStored()).toEqual(fixture);
 await vault.changeVaultPassword('Synthetic-Master-42!','Synthetic-New-Master!');expect(await storage.getStored()).toEqual(fixture);
});
it('removes both private recovery copies on clear-all while retaining encrypted empty primary',async()=>{
 const vault=await import('../src/background/vault');const storage=await import('../src/lib/storage');
 await vault.setupVault('Synthetic-Master-42!');local['qf.vault.corrupt-backup.v1']=await vault.exportVault();
 await storage.clearAll();expect(local['qf.vault.backup.v1']).toBeUndefined();expect(local['qf.vault.corrupt-backup.v1']).toBeUndefined();
 expect((local[KEY] as any).format).toBe('qf-vault');expect((await storage.getStored()).profiles).toEqual([]);
});

it('restore preserves healthy recovery when current primary has valid structure but fails authentication',async()=>{
 const vault=await import('../src/background/vault');
 const {createVault,decryptVault,isVaultEnvelope}=await import('../src/lib/vault-crypto');
 await vault.setupVault('Synthetic-Master-42!');const healthy=await vault.exportVault(true);
 const tampered=structuredClone(await vault.exportVault());
 tampered.cipher.data=(tampered.cipher.data[0]==='A'?'B':'A')+tampered.cipher.data.slice(1);
 expect(isVaultEnvelope(tampered)).toBe(true);local[KEY]=tampered;
 const external=await createVault({...fixture,profiles:[]},'Synthetic-External-42!');
 await vault.restoreVault(external.envelope,'Synthetic-External-42!');
 expect(await vault.exportVault(true)).toEqual(healthy);
 expect(await vault.readVaultData()).toEqual({...fixture,profiles:[]});
 expect(await decryptVault(local['qf.vault.corrupt-backup.v1'],external.key)).toEqual(tampered);
});
it('preserves a locked previous primary under a different password as encrypted forensic data',async()=>{
 const vault=await import('../src/background/vault');const {createVault,decryptVault}=await import('../src/lib/vault-crypto');
 await vault.setupVault('Synthetic-Master-42!');const primary=await vault.exportVault(),healthy=await vault.exportVault(true);await vault.lockVault();
 const external=await createVault({...fixture,profiles:[]},'Synthetic-External-42!');
 await vault.restoreVault(external.envelope,'Synthetic-External-42!');
 expect(await vault.exportVault(true)).toEqual(healthy);
 expect(await decryptVault(local['qf.vault.corrupt-backup.v1'],external.key)).toEqual(primary);
 expect(Object.keys(local).filter(k=>k.includes('backup'))).toHaveLength(2);
});
it('promotes authenticated previous primary using the live trusted session',async()=>{
 const vault=await import('../src/background/vault');const storage=await import('../src/lib/storage');const {createVault}=await import('../src/lib/vault-crypto');
 await vault.setupVault('Synthetic-Master-42!');
 await storage.upsertProfile({...fixture.profiles[0]!,password:'synthetic-current-password'} as any);const primary=await vault.exportVault();
 const external=await createVault({...fixture,profiles:[]},'Synthetic-External-42!');
 await vault.restoreVault(external.envelope,'Synthetic-External-42!');
 expect(await vault.exportVault(true)).toEqual(primary);expect(local['qf.vault.corrupt-backup.v1']).toBeUndefined();
});
it('authenticates a locked previous primary with the restored envelope key when salt matches',async()=>{
 const vault=await import('../src/background/vault');const storage=await import('../src/lib/storage');
 await vault.setupVault('Synthetic-Master-42!');const external=await vault.exportVault();
 await storage.upsertProfile({...fixture.profiles[0]!,password:'synthetic-current-password'} as any);const primary=await vault.exportVault();await vault.lockVault();
 await vault.restoreVault(external,'Synthetic-Master-42!');
 expect(await vault.exportVault(true)).toEqual(primary);expect(local['qf.vault.corrupt-backup.v1']).toBeUndefined();
});
it('keeps authenticated ciphertext with invalid logical schema out of the recovery slot',async()=>{
 const vault=await import('../src/background/vault');const {encryptVault,importVaultKey}=await import('../src/lib/vault-crypto');
 await vault.setupVault('Synthetic-Master-42!');const external=await vault.exportVault(),healthy=await vault.exportVault(true);
 const key=await importVaultKey((session['qf.vault.unlock.v1'] as any).material);
 const invalid=await encryptVault({version:99,profiles:[]},key,external.kdf.salt);local[KEY]=invalid;
 await vault.restoreVault(external,'Synthetic-Master-42!');
 expect(await vault.exportVault(true)).toEqual(healthy);expect(local['qf.vault.corrupt-backup.v1']).toBeDefined();
});

it.each(['expired','overlong'] as const)('does not promote previous primary using an %s session lease',async(lease)=>{
 const vault=await import('../src/background/vault');const storage=await import('../src/lib/storage');const {createVault,decryptVault}=await import('../src/lib/vault-crypto');
 await vault.setupVault('Synthetic-Master-42!');const healthy=await vault.exportVault(true);
 await storage.upsertProfile({...fixture.profiles[0]!,password:'synthetic-current-password'} as any);const previous=await vault.exportVault();
 (session['qf.vault.unlock.v1'] as any).expiresAt=Date.now()+(lease==='expired'?-1:16*60*1000);
 const external=await createVault({...fixture,profiles:[]},'Synthetic-External-42!');
 await vault.restoreVault(external.envelope,'Synthetic-External-42!');
 expect(await vault.exportVault(true)).toEqual(healthy);
 expect(await decryptVault(local['qf.vault.corrupt-backup.v1'],external.key)).toEqual(previous);
});
it('uses the authenticated external backup when the unknown previous primary has no usable recovery envelope',async()=>{
 const vault=await import('../src/background/vault');const {createVault,decryptVault}=await import('../src/lib/vault-crypto');
 await vault.setupVault('Synthetic-Master-42!');const previous=await vault.exportVault();await vault.lockVault();
 local['qf.vault.backup.v1']={broken:true};
 const external=await createVault({...fixture,profiles:[]},'Synthetic-External-42!');
 await vault.restoreVault(external.envelope,'Synthetic-External-42!');
 expect(await vault.exportVault(true)).toEqual(external.envelope);
 expect(await decryptVault(local['qf.vault.corrupt-backup.v1'],external.key)).toEqual(previous);
});
it('rejects clear while locked before removing recovery copies or changing generation',async()=>{
 const vault=await import('../src/background/vault');const storage=await import('../src/lib/storage');
 await vault.setupVault('Synthetic8!');await vault.lockVault();const before=structuredClone(local);
 await expect(storage.clearAll()).rejects.toThrow('锁定');expect(local).toEqual(before);
});

it('unlocks existing encrypted legacy identities without dropping their credential token fields', async () => {
 const {createVault}=await import('../src/lib/vault-crypto');
 const vault=await import('../src/background/vault');
 const storage=await import('../src/lib/storage');
 const legacy={id:'legacy-identity',kind:'identity',label:'Synthetic legacy',updatedAt:1,fields:{email:'synthetic@example.test',username:'synthetic-legacy-user','current-password':'synthetic-legacy-old','new-password':'synthetic-legacy-new'}};
 const original={...fixture,profiles:[...fixture.profiles,legacy]};
 const existing=await createVault(original,'Synthetic-Master-42!');
 local[KEY]=existing.envelope;
 const before=structuredClone(local);
 await vault.unlockVault('Synthetic-Master-42!');
 expect(local).toEqual(before);
 expect(await storage.getStored()).toEqual(original);
 await storage.touchProfile('synthetic');
 expect((await storage.getStored()).profiles[1]).toEqual(legacy);
 expect((local[KEY] as any).format).toBe('qf-vault');
});
