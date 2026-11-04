import {contentContext} from '../lib/message-policy';
import {GENERATION_KEY} from '../lib/storage-schema';
import {unlockVault, vaultStatus} from './vault';
const KEY='qf.inline-unlock.v1',TTL=2*60*1000;
type Challenge={nonce:string;tabId:number;origin:string;generation:string;expiresAt:number;attempts:number};
type Request={type:string;nonce?:string;password?:string};
const types=new Set(['qf.unlock_prompt','qf.inline_unlock_status','qf.inline_unlock_submit','qf.inline_unlock_cancel']);
export const isInlineUnlockMessage=(type:string):boolean=>types.has(type);
const generation=async()=>{const v=(await chrome.storage.local.get(GENERATION_KEY))[GENERATION_KEY];if(v===undefined)return '0';if(typeof v!=='string')throw Error('数据代次异常');return v;};
async function records():Promise<Record<string,Challenge>> {
 const value=(await chrome.storage.session.get(KEY))[KEY];
 return value&&typeof value==='object'?value:{};
}
async function currentOrigin(tabId:number):Promise<string> {
 const tab=await chrome.tabs.get(tabId);if(!tab.url)throw Error('页面已关闭或无法核对');const url=new URL(tab.url);
 if(!['http:','https:'].includes(url.protocol))throw Error('页面不支持解锁');return url.origin;
}
async function checkFrame(msg:Request,sender:chrome.runtime.MessageSender):Promise<{all:Record<string,Challenge>;challenge:Challenge}> {
 if(sender.id!==chrome.runtime.id||!Number.isSafeInteger(sender.tab?.id)||sender.frameId===undefined||sender.frameId<=0||!sender.url)throw Error('解锁页面来源无效');
 const url=new URL(sender.url),nonce=url.searchParams.get('nonce');
 if(url.protocol!=='chrome-extension:'||url.hostname!==chrome.runtime.id||url.pathname!=='/unlock.html'||url.username||url.password||url.port||url.hash||[...url.searchParams].length!==1||!nonce||nonce!==msg.nonce)throw Error('解锁请求无效');
 if(sender.origin!==undefined&&sender.origin!==`chrome-extension://${chrome.runtime.id}`)throw Error('解锁页面来源无效');
 const all=await records(),challenge=all[String(sender.tab!.id)];
 if(!challenge||challenge.nonce!==nonce||challenge.tabId!==sender.tab!.id||!Number.isFinite(challenge.expiresAt)||challenge.expiresAt<=Date.now()||challenge.expiresAt>Date.now()+TTL||challenge.generation!==await generation()||challenge.origin!==await currentOrigin(challenge.tabId))throw Error('解锁请求已失效，请关闭后重试');
 return {all,challenge};
}
/** Called only inside the worker's serial queue. Passwords never enter content
 * scripts or postMessage: only this extension-origin frame can submit them. */
export async function handleInlineUnlock(msg:Request,sender:chrome.runtime.MessageSender,broadcast:()=>Promise<void>):Promise<unknown> {
 if(msg.type==='qf.unlock_prompt') {
  const {tabId,origin}=contentContext(sender);
  if(origin!==await currentOrigin(tabId))throw Error('页面已切换');
  const status=await vaultStatus();if(!status.enabled||status.unlocked)return {type:'qf.unlock_prompt',locked:false};
  const all=await records(),now=Date.now();for(const [id,v] of Object.entries(all))if(!v||v.expiresAt<=now)delete all[id];
  const challenge:Challenge={nonce:crypto.randomUUID(),tabId,origin,generation:await generation(),expiresAt:now+TTL,attempts:0};all[String(tabId)]=challenge;
  await chrome.storage.session.set({[KEY]:all});
  return {type:'qf.unlock_prompt',locked:true,nonce:challenge.nonce,expiresAt:challenge.expiresAt,url:chrome.runtime.getURL('unlock.html')+'?nonce='+encodeURIComponent(challenge.nonce)};
 }
 const {all,challenge}=await checkFrame(msg,sender);
 if(msg.type==='qf.inline_unlock_status')return {type:'qf.inline_unlock_status',locked:!(await vaultStatus()).unlocked};
 if(msg.type==='qf.inline_unlock_cancel'){delete all[String(challenge.tabId)];await chrome.storage.session.set({[KEY]:all});return {type:'qf.ok'};}
 if(msg.type!=='qf.inline_unlock_submit')throw Error('不支持的解锁操作');
 if(typeof msg.password!=='string'||msg.password.length<8||msg.password.length>1024)throw Error('主密码至少8字符');
 if(challenge.attempts>=5)throw Error('尝试次数过多，请关闭后重新打开');
 challenge.attempts++;await chrome.storage.session.set({[KEY]:all});
 await unlockVault(msg.password);
 // Global session unlock invalidates every other outstanding prompt.
 await chrome.storage.session.remove(KEY);await broadcast();return {type:'qf.ok'};
}
