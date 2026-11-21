import SwiftUI

@main
struct DoorbellApp: App {
    @StateObject private var model = DoorbellModel()

    var body: some Scene {
        WindowGroup {
            TabView {
                DoorbellView()
                    .tabItem { Label("Doorbell", systemImage: "bell") }
                EdgeView()
                    .tabItem { Label("Edge", systemImage: "antenna.radiowaves.left.and.right") }
            }
            .environmentObject(model)
        }
    }
}
