// Edge transports (PLAN §6, spec §11): protocol logic shared with sdk/core, plus browser
// shims in ./web-*.ts. Everything here runs on the device and never touches the relay.
export * from "./audio.ts";
export * from "./base45.ts";
export * from "./ble.ts";
export * from "./crc.ts";
export * from "./fountain.ts";
export * from "./gossip.ts";
export { SplitMix64 } from "./splitmix.ts";
