#include <Arduino.h>
#include <WebServer.h>
#include "Utils.h"
#include "ConfigSettings.h"
#include "Somfy.h"
#include "Sockets.h"
#include "MQTT.h"

// MQTT publishing and socket state emission for rooms, shades, groups and the
// controller, split out of Somfy.cpp.  Pure method moves; declarations stay in
// Somfy.h.

extern SomfyShadeController somfy;
extern SocketEmitter sockEmit;
extern ConfigSettings settings;
extern MQTTClass mqtt;

void SomfyRoom::publish() {
  if(mqtt.connected()) {
    char topic[64];
    sprintf(topic, "rooms/%d/roomId", this->roomId);
    mqtt.publish(topic, this->roomId, true);
    sprintf(topic, "rooms/%d/name", this->roomId);
    mqtt.publish(topic, this->name, true);
    sprintf(topic, "rooms/%d/sortOrder", this->roomId);
    mqtt.publish(topic, this->sortOrder, true);
  }
}
void SomfyRoom::unpublish() {
  if(mqtt.connected()) {
    char topic[64];
    sprintf(topic, "rooms/%d/roomId", this->roomId);
    mqtt.unpublish(topic);
    sprintf(topic, "rooms/%d/name", this->roomId);
    mqtt.unpublish(topic);
    sprintf(topic, "rooms/%d/sortOrder", this->roomId);
    mqtt.unpublish(topic);
  }
}
void SomfyShade::publishState() {
  if(mqtt.connected()) {
    this->publish("position", this->transformPosition(this->currentPos), true);
    this->publish("direction", this->direction, true);
    this->publish("target", this->transformPosition(this->target), true);
    this->publish("lastRollingCode", this->lastRollingCode);
    this->publish("mypos", this->transformPosition(this->myPos), true);
    this->publish("myTiltPos", this->transformPosition(this->myTiltPos), true);
    if(this->tiltType != tilt_types::none) {
      this->publish("tiltDirection", this->tiltDirection, true);
      this->publish("tiltPosition", this->transformPosition(this->currentTiltPos), true);
      this->publish("tiltTarget", this->transformPosition(this->tiltTarget), true);
    }
    const uint8_t sunFlag = !!(this->flags & static_cast<uint8_t>(somfy_flags_t::SunFlag));
    const uint8_t isSunny = !!(this->flags & static_cast<uint8_t>(somfy_flags_t::Sunny));
    const uint8_t isWindy = !!(this->flags & static_cast<uint8_t>(somfy_flags_t::Windy));
    if(this->hasSunSensor()) {
      this->publish("sunFlag", sunFlag);
      this->publish("sunny", isSunny);
    }
    this->publish("windy", isWindy);
  }
}
void SomfyShade::publishDisco() {
  if(!mqtt.connected() || !settings.MQTT.pubDisco) return;
  char topic[128] = "";
  DynamicJsonDocument doc(2048);
  JsonObject obj = doc.to<JsonObject>();
  snprintf(topic, sizeof(topic), "%s/shades/%d", settings.MQTT.rootTopic, this->shadeId);
  obj["~"] = topic;
  JsonObject dobj = obj.createNestedObject("device");
  dobj["hw_version"] = settings.fwVersion.name;
  dobj["name"] = settings.hostname;
  dobj["mf"] = "rstrouse";
  JsonArray arrids = dobj.createNestedArray("identifiers");
  //snprintf(topic, sizeof(topic), "mqtt_espsomfyrts_%s_shade%d", settings.serverId, this->shadeId);
  snprintf(topic, sizeof(topic), "mqtt_espsomfyrts_%s", settings.serverId);
  arrids.add(topic);
  //snprintf(topic, sizeof(topic), "ESPSomfy-RTS_%s", settings.serverId);
  dobj["via_device"] = topic;
  dobj["model"] = "ESPSomfy-RTS MQTT";
  snprintf(topic, sizeof(topic), "%s/status", settings.MQTT.rootTopic);
  obj["availability_topic"] = topic;
  obj["payload_available"] = "online";
  obj["payload_not_available"] = "offline";
  obj["name"] = this->name;
  snprintf(topic, sizeof(topic), "mqtt_%s_shade%d", settings.serverId, this->shadeId);
  obj["unique_id"] = topic;
  switch(this->shadeType) {
    case shade_types::blind:
      obj["device_class"] = "blind";
      obj["payload_close"] = this->flipPosition ? "-1" : "1";
      obj["payload_open"] = this->flipPosition ? "1" : "-1";
      obj["position_open"] = this->flipPosition ? 100 : 0;
      obj["position_closed"] = this->flipPosition ? 0 : 100;
      obj["state_closing"] = this->flipPosition ? "-1" : "1";
      obj["state_opening"] = this->flipPosition ? "1" : "-1";
      break;
    case shade_types::lgate:
    case shade_types::cgate:
    case shade_types::rgate:
    case shade_types::lgate1:
    case shade_types::cgate1:
    case shade_types::rgate1:
    case shade_types::ldrapery:
    case shade_types::rdrapery:
    case shade_types::cdrapery:
      obj["device_class"] = "curtain";
      obj["payload_close"] = this->flipPosition ? "-1" : "1";
      obj["payload_open"] = this->flipPosition ? "1" : "-1";
      obj["position_open"] = this->flipPosition ? 100 : 0;
      obj["position_closed"] = this->flipPosition ? 0 : 100;
      obj["state_closing"] = this->flipPosition ? "-1" : "1";
      obj["state_opening"] = this->flipPosition ? "1" : "-1";
      break;
    case shade_types::garage1:
    case shade_types::garage3:
      obj["device_class"] = "garage";
      obj["payload_close"] = this->flipPosition ? "-1" : "1";
      obj["payload_open"] = this->flipPosition ? "1" : "-1";
      obj["position_open"] = this->flipPosition ? 100 : 0;
      obj["position_closed"] = this->flipPosition ? 0 : 100;
      obj["state_closing"] = this->flipPosition ? "-1" : "1";
      obj["state_opening"] = this->flipPosition ? "1" : "-1";
      break;
    case shade_types::awning:
      obj["device_class"] = "awning";
      obj["payload_close"] = this->flipPosition ? "1" : "-1";
      obj["payload_open"] = this->flipPosition ? "-1" : "1";
      obj["position_open"] = this->flipPosition ? 0 : 100;
      obj["position_closed"] = this->flipPosition ? 100 : 0;
      obj["state_closing"] = this->flipPosition ? "1" : "-1";
      obj["state_opening"] = this->flipPosition ? "-1" : "1";
      break;
    case shade_types::shutter:
      obj["device_class"] = "shutter";
      obj["payload_close"] = this->flipPosition ? "-1" : "1";
      obj["payload_open"] = this->flipPosition ? "1" : "-1";
      obj["position_open"] = this->flipPosition ? 100 : 0;
      obj["position_closed"] = this->flipPosition ? 0 : 100;
      obj["state_closing"] = this->flipPosition ? "-1" : "1";
      obj["state_opening"] = this->flipPosition ? "1" : "-1";
      break;
    case shade_types::drycontact2:
    case shade_types::drycontact:
      break;
    default:
      obj["device_class"] = "shade";
      obj["payload_close"] = this->flipPosition ? "-1" : "1";
      obj["payload_open"] = this->flipPosition ? "1" : "-1";
      obj["position_open"] = this->flipPosition ? 100 : 0;
      obj["position_closed"] = this->flipPosition ? 0 : 100;
      obj["state_closing"] = this->flipPosition ? "-1" : "1";
      obj["state_opening"] = this->flipPosition ? "1" : "-1";
      break;
  }
  if(this->shadeType != shade_types::drycontact && this->shadeType != shade_types::drycontact2) {
    if(this->tiltType != tilt_types::tiltonly) {
      obj["command_topic"] = "~/direction/set";
      obj["position_topic"] = "~/position";
      obj["set_position_topic"] = "~/target/set";
      obj["state_topic"] = "~/direction";
      obj["payload_stop"] = "0";
      obj["state_stopped"] = "0";
    }
    else {
      obj["payload_close"] = nullptr;
      obj["payload_open"] = nullptr;
      obj["payload_stop"] = nullptr;
    }
    
    if(this->tiltType != tilt_types::none) {
      obj["tilt_command_topic"] = "~/tiltTarget/set";
      obj["tilt_status_topic"] = "~/tiltPosition";
    }
    snprintf(topic, sizeof(topic), "%s/cover/%d/config", settings.MQTT.discoTopic, this->shadeId);
  }
  else {
    obj["payload_on"] = 100;
    obj["payload_off"] = 0;
    obj["state_off"] = 0;
    obj["state_on"] = 100;
    obj["state_topic"] = "~/position";
    obj["command_topic"] = "~/target/set";
    snprintf(topic, sizeof(topic), "%s/switch/%d/config", settings.MQTT.discoTopic, this->shadeId);
  }
  
  obj["enabled_by_default"] = true;
  mqtt.publishDisco(topic, obj, true);  
}
void SomfyShade::unpublishDisco() {
  if(!mqtt.connected() || !settings.MQTT.pubDisco) return;
  char topic[128] = "";
  if(this->shadeType != shade_types::drycontact && this->shadeType != shade_types::drycontact2) {
    snprintf(topic, sizeof(topic), "%s/cover/%d/config", settings.MQTT.discoTopic, this->shadeId);
  }
  else
    snprintf(topic, sizeof(topic), "%s/switch/%d/config", settings.MQTT.discoTopic, this->shadeId);
  mqtt.unpublish(topic);
}
void SomfyShade::publish() {
  if(mqtt.connected()) {
    this->publish("shadeId", this->shadeId, true);
    this->publish("name", this->name, true);
    this->publish("remoteAddress", this->getRemoteAddress(), true);
    this->publish("shadeType", static_cast<uint8_t>(this->shadeType), true);
    this->publish("tiltType", static_cast<uint8_t>(this->tiltType), true);
    this->publish("flags", this->flags, true);
    this->publish("flipCommands", this->flipCommands, true);
    this->publish("flipPosition", this->flipPosition, true);
    this->publishState();
    this->publishDisco();
    sockEmit.loop(); // Keep our socket alive.
  }
}
void SomfyGroup::publishState() {
  if(mqtt.connected()) {
    this->publish("direction", this->direction, true);
    this->publish("lastRollingCode", this->lastRollingCode, true);
    this->publish("flipCommands", this->flipCommands, true);
    const uint8_t sunFlag = !!(this->flags & static_cast<uint8_t>(somfy_flags_t::SunFlag));
    const uint8_t isSunny = !!(this->flags & static_cast<uint8_t>(somfy_flags_t::Sunny));
    const uint8_t isWindy = !!(this->flags & static_cast<uint8_t>(somfy_flags_t::Windy));
    this->publish("sunFlag", sunFlag);
    this->publish("sunny", isSunny);
    this->publish("windy", isWindy);    
  }  
}
void SomfyGroup::publish() {
  if(mqtt.connected()) {
    this->publish("groupId", this->groupId, true);
    this->publish("name", this->name, true);
    this->publish("remoteAddress", this->getRemoteAddress(), true);
    this->publish("groupType", static_cast<uint8_t>(this->groupType), true);
    this->publish("flags", this->flags, true);
    this->publish("sunSensor", this->hasSunSensor(), true);
    this->publishState();
  }
}
char mqttTopicBuffer[55];
void SomfyGroup::unpublish() { SomfyGroup::unpublish(this->groupId); }
void SomfyShade::unpublish() { SomfyShade::unpublish(this->shadeId); }
void SomfyShade::unpublish(uint8_t id) {
  if(mqtt.connected()) {
    SomfyShade::unpublish(id, "shadeId");
    SomfyShade::unpublish(id, "name");
    SomfyShade::unpublish(id, "remoteAddress");
    SomfyShade::unpublish(id, "shadeType");
    SomfyShade::unpublish(id, "tiltType");
    SomfyShade::unpublish(id, "flags");
    SomfyShade::unpublish(id, "flipCommands");
    SomfyShade::unpublish(id, "flipPosition");
    SomfyShade::unpublish(id, "position");
    SomfyShade::unpublish(id, "direction");
    SomfyShade::unpublish(id, "target");
    SomfyShade::unpublish(id, "lastRollingCode");
    SomfyShade::unpublish(id, "mypos");
    SomfyShade::unpublish(id, "myTiltPos");
    SomfyShade::unpublish(id, "tiltDirection");
    SomfyShade::unpublish(id, "tiltPosition");
    SomfyShade::unpublish(id, "tiltTarget");
    SomfyShade::unpublish(id, "windy");
    SomfyShade::unpublish(id, "sunny");
    if(settings.MQTT.pubDisco) {
      char topic[128] = "";
      snprintf(topic, sizeof(topic), "%s/cover/%d/config", settings.MQTT.discoTopic, id);
      mqtt.unpublish(topic);
      snprintf(topic, sizeof(topic), "%s/switch/%d/config", settings.MQTT.discoTopic, id);
      mqtt.unpublish(topic);
    }
  }
}
void SomfyGroup::unpublish(uint8_t id) {
  if(mqtt.connected()) {
    SomfyGroup::unpublish(id, "groupId");
    SomfyGroup::unpublish(id, "name");
    SomfyGroup::unpublish(id, "remoteAddress");
    SomfyGroup::unpublish(id, "groupType");
    SomfyGroup::unpublish(id, "direction");
    SomfyGroup::unpublish(id, "lastRollingCode");
    SomfyGroup::unpublish(id, "flags");
    SomfyGroup::unpublish(id, "SunSensor");
    SomfyGroup::unpublish(id, "flipCommands");
  }
}
void SomfyGroup::unpublish(uint8_t id, const char *topic) {
  if(mqtt.connected()) {
    snprintf(mqttTopicBuffer, sizeof(mqttTopicBuffer), "groups/%u/%s", id, topic);
    mqtt.unpublish(mqttTopicBuffer);
  }
}
void SomfyShade::unpublish(uint8_t id, const char *topic) {
  if(mqtt.connected()) {
    snprintf(mqttTopicBuffer, sizeof(mqttTopicBuffer), "shades/%u/%s", id, topic);
    mqtt.unpublish(mqttTopicBuffer);
  }
}
bool SomfyShade::publish(const char *topic, int8_t val, bool retain) {
  if(mqtt.connected()) {
    snprintf(mqttTopicBuffer, sizeof(mqttTopicBuffer), "shades/%u/%s", this->shadeId, topic);
    mqtt.publish(mqttTopicBuffer, val, retain);
    return true;
  }
  return false;
}

bool SomfyShade::publish(const char *topic, const char *val, bool retain) { 
  if(mqtt.connected()) {
    snprintf(mqttTopicBuffer, sizeof(mqttTopicBuffer), "shades/%u/%s", this->shadeId, topic);
    mqtt.publish(mqttTopicBuffer, val, retain);
    return true;
  }
  return false;
}
bool SomfyShade::publish(const char *topic, uint8_t val, bool retain) {
  if(mqtt.connected()) {
    snprintf(mqttTopicBuffer, sizeof(mqttTopicBuffer), "shades/%u/%s", this->shadeId, topic);
    mqtt.publish(mqttTopicBuffer, val, retain);
    return true;
  }
  return false;
}
bool SomfyShade::publish(const char *topic, uint32_t val, bool retain) {
  if(mqtt.connected()) {
    snprintf(mqttTopicBuffer, sizeof(mqttTopicBuffer), "shades/%u/%s", this->shadeId, topic);
    mqtt.publish(mqttTopicBuffer, val, retain);
    return true;
  }
  return false;
}
bool SomfyShade::publish(const char *topic, uint16_t val, bool retain) {
  if(mqtt.connected()) {
    snprintf(mqttTopicBuffer, sizeof(mqttTopicBuffer), "shades/%u/%s", this->shadeId, topic);
    mqtt.publish(mqttTopicBuffer, val, retain);
    return true;
  }
  return false;
}
bool SomfyShade::publish(const char *topic, bool val, bool retain) {
  if(mqtt.connected()) {
    snprintf(mqttTopicBuffer, sizeof(mqttTopicBuffer), "shades/%u/%s", this->shadeId, topic);
    mqtt.publish(mqttTopicBuffer, val, retain);
    return true;
  }
  return false;
}

bool SomfyGroup::publish(const char *topic, int8_t val, bool retain) {
  if(mqtt.connected()) {
    snprintf(mqttTopicBuffer, sizeof(mqttTopicBuffer), "groups/%u/%s", this->groupId, topic);
    mqtt.publish(mqttTopicBuffer, val, retain);
    return true;
  }
  return false;
}
bool SomfyGroup::publish(const char *topic, uint8_t val, bool retain) {
  if(mqtt.connected()) {
    snprintf(mqttTopicBuffer, sizeof(mqttTopicBuffer), "groups/%u/%s", this->groupId, topic);
    mqtt.publish(mqttTopicBuffer, val, retain);
    return true;
  }
  return false;
}
bool SomfyGroup::publish(const char *topic, uint32_t val, bool retain) {
  if(mqtt.connected()) {
    snprintf(mqttTopicBuffer, sizeof(mqttTopicBuffer), "groups/%u/%s", this->groupId, topic);
    mqtt.publish(mqttTopicBuffer, val, retain);
    return true;
  }
  return false;
}
bool SomfyGroup::publish(const char *topic, uint16_t val, bool retain) {
  if(mqtt.connected()) {
    snprintf(mqttTopicBuffer, sizeof(mqttTopicBuffer), "groups/%u/%s", this->groupId, topic);
    mqtt.publish(mqttTopicBuffer, val, retain);
    return true;
  }
  return false;
}
bool SomfyGroup::publish(const char *topic, bool val, bool retain) {
  if(mqtt.connected()) {
    snprintf(mqttTopicBuffer, sizeof(mqttTopicBuffer), "groups/%u/%s", this->groupId, topic);
    mqtt.publish(mqttTopicBuffer, val, retain);
    return true;
  }
  return false;
}

void SomfyShade::emitState(const char *evt) { this->emitState(255, evt); }
void SomfyShade::emitState(uint8_t num, const char *evt) {
  JsonSockEvent *json = sockEmit.beginEmit(evt);
  json->beginObject();
  json->addElem("shadeId", this->shadeId);
  json->addElem("type", static_cast<uint8_t>(this->shadeType));
  json->addElem("remoteAddress", (uint32_t)this->getRemoteAddress());
  json->addElem("name", this->name);
  json->addElem("direction", this->direction);
  json->addElem("position", this->transformPosition(this->currentPos));
  json->addElem("target", this->transformPosition(this->target));
  json->addElem("myPos", this->transformPosition(this->myPos));
  json->addElem("tiltType", static_cast<uint8_t>(this->tiltType));
  json->addElem("flipCommands", this->flipCommands);
  json->addElem("flipPosition", this->flipPosition);
  json->addElem("flags", this->flags);
  json->addElem("sunSensor", this->hasSunSensor());
  json->addElem("light", this->hasLight());
  json->addElem("sortOrder", this->sortOrder);
  if(this->tiltType != tilt_types::none) {
    json->addElem("tiltDirection", this->tiltDirection);
    json->addElem("tiltTarget", this->transformPosition(this->tiltTarget));
    json->addElem("tiltPosition", this->transformPosition(this->currentTiltPos));
    json->addElem("myTiltPos", this->transformPosition(this->myTiltPos));
  }
  json->endObject();
  sockEmit.endEmit(num);
  /*
  char buf[420];
  if(this->tiltType != tilt_types::none)
    snprintf(buf, sizeof(buf), "{\"shadeId\":%d,\"type\":%u,\"remoteAddress\":%d,\"name\":\"%s\",\"direction\":%d,\"position\":%d,\"target\":%d,\"myPos\":%d,\"myTiltPos\":%d,\"tiltType\":%u,\"tiltDirection\":%d,\"tiltTarget\":%d,\"tiltPosition\":%d,\"flipCommands\":%s,\"flipPosition\":%s,\"flags\":%d,\"sunSensor\":%s,\"light\":%s,\"sortOrder\":%d}", 
      this->shadeId, static_cast<uint8_t>(this->shadeType), this->getRemoteAddress(), this->name, this->direction, 
      this->transformPosition(this->currentPos), this->transformPosition(this->target), this->transformPosition(this->myPos), this->transformPosition(this->myTiltPos), static_cast<uint8_t>(this->tiltType), this->tiltDirection, 
      this->transformPosition(this->tiltTarget), this->transformPosition(this->currentTiltPos),
      this->flipCommands ? "true" : "false", this->flipPosition ? "true": "false", this->flags, this->hasSunSensor() ? "true" : "false", this->hasLight() ? "true" : "false", this->sortOrder);
  else
    snprintf(buf, sizeof(buf), "{\"shadeId\":%d,\"type\":%u,\"remoteAddress\":%d,\"name\":\"%s\",\"direction\":%d,\"position\":%d,\"target\":%d,\"myPos\":%d,\"tiltType\":%u,\"flipCommands\":%s,\"flipPosition\":%s,\"flags\":%d,\"sunSensor\":%s,\"light\":%s,\"sortOrder\":%d}", 
      this->shadeId, static_cast<uint8_t>(this->shadeType), this->getRemoteAddress(), this->name, this->direction, 
      this->transformPosition(this->currentPos), this->transformPosition(this->target), this->transformPosition(this->myPos), 
      static_cast<uint8_t>(this->tiltType), this->flipCommands ? "true" : "false", this->flipPosition ? "true": "false", this->flags, this->hasSunSensor() ? "true" : "false", this->hasLight() ? "true" : "false", this->sortOrder);
  if(num >= 255) sockEmit.sendToClients(evt, buf);
  else sockEmit.sendToClient(num, evt, buf);
  */
}
void SomfyShade::emitCommand(somfy_commands cmd, const char *source, uint32_t sourceAddress, const char *evt) { this->emitCommand(255, cmd, source, sourceAddress, evt); }
void SomfyShade::emitCommand(uint8_t num, somfy_commands cmd, const char *source, uint32_t sourceAddress, const char *evt) {
  JsonSockEvent *json = sockEmit.beginEmit(evt);
  json->beginObject();
  json->addElem("shadeId", this->shadeId);
  json->addElem("remoteAddress", (uint32_t)this->getRemoteAddress());
  json->addElem("cmd", translateSomfyCommand(cmd).c_str());
  json->addElem("source", source);
  json->addElem("rcode", (uint32_t)this->lastRollingCode);
  json->addElem("sourceAddress", (uint32_t)sourceAddress);
  json->endObject();
  sockEmit.endEmit(num);
  /*
  ClientSocketEvent e(evt);
  char buf[30];
  snprintf(buf, sizeof(buf), "{\"shadeId\":%d", this->shadeId);
  e.appendMessage(buf);
  snprintf(buf, sizeof(buf), ",\"remoteAddress\":%d", this->getRemoteAddress());
  e.appendMessage(buf);
  snprintf(buf, sizeof(buf), ",\"cmd\":\"%s\"", translateSomfyCommand(cmd).c_str());
  e.appendMessage(buf);
  snprintf(buf, sizeof(buf), ",\"source\":\"%s\"", source);
  e.appendMessage(buf);
  snprintf(buf, sizeof(buf), ",\"rcode\":%d", this->lastRollingCode);
  e.appendMessage(buf);
  snprintf(buf, sizeof(buf), ",\"sourceAddress\":%d}", sourceAddress);
  e.appendMessage(buf);
  if(num >= 255) sockEmit.sendToClients(&e);
  else sockEmit.sendToClient(num, &e);
  */
  if(mqtt.connected()) {
    this->publish("cmdSource", source);
    this->publish("cmdAddress", sourceAddress);
    this->publish("cmd", translateSomfyCommand(cmd).c_str());
  }
}
void SomfyRoom::emitState(const char *evt) { this->emitState(255, evt); }
void SomfyRoom::emitState(uint8_t num, const char *evt) {
  JsonSockEvent *json = sockEmit.beginEmit(evt);
  json->beginObject();
  json->addElem("roomId", this->roomId);
  json->addElem("name", this->name);
  json->addElem("sortOrder", this->sortOrder);
  json->endObject();
  sockEmit.endEmit(num);
  /*
  ClientSocketEvent e(evt);
  char buf[55];
  uint8_t flags = 0;
  snprintf(buf, sizeof(buf), "{\"roomId\":%d,", this->roomId);
  e.appendMessage(buf);
  snprintf(buf, sizeof(buf), "\"name\":\"%s\",", this->name);
  e.appendMessage(buf);
  snprintf(buf, sizeof(buf), "\"sortOrder\":%d}", this->sortOrder);
  e.appendMessage(buf);
  if(num >= 255) sockEmit.sendToClients(&e);
  else sockEmit.sendToClient(num, &e);
  */
  this->publish();
}
void SomfyGroup::emitState(const char *evt) { this->emitState(255, evt); }
void SomfyGroup::emitState(uint8_t num, const char *evt) {
  uint8_t flags = 0;
  JsonSockEvent *json = sockEmit.beginEmit(evt);
  json->beginObject();
  json->addElem("groupId", this->groupId);
  json->addElem("remoteAddress", (uint32_t)this->getRemoteAddress());
  json->addElem("name", this->name);
  json->addElem("sunSensor", this->hasSunSensor());
  json->beginArray("shades");
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPED_SHADES; i++) {
    if(this->linkedShades[i] != 255 && this->linkedShades[i] != 0) {
      SomfyShade *shade = somfy.getShadeById(this->linkedShades[i]);
      if(shade) {
        json->addElem(this->linkedShades[i]);
        // Must stay inside the guard: a group can hold the id of a shade that was
        // since deleted, and dereferencing that null crashed emitState (LoadProhibited).
        flags |= shade->flags;
      }
    }
  }
  json->endArray();
  json->addElem("flags", flags);
  json->endObject();
  sockEmit.endEmit(num);
  /*
  ClientSocketEvent e(evt);
  char buf[55];
  uint8_t flags = 0;
  snprintf(buf, sizeof(buf), "{\"groupId\":%d,", this->groupId);
  e.appendMessage(buf);
  snprintf(buf, sizeof(buf), "\"remoteAddress\":%d,", this->getRemoteAddress());
  e.appendMessage(buf);
  snprintf(buf, sizeof(buf), "\"name\":\"%s\",", this->name);
  e.appendMessage(buf);
  snprintf(buf, sizeof(buf), "\"sunSensor\":%s,", this->hasSunSensor() ? "true" : "false");
  e.appendMessage(buf);
  snprintf(buf, sizeof(buf), "\"shades\":[");
  e.appendMessage(buf);
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPED_SHADES; i++) {
    if(this->linkedShades[i] != 255) {
      if(this->linkedShades[i] != 0) {
        SomfyShade *shade = somfy.getShadeById(this->linkedShades[i]);
        if(shade) {
          flags |= shade->flags;
          snprintf(buf, sizeof(buf), "%s%d", i != 0 ? "," : "", this->linkedShades[i]);
          e.appendMessage(buf);
        }
      }
    }
  }
  snprintf(buf, sizeof(buf), "],\"flags\":%d}", flags);
  e.appendMessage(buf);
  
  if(num >= 255) sockEmit.sendToClients(&e);
  else sockEmit.sendToClient(num, &e);
  */
  this->publish();
}

void SomfyShadeController::emitState(uint8_t num) {
  for(uint8_t i = 0; i < SOMFY_MAX_SHADES; i++) {
    SomfyShade *shade = &this->shades[i];
    if(shade->getShadeId() == 255) continue;
    shade->emitState(num);
  }
}
void SomfyShadeController::publish() {
  this->updateGroupFlags();
  char arrIds[128] = "[";
  for(uint8_t i = 0; i < SOMFY_MAX_SHADES; i++) {
    SomfyShade *shade = &this->shades[i];
    if(shade->getShadeId() == 255) continue;
    if(strlen(arrIds) > 1) strcat(arrIds, ",");
    itoa(shade->getShadeId(), &arrIds[strlen(arrIds)], 10);
    shade->publish();
  }
  strcat(arrIds, "]");
  mqtt.publish("shades", arrIds, true);
  // Sweep stale retained topics for empty slots only once per boot. Deletions already
  // unpublish at delete time (deleteShade/deleteGroup), so repeating this on every MQTT
  // reconnect just spammed the broker with ~21 messages per empty slot (hundreds total).
  static bool sweptEmptySlots = false;
  if(!sweptEmptySlots) {
    for(uint8_t i = 1; i <= SOMFY_MAX_SHADES; i++) {
      if(!this->getShadeById(i)) SomfyShade::unpublish(i);
    }
  }
  strcpy(arrIds, "[");
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPS; i++) {
    SomfyGroup *group = &this->groups[i];
    if(group->getGroupId() == 255) continue;
    if(strlen(arrIds) > 1) strcat(arrIds, ",");
    itoa(group->getGroupId(), &arrIds[strlen(arrIds)], 10);
    group->publish();
  }
  strcat(arrIds, "]");
  mqtt.publish("groups", arrIds, true);
  if(!sweptEmptySlots) {
    for(uint8_t i = 1; i <= SOMFY_MAX_GROUPS; i++) {
      if(!this->getGroupById(i)) SomfyGroup::unpublish(i);
    }
    sweptEmptySlots = true;
  }
}
