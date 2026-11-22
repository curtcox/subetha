import SwiftUI

@main
struct DoorbellApp: App {
    @StateObject private var model = DoorbellModel()
    @StateObject private var edge = EdgeModel()

    var body: some Scene {
        WindowGroup {
            TabView {
                DoorbellView()
                    .tabItem { Label("Doorbell", systemImage: "bell") }
                EdgeView()
                    .tabItem { Label("Edge", systemImage: "antenna.radiowaves.left.and.right") }
            }
            .environmentObject(model)
            .environmentObject(edge)
        }
    }
}
