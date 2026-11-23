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

/** Deletes all R2 attachments and D1 metadata rows for a deleted topic. */
export async function deleteTopicAttachments(env: Env, topic: string): Promise<number> {
  let deleted = 0;
  for (let round = 0; round < 50; round++) {
    const { results } = await env.DB.prepare("SELECT id FROM files WHERE topic = ? LIMIT 1000").bind(topic).all<{ id: string }>();
    if (!results.length) break;
    if (env.FILES) await env.FILES.delete(results.map((r) => `att/${r.id}`));
    await env.DB.batch(results.map((r) => env.DB.prepare("DELETE FROM files WHERE id = ?").bind(r.id)));
    deleted += results.length;
    if (results.length < 1000) break;
  }
  return deleted;
}

/** Deletes all R2 attachments and D1 metadata rows owned by an account (e.g. after freeze grace period). */
export async function deleteAccountAttachments(env: Env, accountId: string): Promise<number> {
  let deleted = 0;
  for (let round = 0; round < 50; round++) {
    const { results } = await env.DB.prepare("SELECT id FROM files WHERE owner_account_id = ? LIMIT 1000").bind(accountId).all<{ id: string }>();
    if (!results.length) break;
    if (env.FILES) await env.FILES.delete(results.map((r) => `att/${r.id}`));
    await env.DB.batch(results.map((r) => env.DB.prepare("DELETE FROM files WHERE id = ?").bind(r.id)));
    deleted += results.length;
    if (results.length < 1000) break;
  }
  return deleted;
}
