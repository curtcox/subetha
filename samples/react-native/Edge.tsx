// The Edge tab: messages between nearby phones with no network, through
// @subetha/react-native/edge. One gossip node holds what this phone has seen.
// - Sound: a 16-FSK modem frame (spec §11.1), played as a WAV with expo-av and heard through
//   react-native-live-audio-stream.
// - QR: fountain-coded animated QR frames (spec §11.2), drawn with react-native-svg and
//   scanned with expo-camera.
// - Bluetooth: a central (react-native-ble-plx) that connects to phones running the Android or
//   iOS sample, which are peripherals (spec §11.3/§11.4).
// - LAN: UDP multicast discovery and gossip (spec §11.5) over react-native-udp.
// - Bridge: with the Doorbell tab connected, relay messages enter the node and edge messages
//   go up to the relay (PLAN §3).
// Bluetooth, the microphone and UDP need a development build (`npx expo run:android`); in Expo
// Go those buttons report that the native module is missing, and QR still works.
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, PermissionsAndroid, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Audio } from "expo-av";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as FileSystem from "expo-file-system";
import Svg, { Path, Rect } from "react-native-svg";
import { ulid, type Envelope, type SubEtha } from "@subetha/react-native";
import {
  acceptPayload, animateQr, audioFrameWav, base64Encode, bridgeEdge, connectBlePlxPeer, createEdgeNode, deliverPayload,
  listenPcm16, QrFrameReceiver, startLanWith, type BlePeer, type DgramLike, type EdgeBridge, type GossipNode, type LanHandle,
  type Pcm16Stream, type PlxManager,
} from "@subetha/react-native/edge";
import { useCore } from "./core";

/** Native modules that Expo Go lacks: null when missing. */
function optional<T>(load: () => T): T | null {
  try {
    return load() ?? null;
  } catch {
    return null;
  }
}
const BleManager = optional(() => require("react-native-ble-plx").BleManager as new () => PlxManager & { destroy(): void });
const liveAudio = optional(() => require("react-native-live-audio-stream").default as Pcm16Stream);
const udp = optional(() => require("react-native-udp").default as DgramLike);

async function androidPermissions(perms: string[]): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const res = await PermissionsAndroid.requestMultiple(perms as never);
  return Object.values(res).every((r) => r === PermissionsAndroid.RESULTS.GRANTED);
}
const blePermissions = () => androidPermissions(
  Number(Platform.Version) >= 31
    ? ["android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_CONNECT"]
    : ["android.permission.ACCESS_FINE_LOCATION"],
);

/** Plays a WAV through expo-av and resolves when it ends. */
async function playWav(wav: Uint8Array): Promise<void> {
  const uri = `${FileSystem.cacheDirectory}subetha-frame.wav`;
  await FileSystem.writeAsStringAsync(uri, base64Encode(wav), { encoding: FileSystem.EncodingType.Base64 });
  const { sound } = await Audio.Sound.createAsync({ uri });
  await new Promise<void>((resolve) => {
    sound.setOnPlaybackStatusUpdate((s) => {
      if (!s.isLoaded || s.didJustFinish) resolve();
    });
    void sound.playAsync();
  });
  await sound.unloadAsync();
}

export function Edge({ fg, client }: { fg: string; client: SubEtha | null }) {
  const [topic, setTopic] = useState("@me/doorbell");
  const [text, setText] = useState("Ding dong");
  const [heard, setHeard] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [qr, setQr] = useState<{ size: number; d: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [listening, setListening] = useState(false);
  const [lanOn, setLanOn] = useState(false);
  const [bridging, setBridging] = useState(false);
  const [peerNames, setPeerNames] = useState<string[]>([]);
  const [camera, requestCamera] = useCameraPermissions();

  const nodeRef = useRef<GossipNode | null>(null);
  const qrAnim = useRef<{ stop(): void } | null>(null);
  const qrRx = useRef<QrFrameReceiver | null>(null);
  const mic = useRef<{ stop(): void } | null>(null);
  const ble = useRef<(PlxManager & { destroy(): void }) | null>(null);
  const peers = useRef(new Map<string, BlePeer>());
  const lan = useRef<LanHandle | null>(null);
  const bridge = useRef<EdgeBridge | null>(null);

  // Hermes can't check Ed25519 signatures on its own. Without the Rust core, signed edge messages
  // are dropped and unsigned ones (like this tab's) pass. With it, the node verifies signatures
  // and this tab signs what it sends with a per-session device key.
  const core = useCore();
  const seed = useMemo(() => (core ? core.newDeviceKey() : null), [core]);
  const nodeCoreRef = useRef<typeof core>(null);
  useEffect(() => () => {
    qrAnim.current?.stop();
    mic.current?.stop();
    peers.current.forEach((p) => void p.disconnect());
    void lan.current?.stop();
    bridge.current?.close();
    ble.current?.destroy();
  }, []);

  const node = (): GossipNode => {
    if (!nodeRef.current || (core && nodeCoreRef.current !== core)) {
      const prev = nodeRef.current;
      const next = createEdgeNode({ core });
      if (prev) {
        for (const t of prev.subscribedTopics()) next.subscribe(t);
        for (const e of prev.storedEnvelopes()) next.publish(e);
      }
      nodeRef.current = next;
      nodeCoreRef.current = core;
    }
    nodeRef.current.subscribe(topic.trim());
    return nodeRef.current;
  };
  const say = (s: string) => setStatus(s);
  const fail = (e: unknown) => say(String((e as Error)?.message ?? e));

  const resyncAll = () => {
    peers.current.forEach((p) => void p.resync().catch(() => {}));
    void lan.current?.resync();
  };

  /** A message that arrived over any edge link. */
  const onMessage = (env: Envelope) => {
    setHeard((h) => [`${env.topic}: ${env.message ?? ""}`, ...h].slice(0, 50));
    void bridge.current?.uplink(env);
  };

  /** A new envelope for the text box, held by the node so links pass it on. */
  const publishLocally = (): Envelope => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned: Envelope = { id: ulid(), time: now, expires: now + 3600, topic: topic.trim(), message: text, hops: 2 };
    const env: Envelope = core && seed ? JSON.parse(core.signEnvelopeJson(JSON.stringify(unsigned), seed.seed)) : unsigned;
    node().publish(env);
    resyncAll();
    void bridge.current?.uplink(env);
    return env;
  };

  // ---- sound ----
  const playSound = async () => {
    try {
      say("Playing…");
      await playWav(audioFrameWav(deliverPayload([publishLocally()])));
      say("Played one frame");
    } catch (e) {
      fail(e);
    }
  };
  const toggleListen = async () => {
    if (mic.current) {
      mic.current.stop();
      mic.current = null;
      setListening(false);
      return;
    }
    if (!liveAudio) return say("Microphone streaming needs a development build (react-native-live-audio-stream)");
    if (!(await androidPermissions(["android.permission.RECORD_AUDIO"]))) return say("Microphone permission denied");
    try {
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      mic.current = listenPcm16(liveAudio, (p) => void acceptPayload(node(), p).then((es) => es.forEach(onMessage)), { sampleRate: 44_100 });
      setListening(true);
      say("Listening…");
    } catch (e) {
      fail(e);
    }
  };

  // ---- QR ----
  const toggleShowQr = () => {
    if (qrAnim.current) {
      qrAnim.current.stop();
      qrAnim.current = null;
      setQr(null);
      return;
    }
    const a = animateQr(deliverPayload([publishLocally()]), (f) => setQr(f), { version: 10, fps: 5 });
    qrAnim.current = a;
    say(`Showing ${a.sourceBlocks} source block(s); point the other phone's camera here`);
  };
  const toggleScan = async () => {
    if (scanning) return setScanning(false);
    if (!camera?.granted && !(await requestCamera()).granted) return say("Camera permission denied");
    qrRx.current = new QrFrameReceiver((p) => {
      void acceptPayload(node(), p).then((es) => {
        es.forEach(onMessage);
        say(es.length ? "Received over QR" : "Already had that message");
      });
      setScanning(false);
    });
    setScanning(true);
  };

  // ---- Bluetooth ----
  const connectBle = async () => {
    if (!BleManager) return say("Bluetooth needs a development build (react-native-ble-plx)");
    if (!(await blePermissions())) return say("Bluetooth permission denied");
    try {
      ble.current ??= new BleManager();
      say("Scanning for a SubEtha peer…");
      const peer = await connectBlePlxPeer(ble.current, node(), onMessage, {
        onDisconnect: () => {
          peers.current.delete(peer.id);
          setPeerNames([...peers.current.values()].map((p) => p.name ?? p.id));
        },
      });
      peers.current.set(peer.id, peer);
      setPeerNames([...peers.current.values()].map((p) => p.name ?? p.id));
      say(`Connected to ${peer.name ?? peer.id} (MTU ${peer.mtu})`);
    } catch (e) {
      fail(e);
    }
  };

  // ---- LAN ----
  const toggleLan = async () => {
    if (lan.current) {
      await lan.current.stop();
      lan.current = null;
      setLanOn(false);
      return;
    }
    if (!udp) return say("LAN needs a development build (react-native-udp)");
    try {
      lan.current = await startLanWith(udp, node(), onMessage);
      setLanOn(true);
      say(`On the LAN as ${lan.current.nodeId}`);
    } catch (e) {
      fail(e);
    }
  };

  // ---- bridge ----
  const toggleBridge = () => {
    if (bridge.current) {
      bridge.current.close();
      bridge.current = null;
      setBridging(false);
      return;
    }
    if (!client) return say("Connect on the Doorbell tab first");
    bridge.current = bridgeEdge(client, node(), {
      topics: [topic.trim()],
      onDownlink: (env) => {
        setHeard((h) => [`relay → edge: ${env.message ?? ""}`, ...h].slice(0, 50));
        resyncAll();
      },
      onError: (e) => say(`Bridge: ${e.message}`),
    });
    setBridging(true);
    say(`Bridging ${topic.trim()} between the relay and nearby phones`);
  };

  const c = { color: fg };
  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ gap: 8, paddingBottom: 32 }}>
      <Text style={[styles.heading, c]}>Edge transports</Text>
      <TextInput style={[styles.input, c]} value={topic} onChangeText={setTopic} autoCapitalize="none" placeholder="Topic" placeholderTextColor="#888" />
      <TextInput style={[styles.input, c]} value={text} onChangeText={setText} placeholder="Message" placeholderTextColor="#888" />

      <Text style={[styles.sub, c]}>Sound</Text>
      <View style={styles.row}>
        <Button title="Play" onPress={playSound} />
        <Button title={listening ? "Stop listening" : "Listen"} onPress={toggleListen} />
      </View>

      <Text style={[styles.sub, c]}>Animated QR</Text>
      <View style={styles.row}>
        <Button title={qr ? "Hide QR" : "Show QR"} onPress={toggleShowQr} />
        <Button title={scanning ? "Stop scanning" : "Scan QR"} onPress={toggleScan} />
      </View>
      {qr ? (
        <Svg width="100%" height={320} viewBox={`0 0 ${qr.size} ${qr.size}`}>
          <Rect width={qr.size} height={qr.size} fill="#fff" />
          <Path d={qr.d} fill="#000" />
        </Svg>
      ) : null}
      {scanning ? (
        <CameraView
          style={styles.camera}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => {
            const p = qrRx.current?.push(data);
            if (p && !p.complete) say(`Scanning: ${p.known}/${p.total} blocks`);
          }}
        />
      ) : null}

      <Text style={[styles.sub, c]}>Bluetooth LE</Text>
      <View style={styles.row}>
        <Button title="Connect to a phone" onPress={connectBle} />
      </View>
      {peerNames.length ? <Text style={[styles.small, c]}>Peers: {peerNames.join(", ")}</Text> : null}

      <Text style={[styles.sub, c]}>LAN and relay</Text>
      <View style={styles.row}>
        <Button title={lanOn ? "Leave LAN" : "Join LAN"} onPress={toggleLan} />
        <Button title={bridging ? "Stop bridge" : "Bridge to relay"} onPress={toggleBridge} />
      </View>

      <Text style={[styles.small, c]}>{status}</Text>
      <Text style={[styles.small, c]}>{seed ? `Signing as ${seed.deviceId.slice(0, 12)}…` : "Unsigned (no Rust core)"}</Text>
      <Text style={[styles.sub, c]}>Heard</Text>
      {heard.length ? heard.map((h, i) => <Text key={i} style={c}>{h}</Text>) : <Text style={[styles.small, c]}>Nothing yet</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16 },
  heading: { fontSize: 17, fontWeight: "600" },
  sub: { fontSize: 15, fontWeight: "600", marginTop: 8 },
  input: { borderWidth: 1, borderColor: "#8884", borderRadius: 8, padding: 10 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  small: { fontSize: 13, opacity: 0.7 },
  camera: { width: "100%", height: 320 },
});
