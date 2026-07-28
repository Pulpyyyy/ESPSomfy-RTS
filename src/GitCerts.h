#ifndef GITCERTS_H
#define GITCERTS_H
#include <pgmspace.h>

// Trust roots for the GitHub OTA and optional mqtts. Defined ONCE in
// GitCerts.cpp: as a static in this header every includer (GitOTA.cpp and
// MQTT.cpp) linked its own 8.6KB copy of the bundle.
extern const char GITHUB_ROOT_CAS[] PROGMEM;
#endif
