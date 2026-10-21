import Foundation
import Speech
import AVFoundation
import CoreAudio
import AudioToolbox

var launchTime = ProcessInfo.processInfo.systemUptime
func timing(_ stage: String) {
    emit(["type": "timing", "stage": stage, "elapsedMs": Int((ProcessInfo.processInfo.systemUptime - launchTime) * 1000)])
}
let outputLock = NSLock()
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    outputLock.lock()
    defer { outputLock.unlock() }
    FileHandle.standardOutput.write(data + Data([10]))
}

struct Microphone {
    let id: AudioDeviceID
    let uid: String
    let name: String
}
func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}
func stringProperty(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
    var key = address(selector)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &key, 0, nil, &size, &value) == noErr else { return nil }
    return value?.takeRetainedValue() as String?
}
func defaultMicrophone() -> AudioDeviceID {
    var key = address(kAudioHardwarePropertyDefaultInputDevice)
    var value = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    _ = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &key, 0, nil, &size, &value)
    return value
}
// Opt-in diagnostics for slow device enumeration (`--devices-debug`, or
// ACB_SPEECH_TIMING=1 with any mode). Written to stderr only, never to the
// stdout protocol, and silent unless explicitly requested.
let debugTiming = CommandLine.arguments.contains("--devices-debug") || ProcessInfo.processInfo.environment["ACB_SPEECH_TIMING"] == "1"
let traceStart = ProcessInfo.processInfo.systemUptime
func trace(_ message: @autoclosure () -> String) {
    guard debugTiming else { return }
    let line = String(format: "[acb-speech %8.1fms] ", (ProcessInfo.processInfo.systemUptime - traceStart) * 1000) + message() + "\n"
    FileHandle.standardError.write(Data(line.utf8))
}
func timed<T>(_ label: @autoclosure () -> String, _ body: () -> T) -> T {
    guard debugTiming else { return body() }
    let start = ProcessInfo.processInfo.systemUptime
    let value = body()
    trace(String(format: "%8.1fms  ", (ProcessInfo.processInfo.systemUptime - start) * 1000) + label())
    return value
}
// Time from exec to main(): dyld, framework loading and the system's first-run
// code assessment all happen before any of our code runs.
func launchDelayMs() -> Double? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
    guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return nil }
    let started = info.kp_proc.p_un.__p_starttime
    let startedAt = Double(started.tv_sec) + Double(started.tv_usec) / 1_000_000
    return (Date().timeIntervalSince1970 - startedAt) * 1000
}
func uint32Property(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
    var key = address(selector)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(id, &key, 0, nil, &size, &value) == noErr else { return nil }
    return value
}
func fourCC(_ value: UInt32?) -> String {
    guard let value else { return "?" }
    let bytes = [24, 16, 8, 0].map { UInt8((value >> UInt32($0)) & 0xff) }
    return bytes.allSatisfy({ $0 >= 32 && $0 < 127 }) ? String(decoding: bytes, as: UTF8.self) : String(value)
}
func inputStreamCount(_ id: AudioDeviceID) -> UInt32? {
    var streams = address(kAudioDevicePropertyStreams, kAudioDevicePropertyScopeInput)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &size) == noErr else { return nil }
    return size / UInt32(MemoryLayout<AudioStreamID>.size)
}
func microphones() throws -> [Microphone] {
    var key = address(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    let sizeStatus = timed("system: device list size (first HAL call)") {
        AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &key, 0, nil, &size)
    }
    guard sizeStatus == noErr else {
        throw NSError(domain: "マイク一覧を取得できませんでした", code: 5)
    }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    let listStatus = timed("system: device list (\(ids.count) devices)") {
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &key, 0, nil, &size, &ids)
    }
    guard listStatus == noErr else {
        throw NSError(domain: "マイク一覧を取得できませんでした", code: 5)
    }
    if debugTiming {
        // Diagnostic only: describe every device, including output-only ones
        // that normal enumeration skips, so a slow device can be identified.
        for id in ids {
            let transport = timed("device \(id): transport type") { uint32Property(id, kAudioDevicePropertyTransportType) }
            let objectClass = timed("device \(id): class") { uint32Property(id, kAudioObjectPropertyClass) }
            let name = timed("device \(id): name") { stringProperty(id, kAudioObjectPropertyName) }
            trace("device \(id): name=\(name ?? "?") transport=\(fourCC(transport)) class=\(fourCC(objectClass))")
        }
    }
    // Only input-capable devices are asked for anything beyond their input
    // stream count: one cheap size query per device, then UID and name.
    return ids.compactMap { id in
        guard let count = timed("device \(id): input stream count", { inputStreamCount(id) }), count > 0,
              let uid = timed("device \(id): UID", { stringProperty(id, kAudioDevicePropertyDeviceUID) }) else { return nil }
        let name = timed("device \(id): name", { stringProperty(id, kAudioObjectPropertyName) })
        return Microphone(id: id, uid: uid, name: name ?? "マイク")
    }
}

@available(macOS 26.0, *)
func transcribe(deviceUID: String? = nil) async throws {
    guard SpeechTranscriber.isAvailable,
          let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "ja-JP")) else {
        throw NSError(domain: "日本語の音声認識に対応していません", code: 1)
    }
    let installed = await SpeechTranscriber.installedLocales
    guard installed.contains(where: { $0.identifier == locale.identifier }) else {
        throw NSError(domain: "日本語の音声認識モデルが未インストールです。macOSの音声入力設定で日本語を追加してください", code: 2)
    }
    if CommandLine.arguments.contains("--probe") {
        emit(["type": "available"])
        return
    }
    timing("locale-ready")
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let results = Task { () throws -> String in
        var text = ""
        for try await result in transcriber.results { text += String(result.text.characters) }
        return text
    }
    // File mode supports deterministic smoke tests without opening a microphone.
    if let index = CommandLine.arguments.firstIndex(of: "--file"), CommandLine.arguments.count > index + 1 {
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: CommandLine.arguments[index + 1]))
        if CommandLine.arguments.contains("--buffer-before-prepare") {
            guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]),
                  let converter = AVAudioConverter(from: file.processingFormat, to: format) else {
                throw NSError(domain: "テスト音声を変換できません", code: 4)
            }
            let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
            while file.framePosition < file.length {
                guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4096) else { break }
                try file.read(into: buffer)
                let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 16
                guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { break }
                var supplied = false
                var conversionError: NSError?
                converter.convert(to: converted, error: &conversionError) { _, status in
                    if supplied { status.pointee = .noDataNow; return nil }
                    supplied = true
                    status.pointee = .haveData
                    return buffer
                }
                if let conversionError { throw conversionError }
                if converted.frameLength > 0 { continuation.yield(AnalyzerInput(buffer: converted)) }
            }
            continuation.finish()
            try await analyzer.prepareToAnalyze(in: format)
            try await analyzer.start(inputSequence: stream)
            try await analyzer.finalizeAndFinishThroughEndOfInput()
        } else {
            let fileAnalyzer = try await SpeechAnalyzer(inputAudioFile: file, modules: [transcriber], finishAfterFile: true)
            _ = fileAnalyzer
        }
        emit(["type": "result", "text": try await results.value])
        return
    }
    if CommandLine.arguments.contains("--prepare-only") {
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw NSError(domain: "音声形式を利用できません", code: 4)
        }
        timing("format-ready")
        try await analyzer.prepareToAnalyze(in: format)
        timing("analyzer-ready")
        results.cancel()
        return
    }
    let permitted = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized ? true : await AVCaptureDevice.requestAccess(for: .audio)
    guard permitted else {
        throw NSError(domain: "マイクの使用が許可されていません。システム設定のプライバシーとセキュリティをご確認ください", code: 3)
    }
    timing("permission-ready")
    let engine = AVAudioEngine()
    defer { engine.stop() }
    let input = engine.inputNode
    let devices = try microphones()
    let requested = deviceUID ?? CommandLine.arguments.firstIndex(of: "--device").flatMap { index in
        CommandLine.arguments.count > index + 1 ? CommandLine.arguments[index + 1] : nil
    }
    guard let device = devices.first(where: { requested == nil ? $0.id == defaultMicrophone() : $0.uid == requested }),
          let unit = input.audioUnit else {
        throw NSError(domain: "選択したマイクが見つかりません。接続を確認するか、別のマイクを選んでください", code: 6)
    }
    var deviceID = device.id
    guard AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &deviceID, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr else {
        throw NSError(domain: "選択したマイクを使用できませんでした", code: 7)
    }
    guard currentInputDevice(engine) == deviceID else {
        throw NSError(domain: "マイクの切り替えを確認できませんでした。別のマイクをお試しください", code: 8)
    }
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
        throw NSError(domain: "マイクの音声形式を利用できません", code: 4)
    }
    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    let capture = MicrophoneCapture(engine: engine, device: device, target: format, continuation: continuation)
    try capture.start()
    timing("microphone-started")
    emit(["type": "listening", "deviceName": device.name])
    // The parent closes stdin on stop. Cancellation terminates this helper.
    // Capture immediately. AsyncStream retains audio in memory until the model
    // is ready; the parent bounds recording to 120 seconds and kills on cancel.
    // Stop must close the microphone even while model preparation is pending.
    let stopped = Task {
        await Task.detached { while readLine() != nil {} }.value
        capture.stop()
        continuation.finish()
        timing("microphone-stopped")
    }
    try await analyzer.prepareToAnalyze(in: format)
    timing("analyzer-ready")
    try await analyzer.start(inputSequence: stream)
    await stopped.value
    try await analyzer.finalizeAndFinishThroughEndOfInput()
    emit(["type": "result", "text": try await results.value])
}

func currentInputDevice(_ engine: AVAudioEngine) -> AudioDeviceID? {
    guard let unit = engine.inputNode.audioUnit else { return nil }
    var device = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, &size) == noErr else { return nil }
    return device
}
func isAlive(_ device: AudioDeviceID) -> Bool {
    var alive: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    var key = address(kAudioDevicePropertyDeviceIsAlive)
    return AudioObjectGetPropertyData(device, &key, 0, nil, &size, &alive) == noErr && alive != 0
}
func describe(_ format: AVAudioFormat) -> String { "\(format.channelCount)ch/\(Int(format.sampleRate))Hz" }

/// Owns the microphone input chain (tap + converter) of one recording and keeps
/// it on the device the user chose. Every engine mutation runs on `queue`.
///
/// The tap is built for the selected device's *hardware* format
/// (`inputNode.inputFormat(forBus: 0)`). `inputNode.outputFormat(forBus: 0)`
/// still describes the system default device after
/// kAudioOutputUnitProperty_CurrentDevice is changed, and a tap built for that
/// stale format receives no audio at all once the engine reconfigures for the
/// real device. See InputRoute.swift for what a configuration change does.
@available(macOS 26.0, *)
final class MicrophoneCapture: @unchecked Sendable {
    private let engine: AVAudioEngine
    private let device: Microphone
    private let target: AVAudioFormat
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private let queue = DispatchQueue(label: "acb-speech.capture")
    private var tapFormat: AVAudioFormat?
    private var rebuilds = 0
    private var stopped = false
    private var pendingCheck: DispatchWorkItem?
    private var observer: NSObjectProtocol?
    private var monitor: DispatchSourceTimer?

    init(engine: AVAudioEngine, device: Microphone, target: AVAudioFormat, continuation: AsyncStream<AnalyzerInput>.Continuation) {
        self.engine = engine
        self.device = device
        self.target = target
        self.continuation = continuation
    }

    func start() throws {
        // Observe before starting: the reconfiguration that follows our own
        // device selection is posted right after the engine starts.
        observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            self?.configurationChanged()
        }
        try queue.sync { try installAndStart() }
        let monitor = DispatchSource.makeTimerSource(queue: queue)
        monitor.schedule(deadline: .now() + 1, repeating: 1)
        monitor.setEventHandler { [weak self] in
            guard let self, !self.stopped, !isAlive(self.device.id) else { return }
            self.fail(.deviceGone)
        }
        monitor.resume()
        self.monitor = monitor
    }

    func stop() {
        queue.sync {
            stopped = true
            pendingCheck?.cancel()
            monitor?.cancel()
            if let observer { NotificationCenter.default.removeObserver(observer) }
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
    }

    /// Builds the tap and converter for the device's current hardware format
    /// and (re)starts the engine. Audio already yielded stays in the stream.
    private func installAndStart() throws {
        let input = engine.inputNode
        let source = input.inputFormat(forBus: 0)
        guard source.sampleRate > 0, source.channelCount > 0,
              let converter = AVAudioConverter(from: source, to: target) else {
            throw NSError(domain: "マイクの音声形式を利用できません", code: 4)
        }
        trace("capture: tap \(describe(source)) on device \(device.id) (engine output bus reports \(describe(input.outputFormat(forBus: 0))))")
        let target = self.target
        let continuation = self.continuation
        var lastMeterTime = Date.timeIntervalSinceReferenceDate
        input.installTap(onBus: 0, bufferSize: 4096, format: source) { buffer, _ in
            let now = Date.timeIntervalSinceReferenceDate
            if now - lastMeterTime >= 0.1 {
                lastMeterTime = now
                let meter = audioLevel(buffer)
                emit(["type": "level", "level": meter.level, "clipping": meter.clipping])
            }
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / source.sampleRate) + 16
            guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
            var supplied = false
            var error: NSError?
            converter.convert(to: converted, error: &error) { _, status in
                if supplied { status.pointee = .noDataNow; return nil }
                supplied = true
                status.pointee = .haveData
                return buffer
            }
            if error == nil && converted.frameLength > 0 { continuation.yield(AnalyzerInput(buffer: converted)) }
        }
        tapFormat = source
        if rebuilds == 0 { timing("device-ready") }
        engine.prepare()
        try engine.start()
    }

    private func configurationChanged() {
        trace("capture: AVAudioEngineConfigurationChange (running=\(engine.isRunning))")
        // Coalesce a burst of notifications into one decision.
        queue.async { [self] in
            guard !stopped else { return }
            pendingCheck?.cancel()
            let check = DispatchWorkItem { [weak self] in self?.reconcile() }
            pendingCheck = check
            queue.asyncAfter(deadline: .now() + 0.1, execute: check)
        }
    }

    private func reconcile() {
        guard !stopped else { return }
        let hardware = engine.inputNode.inputFormat(forBus: 0)
        let state = InputRouteState(
            currentDevice: currentInputDevice(engine),
            selectedDevice: device.id,
            deviceAlive: isAlive(device.id),
            engineRunning: engine.isRunning,
            hardwareSampleRate: hardware.sampleRate,
            hardwareChannels: hardware.channelCount,
            tapSampleRate: tapFormat?.sampleRate ?? 0,
            tapChannels: tapFormat?.channelCount ?? 0)
        let action = decideInputRoute(state, rebuildsSoFar: rebuilds)
        trace("capture: \(state) -> \(action)")
        switch action {
        case .keep:
            return
        case .rebuild:
            rebuilds += 1
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
            do {
                try installAndStart()
                timing("microphone-rebuilt")
            } catch {
                trace("capture: rebuild failed: \(error)")
                fail(.unstable)
            }
        case .stop(let reason):
            fail(reason)
        }
    }

    private func fail(_ reason: InputRouteStopReason) {
        emit(["type": "error", "message": inputRouteMessage(reason)])
        exit(1)
    }
}

// Error code for "this macOS cannot run speech recognition at all" (no retry).
let unsupportedOSCode = 10

@main struct SpeechHelper {
    static func main() async {
        do {
            let oneShot = ["--probe", "--devices", "--devices-debug"].contains(where: CommandLine.arguments.contains)
            if let delay = launchDelayMs() {
                trace(String(format: "exec -> main: %.1fms", delay))
                // One-shot modes report how long the system held the process
                // before main() (code-signing / system policy assessment), so
                // the app can log where a slow probe or device list spent its
                // time. Never emitted in standby/recording mode.
                if oneShot { emit(["type": "launch", "execToMainMs": Int(delay)]) }
            }
            if CommandLine.arguments.contains("--devices") || CommandLine.arguments.contains("--devices-debug") {
                let devices = try microphones()
                let defaultID = timed("system: default input device") { defaultMicrophone() }
                emit(["type": "devices", "devices": devices.map { ["id": $0.uid, "name": $0.name, "isDefault": $0.id == defaultID] as [String: Any] }])
                return
            }
            var deviceUID: String?
            if CommandLine.arguments.contains("--standby") {
                // Do not instantiate AVAudioEngine, request permission or open a
                // microphone until an explicit start command arrives.
                emit(["type": "standby-ready"])
                guard let line = await Task.detached(operation: { readLine() }).value else { return }
                guard let data = line.data(using: .utf8),
                      let command = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      command["command"] as? String == "start" else {
                    throw NSError(domain: "無効な音声入力コマンドです", code: 9)
                }
                deviceUID = command["deviceId"] as? String
                launchTime = ProcessInfo.processInfo.systemUptime
            }
            if #available(macOS 26.0, *) { try await transcribe(deviceUID: deviceUID) }
            else { emit(["type": "error", "message": "音声入力にはmacOS 26以降が必要です", "code": unsupportedOSCode]); exit(1) }
        } catch {
            // `code` lets the app tell a permanent condition from one worth
            // retrying; see voice-probe.ts.
            emit(["type": "error", "message": (error as NSError).domain, "code": (error as NSError).code])
            exit(1)
        }
    }
}
