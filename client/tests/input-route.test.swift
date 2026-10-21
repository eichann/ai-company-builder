// Built without -O so assert() stays active:
//   xcrun swiftc -parse-as-library native/InputRoute.swift tests/input-route.test.swift -o /tmp/input-route-test
@main struct InputRouteTests {
    static func main() {
        // Measured on a Mac whose default input is a 2 ch / 44.1 kHz virtual
        // device while the user picks the 1 ch / 48 kHz built-in microphone.
        let settled = InputRouteState(currentDevice: 90, selectedDevice: 90, deviceAlive: true, engineRunning: true,
                                      hardwareSampleRate: 48000, hardwareChannels: 1, tapSampleRate: 48000, tapChannels: 1)

        // The reconfiguration that follows our own device selection: same
        // device, still running, tap already in the hardware format.
        assert(decideInputRoute(settled, rebuildsSoFar: 0) == .keep)

        // The device's sample rate changed mid-recording: the engine stops and
        // the hardware format no longer matches the tap.
        var rateChanged = settled
        rateChanged.engineRunning = false
        rateChanged.hardwareSampleRate = 44100
        assert(decideInputRoute(rateChanged, rebuildsSoFar: 0) == .rebuild)

        // Channel count change while running still needs a new tap.
        var channelsChanged = settled
        channelsChanged.hardwareChannels = 2
        assert(decideInputRoute(channelsChanged, rebuildsSoFar: 0) == .rebuild)

        // Engine stopped with an unchanged format (Apple's documented
        // contract for a configuration change) is restarted, not abandoned.
        var stoppedSameFormat = settled
        stoppedSameFormat.engineRunning = false
        assert(decideInputRoute(stoppedSameFormat, rebuildsSoFar: 0) == .rebuild)

        // A flapping device gets a bounded number of rebuilds.
        assert(decideInputRoute(rateChanged, rebuildsSoFar: maxInputRebuilds - 1) == .rebuild)
        assert(decideInputRoute(rateChanged, rebuildsSoFar: maxInputRebuilds) == .stop(.unstable))
        assert(decideInputRoute(rateChanged, rebuildsSoFar: 2, maxRebuilds: 2) == .stop(.unstable))
        // ...but a benign notification never consumes or exceeds the budget.
        assert(decideInputRoute(settled, rebuildsSoFar: maxInputRebuilds) == .keep)

        // The system moved the input unit to another device (observed when the
        // default input changes during a recording): never follow it.
        var switched = rateChanged
        switched.currentDevice = 185
        assert(decideInputRoute(switched, rebuildsSoFar: 0) == .stop(.deviceChanged))
        var unreadable = settled
        unreadable.currentDevice = nil
        assert(decideInputRoute(unreadable, rebuildsSoFar: 0) == .stop(.deviceChanged))

        // The chosen device disappeared or lost its input format.
        var gone = settled
        gone.deviceAlive = false
        assert(decideInputRoute(gone, rebuildsSoFar: 0) == .stop(.deviceGone))
        var noFormat = rateChanged
        noFormat.hardwareSampleRate = 0
        assert(decideInputRoute(noFormat, rebuildsSoFar: 0) == .stop(.deviceGone))
        noFormat = rateChanged
        noFormat.hardwareChannels = 0
        assert(decideInputRoute(noFormat, rebuildsSoFar: 0) == .stop(.deviceGone))

        // Messages keep their meaning for the app.
        assert(inputRouteMessage(.deviceGone) == "録音中のマイクが切断されました。接続し直すか、別のマイクを選んでください")
        assert(inputRouteMessage(.deviceChanged) == "マイクの接続または設定が変わったため録音を停止しました。マイクを選び直してください")
        assert(inputRouteMessage(.unstable) == inputRouteMessage(.deviceChanged))
        print("PASS keep after own device selection, rebuild on format change or stop, bounded rebuilds, stop on device switch or loss")
    }
}
