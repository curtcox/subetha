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
          bindings: {
            TEST_MIGRATIONS: migrations,
            STRIPE_WEBHOOK_SECRET: "whsec_test",
            ENVIRONMENT: "local",
            DEV_BOOTSTRAP_SECRET: "test-secret",
            CLERK_ISSUER: "https://clerk.test",
            CLERK_JWKS: JSON.stringify({ keys: [pub] }),
            TEST_CLERK_PRIVATE_JWK: JSON.stringify(privateKey.export({ format: "jwk" })),
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
