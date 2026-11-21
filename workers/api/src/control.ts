// Control-plane routes added by later tracks (devices, endpoints, subscriptions).
import type { Hono, Context } from "hono";
import type { Env, Principal } from "./types.ts";

type App = Hono<{ Bindings: Env; Variables: { principal: Principal } }>;
type PrincipalFn = (c: Context<{ Bindings: Env; Variables: { principal: Principal } }>) => Promise<Principal>;

export function registerControlRoutes(_app: App, _principal: PrincipalFn) {}
