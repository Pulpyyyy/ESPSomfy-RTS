#include <Arduino.h>
#include <LittleFS.h>
// Web.h (hence WebServer.h) must come before the async headers: with
// WEBSERVER_H already defined, ESPAsyncWebServer enables its compatibility
// guard instead of redeclaring the HTTP_* method enum.
#include "Web.h"
#include "GitOTA.h"
#include "WebAsync.h"

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
  asyncServer.onNotFound([](AsyncWebServerRequest *request) {
    request->send(404, "text/plain", "Not found");
  });
  asyncServer.begin();
  Serial.printf("Async web server started on port %u\n", PORT);
}
