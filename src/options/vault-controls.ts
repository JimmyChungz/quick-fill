import {countLegacyPasswords} from '../lib/legacy-status';
import type {Profile} from '../lib/types';
import {bindPasswordVisibility} from '../lib/password-visibility';
import {GENERATION_KEY} from '../lib/storage-schema';
import {send} from '../lib/messaging';

type Status={enabled:boolean;unlocked:boolean;expiresAt:number|null};
const node=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const password=(id:string)=>node<HTMLInputElement>(id).value;
let maskUnlock = () => {};
function clearPasswords():void {maskUnlock();document.querySelectorAll<HTMLInputElement>('#vault-controls input[type=password]').forEach(input=>input.value='');}
let revision = 0;
async function refreshVault():Promise<void> {
 const captured = ++revision;
 const status=await send({type:'qf.vault_status'}) as Status;
 if(captured !== revision)return;
 if(typeof status.enabled!=='boolean'||typeof status.unlocked!=='boolean')throw Error('无法读取密码库状态');
 node('vault-status').textContent=!status.enabled?'尚未开启加密：现有记录仍以应用层明文保存。':status.unlocked?'已加密并解锁。此解锁会话最多15分钟；后台休眠不会延长时间。':'已加密并锁定，请输入主密码解锁。';
 let legacyCount=0;
 if(!status.enabled){const result=await send({type:'qf.get_profiles'}) as {profiles?:Profile[]};if(captured!==revision)return;if(Array.isArray(result.profiles))legacyCount=countLegacyPasswords(result.profiles);}
 node('legacy-vault-warning').hidden=legacyCount===0;
 node('legacy-vault-count').textContent=legacyCount ? `检测到 ${legacyCount} 条包含密码的旧版未加密记录。` : '';
 node('vault-setup').hidden=status.enabled;node('vault-unlock').hidden=!status.enabled||status.unlocked;
 node('vault-lock').hidden=!status.enabled||!status.unlocked;node('vault-change').hidden=!status.enabled;
 node<HTMLButtonElement>('vault-backup').disabled=!status.enabled;
}
function notify():void {window.dispatchEvent(new Event('qf-vault-changed'));}
async function action(run:()=>Promise<void>):Promise<void> {
 const buttons=Array.from(document.querySelectorAll<HTMLButtonElement>('#vault-controls button'));
 if(buttons.some(button=>button.dataset.busy==='true'))return;
 buttons.forEach(button=>{button.dataset.busy='true';button.disabled=true;});node('vault-error').textContent='';
 try{await run();await refreshVault();}
 catch(error){node('vault-error').textContent=error instanceof Error?error.message:'操作失败，原数据未被自动清空';}
 finally{clearPasswords();buttons.forEach(button=>{delete button.dataset.busy;button.disabled=false;});void refreshVault().catch(()=>{});}
}
function download(value:unknown):void {
 const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download=`quickfill-encrypted-${new Date().toISOString().slice(0,10)}.json`;
 document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function initializeVaultControls():void {
 if(!node('vault-controls'))return;
 maskUnlock=bindPasswordVisibility(node<HTMLInputElement>('vault-password'),node<HTMLButtonElement>('vault-password-reveal'));
 node('legacy-vault-migrate').addEventListener('click',()=>{node('vault-new').focus({preventScroll:true});node('vault-new').scrollIntoView?.({block:'center'});});
 node('vault-setup').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{
  const value=password('vault-new');if(value!==password('vault-confirm'))throw Error('两次主密码不一致');
  if(!node<HTMLInputElement>('vault-ack').checked)throw Error('请先确认主密码遗失与旧版兼容风险');
  if(!confirm('开启加密后旧版无法读取；主密码遗失无法恢复。此操作会结束其他页面未保存的草稿。继续?'))return;
  await send({type:'qf.vault_setup',password:value});notify();node('vault-notice').textContent='加密迁移完成，请立即导出并妥善保存加密备份。';
 });});
 node('vault-unlock').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{await send({type:'qf.vault_unlock',password:password('vault-password')});notify();});});
 node('vault-lock').addEventListener('click',()=>{void action(async()=>{if(!confirm('锁定会清除未保存草稿与未确认候选。继续?'))return;await send({type:'qf.vault_lock'});notify();});});
 node('vault-change').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{
  if(password('vault-change-new')!==password('vault-change-confirm'))throw Error('两次新主密码不一致');
  if(!confirm('更改主密码后，请重新导出加密备份；以前导出的文件仍使用原密码。继续?'))return;
  await send({type:'qf.vault_change',oldPassword:password('vault-change-old'),newPassword:password('vault-change-new')});notify();node('vault-notice').textContent='主密码已更改，请重新导出加密备份。';
 });});
 node('vault-recovery-backup').addEventListener('click',()=>{void action(async()=>{const res=await send({type:'qf.vault_export',recovery:true}) as {envelope:unknown};if(!res.envelope)throw Error('没有可用的加密恢复副本');download(res.envelope);});});
 chrome.storage?.onChanged?.addListener((changes,area)=>{if(area==='local'&&changes[GENERATION_KEY]){clearPasswords();void refreshVault().catch(()=>{node('vault-error').textContent='无法读取当前密码库状态，请检查数据或导出恢复副本';});}});
 node('vault-backup').addEventListener('click',()=>{void action(async()=>{const res=await send({type:'qf.vault_export'}) as {envelope:unknown};if(!res.envelope)throw Error('未取得有效密文备份');download(res.envelope);});});
 node('vault-restore').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{
  const file=node<HTMLInputElement>('vault-file').files?.[0];if(!file)throw Error('请选择加密备份');if(file.size>30*1024*1024)throw Error('备份不能超过30MB');
  let envelope:unknown;try{envelope=JSON.parse(await file.text());}catch{throw Error('备份不是有效JSON');}
  if(!confirm('恢复会替换当前密码库；当前内容会保留私有加密恢复副本。确认使用此备份?'))return;
  await send({type:'qf.vault_restore',envelope,password:password('vault-restore-password')});node<HTMLInputElement>('vault-file').value='';notify();node('vault-notice').textContent='加密备份恢复成功。';
 });});
 node('vault-refresh').addEventListener('click',()=>{void action(async()=>{});});
 void refreshVault().catch(error=>{node('vault-error').textContent=error instanceof Error?error.message:'无法读取密码库状态';});
}
