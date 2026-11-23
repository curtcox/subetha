package us.subetha.sample.doorbell

import android.graphics.Bitmap
import android.graphics.Color
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.EncodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import java.util.concurrent.Executors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import us.subetha.core.QrSender

/** One QR code for [text] (alphanumeric base45 text becomes an alphanumeric-mode symbol). */
fun qrBitmap(text: String): Bitmap {
    val hints = mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.L, EncodeHintType.MARGIN to 2)
    val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, hints) // one pixel per module
    val pixels = IntArray(m.width * m.height) { i -> if (m[i % m.width, i / m.width]) Color.BLACK else Color.WHITE }
    return Bitmap.createBitmap(pixels, m.width, m.height, Bitmap.Config.ARGB_8888)
}

/**
 * Shows [sender]'s frames one after another, forever (spec §11.2). A camera that starts late
 * or misses frames just keeps scanning.
 */
@Composable
fun AnimatedQr(sender: QrSender, framesPerSecond: Int = 8) {
    var frame by remember(sender) { mutableStateOf<Bitmap?>(null) }
    LaunchedEffect(sender) {
        var seq = 0
        while (true) {
            frame = withContext(Dispatchers.Default) { qrBitmap(sender.text(seq)) }
            seq++
            delay(1000L / framesPerSecond)
        }
    }
    // A white quiet zone around the code, whatever the theme.
    Box(Modifier.fillMaxWidth().aspectRatio(1f).background(androidx.compose.ui.graphics.Color.White).padding(8.dp)) {
        frame?.let {
            Image(it.asImageBitmap(), "Animated QR code", Modifier.fillMaxWidth().aspectRatio(1f), filterQuality = FilterQuality.None)
        }
    }
}

/**
 * Camera preview that decodes every QR code it sees and passes the text to [onText], on a
 * single background thread. Needs the CAMERA permission.
 */
@Composable
fun QrScanner(onText: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    val previewView = remember { PreviewView(context) }
    DisposableEffect(lifecycleOwner) {
        val future = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        future.addListener({
            val p = future.get()
            provider = p
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            val decoder = QrFrameDecoder()
            analysis.setAnalyzer(executor) { image -> image.use { decoder.decode(it)?.let(onText) } }
            p.unbindAll()
            p.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        }, ContextCompat.getMainExecutor(context))
        onDispose {
            provider?.unbindAll()
            executor.shutdown()
        }
    }
    AndroidView({ previewView }, Modifier.fillMaxWidth().height(280.dp))
}

/** ZXing on the luminance (Y) plane of a camera frame. */
private class QrFrameDecoder {
    private val reader = QRCodeReader()
    private val hints = mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE))

    fun decode(image: ImageProxy): String? {
        val plane = image.planes[0]
        val buffer = plane.buffer
        val bytes = ByteArray(buffer.remaining()).also { buffer.get(it) }
        val stride = plane.rowStride
        if (bytes.size < stride * (image.height - 1) + image.width) return null
        val source = PlanarYUVLuminanceSource(bytes, stride, image.height, 0, 0, image.width, image.height, false)
        return try {
            reader.decode(BinaryBitmap(HybridBinarizer(source)), hints).text
        } catch (_: ReaderException) {
            null
        } finally {
            reader.reset()
        }
    }
}
