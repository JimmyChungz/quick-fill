import {bindPasswordVisibility} from '../lib/password-visibility';
import {send} from '../lib/messaging';
const nonce=new URLSearchParams(location.search).get('nonce')??'';
const field=document.getElementById('password') as HTMLInputElement;
const maskPassword=bindPasswordVisibility(field,document.getElementById('password-reveal') as HTMLButtonElement);
const submit=document.getElementById('unlock') as HTMLButtonElement;
const status=document.getElementById('status')!;
const finish=(result:'unlocked'|'cancelled')=>window.parent.postMessage({type:'qf.inline_unlock_done',nonce,result},'*');
let busy=false;
document.getElementById('unlock-form')!.addEventListener('submit',event=>{
 event.preventDefault();if(busy)return;busy=true;submit.disabled=true;field.disabled=true;status.textContent='正在解锁…';
 void (async()=>{
  try{await send({type:'qf.inline_unlock_submit',nonce,password:field.value});field.value='';finish('unlocked');status.textContent='已解锁，可以继续填充。';}
  catch(error){status.textContent=error instanceof Error?error.message:'解锁失败，请重试';}
  finally{maskPassword();field.value='';field.disabled=false;submit.disabled=false;busy=false;field.focus();}
 })();
});
document.getElementById('close')!.addEventListener('click',()=>{
 if(busy)return;maskPassword();field.value='';void send({type:'qf.inline_unlock_cancel',nonce}).catch(()=>{});finish('cancelled');
});
void (async()=>{
 try{const result=await send({type:'qf.inline_unlock_status',nonce}) as {locked:boolean};if(!result.locked){finish('unlocked');return;}status.textContent='';field.focus();}
 catch(error){submit.disabled=true;status.textContent=error instanceof Error?error.message:'请求已失效，请关闭后重试';}
})();
