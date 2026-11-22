// The Rust core (@subetha/react-native-core, a Turbo Module) when this is a development build
// that includes it; null in Expo Go, which can't load custom native code. Metro needs the literal
// require. With the core, Hermes can sign and verify Ed25519: the Doorbell tab checks signatures
// on what it receives, and the Edge tab signs what it sends and verifies what it hears.
import { useEffect, useState } from "react";
import { loadCore, type SubEthaCore } from "@subetha/react-native";

export const corePromise: Promise<SubEthaCore | null> = loadCore(() => require("@subetha/react-native-core"));

export function useCore(): SubEthaCore | null {
  const [core, setCore] = useState<SubEthaCore | null>(null);
  useEffect(() => {
    let live = true;
    void corePromise.then((c) => live && setCore(c));
    return () => {
      live = false;
    };
  }, []);
  return core;
}
