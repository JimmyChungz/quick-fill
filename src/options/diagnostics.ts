import { send } from '../lib/messaging';
import {
  readSelfStatus,
  storageSummary,
  type SelfStatus,
} from '../lib/diagnostics';

const output = document.getElementById('output')!;
const read = document.getElementById('read') as HTMLButtonElement;

function showSelfStatus(self: SelfStatus): void {
  const installation: Record<SelfStatus['installType'], string> = {
    development: '开发模式安装：本地加载的未打包扩展，请保持开发者模式开启。',
    normal: '常规安装：此 API 无法确认商店来源。',
    admin: '企业策略安装：由管理员管理。',
    sideload: '由其他软件安装。',
    other: '其他安装方式。',
    unknown: '安装方式未知：当前无法读取此项。',
  };
  document.getElementById('installation')!.textContent =
    installation[self.installType];
  document.getElementById('enabled')!.textContent =
    self.enabled === 'unknown'
      ? '启用状态未知：请在 chrome://extensions 查看此扩展。'
      : self.enabled
        ? '扩展已启用。'
        : `扩展已停用，原因：${self.disabledReason}。请在 chrome://extensions 查看提示。`;
  document.getElementById('toolbar')!.textContent =
    self.isOnToolbar === 'unknown'
      ? '工具栏固定状态未知：请在拼图菜单中查看。'
      : self.isOnToolbar
        ? '图标已固定到工具栏；固定状态与扩展启用状态分别判断。'
        : '图标未固定：在 Chrome 右上角的拼图菜单中找到快填，点击图钉固定。图标隐藏不等于卸载。';
}

async function refresh(): Promise<void> {
  if (read.disabled) return;
  read.disabled = true;
  try {
    const id = chrome.runtime.id;
    const version = chrome.runtime.getManifest().version;
    const self = await readSelfStatus();
    showSelfStatus(self);
    const result: Record<string, unknown> = { id, version, self };
    try {
      Object.assign(
        result,
        storageSummary(await chrome.storage.local.get(null), id, version),
      );
      result.localReadable = true;
    } catch {
      result.localReadable = false;
    }
    try {
      result.sync = storageSummary(
        await chrome.storage.sync.get(null),
        id,
        version,
      );
    } catch {
      result.sync = { readable: false };
    }
    try {
      result.sessionKeys = Object.keys(await chrome.storage.session.get(null));
    } catch {
      result.sessionKeys = null;
    }
    try {
      result.legacyLocalStorageKeys = Object.keys(localStorage);
      const raw = localStorage.getItem('qf.stored.v1');
      if (raw)
        result.legacyStore = storageSummary(
          { 'qf.stored.v1': JSON.parse(raw) },
          id,
          version,
        );
    } catch {
      result.legacyLocalStorageReadable = false;
    }
    try {
      result.indexedDbNames = (await indexedDB.databases()).map(
        (db) => db.name ?? '(unnamed)',
      );
    } catch {
      result.indexedDbReadable = false;
    }
    output.textContent = JSON.stringify(result, null, 2);
  } catch {
    showSelfStatus({
      installType: 'unknown',
      enabled: 'unknown',
      disabledReason: 'unknown',
      isOnToolbar: 'unknown',
    });
    output.textContent =
      '无法读取扩展运行信息。请在 chrome://extensions 检查此扩展，再重新打开诊断页。';
  } finally {
    read.disabled = false;
  }
}
read.addEventListener('click', () => {
  void refresh();
});
void refresh();

// This opt-in section changes only short-lived diagnostic state, never profiles.
const traceOutput = document.getElementById('trace-output')!;
async function traceAction(enabled?: boolean): Promise<void> {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-trace]'));
  buttons.forEach(button => button.disabled = true);
  try {
    if (enabled !== undefined) await send({type:'qf.trace_set', enabled});
    const result = await send({type:'qf.trace_read'});
    traceOutput.textContent = JSON.stringify(result, null, 2);
  } catch {
    traceOutput.textContent = '无法读取诊断状态，请重新打开本页。';
  } finally { buttons.forEach(button => button.disabled = false); }
}
document.getElementById('trace-enable')!.addEventListener('click', () => { void traceAction(true); });
document.getElementById('trace-disable')!.addEventListener('click', () => { void traceAction(false); });
document.getElementById('trace-read')!.addEventListener('click', () => { void traceAction(); });
void traceAction();
