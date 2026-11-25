// What every TypeScript sample receives. CI passes the test Worker's fetch; in your own code,
// leave `fetch` out and the SDK uses the global one.
export interface SampleContext {
  /** https://subetha.us, or http://localhost:8787 under `wrangler dev`. */
  baseUrl: string;
  /** An API token (se_…). */
  token: string;
  /** A topic the token's account owns, e.g. "@me/demo". */
  topic: string;
  fetch?: typeof fetch;
  /**
   * A device enrolled at devicebasedauth.org for subetha.us: in a browser,
   * `new DBA()` from https://devicebasedauth.org/sdk/dba.js after `dba.enroll(…)`; CI passes a
   * stand-in. headers() returns its Authorization and DPoP headers for one request.
   */
  dba: { headers(method: string, url: string): Promise<Record<string, string>> };
}
