// Vite's `?raw` imports (source text), used by tests that inspect the relay's own code.
declare module "*?raw" {
  const text: string;
  export default text;
}
