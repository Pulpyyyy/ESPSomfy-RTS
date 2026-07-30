#include <Arduino.h>
#include <LittleFS.h>
#include <Update.h>
#include <esp_task_wdt.h>
// Web.h (hence WebServer.h) must come before the async headers: with
// WEBSERVER_H already defined, ESPAsyncWebServer enables its compatibility
// guard instead of redeclaring the HTTP_* method enum.
#include "Web.h"
#include "GitOTA.h"
#include "ConfigSettings.h"
#include "Utils.h"
#include "Somfy.h"
#include "MQTT.h"
#include "Rollback.h"
#include "SSDP.h"
#include "ConfigFile.h"
#include "Network.h"
#include "WebAsync.h"

extern ConfigSettings settings;
extern SomfyShadeController somfy;
extern Web webServer;
extern MQTTClass mqtt;
extern SSDPClass SSDP;
extern rebootDelay_t rebootDelay;
extern Network net;

// Async upload gate, mirroring the sync WebRoutesSystem statics: the async_tcp
// task runs one upload at a time, so a single flag pair is enough. Set at the
// first chunk (index 0) after the auth check; every later chunk is a no-op
// when it is false.
static bool g_asyncUploadAuth = false;
static size_t g_asyncUploadBytes = 0;
#define ASYNC_RESTORE_MAX_UPLOAD (128 * 1024)
#define ASYNC_SHADECFG_MAX_UPLOAD (64 * 1024)

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

// Accumulates a JSON request body into request->_tempObject (freed by the
// request destructor), mirroring the sync server's arg("plain"). Bodies over
// the cap are dropped: the largest legitimate payload is the /restoreRfStats
// export (~8KB), everything else stays under 1KB.
static void asyncBufferBody(AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
  // The sync server never exposes a body on GET; mirror that so a degenerate
  // GET-with-body behaves identically on both transports.
  if(request->method() == ASYNC_HTTP_GET) return;
  if(total == 0 || total > 16384) return;
  if(index == 0 && request->_tempObject == nullptr) request->_tempObject = malloc(total + 1);
  if(request->_tempObject != nullptr) {
    memcpy((uint8_t *)request->_tempObject + index, data, len);
    if(index + len == total) ((char *)request->_tempObject)[total] = '\0';
  }
}
static const char *asyncBody(AsyncWebServerRequest *request) {
  return (const char *)request->_tempObject;
}
// Same responses as Web::handleDeserializationError, for the async transport.
static void asyncDeserializationError(AsyncWebServerRequest *request, DeserializationError &err) {
  switch (err.code()) {
    case DeserializationError::InvalidInput:
      request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Invalid JSON payload\"}"));
      break;
    case DeserializationError::NoMemory:
      request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Out of memory parsing JSON\"}"));
      break;
    default:
      request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"General JSON Deserialization failed\"}"));
      break;
  }
}

// ---- WebRequest bound to an async request. --------------------------------
HTTPMethod WebAsyncRequest::method() {
  switch(this->_request->method()) {
    case ASYNC_HTTP_GET: return HTTP_GET;
    case ASYNC_HTTP_POST: return HTTP_POST;
    case ASYNC_HTTP_PUT: return HTTP_PUT;
    case ASYNC_HTTP_DELETE: return HTTP_DELETE;
    case ASYNC_HTTP_PATCH: return HTTP_PATCH;
    case ASYNC_HTTP_HEAD: return HTTP_HEAD;
    case ASYNC_HTTP_OPTIONS: return HTTP_OPTIONS;
    default: return HTTP_ANY;
  }
}
bool WebAsyncRequest::hasParam(const char *name) { return this->_request->hasParam(name); }
String WebAsyncRequest::param(const char *name) {
  const AsyncWebParameter *p = this->_request->getParam(name);
  return p ? p->value() : String();
}
bool WebAsyncRequest::hasBody() { return this->_request->_tempObject != nullptr; }
const char *WebAsyncRequest::body() {
  // Never nullptr: an absent body must behave like the sync server's empty
  // arg("plain") when fed to deserializeJson.
  return this->_request->_tempObject ? (const char *)this->_request->_tempObject : "";
}
void WebAsyncRequest::send(int code, const char *contentType, const char *content) {
  if(this->_sent) return;
  if(this->_stream) { delete this->_stream; this->_stream = nullptr; }
  this->_sent = true;
  this->_request->send(code, contentType, content);
}
bool WebAsyncRequest::ensureAuth(bool cfg) {
  bool ok = webAsync.ensureAuth(this->_request, cfg);
  if(!ok) this->_sent = true;  // ensureAuth answered 403/401 itself
  return ok;
}
IPAddress WebAsyncRequest::remoteIP() { return this->_request->client()->remoteIP(); }
JsonResponse &WebAsyncRequest::beginJson() {
  if(!this->_stream) this->_stream = this->_request->beginResponseStream("application/json");
  this->_resp.beginResponse(this->_stream, g_asyncContent, sizeof(g_asyncContent));
  return this->_resp;
}
void WebAsyncRequest::endJson() {
  if(!this->_stream) return;
  this->_resp.endResponse();
  if(this->_sent) { delete this->_stream; }  // an error already went out first
  else { this->_sent = true; this->_request->send(this->_stream); }
  this->_stream = nullptr;
}
void WebAsyncRequest::finish() {
  if(this->_sent) return;
  if(this->_stream) { delete this->_stream; this->_stream = nullptr; }
  // The sync server closes without a response on these paths; do the same
  // rather than leaving the request open until the client gives up.
  this->_request->client()->close();
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

// Captures SSDP.schema()'s raw-HTTP output into a String so the XML body can
// be split from its embedded header block.
class SchemaCapture : public Print {
  public:
    String out;
    size_t write(uint8_t c) override { this->out += (char)c; return 1; }
    size_t write(const uint8_t *buf, size_t len) override {
      for(size_t i = 0; i < len; i++) this->out += (char)buf[i];
      return len;
    }
};
// Shared firmware/filesystem flash chunk handler. isApp selects the SPIFFS
// (LittleFS) partition and its commit()/no-rollback behavior; otherwise the
// application partition with an OTA-rollback pending marker. Mirrors the sync
// updateFirmware/updateApplication upload lambdas.
static void asyncOtaUpload(AsyncWebServerRequest *request, size_t index, uint8_t *data, size_t len, bool final, bool isApp) {
  if(index == 0) {
    webServer.uploadSuccess = false;
    g_asyncUploadAuth = webAsync.isSameOrigin(request) && webAsync.isAuthenticated(request, true);
    if(g_asyncUploadAuth) {
      SomfyGuard guard;
      if(!Update.begin(UPDATE_SIZE_UNKNOWN, isApp ? U_SPIFFS : U_FLASH)) Update.printError(Serial);
      else {
        somfy.transceiver.end(); // no radio interrupts during the flash
        mqtt.end();
        webAsync.otaInProgress = true; // loop() stops touching somfy until we finish
      }
    }
  }
  if(!g_asyncUploadAuth) { esp_task_wdt_reset(); return; }
  webAsync.otaActivity = millis();
  if(len) {
    if(Update.write(data, len) != len) { Update.printError(Serial); Update.abort(); }
  }
  if(final) {
    if(Update.end(true)) {
      webServer.uploadSuccess = true;
      if(!isApp) OTARollback::markPending(); // application partition flashed
    }
    else Update.printError(Serial);
    if(isApp) { SomfyGuard guard; somfy.commit(); }
    webAsync.otaInProgress = false;
  }
  esp_task_wdt_reset();
}
// Shade-config upload -> /shades.tmp, then loaded/validated. Mirrors the sync
// updateShadeConfig upload lambda.
static void asyncShadeConfigUpload(AsyncWebServerRequest *request, size_t index, uint8_t *data, size_t len, bool final) {
  if(index == 0) {
    g_asyncUploadAuth = webAsync.isSameOrigin(request) && webAsync.isAuthenticated(request, true);
    g_asyncUploadBytes = 0;
    if(g_asyncUploadAuth) {
      SomfyGuard guard;
      File fup = LittleFS.open("/shades.tmp", "w");
      fup.close();
    }
  }
  if(!g_asyncUploadAuth) return;
  SomfyGuard guard;
  if(len) {
    // The header of a shade config: three space-padded digits then ','.
    if(g_asyncUploadBytes == 0 && len > 0) {
      bool looksValid = len >= 4 && data[3] == ',';
      for(uint8_t i = 0; looksValid && i < 3; i++) {
        char c = (char)data[i];
        if(c != ' ' && (c < '0' || c > '9')) looksValid = false;
      }
      if(!looksValid) {
        g_asyncUploadAuth = false;
        Serial.println("Update aborted: not a shade configuration file");
        LittleFS.remove("/shades.tmp");
        return;
      }
    }
    g_asyncUploadBytes += len;
    if(g_asyncUploadBytes > ASYNC_SHADECFG_MAX_UPLOAD) {
      g_asyncUploadAuth = false;
      LittleFS.remove("/shades.tmp");
      return;
    }
    File fup = LittleFS.open("/shades.tmp", "a");
    if(!fup) { g_asyncUploadAuth = false; return; }
    if(fup.write(data, len) != len) g_asyncUploadAuth = false;
    fup.close();
  }
  if(final) {
    if(g_asyncUploadBytes == 0) { LittleFS.remove("/shades.tmp"); return; }
    // loadShadesFile() validates before touching the live arrays.
    if(!somfy.loadShadesFile("/shades.tmp"))
      Serial.println("Shade configuration upload rejected as invalid");
  }
}
// Backup-restore upload -> /shades.tmp, applied in the completion handler.
// Mirrors the sync /restore upload lambda.
static void asyncRestoreUpload(AsyncWebServerRequest *request, size_t index, uint8_t *data, size_t len, bool final) {
  esp_task_wdt_reset();
  if(index == 0) {
    webServer.uploadSuccess = false;
    g_asyncUploadAuth = webAsync.isSameOrigin(request) && webAsync.isAuthenticated(request, true);
    g_asyncUploadBytes = 0;
    if(g_asyncUploadAuth) {
      SomfyGuard guard;
      File fup = LittleFS.open("/shades.tmp", "w");
      fup.close();
    }
  }
  if(!g_asyncUploadAuth) return;
  SomfyGuard guard;
  if(len) {
    g_asyncUploadBytes += len;
    if(g_asyncUploadBytes > ASYNC_RESTORE_MAX_UPLOAD) {
      webServer.uploadSuccess = false;
      g_asyncUploadAuth = false;
      return;
    }
    File fup = LittleFS.open("/shades.tmp", "a");
    if(fup) { fup.write(data, len); fup.close(); }
  }
  if(final) webServer.uploadSuccess = true;
}
void WebAsync::abortStalledOta() {
  if(!this->otaInProgress) return;
  if((int32_t)(millis() - this->otaActivity) < 15000) return;
  // A flash that has not advanced for 15s is abandoned: drop it and let somfy
  // resume. The radio stays down until the next reboot (as on an aborted sync
  // flash); the device stays reachable so the user can retry.
  Update.abort();
  this->otaInProgress = false;
  Serial.println("Async OTA stalled - aborted, releasing somfy");
}
void WebAsync::begin() {
  if(!g_somfyLock) g_somfyLock = xSemaphoreCreateRecursiveMutex();
  asyncServer.on("/", ASYNC_HTTP_GET, serveIndex);
  asyncServer.on("/index.html", ASYNC_HTTP_GET, serveIndex);
  // Every other asset straight from LittleFS: the handler only claims paths
  // that exist as files (or file.gz), so future API routes are unaffected.
  asyncServer.serveStatic("/", LittleFS, "/")
    .setCacheControl("public, max-age=604800, immutable")
    .setFilter([](AsyncWebServerRequest *request) {
      webServer.lastActivity = millis();
      return !git.lockFS;
    });
  // ---- Phase 2 pilot GET routes: shared emitters, per-transport shells. ----
  asyncServer.on("/loginContext", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
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
  asyncServer.on("/rfStats", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
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
  asyncServer.on("/shades", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
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
  // Settings family: same auth gates as the sync twins.
  asyncServer.on("/modulesettings", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
    // Public on the sync server too: general module info without secrets.
    webServer.lastActivity = millis();
    AsyncResponseStream *stream = request->beginResponseStream("application/json");
    JsonAsyncResponse resp;
    {
      SomfyGuard guard;
      resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
      webServer.emitModuleSettings(resp);
      resp.endResponse();
    }
    request->send(stream);
  });
  asyncServer.on("/networksettings", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    // The response contains the WiFi passphrase.
    if(!webAsync.ensureAuth(request, true)) return;
    AsyncResponseStream *stream = request->beginResponseStream("application/json");
    JsonAsyncResponse resp;
    {
      SomfyGuard guard;
      resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
      webServer.emitNetworkSettings(resp);
      resp.endResponse();
    }
    request->send(stream);
  });
  asyncServer.on("/mqttsettings", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    // The response contains the MQTT password.
    if(!webAsync.ensureAuth(request, true)) return;
    AsyncResponseStream *stream = request->beginResponseStream("application/json");
    JsonAsyncResponse resp;
    {
      SomfyGuard guard;
      resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
      webServer.emitMqttSettings(resp);
      resp.endResponse();
    }
    request->send(stream);
  });
  asyncServer.on("/getRadio", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    if(!webAsync.ensureAuth(request, true)) return;
    AsyncResponseStream *stream = request->beginResponseStream("application/json");
    JsonAsyncResponse resp;
    {
      SomfyGuard guard;
      resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
      webServer.emitRadio(resp);
      resp.endResponse();
    }
    request->send(stream);
  });
  asyncServer.on("/getSecurity", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    // The response contains the password and pin in clear text.
    if(!webAsync.ensureAuth(request, true)) return;
    {
      SomfyGuard guard;
      webServer.buildSecurityJson(g_asyncContent, sizeof(g_asyncContent));
    }
    request->send(200, "application/json", g_asyncContent);
  });
  // Shades world: same gates and same secret-masking flags as the sync twins.
  asyncServer.on("/controller", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    if(!webAsync.ensureAuth(request, false)) return;
    bool secrets = webAsync.isAuthenticated(request, true);
    AsyncResponseStream *stream = request->beginResponseStream("application/json");
    JsonAsyncResponse resp;
    {
      SomfyGuard guard;
      resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
      webServer.emitController(resp, secrets);
      resp.endResponse();
    }
    request->send(stream);
  });
  asyncServer.on("/rooms", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    if(!webAsync.ensureAuth(request, false)) return;
    AsyncResponseStream *stream = request->beginResponseStream("application/json");
    JsonAsyncResponse resp;
    {
      SomfyGuard guard;
      resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
      resp.beginArray();
      somfy.toJSONRooms(resp);
      resp.endArray();
      resp.endResponse();
    }
    request->send(stream);
  });
  asyncServer.on("/groups", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    if(!webAsync.ensureAuth(request, false)) return;
    bool secrets = webAsync.isAuthenticated(request, true);
    AsyncResponseStream *stream = request->beginResponseStream("application/json");
    JsonAsyncResponse resp;
    {
      SomfyGuard guard;
      resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
      resp.beginArray();
      somfy.toJSONGroups(resp, secrets);
      resp.endArray();
      resp.endResponse();
    }
    request->send(stream);
  });
  // The single-entity reads and the id allocators are unauthenticated on the
  // sync server (secrets are masked by the flag): strict parity here.
  asyncServer.on("/shade", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    if(!request->hasParam("shadeId")) {
      request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"You must supply a valid shade id.\"}"));
      return;
    }
    bool secrets = webAsync.isAuthenticated(request, true);
    int shadeId = atoi(request->getParam("shadeId")->value().c_str());
    AsyncResponseStream *stream = nullptr;
    {
      SomfyGuard guard;
      SomfyShade *shade = somfy.getShadeById(shadeId);
      if(shade) {
        stream = request->beginResponseStream("application/json");
        JsonAsyncResponse resp;
        resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
        resp.beginObject();
        shade->toJSON(resp, secrets);
        resp.endObject();
        resp.endResponse();
      }
    }
    if(stream) request->send(stream);
    else request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Shade Id not found.\"}"));
  });
  asyncServer.on("/group", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    if(!request->hasParam("groupId")) {
      request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"You must supply a valid shade id.\"}"));
      return;
    }
    bool secrets = webAsync.isAuthenticated(request, true);
    int groupId = atoi(request->getParam("groupId")->value().c_str());
    AsyncResponseStream *stream = nullptr;
    {
      SomfyGuard guard;
      SomfyGroup *group = somfy.getGroupById(groupId);
      if(group) {
        stream = request->beginResponseStream("application/json");
        JsonAsyncResponse resp;
        resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
        resp.beginObject();
        group->toJSON(resp, secrets);
        resp.endObject();
        resp.endResponse();
      }
    }
    if(stream) request->send(stream);
    else request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Group Id not found.\"}"));
  });
  asyncServer.on("/room", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    if(!request->hasParam("roomId")) {
      request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"You must supply a valid room id.\"}"));
      return;
    }
    int roomId = atoi(request->getParam("roomId")->value().c_str());
    AsyncResponseStream *stream = nullptr;
    {
      SomfyGuard guard;
      SomfyRoom *room = somfy.getRoomById(roomId);
      if(room) {
        stream = request->beginResponseStream("application/json");
        JsonAsyncResponse resp;
        resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
        resp.beginObject();
        room->toJSON(resp);
        resp.endObject();
        resp.endResponse();
      }
    }
    if(stream) request->send(stream);
    else request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Room Id not found.\"}"));
  });
  asyncServer.on("/getNextShade", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    AsyncResponseStream *stream = request->beginResponseStream("application/json");
    JsonAsyncResponse resp;
    {
      SomfyGuard guard;
      uint8_t shadeId = somfy.getNextShadeId();
      resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
      resp.beginObject();
      resp.addElem("shadeId", shadeId);
      resp.addElem("remoteAddress", (uint32_t)somfy.getNextRemoteAddress(shadeId));
      resp.addElem("bitLength", somfy.transceiver.config.type);
      resp.addElem("stepSize", (uint8_t)100);
      resp.addElem("proto", static_cast<uint8_t>(somfy.transceiver.config.proto));
      resp.endObject();
      resp.endResponse();
    }
    request->send(stream);
  });
  asyncServer.on("/getNextGroup", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    AsyncResponseStream *stream = request->beginResponseStream("application/json");
    JsonAsyncResponse resp;
    {
      SomfyGuard guard;
      uint8_t groupId = somfy.getNextGroupId();
      resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
      resp.beginObject();
      resp.addElem("groupId", groupId);
      resp.addElem("remoteAddress", (uint32_t)somfy.getNextRemoteAddress(groupId));
      resp.addElem("bitLength", somfy.transceiver.config.type);
      resp.addElem("proto", static_cast<uint8_t>(somfy.transceiver.config.proto));
      resp.endObject();
      resp.endResponse();
    }
    request->send(stream);
  });
  asyncServer.on("/getNextRoom", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    AsyncResponseStream *stream = request->beginResponseStream("application/json");
    JsonAsyncResponse resp;
    {
      SomfyGuard guard;
      resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
      resp.beginObject();
      resp.addElem("roomId", somfy.getNextRoomId());
      resp.endObject();
      resp.endResponse();
    }
    request->send(stream);
  });
  asyncServer.on("/lang", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    const char *file = settings.language == 1 ? "/locale/fr.json"
      : settings.language == 2 ? "/locale/de.json"
      : settings.language == 3 ? "/locale/es.json" : "/locale/en.json";
    // send(fs, path) picks up the .gz variant and sets Content-Encoding itself.
    AsyncWebServerResponse *response = request->beginResponse(LittleFS, file, "application/json");
    if(!response) request->send(404, "text/plain", "Lang file not found");
    else request->send(response);
  });
  // ---- Phase 3: shade/group commands (the HA-critical mutations). ---------
  asyncServer.on("/shadeCommand", ASYNC_HTTP_GET | ASYNC_HTTP_PUT | ASYNC_HTTP_POST, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    if(!webAsync.ensureAuth(request, false)) return;
    somfy_cmd_req_t cmd;
    if(request->hasParam("shadeId")) {
      cmd.shadeId = atoi(request->getParam("shadeId")->value().c_str());
      if(request->hasParam("command")) cmd.command = translateSomfyCommand(request->getParam("command")->value());
      else if(request->hasParam("target")) cmd.target = atoi(request->getParam("target")->value().c_str());
      if(request->hasParam("repeat")) cmd.repeat = atoi(request->getParam("repeat")->value().c_str());
      if(request->hasParam("stepSize")) cmd.stepSize = atoi(request->getParam("stepSize")->value().c_str());
    }
    else if(asyncBody(request)) {
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, asyncBody(request));
      if(err) { asyncDeserializationError(request, err); return; }
      JsonObject obj = doc.as<JsonObject>();
      if(!obj.containsKey("shadeId")) { request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"No shade id was supplied.\"}")); return; }
      webServer.parseCommandJson(obj, cmd);
    }
    else { request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"No shade object supplied.\"}")); return; }
    AsyncResponseStream *stream = request->beginResponseStream("application/json");
    bool ok;
    {
      SomfyGuard guard;
      JsonAsyncResponse resp;
      resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
      ok = webServer.execShadeCommand(cmd, resp);
      if(ok) resp.endResponse();
    }
    if(ok) request->send(stream);
    else { delete stream; request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Shade with the specified id not found.\"}")); }
  }, nullptr, asyncBufferBody);
  asyncServer.on("/tiltCommand", ASYNC_HTTP_GET | ASYNC_HTTP_PUT | ASYNC_HTTP_POST, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    if(!webAsync.ensureAuth(request, false)) return;
    somfy_cmd_req_t cmd;
    if(request->hasParam("shadeId")) {
      cmd.shadeId = atoi(request->getParam("shadeId")->value().c_str());
      if(request->hasParam("command")) cmd.command = translateSomfyCommand(request->getParam("command")->value());
      else if(request->hasParam("target")) cmd.target = atoi(request->getParam("target")->value().c_str());
    }
    else if(asyncBody(request)) {
      DynamicJsonDocument doc(256);
      DeserializationError err = deserializeJson(doc, asyncBody(request));
      if(err) { asyncDeserializationError(request, err); return; }
      JsonObject obj = doc.as<JsonObject>();
      if(!obj.containsKey("shadeId")) { request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"No shade id was supplied.\"}")); return; }
      webServer.parseCommandJson(obj, cmd);
    }
    else { request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"No shade object supplied.\"}")); return; }
    AsyncResponseStream *stream = request->beginResponseStream("application/json");
    bool ok;
    {
      SomfyGuard guard;
      JsonAsyncResponse resp;
      resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
      ok = webServer.execTiltCommand(cmd, resp);
      if(ok) resp.endResponse();
    }
    if(ok) request->send(stream);
    else { delete stream; request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Shade with the specified id not found.\"}")); }
  }, nullptr, asyncBufferBody);
  asyncServer.on("/groupCommand", ASYNC_HTTP_GET | ASYNC_HTTP_PUT | ASYNC_HTTP_POST, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    if(!webAsync.ensureAuth(request, false)) return;
    somfy_cmd_req_t cmd;
    if(request->hasParam("groupId")) {
      cmd.groupId = atoi(request->getParam("groupId")->value().c_str());
      if(request->hasParam("command")) cmd.command = translateSomfyCommand(request->getParam("command")->value());
      if(request->hasParam("repeat")) cmd.repeat = atoi(request->getParam("repeat")->value().c_str());
      if(request->hasParam("stepSize")) cmd.stepSize = atoi(request->getParam("stepSize")->value().c_str());
    }
    else if(asyncBody(request)) {
      DynamicJsonDocument doc(256);
      DeserializationError err = deserializeJson(doc, asyncBody(request));
      if(err) { asyncDeserializationError(request, err); return; }
      JsonObject obj = doc.as<JsonObject>();
      if(!obj.containsKey("groupId")) { request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"No group id was supplied.\"}")); return; }
      webServer.parseCommandJson(obj, cmd);
    }
    else { request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"No group object supplied.\"}")); return; }
    AsyncResponseStream *stream = request->beginResponseStream("application/json");
    bool ok;
    {
      SomfyGuard guard;
      JsonAsyncResponse resp;
      resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
      ok = webServer.execGroupCommand(cmd, resp);
      if(ok) resp.endResponse();
    }
    if(ok) request->send(stream);
    else { delete stream; request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Group with the specified id not found.\"}")); }
  }, nullptr, asyncBufferBody);
  asyncServer.on("/repeatCommand", ASYNC_HTTP_GET | ASYNC_HTTP_PUT | ASYNC_HTTP_POST, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    if(!webAsync.ensureAuth(request, false)) return;
    somfy_cmd_req_t cmd;
    if(request->hasParam("shadeId")) cmd.shadeId = atoi(request->getParam("shadeId")->value().c_str());
    else if(request->hasParam("groupId")) cmd.groupId = atoi(request->getParam("groupId")->value().c_str());
    if(request->hasParam("command")) cmd.command = translateSomfyCommand(request->getParam("command")->value());
    if(request->hasParam("repeat")) cmd.repeat = atoi(request->getParam("repeat")->value().c_str());
    if(request->hasParam("stepSize")) cmd.stepSize = atoi(request->getParam("stepSize")->value().c_str());
    if(cmd.shadeId == 255 && cmd.groupId == 255 && asyncBody(request)) {
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, asyncBody(request));
      if(err) { asyncDeserializationError(request, err); return; }
      JsonObject obj = doc.as<JsonObject>();
      webServer.parseCommandJson(obj, cmd);
    }
    AsyncResponseStream *stream = request->beginResponseStream("application/json");
    uint8_t code;
    {
      SomfyGuard guard;
      JsonAsyncResponse resp;
      resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
      code = webServer.execRepeatCommand(cmd, resp);
      if(code == 0) resp.endResponse();
    }
    if(code != 0) delete stream;
    switch(code) {
      case 0: request->send(stream); break;
      case 1: request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Shade reference could not be found.\"}")); break;
      case 2: request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Group reference could not be found.\"}")); break;
      default: request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"No shade or group id supplied.\"}")); break;
    }
  }, nullptr, asyncBufferBody);
  // ---- Phase 3 batch B: entity mutations through the shared WebRequest ----
  // cores (WebRoutesShades.cpp / WebShades.cpp / Web.cpp). ANY method mask for
  // parity with the sync server.on(path, fn) registrations; the cores do their
  // own method filtering. The guard covers parsing and the somfy work alike.
  #define ASYNC_SHARED_ROUTE(path, corefn) \
    asyncServer.on(path, ASYNC_HTTP_ANY, [](AsyncWebServerRequest *request) { \
      webServer.lastActivity = millis(); \
      WebAsyncRequest req(request); \
      { SomfyGuard guard; webServer.corefn(req); } \
      req.finish(); \
    }, nullptr, asyncBufferBody)
  ASYNC_SHARED_ROUTE("/addRoom", handleAddRoom);
  ASYNC_SHARED_ROUTE("/addShade", handleAddShade);
  ASYNC_SHARED_ROUTE("/addGroup", handleAddGroup);
  ASYNC_SHARED_ROUTE("/groupOptions", handleGroupOptions);
  ASYNC_SHARED_ROUTE("/saveRoom", handleSaveRoom);
  ASYNC_SHARED_ROUTE("/saveShade", handleSaveShade);
  ASYNC_SHARED_ROUTE("/saveGroup", handleSaveGroup);
  ASYNC_SHARED_ROUTE("/setMyPosition", handleSetMyPosition);
  ASYNC_SHARED_ROUTE("/setRollingCode", handleSetRollingCode);
  ASYNC_SHARED_ROUTE("/setPaired", handleSetPaired);
  ASYNC_SHARED_ROUTE("/unpairShade", handleUnpairShade);
  ASYNC_SHARED_ROUTE("/linkRepeater", handleLinkRepeater);
  ASYNC_SHARED_ROUTE("/unlinkRepeater", handleUnlinkRepeater);
  ASYNC_SHARED_ROUTE("/unlinkRemote", handleUnlinkRemote);
  ASYNC_SHARED_ROUTE("/linkRemote", handleLinkRemote);
  ASYNC_SHARED_ROUTE("/linkToGroup", handleLinkToGroup);
  ASYNC_SHARED_ROUTE("/unlinkFromGroup", handleUnlinkFromGroup);
  ASYNC_SHARED_ROUTE("/deleteRoom", handleDeleteRoom);
  ASYNC_SHARED_ROUTE("/deleteShade", handleDeleteShade);
  ASYNC_SHARED_ROUTE("/deleteGroup", handleDeleteGroup);
  ASYNC_SHARED_ROUTE("/roomSortOrder", handleRoomSortOrder);
  ASYNC_SHARED_ROUTE("/shadeSortOrder", handleShadeSortOrder);
  ASYNC_SHARED_ROUTE("/groupSortOrder", handleGroupSortOrder);
  ASYNC_SHARED_ROUTE("/setPositions", handleSetPositions);
  ASYNC_SHARED_ROUTE("/setSensor", handleSetSensor);
  ASYNC_SHARED_ROUTE("/sendRemoteCommand", handleSendRemoteCommand);
  ASYNC_SHARED_ROUTE("/netDiag", handleNetDiag);
  // ---- Phase 3 batch C: system mutations. Long ops (/scanaps, /getReleases)
  // and every upload/download stay sync until phases 4-5.
  ASYNC_SHARED_ROUTE("/login", handleLogin);
  // GET-only for parity with the sync registration.
  asyncServer.on("/setLang", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    WebAsyncRequest req(request);
    { SomfyGuard guard; webServer.handleSetLang(req); }
    req.finish();
  });
  ASYNC_SHARED_ROUTE("/saveSecurity", handleSaveSecurity);
  ASYNC_SHARED_ROUTE("/setgeneral", handleSetGeneral);
  ASYNC_SHARED_ROUTE("/setNetwork", handleSetNetwork);
  ASYNC_SHARED_ROUTE("/setIP", handleSetIP);
  ASYNC_SHARED_ROUTE("/connectwifi", handleConnectWifi);
  ASYNC_SHARED_ROUTE("/connectmqtt", handleConnectMqtt);
  ASYNC_SHARED_ROUTE("/saveRadio", handleSaveRadio);
  ASYNC_SHARED_ROUTE("/clearRfStats", handleClearRfStats);
  ASYNC_SHARED_ROUTE("/restoreRfStats", handleRestoreRfStats);
  ASYNC_SHARED_ROUTE("/setGuidedRssi", handleSetGuidedRssi);
  ASYNC_SHARED_ROUTE("/beginFrequencyScan", handleBeginFrequencyScan);
  ASYNC_SHARED_ROUTE("/endFrequencyScan", handleEndFrequencyScan);
  ASYNC_SHARED_ROUTE("/reboot", handleReboot);
  ASYNC_SHARED_ROUTE("/cancelFirmware", handleCancelFirmware);
  ASYNC_SHARED_ROUTE("/recoverFilesystem", handleRecoverFilesystem);
  #undef ASYNC_SHARED_ROUTE
  // ---- Phase 4: file downloads (GET) and uploads (POST). -----------------
  // Streamed reads of the raw shade config; both expose remote addresses and
  // rolling codes, so they are auth-gated like the sync twins.
  asyncServer.on("/shades.cfg", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    if(git.lockFS) { request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Filesystem update in progress\"}")); return; }
    if(!webAsync.ensureAuth(request, true)) return;
    // handleStreamFile answers a 500 "Error opening file" on a missing file, not
    // send(fs, path)'s 404; match it for parity.
    if(!LittleFS.exists("/shades.cfg")) { request->send(500, "text/plain", "Error opening file"); return; }
    request->send(LittleFS, "/shades.cfg", "text/plain");
  });
  asyncServer.on("/shades.tmp", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    if(git.lockFS) { request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Filesystem update in progress\"}")); return; }
    if(!webAsync.ensureAuth(request, true)) return;
    if(!LittleFS.exists("/shades.tmp")) { request->send(500, "text/plain", "Error opening file"); return; }
    request->send(LittleFS, "/shades.tmp", "text/plain");
  });
  // Discovery document: unauthenticated on the sync server too. SSDP.schema()
  // emits a whole raw HTTP response (status line + headers + XML) meant for the
  // socket; capture it, strip the header block, and send just the XML so the
  // async framework does not double-wrap the headers.
  asyncServer.on("/upnp.xml", ASYNC_HTTP_GET, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    SchemaCapture cap;
    SSDP.schema(cap);
    int sep = cap.out.indexOf("\r\n\r\n");
    request->send(200, "text/xml", sep >= 0 ? cap.out.substring(sep + 4) : cap.out);
  });
  // Config backup: writes /controller.backup then streams it. The file holds
  // the WiFi passphrase by design, so it is config-gated.
  asyncServer.on("/backup", ASYNC_HTTP_ANY, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    if(git.lockFS) { request->send(503, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Filesystem update in progress\"}")); return; }
    if(!webAsync.ensureAuth(request, true)) return;
    bool attach = true;
    if(request->hasParam("attach")) attach = toBoolean(request->getParam("attach")->value().c_str(), attach);
    {
      SomfyGuard guard;
      somfy.writeBackup();
    }
    if(!LittleFS.exists("/controller.backup")) { request->send(500, "text/plain", F("Err: File")); return; }
    AsyncWebServerResponse *response = request->beginResponse(LittleFS, "/controller.backup", "text/plain");
    if(attach) {
      Timestamp ts;
      char *iso = ts.getISOTime();
      for(char *p = iso; *p; p++) {
        if(*p == '.') { *p = '\0'; break; }
        if(*p == ':') *p = '_';
      }
      response->addHeader(F("Content-Disposition"), String(F("attachment; filename=\"ESPSomfyRTS ")) + iso + F(".backup\""));
      response->addHeader(F("Access-Control-Expose-Headers"), F("Content-Disposition"));
    }
    request->send(response);
  });
  // Firmware / filesystem OTA. The completion handler answers and arms the
  // reboot; the upload handler does the flashing under the OTA gate.
  asyncServer.on("/updateFirmware", ASYNC_HTTP_POST,
    [](AsyncWebServerRequest *request) {
      webServer.lastActivity = millis();
      if(!webAsync.ensureAuth(request, true)) return;
      if(Update.hasError()) request->send(500, "application/json", "{\"status\":\"ERROR\",\"desc\":\"Error updating firmware: \"}");
      else request->send(200, "application/json", "{\"status\":\"SUCCESS\",\"desc\":\"Successfully updated firmware\"}");
      rebootDelay.reboot = true;
      rebootDelay.rebootTime = millis() + 500;
    },
    [](AsyncWebServerRequest *request, String filename, size_t index, uint8_t *data, size_t len, bool final) {
      asyncOtaUpload(request, index, data, len, final, false);
    });
  asyncServer.on("/updateApplication", ASYNC_HTTP_POST,
    [](AsyncWebServerRequest *request) {
      webServer.lastActivity = millis();
      if(!webAsync.ensureAuth(request, true)) return;
      if(Update.hasError()) request->send(500, "application/json", "{\"status\":\"ERROR\",\"desc\":\"Error updating application: \"}");
      else request->send(200, "application/json", "{\"status\":\"SUCCESS\",\"desc\":\"Successfully updated application\"}");
      rebootDelay.reboot = true;
      rebootDelay.rebootTime = millis() + 500;
    },
    [](AsyncWebServerRequest *request, String filename, size_t index, uint8_t *data, size_t len, bool final) {
      asyncOtaUpload(request, index, data, len, final, true);
    });
  // Shade-config upload: an ordinary LittleFS file, header-sniffed and capped,
  // loaded (validated) at the end. No reboot.
  asyncServer.on("/updateShadeConfig", ASYNC_HTTP_POST,
    [](AsyncWebServerRequest *request) {
      webServer.lastActivity = millis();
      if(git.lockFS) { request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Filesystem update in progress\"}")); return; }
      if(!webAsync.ensureAuth(request, true)) return;
      request->send(200, "application/json", "{\"status\":\"ERROR\",\"desc\":\"Updating Shade Config: \"}");
    },
    [](AsyncWebServerRequest *request, String filename, size_t index, uint8_t *data, size_t len, bool final) {
      asyncShadeConfigUpload(request, index, data, len, final);
    });
  // Backup restore: uploads the file to /shades.tmp then, in the completion
  // handler, applies it and reboots. The 'data' form field carries the
  // restore options.
  asyncServer.on("/restore", ASYNC_HTTP_POST,
    [](AsyncWebServerRequest *request) {
      webServer.lastActivity = millis();
      if(!webAsync.ensureAuth(request, true)) return;
      if(webServer.uploadSuccess) {
        request->send(200, "application/json", "{\"status\":\"Success\",\"desc\":\"Restoring Shade settings\"}");
        restore_options_t opts;
        if(request->hasParam("data", true)) {
          StaticJsonDocument<256> doc;
          DeserializationError err = deserializeJson(doc, request->getParam("data", true)->value());
          if(err) { asyncDeserializationError(request, err); return; }
          JsonObject obj = doc.as<JsonObject>();
          opts.fromJSON(obj);
        }
        else opts.shades = true;
        {
          SomfyGuard guard;
          ShadeConfigFile::restore(&somfy, "/shades.tmp", opts);
        }
        rebootDelay.reboot = true;
        rebootDelay.rebootTime = millis() + 1000;
      }
      else request->send(400, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Restore upload refused or incomplete\"}"));
    },
    [](AsyncWebServerRequest *request, String filename, size_t index, uint8_t *data, size_t len, bool final) {
      asyncRestoreUpload(request, index, data, len, final);
    });
  // ---- Phase 5: blocking network long-ops, run inline in async_tcp (see the
  // stack bump in platformio.ini). git ops claim git.status so git.loop() will
  // not launch its own concurrent check; the big GitRepo lives on the heap to
  // spare the task stack for the TLS session. -----------------------------
  asyncServer.on("/scanaps", ASYNC_HTTP_ANY, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    if(request->method() == ASYNC_HTTP_OPTIONS) { request->send(200, "text/plain", "OK"); return; }
    // The response echoes the current WiFi passphrase's SSID and details.
    if(!webAsync.ensureAuth(request, true)) return;
    if(net.softAPOpened) WiFi.disconnect(false);
    int n = WiFi.scanNetworks(false, true); // blocking (~seconds) in async_tcp
    AsyncResponseStream *stream = request->beginResponseStream("application/json");
    JsonAsyncResponse resp;
    resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
    resp.beginObject();
    resp.beginObject("connected");
    resp.addElem("name", settings.WIFI.ssid);
    resp.addElem("strength", (int32_t)WiFi.RSSI());
    resp.addElem("channel", (int32_t)WiFi.channel());
    resp.endObject();
    resp.beginArray("accessPoints");
    for(int i = 0; i < n; ++i) {
      if(WiFi.SSID(i).length() == 0 || WiFi.RSSI(i) < -95) continue; // hidden/too weak to join
      resp.beginObject();
      resp.addElem("name", WiFi.SSID(i).c_str());
      resp.addElem("channel", (int32_t)WiFi.channel(i));
      resp.addElem("strength", (int32_t)WiFi.RSSI(i));
      resp.addElem("macAddress", WiFi.BSSIDstr(i).c_str());
      resp.endObject();
    }
    resp.endArray();
    resp.endObject();
    resp.endResponse();
    request->send(stream);
  });
  asyncServer.on("/getReleases", ASYNC_HTTP_ANY, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    if(request->method() == ASYNC_HTTP_OPTIONS) { request->send(200, "text/plain", "OK"); return; }
    if(!webAsync.ensureAuth(request, false)) return;
    // A blocking GitHub fetch would delay a shade's STOP if one is travelling.
    bool idle;
    { SomfyGuard guard; idle = somfy.allIdle(); }
    if(!idle) { request->send(503, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Busy: a shade is moving\"}")); return; }
    // Claim the git state machine so git.loop() skips its own check for now.
    git.status = GIT_STATUS_CHECK;
    GitRepo *repo = new GitRepo();
    repo->getReleases();
    git.setCurrentRelease(*repo);
    git.status = GIT_STATUS_READY;
    AsyncResponseStream *stream = request->beginResponseStream("application/json");
    JsonAsyncResponse resp;
    resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
    resp.beginObject();
    repo->toJSON(resp);
    resp.endObject();
    resp.endResponse();
    delete repo;
    request->send(stream);
  });
  asyncServer.on("/downloadFirmware", ASYNC_HTTP_ANY, [](AsyncWebServerRequest *request) {
    webServer.lastActivity = millis();
    if(request->method() == ASYNC_HTTP_OPTIONS) { request->send(200, "text/plain", "OK"); return; }
    if(!webAsync.ensureAuth(request, true)) return;
    git.status = GIT_STATUS_CHECK;
    GitRepo *repo = new GitRepo();
    GitRelease *rel = nullptr;
    int8_t err = repo->getReleases();
    if(err == 0) {
      if(request->hasParam("ver")) {
        String ver = request->getParam("ver")->value();
        if(ver == "latest") rel = &repo->releases[0];
        else if(ver == "main") rel = &repo->releases[GIT_MAX_RELEASES];
        else {
          for(uint8_t i = 0; i < GIT_MAX_RELEASES; i++) {
            if(repo->releases[i].id == 0) continue;
            if(strcmp(repo->releases[i].name, ver.c_str()) == 0 ||
               strcmp(repo->releases[i].version.name, ver.c_str()) == 0) rel = &repo->releases[i];
          }
        }
        if(rel) {
          AsyncResponseStream *stream = request->beginResponseStream("application/json");
          JsonAsyncResponse resp;
          resp.beginResponse(stream, g_asyncContent, sizeof(g_asyncContent));
          resp.beginObject();
          rel->toJSON(resp);
          resp.endObject();
          resp.endResponse();
          strcpy(git.targetRelease, rel->version.name[0] ? rel->version.name : rel->name);
          // Hand the actual download to git.loop() (the flash write stays in
          // the loop task); leaving READY here would let the check re-fire.
          git.status = GIT_AWAITING_UPDATE;
          request->send(stream);
        }
        else { git.status = GIT_STATUS_READY; request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Release not found in repo.\"}")); }
      }
      else { git.status = GIT_STATUS_READY; request->send(500, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Release version not supplied.\"}")); }
    }
    else { git.status = GIT_STATUS_READY; request->send(err, "application/json", F("{\"status\":\"ERROR\",\"desc\":\"Error communicating with Github.\"}")); }
    delete repo;
  });
  // Twin of the sync handleNotFound: same OPTIONS shortcut, same 404 text.
  asyncServer.onNotFound([](AsyncWebServerRequest *request) {
    if(request->method() == ASYNC_HTTP_OPTIONS) {
      request->send(200, "text/plain", "OK");
      return;
    }
    request->send(404, "text/plain", "404: Not Found");
  });
  asyncServer.begin();
  Serial.printf("Async web server started on port %u\n", PORT);
}
