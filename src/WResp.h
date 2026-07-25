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
