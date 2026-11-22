// Hermes has no crypto.getRandomValues (message ids) or Buffer (react-native-udp): polyfill
// both before anything else loads.
import "react-native-get-random-values";
import { Buffer } from "buffer";
import { registerRootComponent } from "expo";
import App from "./App";

(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

registerRootComponent(App);
