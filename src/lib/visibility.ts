type Rect = Pick<DOMRectReadOnly, 'left' | 'right' | 'top' | 'bottom'>;
type Clip = { rect: Rect; x: boolean; y: boolean; scrollY?: { before: number; after: number } };

/** Rectangle policy, separate from DOM layout so its boundary cases can be tested. */
export function hasVisibleGeometry(
  rects: readonly Rect[],
  bounds: Rect,
  clips: readonly Clip[] = [],
): boolean {
  if (![bounds.left, bounds.right, bounds.top, bounds.bottom].every(Number.isFinite)) return false;
  return rects.some(rect => {
    if (![rect.left, rect.right, rect.top, rect.bottom].every(Number.isFinite)) return false;
    let left = Math.max(rect.left, bounds.left);
    let right = Math.min(rect.right, bounds.right);
    let { top, bottom } = rect;
    for (const clip of clips) {
      if (right - left < 2 || bottom - top < 2) return false;
      if (![clip.rect.left, clip.rect.right, clip.rect.top, clip.rect.bottom].every(Number.isFinite)) return false;
      if (clip.x) {
        left = Math.max(left, clip.rect.left);
        right = Math.min(right, clip.rect.right);
      }
      if (clip.scrollY) {
        // Union of positions reachable by this container's normal vertical scroll.
        top -= clip.scrollY.after;
        bottom += clip.scrollY.before;
      }
      if (clip.y) {
        top = Math.max(top, clip.rect.top);
        bottom = Math.min(bottom, clip.rect.bottom);
      }
    }
    top = Math.max(top, bounds.top);
    bottom = Math.min(bottom, bounds.bottom);
    // Reject zero-size / one-pixel hiding tricks while retaining small normal controls.
    return right - left >= 2 && bottom - top >= 2;
  });
}

function length(value: string, size: number): number | undefined {
  if (!/^-?(?:\d*\.)?\d+(?:px|%)?$/.test(value)) return undefined;
  return parseFloat(value) * (value.endsWith('%') ? size / 100 : 1);
}

/** Handle common rectangular clips and shapes that are certainly collapsed.
 * Arbitrary SVG paths, masks, rotation and pixel occlusion are outside this policy.
 */
function shapeClip(style: CSSStyleDeclaration, rect: Rect): Rect | undefined {
  const path = style.clipPath;
  const inset = /^inset\(([^)]*)\)$/.exec(path);
  if (inset) {
    const values = inset[1]!.split(/\s+round\s+/)[0]!.trim().split(/\s+/);
    if (values.length > 4) return undefined;
    const [t, r = t, b = t, l = r] = values;
    const top = length(t!, rect.bottom - rect.top);
    const right = length(r!, rect.right - rect.left);
    const bottom = length(b!, rect.bottom - rect.top);
    const left = length(l!, rect.right - rect.left);
    if (top !== undefined && right !== undefined && bottom !== undefined && left !== undefined) {
      return { left: rect.left + left, right: rect.right - right, top: rect.top + top, bottom: rect.bottom - bottom };
    }
  }
  if (/^circle\(0(?:px|%)?(?:\s|\))/.test(path)
    || /^ellipse\((?:0(?:px|%)?\s+[^ ]+|[^ ]+\s+0(?:px|%)?)(?:\s|\))/.test(path)) {
    return { left: rect.left, right: rect.left, top: rect.top, bottom: rect.top };
  }
  const legacy = /^rect\(([^)]*)\)$/.exec(style.clip);
  if (legacy && (style.position === 'absolute' || style.position === 'fixed')) {
    const values = legacy[1]!.trim().split(/[,\s]+/);
    if (values.length !== 4) return undefined;
    const offsets = values.map((value, i) => value === 'auto'
      ? (i === 1 ? rect.right - rect.left : i === 2 ? rect.bottom - rect.top : 0)
      : length(value, 0));
    if (offsets.every(value => value !== undefined)) {
      return { top: rect.top + offsets[0]!, right: rect.left + offsets[1]!, bottom: rect.top + offsets[2]!, left: rect.left + offsets[3]! };
    }
  }
  return undefined;
}

function establishesContainingBlock(style: CSSStyleDeclaration, position: 'absolute' | 'fixed'): boolean {
  if (style.display === 'contents') return false;
  if (position === 'absolute' && style.position && style.position !== 'static') return true;
  return [style.transform, style.translate, style.rotate, style.scale, style.perspective,
    style.filter, style.backdropFilter].some(value => !!value && value !== 'none')
    || /(?:^|\s)(layout|paint|strict|content)(?:\s|$)/.test(style.contain)
    || style.transformStyle === 'preserve-3d'
    || style.contentVisibility === 'auto'
    || style.willChange.split(',').some(value => /^(transform|translate|rotate|scale|perspective|filter|backdrop-filter|contain)$/.test(value.trim()));
}

/** Bounded rendered-geometry policy; does not focus, scroll, or require the current viewport. */
export function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;
  if (!el.isConnected) return false;
  const clips: Clip[] = [];
  let escaping: 'absolute' | 'fixed' | null = null;
  for (let current: HTMLElement | null = el; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
    const cs = getComputedStyle(current);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse'
      || cs.opacity === '0' || cs.contentVisibility === 'hidden') return false;
    const rect = current.getBoundingClientRect();
    const shape = shapeClip(cs, rect);
    if (shape) clips.push({ rect: shape, x: true, y: true });
    // A positioned descendant escapes overflow ancestors between itself and
    // its containing block. A transformed/contained ancestor can bind fixed
    // descendants too; once reached, outer overflow clips apply normally.
    if (current !== el && escaping && establishesContainingBlock(cs, escaping)) escaping = null;
    if (current !== el && !escaping) {
      // Project reachable vertical positions through each inner scroll container
      // before applying outer clips and final document bounds.
      const x = /^(hidden|clip)$/.test(cs.overflowX || cs.overflow);
      const overflowY = cs.overflowY || cs.overflow;
      const scrollRange = Math.max(0, current.scrollHeight - current.clientHeight);
      const scrollableY = current !== el.ownerDocument.body && current !== el.ownerDocument.documentElement
        && /^(auto|scroll)$/.test(overflowY) && current.clientHeight > 0 && scrollRange > 0;
      const y = /^(hidden|clip)$/.test(overflowY) || scrollableY;
      const before = Math.min(scrollRange, Math.max(0, current.scrollTop));
      // Scroll offsets use layout pixels; compare them with rendered geometry.
      const scaleY = current.offsetHeight > 0 ? rect.height / current.offsetHeight : 1;
      if (x || y) clips.push({ rect: {
        left: rect.left + (parseFloat(cs.borderLeftWidth) || 0),
        right: rect.right - (parseFloat(cs.borderRightWidth) || 0),
        top: rect.top + (parseFloat(cs.borderTopWidth) || 0),
        bottom: rect.bottom - (parseFloat(cs.borderBottomWidth) || 0),
      }, x, y, ...(scrollableY ? { scrollY: { before: before * scaleY, after: (scrollRange - before) * scaleY } } : {}) });
    }
    if (!escaping && (cs.position === 'absolute' || cs.position === 'fixed')) escaping = cs.position;
  }
  const cv = (el as HTMLElement & { checkVisibility?: (opts?: unknown) => boolean }).checkVisibility;
  if (typeof cv === 'function') {
    try {
      if (!cv.call(el, { checkOpacity: true, checkVisibilityCSS: true })) return false;
    } catch { /* Older implementations still require the geometry and CSS checks. */ }
  }
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  if (!view) return false;
  const width = Math.max(doc.documentElement.scrollWidth, doc.documentElement.clientWidth,
    doc.body?.scrollWidth ?? 0, view.innerWidth);
  const height = Math.max(doc.documentElement.scrollHeight, doc.documentElement.clientHeight,
    doc.body?.scrollHeight ?? 0, view.innerHeight);
  // Unbound fixed controls cannot be reached by scrolling the document.
  const fixed = escaping === 'fixed';
  // Document coordinates retain long forms and account for current page scrolling.
  return hasVisibleGeometry(Array.from(el.getClientRects()), {
    left: -view.scrollX, right: width - view.scrollX,
    top: fixed ? 0 : -view.scrollY, bottom: fixed ? view.innerHeight : height - view.scrollY,
  }, clips);
}
