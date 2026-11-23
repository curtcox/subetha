package us.subetha.sample.doorbell

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelUuid
import java.io.ByteArrayOutputStream
import java.security.SecureRandom
import java.util.ArrayDeque
import java.util.UUID
import us.subetha.core.BleLink
import us.subetha.core.ffi.EdgeGossipNode

/**
 * The platform half of the Bluetooth LE link (spec §11.3). The phone is both a peripheral
 * (GATT server + advertising, so other phones and Web Bluetooth pages can connect to it) and a
 * central (scans for the SubEtha service and connects). Each connection gets an
 * us.subetha.core.BleLink, which does the chunking and the gossip; this class only moves chunks.
 *
 * Android allows one outstanding GATT operation per connection, so writes and notifications go
 * through small queues that advance on each completion callback. Everything runs on one
 * HandlerThread, so the links are never used from two threads at once.
 *
 * Needs BLUETOOTH_SCAN, BLUETOOTH_CONNECT and BLUETOOTH_ADVERTISE (Android 12+) or
 * ACCESS_FINE_LOCATION (Android 8–11), and Bluetooth turned on.
 */
@SuppressLint("MissingPermission")
class AndroidBle(
    private val context: Context,
    private val node: EdgeGossipNode,
    /** New envelopes (JSON) from any peer. Called on the BLE thread. */
    private val onMessage: (String) -> Unit,
    /** Human-readable connection changes, for the UI. */
    private val onStatus: (String) -> Unit = {},
) {
    private val manager = context.getSystemService(BluetoothManager::class.java)
    private val adapter get() = manager?.adapter
    private val thread = HandlerThread("subetha-ble").apply { start() }
    private val handler = Handler(thread.looper)

    /** Random per run; with two Android phones only the one with the lower token connects. */
    private val token = ByteArray(4).also { SecureRandom().nextBytes(it) }

    private var server: BluetoothGattServer? = null
    private var running = false

    /** Peripheral side: centrals connected to our GATT server, by address. */
    private val centrals = HashMap<String, CentralPeer>()

    /** Central side: our connections to other peripherals, by address. */
    private val peripherals = HashMap<String, PeripheralPeer>()

    /** Addresses we disconnected from recently, so we don't reconnect in a tight loop. */
    private val cooldown = HashMap<String, Long>()

    /** Notifications share the outbox characteristic, so they're sent one at a time. */
    private val notifyQueue = ArrayDeque<Pair<BluetoothDevice, ByteArray>>()
    private var notifying = false

    val peerCount: Int get() = centrals.values.count { it.subscribed } + peripherals.values.count { it.link != null }

    // --- lifecycle ------------------------------------------------------------------------

    /** Starts the GATT server, advertising and scanning. Returns false if Bluetooth is off. */
    fun start(): Boolean {
        val a = adapter
        if (a == null || !a.isEnabled) return false
        handler.post {
            if (running) return@post
            running = true
            openServer()
            startAdvertising()
            startScanning()
            onStatus("Bluetooth on: advertising and scanning")
        }
        return true
    }

    fun stop() {
        handler.post {
            if (!running) return@post
            running = false
            runCatching { adapter?.bluetoothLeScanner?.stopScan(scanCallback) }
            runCatching { adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback) }
            peripherals.values.forEach { runCatching { it.gatt.close() } }
            peripherals.clear()
            centrals.clear()
            notifyQueue.clear()
            notifying = false
            runCatching { server?.close() }
            server = null
            onStatus("Bluetooth off")
        }
    }

    /** Tells every connected peer what we hold (after publishing or bridging something in). */
    fun resyncAll() {
        handler.post {
            centrals.values.filter { it.subscribed }.forEach { it.link.resync() }
            peripherals.values.forEach { it.link?.resync() }
        }
    }

    fun close() {
        stop()
        thread.quitSafely()
    }

    // --- peripheral: GATT server + advertising --------------------------------------------

    private class CentralPeer(val device: BluetoothDevice, val link: BleLink) {
        var subscribed = false
        val prepared = ByteArrayOutputStream()
    }

    private val outbox = BluetoothGattCharacteristic(
        OUTBOX,
        BluetoothGattCharacteristic.PROPERTY_NOTIFY or BluetoothGattCharacteristic.PROPERTY_INDICATE,
        BluetoothGattCharacteristic.PERMISSION_READ,
    ).apply {
        addDescriptor(BluetoothGattDescriptor(CCCD, BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE))
    }

    private fun openServer() {
        val s = manager?.openGattServer(context, serverCallback) ?: return
        val service = BluetoothGattService(SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        service.addCharacteristic(
            BluetoothGattCharacteristic(
                INBOX,
                BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
                BluetoothGattCharacteristic.PERMISSION_WRITE,
            ),
        )
        service.addCharacteristic(outbox)
        service.addCharacteristic(BluetoothGattCharacteristic(SUMMARY, BluetoothGattCharacteristic.PROPERTY_READ, BluetoothGattCharacteristic.PERMISSION_READ))
        service.addCharacteristic(BluetoothGattCharacteristic(VERSION, BluetoothGattCharacteristic.PROPERTY_READ, BluetoothGattCharacteristic.PERMISSION_READ))
        s.addService(service)
        server = s
    }

    private fun startAdvertising() {
        val advertiser = adapter?.bluetoothLeAdvertiser ?: return onStatus("This phone can't advertise; scanning only")
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true)
            .build()
        // The 128-bit service UUID fills most of the 31-byte packet; the token goes in the scan response.
        val data = AdvertiseData.Builder().addServiceUuid(ParcelUuid(SERVICE)).setIncludeDeviceName(false).build()
        val response = AdvertiseData.Builder().addServiceData(ParcelUuid(SERVICE), token).setIncludeDeviceName(false).build()
        advertiser.startAdvertising(settings, data, response, advertiseCallback)
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartFailure(errorCode: Int) {
            onStatus("Advertising failed ($errorCode); scanning only")
        }
    }

    private fun notifyChunk(device: BluetoothDevice, chunk: ByteArray) {
        notifyQueue.add(device to chunk)
        pumpNotifications()
    }

    private fun pumpNotifications() {
        val s = server ?: return
        while (!notifying) {
            val (device, chunk) = notifyQueue.poll() ?: return
            if (centrals[device.address]?.subscribed != true) continue
            // On failure, drop the chunk and try the next; the message times out and the peer resyncs.
            notifying = notifyCompat(s, device, outbox, chunk)
        }
    }

    private val serverCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            handler.post {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    if (device.address in centrals) return@post
                    centrals[device.address] = CentralPeer(device, BleLink(node, { notifyChunk(device, it) }, onMessage))
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    if (centrals.remove(device.address)?.subscribed == true) onStatus("A central disconnected ($peerCount connected)")
                }
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            handler.post { centrals[device.address]?.link?.attMtu = mtu }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?,
        ) {
            val bytes = value ?: ByteArray(0)
            val ok = characteristic.uuid == INBOX
            if (responseNeeded) {
                server?.sendResponse(device, requestId, if (ok) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_WRITE_NOT_PERMITTED, offset, bytes)
            }
            if (!ok) return
            handler.post {
                val peer = centrals[device.address] ?: return@post
                // Web Bluetooth's writeValueWithResponse uses long (prepared) writes for big chunks.
                if (preparedWrite) peer.prepared.write(bytes) else peer.link.receive(bytes)
            }
        }

        override fun onExecuteWrite(device: BluetoothDevice, requestId: Int, execute: Boolean) {
            server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            handler.post {
                val peer = centrals[device.address] ?: return@post
                val bytes = peer.prepared.toByteArray()
                peer.prepared.reset()
                if (execute && bytes.isNotEmpty()) peer.link.receive(bytes)
            }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?,
        ) {
            if (responseNeeded) server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
            if (descriptor.uuid != CCCD) return
            val on = value != null && value.isNotEmpty() && value[0].toInt() != 0
            handler.post {
                val peer = centrals[device.address] ?: return@post
                val was = peer.subscribed
                peer.subscribed = on
                if (on && !was) {
                    onStatus("A central connected ($peerCount connected)")
                    peer.link.resync()
                }
            }
        }

        override fun onDescriptorReadRequest(device: BluetoothDevice, requestId: Int, offset: Int, descriptor: BluetoothGattDescriptor) {
            val on = centrals[device.address]?.subscribed == true
            val v = if (on) BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE else BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
            server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, v.copyOfRange(minOf(offset, v.size), v.size))
        }

        override fun onCharacteristicReadRequest(device: BluetoothDevice, requestId: Int, offset: Int, characteristic: BluetoothGattCharacteristic) {
            val v = when (characteristic.uuid) {
                VERSION -> byteArrayOf(1)
                SUMMARY -> runCatching { node.summary(System.currentTimeMillis().toULong() / 1000u) }.getOrDefault(ByteArray(0))
                else -> null
            }
            if (v == null) {
                server?.sendResponse(device, requestId, BluetoothGatt.GATT_READ_NOT_PERMITTED, offset, null)
            } else {
                server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, v.copyOfRange(minOf(offset, v.size), v.size))
            }
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            handler.post {
                notifying = false
                pumpNotifications()
            }
        }
    }

    // --- central: scan + connect -----------------------------------------------------------

    private class PeripheralPeer(val gatt: BluetoothGatt) {
        var mtu = BleLink.DEFAULT_ATT_MTU
        var inbox: BluetoothGattCharacteristic? = null
        var link: BleLink? = null
        val writes = ArrayDeque<ByteArray>()
        var writing = false

        fun write(chunk: ByteArray) {
            writes.add(chunk)
            pump()
        }

        fun pump() {
            val c = inbox ?: return
            while (!writing) {
                val chunk = writes.poll() ?: return
                // A chunk is at most ATT_MTU − 3 bytes, so it fits one write request.
                writing = writeCompat(gatt, c, chunk)
            }
        }
    }

    private fun startScanning() {
        val scanner = adapter?.bluetoothLeScanner ?: return
        val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE)).build()
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        scanner.startScan(listOf(filter), settings, scanCallback)
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            handler.post { maybeConnect(result) }
        }

        override fun onScanFailed(errorCode: Int) {
            onStatus("Scanning failed ($errorCode); others can still connect to this phone")
        }
    }

    private fun maybeConnect(result: ScanResult) {
        if (!running) return
        val address = result.device.address
        if (address in peripherals || address in centrals || peripherals.size >= MAX_CENTRAL_LINKS) return
        cooldown[address]?.let { if (System.currentTimeMillis() < it) return }
        // Two Android phones see each other both ways; only the lower token connects. Peers
        // without a token (iOS, which can't advertise service data) are always connected to.
        val theirs = result.scanRecord?.getServiceData(ParcelUuid(SERVICE))
        if (theirs != null && theirs.size == token.size && compareUnsigned(token, theirs) >= 0) return
        val gatt = result.device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE) ?: return
        peripherals[address] = PeripheralPeer(gatt)
    }

    private fun drop(gatt: BluetoothGatt) {
        val address = gatt.device.address
        val had = peripherals.remove(address)?.link != null
        cooldown[address] = System.currentTimeMillis() + RECONNECT_COOLDOWN_MS
        runCatching { gatt.close() }
        if (had) onStatus("A peripheral disconnected ($peerCount connected)")
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            handler.post {
                if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                    if (!gatt.requestMtu(REQUESTED_MTU)) gatt.discoverServices()
                } else {
                    drop(gatt)
                }
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            handler.post {
                val peer = peripherals[gatt.device.address] ?: return@post
                if (status == BluetoothGatt.GATT_SUCCESS) peer.mtu = mtu
                peer.link?.attMtu = peer.mtu
                if (peer.inbox == null) gatt.discoverServices()
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            handler.post {
                val peer = peripherals[gatt.device.address] ?: return@post
                val service = gatt.getService(SERVICE)
                val inbox = service?.getCharacteristic(INBOX)
                val out = service?.getCharacteristic(OUTBOX)
                val cccd = out?.getDescriptor(CCCD)
                if (status != BluetoothGatt.GATT_SUCCESS || inbox == null || out == null || cccd == null) {
                    gatt.disconnect()
                    return@post
                }
                peer.inbox = inbox
                gatt.setCharacteristicNotification(out, true)
                if (!writeDescriptorCompat(gatt, cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) gatt.disconnect()
            }
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            handler.post {
                val peer = peripherals[gatt.device.address] ?: return@post
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    gatt.disconnect()
                    return@post
                }
                if (peer.link != null) return@post
                val link = BleLink(node, peer::write, onMessage, peer.mtu)
                peer.link = link
                onStatus("Connected to a peripheral ($peerCount connected)")
                link.resync()
            }
        }

        override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            handler.post {
                val peer = peripherals[gatt.device.address] ?: return@post
                peer.writing = false
                peer.pump()
            }
        }

        // Android 13+ calls this overload; older versions call the deprecated one below.
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            received(gatt, characteristic, value)
        }

        @Deprecated("Android 12 and lower")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            @Suppress("DEPRECATION")
            val value = characteristic.value ?: return
            received(gatt, characteristic, value.copyOf())
        }

        private fun received(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            if (characteristic.uuid != OUTBOX) return
            handler.post { peripherals[gatt.device.address]?.link?.receive(value) }
        }
    }

    companion object {
        val SERVICE: UUID = UUID.fromString("53554245-5448-4100-8000-5ebe7a000000")
        val INBOX: UUID = UUID.fromString("53554245-5448-4100-8000-5ebe7a000001")
        val OUTBOX: UUID = UUID.fromString("53554245-5448-4100-8000-5ebe7a000002")
        val SUMMARY: UUID = UUID.fromString("53554245-5448-4100-8000-5ebe7a000003")
        val VERSION: UUID = UUID.fromString("53554245-5448-4100-8000-5ebe7a000004")
        private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        private const val REQUESTED_MTU = 247
        private const val MAX_CENTRAL_LINKS = 4
        private const val RECONNECT_COOLDOWN_MS = 15_000L

        // Android 13 replaced the value-on-the-object GATT calls; these pick the right one.

        @Suppress("DEPRECATION")
        private fun notifyCompat(s: BluetoothGattServer, d: BluetoothDevice, c: BluetoothGattCharacteristic, v: ByteArray): Boolean =
            if (Build.VERSION.SDK_INT >= 33) {
                s.notifyCharacteristicChanged(d, c, false, v) == BluetoothStatusCodes.SUCCESS
            } else {
                c.value = v
                s.notifyCharacteristicChanged(d, c, false)
            }

        @Suppress("DEPRECATION")
        private fun writeCompat(g: BluetoothGatt, c: BluetoothGattCharacteristic, v: ByteArray): Boolean =
            if (Build.VERSION.SDK_INT >= 33) {
                g.writeCharacteristic(c, v, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS
            } else {
                c.value = v
                c.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                g.writeCharacteristic(c)
            }

        @Suppress("DEPRECATION")
        private fun writeDescriptorCompat(g: BluetoothGatt, d: BluetoothGattDescriptor, v: ByteArray): Boolean =
            if (Build.VERSION.SDK_INT >= 33) {
                g.writeDescriptor(d, v) == BluetoothStatusCodes.SUCCESS
            } else {
                d.value = v
                g.writeDescriptor(d)
            }

        private fun compareUnsigned(a: ByteArray, b: ByteArray): Int {
            for (i in a.indices) {
                val d = (a[i].toInt() and 0xff) - (b[i].toInt() and 0xff)
                if (d != 0) return d
            }
            return 0
        }
    }
}
