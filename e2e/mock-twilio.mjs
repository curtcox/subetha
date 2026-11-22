// A stand-in for Twilio's REST API, for the escalation E2E tests: records each SMS and call the
// relay makes (TWILIO_API_BASE points here) and lists them at GET /__calls?to=+1….
import { createServer } from "node:http";

export function startMockTwilio(port) {
  const calls = [];
  let n = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (req.method === "GET" && url.pathname === "/__calls") {
      const to = url.searchParams.get("to");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(calls.filter((c) => !to || c.to === to)));
      return;
    }
    const m = /^\/2010-04-01\/Accounts\/[^/]+\/(Messages|Calls)\.json$/.exec(url.pathname);
    if (req.method !== "POST" || !m) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = Object.fromEntries(new URLSearchParams(body));
      const sms = m[1] === "Messages";
      const sid = `${sms ? "SM" : "CA"}mock${++n}`;
      calls.push({ kind: sms ? "sms" : "voice", sid, to: p.To, from: p.From, body: p.Body, twiml: p.Twiml, status_callback: p.StatusCallback, auth: req.headers.authorization, time: Date.now() });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify(sms ? { sid, num_segments: "1", status: "queued" } : { sid, status: "queued" }));
    });
  });
  server.listen(port);
  return server;
}
