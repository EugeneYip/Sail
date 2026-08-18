import { chromium } from 'playwright';
for (const flags of [
  ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--enable-unsafe-swiftshader'],
  ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'],
]) {
  const b = await chromium.launch({ headless: true, args: flags });
  const p = await b.newPage({ viewport: { width: 640, height: 360 } });
  await p.goto('about:blank');
  const info = await p.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return { ok: false };
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)), vendor: String(gl.getParameter(d.UNMASKED_VENDOR_WEBGL)) };
  });
  console.log(flags.join(' '), '=>', JSON.stringify(info));
  await b.close();
}
