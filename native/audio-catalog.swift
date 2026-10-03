// Read-only CoreAudio device catalog. Lists devices the way Chromium's
// AudioManagerMac does (media/audio/mac/audio_manager_mac.cc GetAudioDeviceInfo):
// kAudioDevicePropertyDeviceUID is the raw ID Chromium hashes into deviceId,
// private aggregate devices are skipped, and input/output follow
// CoreAudioUtilMac::IsInputDevice/IsOutputDevice. It never opens a stream,
// requests permission or changes a default device.
// Usage: glkvm-audio-catalog [--watch]  (watch prints a new line on changes until stdin closes)
import CoreAudio
import Foundation

let system = AudioObjectID(kAudioObjectSystemObject)

func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func objects(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> [AudioObjectID] {
  var where_ = address(selector)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(id, &where_, 0, nil, &size) == noErr, size > 0 else { return [] }
  var result = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(id, &where_, 0, nil, &size, &result) == noErr else { return [] }
  return result
}

func uint32(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
  var where_ = address(selector)
  var value: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  return AudioObjectGetPropertyData(id, &where_, 0, nil, &size, &value) == noErr ? value : nil
}

func string(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var where_ = address(selector)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(id, &where_, 0, nil, &size, &value) == noErr, let text = value?.takeRetainedValue() else { return nil }
  return text as String
}

func isPrivateAggregate(_ id: AudioObjectID) -> Bool {
  guard uint32(id, kAudioDevicePropertyTransportType) == kAudioDeviceTransportTypeAggregate else { return false }
  var where_ = address(kAudioAggregateDevicePropertyComposition)
  var value: Unmanaged<CFDictionary>?
  var size = UInt32(MemoryLayout<Unmanaged<CFDictionary>?>.size)
  guard AudioObjectGetPropertyData(id, &where_, 0, nil, &size, &value) == noErr, let composition = value?.takeRetainedValue() as? [String: Any] else { return false }
  let flag = composition[kAudioAggregateDeviceIsPrivateKey]
  return (flag as? Bool) ?? ((flag as? NSNumber)?.intValue ?? 0 != 0)
}

let inputUndefinedTerminal: UInt32 = 0x0200
func isInput(_ id: AudioObjectID) -> Bool {
  var defined = 0, undefined = 0, outputs = 0
  for stream in objects(id, kAudioDevicePropertyStreams) {
    switch uint32(stream, kAudioStreamPropertyDirection) {
    case 0: outputs += 1
    case 1: if uint32(stream, kAudioStreamPropertyTerminalType) == inputUndefinedTerminal { undefined += 1 } else { defined += 1 }
    default: break
    }
  }
  return defined > 0 || (undefined > 0 && outputs == 0)
}

func isOutput(_ id: AudioObjectID) -> Bool {
  var where_ = address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput)
  var size: UInt32 = 0
  return AudioObjectGetPropertyDataSize(id, &where_, 0, nil, &size) == noErr && size > 0
}

let transports: [UInt32: String] = [
  kAudioDeviceTransportTypeBuiltIn: "Built-in", kAudioDeviceTransportTypeAggregate: "Aggregate",
  kAudioDeviceTransportTypeAutoAggregate: "AutoAggregate", kAudioDeviceTransportTypeVirtual: "Virtual",
  kAudioDeviceTransportTypePCI: "PCI", kAudioDeviceTransportTypeUSB: "USB", kAudioDeviceTransportTypeFireWire: "FireWire",
  kAudioDeviceTransportTypeBluetooth: "Bluetooth", kAudioDeviceTransportTypeBluetoothLE: "Bluetooth LE",
  kAudioDeviceTransportTypeHDMI: "HDMI", kAudioDeviceTransportTypeDisplayPort: "DisplayPort",
  kAudioDeviceTransportTypeAirPlay: "AirPlay", kAudioDeviceTransportTypeAVB: "AVB",
  kAudioDeviceTransportTypeThunderbolt: "Thunderbolt",
]

func snapshot() -> String {
  var devices: [[String: Any]] = []
  for id in objects(system, kAudioHardwarePropertyDevices) {
    guard let uid = string(id, kAudioDevicePropertyDeviceUID), let name = string(id, kAudioObjectPropertyName), !isPrivateAggregate(id) else { continue }
    let input = isInput(id), output = isOutput(id)
    if !input && !output { continue }
    devices.append([
      "uid": uid, "name": name, "input": input, "output": output,
      "alive": uint32(id, kAudioDevicePropertyDeviceIsAlive).map { $0 != 0 } ?? false,
      "transport": transports[uint32(id, kAudioDevicePropertyTransportType) ?? 0] ?? "",
    ])
  }
  let data = try! JSONSerialization.data(withJSONObject: ["devices": devices], options: [.sortedKeys])
  return String(decoding: data, as: UTF8.self)
}

func emit() { print(snapshot()); fflush(stdout) }
emit()
if CommandLine.arguments.contains("--watch") {
  // Coalesce bursts of hardware notifications into one snapshot.
  var pending = false
  let queue = DispatchQueue.main
  let changed: AudioObjectPropertyListenerBlock = { _, _ in
    if pending { return }
    pending = true
    queue.asyncAfter(deadline: .now() + 0.25) { pending = false; emit() }
  }
  var devices = address(kAudioHardwarePropertyDevices)
  AudioObjectAddPropertyListenerBlock(system, &devices, queue, changed)
  // The app owns this process: exit when it closes stdin or dies.
  FileHandle.standardInput.readabilityHandler = { handle in if handle.availableData.isEmpty { exit(0) } }
  dispatchMain()
}
