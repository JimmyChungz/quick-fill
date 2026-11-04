import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as diagnostics from '../src/lib/diagnostics';

it('distinguishes missing store from an empty store and never includes record values', () => {
  const missing = diagnostics.storageSummary({}, 'example-id', '0.2.1');
  expect(missing.hasStore).toBe(false);
  expect(missing.profilesCount).toBeNull();
  const result = diagnostics.storageSummary(
    {
      'qf.stored.v1': {
        version: 1,
        profiles: [
          {
            kind: 'login',
            username: 'private-user',
            password: 'private-password',
          },
        ],
        blacklist: [],
      },
    },
    'example-id',
    '0.2.1',
  );
  expect(result.hasStore).toBe(true);
  expect(result.profilesCount).toBe(1);
  expect(result.loginCount).toBe(1);
  expect(JSON.stringify(result)).not.toContain('private-user');
  expect(JSON.stringify(result)).not.toContain('private-password');
});

let api: any;
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const text = (id: string) => document.getElementById(id)!.textContent!;
const result = () => JSON.parse(text('output'));
async function mount() {
  document.documentElement.innerHTML = readFileSync(
    `${process.cwd()}/public/diagnostics.html`,
    'utf8',
  );
  await import('../src/options/diagnostics');
  await flush();
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  api = {
    runtime: {
      id: 'neilinbkkjgcnflgamepebchiapfcibm',
      getManifest: () => ({ version: '0.2.1' }),
    },
    management: {
      getSelf: vi.fn(async () => ({
        id: 'neilinbkkjgcnflgamepebchiapfcibm',
        installType: 'development',
        enabled: true,
        permissions: ['do-not-report-permissions'],
        description: 'do-not-report-description',
      })),
      getAll: vi.fn(),
    },
    action: {
      getUserSettings: vi.fn(async () => ({
        isOnToolbar: false,
        unexpected: 'do-not-report',
      })),
    },
    storage: Object.fromEntries(
      ['local', 'sync', 'session'].map((area) => [
        area,
        {
          get: vi.fn(async () =>
            area === 'local'
              ? {
                  'qf.stored.v1': {
                    version: 1,
                    profiles: [
                      {
                        kind: 'login',
                        username: 'private-user',
                        password: 'private-password',
                      },
                    ],
                    blacklist: ['https://private.example'],
                  },
                }
              : {},
          ),
          set: vi.fn(),
          remove: vi.fn(),
          clear: vi.fn(),
        },
      ]),
    ),
    downloads: { download: vi.fn() },
  };
  vi.stubGlobal('chrome', api);
  vi.stubGlobal('indexedDB', { databases: vi.fn(async () => []) });
  vi.stubGlobal('fetch', vi.fn());
});

describe('read-only self API diagnostics', () => {
  it('changes only opt-in trace state after an explicit click and can turn it off', async () => {
    const sent:any[] = []; let enabled = false;
    api.runtime.sendMessage = (message:any, callback:any) => {
      sent.push(message);
      if (message.type === 'qf.trace_set') enabled = message.enabled;
      queueMicrotask(() => callback({type:'qf.trace_result',enabled,events:[]}));
    };
    await mount();
    expect(sent.map(m => m.type)).toEqual(['qf.trace_read']);
    expect(text('trace-output')).toContain('false');
    document.getElementById('trace-enable')!.click(); await flush();
    expect(sent).toContainEqual(expect.objectContaining({type:'qf.trace_set',enabled:true}));
    expect(text('trace-output')).toContain('true');
    document.getElementById('trace-disable')!.click(); await flush();
    expect(sent.at(-2)).toMatchObject({type:'qf.trace_set',enabled:false});
    expect(text('trace-output')).toContain('false');
    expect(sent.every(m => ['qf.trace_read','qf.trace_set'].includes(m.type))).toBe(true);
  });
  it('returns only whitelisted self status and distinguishes a hidden icon from disabled extension', async () => {
    await mount();
    expect(result().self).toEqual({
      installType: 'development',
      enabled: true,
      disabledReason: 'unknown',
      isOnToolbar: false,
    });
    expect(text('installation')).toContain('开发模式');
    expect(text('enabled')).toContain('已启用');
    expect(text('toolbar')).toContain('未固定');
    expect(text('toolbar')).toContain('拼图');
    expect(text('output')).not.toContain('do-not-report');
    expect(text('output')).not.toContain('private-user');
    expect(text('output')).not.toContain('private-password');
    expect(text('output')).not.toContain('private.example');
    expect(api.management.getAll).not.toHaveBeenCalled();
    for (const area of ['local', 'sync', 'session']) {
      for (const method of ['set', 'remove', 'clear'])
        expect(api.storage[area][method]).not.toHaveBeenCalled();
    }
    expect(api.downloads.download).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports unavailable APIs as unknown, never disabled or unpinned', async () => {
    delete api.management;
    delete api.action;
    await mount();
    expect(result().self).toEqual({
      installType: 'unknown',
      enabled: 'unknown',
      disabledReason: 'unknown',
      isOnToolbar: 'unknown',
    });
    expect(text('enabled')).toContain('未知');
    expect(text('toolbar')).toContain('未知');
    expect(text('enabled')).not.toContain('已停用');
    expect(text('toolbar')).not.toContain('未固定');
  });

  it('handles rejected and malformed API responses independently and allows retry', async () => {
    api.management.getSelf.mockRejectedValueOnce(
      new Error('API unavailable with private value'),
    );
    api.action.getUserSettings.mockResolvedValueOnce({});
    await mount();
    expect(result().self.enabled).toBe('unknown');
    expect(result().self.isOnToolbar).toBe('unknown');
    expect(text('output')).not.toContain('private value');
    document.getElementById('read')!.click();
    await flush();
    expect(result().self.enabled).toBe(true);
    expect(result().self.isOnToolbar).toBe(false);
    expect(
      (document.getElementById('read') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('preserves known enabled state when the toolbar API rejects and ignores unrecognized status strings', async () => {
    api.management.getSelf.mockResolvedValue({
      installType: 'private-unrecognized-type',
      enabled: true,
      disabledReason: 'private-unrecognized-reason',
    });
    api.action.getUserSettings.mockRejectedValue(
      new Error('private-toolbar-error'),
    );
    await mount();
    expect(result().self).toEqual({
      installType: 'unknown',
      enabled: true,
      disabledReason: 'unknown',
      isOnToolbar: 'unknown',
    });
    expect(text('enabled')).toContain('已启用');
    expect(text('toolbar')).toContain('未知');
    expect(text('output')).not.toContain('private-');
  });

  it('reports disabled state separately from a pinned toolbar icon', async () => {
    api.management.getSelf.mockResolvedValue({
      installType: 'normal',
      enabled: false,
      disabledReason: 'permissions_increase',
    });
    api.action.getUserSettings.mockResolvedValue({ isOnToolbar: true });
    await mount();
    expect(result().self.enabled).toBe(false);
    expect(text('enabled')).toContain('已停用');
    expect(text('enabled')).toContain('permissions_increase');
    expect(text('toolbar')).toContain('已固定');
    expect(text('installation')).toContain('无法确认商店来源');
  });

  it('does not infer uninstall when local reads fail and keeps self diagnostics usable', async () => {
    api.storage.local.get.mockRejectedValue(new Error('private-storage-error'));
    await mount();
    expect(result().self.enabled).toBe(true);
    expect(result().localReadable).toBe(false);
    expect(text('output')).not.toContain('private-storage-error');
    expect(document.body.textContent).toContain('页面打不开');
    expect(document.body.textContent).toContain('不等于卸载');
  });

  it('clears previously shown status if the extension runtime becomes unavailable', async () => {
    await mount();
    api.runtime.getManifest = () => {
      throw new Error('private-runtime-error');
    };
    document.getElementById('read')!.click();
    await flush();
    expect(text('enabled')).toContain('未知');
    expect(text('toolbar')).toContain('未知');
    expect(text('output')).toContain('无法读取');
    expect(text('output')).not.toContain('private-runtime-error');
  });

  it('provides a diagnostics entry point from options and fixed-path operating instructions', () => {
    const options = readFileSync(
      `${process.cwd()}/public/options.html`,
      'utf8',
    );
    const page = readFileSync(
      `${process.cwd()}/public/diagnostics.html`,
      'utf8',
    );
    expect(options).toMatch(/href="diagnostics.html"/);
    expect(page).toContain('开发者模式');
    expect(page).toContain('固定目录');
    expect(page).toContain('移除');
    expect(page).toContain('Chrome Web Store');
  });
});
