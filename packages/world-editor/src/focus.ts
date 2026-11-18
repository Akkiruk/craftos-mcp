// Focus, caret and scroll survive a redraw: the editors draw their whole view again on every change, and elements
// that matter carry a data-key, so the one that had focus gets it back (with what was typed but not yet sent).

export interface FocusSnapshot {
  key?: string;
  start?: number | null;
  end?: number | null;
  value?: string;
  dirty?: boolean;
  scroll: Record<string, number>;
}

/** What has focus, and how far the elements matching `scrollers` are scrolled. */
export function snapshotFocus(
  scrollers: readonly string[],
  root: ParentNode = document,
): FocusSnapshot {
  const el = document.activeElement as HTMLElement | null;
  const scroll: Record<string, number> = {};
  for (const sel of scrollers) {
    const s = root.querySelector(sel);
    if (s) scroll[sel] = s.scrollTop;
  }
  const key = el?.getAttribute?.("data-key") ?? undefined;
  const out: FocusSnapshot = { key, scroll };
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      out.start = el.selectionStart;
      out.end = el.selectionEnd;
    } catch {
      // number inputs have no selection
    }
    out.value = el.value;
    out.dirty = el.value !== el.defaultValue && el.type !== "search";
  }
  return out;
}

/** Back as it was; `want` (a data-key) gets focus instead when given, scrolled into view. */
export function restoreFocus(
  s: FocusSnapshot,
  want: string | undefined = s.key,
  root: ParentNode = document,
): void {
  for (const [sel, top] of Object.entries(s.scroll)) {
    const el = root.querySelector(sel);
    if (el) el.scrollTop = top;
  }
  if (!want) return;
  const el = Array.from(root.querySelectorAll<HTMLElement>("[data-key]")).find(
    (e) => e.getAttribute("data-key") === want,
  );
  if (!el) return;
  el.focus({ preventScroll: want !== s.key });
  if (want !== s.key) el.scrollIntoView({ block: "nearest" });
  if (
    want === s.key &&
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
  ) {
    if (s.dirty && s.value !== undefined) el.value = s.value;
    try {
      if (s.start != null) el.setSelectionRange(s.start, s.end ?? s.start);
    } catch {
      // number inputs
    }
  }
}
