#include <WebServer.h>
#include <WebSocketsServer.h>
#ifndef wresp_h
#define wresp_h
// The pure serialisation layer lives in JsonFormatter.h so it can be unit
// tested on the host; only the transport bindings below need Arduino.
#include "JsonFormatter.h"
class JsonResponse : public JsonFormatter {
  protected:
    void _safecat(const char *val, bool escape = false) override;
  public:
    WebServer *server;
    void beginResponse(WebServer *server, char *buff, size_t buffSize);
    void endResponse();
    void send();
};
// Transport-neutral request facade: one handler body serves both the sync
// WebServer and the async server (implementations: WebSyncRequest in Web.h,
// WebAsyncRequest in WebAsync.h). Rules: beginJson()/endJson() bracket a
// streamed JSON body; send() is for fixed responses; the first response wins
// on both transports, later ones are ignored at the HTTP level.
class WebRequest {
  public:
    virtual ~WebRequest() {}
    virtual HTTPMethod method() = 0;
    virtual bool hasParam(const char *name) = 0;
    virtual String param(const char *name) = 0;
    // The raw request body (the sync server's arg("plain")); body() never
    // returns nullptr so it can feed deserializeJson directly.
    virtual bool hasBody() = 0;
    virtual const char *body() = 0;
    virtual void send(int code, const char *contentType, const char *content) = 0;
    virtual bool ensureAuth(bool cfg = false) = 0;
    virtual JsonResponse &beginJson() = 0;
    virtual void endJson() = 0;
};
class JsonSockEvent : public JsonFormatter {
  protected:
    bool _closed = false;
    void _safecat(const char *val, bool escape = false) override;
  public:
    WebSocketsServer *server = nullptr;
    void beginEvent(WebSocketsServer *server, const char *evt, char *buff, size_t buffSize);
    void endEvent(uint8_t clientNum = 255);
    void closeEvent();
};
#endif
