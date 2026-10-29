import {send} from '../lib/messaging';
/** Only a cross-origin extension iframe holds the master-password input. The
 * page and this content script see nonce/status only, never the password. */
export function attachInlineUnlock(onUnlocked:()=>Promise<void>):()=>void {
 let disposed=false;
 let restoreFocus:HTMLElement|null=null;
 let host:HTMLDivElement|null=null,frame:HTMLIFrameElement|null=null,nonce='',dismissed=false,busy=false,retry=false,revision=0,expiresAt=0;
 const remove=()=>{host?.remove();host=null;frame=null;nonce='';expiresAt=0;revision++;};
 const show=async(explicit=false)=>{
  if(disposed)return;
  if(busy){retry=true;return;}
  if(document.visibilityState==='hidden'||(dismissed&&!explicit))return;
  if(host?.isConnected){if(expiresAt>Date.now())return;remove();}
  busy=true;const expected=revision;
  try{
   const result=await send({type:'qf.unlock_prompt'}) as {locked:boolean;url?:string;nonce?:string;expiresAt?:number};
   if(expected!==revision||result.locked!==true||!result.url||!result.nonce||
      typeof result.expiresAt!=='number'||!Number.isFinite(result.expiresAt)||result.expiresAt<=Date.now())return;
   const url=new URL(result.url);if(url.protocol!=='chrome-extension:'||url.hostname!==chrome.runtime.id||url.pathname!=='/unlock.html')return;
   host?.remove();nonce=result.nonce;expiresAt=result.expiresAt;dismissed=false;host=document.createElement('div');host.style.cssText='position:fixed;top:12px;right:12px;z-index:2147483647;width:min(360px,calc(100vw - 24px));height:300px;';
   const shadow=host.attachShadow({mode:'closed'});frame=document.createElement('iframe');frame.src=result.url;frame.title='快填安全解锁';frame.style.cssText='width:100%;height:100%;border:1px solid #a8b5c9;border-radius:10px;background:#fff;box-shadow:0 8px 30px #0003;';shadow.append(frame);document.documentElement.append(host);
  }catch{/* Other capture/fill behavior remains available after transient errors. */}
  finally{busy=false;if(retry){retry=false;void show();}}
 };
 const complete=()=>{const target=restoreFocus;remove();const expected=revision;dismissed=false;void onUnlocked().then(()=>{if(!disposed&&expected===revision&&target?.isConnected)target.focus();}).catch(()=>{});};
 const message=(event:MessageEvent)=>{
  if(!frame||event.source!==frame.contentWindow||event.origin!==`chrome-extension://${chrome.runtime.id}`||event.data?.type!=='qf.inline_unlock_done'||event.data.nonce!==nonce)return;
  if(event.data.result==='unlocked')complete();
  else if(event.data.result==='cancelled'){remove();dismissed=true;}
 };
 const visible=()=>{if(document.visibilityState==='visible')void show();};
 const focus=(event:FocusEvent)=>{if(event.target instanceof HTMLInputElement||event.target instanceof HTMLTextAreaElement){restoreFocus=event.target;void show(true);}};
 const changed=(message:unknown,sender:chrome.runtime.MessageSender)=>{
  const value=message as {type?:string;locked?:boolean};if(sender.id!==chrome.runtime.id||value?.type!=='qf.data_changed')return;
  if(value.locked===false){if(host)complete();else{remove();dismissed=false;}}else if(value.locked===true){remove();dismissed=false;void show();}
 };
 window.addEventListener('message',message);document.addEventListener('visibilitychange',visible);document.addEventListener('focusin',focus);chrome.runtime.onMessage.addListener(changed);void show();
 return ()=>{disposed=true;retry=false;remove();window.removeEventListener('message',message);document.removeEventListener('visibilitychange',visible);document.removeEventListener('focusin',focus);chrome.runtime.onMessage.removeListener?.(changed);};
}
