#include <WiFi.h>
#include <WebServer.h>
#include <LittleFS.h>
#include "mbedtls/md.h"
#include "ConfigSettings.h"
#include "Utils.h"
#include "Somfy.h"
#include "WResp.h"
#include "Web.h"
#include "Network.h"

// Authentication, CSRF / DNS-rebinding protection, API tokens, login flow and
// language endpoints, split out of Web.cpp.  Declarations stay in Web.h; the
// shared response buffer and MIME strings are defined in Web.cpp (see Web.h).

extern ConfigSettings settings;
extern Web webServer;
extern Network net;

void Web::handleDeserializationError(WebServer &server, DeserializationError &err) {
    switch (err.code()) {
    case DeserializationError::InvalidInput:
      server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Invalid JSON payload\"}"));
      break;
    case DeserializationError::NoMemory:
      server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Out of memory parsing JSON\"}"));
      break;
    default:
      server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"General JSON Deserialization failed\"}"));
      break;
    }
}
bool Web::secureEquals(const char *a, const char *b) {
  if(a == nullptr || b == nullptr) return false;
  size_t la = strlen(a), lb = strlen(b);
  size_t n = la > lb ? la : lb;
  uint8_t diff = static_cast<uint8_t>(la ^ lb);
  for(size_t i = 0; i < n; i++)
    diff |= static_cast<uint8_t>((i < la ? a[i] : 0) ^ (i < lb ? b[i] : 0));
  return diff == 0;
}
bool Web::_loginLocked() {
  if(this->_lockoutUntil == 0) return false;
  if((int32_t)(millis() - this->_lockoutUntil) >= 0) { this->_lockoutUntil = 0; return false; }
  return true;
}
void Web::_loginFailed() {
  if(this->_failedLogins < 255) this->_failedLogins++;
  // Let a few fat-finger attempts through, then back off: 5s, 10s, ... capped at 60s.
  if(this->_failedLogins >= 5) {
    uint32_t backoff = (uint32_t)(this->_failedLogins - 4) * 5000;
    if(backoff > 60000) backoff = 60000;
    this->_lockoutUntil = millis() + backoff;
    if(this->_lockoutUntil == 0) this->_lockoutUntil = 1; // never the "unlocked" sentinel
  }
}
// Pure check: never sends a response.  Upload lambdas call this while the request body is
// still being parsed, so the outer handler (or ensureAuth) owns the 401.
bool Web::isAuthenticated(WebServer &server, bool cfg) {
  if(settings.Security.type == security_types::None) return true;
  else if(!cfg && (settings.Security.permissions & static_cast<uint8_t>(security_permissions::ConfigOnly)) == 0x01) return true;
  else if(server.hasHeader("apikey")) {
    // Api key was supplied.
    char token[65];
    memset(token, 0x00, sizeof(token));
    this->createAPIToken(server.client().remoteIP(), token);
    // Compare the tokens.
    if(!Web::secureEquals(token, server.header("apikey").c_str())) return false;
    server.sendHeader("apikey", token);
    return true;
  }
  Serial.println("Not authenticated...");
  return false;
}
// Auth gate for mutating/config endpoints.  Sends the 401 itself so callers can simply return.
bool Web::ensureAuth(WebServer &server, bool cfg) {
  // Same-origin is enforced before authentication so it also covers Security::None
  // devices, where isAuthenticated() always returns true: the anti-rebinding host
  // check is then the only barrier against a remote site driving these endpoints.
  if(!this->sameOriginOK(server)) return false;
  if(this->isAuthenticated(server, cfg)) return true;
  server.send(401, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Not authenticated\"}"));
  return false;
}
// --- CSRF / DNS-rebinding protection --------------------------------------
// Extract the bare host from a Host/Origin/Referer value, dropping any scheme,
// path and port.  Handles bracketed IPv6 literals ("[::1]:80" -> "::1").
static String csrfExtractHost(String v) {
  v.trim();
  int scheme = v.indexOf("://");
  if(scheme >= 0) v = v.substring(scheme + 3);    // strip "http://" (Origin/Referer)
  int slash = v.indexOf('/');
  if(slash >= 0) v = v.substring(0, slash);        // strip "/path" (Referer)
  if(v.length() && v[0] == '[') {                  // bracketed IPv6 literal
    int close = v.indexOf(']');
    if(close > 0) return v.substring(1, close);
    return v;
  }
  int first = v.indexOf(':');
  int last = v.lastIndexOf(':');
  if(first >= 0 && first == last) v = v.substring(0, first); // single ':' -> host:port
  // Several colons and no brackets means a bare IPv6 literal: keep it verbatim.
  return v;
}
// True when the host is an IP literal (v4 or v6).  DNS-rebinding needs a real
// DNS name, so any literal address (including the 192.168.4.1 recovery AP) is safe.
static bool csrfIsIpLiteral(const String &h) {
  if(h.length() == 0) return false;
  if(h.indexOf(':') >= 0) {                         // candidate IPv6 literal
    for(size_t i = 0; i < h.length(); i++) {
      char c = h.charAt(i);
      if(c != ':' && !isxdigit((int)c)) return false;
    }
    return true;
  }
  IPAddress ip;
  return ip.fromString(h);                           // strict IPv4 parse
}
// True when the host matches the configured device hostname, with or without
// the mDNS ".local" suffix (case-insensitive).
static bool csrfIsConfiguredHost(const String &h) {
  String hn = String(settings.hostname);
  if(hn.length() == 0) return false;
  hn.toLowerCase();
  String lh = h; lh.toLowerCase();
  return lh == hn || lh == hn + ".local";
}
// Pure predicate for the CSRF / DNS-rebinding check; sends nothing so it can be
// called during an upload (UPLOAD_FILE_START) where no response may be emitted yet.
// Home Assistant talks to the dedicated API port (apiServer) with token auth and
// is not browser-driven, so the check is skipped there to avoid breaking it.
bool Web::isSameOrigin(WebServer &server) {
  if(&server == &apiServer) return true;
  String host = csrfExtractHost(server.hostHeader());
  // (a) Anti DNS-rebinding: the Host must be an IP literal or our own hostname.
  //     An absent Host cannot carry a rebinding attack, so it is allowed through.
  if(host.length() != 0 && !csrfIsIpLiteral(host) && !csrfIsConfiguredHost(host)) return false;
  // (b) If the browser sent an Origin or Referer, its host must equal the Host
  //     header; a cross-site page driving this API would carry a foreign origin.
  String src = server.header("Origin");
  if(src.length() == 0) src = server.header("Referer");
  if(src.length() != 0 && host.length() != 0) {
    String srcHost = csrfExtractHost(src);
    srcHost.toLowerCase();
    String lh = host; lh.toLowerCase();
    if(srcHost != lh) return false;
  }
  return true;
}
// Reject cross-site and DNS-rebinding requests on the browser-facing server,
// sending the 403 itself so callers can simply return.
bool Web::sameOriginOK(WebServer &server) {
  if(this->isSameOrigin(server)) return true;
  server.send(403, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Cross-origin or forbidden host\"}"));
  return false;
}
bool Web::createAPIPinToken(const IPAddress ipAddress, const char *pin, char *token) {
  return this->createAPIToken((String(pin) + ":" + ipAddress.toString()).c_str(), token);
}
bool Web::createAPIPasswordToken(const IPAddress ipAddress, const char *username, const char *password, char *token) {
  return this->createAPIToken((String(username) + ":" + String(password) + ":" + ipAddress.toString()).c_str(), token);
}
bool Web::createAPIToken(const char *payload, char *token) {
    byte hmacResult[32];
    mbedtls_md_context_t ctx;
    mbedtls_md_type_t md_type = MBEDTLS_MD_SHA256;
    // md_setup() with hmac=1 heap-allocates the digest and HMAC contexts; they must be
    // released or every token computation leaks.  /login computes one before checking any
    // credential, so an anonymous request loop would otherwise exhaust the heap.
    mbedtls_md_init(&ctx);
    if(mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(md_type), 1) != 0) {
      mbedtls_md_free(&ctx);
      token[0] = '\0';
      return false;
    }
    // Key the HMAC with the private random secret, not the public/weak serverId.
    mbedtls_md_hmac_starts(&ctx, (const unsigned char *)settings.apiSecret, sizeof(settings.apiSecret));
    mbedtls_md_hmac_update(&ctx, (const unsigned char *)payload, strlen(payload)); 
    mbedtls_md_hmac_finish(&ctx, hmacResult);
    mbedtls_md_free(&ctx);
    token[0] = '\0';
    for(int i = 0; i < sizeof(hmacResult); i++){
        char str[3];
        sprintf(str, "%02x", (int)hmacResult[i]);
        strcat(token, str);
    }
    return true;
}
bool Web::createAPIToken(const IPAddress ipAddress, char *token) {
    String payload;
    if(settings.Security.type == security_types::Password) createAPIPasswordToken(ipAddress, settings.Security.username, settings.Security.password, token);
    else if(settings.Security.type == security_types::PinEntry) createAPIPinToken(ipAddress, settings.Security.pin, token);
    else createAPIToken(ipAddress.toString().c_str(), token);
    return true;
}
void Web::handleLang(WebServer &server) {
    webServer.sendCORSHeaders(server);
    if (server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }

    String filename = "/locale/en.json.gz"; // Par défaut en .gz

    // On définit le fichier selon le réglage
    if (settings.language == 0) filename = "/locale/en.json.gz";
    else if (settings.language == 1) filename = "/locale/fr.json.gz";
    else if (settings.language == 2) filename = "/locale/de.json.gz";
    else if (settings.language == 3) filename = "/locale/es.json.gz";

    if (LittleFS.exists(filename)) {
        File file = LittleFS.open(filename, "r");
        
        // --- MÉTHODE D'ENVOI MANUELLE (Identique à handleStreamFile) ---
        server.setContentLength(file.size());
        server.sendHeader("Content-Encoding", "gzip");
        
        // On envoie le Type MIME JSON
        server.send(200, "application/json", ""); 
        
        // Envoi du binaire compressé
        server.client().write(file);
        
        file.close();
    } else {
        Serial.print("Lang file not found: ");
        Serial.println(filename);
        server.send(404, "text/plain", "Lang file not found");
    }
}
void Web::handleSetLang(WebServer &server) {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) {
      server.send(200, "OK");
      return;
    }

    if(!server.hasArg("lang")) {
      server.send(400, _encoding_json, "{\"error\":\"missing lang\"}");
      return;
    }

    String lang = server.arg("lang");
    uint8_t language;
    if(lang == "en") language = 0;
    else if(lang == "fr") language = 1;
    else if(lang == "de") language = 2;
    else if(lang == "es") language = 3;
    else {
      server.send(400, _encoding_json, "{\"error\":\"unsupported lang\"}");
      return;
    }
    // This endpoint is reachable before login, since the language selector sits on the
    // login screen. Only touch NVS when the value actually changes, so repeated calls
    // cannot be used to wear out the flash.
    if(settings.language != language) {
      settings.language = language;
      settings.save();
    }
    server.send(200, _encoding_json, "{\"status\":\"ok\"}");
}
void Web::handleLogout(WebServer &server) {
  Serial.println("Logging out of webserver");
  server.sendHeader("Location", "/");
  server.sendHeader("Cache-Control", "no-cache");
  server.sendHeader("Set-Cookie", "ESPSOMFYID=0");
  server.send(301);
}
void Web::handleLogin(WebServer &server) {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    StaticJsonDocument<256> doc;
    JsonObject obj = doc.to<JsonObject>();
    char token[65];
    memset(&token, 0x00, sizeof(token));
    this->createAPIToken(server.client().remoteIP(), token);
    obj["type"] = static_cast<uint8_t>(settings.Security.type);
    if(settings.Security.type == security_types::None) {
      obj["apiKey"] = token;
      obj["msg"] = "Success";
      obj["success"] = true;
      serializeJson(doc, g_content);
      server.send(200, _encoding_json, g_content);
      return;
    }
    Serial.println("Web logging in...");
    char username[33] = "";
    char password[33] = "";
    char pin[5] = "";
    memset(username, 0x00, sizeof(username));
    memset(password, 0x00, sizeof(password));
    memset(pin, 0x00, sizeof(pin));
    if(server.hasArg("plain")) {
      DynamicJsonDocument docin(512);
      DeserializationError err = deserializeJson(docin, server.arg("plain"));
      if (err) {
        this->handleDeserializationError(server, err);
        return;
      }
      else {
          JsonObject objin = docin.as<JsonObject>();
          if(objin.containsKey("username") && objin["username"]) strlcpy(username, objin["username"], sizeof(username));
          if(objin.containsKey("password") && objin["password"]) strlcpy(password, objin["password"], sizeof(password));
          if(objin.containsKey("pin") && objin["pin"]) strlcpy(pin, objin["pin"], sizeof(pin));
      }
    }
    else {
      if(server.hasArg("username")) strlcpy(username, server.arg("username").c_str(), sizeof(username));
      if(server.hasArg("password")) strlcpy(password, server.arg("password").c_str(), sizeof(password));
      if(server.hasArg("pin")) strlcpy(pin, server.arg("pin").c_str(), sizeof(pin));
    }
    // At this point we should have all the data we need to login.
    if(this->_loginLocked()) {
      obj["success"] = false;
      obj["msg"] = "Too many attempts, try again shortly";
      serializeJson(doc, g_content);
      server.send(429, _encoding_json, g_content);
      return;
    }
    if(settings.Security.type == security_types::PinEntry) {
      Serial.println("Validating pin");
      if(strlen(pin) == 0 || !Web::secureEquals(pin, settings.Security.pin)) {
        this->_loginFailed();
        obj["success"] = false;
        obj["msg"] = "Invalid Pin Entry";
      }
      else {
        this->_failedLogins = 0;
        this->_lockoutUntil = 0;
        obj["success"] = true;
        obj["msg"] = "Login successful";
        obj["apiKey"] = token;
      }
    }
    else if(settings.Security.type == security_types::Password) {
      if(strlen(username) == 0 || strlen(password) == 0
        || !Web::secureEquals(username, settings.Security.username)
        || !Web::secureEquals(password, settings.Security.password)) {
        this->_loginFailed();
        obj["success"] = false;
        obj["msg"] = "Invalid username or password";
      }
      else {
        this->_failedLogins = 0;
        this->_lockoutUntil = 0;
        obj["success"] = true;
        obj["msg"] = "Login successful";
        obj["apiKey"] = token;
      }
    }
    serializeJson(doc, g_content);
    server.send(200, _encoding_json, g_content);
    return;
}

void Web::handleLoginContext(WebServer &server) {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    JsonResponse resp;
    resp.beginResponse(&server, g_content, sizeof(g_content));
    resp.beginObject();
    resp.addElem("type", static_cast<uint8_t>(settings.Security.type));
    resp.addElem("permissions", settings.Security.permissions);
    resp.addElem("serverId", settings.serverId);
    resp.addElem("version", settings.fwVersion.name);
    resp.addElem("model", "ESPSomfyRTS");
    resp.addElem("hostname", settings.hostname);
    if (net.connType == conn_types_t::ethernet) {
      resp.addElem("mac", ETH.macAddress().c_str());
    } else {
      resp.addElem("mac", WiFi.macAddress().c_str());
    }
    resp.addElem("uptime", (uint32_t)(millis() / 1000));
    uint32_t netUptime = 0;
    if(net.connectedAt > 0) {
      netUptime = (millis() - net.connectedAt) / 1000;
    }
    resp.addElem("netUptime", netUptime);
    resp.addElem("cpuFreq", ESP.getCpuFreqMHz());
    resp.addElem("cores", ESP.getChipCores());
    resp.addElem("flashSize", (uint32_t)(ESP.getFlashChipSize() / 1024 / 1024));
    size_t total = LittleFS.totalBytes();
    size_t used = LittleFS.usedBytes();
    resp.addElem("fsTotal", (uint32_t)(total / 1024)); // En Ko
    resp.addElem("fsUsed", (uint32_t)(used / 1024));   // En Ko
    // Size of the inactive OTA app slot: the UI uses it to allow/deny a GitHub
    // update based on the real partition layout instead of the version number
    // (an old small-partition table cannot hold the enlarged-layout images).
    resp.addElem("otaSize", (uint32_t)ESP.getFreeSketchSpace());
    resp.addElem("flashSpeed", (uint32_t)(ESP.getFlashChipSpeed() / 1000000)); // En MHz
    resp.endObject();
    resp.endResponse();
}
