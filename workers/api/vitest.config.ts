import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { generateKeyPairSync } from "node:crypto";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  // A throwaway RSA key standing in for Clerk's signing key.
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pub = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" };
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Tests drive the delivery consumer directly; don't auto-consume the queue.
          queueConsumers: {},
          bindings: {
            TEST_MIGRATIONS: migrations,
            STRIPE_WEBHOOK_SECRET: "whsec_test",
            STRIPE_SECRET_KEY: "sk_test_x",
            ENVIRONMENT: "local",
            DEV_BOOTSTRAP_SECRET: "test-secret",
            CLERK_ISSUER: "https://clerk.test",
            CLERK_JWKS: JSON.stringify({ keys: [pub] }),
            WEBHOOK_SIGNING_SECRET: "test",
            SES_ACCESS_KEY_ID: "AKIDEXAMPLE",
            SES_SECRET_ACCESS_KEY: "secret",
            TWILIO_ACCOUNT_SID: "ACtest",
            TWILIO_AUTH_TOKEN: "twilio-token",
            TWILIO_FROM: "+15005550006",
            SLACK_SIGNING_SECRET: "slack-secret",
            TEST_CLERK_PRIVATE_JWK: JSON.stringify(privateKey.export({ format: "jwk" })),
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
