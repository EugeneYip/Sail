/**
 * Browser-level zoom recovery, for iPad and phones.
 *
 * THE PROBLEM. iOS Safari has ignored `user-scalable=no` since iOS 10, so the
 * viewport meta in `index.html` does not stop the page being zoomed. `styles.css`
 * now sets `touch-action: manipulation` on the body, which removes the accidental
 * DOUBLE-TAP trigger while leaving a deliberate pinch alone — but a pinch that
 * starts on the body still zooms, and once it has, the way back is blocked: the
 * zoomed screen is mostly `#viewport`, which carries `touch-action: none` because
 * the canvas has to swallow drags, so Safari never sees the gesture that would
 * zoom out again. The player is stranded at 2-3x with part of the UI off-screen
 * and no way home but a reload. That is the reported failure.
 *
 * THE TRADE-OFF, stated. Restoring the zoom automatically means a deliberate pinch
 * does not stick. That is a real cost, and it is taken deliberately: the product
 * already declares `user-scalable=no`, the zoomed view of a WebGL canvas is a
 * magnified bitmap that carries no extra detail, and the alternative on this
 * layout is a state the user cannot leave. Prevention is preferred over recovery
 * wherever it is possible — hence the CSS above — and this only fires when
 * prevention has already been bypassed.
 *
 * It debounces, so it never fights a pinch that is still in progress, and it
 * re-syncs the app's own sizing afterwards because nothing in the engine listens
 * to `visualViewport` at all.
 */

/** Scale above which the page counts as zoomed. Well clear of rounding. */
const ZOOM_EPS = 1.02;
/** Quiet time after the last viewport event before restoring, ms. */
const SETTLE_MS = 450;

export function installZoomGuard(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};

  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  let timer: number | undefined;

  /**
   * Safari re-reads the viewport meta when its content changes, and re-reading it
   * with a fixed maximum-scale is the only way a page can put the zoom back. The
   * value is restored on the next frame so pinch is available again afterwards.
   */
  const resetZoom = (): void => {
    if (!meta) return;
    const original = meta.content;
    meta.content = `${original}, maximum-scale=1.0`;
    requestAnimationFrame(() => {
      meta.content = original;
      // Nothing in the engine watches visualViewport, so tell it the size story
      // may have changed and let its own resize path re-derive everything.
      window.dispatchEvent(new Event('resize'));
    });
  };

  const onChange = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (vv.scale > ZOOM_EPS) {
        // Anything scrolled out of reach comes back first, then the scale.
        window.scrollTo(0, 0);
        resetZoom();
      }
    }, SETTLE_MS);
  };

  vv.addEventListener('resize', onChange);
  vv.addEventListener('scroll', onChange);
  return () => {
    window.clearTimeout(timer);
    vv.removeEventListener('resize', onChange);
    vv.removeEventListener('scroll', onChange);
  };
}
