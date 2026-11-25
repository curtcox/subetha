// Types for the vendored DPoP proof helper subetha's tests use.
export function createProof(options: { privateKey: CryptoKey; publicJwk: JsonWebKey; method: string; url: string; credential?: string; nonce?: string; now?: number; jti?: string }): Promise<string>;
