// Decides what a recording does after AVAudioEngine reports a configuration
// change. Pure (no CoreAudio / AVFoundation calls) so it is unit tested in
// tests/input-route.test.swift; SpeechHelper.swift gathers the facts.
//
// Why this exists: selecting a microphone other than the system default
// (kAudioOutputUnitProperty_CurrentDevice) makes the engine reconfigure its
// input I/O unit right after start whenever the selected device's hardware
// format differs from the default's (e.g. a 1 ch / 48 kHz built-in microphone
// while the default is a 2 ch / 44.1 kHz virtual device). That notification is
// a consequence of our own selection, not of the user's source changing. A
// device whose sample rate changes mid-recording posts the same notification
// and stops the engine. In both cases the device is still the chosen one, so
// the input chain is rebuilt; only a different or vanished device stops the
// recording ("never silently record from another microphone").

struct InputRouteState: Equatable {
    /// The input unit's current device, or nil when it could not be read.
    var currentDevice: UInt32?
    var selectedDevice: UInt32
    var deviceAlive: Bool
    var engineRunning: Bool
    /// The selected device's hardware input format as the engine now sees it.
    var hardwareSampleRate: Double
    var hardwareChannels: UInt32
    /// The format the current tap and converter were built for.
    var tapSampleRate: Double
    var tapChannels: UInt32
}

enum InputRouteStopReason: Equatable {
    /// The input unit is no longer on the device the user chose.
    case deviceChanged
    /// The chosen device disappeared or no longer offers an input format.
    case deviceGone
    /// The device kept reconfiguring past the rebuild budget.
    case unstable
}

enum InputRouteAction: Equatable {
    /// Still capturing from the chosen device in the format the tap expects.
    case keep
    /// Same device, but the engine stopped or the format changed: rebuild.
    case rebuild
    case stop(InputRouteStopReason)
}

/// Rebuilds allowed per recording. A real device settles after one or two;
/// a flapping one must not loop for the whole 120 s recording.
let maxInputRebuilds = 5

func decideInputRoute(_ state: InputRouteState, rebuildsSoFar: Int, maxRebuilds: Int = maxInputRebuilds) -> InputRouteAction {
    guard state.deviceAlive else { return .stop(.deviceGone) }
    guard let current = state.currentDevice, current == state.selectedDevice else { return .stop(.deviceChanged) }
    guard state.hardwareSampleRate > 0, state.hardwareChannels > 0 else { return .stop(.deviceGone) }
    let formatChanged = state.hardwareSampleRate != state.tapSampleRate || state.hardwareChannels != state.tapChannels
    if state.engineRunning && !formatChanged { return .keep }
    return rebuildsSoFar < maxRebuilds ? .rebuild : .stop(.unstable)
}

func inputRouteMessage(_ reason: InputRouteStopReason) -> String {
    switch reason {
    case .deviceGone: return "録音中のマイクが切断されました。接続し直すか、別のマイクを選んでください"
    case .deviceChanged, .unstable: return "マイクの接続または設定が変わったため録音を停止しました。マイクを選び直してください"
    }
}
