#include <Arduino.h>
#include <WiFi.h>
#include <LittleFS.h>
#include <esp_task_wdt.h>
#include "ConfigSettings.h"
#include "Network.h"
#include "Web.h"
#include "WebAsync.h"
#include "Sockets.h"
#include "Utils.h"
#include "Somfy.h"
#include "RfStats.h"
#include "MQTT.h"
#include "GitOTA.h"
#include "Rollback.h"
#include "Recovery.h"

ConfigSettings settings;
Web webServer;
SocketEmitter sockEmit;
Network net;
rebootDelay_t rebootDelay;
SomfyShadeController somfy;
RfStats rfStats;
MQTTClass mqtt;
GitUpdater git;

uint32_t oldheap = 0;
void setup() {
  #if defined(LED_PIN) && LED_PIN != -1
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  #endif
  Serial.begin(115200);
  Serial.println();
  Serial.println("Startup/Boot....");
  somfyLockInit();
  OTARollback::checkBoot();
  handlePowerCycleReset();
  Serial.println("Mounting File System...");
  if(LittleFS.begin()) Serial.println("File system mounted successfully");
  else Serial.println("Error mounting file system");
  if(_pendingFactory) performFactoryReset();
  settings.begin();
  if(_pendingNetSecuRecovery) resetAccessAndNetworkConfig();
  if(WiFi.status() == WL_CONNECTED) WiFi.disconnect(true);
  delay(10);
  Serial.println();
  webServer.startup();
  webServer.begin();
  webAsync.begin();
  delay(1000);
  net.setup();
  somfy.begin();
  rfStats.begin();
  esp_task_wdt_init(15, true); //enable panic so ESP32 restarts
  esp_task_wdt_add(NULL); //add current thread to WDT watch

}

void loop() {
  // put your main code here, to run repeatedly:
  //uint32_t heap = ESP.getFreeHeap();
  // One minute of loop without crash or watchdog reset = firmware is valid, cancel rollback.
  static bool fwValidated = false;
  if(!fwValidated && millis() > 60000) { OTARollback::markValid(); fwValidated = true; }
  // Single evaluation per pass: a reboot armed later in this pass fires at the top of the
  // next one a few ms later, which is what the 500-1000ms grace the callers arm is for --
  // it lets the HTTP response that requested the reboot flush first.
  // Read under the lock: the async handlers set reboot and rebootTime as a pair
  // under it, so a reboot never fires on a stale rebootTime before its response
  // has gone out.
  bool rebootNow;
  {
    SomfyGuard guard;
    rebootNow = rebootDelay.reboot && (int32_t)(millis() - rebootDelay.rebootTime) >= 0;
  }
  if(rebootNow) {
    SomfyGuard guard; // the async side must not touch MQTT, sockets or files while they close
    Serial.print("Rebooting after ");
    Serial.print(rebootDelay.rebootTime);
    Serial.println("ms");
    // A user-requested reboot proves the running firmware works: validate it so
    // quick successive reboots do not trip the OTA rollback. markValid() keeps
    // a marker set in this session (post-flash, pre-reboot) pending.
    OTARollback::markValid();
    rfStats.end();
    net.end();
    ESP.restart();
    return;
  }
  uint32_t timing = millis();

  {
    // Network upkeep pumps MQTT (whose receive callback drives the shades) and
    // the socket server, both shared with the async handlers.
    SomfyGuard guard;
    net.loop();
  }
  if(millis() - timing > 100) Serial.printf("Timing Net: %ldms\n", millis() - timing);
  timing = millis();
  esp_task_wdt_reset();
  // Release the OTA gate if a flash stalled (browser dropped mid-upload), so
  // somfy does not stay frozen waiting for a final chunk that never comes.
  webAsync.abortStalledOta();
  {
    // Async HTTP handlers run concurrently in the async_tcp task; everything
    // touching the somfy/rfStats world is serialized on this lock. During an
    // async OTA flash the radio is shut down and somfy must stay quiescent,
    // exactly as it does on the sync path (which blocks the loop task for the
    // whole upload), so skip this block until the flash completes. The flag is
    // read under the lock, where the upload handler sets it.
    SomfyGuard guard;
    if(!webAsync.otaInProgress) {
      somfy.loop();
      rfStats.loop();
    }
  }
  if(millis() - timing > 100) Serial.printf("Timing Somfy: %ldms\n", millis() - timing);
  timing = millis();
  esp_task_wdt_reset();
  if(net.connected() || net.softAPOpened) {
    if(!rebootDelay.reboot && net.connected() && !net.softAPOpened) {
      git.loop();
      esp_task_wdt_reset();
    }
    webServer.loop();
    esp_task_wdt_reset();
    if(millis() - timing > 100) Serial.printf("Timing WebServer: %ldms\n", millis() - timing);
    esp_task_wdt_reset();
    timing = millis();
    sockEmit.loop();
    if(millis() - timing > 100) Serial.printf("Timing Socket: %ldms\n", millis() - timing);
    esp_task_wdt_reset();
    timing = millis();
  }
  esp_task_wdt_reset();
}
