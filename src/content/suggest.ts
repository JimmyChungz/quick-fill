import type { LoginProfile, IdentityProfile } from '../lib/types';
import type { DetectedField } from './auto-detect';
import { debug } from '../lib/debug';

const STYLE = `
:host { all: initial; }
.card {
  position: absolute;
  z-index: 2147483647;
  background: #fff;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.18);
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #222;
  min-width: 200px;
  max-width: 320px;
  padding: 4px 0;
  user-select: none;
  /* pointer-events is inherited: the host sets none so clicks pass through the
     transparent wrapper, so the visible card must opt back in. */
  pointer-events: auto;
}
.item {
  padding: 6px 10px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.item:hover, .item.focus { background: #f0f7ff; }
.sub {
  color: #888;
  font-size: 11px;
  margin-left: 6px;
}
.badge {
  display: inline-block;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  margin-right: 6px;
  vertical-align: 1px;
  font-weight: 600;
  letter-spacing: 0.3px;
}
.badge.login { background: #dbeafe; color: #1d4ed8; }
.badge.identity { background: #d1fae5; color: #047857; }
.empty {
  padding: 8px 10px;
  color: #888;
  font-style: italic;
}
`;


export type MixedItem = {
  label: string;
  sub?: string;
  badge?: 'login' | 'identity';
  /** The token(s) this profile can actually fill on the current form, with how many. */
  fillableTokens?: string[];
  onPick: () => void;
};

export type SuggestOptions =
  | {
      kind: 'login';
      target: HTMLElement;
      profiles: LoginProfile[];
      onPick: (p: LoginProfile) => void;
    }
  | {
      kind: 'identity';
      target: HTMLElement;
      profiles: IdentityProfile[];
      fields: DetectedField[];
      doFill: (p: IdentityProfile, fields: DetectedField[]) => void;
    }
  | {
      kind: 'mixed';
      target: HTMLElement;
      items: MixedItem[];
    };

/**
 * Closed shadow DOM: page scripts cannot read the popup's textContent or
 * programmatically click its buttons. v2 audit (N4) verified the previous open
 * shadow leaked usernames and allowed page to auto-click 永不保存 — closed
 * mode blocks both. We keep the card reference as an instance field because
 * `this.host.shadowRoot` is null under mode: 'closed'.
 */
export class Suggest {
  /** The most recently shown instance, so tests can reach the Suggest when the
   *  shadow root is closed (N4). Not used by production code. */
  private static _current: Suggest | null = null;
  static current(): Suggest | null { return Suggest._current; }

  private host: HTMLDivElement | null = null;
  private card: HTMLElement | null = null;
  private target: HTMLElement | null = null;
  private raf = 0;
  private detachObserver: MutationObserver | null = null;

  show(opts: SuggestOptions): void {
    this.hide();
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    const card = document.createElement('div');
    card.className = 'card';
    // Keep focus on the input when the user mousedowns on the popup, so the
    // page does not blur/close the field while we are filling it.
    card.addEventListener('mousedown', (e) => { e.preventDefault(); });

    if (opts.kind === 'mixed') {
      if (opts.items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '无可选项';
        card.appendChild(empty);
      } else {
        opts.items.forEach((item, idx) => {
          const row = document.createElement('div');
          row.className = 'item' + (idx === 0 ? ' focus' : '');
          if (item.badge) {
            const badge = document.createElement('span');
            badge.className = `badge ${item.badge}`;
            badge.textContent = item.badge === 'login' ? '登录' : '身份';
            row.appendChild(badge);
          }
          const main = document.createElement('span');
          main.textContent = item.label;
          row.appendChild(main);
          if (item.sub) {
            const sub = document.createElement('span');
            sub.className = 'sub';
            sub.textContent = item.sub;
            row.appendChild(sub);
          }
          row.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            item.onPick();
            this.hide();
          });
          card.appendChild(row);
        });
      }
    } else if (opts.profiles.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = opts.kind === 'login' ? '无已保存的登录' : '无已保存的身份';
      card.appendChild(empty);
    } else {
      opts.profiles.forEach((p, idx) => {
        const item = document.createElement('div');
        item.className = 'item' + (idx === 0 ? ' focus' : '');
        const label = document.createElement('span');
        if (p.kind === 'login') {
          label.textContent = p.username || '(空用户名)';
          const sub = document.createElement('span');
          sub.className = 'sub';
          sub.textContent = p.url;
          label.appendChild(sub);
        } else {
          label.textContent = p.label || '(未命名身份)';
        }
        item.appendChild(label);
        item.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (opts.kind === 'login') opts.onPick(p as LoginProfile);
          else opts.doFill(p as IdentityProfile, opts.fields);
          this.hide();
        });
        card.appendChild(item);
      });
    }

    root.appendChild(card);
    document.documentElement.appendChild(host);
    this.host = host;
    this.card = card;
    this.target = opts.target;
    Suggest._current = this;
    this.position(opts.target);
    window.addEventListener('scroll', this.onViewportChange, true);
    window.addEventListener('resize', this.onViewportChange);

    // N9: SPA DOM swap removes the focused field. The popup's only sane
    // reaction is to dismiss itself rather than float over a dead input.
    this.detachObserver = new MutationObserver(() => {
      if (this.target && !this.target.isConnected) this.hide();
    });
    this.detachObserver.observe(document.documentElement, { childList: true, subtree: true });

    const count = opts.kind === 'mixed' ? opts.items.length : opts.profiles.length;
    debug(`suggest: shown ${count} items`);
  }

  /**
   * The host is position:fixed, so its coordinates are viewport-based and go
   * stale as soon as the page moves — without this the card drifts away from the
   * field it belongs to. rAF-throttled because scroll fires continuously.
   */
  private onViewportChange = (): void => {
    if (this.raf) return;
    const raf = globalThis.requestAnimationFrame
      ?? ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16) as unknown as number);
    this.raf = raf(() => {
      this.raf = 0;
      if (this.target?.isConnected) this.position(this.target);
    });
  };

  private detachViewportListener(): void {
    window.removeEventListener('scroll', this.onViewportChange, true);
    window.removeEventListener('resize', this.onViewportChange);
    if (this.raf) {
      globalThis.cancelAnimationFrame?.(this.raf);
      this.raf = 0;
    }
  }

  private position(target: HTMLElement): void {
    if (!this.host) return;
    const r = target.getBoundingClientRect();
    // closed shadow: this.card is the only card reference we can keep.
    const height = this.card?.getBoundingClientRect().height ?? 0;
    const below = r.bottom + 2;
    const flip = height > 0 && below + height > window.innerHeight && r.top - height - 2 > 0;
    this.host.style.left = `${r.left}px`;
    this.host.style.top = flip ? `${r.top - height - 2}px` : `${below}px`;
  }

  hide(): void {
    if (this.host) {
      this.host.remove();
      this.host = null;
      this.target = null;
      this.card = null;
      if (Suggest._current === this) Suggest._current = null;
      this.detachViewportListener();
      this.detachObserver?.disconnect();
      this.detachObserver = null;
      debug('suggest: hidden');
    }
  }

  isShown(): boolean {
    return this.host !== null;
  }

  getHost(): HTMLElement | null {
    return this.host;
  }
  getCard(): HTMLElement | null {
    return this.card;
  }
}
