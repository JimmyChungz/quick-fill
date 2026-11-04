import {afterEach,beforeEach,expect,it,vi} from 'vitest';
let mask:()=>void,input:HTMLInputElement,button:HTMLButtonElement;
beforeEach(async()=>{
 document.body.innerHTML='<form><label for="secret">主密码</label><input id="secret" type="password"><button id="eye" type="button" aria-controls="secret">眼睛</button></form>';
 input=document.querySelector('input')!;button=document.querySelector('button')!;input.value='Synthetic-secret';
 mask=(await import('../src/lib/password-visibility')).bindPasswordVisibility(input,button);
});
afterEach(()=>{mask();vi.restoreAllMocks();});
it('reveals only on an explicit button click and keeps the password unchanged',()=>{
 expect(input.type).toBe('password');expect(button.getAttribute('aria-pressed')).toBe('false');
 input.focus();expect(input.type).toBe('password');button.click();expect(input.type).toBe('text');expect(button.getAttribute('aria-pressed')).toBe('true');
 expect(button.getAttribute('aria-label')).toBe('隐藏主密码');expect(input.value).toBe('Synthetic-secret');
 button.click();expect(input.type).toBe('password');expect(input.value).toBe('Synthetic-secret');
});
it.each(['beforeinput','input','paste','drop','compositionstart','change'])('masks immediately on %s and never erases input',event=>{
 button.click();input.dispatchEvent(new Event(event,{bubbles:true}));expect(input.type).toBe('password');expect(input.value).toBe('Synthetic-secret');expect(button.getAttribute('aria-pressed')).toBe('false');
});
it.each(['blur','pagehide'])('masks on window %s',event=>{
 button.click();window.dispatchEvent(new Event(event));expect(input.type).toBe('password');
});
it('masks before form submission and ignores clicks while input is disabled',()=>{
 button.click();document.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));expect(input.type).toBe('password');
 input.disabled=true;button.click();expect(input.type).toBe('password');
});
