import {countLegacyPasswords} from '../lib/legacy-status';
import {bindPasswordVisibility} from '../lib/password-visibility';
import { send, currentGeneration } from '../lib/messaging';
import { normalizeOrigin } from '../lib/origin';
import type { Profile, LoginProfile, IdentityProfile, IdentityToken } from '../lib/types';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const params = new URLSearchParams(location.search);
const requestedKind = params.get('editor');
const editorKind = requestedKind === 'login' || requestedKind === 'identity' ? requestedKind : null;
let editorStarted = false;
let editorActive = false;
let originalValues = '';
let stateRevision = 0;
let maskMaster = () => {};

const identityFields: Record<string, IdentityToken> = {
  name: 'name', email: 'email', tel: 'tel', org: 'organization',
  street: 'street-address', city: 'city', state: 'region', zip: 'postal-code', country: 'country',
};

function editorValues(): string {
  const panel = editorKind === 'login' ? '#new-login-form' : '#new-identity-form';
  return JSON.stringify(Array.from(document.querySelectorAll<HTMLInputElement>(`${panel} input`), input => input.value));
}
function isDirty(): boolean { return editorActive && editorValues() !== originalValues; }
function finishEditor(saved: boolean): void {
  editorActive = false;
  originalValues = '';
  clearLoginForm();
  clearIdentityForm();
  setEdit($('#nl-save'));
  setEdit($('#ni-save'));
  showOnlyPanel(null);
  $('#retry').hidden = true;
  $('#editor-complete').hidden = false;
  $('#editor-status').textContent = saved ? '已保存。可以返回管理页面或关闭此标签页。' : '已取消，未保存的修改已丢弃。';
  $('#editor-status').focus();
}
function cancelEditor(): void {
  if (!editorActive || (isDirty() && !confirm('有未保存的修改，确定放弃吗？'))) return;
  finishEditor(false);
}
async function openEditor(kind: 'login' | 'identity', id?: string): Promise<void> {
  await chrome.tabs.create({ url: `${chrome.runtime.getURL('popup.html')}?editor=${kind}${id ? `&id=${encodeURIComponent(id)}` : ''}` });
}

function showError(error: unknown): void {
  $('#error').textContent = error instanceof Error ? error.message : '操作失败，请重试';
  $('#error').hidden = false;
}

async function run(action: () => Promise<void>, button?: HTMLButtonElement): Promise<void> {
  if (button?.disabled) return;
  $('#error').hidden = true;
  // Freeze this form while its write is pending so later edits cannot be discarded by its acknowledgement.
  const controls = button?.closest('.form-panel')?.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button');
  if (controls) for (const control of controls) control.disabled = true;
  else if (button) button.disabled = true;
  try { await action(); } catch (error) { showError(error); }
  finally {
    if (controls) for (const control of controls) control.disabled = false;
    else if (button) button.disabled = false;
  }
}

async function getProfiles(): Promise<Profile[]> {
  const res = await send({ type: 'qf.get_profiles' });
  if (res && typeof res === 'object' && 'profiles' in res && Array.isArray(res.profiles)) return res.profiles;
  throw new Error('无法读取保存的记录，请重试');
}

function showOnlyPanel(panelId: string | null): void {
  for (const id of ['new-login-form', 'new-identity-form']) $(`#${id}`).hidden = id !== panelId;
  if (panelId !== 'new-login-form') maskPassword();
}

const passwordField = (): HTMLInputElement => $('#nl-password');
function maskPassword(): void {
  passwordField().type = 'password';
  $('#nl-reveal').setAttribute('aria-pressed', 'false');
}
function clearLoginForm(): void {
  for (const id of ['origin', 'username', 'password']) $<HTMLInputElement>(`#nl-${id}`).value = '';
  maskPassword();
}
function clearIdentityForm(): void {
  for (const id of ['label', ...Object.keys(identityFields)]) $<HTMLInputElement>(`#ni-${id}`).value = '';
}
function setEdit(button: HTMLButtonElement, profile?: Profile): void {
  button.dataset.generation = currentGeneration();
  delete button.dataset.draftId;
  delete button.dataset.editId;
  delete button.dataset.updatedAt;
  if (profile) {
    button.dataset.editId = profile.id;
    button.dataset.updatedAt = String(profile.updatedAt);
  }
}

function render(profiles: Profile[], q: string): void {
  const lc = q.toLowerCase();
  const match = (p: Profile): boolean => {
    const hay = p.kind === 'login' ? `${p.url} ${p.username}` : `${p.label} ${Object.values(p.fields).join(' ')}`;
    return hay.toLowerCase().includes(lc);
  };
  const logins = profiles.filter((p): p is LoginProfile => p.kind === 'login' && match(p)).sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt));
  const identities = profiles.filter((p): p is IdentityProfile => p.kind === 'identity' && match(p)).sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt));
  $('#logins').replaceChildren(...logins.map(loginLi));
  $('#identities').replaceChildren(...identities.map(identLi));
}
function item(title: string, subtitle: string, edit: () => void): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'item';
  const button = document.createElement('button');
  button.type = 'button';
  const main = document.createElement('span');
  main.className = 'main';
  main.textContent = title;
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = subtitle;
  button.append(main, sub);
  button.addEventListener('click', edit);
  li.append(button);
  // Keep the whole list item clickable, including its padding.
  li.addEventListener('click', event => { if (event.target === li) edit(); });
  return li;
}
function openRecord(kind: 'login' | 'identity', id: string): () => void {
  return () => { void run(() => openEditor(kind, id)); };
}
function loginLi(p: LoginProfile): HTMLLIElement {
  return item(p.username || '(空用户名)', `[密码: ••••••••]  ${p.url}`, openRecord('login', p.id));
}
function identLi(p: IdentityProfile): HTMLLIElement {
  return item(p.label || '(未命名)', `${Object.keys(p.fields).length} 个字段`, openRecord('identity', p.id));
}
function editLogin(p: LoginProfile): void {
  showOnlyPanel('new-login-form');
  maskPassword();
  $<HTMLInputElement>('#nl-origin').value = p.url;
  $<HTMLInputElement>('#nl-username').value = p.username;
  passwordField().value = p.password;
  setEdit($('#nl-save'), p);
  $<HTMLInputElement>('#nl-origin').focus();
}
function editIdentity(p: IdentityProfile): void {
  showOnlyPanel('new-identity-form');
  $<HTMLInputElement>('#ni-label').value = p.label;
  for (const [id, token] of Object.entries(identityFields)) $<HTMLInputElement>(`#ni-${id}`).value = p.fields[token] ?? '';
  setEdit($('#ni-save'), p);
  $<HTMLInputElement>('#ni-label').focus();
}
function showUnlock(locked: boolean): void {
  $('#vault-unlock-panel').hidden = !locked;
  if (!editorKind) for (const id of ['popup-header', 'record-list', 'popup-actions']) $(`#${id}`).hidden = locked;
  if (locked) {
    $('#logins').replaceChildren(); $('#identities').replaceChildren();
    clearLoginForm(); clearIdentityForm(); showOnlyPanel(null);
    editorActive = false; editorStarted = false; originalValues = '';
    $('#editor-complete').hidden = true;
    $<HTMLInputElement>('#popup-master-password').focus();
  }
}

async function refresh(): Promise<void> {
  const openingRevision = stateRevision;
  const status = await send({type: 'qf.vault_status'}) as {type: string; enabled: boolean; unlocked: boolean};
  if (openingRevision !== stateRevision) return;
  if (status.type !== 'qf.vault_status' || typeof status.enabled !== 'boolean' || typeof status.unlocked !== 'boolean')
    throw new Error('无法读取密码库状态，请重试');
  $('#popup-legacy-warning').hidden = true;
  showUnlock(status.enabled && !status.unlocked);
  if (status.enabled && !status.unlocked) return;
  const profiles = await getProfiles();
  if (openingRevision !== stateRevision) return;
  const legacyCount = status.enabled ? 0 : countLegacyPasswords(profiles);
  $('#popup-legacy-warning').hidden = legacyCount === 0;
  $('#popup-legacy-count').textContent = legacyCount ? `检测到 ${legacyCount} 条包含密码的旧版未加密记录。请设置主密码后迁移。` : '';
  if (!editorKind) { render(profiles, $<HTMLInputElement>('#search').value); return; }
  if (editorStarted) return; // Refresh never replaces an in-memory draft.
  const id = params.get('id');
  if (params.has('id')) {
    const profile = profiles.find(profile => profile.id === id && profile.kind === editorKind);
    if (!profile) throw new Error('找不到这条记录，可能已被删除。请返回管理页面重新选择。');
    if (profile.kind === 'login') editLogin(profile);
    else editIdentity(profile);
  } else {
    const prefix = editorKind === 'login' ? 'nl' : 'ni';
    const button = $<HTMLButtonElement>(`#${prefix}-save`);
    setEdit(button);
    button.dataset.draftId = crypto.randomUUID();
    clearLoginForm();
    clearIdentityForm();
    showOnlyPanel(`new-${editorKind}-form`);
    $<HTMLInputElement>(editorKind === 'login' ? '#nl-origin' : '#ni-label').focus();
  }
  $('#editor-complete').hidden = true;
  editorStarted = true;
  editorActive = true;
  originalValues = editorValues();
}


function resetForGenerationChange(changes: Record<string, chrome.storage.StorageChange>, area: string): void {
  const change = changes['qf.generation'];
  if (area !== 'local' || !change || change.oldValue === change.newValue) return;
  stateRevision++;
  maskMaster();
  $<HTMLInputElement>('#popup-master-password').value = '';
  $('#logins').replaceChildren();
  $('#identities').replaceChildren();
  $<HTMLInputElement>('#search').value = '';
  finishEditor(false);
  editorStarted = false;
  $('#retry').hidden = false;
  $('#error').hidden = true;
  if (editorKind) $('#editor-status').textContent = '密码库状态已变更，请解锁后刷新；未保存草稿已清除';
  else $('#editor-complete').hidden = true;
}

async function init(): Promise<void> {
  chrome.storage?.onChanged?.addListener(resetForGenerationChange);
  if (editorKind) {
    document.body.classList.add('editor-mode');
    for (const id of ['popup-header', 'record-list', 'popup-actions']) $(`#${id}`).hidden = true;
    $('#editor-header').hidden = false;
    $('#editor-title').textContent = `${params.has('id') ? '编辑' : '新建'}${editorKind === 'login' ? '登录' : '身份'}`;
    $('#retry').textContent = '重试读取（保留当前草稿）';
    document.title = `${$('#editor-title').textContent} · 快填`;
    window.onbeforeunload = event => {
      if (!isDirty()) return;
      event.preventDefault();
      event.returnValue = '';
    };
  }
  $('#editor-open-manager').addEventListener('click', () => { void run(async () => { await chrome.runtime.openOptionsPage(); }); });
  $('#editor-close').addEventListener('click', () => window.close());
  $('#editor-manage').addEventListener('click', () => { void run(async () => { await chrome.runtime.openOptionsPage(); }); });

  const master = $<HTMLInputElement>('#popup-master-password');
  maskMaster = bindPasswordVisibility(master, $('#popup-master-reveal'));
  window.addEventListener('pagehide', () => { maskMaster(); master.value = ''; });
  $('#vault-unlock-form').addEventListener('submit', event => {
    event.preventDefault();
    const button = $<HTMLButtonElement>('#popup-unlock');
    if (button.disabled) return;
    void run(async () => {
      const password = master.value;
      maskMaster(); master.value = '';
      if (password.length < 8 || password.length > 1024) throw new Error('主密码需要8至1024字符');
      master.disabled = true;
      try { await send({type: 'qf.vault_unlock', password}); await refresh(); }
      finally { maskMaster(); master.value = ''; master.disabled = false; if (!$('#vault-unlock-panel').hidden) master.focus(); }
    }, button);
  });

  $('#search').addEventListener('input', () => { void run(refresh); });
  $('#retry').addEventListener('click', () => { void run(refresh); });
  $('#nl-reveal').addEventListener('click', () => {
    const pw = passwordField();
    pw.type = pw.type === 'password' ? 'text' : 'password';
    $('#nl-reveal').setAttribute('aria-pressed', String(pw.type === 'text'));
    pw.focus();
  });
  $('#new-login').addEventListener('click', () => { void run(() => openEditor('login'), $<HTMLButtonElement>('#new-login')); });
  $('#nl-cancel').addEventListener('click', cancelEditor);
  $('#nl-save').addEventListener('click', () => { void run(async () => {
    const origin = normalizeOrigin($<HTMLInputElement>('#nl-origin').value.trim());
    if (!origin) { $<HTMLInputElement>('#nl-origin').focus(); throw new Error('请输入有效的 http(s) 网站地址'); }
    const button = $<HTMLButtonElement>('#nl-save');
    const editId = button.dataset.editId;
    const id = editId ?? button.dataset.draftId;
    if (!id) throw new Error('请先新建或选择一条记录');
    const openingRevision = stateRevision;
    await send({
      type: 'qf.update_profile', create: !editId, generation: button.dataset.generation,
      expectedUpdatedAt: editId ? Number(button.dataset.updatedAt) : undefined,
      profile: { id, kind: 'login', url: origin,
        username: $<HTMLInputElement>('#nl-username').value, password: passwordField().value, updatedAt: Date.now() },
    });
    if (openingRevision === stateRevision) finishEditor(true);
  }, $<HTMLButtonElement>('#nl-save')); });
  $('#new-identity').addEventListener('click', () => { void run(() => openEditor('identity'), $<HTMLButtonElement>('#new-identity')); });
  $('#ni-cancel').addEventListener('click', cancelEditor);
  $('#ni-save').addEventListener('click', () => { void run(async () => {
    const label = $<HTMLInputElement>('#ni-label').value.trim();
    if (!label) { $<HTMLInputElement>('#ni-label').focus(); throw new Error('请输入身份名称'); }
    const fields: IdentityProfile['fields'] = {};
    for (const [id, token] of Object.entries(identityFields)) fields[token] = $<HTMLInputElement>(`#ni-${id}`).value.trim();
    const button = $<HTMLButtonElement>('#ni-save');
    const editId = button.dataset.editId;
    const id = editId ?? button.dataset.draftId;
    if (!id) throw new Error('请先新建或选择一条记录');
    const openingRevision = stateRevision;
    await send({ type: 'qf.update_profile', patch: true, create: !editId, generation: button.dataset.generation,
      expectedUpdatedAt: editId ? Number(button.dataset.updatedAt) : undefined,
      profile: { id, kind: 'identity', label, fields, updatedAt: Date.now() } });
    if (openingRevision === stateRevision) finishEditor(true);
  }, $<HTMLButtonElement>('#ni-save')); });
  $('#popup-legacy-migrate').addEventListener('click', () => { void run(async () => { await chrome.runtime.openOptionsPage(); }); });
  $('#manage').addEventListener('click', () => { void run(async () => { await chrome.runtime.openOptionsPage(); }); });
  await run(refresh);
}
void init();
