# iOS doorbell (SwiftUI)

The scripted doorbell flow (see `samples/README.md`) on the `SubEtha` Swift package from
`sdk/swift` (local package reference).

```bash
brew install xcodegen
cd samples/ios && xcodegen     # writes Doorbell.xcodeproj from project.yml
open Doorbell.xcodeproj        # pick a simulator and run
```

- `DoorbellModel` connects, iterates `client.messages([topic])` into the inbox, rings with
  `publish`, and shows `estimate` (dry run) results.
- The Edge tab is a stub. BLE, audio and QR come from the Rust core through the `SubEthaCore`
  product (build the XCFramework with `sdk/swift/scripts/build-xcframework.sh`).
