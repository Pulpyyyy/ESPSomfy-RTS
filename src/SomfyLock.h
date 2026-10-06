#ifndef somfylock_h
#define somfylock_h
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

// The async HTTP handlers run in the async_tcp task (core 0) while loop() runs
// on core 1. Every touch of shared state -- somfy, rfStats, settings and NVS,
// config files, the radio, the MQTT client, the socket server -- must hold
// this lock: the async handlers take it in their registration shim, loop()
// takes it around each of its consumers (somfy, network/MQTT/sockets, the HA
// API server), and the shared helpers (commit, socket pump, update emits) take
// it themselves so every caller is covered. Recursive, so helpers may nest.
// Keep the critical sections short: long work (OTA writes, GitHub TLS,
// frequency scans) stays on the flag->loop patterns or hands the lock back.
extern SemaphoreHandle_t g_somfyLock;
inline void somfyLockInit() { if(!g_somfyLock) g_somfyLock = xSemaphoreCreateRecursiveMutex(); }
class SomfyGuard {
  public:
    SomfyGuard() { xSemaphoreTakeRecursive(g_somfyLock, portMAX_DELAY); }
    ~SomfyGuard() { xSemaphoreGiveRecursive(g_somfyLock); }
};
// Hands the lock back for the duration of a blocking call made under a guard
// (a network handshake) and takes it again afterwards. Only the holder can give
// it back; when the give fails nothing is retaken, so the count stays balanced.
// Whatever the blocking call works on must be fenced off by its own flag.
class SomfyUnlock {
  private:
    bool _released;
  public:
    SomfyUnlock() : _released(xSemaphoreGiveRecursive(g_somfyLock) == pdTRUE) {}
    ~SomfyUnlock() { if(_released) xSemaphoreTakeRecursive(g_somfyLock, portMAX_DELAY); }
};
#endif
