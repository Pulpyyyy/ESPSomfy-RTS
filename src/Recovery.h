#ifndef RECOVERY_H
#define RECOVERY_H

#define NET_RECOVERY_CYCLES 3
#define FULL_FACTORY_CYCLES 6
#define BOOT_TIMEOUT 5000

//#if defined(CONFIG_IDF_TARGET_ESP32) && !defined(CONFIG_IDF_TARGET_ESP32S2) && !defined(CONFIG_IDF_TARGET_ESP32S3) && !defined(CONFIG_IDF_TARGET_ESP32C3) && !defined(CONFIG_IDF_TARGET_ESP32C6)
//#define LED_PIN 2
//#else
#define LED_PIN -1
//#endif

extern bool _pendingNetSecuRecovery;
extern bool _pendingFactory;

void visualFeedback(int durationMs, int speedMs);
void handlePowerCycleReset();
void resetAccessAndNetworkConfig();
void performFactoryReset();

#endif
