#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Update.h>
#include <HTTPClient.h>
#include <esp_task_wdt.h>
#include <esp_ota_ops.h>
#include <Preferences.h>
#include <time.h>
#include "ConfigSettings.h"
#include "GitOTA.h"
#include "GitCerts.h"
#include "Rollback.h"
#include "SomfyLock.h"
#include "Utils.h"
#include "Sockets.h"
#include "Somfy.h"
#include "Web.h"
#include "WResp.h"
#include "Network.h"


extern ConfigSettings settings;
extern SocketEmitter sockEmit;
extern SomfyShadeController somfy;
extern rebootDelay_t rebootDelay;
extern Web webServer;
extern Network net;

// Certificate validation requires a correct clock: before NTP sync the ESP32
// starts in 1970 and every legitimate TLS handshake would wrongly fail.
static bool _clockIsSet() { return time(nullptr) > 1750000000; } // 2025-06-15

// One TCP segment.
#define MAX_BUFF_SIZE 1460
void GitRelease::setReleaseProperty(const char *key, const char *val) {
  if(strcmp(key, "id") == 0) this->id = atol(val);
  else if(strcmp(key, "draft") == 0) this->draft = toBoolean(val, false);
  else if(strcmp(key, "prerelease") == 0) this->preRelease = toBoolean(val, false);
  else if(strcmp(key, "name") == 0) strlcpy(this->name, val, sizeof(this->name));
  else if(strcmp(key, "tag_name") == 0) {
    this->version.parse(val);
  }
  else if(strcmp(key, "published_at") == 0) {
    //Serial.printf("Key:[%s] Value:[%s]\n", key, val);
    this->releaseDate = Timestamp::parseUTCTime(val);
  }
}
void GitRelease::setAssetProperty(const char *key, const char *val) {
  if(strcmp(key, "name") == 0) {
    if(strstr(val, "littlefs.bin")) this->hasFS = true;
    else if(strstr(val, "ino.esp32.bin")) {
      if(strlen(this->hwVersions)) strcat(this->hwVersions, ",");
      strcat(this->hwVersions, "32");
    }
    else if(strstr(val, "ino.esp32wrover.bin")) {
      if(strlen(this->hwVersions)) strcat(this->hwVersions, ",");
      strcat(this->hwVersions, "wrover");
    }
    else if(strstr(val, "ino.esp32s3_4mb.bin")) {
      if(strlen(this->hwVersions)) strcat(this->hwVersions, ",");
      strcat(this->hwVersions, "s3_4mb");
    }
    else if(strstr(val, "ino.esp32s3_8mb.bin")) {
      if(strlen(this->hwVersions)) strcat(this->hwVersions, ",");
      strcat(this->hwVersions, "s3_8mb");
    }
    else if(strstr(val, "ino.esp32s2.bin")) {
      if(strlen(this->hwVersions)) strcat(this->hwVersions, ",");
      strcat(this->hwVersions, "s2");
    }
    else if(strstr(val, "ino.esp32c3.bin")) {
      if(strlen(this->hwVersions)) strcat(this->hwVersions, ",");
      strcat(this->hwVersions, "c3");
    }
    else if(strstr(val, "ino.esp32c2.bin")) {
      if(strlen(this->hwVersions)) strcat(this->hwVersions, ",");
      strcat(this->hwVersions, "c2");
    }
    else if(strstr(val, "ino.esp32c6.bin")) {
      if(strlen(this->hwVersions)) strcat(this->hwVersions, ",");
      strcat(this->hwVersions, "c6");
    }
    else if(strstr(val, "ino.esp32h2.bin")) {
      if(strlen(this->hwVersions)) strcat(this->hwVersions, ",");
      strcat(this->hwVersions, "h2");
    }
  }
}
void GitRelease::toJSON(JsonResponse &json) {
  Timestamp ts;
  char buff[21];  // uint64_t is up to 20 digits + NUL
  sprintf(buff, "%llu", this->id);
  json.addElem("id", buff);
  json.addElem("name", this->name);
  json.addElem("date", ts.getISOTime(this->releaseDate));
  json.addElem("draft", this->draft);
  json.addElem("preRelease", this->preRelease);
  json.addElem("main", this->main);
  json.addElem("hasFS", this->hasFS);
  json.addElem("hwVersions", this->hwVersions);
  json.beginObject("version");
  this->version.toJSON(json);
  json.endObject();
}
#define ERR_CLIENT_OFFSET -50

int16_t GitRepo::getReleases(uint8_t num) {
  if(!_clockIsSet()) return ERR_CLIENT_OFFSET;
  this->tlsError = 0;
  this->heapBefore = ESP.getMaxAllocHeap();
  WiFiClientSecure sclient;
  sclient.setCACert(githubTlsRoots());
  sclient.setHandshakeTimeout(10); // Chain verification makes the handshake longer.
  uint8_t ndx = 0;
  uint8_t count = min((uint8_t)GIT_MAX_RELEASES, num);
  char url[128];
  memset(this->releases, 0x00, sizeof(GitRelease) * GIT_MAX_RELEASES);
  sprintf(url, "https://api.github.com/repos/" GIT_REPO_PATH "/releases?per_page=%d&page=1", count);
  HTTPClient https;
  https.setReuse(false);
  // The body below is parsed straight off the socket: HTTP/1.0 keeps the server
  // from answering with chunked transfer encoding, whose size lines would land
  // in the JSON.
  https.useHTTP10(true);
  bool listDone = false; // Root array closed, or every requested release read.
  if(https.begin(sclient, url)) {
    esp_task_wdt_reset();
    int httpCode = https.GET();
    Serial.printf("[HTTPS] GET... code: %d\n", httpCode);
    if(httpCode > 0) {
      int len = https.getSize();
      Serial.printf("[HTTPS] GET... code: %d - %d\n", httpCode, len);
      if (httpCode == HTTP_CODE_OK || httpCode == HTTP_CODE_MOVED_PERMANENTLY) {
        WiFiClient *stream = https.getStreamPtr();
        uint8_t buff[128] = {0};
        char jsonElem[32] = "";
        char jsonValue[128] = "";
        int arrTok = 0;
        int objTok = 0;
        bool inQuote = false;
        bool escaped = false;
        bool inElem = false;
        bool inValue = false;
        bool awaitValue = false;
        bool inAss = false;
        uint32_t lastData = millis();
        while(https.connected() && (len > 0 || len == -1) && ndx < count && !listDone) {
          size_t size = stream->available();
          if(!size) {
            // Nothing arrived: this loop used to spin without feeding the watchdog,
            // so a stream stalled for 15s (WiFi out of receive buffers) rebooted
            // the device. Feed it, yield, and give up after 20s.
            esp_task_wdt_reset();
            if((uint32_t)(millis() - lastData) >= 20000) {
              Serial.println("GitHub release list stalled");
              https.end();
              sclient.stop();
              return -46;
            }
            delay(5);
            continue;
          }
          lastData = millis();
          if(size) {
            esp_task_wdt_reset();
            int c = stream->readBytes(buff, ((size > sizeof(buff)) ? sizeof(buff) : size));
            //Serial.write(buff, c);
            if(len > 0) len -= c;
            // Now we should have some data.
            for(uint8_t i = 0; i < c; i++) {
              // Read the buffer a byte at a time until we have a key value pair.
              char ch = static_cast<char>(buff[i]);
              // Brackets and braces are structure only outside a string. A release title
              // or body containing a markdown link, a brace or a quote would otherwise
              // desynchronise the counters and silently corrupt every parsed release.
              bool wasEscaped = escaped;
              escaped = inQuote && !escaped && ch == '\\';
              if(!inQuote && ch == '[') {
                arrTok++;
                if(arrTok == 2 && strcmp(jsonElem, "assets") == 0) {
                  inElem = inValue = awaitValue = false;
                  inAss = true;
                  //Serial.printf("%s: %d\n", jsonElem, arrTok);
                }
                else if(arrTok < 2) inAss = false;
              }
              else if(!inQuote && ch == ']') {
                arrTok--;
                if(arrTok < 2) inAss = false;
                if(arrTok == 0) { listDone = true; break; } // Fewer releases than requested.
              }
              else if(!inQuote && ch == '{') {
                objTok++;
                if(objTok != 1 && !inAss) inElem = inValue = awaitValue = false;
              }
              else if(!inQuote && ch == '}') {
                objTok--;
                if(objTok == 0 && ++ndx >= count) { listDone = true; break; }
              }
              else if(objTok == 1 || inAss) {
                // We only want data from the root object.
                //if(inAss) Serial.print(ch);
                if(ch == '\"' && !wasEscaped) {
                  inQuote = !inQuote;
                  if(inElem) {
                    inElem = false;
                    awaitValue = true;
                  }
                  else if(inValue) {
                    inValue = false;
                    inElem = false;
                    awaitValue = false;
                    if(inAss)
                      this->releases[ndx].setAssetProperty(jsonElem, jsonValue);
                    else
                      this->releases[ndx].setReleaseProperty(jsonElem, jsonValue);
                    memset(jsonElem, 0x00, sizeof(jsonElem));
                    memset(jsonValue, 0x00, sizeof(jsonValue));
                  }
                  else if(awaitValue) inValue = true;
                  else {
                    inElem = true;
                    awaitValue = false;
                  }
                }
                else if(awaitValue) {
                  if(ch != ' ' && ch != ':') {
                    strncat(jsonValue, &ch, 1);
                    awaitValue = false;
                    inValue = true;
                  }
                }
                else if((!inQuote && ch == ',') || ch == '\r' || ch == '\n') {
                  inElem = inValue = awaitValue = false;
                  if(strlen(jsonElem) > 0) {
                    if(inAss)
                      this->releases[ndx].setAssetProperty(jsonElem, jsonValue);
                    else
                      this->releases[ndx].setReleaseProperty(jsonElem, jsonValue);
                  }
                  memset(jsonElem, 0x00, sizeof(jsonElem));
                  memset(jsonValue, 0x00, sizeof(jsonValue));
                }
                else {
                  if(inElem) {
                    if(strlen(jsonElem) < sizeof(jsonElem) - 1) strncat(jsonElem, &ch, 1);
                  }
                  else if(inValue) {
                    if(strlen(jsonValue) < sizeof(jsonValue) - 1) strncat(jsonValue, &ch, 1);
                  }
                }
              }
            }
            delay(1);
          }
          //else break;
        }
      }
      else {
        https.end();
        sclient.stop();
        return httpCode;
      }
    }
    else {
      // No HTTP answer at all (DNS, TLS or connection failure). This used to fall
      // through to the success return with an empty list, which hid the failure.
      char tlsMsg[64];
      this->tlsError = sclient.lastError(tlsMsg, sizeof(tlsMsg));
      Serial.printf("GitHub request failed: %d, TLS %d (%s), largest block %u\n", httpCode, this->tlsError, tlsMsg, this->heapBefore);
      https.end();
      sclient.stop();
      return httpCode < 0 ? httpCode : -1;
    }
    https.end();
    sclient.stop();
  }
  else return -1;
  settings.printAvailHeap();
  // The connection can close before the list ends: report it instead of
  // passing a partial or empty list off as a successful check.
  if(!listDone) {
    Serial.printf("GitHub release list incomplete: %u of %u read\n", ndx, count);
    return -47;
  }
  return 0;
}
void GitRepo::toJSON(JsonResponse &json) {
  json.beginObject("fwVersion");
  settings.fwVersion.toJSON(json);
  json.endObject();
  json.beginObject("appVersion");
  settings.appVersion.toJSON(json);
  json.endObject();
  json.beginArray("releases");
  for(uint8_t i = 0; i < GIT_MAX_RELEASES; i++) {
    if(this->releases[i].id == 0) continue;
    json.beginObject();
    this->releases[i].toJSON(json);
    json.endObject();
  }
  json.endArray();
}
#define UPDATE_ERR_OFFSET 20
#define ERR_DOWNLOAD_HTTP -40
#define ERR_DOWNLOAD_BUFFER -41
#define ERR_DOWNLOAD_CONNECTION -42

void GitUpdater::loop() {
  if(this->fetchRequested) {
    this->fetchResult = net.connected() ? this->fetched.getReleases() : -1;
    // A connection that does not open (DNS or TCP, no HTTP answer) is often a
    // passing hiccup: one more try before reporting it.
    if(this->fetchResult == -1 && net.connected()) {
      esp_task_wdt_reset();
      delay(1000);
      this->fetchResult = this->fetched.getReleases();
    }
    this->fetchRequested = false;
    this->fetchDone = true;
  }
  if(!net.connected()) return;
  if(this->status == GIT_STATUS_READY) {
    // Subtractive comparisons so the one-minute grace and the daily cadence stay correct
    // across the millis() rollover (the old `t + interval < millis()` form broke at wrap).
    if(settings.checkForUpdate &&
      // Five minutes after connection: the old one-minute grace landed exactly in the
      // post-boot login rush, and the blocking TLS handshake (seconds) froze the very
      // first pages the user opened.
      ((uint32_t)(millis() - net.connectTime) >= 300000) &&
      (this->lastCheck == 0 || (uint32_t)(millis() - this->lastCheck) >= 86400000) && !rebootDelay.reboot && // 1 day
      // Same reason: stay away while someone is actively using the web UI.
      ((uint32_t)(millis() - webServer.lastActivity) >= 15000) &&
      somfy.allIdle()) { // The check does a blocking TLS handshake (seconds); running it while
                         // a shade travels would delay its STOP and overshoot. Retry next loop.
        this->checkForUpdate();
      }
  }
  else if(this->status == GIT_AWAITING_UPDATE) {
    // Downloaded after a reboot, before the services start: see bootUpdatePending().
    this->status = GIT_UPDATING;
    this->emitUpdateCheck();
    this->scheduleBootUpdate(this->targetRelease);
  }
  else if(this->status == GIT_UPDATE_CANCELLING) {
    Serial.println("Cancelling update process....");
    if(!this->lockFS) {
      this->status = GIT_UPDATE_CANCELLED;
      this->cancelled = true;
      this->emitUpdateCheck();
    }
  }
}
#define BOOT_UPDATE_NS "fw_boot"
#define BOOT_UPDATE_TRIES 3        // boots spent on one requested version
#define BOOT_UPDATE_WAIT 90000UL   // network and clock, per boot
void GitUpdater::scheduleBootUpdate(const char *version, bool fsOnly) {
  Preferences p;
  p.begin(BOOT_UPDATE_NS, false);
  p.putString("ver", version);
  p.putBool("fs", fsOnly);
  p.putUChar("tries", 0);
  p.end();
  Serial.printf("Update to %s scheduled for the next boot\n", version);
  rebootDelay.reboot = true;
  rebootDelay.rebootTime = millis() + 1000; // lets the HTTP answer go out
}
void GitUpdater::cancelBootUpdate() {
  Preferences p;
  p.begin(BOOT_UPDATE_NS, false);
  p.clear();
  p.end();
}
bool GitUpdater::bootUpdatePending() {
  Preferences p;
  if(!p.begin(BOOT_UPDATE_NS, true)) return false; // namespace never written
  String ver = p.getString("ver", "");
  uint8_t tries = p.getUChar("tries", 0);
  this->bootFsOnly = p.getBool("fs", false);
  p.end();
  if(ver.length() == 0) return false;
  if(tries >= BOOT_UPDATE_TRIES) {
    Serial.printf("Update to %s failed %u times: giving up\n", ver.c_str(), tries);
    this->cancelBootUpdate();
    return false;
  }
  // Counted before trying: a crash during the download must not loop forever.
  p.begin(BOOT_UPDATE_NS, false);
  p.putUChar("tries", tries + 1);
  p.end();
  strlcpy(this->targetRelease, ver.c_str(), sizeof(this->targetRelease));
  this->bootUpdateMode = true;
  this->bootUpdateStart = millis();
  Serial.printf("Boot update to %s, attempt %u/%u\n", this->targetRelease, tries + 1, BOOT_UPDATE_TRIES);
  return true;
}
void GitUpdater::runBootUpdate() {
  // Wait for the network and for NTP: the TLS validation needs the time.
  if(!net.connected() || !_clockIsSet()) {
    if((uint32_t)(millis() - this->bootUpdateStart) >= BOOT_UPDATE_WAIT) {
      Serial.println("Boot update: no network or no clock, rebooting");
      rebootDelay.reboot = true;
      rebootDelay.rebootTime = millis() + 100;
    }
    return;
  }
  this->status = GIT_UPDATING;
  if(this->bootFsOnly) this->recoverFilesystem();
  else this->beginUpdate(this->targetRelease);
  // Success: beginUpdate() armed the reboot into the new firmware. Failure: the
  // next boot tries again until BOOT_UPDATE_TRIES, then boots normally.
  if(this->error == 0) this->cancelBootUpdate();
  rebootDelay.reboot = true;
  if(!rebootDelay.rebootTime || (int32_t)(rebootDelay.rebootTime - millis()) > 1000) rebootDelay.rebootTime = millis() + 500;
  this->bootUpdateMode = false;
}
void GitUpdater::checkForUpdate() {
  if(this->status != 0) return; // If we are already checking.
  Serial.println("Check github for updates...");

  this->status = GIT_STATUS_CHECK;
  settings.printAvailHeap();
  this->lastCheck = millis();
  if(this->checkInternet() == 0) {
    GitRepo repo;
    this->updateAvailable = false;
    // Enough releases to reach the latest stable one behind a run of pre-releases.
    this->error = repo.getReleases(GIT_MAX_RELEASES);
    if(this->error == 0) {
      this->setCurrentRelease(repo);
    }
    else {
      this->emitUpdateCheck();
    }
  }
  else this->error = -1;
  // A failed check retries in an hour instead of waiting a whole day.
  if(this->error != 0) this->lastCheck = millis() - 86400000UL + 3600000UL;
  this->status = GIT_STATUS_READY;
}
// The HTTPS request to GitHub fails when it is made from an async web server handler,
// and the update dialog then received an empty list with nothing to install. The
// handler hands the request to loop(), the task that already runs the daily check and
// the download, and waits for it. The list is kept in `fetched`, owned here, so a
// handler that gives up never leaves loop() writing into freed memory.
int16_t GitUpdater::fetchReleases(uint32_t timeoutMs) {
  if(this->fetchRequested) return -1; // Another request is already waiting for loop().
  this->fetchDone = false;
  this->fetchRequested = true;
  const uint32_t start = millis();
  while(!this->fetchDone) {
    if((uint32_t)(millis() - start) >= timeoutMs) return -1;
    esp_task_wdt_reset(); // The calling task may be watched: a TLS handshake takes seconds.
    vTaskDelay(pdMS_TO_TICKS(50));
  }
  return this->fetchResult;
}
void GitUpdater::setCurrentRelease(GitRepo &repo) {
  this->updateAvailable = false;
  // A board already running a pre-release follows the pre-releases too; a board on a
  // stable release is only offered stable ones. GitHub lists the newest first, so the
  // first eligible release is the one to compare against.
  const bool onPreRelease = settings.fwVersion.suffix[0] != '\0';
  for(uint8_t i = 0; i < GIT_MAX_RELEASES; i++) {
    if(repo.releases[i].draft || repo.releases[i].id == 0) continue;
    if(repo.releases[i].preRelease && !onPreRelease) continue;
    // Compare the versions.
    this->latest.copy(repo.releases[i].version);
    if(repo.releases[i].version.compare(settings.fwVersion) > 0) {
      // We have a new release.
      this->updateAvailable = true;
    }
    break;
  }
  this->emitUpdateCheck();
}
void GitUpdater::toJSON(JsonResponse &json) {
  json.addElem("available", this->updateAvailable);
  json.addElem("status", this->status);
  json.addElem("error", (int32_t)this->error);
  json.addElem("cancelled", this->cancelled);
  json.addElem("checkForUpdate", settings.checkForUpdate);
  json.addElem("inetAvailable", this->inetAvailable);
  json.beginObject("fwVersion");
  settings.fwVersion.toJSON(json);
  json.endObject();
  json.beginObject("appVersion");
  settings.appVersion.toJSON(json);
  json.endObject();
  json.beginObject("latest");
  this->latest.toJSON(json);
  json.endObject();
}
void GitUpdater::emitUpdateCheck(uint8_t num) {
  SomfyGuard guard; // shared emit buffer and socket server
  JsonSockEvent *json = sockEmit.beginEmit("fwStatus");
  json->beginObject();
  json->addElem("available", this->updateAvailable);
  json->addElem("status", this->status);
  json->addElem("error", (int32_t)this->error);
  json->addElem("cancelled", this->cancelled);
  json->addElem("checkForUpdate", settings.checkForUpdate);
  json->addElem("inetAvailable", this->inetAvailable);
  json->beginObject("fwVersion");
  settings.fwVersion.toJSON(json);
  json->endObject();
  json->beginObject("appVersion");
  settings.appVersion.toJSON(json);
  json->endObject();
  json->beginObject("latest");
  this->latest.toJSON(json);
  json->endObject();
  json->endObject();
  sockEmit.endEmit(num);
}
int GitUpdater::checkInternet() {
  int err = 500;
  uint32_t t = millis();
  if(!_clockIsSet()) {
    Serial.println("Update check skipped: clock not synced yet (TLS validation needs the time)");
    this->inetAvailable = false;
    return err;
  }
  WiFiClientSecure sclient;
  sclient.setCACert(githubTlsRoots());
  sclient.setHandshakeTimeout(10); // Chain verification makes the handshake longer.
  esp_task_wdt_reset();
  HTTPClient https;
  https.setReuse(false);
  if(https.begin(sclient, "https://github.com/" GIT_REPO_PATH)) {
    https.setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS);
    https.setTimeout(3000);
    esp_task_wdt_reset();
    int httpCode = https.sendRequest("HEAD");
    esp_task_wdt_reset();
    if (httpCode == HTTP_CODE_OK || httpCode == HTTP_CODE_MOVED_PERMANENTLY || httpCode == HTTP_CODE_FOUND) {
      err = 0;
      Serial.printf("Internet is Available: %ldms\n", millis() - t);
      this->inetAvailable = true;
    }
    else {
      err = httpCode;
      Serial.printf("Internet is Unavailable: %d: %ldms\n", err, millis() - t);
      this->inetAvailable = false;
    }
    https.end();
    sclient.stop();
  }
  esp_task_wdt_reset();
  return err;
}
void GitUpdater::emitDownloadProgress(size_t total, size_t loaded, const char *evt) { this->emitDownloadProgress(255, total, loaded, evt); }
void GitUpdater::emitDownloadProgress(uint8_t num, size_t total, size_t loaded, const char *evt) {
  SomfyGuard guard; // shared emit buffer and socket server
  JsonSockEvent *json = sockEmit.beginEmit(evt);
  json->beginObject();
  json->addElem("ver", this->targetRelease);
  json->addElem("part", (int32_t)this->partition);
  json->addElem("file", this->currentFile);
  json->addElem("total", (uint32_t)total);
  json->addElem("loaded", (uint32_t)loaded);
  json->addElem("error", (uint32_t)this->error);
  json->endObject();
  sockEmit.endEmit(num);
  /*
   * char buf[420];
   * snprintf(buf, sizeof(buf), "{\"ver\":\"%s\",\"part\":%d,\"file\":\"%s\",\"total\":%d,\"loaded\":%d, \"error\":%d}", this->targetRelease, this->partition, this->currentFile, total, loaded, this->error);
   * if(num >= 255) sockEmit.sendToClients(evt, buf);
   * else sockEmit.sendToClient(num, evt, buf);
   */
  sockEmit.loop();
  webServer.loop();
}
void GitUpdater::setFirmwareFile() {
  esp_chip_info_t ci;
  esp_chip_info(&ci);

  switch(ci.model) {
    case esp_chip_model_t::CHIP_ESP32S3: {
      uint32_t flash_size = spi_flash_get_chip_size();

      if (flash_size >= 8 * 1024 * 1024) {
        strlcpy(this->currentFile, "SomfyController.ino.esp32s3_8mb.bin", sizeof(this->currentFile));
      } else {
        strlcpy(this->currentFile, "SomfyController.ino.esp32s3_4mb.bin", sizeof(this->currentFile));
      }
      break;
    }
    case esp_chip_model_t::CHIP_ESP32S2:
      strlcpy(this->currentFile, "SomfyController.ino.esp32s2.bin", sizeof(this->currentFile));
      break;
    case esp_chip_model_t::CHIP_ESP32C3:
      strlcpy(this->currentFile, "SomfyController.ino.esp32c3.bin", sizeof(this->currentFile));
      break;
    case esp_chip_model_t::CHIP_ESP32:
      if (psramFound()) {
        strlcpy(this->currentFile, "SomfyController.ino.esp32wrover.bin", sizeof(this->currentFile));
      } else {
        strlcpy(this->currentFile, "SomfyController.ino.esp32.bin", sizeof(this->currentFile));
      }
      break;
    default:
      strlcpy(this->currentFile, "SomfyController.ino.esp32.bin", sizeof(this->currentFile));
      break;
  }
}
bool GitUpdater::beginUpdate(const char *version) {
  Serial.println("Begin update called...");
  sprintf(this->baseUrl, "https://github.com/" GIT_REPO_PATH "/releases/download/%s/", version);

  strcpy(this->targetRelease, version);
  this->emitUpdateCheck();
  this->setFirmwareFile();
  this->partition = U_FLASH;
  this->lockFS = this->cancelled = false;
  this->error = 0;
  this->error = this->downloadFile();

  if(this->error == 0 && !this->cancelled) {
    somfy.commit();

    strcpy(this->currentFile, "SomfyController.littlefs.bin");
    this->partition = U_SPIFFS;
    this->lockFS = true;
    this->error = this->downloadFile();
    this->lockFS = false;

    if(this->error == 0) {
      settings.fwVersion.parse(version);
      delay(100);
      Serial.println("Committing Configuration...");
      somfy.commitAfterFsFlash();
      OTARollback::markPending(); // The application partition has been flashed.
      rebootDelay.reboot = true;
      rebootDelay.rebootTime = millis() + 500;
    }
    else {
      // The filesystem partition is partly rewritten. Save the shades (into a
      // fresh filesystem if need be) and stay on the running firmware, whose
      // page is still open in the browser, so the update can simply be
      // retried: rebooting would start the new firmware with no web UI.
      Serial.println("Filesystem update failed: keeping the running firmware");
      somfy.commitAfterFsFlash();
      const esp_partition_t *running = esp_ota_get_running_partition();
      if(running) esp_ota_set_boot_partition(running);
    }
  }

  this->status = GIT_UPDATE_COMPLETE;
  this->emitUpdateCheck();
  return true;
}
bool GitUpdater::recoverFilesystem() {
  sprintf(this->baseUrl, "https://github.com/" GIT_REPO_PATH "/releases/download/%s/", settings.fwVersion.name);
  strcpy(this->currentFile, "SomfyController.littlefs.bin");
  this->status = GIT_UPDATING;
  this->partition = U_SPIFFS;
  this->lockFS = true;
  this->error = this->downloadFile();
  this->lockFS = false;
  delay(100);
  Serial.println("Committing Configuration...");
  // Into the recovered image, or into a fresh filesystem when it failed.
  somfy.commitAfterFsFlash();
  this->status = GIT_UPDATE_COMPLETE;
  // Runs as a boot update (scheduleBootUpdate with fsOnly). A failure leaves the
  // reboot to runBootUpdate, which tries again on the next boots.
  if(this->error == 0) {
    rebootDelay.reboot = true;
    rebootDelay.rebootTime = millis() + 500;
  }
  return true;
}
bool GitUpdater::endUpdate() { return true; }
int8_t GitUpdater::downloadFile() {
  Serial.printf("Begin update %s\n", this->currentFile);
  if(!_clockIsSet()) return -44;
  WiFiClientSecure sclient;
  sclient.setCACert(githubTlsRoots());
  sclient.setHandshakeTimeout(10); // Chain verification makes the handshake longer.
  HTTPClient https;
  char url[196];
  sprintf(url, "%s%s", this->baseUrl, this->currentFile);
  Serial.println(url);
  esp_task_wdt_reset();
  if(https.begin(sclient, url)) {
    https.setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS);
    Serial.print("[HTTPS] GET...\n");
    int httpCode = https.GET();
    if(httpCode > 0) {
      size_t len = https.getSize();
      size_t total = 0;
      uint8_t pct = 0;
      int8_t endError = 0;
      Serial.printf("[HTTPS] GET... code: %d - %d\n", httpCode, len);
      if (httpCode == HTTP_CODE_OK || httpCode == HTTP_CODE_MOVED_PERMANENTLY || httpCode == HTTP_CODE_FOUND) {
        WiFiClient *stream = https.getStreamPtr();
        // Reject a firmware image that would not fit the target OTA partition
        // before writing a single byte. A too-large or spoofed Content-Length
        // would otherwise be caught only mid-flash, after clobbering the slot.
        if(this->partition == U_FLASH && len != (size_t)-1) {
          const esp_partition_t *next = esp_ota_get_next_update_partition(NULL);
          if(next && len > next->size) {
            Serial.printf("Firmware image (%u bytes) exceeds OTA partition (%u bytes); aborting.\n",
                          (unsigned)len, (unsigned)next->size);
            https.end();
            sclient.stop();
            return -45;
          }
        }
        if(!Update.begin(len, this->partition)) {
          Serial.println("Update Error detected!!!!!");
          Update.printError(Serial);
          https.end();
          return -(Update.getError() + UPDATE_ERR_OFFSET);
        }
        // Static buffer: a malloc/free per downloaded file fragmented the heap
        // over successive OTA updates, alongside the TLS session allocations.
        static uint8_t buff[MAX_BUFF_SIZE];
        {
          this->emitDownloadProgress(len, total);
          int timeouts = 0;
          while(https.connected() && (len > 0 || len == -1) && total < len) {
            size_t size = stream->available();
            esp_task_wdt_reset();
            if(size) {
              timeouts = 0;
              if(this->cancelled && !this->lockFS) {
                Update.abort();
                https.end();
                return -(Update.getError() + UPDATE_ERR_OFFSET);
              }
              int c = stream->readBytes(buff, ((size > MAX_BUFF_SIZE) ? MAX_BUFF_SIZE : size));
              total += c;
              //Serial.println(total);
              if (Update.write(buff, c) != c) {
                Update.printError(Serial);
                Serial.printf("Upload of %s aborted invalid size %d\n", url, c);
                Update.abort(); // left open, the session refused every later update until a reboot
                https.end();
                sclient.stop();
                return -(Update.getError() + UPDATE_ERR_OFFSET);
              }
              // Calculate the percentage.
              uint8_t p = (uint8_t)floor(((float)total / (float)len) * 100.0f);
              if(p != pct) {
                pct = p;
                Serial.printf("LEN:%d TOTAL:%d %d%%\n", len, total, pct);
                this->emitDownloadProgress(len, total);
              }
              delay(1);
              if(total >= len) {
                if(!Update.end(true)) {
                  Serial.println("Error downloading update...");
                  Update.printError(Serial);
                  // Reported as success before: the caller then recorded the version and rebooted.
                  endError = -(Update.getError() + UPDATE_ERR_OFFSET);
                }
                else {
                  Serial.println("Update.end Called...");
                }
                https.end();
                sclient.stop();
              }
            }
            else {
              timeouts++;
              if(timeouts >= 500) {
                Update.abort();
                https.end();
                Serial.println("Stream timeout!!!");
                return -43;
              }
              sockEmit.loop();
              webServer.loop();
              delay(100);
            }
          }
          if(endError) return endError;
          if(len > total) {
            Update.abort();
            Serial.println("Error downloading file!!!");
            return -42;
          }
          else
            Serial.printf("Update %s complete\n", this->currentFile);
        }
      }
      else {
        Serial.printf("Invalid HTTP Code... %d", httpCode);
        return httpCode;
      }
    }
    else {
      // Falling through to `return 0` reported success: beginUpdate() then recorded the
      // new version, marked the partition pending and rebooted having flashed nothing,
      // leaving the device permanently claiming a firmware it is not running.
      Serial.printf("Invalid HTTP Code: %d\n", httpCode);
      https.end();
      sclient.stop();
      return httpCode != 0 ? static_cast<int8_t>(httpCode) : static_cast<int8_t>(-1);
    }
    https.end();
    sclient.stop();
    Serial.printf("End update %s\n", this->currentFile);
  }
  esp_task_wdt_reset();
  return 0;
}
