import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { after, before, test } from "node:test";

let worker;
let origin;
let output = "";

before(async () => {
  // The build targets workerd and imports cloudflare: modules, so it cannot be
  // loaded by Node. Wrangler serves the actual built worker and static assets.
  worker = spawn(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js", "dev", "--config", "dist/server/wrangler.json",
    "--ip", "127.0.0.1", "--port", "0", "--local", "--show-interactive-dev-session=false",
  ], { env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Wrangler startup timed out: ${output.slice(-4000)}`)), 30000);
    const read = (chunk) => {
      output = (output + chunk.toString()).slice(-20000);
      const match = output.match(/Ready on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); origin = match[1]; resolve(); }
    };
    worker.stdout.on("data", read);
    worker.stderr.on("data", read);
    worker.once("error", (error) => { clearTimeout(timeout); reject(error); });
    worker.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Wrangler exited ${code}: ${output.slice(-4000)}`)); });
  });
});

after(async () => {
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    const exited = once(worker, "exit");
    worker.kill("SIGTERM");
    await exited;
  }
});

async function get(path) {
  return fetch(new URL(path, origin), { redirect: "manual", headers: { accept: "text/html" } });
}

test("root redirects to the default locale and invalid locales return 404", async () => {
  const root = await get("/");
  assert.equal(root.status, 307);
  assert.equal(new URL(root.headers.get("location"), origin).pathname, "/en");
  assert.equal((await get("/not-a-locale")).status, 404);
});

test("built worker server-renders the English anatomy page and its assets", async () => {
  const response = await get("/en");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html\b/);
  const html = await response.text();
  assert.match(html, /<html lang="en" dir="ltr">/);
  assert.match(html, /<main class="app-shell">/);
  assert.match(html, /<h1[^>]*>Heart<\/h1>/);
  assert.match(html, /Organ library/);
  assert.match(html, /Cardiovascular/);
  assert.match(html, /<title>Anatomy Atelier/);
  assert.match(html, /rel="canonical" href="[^"]+\/en"/);
  const stylesheet = html.match(/<link rel="stylesheet"[^>]*href="([^"]+)"/);
  assert.ok(stylesheet, "rendered page links to a stylesheet");
  assert.equal((await get(stylesheet[1])).status, 200);
  const image = await get("/anatomy/heart/thumb.webp");
  assert.equal(image.status, 200);
  assert.match(image.headers.get("content-type"), /^image\/webp/);
});

test("built worker renders translated content and RTL metadata", async () => {
  const response = await get("/ar");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.match(html, /<h1[^>]*>القلب<\/h1>/);
  assert.match(html, /مكتبة الأعضاء/);
  assert.match(html, /rel="canonical" href="[^"]+\/ar"/);
});
