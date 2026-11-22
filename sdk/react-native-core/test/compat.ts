// Type-level check (tsc only, nothing runs): the generated bindings satisfy the SubEthaCore
// interface that @subetha/react-native's loadCore() and createEdgeNode({ core }) rely on.
import * as generated from "../src/generated/subetha_core";
import type { SubEthaCore } from "../../react-native/src/core.ts";

export const core: SubEthaCore = generated;
