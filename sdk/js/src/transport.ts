// Unified pluggable transport interface (PLAN §6): capabilities(), send(), receive(), costEstimate().
import type { Envelope, Transport } from "./protocol/index.ts";
import type { TransportEstimate } from "./routing.ts";
import type { SubEtha } from "./client.ts";

export interface TransportCapabilities {
  kind: Transport;
  edge: boolean;
  direction: "in" | "out" | "in/out";
  maxPayloadBytes?: number;
  typicalLatencyMs: number;
  supportsE2ee: boolean;
}

export interface SendResult {
  transport: Transport;
  id?: string;
  costUsdMicros: number;
}

export interface TransportModule {
  capabilities(): TransportCapabilities;
  send(envelope: Envelope, endpoint?: string): Promise<SendResult>;
  receive(topic?: string): Promise<Envelope[]>;
  costEstimate(envelope: Envelope, endpoint?: string): Promise<number> | number;
}

export async function estimateForModule(mod: TransportModule, envelope: Envelope, endpoint?: string): Promise<TransportEstimate> {
  const caps = mod.capabilities();
  const cost = caps.edge ? 0 : await mod.costEstimate(envelope, endpoint);
  return { transport: caps.kind, costUsdMicros: cost, latencyMs: caps.typicalLatencyMs };
}

/** Relay-side HTTP/WS transport module backed by a SubEtha client. */
export class RelayTransport implements TransportModule {
  private readonly client: SubEtha;
  constructor(client: SubEtha) {
    this.client = client;
  }
  capabilities(): TransportCapabilities {
    return { kind: "ws", edge: false, direction: "in/out", maxPayloadBytes: 4096, typicalLatencyMs: 50, supportsE2ee: true };
  }
  async send(envelope: Envelope): Promise<SendResult> {
    const out = await this.client.publishEnvelope(envelope);
    return { transport: "ws", id: out.id, costUsdMicros: 0 };
  }
  async receive(topic?: string): Promise<Envelope[]> {
    if (!topic) return [];
    return this.client.poll(topic);
  }
  async costEstimate(envelope: Envelope): Promise<number> {
    const est = await this.client.estimate(envelope.topic, envelope.message ?? "");
    return est.estimate_usd_micros;
  }
}
