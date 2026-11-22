# iOS doorbell (SwiftUI)

The scripted doorbell flow (see `samples/README.md`) on the `SubEtha` Swift package from
`sdk/swift` (local package reference).

```bash
sdk/swift/scripts/build-xcframework.sh   # from the repo root: the Rust core for the Edge tab
brew install xcodegen
cd samples/ios && xcodegen     # writes Doorbell.xcodeproj from project.yml
open Doorbell.xcodeproj        # pick a simulator (or a phone, for Bluetooth and sound) and run
```

CI builds it for the simulator (`.github/workflows/mobile.yml`, job `ios-sample`).

- `DoorbellModel` connects, iterates `client.messages([topic])` into the inbox, rings with
  `publish`, and shows `estimate` (dry run) results.
- The Edge tab uses the Rust core through the `SubEthaCore` product (the XCFramework above):
  - **Sound**: `AppleAudio` (AVAudioEngine, measurement mode) plays and records; SubEthaCore's
    `AudioLink` and an `EdgeGossipNode` do the modem and gossip.
  - **Bluetooth**: `AppleBle` is both a peripheral (CBPeripheralManager with the spec §11.3
    service, advertising) and a central (CBCentralManager scanning for it), with a `BleLink`
    per connection. It talks to the Android sample and to Web Bluetooth pages (the Edge lab at
    `/tools/edge.html`). Foreground only: iOS restricts BLE in the background.
  - **Bridge to relay**: with the Doorbell tab connected, `EdgeBridge` brings relay messages on
    the topic into the node (Bluetooth peers then fetch them) and publishes what's heard over
    the edge. The offline BLE-hop demo in `samples/android/README.md` works with any mix of
    iPhones and Android phones.
  - **QR**: "Show as QR" animates a message with `QrSender` (CoreImage renders each frame);
    "Scan QR" feeds AVCaptureMetadataOutput strings to `QrReceiver`. Interoperates with the
    Android sample and the Edge lab page.
