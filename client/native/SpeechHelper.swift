import Foundation
import Speech
import AVFoundation
import CoreAudio
import AudioToolbox

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
func microphones() throws -> [Microphone] {
    var key = address(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &key, 0, nil, &size) == noErr else {
        throw NSError(domain: "マイク一覧を取得できませんでした", code: 5)
    }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &key, 0, nil, &size, &ids) == noErr else {
        throw NSError(domain: "マイク一覧を取得できませんでした", code: 5)
    }
    return ids.compactMap { id in
        var streams = address(kAudioDevicePropertyStreams, kAudioDevicePropertyScopeInput)
        var streamSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &streamSize) == noErr, streamSize > 0,
              let uid = stringProperty(id, kAudioDevicePropertyDeviceUID) else { return nil }
        return Microphone(id: id, uid: uid, name: stringProperty(id, kAudioObjectPropertyName) ?? "マイク")
    }
}

@available(macOS 26.0, *)
func transcribe() async throws {
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
        let fileAnalyzer = try await SpeechAnalyzer(inputAudioFile: file, modules: [transcriber], finishAfterFile: true)
        _ = fileAnalyzer
        emit(["type": "result", "text": try await results.value])
        return
    }
    guard await AVCaptureDevice.requestAccess(for: .audio) else {
        throw NSError(domain: "マイクの使用が許可されていません。システム設定のプライバシーとセキュリティをご確認ください", code: 3)
    }
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let devices = try microphones()
    let requested = CommandLine.arguments.firstIndex(of: "--device").flatMap { index in
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
    var actualDevice = AudioDeviceID(0)
    var actualSize = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &actualDevice, &actualSize) == noErr, actualDevice == deviceID else {
        throw NSError(domain: "マイクの切り替えを確認できませんでした。別のマイクをお試しください", code: 8)
    }
    let sourceFormat = input.outputFormat(forBus: 0)
    guard sourceFormat.sampleRate > 0, sourceFormat.channelCount > 0,
          let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]),
          let converter = AVAudioConverter(from: sourceFormat, to: format) else {
        throw NSError(domain: "マイクの音声形式を利用できません", code: 4)
    }
    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    try await analyzer.prepareToAnalyze(in: format)
    try await analyzer.start(inputSequence: stream)
    var lastMeterTime = Date.timeIntervalSinceReferenceDate
    input.installTap(onBus: 0, bufferSize: 4096, format: sourceFormat) { buffer, _ in
        let now = Date.timeIntervalSinceReferenceDate
        if now - lastMeterTime >= 0.1 {
            lastMeterTime = now
            let meter = audioLevel(buffer)
            emit(["type": "level", "level": meter.level, "clipping": meter.clipping])
        }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / sourceFormat.sampleRate) + 16
        guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
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
    engine.prepare()
    try engine.start()
    // Freeze this recording to the selected device. Never silently switch sources.
    let changed = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { _ in
        emit(["type": "error", "message": "マイクの接続または設定が変わったため録音を停止しました。マイクを選び直してください"])
        exit(1)
    }
    defer { NotificationCenter.default.removeObserver(changed) }
    let connectionMonitor = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
    connectionMonitor.schedule(deadline: .now() + 1, repeating: 1)
    connectionMonitor.setEventHandler {
        var alive: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        var key = address(kAudioDevicePropertyDeviceIsAlive)
        if AudioObjectGetPropertyData(device.id, &key, 0, nil, &size, &alive) != noErr || alive == 0 {
            emit(["type": "error", "message": "録音中のマイクが切断されました。接続し直すか、別のマイクを選んでください"])
            exit(1)
        }
    }
    connectionMonitor.resume()
    defer { connectionMonitor.cancel() }
    emit(["type": "listening", "deviceName": device.name])
    // The parent closes stdin on stop. Cancellation terminates this helper.
    await Task.detached { while readLine() != nil {} }.value
    NotificationCenter.default.removeObserver(changed)
    connectionMonitor.cancel()
    engine.stop()
    input.removeTap(onBus: 0)
    continuation.finish()
    try await analyzer.finalizeAndFinishThroughEndOfInput()
    emit(["type": "result", "text": try await results.value])
}

@main struct SpeechHelper {
    static func main() async {
        do {
            if CommandLine.arguments.contains("--devices") {
                let devices = try microphones()
                let defaultID = defaultMicrophone()
                emit(["type": "devices", "devices": devices.map { ["id": $0.uid, "name": $0.name, "isDefault": $0.id == defaultID] as [String: Any] }])
                return
            }
            if #available(macOS 26.0, *) { try await transcribe() }
            else { emit(["type": "error", "message": "音声入力にはmacOS 26以降が必要です"]); exit(1) }
        } catch {
            emit(["type": "error", "message": (error as NSError).domain])
            exit(1)
        }
    }
}
