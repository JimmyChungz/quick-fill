import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { detectField } from '../src/lib/heuristics';
import { setValue } from '../src/content/fill';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, '..', 'public', 'qf-test.html');
const HTML = readFileSync(HTML_PATH, 'utf-8');

// One JSDOM instance for the whole suite — fixtures are static.
const dom = new JSDOM(HTML);
const doc = dom.window.document;
const inputs = Array.from(doc.querySelectorAll<HTMLInputElement>('input'));

interface Row { id: string; section: string; expected: string; actual: string; ok: boolean; skipped: boolean; }

function sectionOf(el: Element): string {
  const h2 = el.closest('section')?.querySelector('h2')?.textContent ?? '(unknown)';
  return h2.trim().slice(0, 40);
}

describe('qf-test.html — field detection', () => {
  const rows: Row[] = [];

  for (const el of inputs as HTMLInputElement[]) {
    const qf = el.getAttribute('data-qf');
    if (!qf) continue;
    const expected = el.getAttribute('data-qf-expect') ?? '';
    if (!expected) continue;
    const actual = detectField(el) ?? 'null';
    const skipped = el.getAttribute('data-qf-skipped') === 'true';
    rows.push({ id: qf, section: sectionOf(el), expected, actual, ok: expected === actual, skipped });
  }

  it('every input matches its expected token', () => {
    const passed = rows.filter((r) => r.ok).length;
    const failed = rows.filter((r) => !r.ok);

    // eslint-disable-next-line no-console
    console.log(`\n  Field detection: ${passed} / ${rows.length} passed`);

    if (failed.length > 0) {
      // eslint-disable-next-line no-console
      console.log('  Mismatches:');
      for (const f of failed) {
        // eslint-disable-next-line no-console
        console.log(`    ✗ [${f.section}] ${f.id}: expected="${f.expected}" actual="${f.actual}"`);
      }
    }

    expect(failed).toEqual([]);
  });

  it.each(['① W3C autocomplete', '② 英文 name/id', '③ 中文 placeholder', '④ "烂站"风格', '⑤ Edge cases', '⑥ React 风格受控组件'])(
    '%s section all match',
    (label) => {
      const sectionRows = rows.filter((r) => r.section.startsWith(label[0]!));
      expect(sectionRows.length).toBeGreaterThan(0);
      const failed = sectionRows.filter((r) => !r.ok);
      // eslint-disable-next-line no-console
      console.log(`  ${label}: ${sectionRows.length - failed.length} / ${sectionRows.length}`);
      expect(failed).toEqual([]);
    },
  );
});

describe('qf-test.html — fill skip behavior', () => {
  it.each(['t5-dispnone', 't5-vishidden'])('does not write hidden fixture field %s', (id) => {
    const source = inputs.find(el => el.dataset.qf === id)!;
    expect(source).toBeDefined();
    const el = document.importNode(source, true);
    document.body.append(el);
    expect(setValue(el, 'secret')).toBe(false);
    expect(el.value).toBe('');
  });

  it('fields marked data-qf-skipped="true" are not writable', () => {
    // Import skipped inputs into vitest's own jsdom document so the
    // global HTMLInputElement class matches (fill.ts uses instanceof).
    const skippedInputs: HTMLInputElement[] = (inputs as HTMLInputElement[]).filter(
      (el) => el.getAttribute('data-qf-skipped') === 'true',
    );
    expect(skippedInputs.length).toBeGreaterThan(0);

    for (const src of skippedInputs) {
      const el: HTMLInputElement = document.importNode(src, true) as HTMLInputElement;
      document.body.appendChild(el);
      const before = el.value;
      const written = setValue(el, 'should-not-stick');
      expect(written).toBe(false);
      expect(el.value).toBe(before);
    }
  });

  it('non-skipped fields ARE writable (sanity)', () => {
    const src = (inputs as HTMLInputElement[]).find((el) => {
      const qf = el.getAttribute('data-qf');
      return qf !== null && el.getAttribute('data-qf-skipped') !== 'true' && el.getAttribute('data-qf-expect') !== null;
    });
    expect(src).toBeDefined();
    if (src) {
      const el: HTMLInputElement = document.importNode(src, true) as HTMLInputElement;
      document.body.appendChild(el);
      const written = setValue(el, 'test-value');
      expect(written).toBe(true);
    }
  });
});
