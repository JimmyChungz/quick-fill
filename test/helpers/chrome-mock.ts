// Shared chrome.* mock for tests that need the SW message bus + storage.
// Values are deep-cloned on write/read, matching the real chrome.storage.local
// semantics (the real API serialises, it does not hand out live references).
import type { LoginProfile, Profile, Stored } from '../../src/lib/types';
import { summarizeForContent } from '../../src/lib/message-policy';

export const EXTENSION_ID = 'neilinbkkjgcnflgamepebchiapfcibm';
export const PAGE_SENDER = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/options.html` };

export const STORE_KEY = 'qf.stored.v1';
export const PENDING_KEY = 'qf.pending.v2';

type Any = any;
const clone = <T,>(v: T): T => (v === undefined ? v : structuredClone(v));

export type Harness = {
  store: Map<string, unknown>;
  sent: Any[];
  /** Set the whole stored blob. */
  setStored(stored: Stored): void;
  /** Make the next `n` chrome.storage.local.get calls block until release() runs. */
  gateNextGets(n: number): () => void;
  /** Let onChanged listeners run. */
  pump(): Promise<void>;
  /** Deliver a background notification independently of storage visibility. */
  deliver(message: unknown, sender?: unknown): void;
};

export function installChromeMock(seed: Record<string, unknown> = {}): Harness {
  const store = new Map<string, unknown>(
    Object.entries(seed).map(([k, v]) => [k, clone(v)]),
  );
  const sent: Any[] = [];
  const listeners: Array<(changes: Any, area: string) => void> = [];
  const messageListeners: Array<(message: Any, sender: Any, respond: Any) => void> = [];
  const notifyContent = () => {
    const message = { type: 'qf.data_changed', generation: store.get('qf.generation') ?? '0', locked: false };
    for (const listener of messageListeners) listener(message, { id: EXTENSION_ID }, () => {});
  };


  let gate: Promise<void> | null = null;
  let gatedRemaining = 0;
  const gateNextGets = (n: number): (() => void) => {
    gatedRemaining = n;
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    return release;
  };

  const local = {
    async get(k: string) {
      const snap = { [k]: clone(store.get(k)) };
      if (gatedRemaining > 0) { gatedRemaining--; await gate; }
      return snap;
    },
    async set(obj: Record<string, unknown>) {
      const changes: Any = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: clone(store.get(k)), newValue: clone(v) };
        store.set(k, clone(v));
      }
      for (const l of listeners) l(changes, 'local');
      if (changes[STORE_KEY] || changes['qf.generation']) notifyContent();
    },
    async remove(k: string | string[]) {
      const changes: Any = {};
      for (const kk of Array.isArray(k) ? k : [k]) {
        changes[kk] = { oldValue: clone(store.get(kk)) };
        store.delete(kk);
      }
      for (const l of listeners) l(changes, 'local');
      if (changes[STORE_KEY] || changes['qf.generation']) notifyContent();
    },
  };

  // Emulates src/background/service-worker.ts so content-script tests exercise
  // the real message flow.
  const applyUpsert = (p: Profile): Profile[] => {
    const s: Stored = clone(store.get(STORE_KEY) as Stored) ?? { version: 1, profiles: [], blacklist: [] };
    const i = s.profiles.findIndex((x) => x.id === p.id);
    if (i >= 0) s.profiles[i] = clone(p); else s.profiles.push(clone(p));
    store.set(STORE_KEY, s);
    return s.profiles;
  };
  const decidePending = (candidate: Any): {reason?: 'blacklisted'|'unchanged'; existing?: Profile} => {
    const stored = store.get(STORE_KEY) as Stored | undefined;
    const logins = stored?.profiles.filter((p): p is LoginProfile => p.kind === 'login' && p.url === candidate.origin) ?? [];
    if (stored?.blacklist.includes(candidate.origin)) return {reason:'blacklisted'};
    if (logins.some((p: Any) => p.username === candidate.username && p.password === candidate.password)) return {reason:'unchanged'};
    const matches = logins.filter((p: Any) => candidate.username !== '' && p.username === candidate.username);
    return {existing: matches.length === 1 ? {...clone(matches[0]!),password:''} : undefined};
  };

  const chromeMock: Any = {
    storage: {
      local,
      session: { ...local, async clear() { store.delete(PENDING_KEY); } },
      onChanged: { addListener(fn: (changes: Any, area: string) => void) { listeners.push(fn); } },
    },
    alarms: {create: async () => {}, onAlarm: {addListener() {}}},
    tabs: {onRemoved: {addListener() {}}},
    runtime: {
      id: EXTENSION_ID,
      onMessage: {
        addListener(fn: (message: Any, sender: Any, respond: Any) => void) { messageListeners.push(fn); },
        removeListener(fn: (message: Any, sender: Any, respond: Any) => void) {
          const i = messageListeners.indexOf(fn); if (i >= 0) messageListeners.splice(i, 1);
        },
      },
      lastError: undefined,
      openOptionsPage() { /* noop */ },
      sendMessage(msg: Any, cb?: (r: unknown) => void) {
        sent.push(msg);
        let res: unknown;
        switch (msg?.type) {
          case 'qf.content_profiles': {
            const s = store.get(STORE_KEY) as Stored | undefined;
            res = { type: 'qf.profiles', ...summarizeForContent(s ?? {version:1,profiles:[],blacklist:[]}, location.origin), generation: '0' };
            break;
          }
          case 'qf.fill_profile': {
            const s = store.get(STORE_KEY) as Stored | undefined;
            const profile = s?.profiles.find(p => p.id === msg.id);
            res = profile && (profile.kind !== 'login' || profile.url === location.origin) && msg.generation === '0'
              ? {type:'qf.profile',profile:clone(profile),generation:'0'} : {type:'qf.error',message:'record denied'};
            break;
          }
          case 'qf.get_profiles': {
            const s = store.get(STORE_KEY) as Stored | undefined;
            res = { type: 'qf.profiles', profiles: clone(s?.profiles ?? []), blacklist: clone(s?.blacklist ?? []), generation: '0' };
            break;
          }
          case 'qf.capture_begin':res={type:'qf.ok',generation:'0'};break;
          case 'qf.pending_put':
            {
              const decision = decidePending(msg.candidate);
              if (decision.reason) {store.delete(PENDING_KEY);res={type:'qf.pending',pending:null,generation:'0',reason:decision.reason};break;}
            }
            store.set(PENDING_KEY, {...clone(msg.candidate), id: msg.id, generation: msg.generation ?? '0', tabId: 1, createdAt: Date.now()});
            res = {type: 'qf.pending', pending: clone(store.get(PENDING_KEY)), existing: decidePending(msg.candidate).existing, generation: '0'};
            break;
          case 'qf.pending_get': {
            const p = store.get(PENDING_KEY) as Any;
            if (p && Date.now() - p.createdAt >= 5 * 60 * 1000) store.delete(PENDING_KEY);
            const valid = store.get(PENDING_KEY) as Any;
            const decision = valid && valid.origin === location.origin ? decidePending(valid) : {};
            if (decision.reason) store.delete(PENDING_KEY);
            res = {type: 'qf.pending', pending: valid && valid.origin === location.origin && !decision.reason ? {...clone(valid), id: valid.id ?? 'fixture', generation: '0'} : null, ...decision, generation: '0'};
            break;
          }
          case 'qf.pending_drop':
          case 'qf.pending_save':
          case 'qf.pending_blacklist': {
            const p = store.get(PENDING_KEY) as Any;
            if (!p || (p.id ?? 'fixture') !== msg.id) {res={type:'qf.error',message:'missing pending'}; break;}
            if (msg.type === 'qf.pending_save') {
              const s = store.get(STORE_KEY) as Stored | undefined;
              const matches = s?.profiles.filter((x: Any) => x.kind === 'login' && x.url === p.origin && p.username !== '' && x.username === p.username) ?? [];
              applyUpsert({id: matches.length === 1 ? matches[0]!.id : 'capture-' + msg.id, kind:'login',url:p.origin,username:p.username,password:p.password,updatedAt:Date.now()});
            }
            if (msg.type === 'qf.pending_blacklist') {
              const s: Stored = clone(store.get(STORE_KEY) as Stored) ?? {version:1,profiles:[],blacklist:[]};
              s.blacklist.push(p.origin);store.set(STORE_KEY,s);
            }
            store.delete(PENDING_KEY);res={type:'qf.ok',generation:'0'};break;
          }
          case 'qf.touch_profile':res={type:'qf.ok',generation:'0'};break;
          case 'qf.update_profile':
            res = { type: 'qf.profiles', profiles: applyUpsert(msg.profile) };
            break;
          case 'qf.delete_profile': {
            const s: Stored = clone(store.get(STORE_KEY) as Stored) ?? { version: 1, profiles: [], blacklist: [] };
            s.profiles = s.profiles.filter((p) => p.id !== msg.id);
            store.set(STORE_KEY, s);
            res = { type: 'qf.profiles', profiles: s.profiles };
            break;
          }
          case 'qf.add_blacklist': {
            const s: Stored = clone(store.get(STORE_KEY) as Stored) ?? { version: 1, profiles: [], blacklist: [] };
            if (!s.blacklist.includes(msg.origin)) s.blacklist.push(msg.origin);
            store.set(STORE_KEY, s);
            res = { type: 'qf.profiles', profiles: s.profiles };
            break;
          }
          default:
            res = { type: 'qf.error', message: `unmocked message: ${String(msg?.type)}` };
        }
        if (cb) Promise.resolve(res).then(cb);
        return Promise.resolve(res);
      },
    },
  };

  (globalThis as unknown as Record<string, unknown>).chrome = chromeMock;

  return {
    store,
    sent,
    // Goes through the real `set` path so onChanged listeners fire, exactly as
    // they would when another surface writes.
    setStored(stored: Stored) { void local.set({ [STORE_KEY]: stored }); },
    gateNextGets,
    async pump() { for (let i = 0; i < 4; i++) await Promise.resolve(); },
    deliver(message, sender = { id: EXTENSION_ID }) { for (const listener of messageListeners) listener(message, sender, () => {}); },
  };
}

export function loginProfile(over: Partial<Profile> = {}): Profile {
  return {
    id: 'L1', kind: 'login', url: 'https://site.example',
    username: 'alice', password: 'secret', updatedAt: 1,
    ...over,
  } as Profile;
}
