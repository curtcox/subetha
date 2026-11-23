package us.subetha.sample.doorbell

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * The platform half of the sound link: plays modem samples through AudioTrack and feeds
 * AudioRecord buffers to a callback. Everything else (modulation, scanning, gossip) is
 * us.subetha.core.AudioLink.
 */
class AndroidAudio(val sampleRate: Int = 48_000) {
    /** Plays [samples] (mono, -1..1) and calls [done] when they have finished. */
    fun play(samples: FloatArray, done: () -> Unit = {}) {
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(samples.size * 4)
            .build()
        track.write(samples, 0, samples.size, AudioTrack.WRITE_BLOCKING)
        track.play()
        thread(name = "subetha-audio-out") {
            Thread.sleep(samples.size * 1000L / sampleRate + 250)
            track.release()
            done()
        }
    }

    /** Records until the returned function is called. Needs the RECORD_AUDIO permission. */
    @SuppressLint("MissingPermission")
    fun record(onSamples: (FloatArray) -> Unit): () -> Unit {
        val min = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_FLOAT)
        val rec = AudioRecord(MediaRecorder.AudioSource.MIC, sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_FLOAT, maxOf(min, 16_384 * 4))
        val running = AtomicBoolean(true)
        thread(name = "subetha-audio-in") {
            val buf = FloatArray(4096)
            rec.startRecording()
            try {
                while (running.get()) {
                    val n = rec.read(buf, 0, buf.size, AudioRecord.READ_BLOCKING)
                    if (n > 0) onSamples(buf.copyOf(n))
                }
            } finally {
                rec.stop()
                rec.release()
            }
        }
        return { running.set(false) }
    }
}
