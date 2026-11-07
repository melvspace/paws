package dev.paws.discovery

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.DatagramPacket
import java.net.InetAddress
import java.net.MulticastSocket
import java.net.SocketTimeoutException
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject

class PawsDiscoveryModule : Module() {
    private val executor = Executors.newSingleThreadExecutor()
    private val generation = AtomicInteger()
    private val current = AtomicReference<MulticastSocket?>(null)

    override fun definition() = ModuleDefinition {
        Name("PawsDiscovery")

        AsyncFunction("discover") { promise: Promise ->
            val scan = generation.incrementAndGet()
            executor.execute {
                if (scan != generation.get()) {
                    promise.resolve(emptyList<Map<String, String>>())

                    return@execute
                }

                val socket = try {
                    MulticastSocket(0)
                } catch (error: Exception) {
                    promise.reject(
                        "ERR_DISCOVERY",
                        "Could not search the local network. Check Wi-Fi or scan a QR code.",
                        error,
                    )

                    return@execute
                }
                current.getAndSet(socket)?.close()

                if (scan != generation.get()) socket.close()

                try {
                    socket.timeToLive = 1
                    socket.soTimeout = 300
                    val query = "paws-environment-query-v1".toByteArray(Charsets.UTF_8)
                    socket.send(DatagramPacket(
                        query,
                        query.size,
                        InetAddress.getByName("239.255.43.10"),
                        4313,
                    ))
                    val deadline = System.nanoTime() + 1_800_000_000L
                    val peers = linkedMapOf<String, Map<String, String>>()

                    while (!socket.isClosed && System.nanoTime() < deadline && peers.size < 256) {
                        val packet = DatagramPacket(ByteArray(2049), 2049)

                        try {
                            socket.receive(packet)

                            if (packet.length > 2048) continue

                            val data = JSONObject(String(
                                packet.data,
                                0,
                                packet.length,
                                Charsets.UTF_8,
                            ))

                            if (data.optString("protocol") != "paws-environment-v1") continue

                            val port = data.getInt("port")
                            val identity = data.getJSONObject("identity")
                            val id = identity.getString("id")

                            if (port !in 1..65535 || id.length !in 1..128) continue

                            peers[id] = mapOf(
                                "id" to id,
                                "name" to identity.getString("name"),
                                "platform" to identity.getString("platform"),
                                "url" to "http://${packet.address.hostAddress}:$port",
                                "source" to "lan",
                            )
                        } catch (_: SocketTimeoutException) {
                            // Keep collecting unicast replies within the bounded scan.
                        } catch (_: org.json.JSONException) {
                            // Unrelated UDP packets are not Paws advertisements.
                        }
                    }

                    promise.resolve(peers.values.toList())
                } catch (error: Exception) {
                    if (socket.isClosed) {
                        promise.resolve(emptyList<Map<String, String>>())
                    } else {
                        promise.reject(
                        "ERR_DISCOVERY",
                        "Could not search the local network. Check Wi-Fi or scan a QR code.",
                        error,
                    )
                    }
                } finally {
                    current.compareAndSet(socket, null)
                    socket.close()
                }
            }
        }

        Function("cancel") {
            generation.incrementAndGet()
            current.getAndSet(null)?.close()
        }

        OnDestroy {
            generation.incrementAndGet()
            current.getAndSet(null)?.close()
            executor.shutdownNow()
        }
    }
}
