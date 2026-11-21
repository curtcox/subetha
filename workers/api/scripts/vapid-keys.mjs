#!/usr/bin/env node
// Print a new VAPID key pair for Web Push (same format as generateVapidKeys() in
// src/delivery/webpush.ts). Store them with:
//   wrangler secret put VAPID_PUBLIC_KEY   (base64url, uncompressed 65-byte P-256 point)
//   wrangler secret put VAPID_PRIVATE_KEY  (base64url, raw 32-byte private scalar)
//   wrangler secret put VAPID_SUBJECT      (mailto: or https: contact URL)
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url");
const { d } = await crypto.subtle.exportKey("jwk", kp.privateKey);
console.log(`VAPID_PUBLIC_KEY=${pub}\nVAPID_PRIVATE_KEY=${d}`);
