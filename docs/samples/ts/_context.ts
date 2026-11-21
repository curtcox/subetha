// What every TypeScript sample receives. CI passes the test Worker's fetch; in your own code,
// leave `fetch` out and the SDK uses the global one.
export interface SampleContext {
  /** https://subetha.org, or http://localhost:8787 under `wrangler dev`. */
  baseUrl: string;
  /** An API token (se_…). */
  token: string;
  /** A topic the token's account owns, e.g. "@me/demo". */
  topic: string;
  fetch?: typeof fetch;
}
