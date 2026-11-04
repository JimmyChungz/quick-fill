import {createVault, decryptVault, deriveVaultMaterial, encryptVault, importVaultKey, isVaultEnvelope, type VaultEnvelope} from '../lib/vault-crypto';
import {KEY, GENERATION_KEY, validateStored} from '../lib/storage-schema';
import {ensureLocalCapacity} from '../lib/storage-quota';

const SESSION='qf.vault.unlock.v1';
export const VAULT_BACKUP_KEY='qf.vault.backup.v1';
export const VAULT_UNLOCK_MS=15*60*1000;
type Unlock={salt:string;material:string;expiresAt:number};
const raw=async()=> (await chrome.storage.local.get(KEY))[KEY] as unknown;
const encrypted=(value:unknown):boolean => !!value && typeof value==='object' && 'format' in value && value.format==='qf-vault';
function envelope(value:unknown):VaultEnvelope {
 if(!isVaultEnvelope(value))throw Error('密码库密文格式异常，已保留原数据');
 return value as VaultEnvelope;
}
async function forgetUnlock():Promise<void> {
 await chrome.storage.session.remove([SESSION,'qf.pending.v2','qf.capture-permits','qf.receipts']);
 await chrome.storage.local.set({[GENERATION_KEY]:crypto.randomUUID()});
}
async function sessionKey(value:VaultEnvelope):Promise<CryptoKey> {
 const state=(await chrome.storage.session.get(SESSION))[SESSION] as Unlock|undefined;
 if(!state || state.salt!==value.kdf.salt || !Number.isFinite(state.expiresAt) || state.expiresAt<=Date.now() || state.expiresAt>Date.now()+VAULT_UNLOCK_MS){
  if(state)await forgetUnlock();
  throw Error('密码库已锁定，请在网页解锁框或管理页解锁');
 }
 return importVaultKey(state.material);
}
async function remember(value:VaultEnvelope,material:string):Promise<void> {
 const expiresAt=Date.now()+VAULT_UNLOCK_MS;
 try {
  await chrome.alarms.create('qf.vault-lock',{when:expiresAt});
  await chrome.storage.session.set({[SESSION]:{salt:value.kdf.salt,material,expiresAt}});
 } catch(error) {
  await forgetUnlock();
  throw error;
 }
}
export async function readVaultData():Promise<unknown> {
 const value=await raw();
 if(!encrypted(value))return value;
 const box=envelope(value);
 try{return await decryptVault(box,await sessionKey(box));}
 catch(error){if(error instanceof Error && error.message.includes('锁定'))throw error;throw Error('密码库无法解密，已保留原数据');}
}
export async function writeVaultData(value:unknown):Promise<void> {
 const previous=await raw();
 if(!encrypted(previous)){await ensureLocalCapacity({[KEY]:value});await chrome.storage.local.set({[KEY]:value});return;}
 const box=envelope(previous),key=await sessionKey(box);
 const next=await encryptVault(value,key,box.kdf.salt);
 // Verify the candidate before replacing the current encrypted record.
 validateStored(await decryptVault(next,key));
 await ensureLocalCapacity({[KEY]:next});
 await chrome.storage.local.set({[KEY]:next});
}
export async function vaultStatus():Promise<{enabled:boolean;unlocked:boolean;expiresAt:number|null}> {
 const value=await raw();
 if(!encrypted(value))return {enabled:false,unlocked:true,expiresAt:null};
 const box=envelope(value);
 try{await sessionKey(box);const state=(await chrome.storage.session.get(SESSION))[SESSION] as Unlock;return {enabled:true,unlocked:true,expiresAt:state.expiresAt};}
 catch{return {enabled:true,unlocked:false,expiresAt:null};}
}
// Chrome may reorder object keys during storage serialization. Compare the
// validated envelope's values, never JSON property insertion order.
function sameEnvelope(value:unknown, expected:VaultEnvelope):boolean {
 return isVaultEnvelope(value) && value.kdf.salt===expected.kdf.salt
  && value.cipher.iv===expected.cipher.iv && value.cipher.data===expected.cipher.data;
}
async function install(next:VaultEnvelope,key:CryptoKey,material:string,backup:VaultEnvelope,forensic:Record<string,unknown>={}):Promise<void> {
 validateStored(await decryptVault(next,key));
 const recoveryUpdates={...forensic,[VAULT_BACKUP_KEY]:backup};
 const primaryUpdates={[KEY]:next,[GENERATION_KEY]:crypto.randomUUID()};
 // The backup stage retains the old primary; the final stage retains every
 // recovery copy. Both peaks must fit before any local or session mutation.
 await ensureLocalCapacity(recoveryUpdates);
 await ensureLocalCapacity({...recoveryUpdates,...primaryUpdates});
 // A private recovery copy is encrypted too. Never write a new plaintext backup.
 await chrome.storage.local.set(recoveryUpdates);
 const copied=(await chrome.storage.local.get(VAULT_BACKUP_KEY))[VAULT_BACKUP_KEY];
 if(!sameEnvelope(copied,backup))throw Error('加密备份写入校验失败，未切换密码库');
 await chrome.storage.local.set(primaryUpdates);
 const written=await raw();
 if(!sameEnvelope(written,next))throw Error('密码库写入校验失败，请使用加密恢复副本');
 validateStored(await decryptVault(written,key));
 await chrome.storage.session.remove(['qf.pending.v2','qf.capture-permits','qf.receipts']);
 await remember(next,material);
}
export async function setupVault(password:string):Promise<void> {
 if(encrypted(await raw()))throw Error('密码库已启用加密，请使用解锁或更改主密码');
 const stored=validateStored(await readVaultData());
 const {envelope:next,key,material}=await createVault(stored,password);
 await install(next,key,material,next);
}
export async function unlockVault(password:string):Promise<void> {
 const box=envelope(await raw());
 try{
  const material=await deriveVaultMaterial(password,box.kdf.salt),key=await importVaultKey(material);
  validateStored(await decryptVault(box,key));
  await remember(box,material);
 }catch{throw Error('主密码不正确或密码库已损坏，原数据未修改');}
}
export async function lockVault():Promise<void> {await forgetUnlock();}
export async function changeVaultPassword(oldPassword:string,newPassword:string):Promise<void> {
 const old=envelope(await raw());
 let data:unknown;
 try{data=await decryptVault(old,await importVaultKey(await deriveVaultMaterial(oldPassword,old.kdf.salt)));}
 catch{throw Error('原主密码不正确，密码库未修改');}
 const stored=validateStored(data),next=await createVault(stored,newPassword);
 // Re-encrypt the rollback copy under the new password, so changing the master
 // password does not leave a second copy decryptable with the previous one.
 await install(next.envelope,next.key,next.material,next.envelope);
}
export async function exportVault(recovery=false):Promise<VaultEnvelope> {
 return envelope(recovery ? (await chrome.storage.local.get(VAULT_BACKUP_KEY))[VAULT_BACKUP_KEY] : await raw());
}
// Recovery promotion requires authenticated, schema-valid contents. This probe
// must stay read-only: an expired session must not mutate generation or secrets
// before the compound operation has passed its quota preflight.
async function authenticPrevious(value:VaultEnvelope,restored:VaultEnvelope,key:CryptoKey):Promise<boolean> {
 if(value.kdf.salt===restored.kdf.salt){
  try{validateStored(await decryptVault(value,key));return true;}catch{/* Try the trusted current session too. */}
 }
 try{
  const state=(await chrome.storage.session.get(SESSION))[SESSION] as Unlock|undefined;
  const now=Date.now();
  if(!state || state.salt!==value.kdf.salt || !Number.isFinite(state.expiresAt)
   || state.expiresAt<=now || state.expiresAt>now+VAULT_UNLOCK_MS)return false;
  validateStored(await decryptVault(value,await importVaultKey(state.material)));
  return true;
 }catch{return false;}
}
export async function restoreVault(value:unknown,password:string):Promise<void> {
 const box=envelope(value);
 let key:CryptoKey, material:string, stored:ReturnType<typeof validateStored>;
 try{material=await deriveVaultMaterial(password,box.kdf.salt);key=await importVaultKey(material);stored=validateStored(await decryptVault(box,key));}
 catch{throw Error('备份无法解密或内容无效，当前密码库未修改');}
 const previous=await raw();
 let backup:VaultEnvelope;
 const forensic:Record<string,unknown>={};
 if(isVaultEnvelope(previous) && await authenticPrevious(previous,box,key))backup=previous;
 else {
  // A broken or unauthenticated primary must not replace an existing recovery
  // envelope. Preserve its exact JSON in the single bounded encrypted forensic
  // slot, including healthy locked data whose password is currently unknown.
  if(previous!==undefined)forensic['qf.vault.corrupt-backup.v1']=await encryptVault(previous,key,box.kdf.salt);
  const existing=(await chrome.storage.local.get(VAULT_BACKUP_KEY))[VAULT_BACKUP_KEY];
  backup=isVaultEnvelope(existing)?existing:box;
 }
 const next=await encryptVault(stored,key,box.kdf.salt);
 await install(next,key,material,backup,forensic);
}
