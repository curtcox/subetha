// Publish a file as an attachment (ntfy-style X-Filename upload) and download it.
import type { SampleContext } from "./_context.ts";

export async function run({ baseUrl, token, topic, fetch = globalThis.fetch }: SampleContext) {
  const csv = new TextEncoder().encode("date,kwh\n2026-11-20,14.2\n2026-11-21,12.9\n");
  // #region snippet
  const r = await fetch(`${baseUrl}/${topic}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "x-filename": "energy.csv",
      "content-type": "text/csv",
      "x-message": "Yesterday's energy report", // the body is the file, so the text goes in a header
    },
    body: csv,
  });
  const msg = (await r.json()) as { id: string; attachment: { name: string; url: string; size: number; type: string } };
  console.log(msg.attachment); // { name: "energy.csv", url: "https://subetha.us/file/…/energy.csv", size: 53, type: "text/csv" }

  // Anyone with the URL can download it until the message expires (the topic owner pays per download).
  const file = await fetch(msg.attachment.url);
  // #endregion snippet
  return { status: r.status, msg, downloaded: await file.text() };
}
