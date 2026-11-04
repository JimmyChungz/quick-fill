import { traceCapture } from './trace-client';
import { send } from '../lib/messaging';
import { debug } from '../lib/debug';
import type { LoginProfile } from '../lib/types';

const STYLE = `
:host { all: initial; }
.banner {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 2147483647;
  background: #fff;
  border: 1px solid #d0d0d0;
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.18);
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #222;
  width: 320px;
  padding: 12px 36px 12px 14px;
  user-select: none;
  pointer-events: auto;
}
.title { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
/* the message is origin + newline + username — pre-line keeps that a line break */
.msg { font-size: 12px; color: #555; margin-bottom: 10px; word-break: break-all; white-space: pre-line; }
.row { display: flex; gap: 6px; }
button {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid #ccc;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
  font: inherit;
}
button:hover { background: #f0f7ff; }
.primary { background: #3b82f6; color: #fff; border-color: #3b82f6; }
.primary:hover { background: #2563eb; }
.danger { color: #b00; border-color: #e0b0b0; }
.close {
  position: absolute; top: 6px; right: 8px;
  background: transparent; border: none; cursor: pointer;
  font-size: 18px; line-height: 1; color: #888;
  padding: 0; width: 22px; height: 22px;
  flex: 0 0 auto;
}
.close:hover { color: #333; background: #f5f5f5; border-radius: 4px; }
`;

export type SaveBannerOptions = {
  origin: string;
  username: string;
  password: string;
  /**
   * When set, the banner offers to overwrite this row instead of adding a new
   * one — that is what keeps a re-login (or a corrected password) from stacking
   * up duplicate entries.
   */
  existing?: LoginProfile;
  operationId?: string;
  generation?: string;
  needsPersist?: boolean;
  error?: string;
};

export class SaveBanner {
  /** The most recently shown instance, so tests can reach the banner when the
   *  shadow root is closed (N4). Not used by production code. */
  private static _current: SaveBanner | null = null;
  static current(): SaveBanner | null { return SaveBanner._current; }

  private host: HTMLDivElement | null = null;
  private card: HTMLElement | null = null;
  private opts: SaveBannerOptions | null = null;
  private busy = false;
  revision = 0;
  private errorNode: HTMLElement | null = null;

  show(opts: SaveBannerOptions): void {
    this.hide();                      // DOM only — never touches the persisted record
    this.opts = opts;
    this.busy = false;
    const updating = !!opts.existing;

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;';
    // Closed: a page script could otherwise read `.shadowRoot.textContent`
    // (which contains the saved username) and programmatically click
    // 永不保存, silently disabling saving for that site. N4 was only fixed for
    // the Suggest popup at first — this is the same fix for the banner.
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    const banner = document.createElement('div');
    banner.className = 'banner';

    const close = document.createElement('button');
    close.className = 'close';
    close.setAttribute('aria-label', '关闭');
    close.textContent = '\u00d7';
    close.addEventListener('click', () => this.dismiss());

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = updating ? '更新已保存的登录?' : '保存登录到快填?';

    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = opts.origin + (opts.username ? '\n' + opts.username : '');

    const row = document.createElement('div');
    row.className = 'row';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.textContent = updating ? '更新' : '保存';
    saveBtn.addEventListener('click', () => { void this.save(); });

    const blockBtn = document.createElement('button');
    blockBtn.className = 'danger';
    blockBtn.textContent = '永不保存';
    blockBtn.addEventListener('click', () => { void this.blacklist(); });

    row.append(saveBtn, blockBtn);
    const error = document.createElement('div');
    error.setAttribute('role', 'alert'); error.style.color = '#b00';
    error.textContent = opts.error ?? ''; this.errorNode = error;
    banner.append(close, title, msg, error, row);
    root.appendChild(banner);
    document.documentElement.appendChild(host);
    this.host = host;
    this.card = banner;
    SaveBanner._current = this;
    traceCapture('banner_shown', {operationId:opts.operationId});
    debug('banner: shown', opts.origin, updating ? '(update)' : '(new)');
  }

  private async act(type: 'qf.pending_save' | 'qf.pending_blacklist' | 'qf.pending_drop'): Promise<void> {
    const opts = this.opts;
    if (!opts || this.busy) return;
    this.busy = true;
    if (type === 'qf.pending_save') traceCapture('save_click', { operationId: opts.operationId });
    this.revision++;
    const buttons = Array.from(this.card?.querySelectorAll('button') ?? []);
    buttons.forEach(b => b.disabled = true);
    try {
      if (!opts.operationId) throw new Error('候选无效，请重新提交登录');
      if (opts.needsPersist && type !== 'qf.pending_drop') {
        await send({type: 'qf.pending_put', id: opts.operationId, candidate: {origin: opts.origin, username: opts.username, password: opts.password}, generation: opts.generation});
        opts.needsPersist = false;
      }
      if (!opts.needsPersist) {
        if (type === 'qf.pending_save') traceCapture('pending_save_sent', { operationId: opts.operationId });
        const response = await send({type, id: opts.operationId, generation: opts.generation}) as { type?: string };
        if (type === 'qf.pending_save') {
          if (response.type !== 'qf.ok') throw new Error('后台未确认保存，请重试');
          traceCapture('pending_save_ack', { operationId: opts.operationId });
        }
      }
      if (this.opts === opts) this.hide();
    } catch (e) {
      if (type === 'qf.pending_save') traceCapture('pending_save_error', { operationId: opts.operationId, reason: 'storage-error' });
      if (this.opts === opts && this.errorNode) this.errorNode.textContent = e instanceof Error ? e.message : '操作失败，请重试';
    } finally {
      if (this.opts === opts) {
        this.busy = false; buttons.forEach(b => b.disabled = false);
        // A framework may remove the host during the asynchronous write. Keep
        // the failed operation and its retry controls reachable after failure.
        if (this.host && !this.host.isConnected) document.documentElement.append(this.host);
      }
    }
  }
  async save(): Promise<void> { await this.act('qf.pending_save'); }
  async blacklist(): Promise<void> { await this.act('qf.pending_blacklist'); }
  async dismiss(): Promise<void> { await this.act('qf.pending_drop'); }

  /** Removes the UI only. The persisted record is what lets the landing page of a
   *  classic form POST ask again, so it must survive an incidental re-render. */
  hide(): void {
    this.revision++;
    this.opts = null;
    this.errorNode = null;
    this.busy = false;
    if (this.host) {
      this.host.remove();
      this.host = null;
      this.card = null;
      if (SaveBanner._current === this) SaveBanner._current = null;
      traceCapture('banner_hidden');
      debug('banner: hidden');
    }
  }

  isShown(): boolean {
    return this.host?.isConnected ?? false;
  }

  isBusy(): boolean { return this.busy; }
  hasDetachedHost(): boolean { return this.host !== null && !this.host.isConnected && !this.busy; }

  /** Test hook: the `.banner` element inside the closed shadow root. */
  getCard(): HTMLElement | null {
    return this.card;
  }
}
