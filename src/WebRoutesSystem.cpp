#include <WiFi.h>
#include <WebServer.h>
#include <LittleFS.h>
#include <Update.h>
#include <esp_task_wdt.h>
#include "ConfigSettings.h"
#include "ConfigFile.h"
#include "Utils.h"
#include "Somfy.h"
#include "WResp.h"
#include "Web.h"
#include "MQTT.h"
#include "GitOTA.h"
#include "Rollback.h"

// Route registrations for firmware/filesystem/backup endpoints, split out of
// Web::begin().  Every upload endpoint lives here, so the shared upload gate
// and caps are file-local statics again.

extern ConfigSettings settings;
extern rebootDelay_t rebootDelay;
extern SomfyShadeController somfy;
extern Web webServer;
extern MQTTClass mqtt;
extern GitUpdater git;

// Set at UPLOAD_FILE_START by the upload lambdas; the server is single-threaded so one
// flag is enough to make every later chunk of an unauthenticated upload a no-op.
static bool g_uploadAuthorized = false;

// Cumulative bytes of the current config upload, reset at UPLOAD_FILE_START. Only one
// upload runs at a time (single-threaded server) so a single counter is sufficient.
static size_t g_uploadBytes = 0;
// Generous caps: shades backups are a few KB. Anything larger is treated as an attempt
// to fill the filesystem and is aborted. Firmware image endpoints are not capped here.
#define RESTORE_MAX_UPLOAD (128 * 1024)
#define SHADECFG_MAX_UPLOAD (64 * 1024)

void Web::beginSystemRoutes() {
  server.on("/getReleases", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    // Gate this behind auth: it triggers a blocking TLS call out to GitHub, so
    // an anonymous client could hang the loop. Passthrough when security is off.
    if(!webServer.ensureAuth(server, false)) return;
    // Refuse while a shade is moving; the blocking GitHub fetch would stall the
    // motion timing loop.
    if(!somfy.allIdle()) {
      server.send(503, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Busy: a shade is moving\"}"));
      return;
    }
    GitRepo repo;
    repo.getReleases();
    git.setCurrentRelease(repo);
    JsonResponse resp;
    resp.beginResponse(&server, g_content, sizeof(g_content));
    resp.beginObject();
    repo.toJSON(resp);
    resp.endObject();
    resp.endResponse();
  });
  server.on("/downloadFirmware", []() { webServer.handleDownloadFirmware(server); });
  server.on("/cancelFirmware", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    // If we are currently downloading the filesystem we cannot cancel.
    if(!git.lockFS) {
      git.status = GIT_UPDATE_CANCELLING;
      JsonResponse resp;
      resp.beginResponse(&server, g_content, sizeof(g_content));
      resp.beginObject();
      git.toJSON(resp);
      resp.endObject();
      resp.endResponse();
      git.cancelled = true;
    }
    else {
      server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Cannot cancel during filesystem update.\"}"));
    }
  });
  server.on("/backup", []() { webServer.handleBackup(server, true); });
  server.on("/restore", HTTP_POST, []() {
    webServer.sendCORSHeaders(server);
    server.sendHeader("Connection", "close");
    if(!webServer.ensureAuth(server, true)) return;
    if(webServer.uploadSuccess) {
      server.send(200, _encoding_json, "{\"status\":\"Success\",\"desc\":\"Restoring Shade settings\"}");
      restore_options_t opts;
      if(server.hasArg("data")) {
        Serial.println(server.arg("data"));
        StaticJsonDocument<256> doc;
        DeserializationError err = deserializeJson(doc, server.arg("data"));
        if (err) {
          webServer.handleDeserializationError(server, err);
          return;
        }
        else {
          JsonObject obj = doc.as<JsonObject>();
          opts.fromJSON(obj);
        }
      }
      else {
        Serial.println("No restore options sent.  Using defaults...");
        opts.shades = true;
      }
      ShadeConfigFile::restore(&somfy, "/shades.tmp", opts);
      Serial.println("Rebooting ESP for restored settings...");
      rebootDelay.reboot = true;
      rebootDelay.rebootTime = millis() + 1000;
    }
    }, []() {
      esp_task_wdt_reset();
      HTTPUpload& upload = server.upload();
      // Headers are already parsed when the upload starts, so auth can be checked here.
      // Refuse to touch the filesystem for unauthenticated uploads; the outer handler sends the 401.
      if (upload.status == UPLOAD_FILE_START) {
        webServer.uploadSuccess = false;
        g_uploadAuthorized = webServer.isSameOrigin(server) && webServer.isAuthenticated(server, true);
        g_uploadBytes = 0;
      }
      if (!g_uploadAuthorized) return;
      if (upload.status == UPLOAD_FILE_START) {
        Serial.printf("Restore: %s\n", upload.filename.c_str());
        // Begin by opening a new temporary file.
        File fup = LittleFS.open("/shades.tmp", "w");
        fup.close();
      }
      else if (upload.status == UPLOAD_FILE_WRITE) {
        // Cap the cumulative size so a large repeated upload cannot fill the filesystem.
        g_uploadBytes += upload.currentSize;
        if (g_uploadBytes > RESTORE_MAX_UPLOAD) {
          webServer.uploadSuccess = false;
          g_uploadAuthorized = false; // make every later chunk (and END) a no-op
          Serial.printf("Restore aborted: upload exceeds %u bytes\n", (unsigned)RESTORE_MAX_UPLOAD);
          return;
        }
        File fup = LittleFS.open("/shades.tmp", "a");
        //upload.buf[upload.currentSize] = 0x00;
        //Serial.print((char *)upload.buf);
        fup.write(upload.buf, upload.currentSize);
        fup.close();
      }
      else if (upload.status == UPLOAD_FILE_END) {
        webServer.uploadSuccess = true;
      }

    });
  server.on("/updateFirmware", HTTP_POST, []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    // An unauthenticated upload wrote nothing to flash; make sure it cannot reboot either.
    if(!webServer.ensureAuth(server, true)) return;
    if (Update.hasError())
      server.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Error updating firmware: \"}");
    else
      server.send(200, _encoding_json, "{\"status\":\"SUCCESS\",\"desc\":\"Successfully updated firmware\"}");
    rebootDelay.reboot = true;
    rebootDelay.rebootTime = millis() + 500;
    }, []() {
      HTTPUpload& upload = server.upload();
      // Headers are already parsed at UPLOAD_FILE_START so auth can be checked before
      // any flash write; unauthenticated chunks are dropped and the outer handler 401s.
      if (upload.status == UPLOAD_FILE_START) {
        webServer.uploadSuccess = false;
        g_uploadAuthorized = webServer.isSameOrigin(server) && webServer.isAuthenticated(server, true);
      }
      if (!g_uploadAuthorized) { esp_task_wdt_reset(); return; }
      if (upload.status == UPLOAD_FILE_START) {
        Serial.printf("Update: %s - %d\n", upload.filename.c_str(), upload.totalSize);
        //if(!Update.begin(upload.totalSize, U_SPIFFS)) {
        if (!Update.begin(UPDATE_SIZE_UNKNOWN)) { //start with max available size
          Update.printError(Serial);
        }
        else {
          somfy.transceiver.end(); // Shut down the radio so we do not get any interrupts during this process.
          mqtt.end();
        }
      }
      else if(upload.status == UPLOAD_FILE_ABORTED) {
        Serial.printf("Upload of %s aborted\n", upload.filename.c_str());
        Update.abort();
      }
      else if (upload.status == UPLOAD_FILE_WRITE) {
        /* flashing firmware to ESP*/
        if (Update.write(upload.buf, upload.currentSize) != upload.currentSize) {
          Update.printError(Serial);
          Serial.printf("Upload of %s aborted invalid size %d\n", upload.filename.c_str(), upload.currentSize);
          Update.abort();
        }
      }
      else if (upload.status == UPLOAD_FILE_END) {
        if (Update.end(true)) { //true to set the size to the current progress
          Serial.printf("Update Success: %u\nRebooting...\n", upload.totalSize);
          webServer.uploadSuccess = true;
          OTARollback::markPending(); // The application partition has been flashed.
        }
        else {
          Update.printError(Serial);
        }
      }
      esp_task_wdt_reset();
    });
  server.on("/updateShadeConfig", HTTP_POST, []() {
    if(git.lockFS) {
      server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Filesystem update in progress\"}"));
      return;
    }
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    server.sendHeader("Connection", "close");
    server.send(200, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Updating Shade Config: \"}");
    }, []() {
      HTTPUpload& upload = server.upload();
      // Check auth before touching the filesystem; the outer handler sends the 401.
      if (upload.status == UPLOAD_FILE_START) {
        g_uploadAuthorized = webServer.isSameOrigin(server) && webServer.isAuthenticated(server, true);
        g_uploadBytes = 0;
      }
      if (!g_uploadAuthorized) return;
      if (upload.status == UPLOAD_FILE_START) {
        Serial.printf("Update: shades.cfg\n");
        File fup = LittleFS.open("/shades.tmp", "w");
        fup.close();
      }
      else if (upload.status == UPLOAD_FILE_WRITE) {
        // A shade config is an ordinary LittleFS file. Update.write() used to be
        // called here as a "does this look valid" probe: it tells us nothing
        // about the content and, whenever an OTA session happened to be open, it
        // pushed the uploaded bytes straight into the flash partition and skipped
        // the file write entirely. Sniff the header instead and only ever append.
        if (g_uploadBytes == 0 && upload.currentSize > 0) {
          // Every config file starts with the header version written by
          // writeUInt8(): three space padded digits then the ',' separator.
          bool looksValid = upload.currentSize >= 4 && upload.buf[3] == ',';
          for (uint8_t i = 0; looksValid && i < 3; i++) {
            char c = (char)upload.buf[i];
            if (c != ' ' && (c < '0' || c > '9')) looksValid = false;
          }
          if (!looksValid) {
            g_uploadAuthorized = false;
            Serial.println("Update aborted: not a shade configuration file");
            LittleFS.remove("/shades.tmp");
            return;
          }
        }
        // Cap the cumulative size so a large repeated upload cannot fill the filesystem.
        g_uploadBytes += upload.currentSize;
        if (g_uploadBytes > SHADECFG_MAX_UPLOAD) {
          g_uploadAuthorized = false; // make every later chunk (and END) a no-op
          Serial.printf("Update aborted: upload exceeds %u bytes\n", (unsigned)SHADECFG_MAX_UPLOAD);
          LittleFS.remove("/shades.tmp");
          return;
        }
        File fup = LittleFS.open("/shades.tmp", "a");
        if (!fup) {
          g_uploadAuthorized = false;
          Serial.println("Update aborted: cannot open /shades.tmp");
          return;
        }
        if (fup.write(upload.buf, upload.currentSize) != upload.currentSize) {
          g_uploadAuthorized = false;
          Serial.println("Update aborted: write error on /shades.tmp");
        }
        fup.close();
      }
      else if (upload.status == UPLOAD_FILE_ABORTED) {
        g_uploadAuthorized = false;
        LittleFS.remove("/shades.tmp");
      }
      else if (upload.status == UPLOAD_FILE_END) {
        if (g_uploadBytes == 0) {
          Serial.println("Update aborted: empty shade configuration upload");
          LittleFS.remove("/shades.tmp");
          return;
        }
        // loadShadesFile() runs validate() first, so a truncated or forged file
        // is rejected before any of it reaches the shade/room/group arrays.
        if (!somfy.loadShadesFile("/shades.tmp"))
          Serial.println("Shade configuration upload rejected as invalid");
      }
    });
  server.on("/updateApplication", HTTP_POST, []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    // An unauthenticated upload wrote nothing to flash; make sure it cannot reboot either.
    if(!webServer.ensureAuth(server, true)) return;
    server.sendHeader("Connection", "close");
    if (Update.hasError())
      server.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Error updating application: \"}");
    else
      server.send(200, _encoding_json, "{\"status\":\"SUCCESS\",\"desc\":\"Successfully updated application\"}");
    rebootDelay.reboot = true;
    rebootDelay.rebootTime = millis() + 500;
    }, []() {
      HTTPUpload& upload = server.upload();
      // Check auth before any flash write; unauthenticated chunks are dropped.
      if (upload.status == UPLOAD_FILE_START) {
        webServer.uploadSuccess = false;
        g_uploadAuthorized = webServer.isSameOrigin(server) && webServer.isAuthenticated(server, true);
      }
      if (!g_uploadAuthorized) { esp_task_wdt_reset(); return; }
      if (upload.status == UPLOAD_FILE_START) {
        Serial.printf("Update: %s %d\n", upload.filename.c_str(), upload.totalSize);
        //if(!Update.begin(upload.totalSize, U_SPIFFS)) {
        if (!Update.begin(UPDATE_SIZE_UNKNOWN, U_SPIFFS)) { //start with max available size and tell it we are updating the file system.
          Update.printError(Serial);
        }
        else {
          somfy.transceiver.end(); // Shut down the radio so we do not get any interrupts during this process.
          mqtt.end();
        }
      }
      else if(upload.status == UPLOAD_FILE_ABORTED) {
        Serial.printf("Upload of %s aborted\n", upload.filename.c_str());
        Update.abort();
        somfy.commit();
      }
      else if (upload.status == UPLOAD_FILE_WRITE) {
        /* flashing littlefs to ESP*/
        if (Update.write(upload.buf, upload.currentSize) != upload.currentSize) {
          Update.printError(Serial);
          Serial.printf("Upload of %s aborted invalid size %d\n", upload.filename.c_str(), upload.currentSize);
          Update.abort();
        }
      }
      else if (upload.status == UPLOAD_FILE_END) {
        if (Update.end(true)) { //true to set the size to the current progress
          webServer.uploadSuccess = true;
          Serial.printf("Update Success: %u\nRebooting...\n", upload.totalSize);
          somfy.commit();
        }
        else {
          somfy.commit();
          Update.printError(Serial);
        }
      }
      esp_task_wdt_reset();
    });
  server.on("/reboot", []() { webServer.handleReboot(server);});
  server.on("/recoverFilesystem", [] () {
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    webServer.sendCORSHeaders(server);
    if(!webServer.ensureAuth(server, true)) return;
    if(git.status == GIT_UPDATING)
      server.send(200, "application/json", "{\"status\":\"OK\",\"desc\":\"Filesystem is updating.  Please wait!!!\"}");
    else if(git.status != GIT_STATUS_READY)
      server.send(200, "application/json", "{\"status\":\"ERROR\",\"desc\":\"Cannot recover file system at this time.\"}");
    else {
      git.recoverFilesystem();
      server.send(200, "application/json", "{\"status\":\"OK\",\"desc\":\"Recovering filesystem from github please wait!!!\"}");
    }
  });
}
