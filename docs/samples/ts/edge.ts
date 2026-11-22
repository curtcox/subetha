// Edge transports: two devices swap a signed message over sound and animated QR, no relay.
import { acceptPayload, deliverPayload, demodulate, GossipNode, modulate, QrFrameReceiver, qrFrameTexts } from "@subetha/sdk/edge";
import { generateDeviceKey, signEnvelope, ulid } from "@subetha/sdk/protocol";
import type { SampleContext } from "./_context.ts";

export async function run({ topic }: SampleContext) {
  // #region snippet
  const key = await generateDeviceKey();
  const now = Math.floor(Date.now() / 1000);
  const env = await signEnvelope({ id: ulid(), time: now, expires: now + 3600, topic, message: "Door opened", hops: 2 }, key);
  const payload = deliverPayload([env]); // one-way links carry a gossip "deliver" message

  // The receiving device subscribes; its node checks signatures, expiry, hops, and duplicates.
  const receiver = new GossipNode();
  receiver.subscribe(topic);

  // Sound: 48 kHz PCM for the speaker (playAudioFrame does this in a browser)…
  const pcm = modulate(payload);
  // …and what the other device's microphone hears (listenAudio scans for frames).
  const [viaSound] = await acceptPayload(receiver, demodulate(pcm)!);

  // Animated QR: an endless stream of fountain-coded frames (showAnimatedQr draws them).
  const frames = qrFrameTexts(payload, 10, "L");
  let viaQr: Uint8Array | null = null;
  const scanner = new QrFrameReceiver((p) => (viaQr = p)); // scanAnimatedQr feeds this
  for (let seq = 3; !viaQr; seq += 2) scanner.push(frames.text(seq)); // joined late, saw every other frame
  const again = await acceptPayload(receiver, viaQr); // same message: deduplicated

  console.log(viaSound!.message, `${(pcm.length / 48000).toFixed(1)} s of audio`, again.length);
  // #endregion snippet
  return { viaSound: viaSound!, again, seconds: pcm.length / 48000, sourceBlocks: frames.sourceBlocks };
}
