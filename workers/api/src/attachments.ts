// Attachment files in R2 (PLAN §4): stored before the publish that charges for them, then
// recorded in D1 (for downloads and storage rent) once the message exists, or deleted if it doesn't.
import { ulid, type Envelope } from "@subetha/sdk/protocol";
import { topicStub } from "./durable/topic.ts";
import { ApiError } from "./errors.ts";
import type { Env } from "./types.ts";

export interface AttachmentFile { name: string; type: string; bytes: Uint8Array }

/** Puts the file in R2 (unless this is a dry run) and returns its id and the envelope attachment. */
export async function storeAttachment(env: Env, file: AttachmentFile, dryRun = false): Promise<{ fileId: string; attachment: NonNullable<Envelope["attachment"]> }> {
  if (!env.FILES) throw new ApiError("unsupported", "attachments are not enabled");
  const fileId = ulid().toLowerCase();
  const attachment = { name: file.name, url: `${env.BASE_URL}/file/${fileId}/${encodeURIComponent(file.name)}`, size: file.bytes.length, type: file.type };
  if (!dryRun) await env.FILES.put(`att/${fileId}`, file.bytes, { httpMetadata: { contentType: file.type } });
  return { fileId, attachment };
}

export async function discardAttachment(env: Env, fileId: string) {
  await env.FILES?.delete(`att/${fileId}`);
}

/** After the publish: record the file against the stored message, or drop it for a duplicate. */
export async function recordAttachment(env: Env, fileId: string, file: AttachmentFile, topic: string, result: { duplicate: boolean; message: Envelope }) {
  if (result.duplicate) return discardAttachment(env, fileId);
  const meta = await topicStub(env, topic).getMeta();
  await env.DB.prepare("INSERT INTO files (id, topic, owner_account_id, name, type, size, message_id, expires, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(fileId, topic, meta!.owner, file.name, file.type, file.bytes.length, result.message.id, result.message.expires, Date.now()).run();
}
