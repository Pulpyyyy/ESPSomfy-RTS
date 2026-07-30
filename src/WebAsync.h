// WResp.h pulls WebServer.h: with WEBSERVER_H defined first, ESPAsyncWebServer
// enables its compatibility guard instead of redeclaring the HTTP_* enums.
#include "WResp.h"
#include <ESPAsyncWebServer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#ifndef webasync_h
#define webasync_h

// JsonResponse twin bound to an async response stream. Inheriting JsonResponse
// keeps every existing toJSON(JsonResponse&) serializer usable untouched; only
// the flush target changes.
class JsonAsyncResponse : public JsonResponse {
  protected:
    void _safecat(const char *val, bool escape = false) override;
  public:
    AsyncResponseStream *stream = nullptr;
    void beginResponse(AsyncResponseStream *stream, char *buff, size_t buffSize);
    void endResponse();
};

// Async handlers run in the async_tcp task, concurrently with loop(). Every
// touch of shared state (somfy, rfStats, settings, config files) must hold
// this lock; loop() holds it around its somfy/rfStats processing. Recursive,
// so helpers may nest. Keep the critical sections short: long work (OTA
// writes, GitHub TLS, frequency scans) stays on the flag->loop patterns.
extern SemaphoreHandle_t g_somfyLock;
class SomfyGuard {
  public:
    SomfyGuard() { xSemaphoreTakeRecursive(g_somfyLock, portMAX_DELAY); }
    ~SomfyGuard() { xSemaphoreGiveRecursive(g_somfyLock); }
};

class WebAsync {
  public:
    // Development port: the synchronous server keeps port 80 fully functional
    // while routes migrate one phase at a time. The cutover commit moves this
    // to 80 and retires the synchronous registrations.
    static constexpr uint16_t PORT = 8082;
    void begin();
    // Async twins of the WebAuth checks: same policy, same responses. The
    // origin decision itself is Web::originAllowed - one source of truth.
    bool isAuthenticated(AsyncWebServerRequest *request, bool cfg = false);
    bool isSameOrigin(AsyncWebServerRequest *request);
    bool ensureAuth(AsyncWebServerRequest *request, bool cfg = false);
};
extern WebAsync webAsync;
#endif
