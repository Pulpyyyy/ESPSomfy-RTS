// WResp.h pulls WebServer.h: with WEBSERVER_H defined first, ESPAsyncWebServer
// enables its compatibility guard instead of redeclaring the HTTP_* enums.
#include "WResp.h"
#include <ESPAsyncWebServer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#ifndef webasync_h
#define webasync_h

// With WebServer.h included first (HTTP_ANY defined), the async library keeps
// its method enum inside the AsyncWebRequestMethod namespace and the global
// HTTP_* names stay the sync HTTPMethod values. Since 3.10.2 the bit layout
// changed (DELETE=1, GET=2, ...) and raw integers are rejected, so name the
// library's own enumerators instead of hard-coding wire values.
#define ASYNC_HTTP_GET     AsyncWebRequestMethod::HTTP_GET
#define ASYNC_HTTP_POST    AsyncWebRequestMethod::HTTP_POST
#define ASYNC_HTTP_DELETE  AsyncWebRequestMethod::HTTP_DELETE
#define ASYNC_HTTP_PUT     AsyncWebRequestMethod::HTTP_PUT
#define ASYNC_HTTP_PATCH   AsyncWebRequestMethod::HTTP_PATCH
#define ASYNC_HTTP_HEAD    AsyncWebRequestMethod::HTTP_HEAD
#define ASYNC_HTTP_OPTIONS AsyncWebRequestMethod::HTTP_OPTIONS
#define ASYNC_HTTP_ANY     AsyncWebRequestMethod::HTTP_ALL

// JsonResponse twin for the async server. Inheriting JsonResponse keeps every
// existing toJSON(JsonResponse&) serializer usable untouched. It accumulates
// the whole body in a staging buffer and sends it in one AsyncBasicResponse
// (finish()): handing the full buffer to LWIP lets it burst the initial
// congestion window, where an AsyncResponseStream fed piecemeal stalls on the
// client's delayed ACKs (measured: controller 5.8KB was ~1150ms streamed, a
// few ms one-shot). A stream fallback kicks in only if the body outgrows the
// buffer (oversize configs), preserving unbounded correctness.
class JsonAsyncResponse : public JsonResponse {
  protected:
    void _safecat(const char *val, bool escape = false) override;
    size_t _len = 0;
  public:
    AsyncWebServerRequest *request = nullptr;
    AsyncResponseStream *overflow = nullptr; // created lazily only past buffSize
    void begin(AsyncWebServerRequest *request, char *buff, size_t buffSize);
    void finish(const char *contentType = "application/json");
    void discard(); // drop an unsent overflow stream (error/abort paths)
};

// The shared-state lock (SomfyGuard) lives in SomfyLock.h.
#include "SomfyLock.h"

// WebRequest bound to an async request. The shared handlers run in the
// async_tcp task under the SomfyGuard taken by the registration shim. First
// response wins: a later beginJson/endJson after an error send is discarded,
// and finish() closes the connection when a handler falls through silently
// (parity with the sync server's close-without-response paths).
class WebAsyncRequest : public WebRequest {
  protected:
    AsyncWebServerRequest *_request;
    JsonAsyncResponse _resp;
    bool _sent = false;
  public:
    WebAsyncRequest(AsyncWebServerRequest *request) : _request(request) {}
    ~WebAsyncRequest() { this->_resp.discard(); }
    HTTPMethod method() override;
    bool hasParam(const char *name) override;
    String param(const char *name) override;
    bool hasBody() override;
    const char *body() override;
    void send(int code, const char *contentType, const char *content) override;
    bool ensureAuth(bool cfg = false) override;
    bool sameOrigin() override;
    IPAddress remoteIP() override;
    JsonResponse &beginJson() override;
    void endJson() override;
    void finish();
};
class WebAsync {
  public:
    // The browser-facing server. Was 8082 while routes migrated phase by
    // phase next to the synchronous server; the cutover moved it to 80 and
    // retired the synchronous port-80 registrations (Web::begin).
    static constexpr uint16_t PORT = 80;
    // Set for the duration of an async OTA/filesystem flash. The sync upload
    // path runs in the loop task, so somfy.loop() simply never ran during a
    // flash; an async upload runs in the async_tcp task concurrently with
    // loop(), so loop() must skip its somfy/rfStats processing (the radio is
    // shut down for the flash anyway) to reproduce that quiescence.
    volatile bool otaInProgress = false;
    // millis() of the last received flash chunk. A browser that drops mid-OTA
    // never delivers the final chunk, so loop() calls abortStalledOta() to
    // release the gate instead of leaving somfy frozen until a reboot.
    volatile uint32_t otaActivity = 0;
    void abortStalledOta();
    void begin();
    // Async twins of the WebAuth checks: same policy, same responses. The
    // origin decision itself is Web::originAllowed - one source of truth.
    bool isAuthenticated(AsyncWebServerRequest *request, bool cfg = false);
    bool isSameOrigin(AsyncWebServerRequest *request);
    bool ensureAuth(AsyncWebServerRequest *request, bool cfg = false);
};
extern WebAsync webAsync;
#endif
