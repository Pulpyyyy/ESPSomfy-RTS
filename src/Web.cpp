#include <WiFi.h>
#include <WebServer.h>
#include <LittleFS.h>
#include <Update.h>
#include <esp_task_wdt.h>
#include "mbedtls/md.h"
#include "ConfigSettings.h"
#include "ConfigFile.h"
#include "Utils.h"
#include "SSDP.h"
#include "Somfy.h"
#include "RfStats.h"
#include "WResp.h"
#include "Web.h"
#include "MQTT.h"
#include "GitOTA.h"
#include "Rollback.h"
#include "Network.h"

extern ConfigSettings settings;
extern SSDPClass SSDP;
extern rebootDelay_t rebootDelay;
extern SomfyShadeController somfy;
extern Web webServer;
extern MQTTClass mqtt;
extern GitUpdater git;
extern Network net;
extern RfStats rfStats;

// WEB_MAX_RESPONSE and the extern declarations for these live in Web.h.
char g_content[WEB_MAX_RESPONSE];


// General responses.  extern on the definitions: a namespace-scope const array
// otherwise has internal linkage and the other Web*.cpp files must see THESE
// objects (pointer identity matters, see Web.h).
extern const char _response_404[] = "404: Service Not Found";

// Encodings
extern const char _encoding_text[] = "text/plain";
extern const char _encoding_html[] = "text/html";
extern const char _encoding_json[] = "application/json";


WebServer apiServer(8081);
WebServer server(80);
void Web::startup() {
  Serial.println("Launching web server...");


  //server.on("/json", HTTP_GET, []() {
    //Serial.print(">>> REQUETE /json RECUE DE L'IP : ");
    //Serial.println(server.client().remoteIP().toString());
    //server.send(200, "application/json", "{}");
  //});
}
// Bodies shared by the sync and async transports.
void Web::emitModuleSettings(JsonResponse &resp) {
  resp.beginObject();
  resp.addElem("fwVersion", settings.fwVersion.name);
  settings.toJSON(resp);
  settings.NTP.toJSON(resp);
  resp.endObject();
}
void Web::emitNetworkSettings(JsonResponse &resp) {
  resp.beginObject();
  settings.toJSON(resp);
  resp.addElem("fwVersion", settings.fwVersion.name);
  resp.beginObject("ethernet");
  settings.Ethernet.toJSON(resp);
  resp.endObject();
  resp.beginObject("wifi");
  settings.WIFI.toJSON(resp);
  resp.endObject();
  resp.beginObject("ip");
  settings.IP.toJSON(resp);
  resp.endObject();
  resp.endObject();
}
void Web::emitMqttSettings(JsonResponse &resp) {
  resp.beginObject();
  settings.MQTT.toJSON(resp);
  resp.endObject();
}
void Web::emitRadio(JsonResponse &resp) {
  resp.beginObject();
  somfy.transceiver.toJSON(resp);
  resp.endObject();
}
size_t Web::buildSecurityJson(char *buff, size_t size) {
  DynamicJsonDocument doc(192);
  JsonObject obj = doc.to<JsonObject>();
  settings.Security.toJSON(obj);
  return serializeJson(doc, buff, size);
}
void Web::emitRfStats(JsonResponse &resp) {
  resp.beginObject();
  resp.addElem("frequency", somfy.transceiver.config.frequency);
  rfStats.toJSON(resp);
  // The board's own link belongs on the same page: a weak or flapping WiFi
  // reads exactly like an RF problem from the user's side.
  resp.beginObject("wifi");
  resp.addElem("rssi", net.connType == conn_types_t::wifi ? (int32_t)WiFi.RSSI() : (int32_t)0);
  resp.addElem("channel", (int32_t)net.channel);
  resp.addElem("reconnects", (uint32_t)net.reconnects);
  resp.addElem("uptime", (uint32_t)(net.connectedAt > 0 ? (millis() - net.connectedAt) / 1000 : 0));
  resp.endObject();
  resp.endObject();
}
void Web::loop() {
  server.handleClient();
  delay(1);
  apiServer.handleClient();
  delay(1);
}
void Web::sendCORSHeaders(WebServer &server) {
    // Every handler passes through here first: a cheap place to record UI activity.
    this->lastActivity = millis();
    //server.sendHeader(F("Connection"), F("Keep-Alive"));
    //server.sendHeader(F("Keep-Alive"), F("timeout=5, max=1000"));
    //server.sendHeader(F("Access-Control-Allow-Origin"), F("*"));
    //server.sendHeader(F("Access-Control-Max-Age"), F("600"));
    //server.sendHeader(F("Access-Control-Allow-Methods"), F("PUT,POST,GET,OPTIONS"));
    //server.sendHeader(F("Access-Control-Allow-Headers"), F("*"));
}
void Web::sendCacheHeaders(uint32_t seconds) {
  server.sendHeader(F("Cache-Control"), F("public, max-age=604800, immutable"));
}
void Web::end() {
  //server.end();
}
void Web::handleStreamFile(WebServer &server, const char *filename, const char *encoding) {
  if(git.lockFS) {
    server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Filesystem update in progress\"}"));
    return;
  }
  webServer.sendCORSHeaders(server);

  if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
  esp_task_wdt_reset();
  // Load the index html page from the data directory.
  // --- LE MOUCHARD DE MÉMOIRE ---
  WiFiClient clientDetect = server.client();
  //Serial.printf("\n[DEBUG] Requête de l'IP: %s | Fichier: %s\n", clientDetect.remoteIP().toString().c_str(), filename);
  //Serial.printf("[DEBUG] RAM Avant: Free:%d | MaxBlock:%d\n", ESP.getFreeHeap(), ESP.getMaxAllocHeap());
  // ------------------------------

  
  Serial.print("Loading file ");
  Serial.println(filename);
  File file = LittleFS.open(filename, "r");
  if (!file) {
    Serial.print("Error opening");
    Serial.println(filename);
    server.send(500, _encoding_text, "Error opening file");
    return;
  }
  server.setContentLength(file.size());

  // Harden the UI document itself. The page uses inline <script>, inline event
  // handlers and inline style attributes (hence 'unsafe-inline'); the live
  // WebSocket runs on :8080 and release notes are fetched from api.github.com,
  // so connect-src is widened accordingly. Everything else stays same-origin.
  if(encoding == _encoding_html) {
    server.sendHeader(F("Content-Security-Policy"), F("default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api.github.com ws://*:8080 wss://*:8080; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"));
    server.sendHeader(F("X-Content-Type-Options"), F("nosniff"));
  }

  if (String(filename).endsWith(".gz")) {
      server.sendHeader("Content-Encoding", "gzip");
  }
  server.send(200, encoding, "");
  // Copy through g_content (idle during a file stream) in 4KB chunks instead of
  // WiFiClient::write(Stream&)'s internal 1360-byte loop: page-aligned LittleFS
  // reads and fewer socket writes roughly double the asset throughput, which is
  // what the first cold page load is made of.
  size_t n;
  while((n = file.read((uint8_t *)g_content, sizeof(g_content))) > 0) {
    server.client().write((const uint8_t *)g_content, n);
    esp_task_wdt_reset();
  }
  file.close();
 
  esp_task_wdt_reset();
}
void Web::handleController(WebServer &server) {
  webServer.sendCORSHeaders(server);
  if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
  // Shade/room/group names and layout are private; gate the read behind auth.
  // Passthrough when security is None or ConfigOnly (isAuthenticated(cfg=false));
  // only full-auth mode now hides the dashboard until login.
  if(!this->ensureAuth(server, false)) return;
  HTTPMethod method = server.method();
  settings.printAvailHeap();
  if (method == HTTP_POST || method == HTTP_GET) {
    JsonResponse resp;
    resp.beginResponse(&server, g_content, sizeof(g_content));
    this->emitController(resp, this->isAuthenticated(server, true));
    resp.endResponse();
  }
  else server.send(404, _encoding_text, _response_404);
}
// Body shared by the sync and async transports.
void Web::emitController(JsonResponse &resp, bool includeSecrets) {
  resp.beginObject();
  resp.addElem("maxRooms", (uint8_t)SOMFY_MAX_ROOMS);
  resp.addElem("maxShades", (uint8_t)SOMFY_MAX_SHADES);
  resp.addElem("maxGroups", (uint8_t)SOMFY_MAX_GROUPS);
  resp.addElem("maxGroupedShades", (uint8_t)SOMFY_MAX_GROUPED_SHADES);
  resp.addElem("maxLinkedRemotes", (uint8_t)SOMFY_MAX_LINKED_REMOTES);
  resp.addElem("startingAddress", (uint32_t)somfy.startingAddress);
  resp.beginObject("transceiver");
  somfy.transceiver.toJSON(resp);
  resp.endObject();
  resp.beginObject("version");
  git.toJSON(resp);
  resp.endObject();
  resp.beginArray("rooms");
  somfy.toJSONRooms(resp);
  resp.endArray();
  resp.beginArray("shades");
  somfy.toJSONShades(resp, includeSecrets);
  resp.endArray();
  resp.beginArray("groups");
  somfy.toJSONGroups(resp, includeSecrets);
  resp.endArray();
  resp.beginArray("repeaters");
  somfy.toJSONRepeaters(resp);
  resp.endArray();
  resp.endObject();
}
void Web::handleBackup(WebServer &server, bool attach) {
  webServer.sendCORSHeaders(server);
  // A backup writes to LittleFS; refuse while a filesystem update is in progress
  // so we do not race the OTA write against the config partition.
  if(git.lockFS) {
    server.send(503, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Filesystem update in progress\"}"));
    return;
  }
  // The backup file contains the WiFi passphrase by design (needed for restore).
  if(!this->ensureAuth(server, true)) return;
  if(server.hasArg("attach")) attach = toBoolean(server.arg("attach").c_str(), attach);

  if(attach) {
    Timestamp ts;
    char * iso = ts.getISOTime();

    for(char *p = iso; *p; p++) {
      if(*p == '.') { *p = '\0'; break; }
      if(*p == ':') *p = '_';
    }

    server.sendHeader(F("Content-Disposition"), String(F("attachment; filename=\"ESPSomfyRTS ")) + iso + F(".backup\""));
    server.sendHeader(F("Access-Control-Expose-Headers"), F("Content-Disposition"));
  }
  Serial.println(F("Backup..."));
  somfy.writeBackup();

  File file = LittleFS.open("/controller.backup", "r");
  if (!file) {
    server.send(500, _encoding_text, F("Err: File"));
    return;
  }
  server.streamFile(file, _encoding_text);
  file.close();
}
void Web::handleDownloadFirmware(WebServer &server) {
  webServer.sendCORSHeaders(server);
  if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
  if(!this->ensureAuth(server, true)) return;
  GitRepo repo;
  GitRelease *rel = nullptr;
  int8_t err = repo.getReleases();
  Serial.println("downloadFirmware called...");
  if(err == 0) {
    if(server.hasArg("ver")) {
      if(strcmp(server.arg("ver").c_str(), "latest") == 0) rel = &repo.releases[0];
      else if(strcmp(server.arg("ver").c_str(), "main") == 0) {
        rel = &repo.releases[GIT_MAX_RELEASES];
      }
      else {
        for(uint8_t i = 0; i < GIT_MAX_RELEASES; i++) {
          if(repo.releases[i].id == 0) continue;
          // Match on the version (tag-derived) as well as the display name, so a
          // release with a descriptive title ("v3.0.0 — ...") is still found: the
          // UI sends version.name, and matching only the title used to fail.
          if(strcmp(repo.releases[i].name, server.arg("ver").c_str()) == 0 ||
             strcmp(repo.releases[i].version.name, server.arg("ver").c_str()) == 0) {
            rel = &repo.releases[i];
          }
        }
      }
      if(rel) {
        JsonResponse resp;
        resp.beginResponse(&server, g_content, sizeof(g_content));
        resp.beginObject();
        rel->toJSON(resp);
        resp.endObject();
        resp.endResponse();
        // The OTA download URL is built from this value as
        // .../releases/download/<targetRelease>/, which GitHub keys by the git tag,
        // not the (possibly spaced/decorated) release title. Prefer the tag-derived
        // version name; fall back to the title only for the tag-less "main" slot.
        strcpy(git.targetRelease, rel->version.name[0] ? rel->version.name : rel->name);
        git.status = GIT_AWAITING_UPDATE;
      }
      else
        server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Release not found in repo.\"}"));
    }
    else
      server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Release version not supplied.\"}"));
  }
  else {
      server.send(err, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Error communicating with Github.\"}"));
  }
}
void Web::handleNotFound(WebServer &server) {
  if(server.method() == HTTP_OPTIONS) {
    server.send(200, _encoding_text, F("OK"));
    return;
  }
  Serial.print(F("404: "));
  Serial.println(server.uri());

  server.send(404, _encoding_text, F("404: Not Found"));
}
void Web::handleReboot(WebServer &server) {
  webServer.sendCORSHeaders(server);
  if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
  if(!this->ensureAuth(server, true)) return;
  HTTPMethod method = server.method();
  if (method == HTTP_POST || method == HTTP_PUT) {
    Serial.println("Rebooting ESP...");
    rebootDelay.reboot = true;
    rebootDelay.rebootTime = millis() + 500;
    server.send(200, "application/json", "{\"status\":\"OK\",\"desc\":\"Successfully started reboot\"}");
  }
  else {
    server.send(201, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Invalid HTTP Method: \"}");
  }
}
void Web::begin() {
  Serial.println("Creating Web MicroServices...");
  // No CORS headers: the embedded UI is same-origin and Home Assistant talks
  // server-to-server. A wildcard here would let any web page visited from the
  // LAN read and drive this API from the victim's browser.
  // The ESP32 WebServer only exposes headers it was told to collect. Origin and
  // Referer are needed for the CSRF/DNS-rebinding check; Host is exposed via
  // hostHeader() but is collected here too for completeness.
  const char *keys[] = {"apikey", "Host", "Origin", "Referer"};
  const size_t keyCount = sizeof(keys) / sizeof(keys[0]);
  server.collectHeaders(keys, keyCount);
  // API Server Handlers
  apiServer.collectHeaders(keys, keyCount);
  this->beginApiRoutes();
  server.on("/lang", HTTP_GET, [this]() { this->handleLang(server); });
  server.on("/setLang", HTTP_GET, [this]() { this->handleSetLang(server); });

  server.on("/tiltCommand", []() { webServer.handleTiltCommand(server); });
  server.on("/repeatCommand", []() { webServer.handleRepeatCommand(server); });
  server.on("/shadeCommand", []() { webServer.handleShadeCommand(server); });
  server.on("/groupCommand", []() { webServer.handleGroupCommand(server); });
  server.on("/setPositions", []() { webServer.handleSetPositions(server); });
  server.on("/setSensor", []() { webServer.handleSetSensor(server); });
  server.on("/upnp.xml", []() { SSDP.schema(server.client()); });
  server.on("/", []() { webServer.handleStreamFile(server, "/index.html.gz", _encoding_html); });
  server.on("/login", []() { webServer.handleLogin(server); });
  server.on("/loginContext", []() { webServer.handleLoginContext(server); });
  // The raw shade config exposes remote addresses and rolling codes.
  server.on("/shades.cfg", []() { if(!webServer.ensureAuth(server, true)) return; webServer.handleStreamFile(server, "/shades.cfg", _encoding_text); });
  server.on("/shades.tmp", []() { if(!webServer.ensureAuth(server, true)) return; webServer.handleStreamFile(server, "/shades.tmp", _encoding_text); });
  server.on("/index.js", []() { webServer.sendCacheHeaders(604800); webServer.handleStreamFile(server, "/index.js.gz", "text/javascript"); });
  // base/main/overlays are concatenated into app.css by the build (minify_data.py):
  // one stylesheet request instead of three on a one-connection-at-a-time server.
  server.on("/app.css", []() { webServer.sendCacheHeaders(604800); webServer.handleStreamFile(server, "/app.css.gz", "text/css"); });
  server.on("/favicon.svg", []() { webServer.sendCacheHeaders(604800); webServer.handleStreamFile(server, "/favicon.svg.gz", "image/svg+xml"); });

  server.on("/editionWifi.webp", []() { webServer.sendCacheHeaders(604800); webServer.handleStreamFile(server, "/editionWifi.webp", "image/webp"); });
  server.on("/editionEthernet.webp", []() { webServer.sendCacheHeaders(604800); webServer.handleStreamFile(server, "/editionEthernet.webp", "image/webp"); });

  server.onNotFound([]() { webServer.handleNotFound(server); });
  this->beginShadeRoutes();
  this->beginSystemRoutes();
  this->beginNetworkRoutes();
  this->beginRadioRoutes();
  server.begin();
  apiServer.begin();
}

void Web::beginApiRoutes() {
  apiServer.on("/discovery", []() { webServer.handleDiscovery(apiServer); });
  apiServer.on("/rooms", []() {webServer.handleGetRooms(apiServer); });
  apiServer.on("/shades", []() { webServer.handleGetShades(apiServer); });
  apiServer.on("/groups", []() { webServer.handleGetGroups(apiServer); });
  apiServer.on("/login", []() { webServer.handleLogin(apiServer); });
  apiServer.onNotFound([]() { webServer.handleNotFound(apiServer); });
  apiServer.on("/controller", []() { webServer.handleController(apiServer); });
  apiServer.on("/shadeCommand", []() { webServer.handleShadeCommand(apiServer); });
  apiServer.on("/groupCommand", []() { webServer.handleGroupCommand(apiServer); });
  apiServer.on("/tiltCommand", []() { webServer.handleTiltCommand(apiServer); });
  apiServer.on("/repeatCommand", []() { webServer.handleRepeatCommand(apiServer); });
  apiServer.on("/room", HTTP_GET, [] () { webServer.handleRoom(apiServer); });
  apiServer.on("/shade", HTTP_GET, [] () { webServer.handleShade(apiServer); });
  apiServer.on("/group", HTTP_GET, [] () { webServer.handleGroup(apiServer); });
  apiServer.on("/setPositions", []() { webServer.handleSetPositions(apiServer); });
  apiServer.on("/setSensor", []() { webServer.handleSetSensor(apiServer); });
  apiServer.on("/downloadFirmware", []() { webServer.handleDownloadFirmware(apiServer); });
  apiServer.on("/backup", []() { webServer.handleBackup(apiServer); });
  apiServer.on("/reboot", []() { webServer.handleReboot(apiServer); });
}
void Web::beginNetworkRoutes() {
  server.on("/scanaps", []() {
    webServer.sendCORSHeaders(server);
    esp_task_wdt_reset();
    
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    // The response echoes the current WiFi passphrase.
    if(!webServer.ensureAuth(server, true)) return;
    esp_task_wdt_delete(NULL);
    if(net.softAPOpened) WiFi.disconnect(false);
    int n = WiFi.scanNetworks(false, true);
    esp_task_wdt_add(NULL);
    
    Serial.print("Scanned ");
    Serial.print(n);
    Serial.println(" networks");
    // Ok we need to chunk this response as well.
    JsonResponse resp;
    resp.beginResponse(&server, g_content, sizeof(g_content));
    resp.beginObject();
    resp.beginObject("connected");
    resp.addElem("name", settings.WIFI.ssid);
    resp.addElem("strength", (int32_t)WiFi.RSSI());
    resp.addElem("channel", (int32_t)WiFi.channel());
    resp.endObject();
    resp.beginArray("accessPoints");
    for(int i = 0; i < n; ++i) {
      if(WiFi.SSID(i).length() == 0 || WiFi.RSSI(i) < -95) continue; // Ignore hidden and weak networks that we cannot connect to anyway.
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
    });
  server.on("/saveSecurity", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) return server.send(200);
    if(!webServer.ensureAuth(server, true)) return;

    StaticJsonDocument<768> doc; // Un seul doc suffit pour l'entrée et la sortie
    if (deserializeJson(doc, server.arg("plain"))) return server.send(400, "text/plain", F("J-Err"));

    if (server.method() == HTTP_POST || server.method() == HTTP_PUT) {
      JsonObject obj = doc.as<JsonObject>();
      settings.Security.fromJSON(obj);
      settings.Security.save();

      doc.clear();
      obj = doc.to<JsonObject>();

      char token[65];
      webServer.createAPIToken(server.client().remoteIP(), token);
      settings.Security.toJSON(obj);
      obj["apiKey"] = token;

      serializeJson(doc, g_content);
      server.send(200, _encoding_json, g_content);
    } else {
      server.send(405, _encoding_json, F("{\"s\":\"ERR\"}"));
    }
  });
  server.on("/getSecurity", []() {
    webServer.sendCORSHeaders(server);
    // The response contains the password and pin in clear text.
    if(!webServer.ensureAuth(server, true)) return;
    webServer.buildSecurityJson(g_content, sizeof(g_content));
    server.send(200, _encoding_json, g_content);
    });

  server.on("/setgeneral", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    DynamicJsonDocument doc(512);
    
    Serial.print("Plain: ");
    Serial.print(server.method());
    Serial.println(server.arg("plain"));
    DeserializationError err = deserializeJson(doc, server.arg("plain"));
    if (err) {
      webServer.handleDeserializationError(server, err);
      return;
    }
    else {
      JsonObject obj = doc.as<JsonObject>();
      HTTPMethod method = server.method();
      if (method == HTTP_POST || method == HTTP_PUT) {
        // Parse out all the inputs.
        if (obj.containsKey("hostname") || obj.containsKey("ssdpBroadcast") || obj.containsKey("checkForUpdate")) {
          bool checkForUpdate = settings.checkForUpdate;
          settings.fromJSON(obj);
          settings.save();
          if(settings.checkForUpdate != checkForUpdate) git.emitUpdateCheck();
          if(obj.containsKey("hostname")) net.updateHostname();
        }
        if (obj.containsKey("ntpServer") || obj.containsKey("ntpServer")) {
          settings.NTP.fromJSON(obj);
          settings.NTP.save();
        }
        server.send(200, "application/json", "{\"status\":\"OK\",\"desc\":\"Successfully set General Settings\"}");
      }
      else {
        server.send(201, "application/json", "{\"status\":\"ERROR\",\"desc\":\"Invalid HTTP Method: \"}");
      }
    }
    });
  server.on("/setNetwork", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    DynamicJsonDocument doc(1024);
    DeserializationError err = deserializeJson(doc, server.arg("plain"));
    if (err) {
      Serial.print("Error parsing JSON ");
      Serial.println(err.c_str());
      String msg = err.c_str();
      server.send(400, _encoding_html, "Error parsing JSON body<br>" + msg);
    }
    else {
      JsonObject obj = doc.as<JsonObject>();
      HTTPMethod method = server.method();
      if (method == HTTP_POST || method == HTTP_PUT) {
        // Parse out all the inputs.
        bool reboot = false;
        if(obj.containsKey("connType") && obj["connType"].as<uint8_t>() != static_cast<uint8_t>(settings.connType)) {
          settings.connType = static_cast<conn_types_t>(obj["connType"].as<uint8_t>());
          settings.save();
          reboot = true;
        }
        if(obj.containsKey("wifi")) {
          JsonObject objWifi = obj["wifi"];
          // Compare against the applied result since fromJSON keeps the stored
          // passphrase when the client sends it empty for an unchanged SSID.
          char oldSsid[sizeof(settings.WIFI.ssid)];
          char oldPass[sizeof(settings.WIFI.passphrase)];
          strlcpy(oldSsid, settings.WIFI.ssid, sizeof(oldSsid));
          strlcpy(oldPass, settings.WIFI.passphrase, sizeof(oldPass));
          settings.WIFI.fromJSON(objWifi);
          settings.WIFI.save();
          if(settings.connType == conn_types_t::wifi &&
            (strcmp(oldSsid, settings.WIFI.ssid) != 0 || strcmp(oldPass, settings.WIFI.passphrase) != 0)) {
            if(WiFi.softAPgetStationNum() == 0) reboot = true;
          }
        }
        if(obj.containsKey("ethernet"))
        {
          JsonObject objEth = obj["ethernet"];
          // This is an ethernet connection so if anything changes we need to reboot.
          if(settings.connType == conn_types_t::ethernet || settings.connType == conn_types_t::ethernetpref)
            reboot = true;
          settings.Ethernet.fromJSON(objEth);
          settings.Ethernet.save();
        }
        if (reboot) {
          Serial.println("Rebooting ESP for new Network settings...");
          rebootDelay.reboot = true;
          rebootDelay.rebootTime = millis() + 1000;
        }
        server.send(200, "application/json", "{\"status\":\"OK\",\"desc\":\"Successfully set Network Settings\"}");
      }
      else {
        server.send(201, "application/json", "{\"status\":\"ERROR\",\"desc\":\"Invalid HTTP Method: \"}");
      }
    }
  });
  server.on("/setIP", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    Serial.println("Setting IP...");
    DynamicJsonDocument doc(1024);
    DeserializationError err = deserializeJson(doc, server.arg("plain"));
    if (err) {
      webServer.handleDeserializationError(server, err);
      return;
    }
    else {
      JsonObject obj = doc.as<JsonObject>();
      HTTPMethod method = server.method();
      if (method == HTTP_POST || method == HTTP_PUT) {
        settings.IP.fromJSON(obj);
        settings.IP.save();
        server.send(200, "application/json", "{\"status\":\"OK\",\"desc\":\"Successfully set Network Settings\"}");
      }
      else {
        server.send(201, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Invalid HTTP Method: \"}");
      }
    }
  });
  server.on("/connectwifi", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    Serial.println("Settings WIFI connection...");
    DynamicJsonDocument doc(512);
    DeserializationError err = deserializeJson(doc, server.arg("plain"));
    if (err) {
      webServer.handleDeserializationError(server, err);
      return;
    }
    else {
      JsonObject obj = doc.as<JsonObject>();
      HTTPMethod method = server.method();
      //Serial.print(F("HTTP Method: "));
      //Serial.println(server.method());
      if (method == HTTP_POST || method == HTTP_PUT) {
        String ssid = "";
        String passphrase = "";
        if (obj.containsKey("ssid")) ssid = obj["ssid"].as<String>();
        if (obj.containsKey("passphrase")) passphrase = obj["passphrase"].as<String>();
        // The passphrase is never prefilled client-side; an empty value means
        // "keep the stored one" unless the target SSID changes.
        bool ssidChanged = ssid.compareTo(settings.WIFI.ssid) != 0;
        if (passphrase.length() == 0 && !ssidChanged) passphrase = settings.WIFI.passphrase;
        bool reboot = ssidChanged || passphrase.compareTo(settings.WIFI.passphrase) != 0;
        if (!settings.WIFI.ssidExists(ssid.c_str()) && ssid.length() > 0) {
          server.send(400, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"WiFi Network Does not exist\"}");
        }
        else {
          SETCHARPROP(settings.WIFI.ssid, ssid.c_str(), sizeof(settings.WIFI.ssid));
          SETCHARPROP(settings.WIFI.passphrase, passphrase.c_str(), sizeof(settings.WIFI.passphrase));
          settings.WIFI.save();
          settings.WIFI.print();
          server.send(201, _encoding_json, "{\"status\":\"OK\",\"desc\":\"Successfully set server connection\"}");
          if (reboot) {
            Serial.println("Rebooting ESP for new WiFi settings...");
            rebootDelay.reboot = true;
            rebootDelay.rebootTime = millis() + 1000;
          }
        }
      }
      else {
        server.send(201, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Invalid HTTP Method: \"}");
      }
    }
    });
  server.on("/modulesettings", []() {
    webServer.sendCORSHeaders(server);
    JsonResponse resp;
    resp.beginResponse(&server, g_content, sizeof(g_content));
    webServer.emitModuleSettings(resp);
    resp.endResponse();
    });
  server.on("/networksettings", []() {
    webServer.sendCORSHeaders(server);
    // The response contains the WiFi passphrase.
    if(!webServer.ensureAuth(server, true)) return;
    JsonResponse resp;
    resp.beginResponse(&server, g_content, sizeof(g_content));
    webServer.emitNetworkSettings(resp);
    resp.endResponse();
    });
  server.on("/connectmqtt", []() {
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    DynamicJsonDocument doc(1024);
    DeserializationError err = deserializeJson(doc, server.arg("plain"));
    if (err) {
      webServer.handleDeserializationError(server, err);
      return;
    }
    else {
      JsonObject obj = doc.as<JsonObject>();
      HTTPMethod method = server.method();
      Serial.print("Saving MQTT ");
      Serial.print(F("HTTP Method: "));
      Serial.println(server.method());
      if (method == HTTP_POST || method == HTTP_PUT) {
        // Reject the payload before dropping the current connection: an empty or
        // wildcard root topic would scope this device at the broker root.
        if(!settings.MQTT.fromJSON(obj)) {
          server.send(400, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"The MQTT root topic is required and cannot contain '+' or '#' nor start with '/' or '$'\"}"));
          return;
        }
        mqtt.disconnect();
        settings.MQTT.save();
        JsonResponse resp;
        resp.beginResponse(&server, g_content, sizeof(g_content));
        resp.beginObject();
        settings.MQTT.toJSON(resp);
        resp.endObject();
        resp.endResponse();
        /*
        DynamicJsonDocument sdoc(1024);
        JsonObject sobj = sdoc.to<JsonObject>();
        settings.MQTT.toJSON(sobj);
        serializeJson(sdoc, g_content);
        server.send(200, _encoding_json, g_content);
        */
      }
      else {
        server.send(201, "application/json", "{\"status\":\"ERROR\",\"desc\":\"Invalid HTTP Method: \"}");
      }
    }
    });
  server.on("/mqttsettings", []() {
    webServer.sendCORSHeaders(server);
    // The response contains the MQTT password.
    if(!webServer.ensureAuth(server, true)) return;
    JsonResponse resp;
    resp.beginResponse(&server, g_content, sizeof(g_content));
    webServer.emitMqttSettings(resp);
    resp.endResponse();
    });
}
void Web::beginRadioRoutes() {
  server.on("/saveRadio", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) return server.send(200);
    if(!webServer.ensureAuth(server, true)) return;

    StaticJsonDocument<512> doc; // Réduit de 1024 à 768 si tes réglages radio sont simples
    if (deserializeJson(doc, server.arg("plain"))) return server.send(400, "text/plain", F("J-Err"));

    if (server.method() == HTTP_POST || server.method() == HTTP_PUT) {
      JsonObject obj = doc.as<JsonObject>();
      somfy.transceiver.fromJSON(obj);
      somfy.transceiver.save();
      // Roll the RF-stats epoch so KPIs accumulated under the old radio settings are
      // frozen for the before/after comparison; no-op when nothing relevant changed.
      rfStats.syncEpoch(somfy.transceiver.config.frequency, somfy.transceiver.config.rxBandwidth, somfy.transceiver.config.txPower);

      JsonResponse resp;
      resp.beginResponse(&server, g_content, sizeof(g_content));
      resp.beginObject();
      somfy.transceiver.toJSON(resp);
      resp.endObject();
      resp.endResponse();
    } else {
      server.send(405, _encoding_json, F("{\"s\":\"ERR\"}"));
    }
  });
  server.on("/getRadio", []() {
    webServer.sendCORSHeaders(server);
    // Config-level read, same gate as /saveRadio and the scan endpoints.
    if(!webServer.ensureAuth(server, true)) return;
    JsonResponse resp;
    resp.beginResponse(&server, g_content, sizeof(g_content));
    webServer.emitRadio(resp);
    resp.endResponse();
    });
  server.on("/sendRemoteCommand", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    HTTPMethod method = server.method();
    if (method == HTTP_GET || method == HTTP_PUT || method == HTTP_POST) {
      somfy_frame_t frame;
      uint8_t repeats = 0;
      if (server.hasArg("address")) {
        frame.remoteAddress = atoi(server.arg("address").c_str());
        if (server.hasArg("encKey")) frame.encKey = atoi(server.arg("encKey").c_str());
        if (server.hasArg("command")) frame.cmd = translateSomfyCommand(server.arg("command"));
        if (server.hasArg("rcode")) frame.rollingCode = atoi(server.arg("rcode").c_str());
        if (server.hasArg("repeats")) repeats = atoi(server.arg("repeats").c_str());
      }
      else if (server.hasArg("plain")) {
        StaticJsonDocument<128> doc;
        DeserializationError err = deserializeJson(doc, server.arg("plain"));
        if (err) {
          webServer.handleDeserializationError(server, err);
          return;
        }
        else {
          JsonObject obj = doc.as<JsonObject>();
          String scmd;
          if (obj.containsKey("address")) frame.remoteAddress = obj["address"];
          if (obj.containsKey("command")) scmd = obj["command"].as<String>();
          if (obj.containsKey("repeats")) repeats = obj["repeats"];
          if (obj.containsKey("rcode")) frame.rollingCode = obj["rcode"];
          if (obj.containsKey("encKey")) frame.encKey = obj["encKey"];
          frame.cmd = translateSomfyCommand(scmd.c_str());
        }
      }
      if (frame.remoteAddress > 0 && frame.rollingCode > 0) {
        somfy.sendFrame(frame, repeats);
        server.send(200, _encoding_json, F("{\"status\":\"SUCCESS\",\"desc\":\"Command Sent\"}"));
      }
      else
        server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No address or rolling code provided\"}"));
    }
    });
  server.on("/beginFrequencyScan", []() {
    webServer.sendCORSHeaders(server);
    if(!webServer.ensureAuth(server, true)) return;
    somfy.transceiver.beginFrequencyScan();
    JsonResponse resp;
    resp.beginResponse(&server, g_content, sizeof(g_content));
    resp.beginObject();
    somfy.transceiver.toJSON(resp);
    resp.endObject();
    resp.endResponse();
    /*
    DynamicJsonDocument doc(1024);
    JsonObject obj = doc.to<JsonObject>();
    somfy.transceiver.toJSON(obj);
    serializeJson(doc, g_content);
    server.send(200, _encoding_json, g_content);
    */
  });
  server.on("/endFrequencyScan", []() {
    webServer.sendCORSHeaders(server);
    if(!webServer.ensureAuth(server, true)) return;
    somfy.transceiver.endFrequencyScan();
    JsonResponse resp;
    resp.beginResponse(&server, g_content, sizeof(g_content));
    resp.beginObject();
    somfy.transceiver.toJSON(resp);
    resp.endObject();
    resp.endResponse();
    /*
    DynamicJsonDocument doc(1024);
    JsonObject obj = doc.to<JsonObject>();
    somfy.transceiver.toJSON(obj);
    serializeJson(doc, g_content);
    server.send(200, _encoding_json, g_content);
    */
  });
  server.on("/rfStats", []() {
    webServer.sendCORSHeaders(server);
    if(!webServer.ensureAuth(server, true)) return;
    JsonResponse resp;
    resp.beginResponse(&server, g_content, sizeof(g_content));
    webServer.emitRfStats(resp);
    resp.endResponse();
  });
  server.on("/clearRfStats", []() {
    webServer.sendCORSHeaders(server);
    if(!webServer.ensureAuth(server, true)) return;
    rfStats.clear();
    server.send(200, "application/json", "{\"status\":\"OK\",\"desc\":\"RF statistics cleared\"}");
  });
  server.on("/restoreRfStats", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) return server.send(200);
    if(!webServer.ensureAuth(server, true)) return;
    // A full 48-entry export is ~8KB of JSON; the document is transient heap.
    DynamicJsonDocument doc(16384);
    if(deserializeJson(doc, server.arg("plain"))) return server.send(400, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Invalid JSON\"}");
    JsonObject obj = doc.as<JsonObject>();
    if(!rfStats.restoreJSON(obj)) return server.send(400, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Invalid stats payload\"}");
    server.send(200, "application/json", "{\"status\":\"OK\",\"desc\":\"RF statistics restored\"}");
  });
  server.on("/setGuidedRssi", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) return server.send(200);
    if(!webServer.ensureAuth(server, true)) return;
    StaticJsonDocument<128> doc;
    if(deserializeJson(doc, server.arg("plain"))) return server.send(400, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Invalid JSON\"}");
    JsonObject obj = doc.as<JsonObject>();
    if(!obj.containsKey("address") || !obj.containsKey("rssi")
      || !rfStats.setGuided(obj["address"], obj["rssi"]))
      return server.send(400, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Invalid address or RSSI\"}");
    server.send(200, "application/json", "{\"status\":\"OK\",\"desc\":\"Guided measurement stored\"}");
  });
}
