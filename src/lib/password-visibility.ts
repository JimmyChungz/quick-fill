/** Explicit, temporary viewing only. Never copies or stores the input value. */
export function bindPasswordVisibility(input: HTMLInputElement, button: HTMLButtonElement): () => void {
  const mask = () => {
    input.type = 'password';
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', '显示主密码');
    button.title = '查看主密码（继续输入时自动隐藏）';
  };
  mask();
  button.addEventListener('click', () => {
    if (input.disabled || button.disabled) return;
    if (input.type === 'text') mask();
    else {
      input.type = 'text';
      button.setAttribute('aria-pressed', 'true');
      button.setAttribute('aria-label', '隐藏主密码');
      button.title = '隐藏主密码';
    }
    input.focus({preventScroll: true});
  });
  for (const event of ['beforeinput', 'input', 'paste', 'drop', 'compositionstart', 'change'])
    input.addEventListener(event, mask);
  input.form?.addEventListener('submit', mask, true);
  window.addEventListener('blur', mask);
  window.addEventListener('pagehide', mask);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') mask(); });
  return mask;
}
