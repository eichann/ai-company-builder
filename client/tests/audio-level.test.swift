import AVFoundation
@main struct AudioLevelTests {
    static func main() {
        for interleaved in [false, true] {
            let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: interleaved)!
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 128)!
            assert(audioLevel(buffer).level == 0)
            buffer.frameLength = 128
            for amplitude: Float in [0, 0.001, 0.01, 0.1, 1] {
                for channel in 0..<2 {
                    for frame in 0..<128 {
                        if interleaved { buffer.floatChannelData![0][frame * 2 + channel] = amplitude }
                        else { buffer.floatChannelData![channel][frame] = amplitude }
                    }
                }
                let value = audioLevel(buffer)
                let expected: Float = amplitude == 0 ? 0 : max(0, (20 * log10(amplitude) + 60) / 60)
                assert(abs(value.level - expected) < 0.001)
                assert(value.clipping == (amplitude == 1))
            }
        }
        print("PASS silence, amplitude, clipping, interleaved and planar PCM metering")
    }
}
