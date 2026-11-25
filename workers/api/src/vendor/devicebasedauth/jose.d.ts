// Types for the vendored JOSE helpers subetha's tests use.
export function b64u(input: Uint8Array | ArrayBuffer | string): string;
export function generateKeyPair(extractable?: boolean): Promise<CryptoKeyPair>;
export function exportPublicJwk(publicKey: CryptoKey): Promise<JsonWebKey>;
export function jwkThumbprint(jwk: JsonWebKey): Promise<string>;
export function signJws(header: Record<string, unknown>, payload: Record<string, unknown>, privateKey: CryptoKey): Promise<string>;
