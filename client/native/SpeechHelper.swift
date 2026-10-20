import Foundation
import Speech
import AVFoundation

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
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
    let sourceFormat = input.outputFormat(forBus: 0)
    guard sourceFormat.sampleRate > 0, sourceFormat.channelCount > 0,
          let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]),
          let converter = AVAudioConverter(from: sourceFormat, to: format) else {
        throw NSError(domain: "マイクの音声形式を利用できません", code: 4)
    }
    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    try await analyzer.prepareToAnalyze(in: format)
    try await analyzer.start(inputSequence: stream)
    input.installTap(onBus: 0, bufferSize: 4096, format: sourceFormat) { buffer, _ in
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
    emit(["type": "listening"])
    // The parent closes stdin on stop. Cancellation terminates this helper.
    await Task.detached { while readLine() != nil {} }.value
    engine.stop()
    input.removeTap(onBus: 0)
    continuation.finish()
    try await analyzer.finalizeAndFinishThroughEndOfInput()
    emit(["type": "result", "text": try await results.value])
}

@main struct SpeechHelper {
    static func main() async {
        do {
            if #available(macOS 26.0, *) { try await transcribe() }
            else { emit(["type": "error", "message": "音声入力にはmacOS 26以降が必要です"]); exit(1) }
        } catch {
            emit(["type": "error", "message": (error as NSError).domain])
            exit(1)
        }
    }
}
