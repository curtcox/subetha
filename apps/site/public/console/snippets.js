// "Copy as …" for the message composer (PLAN §10): the same publish in curl and every SDK.
// Pure: takes the composer's fields, returns source text. Tested in apps/site/test/snippets.test.ts.

/** @typedef {{ baseUrl: string, topic: string, message: string, title?: string, priority?: number, tags?: string[], mode?: string, maxCostUsd?: number, deny?: string[] }} Pub */

export const LANGUAGES = ["curl", "js", "python", "swift", "kotlin", "dart"];
export const LANGUAGE_NAMES = { curl: "curl", js: "JavaScript", python: "Python", swift: "Swift", kotlin: "Kotlin", dart: "Dart" };

const DEFAULT_BASE = "https://subetha.us";
const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`; // POSIX shell single quotes
const dq = (s) => JSON.stringify(String(s)); // JS/Swift/Kotlin/Dart-safe double-quoted string
const py = (s) => JSON.stringify(String(s)); // JSON strings are valid Python literals for BMP text
const dartStr = (s) => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\$/g, "\\$").replace(/\n/g, "\\n")}'`;
const kt = (s) => dq(s).replace(/\$/g, "\\$");

function norm(p) {
  return {
    baseUrl: (p.baseUrl || DEFAULT_BASE).replace(/\/+$/, ""),
    topic: p.topic,
    message: p.message ?? "",
    title: p.title || undefined,
    priority: p.priority && p.priority !== 3 ? p.priority : undefined,
    tags: (p.tags ?? []).filter(Boolean),
    mode: p.mode && p.mode !== "any" ? p.mode : undefined,
    maxCostUsd: typeof p.maxCostUsd === "number" && !Number.isNaN(p.maxCostUsd) ? p.maxCostUsd : undefined,
    deny: (p.deny ?? []).filter(Boolean),
  };
}

/** @param {string} lang @param {Pub} pub */
export function snippet(lang, pub) {
  const p = norm(pub);
  const custom = p.baseUrl !== DEFAULT_BASE;
  const hasRoute = p.mode || p.maxCostUsd !== undefined || p.deny.length;
  switch (lang) {
    case "curl": {
      const parts = ["curl", `-H "Authorization: Bearer $SUBETHA_TOKEN"`];
      if (p.title) parts.push(`-H ${sq(`X-Title: ${p.title}`)}`);
      if (p.priority) parts.push(`-H "X-Priority: ${p.priority}"`);
      if (p.tags.length) parts.push(`-H ${sq(`X-Tags: ${p.tags.join(",")}`)}`);
      if (p.mode) parts.push(`-H "X-Route-Mode: ${p.mode}"`);
      if (p.maxCostUsd !== undefined) parts.push(`-H "X-Max-Cost: ${p.maxCostUsd}"`);
      if (p.deny.length) parts.push(`-H "X-Deny: ${p.deny.join(",")}"`);
      parts.push(`-d ${sq(p.message)}`, sq(`${p.baseUrl}/${p.topic}`));
      return parts.join(" \\\n  ");
    }
    case "js": {
      const o = [];
      if (p.title) o.push(`title: ${dq(p.title)}`);
      if (p.priority) o.push(`priority: ${p.priority}`);
      if (p.tags.length) o.push(`tags: ${JSON.stringify(p.tags)}`);
      if (hasRoute) {
        const r = [];
        if (p.mode) r.push(`mode: ${dq(p.mode)}`);
        if (p.maxCostUsd !== undefined) r.push(`maxCostUsd: ${p.maxCostUsd}`);
        if (p.deny.length) r.push(`deny: ${JSON.stringify(p.deny)}`);
        o.push(`route: { ${r.join(", ")} }`);
      }
      return `import { SubEtha } from "@subetha/sdk";

const se = new SubEtha({ ${custom ? `baseUrl: ${dq(p.baseUrl)}, ` : ""}token: process.env.SUBETHA_TOKEN });
await se.publish(${dq(p.topic)}, ${dq(p.message)}${o.length ? `, { ${o.join(", ")} }` : ""});`;
    }
    case "python": {
      const a = [py(p.topic), py(p.message)];
      if (p.title) a.push(`title=${py(p.title)}`);
      if (p.priority) a.push(`priority=${p.priority}`);
      if (p.tags.length) a.push(`tags=${JSON.stringify(p.tags)}`);
      if (hasRoute) {
        const r = [];
        if (p.mode) r.push(`"mode": ${py(p.mode)}`);
        if (p.maxCostUsd !== undefined) r.push(`"max_cost_usd_micros": ${Math.floor(p.maxCostUsd * 1e6)}`);
        if (p.deny.length) r.push(`"deny": ${JSON.stringify(p.deny)}`);
        a.push(`route={${r.join(", ")}}`);
      }
      return `import os
from subetha import SubEtha

c = SubEtha(${custom ? `${py(p.baseUrl)}, ` : ""}token=os.environ["SUBETHA_TOKEN"])
c.publish(${a.join(", ")})`;
    }
    case "swift": {
      const o = [];
      if (p.title) o.push(`title: ${dq(p.title)}`);
      if (p.priority) o.push(`priority: ${p.priority}`);
      if (p.tags.length) o.push(`tags: ${JSON.stringify(p.tags)}`);
      if (hasRoute) {
        const r = [];
        if (p.mode) r.push(`mode: .${p.mode}`);
        if (p.maxCostUsd !== undefined) r.push(`maxCostUSD: ${p.maxCostUsd}`);
        if (p.deny.length) r.push(`deny: ${JSON.stringify(p.deny)}`);
        o.push(`route: Route(${r.join(", ")})`);
      }
      return `import SubEtha

let client = SubEtha(${custom ? `baseURL: URL(string: ${dq(p.baseUrl)})!, ` : ""}token: ProcessInfo.processInfo.environment["SUBETHA_TOKEN"])
try await client.publish(${dq(p.topic)}, ${dq(p.message)}${o.length ? `, PublishOptions(${o.join(", ")})` : ""})`;
    }
    case "kotlin": {
      const o = [];
      if (p.title) o.push(`title = ${kt(p.title)}`);
      if (p.priority) o.push(`priority = ${p.priority}`);
      if (p.tags.length) o.push(`tags = listOf(${p.tags.map(kt).join(", ")})`);
      if (hasRoute) {
        const r = [];
        if (p.mode) r.push(`mode = RouteMode.${p.mode.toUpperCase()}`);
        if (p.maxCostUsd !== undefined) r.push(`maxCostUsd = ${p.maxCostUsd}`);
        if (p.deny.length) r.push(`deny = listOf(${p.deny.map(kt).join(", ")})`);
        o.push(`route = Route(${r.join(", ")})`);
      }
      return `import us.subetha.*

val client = SubEtha(${custom ? `baseUrl = ${kt(p.baseUrl)}, ` : ""}token = System.getenv("SUBETHA_TOKEN"))
client.publish(${kt(p.topic)}, ${kt(p.message)}${o.length ? `, PublishOptions(${o.join(", ")})` : ""})`;
    }
    case "dart": {
      const o = [];
      if (p.title) o.push(`title: ${dartStr(p.title)}`);
      if (p.priority) o.push(`priority: ${p.priority}`);
      if (p.tags.length) o.push(`tags: [${p.tags.map(dartStr).join(", ")}]`);
      if (hasRoute) {
        const r = [];
        if (p.mode) r.push(`mode: RouteMode.${p.mode}`);
        if (p.maxCostUsd !== undefined) r.push(`maxCostUsd: ${p.maxCostUsd}`);
        if (p.deny.length) r.push(`deny: [${p.deny.map(dartStr).join(", ")}]`);
        o.push(`route: Route(${r.join(", ")})`);
      }
      return `import 'dart:io';
import 'package:subetha/subetha.dart';

final client = SubEtha(${custom ? `baseUrl: ${dartStr(p.baseUrl)}, ` : ""}token: Platform.environment['SUBETHA_TOKEN']);
await client.publish(${dartStr(p.topic)}, ${dartStr(p.message)}${o.length ? `, PublishOptions(${o.join(", ")})` : ""});`;
    }
    default:
      throw new Error(`unknown language: ${lang}`);
  }
}
