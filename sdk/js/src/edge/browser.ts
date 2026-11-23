// Browser bundle served at subetha.us/edge.js (kept out of sdk.js to keep that small):
//   <script src="https://subetha.us/edge.js"></script> → window.SubEthaEdge
import * as edge from "./index.ts";
import * as web from "./web.ts";

(globalThis as Record<string, unknown>).SubEthaEdge = { ...edge, ...web };
