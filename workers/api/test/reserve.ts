import { ulid } from "@subetha/sdk/protocol";
import { accountStub } from "../src/durable/account.ts";
import type { Env } from "../src/types.ts";

export async function reserve(env: Env, accountId: string, micros: number): Promise<string> {
  const ref = `test:${ulid()}`;
  const r = await accountStub(env, accountId).reserve(micros, ref, null, {});
  if (!r.ok) throw new Error("reserve failed");
  return ref;
}
