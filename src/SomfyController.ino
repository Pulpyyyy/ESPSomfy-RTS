#include <Arduino.h>
#include <WiFi.h>
#include <LittleFS.h>
#include <esp_task_wdt.h>
#include "ConfigSettings.h"
#include "SomfyNetwork.h"
#include "Web.h"
#include "Sockets.h"
#include "Utils.h"
#include "Somfy.h"
#include "MQTT.h"
#include "GitOTA.h"
#include "Rollback.h"
#include "Recovery.h"

ConfigSettings settings;
Web webServer;
SocketEmitter sockEmit;
SomfyNetwork net;
rebootDelay_t rebootDelay;
SomfyShadeController somfy;
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
  delay(1000);
  net.setup();
  somfy.begin();
  // Arduino-ESP32 3.x (ESP-IDF 5.x) replaced the esp_task_wdt_init(timeout_s, panic)
  // signature with a config struct (timeout is now in milliseconds). The Arduino core
  // may already have initialized the TWDT (CONFIG_ESP_TASK_WDT_INIT), in which case
  // init() returns ESP_ERR_INVALID_STATE, so fall back to reconfigure() to apply our
  // 15s / panic-on-timeout settings.
  esp_task_wdt_config_t wdtConfig = {
    .timeout_ms = 15000,     // enable panic so ESP32 restarts after 15s
    .idle_core_mask = 0,     // do not subscribe the idle tasks
    .trigger_panic = true,
  };
  if(esp_task_wdt_init(&wdtConfig) == ESP_ERR_INVALID_STATE)
    esp_task_wdt_reconfigure(&wdtConfig);
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
  if(rebootDelay.reboot && (int32_t)(millis() - rebootDelay.rebootTime) >= 0) {
    Serial.print("Rebooting after ");
    Serial.print(rebootDelay.rebootTime);
    Serial.println("ms");
    // A user-requested reboot proves the running firmware works: validate it so
    // quick successive reboots do not trip the OTA rollback. markValid() keeps
    // a marker set in this session (post-flash, pre-reboot) pending.
    OTARollback::markValid();
    net.end();
    ESP.restart();
    return;
  }
  uint32_t timing = millis();

  net.loop();
  if(millis() - timing > 100) Serial.printf("Timing Net: %ldms\n", millis() - timing);
  timing = millis();
  esp_task_wdt_reset();
  somfy.loop();
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
