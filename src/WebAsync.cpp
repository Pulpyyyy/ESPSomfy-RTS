#include <Arduino.h>
#include <LittleFS.h>
// Web.h (hence WebServer.h) must come before the async headers: with
// WEBSERVER_H already defined, ESPAsyncWebServer enables its compatibility
// guard instead of redeclaring the HTTP_* method enum.
#include "Web.h"
#include "GitOTA.h"
#include "ConfigSettings.h"
#include "Somfy.h"
#include "WebAsync.h"

extern ConfigSettings settings;
extern SomfyShadeController somfy;
extern Web webServer;

// The sync server fills g_content from the loop task without taking the lock,
// so the async transport gets its own buffer for the dual-serving phase. The
// async_tcp task runs handlers one at a time: one buffer is enough.
static char g_asyncContent[WEB_MAX_RESPONSE];

void JsonAsyncResponse::beginResponse(AsyncResponseStream *stream, char *buff, size_t buffSize) {
  this->stream = stream;
  this->buff = buff;
  this->buffSize = buffSize;
  this->buff[0] = '\0';
  this->_objects = 0;
  this->_arrays = 0;
  this->_nocomma = true;
}
void JsonAsyncResponse::_safecat(const char *val, bool escape) {
  // Same buffering as JsonResponse::_safecat; only the flush target differs.
  size_t vlen = (escape ? this->calcEscapedLength(val) : strlen(val)) + (escape ? 2 : 0);
  if(vlen + strlen(this->buff) >= this->buffSize) {
    this->stream->print(this->buff);
    this->buff[0] = '\0';
    if(vlen >= this->buffSize) {
      Serial.printf("JSON value exceeds response buffer %d - %d\n", this->buffSize, vlen);
      return;
    }
  }
  char *p = this->buff + strlen(this->buff);
  if(escape) {
    *p++ = '"';
    p += this->escapeString(val, p);
    *p++ = '"';
    *p = '\0';
  }
  else strcpy(p, val);
}
void JsonAsyncResponse::endResponse() {
  if(this->buff[0] != '\0') {
    this->stream->print(this->buff);
    this->buff[0] = '\0';
  }
}

bool WebAsync::isAuthenticated(AsyncWebServerRequest *request, bool cfg) {
  if(settings.Security.type == security_types::None) return true;
  else if(!cfg && (settings.Security.permissions & static_cast<uint8_t>(security_permissions::ConfigOnly)) == 0x01) return true;
  else if(request->hasHeader(F("apikey"))) {
    char token[65];
    memset(token, 0x00, sizeof(token));
    webServer.createAPIToken(request->client()->remoteIP(), token);
    if(!Web::secureEquals(token, request->header(F("apikey")).c_str())) return false;
    return true;
  }
  return false;
}
bool WebAsync::isSameOrigin(AsyncWebServerRequest *request) {
  return webServer.originAllowed(request->host(), request->header(F("Origin")), request->header(F("Referer")));
}
bool WebAsync::ensureAuth(AsyncWebServerRequest *request, bool cfg) {
  // Same order as the sync twin: same-origin first so the anti-rebinding check
  // also covers Security::None devices.
  if(!this->isSameOrigin(request)) {
    request->send(403, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Cross-origin or forbidden host\"}"));
    return false;
  }
  if(this->isAuthenticated(request, cfg)) return true;
  request->send(401, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Not authenticated\"}"));
  return false;
}

// Phase 1 of the async migration: the shared-state lock and the static
// assets, served in parallel from the async_tcp task. API routes follow in
// later phases; until the cutover the synchronous server owns port 80.

extern Web webServer;
extern GitUpdater git;

SemaphoreHandle_t g_somfyLock = nullptr;
WebAsync webAsync;
static AsyncWebServer asyncServer(WebAsync::PORT);

// Same CSP as the synchronous streamer: the page uses inline scripts and
// styles, the live WebSocket runs on :8080, release notes come from GitHub.
static const char _csp[] PROGMEM =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; "
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
  "connect-src 'self' https://api.github.com ws://*:8080 wss://*:8080; "
  "object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

static void serveIndex(AsyncWebServerRequest *request) {
  webServer.lastActivity = millis();
  if(git.lockFS) {
    request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Filesystem update in progress\"}"));
    return;
  }
  // send(fs, path) picks up index.html.gz and sets Content-Encoding itself.
  AsyncWebServerResponse *response = request->beginResponse(LittleFS, "/index.html", "text/html");
  if(!response) { request->send(500, "text/plain", "Error opening file"); return; }
  response->addHeader(F("Content-Security-Policy"), FPSTR(_csp));
  response->addHeader(F("X-Content-Type-Options"), F("nosniff"));
  request->send(response);
}

void WebAsync::begin() {
  if(!g_somfyLock) g_somfyLock = xSemaphoreCreateRecursiveMutex();
  asyncServer.on("/", HTTP_GET, serveIndex);
  asyncServer.on("/index.html", HTTP_GET, serveIndex);
  // Every other asset straight from LittleFS: the handler only claims paths
  // that exist as files (or file.gz), so future API routes are unaffected.
  asyncServer.serveStatic("/", LittleFS, "/")
    .setCacheControl("public, max-age=604800, immutable")
    .setFilter([](AsyncWebServerRequest *request) {
      webServer.lastActivity = millis();
      return !git.lockFS;
    });
  // ---- Phase 2 pilot GET routes: shared emitters, per-transport shells. ----
  asyncServer.on("/loginContext", HTTP_GET, [](AsyncWebServerRequest *request) {
    // Deliberately unauthenticated, like the sync twin: it feeds the login page.
    webServer.lastActivity = millis();
    AsyncResponseStream *stream = request->beginResponseStream("application/json");
    JsonAsyncResponse resp;
    {
      SomfyGuard guard;
      resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
      webServer.emitLoginContext(resp);
      resp.endResponse();
    }
    request->send(stream);
  });
  asyncServer.on("/rfStats", HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    if(!webAsync.ensureAuth(request, true)) return;
    AsyncResponseStream *stream = request->beginResponseStream("application/json");
    JsonAsyncResponse resp;
    {
      SomfyGuard guard;
      resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
      webServer.emitRfStats(resp);
      resp.endResponse();
    }
    request->send(stream);
  });
  asyncServer.on("/shades", HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    if(!webAsync.ensureAuth(request, false)) return;
    AsyncResponseStream *stream = request->beginResponseStream("application/json");
    JsonAsyncResponse resp;
    {
      SomfyGuard guard;
      resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
      resp.beginArray();
      somfy.toJSONShades(resp, webAsync.isAuthenticated(request, true));
      resp.endArray();
      resp.endResponse();
    }
    request->send(stream);
  });
  asyncServer.onNotFound([](AsyncWebServerRequest *request) {
    request->send(404, "text/plain", "Not found");
  });
  asyncServer.begin();
  Serial.printf("Async web server started on port %u\n", PORT);
}
