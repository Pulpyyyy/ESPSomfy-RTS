#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>
#include <time.h>
#include <strings.h>
#include <new>
#include "ConfigSettings.h"
#include "GitCerts.h"
#include "MQTT.h"
#include "Somfy.h"
#include "Network.h"
#include "Utils.h"

WiFiClient tcpClient;
// Only allocated when the user actually selected mqtts://. WiFiClientSecure plus
// the parsed CA bundle costs roughly 40KB of heap for as long as the session
// lives, which must not be spent on the plaintext path.
static WiFiClientSecure *tlsClient = nullptr;
PubSubClient mqttClient(tcpClient);

#define MQTT_MAX_RESPONSE 2048
static char g_content[MQTT_MAX_RESPONSE];

// Free heap required before starting a handshake. Below this mbedtls fails
// halfway through its allocations, which is a much worse failure mode than
// simply postponing the attempt.
#define MQTT_TLS_MIN_HEAP 50000
// Verifying a chain is slow. 8s keeps the worst case (handshake + the CONNACK
// wait below) under the 15s task watchdog period set in SomfyController.ino.
#define MQTT_TLS_HANDSHAKE_TIMEOUT 8

extern ConfigSettings settings;
extern SomfyShadeController somfy;
extern Network net;
extern rebootDelay_t rebootDelay;

// Certificate validity is checked against the wall clock, so a device that has
// not synced NTP yet rejects every chain. Same guard as GitOTA.cpp.
static bool _clockIsSet() { return time(nullptr) > 1750000000; } // 2025-06-15
// The settings page stores the scheme as the option label ("MQTT"/"MQTTS") while
// the factory default is "mqtt://": match the prefix, case-insensitively.
static bool _useTLS() { return strncasecmp(settings.MQTT.protocol, "mqtts", 5) == 0; }
static void _releaseTLSClient() {
  if(!tlsClient) return;
  // Point PubSubClient back at the plaintext client *before* freeing: it caches the
  // pointer and its loop() would dereference it on the next pass.
  mqttClient.setClient(tcpClient);
  tlsClient->stop();
  delete tlsClient;
  tlsClient = nullptr;
}

const char* MQTTClass::makeTopic(const char* topic) {
  static char top[128];
  // MQTTSettings guarantees a non-empty root topic; this is defence in depth. The
  // former fallback published *and subscribed* at the broker root when the root
  // topic was empty, which let any publisher drive the shades.
  if(settings.MQTT.rootTopic[0] == '\0') settings.MQTT.ensureRootTopic();
  snprintf(top, sizeof(top), "%s/%s", settings.MQTT.rootTopic, topic);
  return top;
}

bool MQTTClass::begin() { this->suspended = false; return true; }
bool MQTTClass::end() { this->suspended = true; this->disconnect(); return true; }
void MQTTClass::reset() { this->disconnect(); this->lastConnect = 0; this->connect(); }

bool MQTTClass::loop() {
  if(this->reconnectPending) {
    this->reconnectPending = false;
    this->disconnect();
  }
  if(settings.MQTT.enabled && !rebootDelay.reboot && !this->suspended && !mqttClient.connected()) {
    esp_task_wdt_reset();
    if(net.connected()) this->connect();
  }
  esp_task_wdt_reset();
  if(settings.MQTT.enabled) mqttClient.loop();
  return true;
}

void MQTTClass::receive(const char *topic, byte* payload, uint32_t length) {
  esp_task_wdt_reset();

  if(!topic || !payload) return;
  uint16_t len = strlen(topic);
  // An empty topic would underflow the unsigned index below to 65535 and send the
  // walk-back loop reading far past the end of the buffer.
  if(len == 0) return;
  uint16_t ndx = len - 1;
  uint8_t slashes = 0;
  while(ndx > 0 && slashes < 4) {
    if(topic[ndx] == '/') slashes++;
    if(slashes < 4) ndx--;
  }

  char entityType[10], entityId[5], command[32], value[11];
  auto extract = [&](char* dest, size_t dlen) {
    while(ndx < len && topic[ndx] == '/') ndx++;
    size_t i = 0;
    while(ndx < len && topic[ndx] != '/' && i < dlen - 1) dest[i++] = topic[ndx++];
    dest[i] = '\0';
  };

  extract(entityType, sizeof(entityType));
  extract(entityId, sizeof(entityId));
  extract(command, sizeof(command));

  size_t vlen = (length < sizeof(value) - 1) ? length : sizeof(value) - 1;
  memcpy(value, payload, vlen);
  value[vlen] = '\0';
  // atoi() would silently turn a non-numeric payload into 0 (= fully open for a
  // target command): ignore any payload that is not strictly an integer.
  char *endp;
  long lval = strtol(value, &endp, 10);
  while(*endp == ' ' || *endp == '\t' || *endp == '\r' || *endp == '\n') endp++;
  if(endp == value || *endp != '\0') return;
  int val = (int)constrain(lval, -1000L, 1000L);

  if(strcmp(entityType, "shades") == 0) {
    SomfyShade* shade = somfy.getShadeById(atoi(entityId));
    if (shade) {
      if(strcmp(command, "target") == 0) shade->moveToTarget(shade->transformPosition(constrain(val, 0, 100)));
      else if(strcmp(command, "tiltTarget") == 0) shade->moveToTiltTarget(constrain(val, 0, 100));
      else if(strcmp(command, "direction") == 0) {
        if(val < 0) shade->sendCommand(somfy_commands::Up);
        else if(val > 0) shade->sendCommand(somfy_commands::Down);
        else shade->sendCommand(somfy_commands::My);
      }
      else if(strcmp(command, "mypos") == 0) shade->setMyPosition(constrain(val, -1, 100));
      else if(strcmp(command, "myTiltPos") == 0) shade->setMyPosition(shade->myPos, constrain(val, -1, 100));
      else if(strcmp(command, "sunFlag") == 0) shade->sendCommand(val > 0 ? somfy_commands::SunFlag : somfy_commands::Flag);
      else if(strcmp(command, "position") == 0) {
        shade->target = shade->currentPos = shade->transformPosition((float)constrain(val, 0, 100));
        shade->emitState();
      }
      else if(strcmp(command, "tiltPosition") == 0) {
        shade->tiltTarget = shade->currentTiltPos = (float)constrain(val, 0, 100);
        shade->emitState();
      }
      else if(strcmp(command, "sunny") == 0) shade->sendSensorCommand(-1, constrain(val, 0, 1), shade->repeats);
      else if(strcmp(command, "windy") == 0) shade->sendSensorCommand(constrain(val, 0, 1), -1, shade->repeats);
    }
  }
  else if(strcmp(entityType, "groups") == 0) {
    SomfyGroup* group = somfy.getGroupById(atoi(entityId));
    if (group) {
      if(strcmp(command, "direction") == 0) {
        if(val < 0) group->sendCommand(somfy_commands::Up);
        else if(val > 0) group->sendCommand(somfy_commands::Down);
        else group->sendCommand(somfy_commands::My);
      }
      else if(strcmp(command, "sunFlag") == 0) group->sendCommand(val > 0 ? somfy_commands::Flag : somfy_commands::SunFlag);
      else if(strcmp(command, "sunny") == 0) group->sendSensorCommand(-1, constrain(val, 0, 1), group->repeats);
      else if(strcmp(command, "windy") == 0) group->sendSensorCommand(constrain(val, 0, 1), -1, group->repeats);
    }
  }
  esp_task_wdt_reset();
}

bool MQTTClass::connect() {
  esp_task_wdt_reset();
  if(mqttClient.connected()) return true;
  if(!settings.MQTT.enabled || this->suspended) return false;
  // Throttle attempts to once per 10s. Stamping the attempt here (not only on success,
  // as before) keeps the guard effective when the broker is unreachable — otherwise a
  // down broker triggers a blocking DNS+TCP connect on every loop iteration. lastConnect
  // holds a millis() value; the subtractive compare stays correct across the 49.7-day
  // wrap, where the old `lastConnect + 10000 > millis()` would have blocked forever.
  // lastConnect == 0 is the "connect now" sentinel used by reset().
  if(this->lastConnect != 0 && (uint32_t)(millis() - this->lastConnect) < 10000) return false;
  this->lastConnect = millis();

  // Use the user-configured client id when set; otherwise fall back to a unique
  // MAC-derived default so two controllers never collide on the broker.
  if(settings.MQTT.clientId[0] != '\0')
    strlcpy(this->clientId, settings.MQTT.clientId, sizeof(this->clientId));
  else {
    uint64_t mac = ESP.getEfuseMac();
    snprintf(this->clientId, sizeof(this->clientId), "client-%08x%08x", (uint32_t)((mac >> 32) & 0xFFFFFFFF), (uint32_t)(mac & 0xFFFFFFFF));
  }

  // mqtts:// used to be accepted while the transport stayed a bare WiFiClient, so the
  // traffic (broker credentials included) went out in clear text while the settings page
  // claimed otherwise. It is now a real TLS session, validated against the same Mozilla
  // roots as the GitHub OTA. There is deliberately no insecure mode: a broker whose chain
  // does not validate is refused rather than silently downgraded.
  const bool useTLS = _useTLS();
  if(useTLS) {
    if(!_clockIsSet()) {
      Serial.println("MQTT connection deferred: the clock is not synced yet (TLS validation needs the time)");
      return false;
    }
    if(!tlsClient) {
      uint32_t heap = ESP.getFreeHeap();
      if(heap < MQTT_TLS_MIN_HEAP) {
        Serial.printf("MQTT TLS connection deferred: only %u bytes of heap free, %u needed for the handshake\n", heap, (uint32_t)MQTT_TLS_MIN_HEAP);
        return false;
      }
      tlsClient = new (std::nothrow) WiFiClientSecure();
      if(!tlsClient) {
        Serial.println("MQTT TLS connection failed: could not allocate the secure client");
        return false;
      }
      tlsClient->setCACert(GITHUB_ROOT_CAS);
      tlsClient->setHandshakeTimeout(MQTT_TLS_HANDSHAKE_TIMEOUT);
    }
    mqttClient.setClient(*tlsClient);
  }
  else _releaseTLSClient(); // Give the ~40KB back as soon as the user leaves mqtts://.

  mqttClient.setServer(settings.MQTT.hostname, settings.MQTT.port);
  // connect() blocks the loop, and with it the radio timing, until the socket answers.
  // PubSubClient defaults to 15s, which is the watchdog period: an unreachable broker on
  // a reachable network could freeze the device long enough to trigger a panic reboot.
  // Over TLS the CONNACK travels behind a record layer, so allow a little more.
  mqttClient.setSocketTimeout(useTLS ? 4 : 2);
  if(mqttClient.connect(this->clientId, settings.MQTT.username, settings.MQTT.password, makeTopic("status"), 0, true, "offline")) {
    if(useTLS) Serial.printf("MQTT connected to %s over TLS, certificate validated (%u bytes of heap free)\n", settings.MQTT.hostname, ESP.getFreeHeap());
    this->publish("status", "online", true);
    this->publish("ipAddress", settings.IP.ip.toString().c_str(), true);
    this->publish("host", settings.hostname, true);
    this->publish("firmware", settings.fwVersion.name, true);
    this->publish("serverId", settings.serverId, true);
    this->publish("mac", net.mac);
    somfy.publish();

    this->subscribe("shades/+/target/set");
    this->subscribe("shades/+/tiltTarget/set");
    this->subscribe("shades/+/direction/set");
    this->subscribe("shades/+/mypos/set");
    this->subscribe("shades/+/myTiltPos/set");
    this->subscribe("shades/+/sunFlag/set");
    this->subscribe("shades/+/sunny/set");
    this->subscribe("shades/+/windy/set");
    this->subscribe("shades/+/position/set");
    this->subscribe("shades/+/tiltPosition/set");
    this->subscribe("groups/+/direction/set");
    this->subscribe("groups/+/sunFlag/set");
    this->subscribe("groups/+/sunny/set");
    this->subscribe("groups/+/windy/set");

    mqttClient.setCallback(MQTTClass::receive);
    return true;
  }
  if(useTLS && tlsClient) {
    char err[128] = "";
    int lastError = tlsClient->lastError(err, sizeof(err));
    if(lastError != 0)
      Serial.printf("MQTT TLS handshake with %s failed (-0x%04X): %s -- the broker certificate must chain to a public CA and match the host name\n",
        settings.MQTT.hostname, (unsigned int)(-lastError), err);
    else
      Serial.printf("MQTT broker %s refused the connection over TLS (state %d)\n", settings.MQTT.hostname, mqttClient.state());
    // Do not keep the session (and its ~40KB) pinned while we wait for the next
    // attempt; connect() rebuilds it from scratch.
    _releaseTLSClient();
  }
  return false;
}

bool MQTTClass::disconnect() {
  if(mqttClient.connected()) {
    this->unsubscribe("shades/+/target/set");
    this->unsubscribe("shades/+/direction/set");
    this->unsubscribe("shades/+/tiltTarget/set");
    this->unsubscribe("shades/+/mypos/set");
    this->unsubscribe("shades/+/myTiltPos/set");
    this->unsubscribe("shades/+/sunFlag/set");
    this->unsubscribe("groups/+/direction/set");
    this->unsubscribe("shades/+/sunny/set");
    this->unsubscribe("shades/+/windy/set");
    this->unsubscribe("shades/+/position/set");
    this->unsubscribe("shades/+/tiltPosition/set");
    this->unsubscribe("groups/+/direction/set");
    this->unsubscribe("groups/+/sunFlag/set");
    this->unsubscribe("groups/+/sunny/set");
    this->unsubscribe("groups/+/windy/set");
    mqttClient.disconnect();
  }
  // Reclaim the TLS session heap whenever we are not connected; connect() rebuilds it.
  _releaseTLSClient();
  return true;
}

bool MQTTClass::subscribe(const char *topic) {
  if(!mqttClient.connected()) return false;
  esp_task_wdt_reset();
  return mqttClient.subscribe(makeTopic(topic));
}

bool MQTTClass::unsubscribe(const char *topic) {
  if(!mqttClient.connected()) return false;
  return mqttClient.unsubscribe(makeTopic(topic));
}

bool MQTTClass::publish(const char *topic, const char *payload, bool retain) {
  if(!mqttClient.connected()) return false;
  esp_task_wdt_reset();
  return mqttClient.publish(makeTopic(topic), payload, retain);
}

bool MQTTClass::unpublish(const char *topic) {
  if(!mqttClient.connected()) return false;
  esp_task_wdt_reset();
  return mqttClient.publish(makeTopic(topic), (const uint8_t *)"", 0, true);
}

bool MQTTClass::publish(const char *topic, uint32_t val, bool retain) { itoa(val, g_content, 10); return this->publish(topic, g_content, retain); }
bool MQTTClass::publish(const char *topic, uint8_t val, bool retain) { itoa(val, g_content, 10); return this->publish(topic, g_content, retain); }
bool MQTTClass::publish(const char *topic, uint16_t val, bool retain) { itoa(val, g_content, 10); return this->publish(topic, g_content, retain); }
bool MQTTClass::publish(const char *topic, int8_t val, bool retain) { itoa(val, g_content, 10); return this->publish(topic, g_content, retain); }
bool MQTTClass::publish(const char *topic, bool val, bool retain) { return this->publish(topic, val ? "true" : "false", retain); }

bool MQTTClass::publishBuffer(const char *topic, uint8_t *data, uint16_t len, bool retain) {
  if(!mqttClient.connected()) return false;
  esp_task_wdt_reset();
  mqttClient.beginPublish(makeTopic(topic), len, retain);
  mqttClient.write(data, len);
  return mqttClient.endPublish();
}

bool MQTTClass::publishDisco(const char *topic, JsonObject &obj, bool retain) {
  serializeJson(obj, g_content, sizeof(g_content));
  return this->publishBuffer(topic, (uint8_t *)g_content, strlen(g_content), retain);
}

bool MQTTClass::connected() { return settings.MQTT.enabled && mqttClient.connected(); }
