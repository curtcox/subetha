// Subscribe to a topic and wait for one message.
import { SubEtha, type Envelope } from "@subetha/sdk";
import type { SampleContext } from "./_context.ts";

export async function run({ baseUrl, token, topic, fetch }: SampleContext) {
  const se = new SubEtha({ baseUrl, token, fetch });
  await se.configureTopic(topic, {}); // subscribing to a topic that doesn't exist yet is a 404
  // #region snippet
  const first = new Promise<Envelope>((resolve, reject) => {
    const sub = se.subscribe(topic, (m) => {
      console.log(`${m.title ?? ""} ${m.message}`);
      sub.close();
      resolve(m);
    }, {
      transport: "stream",   // "auto" (the default) prefers a WebSocket when there is one
      priority: [3, 4, 5],   // filtered on the server
      onOpen: () => void se.publish(topic, "hello, subscriber").catch(reject),
      onError: (e) => console.warn("reconnecting:", e.message),
    });
  });
  const message = await first;
  // #endregion snippet
  return message;
}
