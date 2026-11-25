// Types for the vendored issuer helpers, which subetha's tests use to stand in for devicebasedauth.org.
export interface IssuerSigner { kid: string; key: CryptoKey; [k: string]: unknown }
export function issuerSigner(key: { kid: string; jwk: JsonWebKey }): Promise<IssuerSigner>;
export function jwksFor(keys: Array<{ kid: string; jwk: JsonWebKey }>): { keys: JsonWebKey[] };
export function signCredential(payload: Record<string, unknown>, signer: IssuerSigner, typ?: string): Promise<string>;
export function signAccessToken(payload: Record<string, unknown>, signer: IssuerSigner): Promise<string>;
export function signStatusList(options: { uri: string; bytes: Uint8Array; issuer: string; ttl?: number; now?: number; lifetime?: number }, signer: IssuerSigner): Promise<string>;
