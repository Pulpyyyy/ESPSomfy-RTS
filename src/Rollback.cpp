#include <Arduino.h>
#include <Preferences.h>
#include <esp_ota_ops.h>
#include "Rollback.h"

// Number of boots the new firmware gets to reach markValid() before we
// switch back to the previous partition.
#define ROLLBACK_MAX_BOOTS 3

void OTARollback::markPending() {
  Preferences p;
  p.begin("fw_rb", false);
  p.putUChar("pending", 1);
  p.putUChar("boots", 0);
  p.end();
  Serial.println("[OTA] Firmware marked for validation on next boot");
}
void OTARollback::checkBoot() {
  Preferences p;
  p.begin("fw_rb", false);
  if(p.getUChar("pending", 0)) {
    uint8_t boots = p.getUChar("boots", 0) + 1;
    p.putUChar("boots", boots);
    Serial.printf("[OTA] Firmware awaiting validation: boot %u/%u\n", boots, ROLLBACK_MAX_BOOTS);
    if(boots > ROLLBACK_MAX_BOOTS) {
      p.putUChar("pending", 0);
      p.putUChar("boots", 0);
      // The other OTA bank still holds the previous firmware;
      // esp_ota_set_boot_partition rejects an invalid image.
      const esp_partition_t *prev = esp_ota_get_next_update_partition(NULL);
      if(prev && esp_ota_set_boot_partition(prev) == ESP_OK) {
        p.end();
        Serial.printf("[OTA] Firmware failed to validate: rolling back to %s\n", prev->label);
        delay(100);
        ESP.restart();
      }
      Serial.println("[OTA] Rollback not possible: keeping current firmware");
    }
  }
  p.end();
}
void OTARollback::markValid() {
  Preferences p;
  p.begin("fw_rb", false);
  // boots == 0 means the marker was set in the current session (right after
  // flashing, before the post-OTA reboot): that firmware has not booted yet
  // and must not be validated. Only clear once the new image has booted.
  if(p.getUChar("pending", 0) && p.getUChar("boots", 0) > 0) {
    p.putUChar("pending", 0);
    p.putUChar("boots", 0);
    Serial.println("[OTA] Firmware validated");
  }
  p.end();
}
