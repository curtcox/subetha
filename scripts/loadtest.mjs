#!/usr/bin/env node
// Load test (PLAN §14 Phase 3): S subscribers on one topic, P publishers sending N messages each.
// Measures publish latency and publish→receive latency. Every message is charged, so run it
// against staging or local (`wrangler dev`) with a funded test account.
//
//   SUBETHA_URL=http://localhost:8787 SUBETHA_TOKEN=se_… node scripts/loadtest.mjs \
//     --topic @me/load --subscribers 20 --publishers 5 --messages 50
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const base = (process.env.SUBETHA_URL ?? "http://localhost:8787").replace(/\/$/, "");
const token = process.env.SUBETHA_TOKEN;
if (!token) throw new Error("set SUBETHA_TOKEN");
const topic = args.topic ?? "@me/load";
const S = Number(args.subscribers ?? 10), P = Number(args.publishers ?? 4), N = Number(args.messages ?? 25);
const headers = { authorization: `Bearer ${token}` };
const pct = (xs, p) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : NaN);

const sent = new Map();
const recvLatencies = [];
const pubLatencies = [];
let received = 0, errors = 0;
const controllers = [];

async function subscriber() {
  const ctl = new AbortController();
  controllers.push(ctl);
  const r = await fetch(`${base}/${topic}/json`, { headers, signal: ctl.signal });
  if (!r.ok || !r.body) {
    errors++;
    if (errors < 5) console.error("sub failed", r.status, await r.text().catch(() => ""));
    return;
  }
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.event !== "message") continue;
        const t0 = sent.get(m.message);
        if (t0) recvLatencies.push(performance.now() - t0);
        received++;
      }
    }
  } catch { /* aborted */ }
}

async function publisher(p) {
  for (let n = 0; n < N; n++) {
    const body = `load ${p}-${n}-${Math.random().toString(36).slice(2)}`;
    const t0 = performance.now();
    sent.set(body, t0);
    const r = await fetch(`${base}/${topic}`, { method: "POST", headers, body });
    pubLatencies.push(performance.now() - t0);
    if (!r.ok) { errors++; if (errors < 5) console.error(r.status, await r.text()); }
  }
}

const subs = Array.from({ length: S }, subscriber);
await new Promise((r) => setTimeout(r, 1500));
const start = performance.now();
await Promise.all(Array.from({ length: P }, (_, p) => publisher(p)));
await new Promise((r) => setTimeout(r, 3000));
const elapsed = (performance.now() - start) / 1000;
controllers.forEach((c) => c.abort());
await Promise.allSettled(subs);
const total = P * N;
console.log(JSON.stringify({
  topic, subscribers: S, publishers: P, messages: total, errors,
  publish_rps: +(total / elapsed).toFixed(1),
  publish_ms: { p50: +pct(pubLatencies, 50).toFixed(1), p95: +pct(pubLatencies, 95).toFixed(1), p99: +pct(pubLatencies, 99).toFixed(1) },
  delivered: received, expected: total * S,
  delivery_ms: { p50: +pct(recvLatencies, 50).toFixed(1), p95: +pct(recvLatencies, 95).toFixed(1), p99: +pct(recvLatencies, 99).toFixed(1) },
}, null, 2));
