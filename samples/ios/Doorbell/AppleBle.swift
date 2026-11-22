import CoreBluetooth
import Foundation
import SubEthaCore

/// The platform half of the Bluetooth LE link (spec §11.3). The phone is both a peripheral
/// (CBPeripheralManager with the SubEtha service, advertising) and a central (CBCentralManager
/// scanning for that service). Each connection gets a SubEthaCore `BleLink`, which does the
/// chunking and the gossip; this class only moves chunks.
///
/// Everything, including the links and `node`, is used on `queue` only. Needs
/// NSBluetoothAlwaysUsageDescription. Works in the foreground (iOS limits background BLE).
final class AppleBle: NSObject {
    static let service = CBUUID(string: "53554245-5448-4100-8000-5EBE7A000000")
    static let inbox = CBUUID(string: "53554245-5448-4100-8000-5EBE7A000001")
    static let outbox = CBUUID(string: "53554245-5448-4100-8000-5EBE7A000002")
    static let summary = CBUUID(string: "53554245-5448-4100-8000-5EBE7A000003")
    static let version = CBUUID(string: "53554245-5448-4100-8000-5EBE7A000004")
    private static let maxCentralLinks = 4

    let queue: DispatchQueue
    private let node: EdgeGossipNode
    private let onMessage: (String) -> Void
    private let onStatus: (String, Int) -> Void

    private var peripheralManager: CBPeripheralManager!
    private var centralManager: CBCentralManager!
    private var outboxCharacteristic: CBMutableCharacteristic?
    private var running = false

    /// Peripheral side: centrals subscribed to our outbox.
    private var centrals: [UUID: (central: CBCentral, link: BleLink)] = [:]
    /// Notifications that didn't fit in CoreBluetooth's queue; resent when it drains.
    private var pendingNotifications: [(central: CBCentral, chunk: Data)] = []

    /// Central side: peripherals we connected to.
    private final class Peer {
        let peripheral: CBPeripheral
        var inbox: CBCharacteristic?
        var link: BleLink?
        init(_ peripheral: CBPeripheral) { self.peripheral = peripheral }
    }
    private var peripherals: [UUID: Peer] = [:]
    private var cooldown: [UUID: Date] = [:]

    var peerCount: Int { centrals.count + peripherals.values.filter { $0.link != nil }.count }

    /// `onMessage` gets new envelopes (JSON); `onStatus` a description and the peer count. Both
    /// are called on `queue`.
    init(node: EdgeGossipNode, queue: DispatchQueue, onMessage: @escaping (String) -> Void,
         onStatus: @escaping (String, Int) -> Void) {
        self.node = node
        self.queue = queue
        self.onMessage = onMessage
        self.onStatus = onStatus
        super.init()
    }

    /// Creates the managers (iOS asks for Bluetooth permission the first time). Advertising and
    /// scanning start once Bluetooth reports powered on.
    func start() {
        queue.async {
            guard !self.running else { return }
            self.running = true
            self.peripheralManager = CBPeripheralManager(delegate: self, queue: self.queue)
            self.centralManager = CBCentralManager(delegate: self, queue: self.queue)
        }
    }

    func stop() {
        queue.async {
            guard self.running else { return }
            self.running = false
            self.peripheralManager?.stopAdvertising()
            self.peripheralManager?.removeAllServices()
            self.centralManager?.stopScan()
            for p in self.peripherals.values { self.centralManager?.cancelPeripheralConnection(p.peripheral) }
            self.peripherals = [:]
            self.centrals = [:]
            self.pendingNotifications = []
            self.peripheralManager?.delegate = nil
            self.centralManager?.delegate = nil
            self.peripheralManager = nil
            self.centralManager = nil
            self.outboxCharacteristic = nil
            self.onStatus("Bluetooth off", 0)
        }
    }

    /// Tells every connected peer what we hold (after publishing or bridging something in).
    func resyncAll() {
        queue.async {
            self.centrals.values.forEach { $0.link.resync() }
            self.peripherals.values.forEach { $0.link?.resync() }
        }
    }

    private func status(_ text: String) { onStatus(text, peerCount) }

    private func nowSecs() -> UInt64 { UInt64(Date().timeIntervalSince1970) }
}

// MARK: - Peripheral: GATT server + advertising

extension AppleBle: CBPeripheralManagerDelegate {
    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        guard running, peripheral.state == .poweredOn, outboxCharacteristic == nil else {
            if peripheral.state == .unauthorized { status("Bluetooth permission denied (Settings → Doorbell)") }
            if peripheral.state == .poweredOff { status("Turn Bluetooth on") }
            return
        }
        let inbox = CBMutableCharacteristic(type: Self.inbox, properties: [.write, .writeWithoutResponse], value: nil, permissions: [.writeable])
        let outbox = CBMutableCharacteristic(type: Self.outbox, properties: [.notify, .indicate], value: nil, permissions: [.readable])
        let summary = CBMutableCharacteristic(type: Self.summary, properties: [.read], value: nil, permissions: [.readable])
        let version = CBMutableCharacteristic(type: Self.version, properties: [.read], value: Data([1]), permissions: [.readable])
        let service = CBMutableService(type: Self.service, primary: true)
        service.characteristics = [inbox, outbox, summary, version]
        outboxCharacteristic = outbox
        peripheral.add(service)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error { return status("Couldn't add the GATT service: \(error.localizedDescription)") }
        // iOS can't advertise service data, so Android peers can't skip the duplicate connection
        // (harmless: gossip dedupes).
        peripheral.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [Self.service]])
        status("Bluetooth on: advertising and scanning")
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        guard characteristic.uuid == Self.outbox, centrals[central.identifier] == nil else { return }
        let link = BleLink(node: node, write: { [weak self] in self?.notify(central, $0) }, onMessage: onMessage,
                           attMtu: central.maximumUpdateValueLength + 3)
        centrals[central.identifier] = (central, link)
        status("A central connected")
        link.resync()
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        guard characteristic.uuid == Self.outbox, centrals.removeValue(forKey: central.identifier) != nil else { return }
        pendingNotifications.removeAll { $0.central.identifier == central.identifier }
        status("A central disconnected")
    }

    private func notify(_ central: CBCentral, _ chunk: Data) {
        pendingNotifications.append((central, chunk))
        drainNotifications()
    }

    private func drainNotifications() {
        guard let outbox = outboxCharacteristic else { return }
        while let next = pendingNotifications.first {
            // false: CoreBluetooth's queue is full; peripheralManagerIsReady says when to retry.
            guard peripheralManager.updateValue(next.chunk, for: outbox, onSubscribedCentrals: [next.central]) else { return }
            pendingNotifications.removeFirst()
        }
    }

    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        drainNotifications()
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        guard requests.allSatisfy({ $0.characteristic.uuid == Self.inbox }) else {
            return peripheral.respond(to: requests[0], withResult: .writeNotPermitted)
        }
        peripheral.respond(to: requests[0], withResult: .success)
        // A long (prepared) write arrives as several requests with increasing offsets: join them.
        var byCentral: [UUID: (central: CBCentral, data: Data)] = [:]
        var order: [UUID] = []
        for r in requests {
            let id = r.central.identifier
            if byCentral[id] == nil { order.append(id) }
            if r.offset == 0, let previous = byCentral[id], !previous.data.isEmpty {
                deliver(previous.data, from: id)
                byCentral[id] = (r.central, r.value ?? Data())
            } else {
                byCentral[id, default: (r.central, Data())].data.append(r.value ?? Data())
            }
        }
        for id in order { if let d = byCentral[id]?.data, !d.isEmpty { deliver(d, from: id) } }
    }

    private func deliver(_ chunk: Data, from central: UUID) {
        // A central may write before subscribing; it gets our summary when it subscribes.
        centrals[central]?.link.receive(chunk)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        guard request.characteristic.uuid == Self.summary else {
            return peripheral.respond(to: request, withResult: .readNotPermitted)
        }
        let value = node.summary(nowSecs: nowSecs())
        guard request.offset <= value.count else { return peripheral.respond(to: request, withResult: .invalidOffset) }
        request.value = value.subdata(in: request.offset..<value.count)
        peripheral.respond(to: request, withResult: .success)
    }
}

// MARK: - Central: scan + connect

extension AppleBle: CBCentralManagerDelegate, CBPeripheralDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard running, central.state == .poweredOn else { return }
        central.scanForPeripherals(withServices: [Self.service], options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let id = peripheral.identifier
        guard running, peripherals[id] == nil, peripherals.count < Self.maxCentralLinks else { return }
        if let until = cooldown[id], until > Date() { return }
        peripherals[id] = Peer(peripheral)
        peripheral.delegate = self
        central.connect(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices([Self.service])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        drop(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        drop(peripheral)
    }

    private func drop(_ peripheral: CBPeripheral) {
        let had = peripherals.removeValue(forKey: peripheral.identifier)?.link != nil
        cooldown[peripheral.identifier] = Date().addingTimeInterval(15)
        if had { status("A peripheral disconnected") }
        // Scanning without duplicates reports each peripheral once; restart so it can be found again.
        if running, centralManager?.state == .poweredOn {
            centralManager.stopScan()
            centralManager.scanForPeripherals(withServices: [Self.service], options: nil)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = peripheral.services?.first(where: { $0.uuid == Self.service }) else {
            return centralManager.cancelPeripheralConnection(peripheral)
        }
        peripheral.discoverCharacteristics([Self.inbox, Self.outbox], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        let chars = service.characteristics ?? []
        guard let peer = peripherals[peripheral.identifier],
              let inbox = chars.first(where: { $0.uuid == Self.inbox }),
              let outbox = chars.first(where: { $0.uuid == Self.outbox }) else {
            return centralManager.cancelPeripheralConnection(peripheral)
        }
        peer.inbox = inbox
        peripheral.setNotifyValue(true, for: outbox)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic.uuid == Self.outbox, let peer = peripherals[peripheral.identifier] else { return }
        guard error == nil, characteristic.isNotifying, let inbox = peer.inbox else {
            return centralManager.cancelPeripheralConnection(peripheral)
        }
        guard peer.link == nil else { return }
        // CoreBluetooth queues writes with response, so chunks can be handed over all at once.
        // The without-response limit is ATT_MTU − 3 (the with-response one allows long writes).
        let link = BleLink(node: node, write: { [weak peripheral] in peripheral?.writeValue($0, for: inbox, type: .withResponse) },
                           onMessage: onMessage, attMtu: peripheral.maximumWriteValueLength(for: .withoutResponse) + 3)
        peer.link = link
        status("Connected to a peripheral")
        link.resync()
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic.uuid == Self.outbox, error == nil, let value = characteristic.value else { return }
        peripherals[peripheral.identifier]?.link?.receive(value)
    }
}
