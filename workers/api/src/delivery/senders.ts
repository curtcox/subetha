// Per-transport senders. Filled in by the transport tracks (PLAN §14).
import type { Transport } from "@subetha/sdk/protocol";
import type { DeliveryJob, Env } from "../types.ts";

export class PermanentError extends Error {}

export interface SendResult { costMicros?: number; detail?: unknown }
export type Sender = (job: DeliveryJob, env: Env) => Promise<SendResult>;

export const senders: Partial<Record<Transport, Sender>> = {};
