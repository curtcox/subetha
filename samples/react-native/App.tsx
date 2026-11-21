// The scripted doorbell flow: connect, subscribe, inbox, ring, dry-run cost, edge stub.
import { useEffect, useRef, useState } from "react";
import { Button, FlatList, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View, useColorScheme } from "react-native";
import { StatusBar } from "expo-status-bar";
import { createClient, subscribe, SubEthaError, type Envelope, type SubEtha, type Subscription } from "@subetha/react-native";

export default function App() {
  const [tab, setTab] = useState<"doorbell" | "edge">("doorbell");
  const dark = useColorScheme() === "dark";
  const fg = dark ? "#f5f5f4" : "#1c1917";
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: dark ? "#0c0a09" : "#fafaf9" }]}>
      <StatusBar style="auto" />
      <View style={styles.tabs}>
        <Button title="Doorbell" onPress={() => setTab("doorbell")} disabled={tab === "doorbell"} />
        <Button title="Edge" onPress={() => setTab("edge")} disabled={tab === "edge"} />
      </View>
      {tab === "doorbell" ? <Doorbell fg={fg} /> : <Edge fg={fg} />}
    </SafeAreaView>
  );
}

function describe(e: unknown): string {
  return e instanceof SubEthaError ? `${e.code} (HTTP ${e.status})` : String((e as Error)?.message ?? e);
}

function Doorbell({ fg }: { fg: string }) {
  const [token, setToken] = useState("");
  const [topic, setTopic] = useState("@me/doorbell");
  const [baseUrl, setBaseUrl] = useState("https://subetha.org");
  const [client, setClient] = useState<SubEtha | null>(null);
  const [status, setStatus] = useState("Not connected");
  const [inbox, setInbox] = useState<Envelope[]>([]);
  const [estimate, setEstimate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sub = useRef<Subscription | null>(null);

  useEffect(() => () => sub.current?.close(), []);

  const connect = () => {
    sub.current?.close();
    const c = createClient({ baseUrl, token: token.trim() });
    setClient(c);
    setInbox([]);
    setEstimate(null);
    setStatus("Connecting…");
    // One topic → WebSocket (RN fetch can't stream); reconnect, resume, dedupe and acks built in.
    sub.current = subscribe(c, topic, (m) => setInbox((prev) => [m, ...prev].slice(0, 100)), {
      since: "1h",
      onOpen: () => setStatus(`Subscribed to ${topic}`),
      onError: (e) => setStatus(`Reconnecting: ${e.message}`),
    });
  };

  const disconnect = () => {
    sub.current?.close();
    setClient(null);
    setStatus("Not connected");
  };

  const run = async (action: (c: SubEtha) => Promise<void>) => {
    if (!client) return;
    setBusy(true);
    try {
      await action(client);
    } catch (e) {
      setStatus(describe(e));
    } finally {
      setBusy(false);
    }
  };

  const ring = () => run(async (c) => { await c.publish(topic, "ding", { title: "Doorbell", tags: ["bell"] }); });
  const price = () => run(async (c) => {
    const e = await c.estimate(topic, "ding", { title: "Doorbell", route: { mode: "all" } });
    setEstimate(`Worst case $${(e.estimate_usd_micros / 1e6).toFixed(6)}\n${JSON.stringify(e.plan, null, 2)}`);
  });

  const text = { color: fg };
  return (
    <View style={styles.screen}>
      {!client ? (
        <View style={styles.form}>
          <TextInput style={[styles.input, text]} placeholder="Token" placeholderTextColor="#888" secureTextEntry value={token} onChangeText={setToken} autoCapitalize="none" />
          <TextInput style={[styles.input, text]} placeholder="Topic" placeholderTextColor="#888" value={topic} onChangeText={setTopic} autoCapitalize="none" />
          <TextInput style={[styles.input, text]} placeholder="Base URL" placeholderTextColor="#888" value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" keyboardType="url" />
          <Button title="Subscribe" onPress={connect} disabled={!token || !topic} />
        </View>
      ) : (
        <View style={styles.row}>
          <Button title={'Ring "ding"'} onPress={ring} disabled={busy} />
          <Button title="Route & cost" onPress={price} disabled={busy} />
          <Button title="Disconnect" onPress={disconnect} />
        </View>
      )}
      <Text style={[styles.small, text]}>{status}</Text>
      {estimate ? <ScrollView style={styles.estimate}><Text style={[styles.mono, text]}>{estimate}</Text></ScrollView> : null}
      <Text style={[styles.heading, text]}>Inbox</Text>
      <FlatList
        data={inbox}
        keyExtractor={(m, i) => m.id ?? String(i)}
        ListEmptyComponent={<Text style={[styles.small, text]}>No messages yet</Text>}
        renderItem={({ item }) => (
          <Text style={[styles.item, text]}>
            {item.time ? new Date(item.time * 1000).toLocaleTimeString() + "  " : ""}
            {item.title ? `${item.title}: ` : ""}
            {item.message ?? ""}
          </Text>
        )}
      />
    </View>
  );
}

function Edge({ fg }: { fg: string }) {
  return (
    <ScrollView style={styles.screen}>
      <Text style={[styles.heading, { color: fg }]}>Edge transports</Text>
      <Text style={{ color: fg, marginBottom: 12 }}>
        Offline delivery over BLE (store-and-forward gossip), data-over-sound (16-FSK audio modem) and animated QR
        (fountain codes) come from the Rust core: sdk/core edge::ble, edge::gossip, edge::audio and edge::qr, through a
        uniffi-bindgen-react-native Turbo Module (see sdk/react-native/README.md).
      </Text>
      <Text style={[styles.small, { color: fg }]}>
        This screen is a stub (track F). The app supplies the radios: react-native-ble-plx with the core's GATT UUIDs and
        MTU chunking, 48 kHz audio, and camera frames for QR.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  tabs: { flexDirection: "row", justifyContent: "center", gap: 12, paddingVertical: 8 },
  screen: { flex: 1, padding: 16 },
  form: { gap: 8 },
  input: { borderWidth: 1, borderColor: "#8884", borderRadius: 8, padding: 10 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  small: { fontSize: 13, opacity: 0.7, marginVertical: 8 },
  heading: { fontSize: 17, fontWeight: "600", marginVertical: 8 },
  estimate: { maxHeight: 160, borderWidth: 1, borderColor: "#8884", borderRadius: 8, padding: 8 },
  mono: { fontFamily: "Courier", fontSize: 12 },
  item: { paddingVertical: 6 },
});
