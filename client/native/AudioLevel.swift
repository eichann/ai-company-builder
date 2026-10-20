import AVFoundation

// Meter the same PCM buffers that are passed to recognition. Display -60...0 dBFS.
func audioLevel(_ buffer: AVAudioPCMBuffer) -> (level: Float, clipping: Bool) {
    guard let channels = buffer.floatChannelData, buffer.frameLength > 0, buffer.format.channelCount > 0 else { return (0, false) }
    var squareSum: Float = 0
    var peak: Float = 0
    let channelCount = Int(buffer.format.channelCount)
    for channel in 0..<channelCount {
        for frame in 0..<Int(buffer.frameLength) {
            let value = buffer.format.isInterleaved ? channels[0][frame * channelCount + channel] : channels[channel][frame]
            let sample = value.isFinite ? value : 0
            squareSum += sample * sample
            peak = max(peak, abs(sample))
        }
    }
    let rms = sqrt(squareSum / Float(Int(buffer.frameLength) * channelCount))
    let db = max(-60, 20 * log10(max(rms, 0.000001)))
    return (min(1, max(0, (db + 60) / 60)), peak >= 0.99)
}
