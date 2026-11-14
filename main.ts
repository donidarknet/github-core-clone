// main.ts — lifecycle: bind an ephemeral port, register with the env, long-poll
// GET $MAKEFUN_ENV_URL/done until {"done": true}, exit 0.
// (Kept from the starter: this file is the entrypoint the harness runs.)
import { createApp } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL;
if (!ENV_URL) {
  console.error('MAKEFUN_ENV_URL is required');
  process.exit(1);
}

async function register(port) {
  let delayMs = 250;
  const started = Date.now();
  while (true) {
    const res = await fetch(`${ENV_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 200 || res.status === 409) return;
    if (res.status === 400 || res.status === 405) {
      throw new Error(`register failed: ${res.status}`);
    }
    if (Date.now() - started > 30_000) throw new Error('register timed out');
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(delayMs * 2, 2000);
  }
}

async function waitDone() {
  while (true) {
    const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(30_000) });
    const json = await res.json();
    if (json && json.done === true) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  const app = createApp();
  await new Promise((resolve, reject) => {
    app.on('error', reject);
    app.listen(0, () => resolve());
  });
  const port = app.address().port;
  await register(port);
  await waitDone();
  await new Promise((resolve) => app.close(() => resolve()));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
