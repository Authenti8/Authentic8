import AppKit
import ApplicationServices
import CoreAudio
import CryptoKit
import Foundation
import Security

struct Snapshot: Codable {
  let applications: [ApplicationEvidence]
  let windows: [WindowEvidence]
  let audioDevices: [AudioEvidence]
  let permissions: Permissions
}

struct ApplicationEvidence: Codable {
  let processId: Int32
  let bundleIdentifier: String?
  let executableSha256: String?
  let teamIdentifier: String?
  let version: String?
  let launchTime: String?
  let identityKey: String?
}

struct CachedIdentity: Codable { let executableSha256: String?; let teamIdentifier: String? }

struct WindowEvidence: Codable {
  let ownerProcessId: Int32
  let ownerBundleIdentifier: String?
  let windowIdHash: String
  let titleHash: String
  let layer: Int
  let alpha: Double
  let onScreen: Bool
  let bounds: Bounds
}

struct Bounds: Codable { let left: Double; let top: Double; let width: Double; let height: Double }
struct AudioEvidence: Codable {
  let deviceIdHash: String
  let name: String
  let provider: String?
  let direction: String
  let virtual: Bool
  let isDefault: Bool
}
struct Permissions: Codable { let accessibility: Bool; let screenRecording: Bool }

func sha256(_ value: String) -> String {
  SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
}

func fileHash(_ url: URL?) -> String? {
  guard let url, let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return nil }
  return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func signingTeam(_ url: URL?) -> String? {
  guard let url else { return nil }
  var code: SecStaticCode?
  guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code else { return nil }
  var information: CFDictionary?
  guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation),
    &information) == errSecSuccess else { return nil }
  return (information as? [String: Any])?[kSecCodeInfoTeamIdentifier as String] as? String
}

func identityKey(_ url: URL?) -> String? {
  guard let url, let values = try? url.resourceValues(forKeys: [
    .fileResourceIdentifierKey, .contentModificationDateKey, .fileSizeKey]) else { return nil }
  let epoch = Int(Date().timeIntervalSince1970 / 30)
  return sha256("\(url.path)|\(String(describing: values.fileResourceIdentifier))|" +
    "\(values.contentModificationDate?.timeIntervalSince1970 ?? 0)|\(values.fileSize ?? 0)|\(epoch)")
}

let identityCache: [String: CachedIdentity] = {
  guard let encoded = ProcessInfo.processInfo.environment["AUTHENTI8_IDENTITY_CACHE"],
    let data = Data(base64Encoded: encoded),
    let cache = try? JSONDecoder().decode([String: CachedIdentity].self, from: data) else { return [:] }
  return cache
}()

let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy != .prohibited }
let applications = running.map { app in
  let key = identityKey(app.executableURL)
  let cached = key.flatMap { identityCache[$0] }
  return ApplicationEvidence(processId: app.processIdentifier, bundleIdentifier: app.bundleIdentifier,
    executableSha256: cached?.executableSha256 ?? fileHash(app.executableURL),
    teamIdentifier: cached?.teamIdentifier ?? signingTeam(app.executableURL),
    version: app.bundleURL.flatMap { Bundle(url: $0)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String },
    launchTime: nil, identityKey: key)
}
let bundleByPid = Dictionary(uniqueKeysWithValues: running.map { ($0.processIdentifier, $0.bundleIdentifier) })
let rawWindows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
  as? [[String: Any]] ?? []
let windows = rawWindows.compactMap { item -> WindowEvidence? in
  guard let pid = item[kCGWindowOwnerPID as String] as? Int32,
    let number = item[kCGWindowNumber as String] as? Int,
    let rectangle = item[kCGWindowBounds as String] as? [String: Double] else { return nil }
  let title = item[kCGWindowName as String] as? String ?? ""
  return WindowEvidence(ownerProcessId: pid, ownerBundleIdentifier: bundleByPid[pid] ?? nil,
    windowIdHash: sha256(String(number)), titleHash: sha256(title),
    layer: item[kCGWindowLayer as String] as? Int ?? 0,
    alpha: item[kCGWindowAlpha as String] as? Double ?? 1,
    onScreen: item[kCGWindowIsOnscreen as String] as? Bool ?? true,
    bounds: Bounds(left: rectangle["X"] ?? 0, top: rectangle["Y"] ?? 0,
      width: rectangle["Width"] ?? 0, height: rectangle["Height"] ?? 0))
}

func audioString(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var value: CFString = "" as CFString
  var size = UInt32(MemoryLayout<CFString>.size)
  guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr else { return nil }
  return value as String
}

func audioUInt(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var value: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr else { return nil }
  return value
}

func hasStreams(_ id: AudioObjectID, _ scope: AudioObjectPropertyScope) -> Bool {
  var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: scope,
    mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  return AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr && size > 0
}

func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioObjectID {
  audioUInt(AudioObjectID(kAudioObjectSystemObject), selector) ?? 0
}

func collectAudio() -> [AudioEvidence] {
  let system = AudioObjectID(kAudioObjectSystemObject)
  var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return [] }
  var devices = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &devices) == noErr else { return [] }
  let defaultInput = defaultDevice(kAudioHardwarePropertyDefaultInputDevice)
  let defaultOutput = defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
  return devices.flatMap { id -> [AudioEvidence] in
    let name = audioString(id, kAudioObjectPropertyName) ?? "Unknown"
    let provider = audioString(id, kAudioObjectPropertyManufacturer)
    let transport = audioUInt(id, kAudioDevicePropertyTransportType) ?? 0
    let virtual = transport == kAudioDeviceTransportTypeVirtual || transport == kAudioDeviceTransportTypeAggregate
    let hash = sha256(audioString(id, kAudioDevicePropertyDeviceUID) ?? String(id))
    var result: [AudioEvidence] = []
    if hasStreams(id, kAudioDevicePropertyScopeInput) {
      result.append(AudioEvidence(deviceIdHash: hash, name: name, provider: provider,
        direction: "CAPTURE", virtual: virtual, isDefault: id == defaultInput))
    }
    if hasStreams(id, kAudioDevicePropertyScopeOutput) {
      result.append(AudioEvidence(deviceIdHash: hash, name: name, provider: provider,
        direction: "RENDER", virtual: virtual, isDefault: id == defaultOutput))
    }
    return result
  }
}

let snapshot = Snapshot(applications: applications, windows: windows, audioDevices: collectAudio(),
  permissions: Permissions(accessibility: AXIsProcessTrusted(),
    screenRecording: CGPreflightScreenCaptureAccess()))
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
FileHandle.standardOutput.write(try encoder.encode(snapshot))
