// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "Authenti8MacSensor",
  platforms: [.macOS(.v13)],
  products: [.executable(name: "Authenti8MacSensor", targets: ["Authenti8MacSensor"])],
  targets: [.executableTarget(name: "Authenti8MacSensor")]
)
