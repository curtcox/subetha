// End-to-end encryption: the relay only ever sees ciphertext.
import { SubEtha } from "@subetha/sdk";
import type { SampleContext } from "./_context.ts";

export async function run({ baseUrl, token, topic, fetch }: SampleContext) {
  // #region snippet
  // Share these 32 bytes out of band (QR code, password manager…) with every device on the topic.
  const key = crypto.getRandomValues(new Uint8Array(32));
  const topicKeys = { [topic]: { kid: "k1", key } };

  const se = new SubEtha({ baseUrl, token, fetch, topicKeys });
  await se.publish(topic, "The door code is 4721", { title: "Secret" });

  const [plain] = await se.poll(topic);                                    // decrypted for us
  const [wire] = await new SubEtha({ baseUrl, token, fetch }).poll(topic); // what the relay stores
  console.log(plain!.message, "|", wire!.enc, wire!.message);
  // #endregion snippet
  return { plain: plain!, wire: wire! };
}
