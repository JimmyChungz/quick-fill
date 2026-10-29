import { beforeEach, describe, expect, it } from 'vitest';
import { hasVisibleGeometry, isVisible } from '../src/lib/visibility';
import { fillIdentity } from '../src/content/fill';

function layout(el: Element, x = 10, y = 10, width = 180, height = 28, boxes = true) {
  const rect = new DOMRect(x, y, width, height);
  Object.defineProperties(el, {
    getBoundingClientRect: { configurable: true, value: () => rect },
    getClientRects: { configurable: true, value: () => boxes ? [rect] : [] },
  });
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '<section><input></section>';
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 800 });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
});
const field = () => document.querySelector('input')!;
const parent = () => document.querySelector('section')!;

describe('rendered field geometry', () => {
  it.each([
    ['empty client rects', 10, 10, 180, 28, false],
    ['zero width', 10, 10, 0, 28, true],
    ['one pixel box', 10, 10, 1, 1, true],
    ['extreme negative horizontal position', -100000, 10, 180, 28, true],
    ['outside the horizontal document', 100000, 10, 180, 28, true],
    ['above the vertical document', 10, -10000, 180, 28, true],
    ['below the vertical document', 10, 1000000, 180, 28, true],
    ['nonfinite position', Infinity, 10, 180, 28, true],
    ['nonfinite size', 10, 10, NaN, 28, true],
  ] as const)('rejects %s even when checkVisibility reports true', (_, x, y, width, height, boxes) => {
    const el = layout(field(), x, y, width, height, boxes);
    Object.defineProperty(el, 'checkVisibility', { configurable: true, value: () => true });
    expect(isVisible(el)).toBe(false);
  });

  it('keeps a normal field below the current viewport without moving focus or scrolling', () => {
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 15000 });
    const el = layout(field(), 10, 12000);
    expect(isVisible(el)).toBe(true);
    expect(document.activeElement).toBe(document.body);
    expect(window.scrollY).toBe(0);
  });

  it.each([-10000, 1000000])('does not write identity data or dispatch events to an unreachable y=%s field', y => {
    layout(field(), 10, y);
    let inputEvents = 0;
    field().addEventListener('input', () => { inputEvents++; });
    const summary = fillIdentity({
      id: 'synthetic', kind: 'identity', label: 'Synthetic', updatedAt: 0,
      fields: { tel: '5550100' },
    }, [{ el: field(), token: 'tel' }]);
    expect(summary.filled).toBe(0);
    expect(field().value).toBe('');
    expect(inputEvents).toBe(0);
  });

  it('uses transformed rendered geometry rather than CSS width', () => {
    const el = layout(field(), 10, 10, 0.2, 0.2);
    el.setAttribute('style', 'width:200px;height:200px;transform:scale(.001)');
    expect(isVisible(el)).toBe(false);
  });

  it.each(['hidden', 'clip'])('rejects a field reduced to one pixel by overflow:%s', (overflow) => {
    layout(field());
    const ancestor = layout(parent(), 10, 10, 1, 28);
    ancestor.setAttribute('style', `overflow:${overflow}`);
    expect(isVisible(field())).toBe(false);
  });

  it('intersects clipping ancestors cumulatively', () => {
    parent().innerHTML = '<div><input></div>';
    layout(field(), 10, 10, 180, 28);
    layout(parent(), 10, 10, 100, 28).setAttribute('style', 'overflow:hidden');
    layout(document.querySelector('div')!, 109, 10, 100, 28).setAttribute('style', 'overflow:hidden');
    expect(isVisible(field())).toBe(false);
  });

  it('clips only the specified overflow axis', () => {
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 2000 });
    layout(field(), 10, 1000);
    layout(parent(), 10, 10, 200, 28).setAttribute('style', 'overflow-x:clip;overflow-y:visible');
    expect(isVisible(field())).toBe(true);
  });

  it.each(['auto', 'scroll'])('keeps fields reachable in an overflow:%s container', (overflow) => {
    layout(field(), 10, 1000);
    const container = layout(parent(), 10, 10, 200, 28);
    container.setAttribute('style', `overflow:${overflow}`);
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, value: 1028 },
      clientHeight: { configurable: true, value: 28 },
    });
    expect(isVisible(field())).toBe(true);
  });

  it('uses vertical page scroll coordinates for document bounds', () => {
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 1200 });
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 3000 });
    expect(isVisible(layout(field(), 10, -1100))).toBe(true);
    expect(isVisible(layout(field(), 10, -1300))).toBe(false);
    expect(isVisible(layout(field(), 10, 1800))).toBe(false);
  });

  it('keeps an already scrolled container field reachable above the document', () => {
    layout(field(), 10, -900);
    const container = layout(parent(), 10, 10, 200, 100);
    container.setAttribute('style', 'overflow:auto');
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, value: 1100 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, value: 1000 },
    });
    expect(isVisible(field())).toBe(true);
  });

  it('rejects a negative field unreachable within a scrollable container', () => {
    layout(field(), 10, -10000);
    const container = layout(parent(), 10, 10, 200, 100);
    container.setAttribute('style', 'overflow:auto');
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, value: 1100 },
      clientHeight: { configurable: true, value: 100 },
    });
    expect(isVisible(field())).toBe(false);
  });

  it('rejects an unreachable fixed field even on a tall document', () => {
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 3000 });
    layout(field(), 10, 1800).setAttribute('style', 'position:fixed');
    expect(isVisible(field())).toBe(false);
  });

  it.each(['inset(50%)', 'inset(100%)', 'circle(0px at 50% 50%)', 'ellipse(0px 20px at center)'])('rejects collapsed clip-path:%s on an ancestor', (clipPath) => {
    layout(field());
    layout(parent(), 10, 10, 200, 40).setAttribute('style', `clip-path:${clipPath}`);
    expect(isVisible(field())).toBe(false);
  });

  it('rejects one pixel legacy clipping on the field', () => {
    layout(field()).setAttribute('style', 'position:absolute;clip:rect(0px, 1px, 1px, 0px)');
    expect(isVisible(field())).toBe(false);
  });

  it('preserves a field with a substantial noncollapsed inset clip', () => {
    layout(field()).setAttribute('style', 'clip-path:inset(2px)');
    expect(isVisible(field())).toBe(true);
  });
});


describe('explicit rectangle policy', () => {
  const bounds = { left: 0, right: 1200, top: 0, bottom: 10000 };
  it('accepts any surviving rendered fragment with at least a two pixel intersection', () => {
    expect(hasVisibleGeometry([new DOMRect(-100, 0, 10, 20), new DOMRect(1198, 5000, 30, 20)], bounds)).toBe(true);
    expect(hasVisibleGeometry([new DOMRect(1199, 5000, 30, 20)], bounds)).toBe(false);
  });

  it('never expands a one-pixel field into eligibility through scroll reachability', () => {
    expect(hasVisibleGeometry([new DOMRect(10, 1000, 180, 1)], bounds, [{
      rect: new DOMRect(0, 0, 200, 100), x: false, y: true,
      scrollY: { before: 1000, after: 1000 },
    }])).toBe(false);
  });

  it('requires a substantial intersection with both vertical document edges', () => {
    expect(hasVisibleGeometry([new DOMRect(10, -27, 180, 28)], bounds)).toBe(false);
    expect(hasVisibleGeometry([new DOMRect(10, -26, 180, 28)], bounds)).toBe(true);
    expect(hasVisibleGeometry([new DOMRect(10, 9999, 180, 28)], bounds)).toBe(false);
    expect(hasVisibleGeometry([new DOMRect(10, 9998, 180, 28)], bounds)).toBe(true);
  });

  it('rejects malformed clipping geometry rather than treating it as unconstrained', () => {
    expect(hasVisibleGeometry([new DOMRect(10, 10, 180, 28)], bounds, [
      { rect: new DOMRect(NaN, 0, 100, 100), x: true, y: false },
    ])).toBe(false);
  });

  it('uses page scroll coordinates without requiring a vertical viewport intersection', () => {
    expect(hasVisibleGeometry([new DOMRect(-400, 9000, 180, 28)], { left: -500, right: 700, top: -500, bottom: 9500 })).toBe(true);
  });
});


describe('positioned controls and actual overflow containing blocks', () => {
  it.each(['fixed', 'absolute'])('preserves a visible %s field escaping a static overflow ancestor', position => {
    layout(parent(), 10, 10, 1, 1).setAttribute('style', 'overflow:hidden');
    layout(field(), 100, 100, 200, 30).setAttribute('style', `position:${position}`);
    expect(isVisible(field())).toBe(true);
  });

  it('preserves ordinary fields inside a fixed wrapper escaping an outer overflow ancestor', () => {
    parent().innerHTML = '<div style="position:fixed"><input></div>';
    layout(parent(), 10, 10, 1, 1).setAttribute('style', 'overflow:hidden');
    layout(document.querySelector('div')!, 100, 100, 200, 30);
    layout(field(), 100, 100, 200, 30);
    expect(isVisible(field())).toBe(true);
  });

  it('still applies clipping inside a fixed wrapper', () => {
    parent().innerHTML = '<div style="position:fixed;overflow:hidden"><input></div>';
    layout(parent(), 10, 10, 1, 1).setAttribute('style', 'overflow:hidden');
    layout(document.querySelector('div')!, 100, 100, 1, 1);
    layout(field(), 100, 100, 200, 30);
    expect(isVisible(field())).toBe(false);
  });

  it('clips absolute controls at a positioned containing ancestor', () => {
    layout(parent(), 10, 10, 1, 1).setAttribute('style', 'position:relative;overflow:hidden');
    layout(field(), 100, 100, 200, 30).setAttribute('style', 'position:absolute');
    expect(isVisible(field())).toBe(false);
  });

  it.each(['transform:translateX(0)', 'transform-style:preserve-3d', 'translate:0px', 'filter:blur(0px)', 'perspective:100px', 'contain:paint', 'will-change:transform'])('clips fixed controls at a containing ancestor with %s', property => {
    layout(parent(), 10, 10, 1, 1).setAttribute('style', `overflow:hidden;${property}`);
    layout(field(), 100, 100, 200, 30).setAttribute('style', 'position:fixed');
    expect(isVisible(field())).toBe(false);
  });

  it('clips fixed controls when their transformed containing block is inside an outer clip', () => {
    parent().innerHTML = '<div style="transform:translateX(0)"><input style="position:fixed"></div>';
    layout(parent(), 10, 10, 1, 1).setAttribute('style', 'overflow:hidden');
    layout(document.querySelector('div')!, 100, 100, 200, 30);
    layout(field(), 100, 100, 200, 30);
    expect(isVisible(field())).toBe(false);
  });
});
