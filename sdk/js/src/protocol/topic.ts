// Topic grammar (spec §1.2).

import { base32Encode } from "./encoding.ts";

export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
export const TOPIC_RE = /^(@[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[A-Za-z0-9_-]{1,64}|t_[a-z2-7]{26})$/;

export type ParsedTopic =
  | { kind: "namespaced"; topic: string; handle: string; name: string }
  | { kind: "secret"; topic: string };

export function parseTopic(topic: string): ParsedTopic | null {
  if (!TOPIC_RE.test(topic)) return null;
  if (topic.startsWith("t_")) return { kind: "secret", topic };
  const slash = topic.indexOf("/");
  return { kind: "namespaced", topic, handle: topic.slice(1, slash), name: topic.slice(slash + 1) };
}

export function isTopic(s: unknown): s is string {
  return typeof s === "string" && TOPIC_RE.test(s);
}

/** A fresh unguessable secret topic (128 random bits). */
export function secretTopic(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return "t_" + base32Encode(b);
}
