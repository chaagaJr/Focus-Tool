// Local stand-in for Supabase, for trying the app on your PC without deploying anything.
//   node tests/dev-server.mjs
// Then: serve the app folder (e.g. `npx serve app` or `python -m http.server -d app 8080`),
// open http://localhost:8080, Settings → URL http://localhost:8787/functions/v1/focus, key dev-key.
// Data lives in memory and push notifications are only logged.
import { register } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, copyFileSync } from 'node:fs';

register('./mocks/loader.mjs', import.meta.url);
const ENV = { FOCUS_KEY: process.env.FOCUS_KEY || 'dev-key', SUPABASE_URL: 'http://memory', SUPABASE_SERVICE_ROLE_KEY: 'dev' };
let handler;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (/^https?:\/\/(localhost|127\.)/.test(String(url))) return realFetch(url, opts);
  console.log('[push]', String(url).slice(0, 60));
  return new Response('', { status: 201 });
};
const { pushed } = await import('./mocks/pushforge.mjs');
mkdirSync(new URL('./.tmp/', import.meta.url), { recursive: true });
const dest = new URL('./.tmp/focus-dev.mjs', import.meta.url);
copyFileSync(new URL('../supabase/functions/focus/index.ts', import.meta.url), dest);
await import(dest.href);

const port = +(process.env.PORT || 8787);
createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const r = await handler(new Request(`http://localhost:${port}${req.url}`, {
    method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  }));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
  const last = pushed.at(-1);
  if (last && !last.logged) { last.logged = true; console.log('[notification]', last.payload.title, '|', last.payload.body); }
}).listen(port, () => console.log(`Fake Supabase function on http://localhost:${port}/functions/v1/focus  (key: ${ENV.FOCUS_KEY})`));

// Pretend to be the cron job.
if (!process.env.NO_TICK) setInterval(() => realFetch(`http://localhost:${port}/functions/v1/focus`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-focus-key': ENV.FOCUS_KEY }, body: '{"action":"tick"}',
}).catch(() => {}), 60000);
