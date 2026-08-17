/**
 * Save the WebGL canvas as a PNG.
 *
 * The context is created without `preserveDrawingBuffer`, so the drawing buffer
 * is discarded once the frame is composited. The one window where it still
 * holds pixels is inside a requestAnimationFrame callback that runs *after* the
 * engine's own frame callback. Registering from a user-gesture task (a click or
 * a keydown) puts us behind the engine's already-queued callback for the next
 * frame, which is exactly the slot we need — so this must not be called from
 * inside a module update.
 */
export function saveCanvasPng(canvas: HTMLCanvasElement, done: (ok: boolean) => void): void {
  requestAnimationFrame(() => {
    try {
      canvas.toBlob((blob) => {
        if (!blob || blob.size < 2048) {
          done(false);
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `leeward-${stamp()}.png`;
        a.rel = 'noopener';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 20_000);
        done(true);
      }, 'image/png');
    } catch {
      done(false);
    }
  });
}

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
