import {initializeVaultControls} from './vault-controls';
import {GENERATION_KEY} from '../lib/storage-schema';
import { send, currentGeneration } from '../lib/messaging';
import { isProfile, MAX_IMPORT } from '../lib/storage-schema';
import { normalizeOrigin } from '../lib/origin';
import type { Profile, LoginProfile, IdentityProfile, ExportPayload, FieldToken } from '../lib/types';
import { ALL_TOKENS, TOKEN_LABEL, isIdentityToken } from '../lib/tokens';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
let stateRevision = 0;
let editingLogin: LoginProfile | undefined;
let editingIdentity: IdentityProfile | undefined;
let loginGeneration: string;
let identityGeneration: string;

function errorMessage(error: unknown): void {
  $('#error').textContent = error instanceof Error ? error.message : '操作失败，请重试';
  $('#error').hidden = false;
}
async function run(action: () => Promise<void>, button?: HTMLButtonElement): Promise<void> {
  if (button?.disabled) return;
  $('#error').hidden = true;
  if (button) button.disabled = true;
  try { await action(); } catch (error) { errorMessage(error); }
  finally { if (button) button.disabled = false; }
}
async function getData(): Promise<{ profiles: Profile[]; blacklist: string[] }> {
  const res = await send({ type: 'qf.get_profiles' });
  if (res && typeof res === 'object' && 'profiles' in res && Array.isArray(res.profiles)) {
    return { profiles: res.profiles, blacklist: 'blacklist' in res && Array.isArray(res.blacklist) ? res.blacklist : [] };
  }
  throw new Error('无法读取保存的记录，请重试');
}
function render(profiles: Profile[]): void {
  const logins = profiles.filter((p): p is LoginProfile => p.kind === 'login').sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt));
  const identities = profiles.filter((p): p is IdentityProfile => p.kind === 'identity').sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt));
  for (const [selector, rows] of [
    ['#logins-tbody', logins.map(loginRow)], ['#identities-tbody', identities.map(identRow)],
  ] as const) {
    const tbody = $(selector);
    tbody.replaceChildren(...rows);
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.setAttribute('colspan', '4');
      td.className = 'muted';
      td.textContent = '暂无记录';
      tr.append(td);
      tbody.append(tr);
    }
  }
}
function loginRow(p: LoginProfile): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${esc(p.url)}</td><td>${esc(p.username)}</td><td><code>•••••••</code></td>
    <td class="actions"><button data-act="edit">编辑</button><button data-act="del">删除</button></td>`;
  tr.querySelector('[data-act="edit"]')!.addEventListener('click', () => editLogin(p));
  bindDelete(tr, p, `删除登录 ${p.url} / ${p.username}?`);
  return tr;
}
function identRow(p: IdentityProfile): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${esc(p.label)}</td><td>${Object.keys(p.fields).length}</td><td class="muted">${esc(Object.keys(p.fields).join(', '))}</td>
    <td class="actions"><button data-act="edit">编辑</button><button data-act="del">删除</button></td>`;
  tr.querySelector('[data-act="edit"]')!.addEventListener('click', () => editIdentity(p));
  bindDelete(tr, p, `删除身份 ${p.label}?`);
  return tr;
}
function bindDelete(row: HTMLTableRowElement, profile: Profile, message: string): void {
  const button = row.querySelector<HTMLButtonElement>('[data-act="del"]')!;
  button.addEventListener('click', () => { void run(async () => {
    if (!confirm(message)) return;
    await send({ type: 'qf.delete_profile', id: profile.id });
    if (editingLogin?.id === profile.id) closeLogin();
    if (editingIdentity?.id === profile.id) closeIdentity();
    await refresh();
  }, button); });
}
function editLogin(p: LoginProfile): void {
  closeLogin();
  editingLogin = p;
  loginGeneration = currentGeneration();
  $('#login-editor').hidden = false;
  $<HTMLInputElement>('#edit-login-origin').value = p.url;
  $<HTMLInputElement>('#edit-login-username').value = p.username;
  $<HTMLInputElement>('#edit-login-password').value = p.password;
  $<HTMLInputElement>('#edit-login-origin').focus();
}
function closeLogin(): void {
  editingLogin = undefined;
  $('#login-editor').hidden = true;
  $<HTMLFormElement>('#login-editor').reset();
  $<HTMLInputElement>('#edit-login-password').type = 'password';
  $('#edit-login-reveal').setAttribute('aria-pressed', 'false');
}
function editIdentity(p: IdentityProfile): void {
  editingIdentity = p;
  identityGeneration = currentGeneration();
  $('#identity-editor').hidden = false;
  $<HTMLInputElement>('#edit-identity-label').value = p.label;
  $<HTMLTextAreaElement>('#edit-identity-fields').value = JSON.stringify(p.fields, null, 2);
  $<HTMLInputElement>('#edit-identity-label').focus();
}
function closeIdentity(): void {
  editingIdentity = undefined;
  $('#identity-editor').hidden = true;
  $<HTMLFormElement>('#identity-editor').reset();
}
function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function renderBlacklist(origins: string[]): void {
  const list = $('#blacklist');
  list.replaceChildren();
  if (!origins.length) list.textContent = '暂无黑名单网站';
  for (const origin of origins) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = origin;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '恢复保存提示';
    button.setAttribute('aria-label', `恢复 ${origin} 的保存提示`);
    button.addEventListener('click', () => { void run(async () => {
      await send({ type: 'qf.remove_blacklist', origin });
      await refresh();
    }, button); });
    li.append(label, button);
    list.append(li);
  }
}
async function refresh(): Promise<void> {
  const revision = stateRevision;
  const data = await getData();
  if(revision !== stateRevision) return;
  render(data.profiles);
  renderBlacklist(data.blacklist);
}
function downloadJSON(value: unknown, prefix = ''): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  try {
    a.href = url;
    a.download = `quickfill-${prefix}${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
async function doExport(): Promise<void> {
  if (!confirm('导出文件含明文密码，请妥善保管。继续导出?')) return;
  const { profiles } = await getData();
  const payload: ExportPayload = { version: 1, exportedAt: Date.now(), profiles };
  downloadJSON(payload);
}
async function doExportRaw(): Promise<void> {
  if (!confirm('原始备份可能含明文密码与损坏的数据，请妥善保管。继续导出?')) return;
  const response = await send({ type: 'qf.export_raw' });
  if (!response || typeof response !== 'object' || !('raw' in response)) throw new Error('无法读取原始数据备份，请重试');
  downloadJSON(response.raw, 'raw-');
}
async function doImport(file: File): Promise<void> {
  if (file.size > 10 * 1024 * 1024) throw new Error('导入文件不能超过 10 MB');
  let parsed: unknown;
  try { parsed = JSON.parse(await file.text()); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('JSON 解析失败，请检查文件');
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1 || !('profiles' in parsed) || !Array.isArray(parsed.profiles)) {
    throw new Error('文件格式不正确 (version !== 1 或缺少 profiles)');
  }
  const { profiles } = await getData();
  const existing = new Set(profiles.map(profile => profile.id));
  const accepted: Profile[] = [];
  let rejected = 0;
  for (const row of parsed.profiles) {
    if (accepted.length >= MAX_IMPORT || !isProfile(row)) rejected++;
    else accepted.push(row);
  }
  const ids = new Set(accepted.map(profile => profile.id));
  const overwritten = [...ids].filter(id => existing.has(id)).length;
  const added = ids.size - overwritten;
  if (!confirm(`导入预览：新增 ${added} 条，覆盖 ${overwritten} 条，跳过 ${rejected} 条无效或超限记录。\n同 id 以文件中最后一条有效记录为准。确认合并?`)) return;
  const res = await send({ type: 'qf.import', payload: parsed as ExportPayload });
  const counts = res as { imported?: number; rejected?: number };
  $('#notice').textContent = `导入完成：接受 ${counts.imported ?? accepted.length} 条，跳过 ${counts.rejected ?? rejected} 条。`;
  await refresh();
}
async function doClear(): Promise<void> {
  if (!confirm('清空所有登录、身份、黑名单及内部恢复副本? 外部导出文件不会删除。')) return;
  if (!confirm('再次确认: 这会删除当前记录及内部恢复副本。继续?')) return;
  await send({ type: 'qf.clear_all' });
  closeLogin();
  closeIdentity();
  await refresh();
}
async function init(): Promise<void> {
  $('#export-raw').addEventListener('click', () => { void run(doExportRaw, $<HTMLButtonElement>('#export-raw')); });
  $('#export').addEventListener('click', () => { void run(doExport, $<HTMLButtonElement>('#export')); });
  $('#import-file').addEventListener('change', event => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void run(async () => { try { await doImport(file); } finally { input.value = ''; } });
  });
  $('#clear').addEventListener('click', () => { void run(doClear, $<HTMLButtonElement>('#clear')); });
  $('#retry').addEventListener('click', () => { void run(refresh, $<HTMLButtonElement>('#retry')); });
  $('#edit-login-cancel').addEventListener('click', closeLogin);
  $('#edit-login-reveal').addEventListener('click', () => {
    const field = $<HTMLInputElement>('#edit-login-password');
    field.type = field.type === 'password' ? 'text' : 'password';
    $('#edit-login-reveal').setAttribute('aria-pressed', String(field.type === 'text'));
  });
  $('#login-editor').addEventListener('submit', event => {
    event.preventDefault();
    void run(async () => {
      const profile = editingLogin;
      if (!profile) return;
      const url = normalizeOrigin($<HTMLInputElement>('#edit-login-origin').value.trim());
      if (!url) throw new Error('请输入有效的 http(s) 网站地址');
      await send({ type: 'qf.update_profile', create: false, generation: loginGeneration, expectedUpdatedAt: profile.updatedAt,
        profile: { ...profile, url, username: $<HTMLInputElement>('#edit-login-username').value,
          password: $<HTMLInputElement>('#edit-login-password').value, updatedAt: Date.now() } });
      closeLogin();
      await refresh();
    }, $<HTMLButtonElement>('#edit-login-save'));
  });
  $('#edit-identity-cancel').addEventListener('click', closeIdentity);
  $('#identity-editor').addEventListener('submit', event => {
    event.preventDefault();
    void run(async () => {
      const profile = editingIdentity;
      if (!profile) return;
      const label = $<HTMLInputElement>('#edit-identity-label').value.trim();
      if (!label) throw new Error('请输入身份名称');
      let parsed: unknown;
      try { parsed = JSON.parse($<HTMLTextAreaElement>('#edit-identity-fields').value); }
      catch { throw new Error('字段 JSON 解析失败，请检查后重试'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
          Object.entries(parsed).some(([key, value]) => !ALL_TOKENS.includes(key as FieldToken) || !isIdentityToken(key as FieldToken) || typeof value !== 'string')) {
        throw new Error('字段必须是支持的身份 token 与字符串值组成的 JSON 对象');
      }
      const fields: IdentityProfile['fields'] = {};
      for (const token of ALL_TOKENS.filter(isIdentityToken)) fields[token] = (parsed as IdentityProfile['fields'])[token] ?? '';
      await send({ type: 'qf.update_profile', patch: true, create: false, generation: identityGeneration, expectedUpdatedAt: profile.updatedAt,
        profile: { ...profile, label, fields, updatedAt: Date.now() } });
      closeIdentity();
      await refresh();
    }, $<HTMLButtonElement>('#edit-identity-save'));
  });
  $('#token-legend').innerHTML = ALL_TOKENS.filter(isIdentityToken).map(token => `<li><code>${token}</code> — ${TOKEN_LABEL[token]}</li>`).join('');
  await run(refresh);
}
initializeVaultControls();
window.addEventListener('qf-vault-changed', () => { void run(refresh); });
chrome.storage?.onChanged?.addListener((changes,area) => {
  if(area==='local' && changes[GENERATION_KEY]) {
    stateRevision++;
    closeLogin(); closeIdentity(); render([]);renderBlacklist([]);
    $('#notice').textContent='密码库状态已改变，未保存草稿已清除；请解锁后刷新。';
  }
});
void init();
