// Entry point: PORT (default 8080), RELAY_SECRET (required), APNS_UPSTREAM (default production
// APNs; https://api.sandbox.push.apple.com for development builds).
import { createRelay, DEFAULT_UPSTREAM } from "./relay.ts";

const port = Number(process.env.PORT ?? 8080);
const upstream = process.env.APNS_UPSTREAM || DEFAULT_UPSTREAM;
const relay = createRelay({ secret: process.env.RELAY_SECRET ?? "", upstream });
relay.listen(port, () => console.log(`apns-relay listening on :${port} → ${upstream}`));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => relay.close(() => process.exit(0)));
