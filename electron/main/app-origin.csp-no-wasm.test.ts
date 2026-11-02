import { expect, it } from 'vitest';
import { APP_ORIGIN, buildCsp, createAppOriginHandler } from './app-origin.ts';

const directive = (csp: string, name: string): string => csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + ' ')) ?? '';

it.each([true, false])('page csp contains neither wasm-unsafe-eval nor unsafe-eval: packaged=%s', (packaged) => {
  const csp = buildCsp({ packaged });
  expect(csp).not.toMatch(/wasm-unsafe-eval|unsafe-eval/);
  expect(directive(csp, 'script-src')).toBe("script-src 'self'");
  expect(directive(csp, 'style-src-attr')).toBe("style-src-attr 'unsafe-inline'");
  expect(directive(csp, 'connect-src')).toContain('https: wss:');
  if (packaged) expect(csp).not.toMatch(/http:|ws:\/\//);
  else expect(directive(csp, 'connect-src')).toContain('http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*');
});

it.each([true, false])('every html and script response carries exactly the buildCsp output: packaged=%s', async (packaged) => {
  const handler = createAppOriginHandler({ packaged, rendererRoot: process.cwd(), readFile: async () => new Uint8Array([1]), passthrough: async () => new Response() });
  for (const path of ['/', '/index-electron.html', '/app.js', '/worker.mjs']) {
    const response = await handler(new Request(APP_ORIGIN + path));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBe(buildCsp({ packaged }));
  }
});
