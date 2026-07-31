#include <WiFi.h>
#include <WebServer.h>
#include <LittleFS.h>
#include "ConfigSettings.h"
#include "Utils.h"
#include "Somfy.h"
#include "WResp.h"
#include "Web.h"

// Route registrations for the shade/room/group entity endpoints, split out of
// Web::begin().  The lambdas capture nothing and reference the globals shared
// through Web.h.
// The mutation handlers are written against the WebRequest facade: the same
// body serves the sync server here and the async server (WebAsync.cpp), so
// the two transports cannot drift apart.

extern ConfigSettings settings;
extern SomfyShadeController somfy;
extern Web webServer;

// ---- Transport-neutral mutation handlers. ---------------------------------
void Web::handleAddRoom(WebRequest &req) {
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  HTTPMethod method = req.method();
  SomfyRoom * room = nullptr;
  if (method == HTTP_POST || method == HTTP_PUT) {
    Serial.println("Adding a room");
    DynamicJsonDocument doc(512);
    DeserializationError err = deserializeJson(doc, req.body());
    if (err) {
      this->sendDeserializationError(req, err);
      return;
    }
    else {
      JsonObject obj = doc.as<JsonObject>();
      if (somfy.roomCount() > SOMFY_MAX_ROOMS) {
        req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Maximum number of rooms exceeded.\"}");
        return;
      }
      else {
        room = somfy.addRoom(obj);
        if (!room) {
          req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Error adding room.\"}");
          return;
        }
      }
    }
  }
  if (room) {
    JsonResponse &resp = req.beginJson();
    resp.beginObject();
    room->toJSON(resp);
    resp.endObject();
    req.endJson();
  }
  else {
    req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Error saving Somfy Room.\"}");
  }
}
void Web::handleAddShade(WebRequest &req) {
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  HTTPMethod method = req.method();
  SomfyShade* shade = nullptr;
  if (method == HTTP_POST || method == HTTP_PUT) {
    Serial.println("Adding a shade");
    DynamicJsonDocument doc(1024);
    DeserializationError err = deserializeJson(doc, req.body());
    if (err) {
      this->sendDeserializationError(req, err);
      return;
    }
    else {
      JsonObject obj = doc.as<JsonObject>();
      if (somfy.shadeCount() > SOMFY_MAX_SHADES) {
        req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Maximum number of shades exceeded.\"}");
        return;
      }
      else {
        shade = somfy.addShade(obj);
        if (!shade) {
          req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Error adding shade.\"}");
          return;
        }
      }
    }
  }
  if (shade) {
    JsonResponse &resp = req.beginJson();
    resp.beginObject();
    shade->toJSON(resp);
    resp.endObject();
    req.endJson();
  }
  else {
    req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Error saving Somfy Shade.\"}");
  }
}
void Web::handleAddGroup(WebRequest &req) {
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  HTTPMethod method = req.method();
  SomfyGroup * group = nullptr;
  if (method == HTTP_POST || method == HTTP_PUT) {
    Serial.println("Adding a group");
    DynamicJsonDocument doc(512);
    DeserializationError err = deserializeJson(doc, req.body());
    if (err) {
      this->sendDeserializationError(req, err);
      return;
    }
    else {
      JsonObject obj = doc.as<JsonObject>();
      if (somfy.groupCount() > SOMFY_MAX_GROUPS) {
        req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Maximum number of groups exceeded.\"}");
        return;
      }
      else {
        group = somfy.addGroup(obj);
        if (!group) {
          req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Error adding group.\"}");
          return;
        }
      }
    }
  }
  if (group) {
    JsonResponse &resp = req.beginJson();
    resp.beginObject();
    group->toJSON(resp);
    resp.endObject();
    req.endJson();
  }
  else {
    req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Error saving Somfy Group.\"}");
  }
}
void Web::handleGroupOptions(WebRequest &req) {
  webServer.lastActivity = millis();
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  HTTPMethod method = req.method();
  if (method == HTTP_GET || method == HTTP_POST) {
    if (req.hasParam("groupId")) {
      int groupId = atoi(req.param("groupId").c_str());
      SomfyGroup* group = somfy.getGroupById(groupId);
      if (group) {
        JsonResponse &resp = req.beginJson();
        resp.beginObject();
        group->toJSON(resp);
        resp.beginArray("availShades");
        for(uint8_t i = 0; i < SOMFY_MAX_SHADES; i++) {
          SomfyShade *shade = &somfy.shades[i];
          if(shade->getShadeId() != 255) {
            bool isLinked = false;
            for(uint8_t j = 0; j < SOMFY_MAX_GROUPED_SHADES; j++) {
              if(group->linkedShades[j] == shade->getShadeId()) {
                isLinked = true;
                break;
              }
            }
            if(!isLinked) {
              resp.beginObject();
              shade->toJSONRef(resp);
              resp.endObject();
            }
          }
        }
        resp.endArray();
        resp.endObject();
        req.endJson();
      }
      else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Group Id not found.\"}");
    }
    else {
      req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"You must supply a valid group id.\"}");
    }
  }
}
void Web::handleSaveRoom(WebRequest &req) {
  webServer.lastActivity = millis();
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  HTTPMethod method = req.method();
  if (method == HTTP_PUT || method == HTTP_POST) {
    // We are updating an existing room.
    if (req.hasBody()) {
      Serial.println("Updating a room");
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, req.body());
      if (err) {
        this->sendDeserializationError(req, err);
        return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        if (obj.containsKey("roomId")) {
          SomfyRoom* room = somfy.getRoomById(obj["roomId"]);
          if (room) {
            room->fromJSON(obj);
            room->save();
            JsonResponse &resp = req.beginJson();
            resp.beginObject();
            room->toJSON(resp);
            resp.endObject();
            req.endJson();
          }
          else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Room Id not found.\"}");
        }
        else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No room id was supplied.\"}");
      }
    }
    else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No room object supplied.\"}");
  }
}
void Web::handleSaveShade(WebRequest &req) {
  webServer.lastActivity = millis();
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  HTTPMethod method = req.method();
  if (method == HTTP_PUT || method == HTTP_POST) {
    // We are updating an existing shade.
    if (req.hasBody()) {
      Serial.println("Updating a shade");
      DynamicJsonDocument doc(1024);
      DeserializationError err = deserializeJson(doc, req.body());
      if (err) {
        this->sendDeserializationError(req, err);
        return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        if (obj.containsKey("shadeId")) {
          SomfyShade* shade = somfy.getShadeById(obj["shadeId"]);
          if (shade) {
            int8_t err = shade->fromJSON(obj);
            if(err == 0) {
              shade->save();
              JsonResponse &resp = req.beginJson();
              resp.beginObject();
              shade->toJSON(resp);
              resp.endObject();
              req.endJson();
            }
            else {
              char msg[80];
              snprintf(msg, sizeof(msg), "{\"status\":\"DATA\",\"desc\":\"Data Error.\", \"code\":%d}", err);
              req.send(500, _encoding_json, msg);
            }
          }
          else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Shade Id not found.\"}");
        }
        else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No shade id was supplied.\"}");
      }
    }
    else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No shade object supplied.\"}");
  }
}
void Web::handleSaveGroup(WebRequest &req) {
  webServer.lastActivity = millis();
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  HTTPMethod method = req.method();
  if (method == HTTP_PUT || method == HTTP_POST) {
    // We are updating an existing group.
    if (req.hasBody()) {
      Serial.println("Updating a group");
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, req.body());
      if (err) {
        this->sendDeserializationError(req, err);
        return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        if (obj.containsKey("groupId")) {
          SomfyGroup* group = somfy.getGroupById(obj["groupId"]);
          if (group) {
            group->fromJSON(obj);
            group->save();
            JsonResponse &resp = req.beginJson();
            resp.beginObject();
            group->toJSON(resp);
            resp.endObject();
            req.endJson();
          }
          else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Group Id not found.\"}");
        }
        else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No group id was supplied.\"}");
      }
    }
    else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No group object supplied.\"}");
  }
}
void Web::handleSetMyPosition(WebRequest &req) {
  webServer.lastActivity = millis();
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  HTTPMethod method = req.method();
  uint8_t shadeId = 255;
  int8_t pos = -1;
  int8_t tilt = -1;
  if (method == HTTP_GET || method == HTTP_PUT || method == HTTP_POST) {
    if (req.hasParam("shadeId")) {
      shadeId = atoi(req.param("shadeId").c_str());
      if(req.hasParam("pos")) pos = atoi(req.param("pos").c_str());
      if(req.hasParam("tilt")) tilt = atoi(req.param("tilt").c_str());
    }
    else if (req.hasBody()) {
      DynamicJsonDocument doc(256);
      DeserializationError err = deserializeJson(doc, req.body());
      if (err) {
        this->sendDeserializationError(req, err);
        return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        if (obj.containsKey("shadeId")) shadeId = obj["shadeId"];
        else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No shade id was supplied.\"}");
        if(obj.containsKey("pos")) pos = obj["pos"].as<int8_t>();
        if(obj.containsKey("tilt")) tilt = obj["tilt"].as<int8_t>();
      }
    }
    else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No shade object supplied.\"}");
    SomfyShade* shade = somfy.getShadeById(shadeId);
    if (shade) {
      // Send the command to the shade.
      if(tilt < 0) tilt = shade->myPos;
      if(shade->tiltType == tilt_types::none) tilt = -1;
      if(pos >= 0 && pos <= 100)
        shade->setMyPosition(shade->transformPosition(pos), shade->transformPosition(tilt));
      // Answered whether or not the position was in range, like it always did.
      JsonResponse &resp = req.beginJson();
      resp.beginObject();
      shade->toJSONRef(resp);
      resp.endObject();
      req.endJson();
    }
    else {
      req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Shade with the specified id not found.\"}");
    }
  }
  else
    req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Invalid Http method\"}");
}
void Web::handleSetRollingCode(WebRequest &req) {
  webServer.lastActivity = millis();
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  HTTPMethod method = req.method();
  if (method == HTTP_PUT || method == HTTP_POST) {
    uint8_t shadeId = 255;
    uint16_t rollingCode = 0;
    if (req.hasBody()) {
      // Its coming in the body.
      StaticJsonDocument<129> doc;
      DeserializationError err = deserializeJson(doc, req.body());
      if (err) {
        this->sendDeserializationError(req, err);
        return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        if (obj.containsKey("shadeId")) shadeId = obj["shadeId"];
        if(obj.containsKey("rollingCode")) rollingCode = obj["rollingCode"];
      }
    }
    else if (req.hasParam("shadeId")) {
      shadeId = atoi(req.param("shadeId").c_str());
      rollingCode = atoi(req.param("rollingCode").c_str());
    }
    SomfyShade* shade = nullptr;
    if (shadeId != 255) shade = somfy.getShadeById(shadeId);
    if (!shade) {
      req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Shade not found to set rolling code\"}");
    }
    else {
      shade->setRollingCode(rollingCode);
      JsonResponse &resp = req.beginJson();
      resp.beginObject();
      shade->toJSON(resp);
      resp.endObject();
      req.endJson();
    }
  }
}
void Web::handleSetPaired(WebRequest &req) {
  webServer.lastActivity = millis();
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  uint8_t shadeId = 255;
  bool paired = false;
  if(req.hasBody()) {
    DynamicJsonDocument doc(512);
    DeserializationError err = deserializeJson(doc, req.body());
    if(err) {
      this->sendDeserializationError(req, err);
      return;
    }
    else {
      JsonObject obj = doc.as<JsonObject>();
      if (obj.containsKey("shadeId")) shadeId = obj["shadeId"];
      if(obj.containsKey("paired")) paired = obj["paired"];
    }
  }
  else if (req.hasParam("shadeId"))
    shadeId = atoi(req.param("shadeId").c_str());
  if(req.hasParam("paired"))
    paired = toBoolean(req.param("paired").c_str(), false);
  SomfyShade* shade = nullptr;
  if (shadeId != 255) shade = somfy.getShadeById(shadeId);
  if (!shade) {
    req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Shade not found to pair\"}");
  }
  else {
    shade->paired = paired;
    shade->save();
    JsonResponse &resp = req.beginJson();
    resp.beginObject();
    shade->toJSON(resp);
    resp.endObject();
    req.endJson();
  }
}
void Web::handleUnpairShade(WebRequest &req) {
  webServer.lastActivity = millis();
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  HTTPMethod method = req.method();
  if (method == HTTP_PUT || method == HTTP_POST) {
    uint8_t shadeId = 255;
    if (req.hasBody()) {
      // Its coming in the body.
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, req.body());
      if (err) {
        this->sendDeserializationError(req, err);
        return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        if (obj.containsKey("shadeId")) shadeId = obj["shadeId"];
      }
    }
    else if (req.hasParam("shadeId"))
      shadeId = atoi(req.param("shadeId").c_str());
    SomfyShade* shade = nullptr;
    if (shadeId != 255) shade = somfy.getShadeById(shadeId);
    if (!shade) {
      req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Shade not found to unpair\"}");
    }
    else {
      if(shade->bitLength == 56)
        shade->sendCommand(somfy_commands::Prog, 7);
      else
        shade->sendCommand(somfy_commands::Prog, 1);
      shade->paired = false;
      shade->save();
      JsonResponse &resp = req.beginJson();
      resp.beginObject();
      shade->toJSON(resp);
      resp.endObject();
      req.endJson();
    }
  }
}
void Web::handleLinkRepeater(WebRequest &req) {
  webServer.lastActivity = millis();
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  HTTPMethod method = req.method();
  if (method == HTTP_PUT || method == HTTP_POST) {
    // We are adding a linked repeater.
    uint32_t address = 0;
    if (req.hasBody()) {
      Serial.println("Linking a repeater");
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, req.body());
      if (err) {
        this->sendDeserializationError(req, err);
        return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        if (obj.containsKey("address")) address = obj["address"];
        else if(obj.containsKey("remoteAddress")) address = obj["remoteAddress"];
      }
    }
    else if(req.hasParam("address"))
      address = atoi(req.param("address").c_str());
    if(address == 0)
      req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No repeater address was supplied.\"}");
    else {
      somfy.linkRepeater(address);
      JsonResponse &resp = req.beginJson();
      resp.beginArray();
      somfy.toJSONRepeaters(resp);
      resp.endArray();
      req.endJson();
    }
  }
}
void Web::handleUnlinkRepeater(WebRequest &req) {
  webServer.lastActivity = millis();
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  HTTPMethod method = req.method();
  if (method == HTTP_PUT || method == HTTP_POST) {
    // We are removing a linked repeater.
    uint32_t address = 0;
    if (req.hasBody()) {
      Serial.println("Unlinking a repeater");
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, req.body());
      if (err) {
        this->sendDeserializationError(req, err);
        return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        if (obj.containsKey("address")) address = obj["address"];
        else if(obj.containsKey("remoteAddress")) address = obj["remoteAddress"];
      }
    }
    else if(req.hasParam("address"))
      address = atoi(req.param("address").c_str());
    if(address == 0)
      req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No repeater address was supplied.\"}");
    else {
      somfy.unlinkRepeater(address);
      JsonResponse &resp = req.beginJson();
      resp.beginArray();
      somfy.toJSONRepeaters(resp);
      resp.endArray();
      req.endJson();
    }
  }
}
void Web::handleUnlinkRemote(WebRequest &req) {
  webServer.lastActivity = millis();
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  HTTPMethod method = req.method();
  if (method == HTTP_PUT || method == HTTP_POST) {
    // We are updating an existing shade by removing a linked remote.
    if (req.hasBody()) {
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, req.body());
      if (err) {
        this->sendDeserializationError(req, err);
        return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        if (obj.containsKey("shadeId")) {
          SomfyShade* shade = somfy.getShadeById(obj["shadeId"]);
          if (shade) {
            if (obj.containsKey("remoteAddress")) {
              shade->unlinkRemote(obj["remoteAddress"]);
            }
            else {
              req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Remote address not provided.\"}");
            }
            // Historical quirk kept as-is: the shade JSON is still emitted after
            // the missing-address error; the first response wins on the wire.
            JsonResponse &resp = req.beginJson();
            resp.beginObject();
            shade->toJSON(resp);
            resp.endObject();
            req.endJson();
          }
          else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Shade Id not found.\"}");
        }
        else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No shade id was supplied.\"}");
      }
    }
    else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No remote object supplied.\"}");
  }
}
void Web::handleLinkRemote(WebRequest &req) {
  webServer.lastActivity = millis();
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  HTTPMethod method = req.method();
  if (method == HTTP_PUT || method == HTTP_POST) {
    // We are updating an existing shade by adding a linked remote.
    if (req.hasBody()) {
      Serial.println("Linking a remote");
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, req.body());
      if (err) {
        this->sendDeserializationError(req, err);
        return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        if (obj.containsKey("shadeId")) {
          SomfyShade* shade = somfy.getShadeById(obj["shadeId"]);
          if (shade) {
            if (obj.containsKey("remoteAddress")) {
              if (obj.containsKey("rollingCode")) shade->linkRemote(obj["remoteAddress"], obj["rollingCode"]);
              else shade->linkRemote(obj["remoteAddress"]);
            }
            else {
              req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Remote address not provided.\"}");
            }
            // Same historical quirk as unlinkRemote above.
            JsonResponse &resp = req.beginJson();
            resp.beginObject();
            shade->toJSON(resp);
            resp.endObject();
            req.endJson();
          }
          else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Shade Id not found.\"}");
        }
        else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No shade id was supplied.\"}");
      }
    }
    else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No remote object supplied.\"}");
  }
}
void Web::handleLinkToGroup(WebRequest &req) {
  webServer.lastActivity = millis();
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  HTTPMethod method = req.method();
  if (method == HTTP_PUT || method == HTTP_POST) {
    if (req.hasBody()) {
      Serial.println("Linking a shade to a group");
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, req.body());
      if (err) {
        this->sendDeserializationError(req, err);
        return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        uint8_t shadeId = obj.containsKey("shadeId") ? obj["shadeId"] : 0;
        uint8_t groupId = obj.containsKey("groupId") ? obj["groupId"] : 0;
        if(groupId == 0) {
          req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Group id not provided.\"}");
          return;
        }
        if(shadeId == 0) {
          req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Shade id not provided.\"}");
          return;
        }
        SomfyGroup * group = somfy.getGroupById(groupId);
        if(!group) {
          req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Group id not found.\"}");
          return;
        }
        SomfyShade * shade = somfy.getShadeById(shadeId);
        if(!shade) {
          req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Shade id not found.\"}");
          return;
        }
        group->linkShade(shadeId);
        JsonResponse &resp = req.beginJson();
        resp.beginObject();
        group->toJSON(resp);
        resp.endObject();
        req.endJson();
      }
    }
    else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No linking object supplied.\"}");
  }
}
void Web::handleUnlinkFromGroup(WebRequest &req) {
  webServer.lastActivity = millis();
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  HTTPMethod method = req.method();
  if (method == HTTP_PUT || method == HTTP_POST) {
    if (req.hasBody()) {
      Serial.println("Unlinking a shade from a group");
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, req.body());
      if (err) {
        this->sendDeserializationError(req, err);
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        uint8_t shadeId = obj.containsKey("shadeId") ? obj["shadeId"] : 0;
        uint8_t groupId = obj.containsKey("groupId") ? obj["groupId"] : 0;
        if(groupId == 0) {
          req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Group id not provided.\"}");
          return;
        }
        if(shadeId == 0) {
          req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Shade id not provided.\"}");
          return;
        }
        SomfyGroup * group = somfy.getGroupById(groupId);
        if(!group) {
          req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Group id not found.\"}");
          return;
        }
        SomfyShade * shade = somfy.getShadeById(shadeId);
        if(!shade) {
          req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Shade id not found.\"}");
          return;
        }
        group->unlinkShade(shadeId);
        JsonResponse &resp = req.beginJson();
        resp.beginObject();
        group->toJSON(resp);
        resp.endObject();
        req.endJson();
      }
    }
    else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No unlinking object supplied.\"}");
  }
}
void Web::handleDeleteRoom(WebRequest &req) {
  webServer.lastActivity = millis();
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  HTTPMethod method = req.method();
  uint8_t roomId = 0;
  if (method == HTTP_GET || method == HTTP_PUT || method == HTTP_POST) {
    if (req.hasParam("roomId")) {
      roomId = atoi(req.param("roomId").c_str());
    }
    else if (req.hasBody()) {
      Serial.println("Deleting a Room");
      DynamicJsonDocument doc(256);
      DeserializationError err = deserializeJson(doc, req.body());
      if (err) {
        this->sendDeserializationError(req, err);
        return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        if (obj.containsKey("roomId")) roomId = obj["roomId"];
        else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No room id was supplied.\"}");
      }
    }
    else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No room object supplied.\"}");
  }
  SomfyRoom* room = somfy.getRoomById(roomId);
  if (!room) req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Room with the specified id not found.\"}");
  else {
    somfy.deleteRoom(roomId);
    req.send(200, _encoding_json, "{\"status\":\"SUCCESS\",\"desc\":\"Room deleted.\"}");
  }
}
void Web::handleDeleteShade(WebRequest &req) {
  webServer.lastActivity = millis();
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  HTTPMethod method = req.method();
  uint8_t shadeId = 255;
  if (method == HTTP_GET || method == HTTP_PUT || method == HTTP_POST) {
    if (req.hasParam("shadeId")) {
      shadeId = atoi(req.param("shadeId").c_str());
    }
    else if (req.hasBody()) {
      Serial.println("Deleting a shade");
      DynamicJsonDocument doc(256);
      DeserializationError err = deserializeJson(doc, req.body());
      if (err) {
        this->sendDeserializationError(req, err);
        return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        if (obj.containsKey("shadeId")) shadeId = obj["shadeId"];
        else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No shade id was supplied.\"}");
      }
    }
    else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No shade object supplied.\"}");
  }
  SomfyShade* shade = somfy.getShadeById(shadeId);
  if (!shade) req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Shade with the specified id not found.\"}");
  else if(shade->isInGroup()) {
    req.send(400, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"This shade is a member of a group and cannot be deleted.\"}");
  }
  else {
    somfy.deleteShade(shadeId);
    req.send(200, _encoding_json, "{\"status\":\"SUCCESS\",\"desc\":\"Shade deleted.\"}");
  }
}
void Web::handleDeleteGroup(WebRequest &req) {
  webServer.lastActivity = millis();
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  HTTPMethod method = req.method();
  uint8_t groupId = 255;
  if (method == HTTP_GET || method == HTTP_PUT || method == HTTP_POST) {
    if (req.hasParam("groupId")) {
      groupId = atoi(req.param("groupId").c_str());
    }
    else if (req.hasBody()) {
      Serial.println("Deleting a group");
      DynamicJsonDocument doc(256);
      DeserializationError err = deserializeJson(doc, req.body());
      if (err) {
        this->sendDeserializationError(req, err);
        return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        if (obj.containsKey("groupId")) groupId = obj["groupId"];
        else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No group id was supplied.\"}");
      }
    }
    else req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"No group object supplied.\"}");
  }
  SomfyGroup * group = somfy.getGroupById(groupId);
  if (!group) req.send(500, _encoding_json, "{\"status\":\"ERROR\",\"desc\":\"Group with the specified id not found.\"}");
  else {
    somfy.deleteGroup(groupId);
    req.send(200, _encoding_json, "{\"status\":\"SUCCESS\",\"desc\":\"Group deleted.\"}");
  }
}
void Web::handleRoomSortOrder(WebRequest &req) {
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  DynamicJsonDocument doc(512);
  DeserializationError err = deserializeJson(doc, req.body());
  if (err) {
    this->sendDeserializationError(req, err);
    return;
  }
  else {
    JsonArray arr = doc.as<JsonArray>();
    HTTPMethod method = req.method();
    if (method == HTTP_POST || method == HTTP_PUT) {
      // Parse out all the inputs.
      uint8_t order = 0;
      for(JsonVariant v : arr) {
        uint8_t roomId = v.as<uint8_t>();
        if (roomId != 0) {
          SomfyRoom *room = somfy.getRoomById(roomId);
          if(room) room->sortOrder = order++;
        }
      }
      req.send(200, "application/json", "{\"status\":\"OK\",\"desc\":\"Successfully set room order\"}");
    }
    else {
      req.send(201, "application/json", "{\"status\":\"ERROR\",\"desc\":\"Invalid HTTP Method: \"}");
    }
  }
}
void Web::handleShadeSortOrder(WebRequest &req) {
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  DynamicJsonDocument doc(512);
  DeserializationError err = deserializeJson(doc, req.body());
  if (err) {
    this->sendDeserializationError(req, err);
    return;
  }
  else {
    JsonArray arr = doc.as<JsonArray>();
    HTTPMethod method = req.method();
    if (method == HTTP_POST || method == HTTP_PUT) {
      // Parse out all the inputs.
      uint8_t order = 0;
      for(JsonVariant v : arr) {
        uint8_t shadeId = v.as<uint8_t>();
        if (shadeId != 255) {
          SomfyShade *shade = somfy.getShadeById(shadeId);
          if(shade) shade->sortOrder = order++;
        }
      }
      req.send(200, "application/json", "{\"status\":\"OK\",\"desc\":\"Successfully set shade order\"}");
    }
    else {
      req.send(201, "application/json", "{\"status\":\"ERROR\",\"desc\":\"Invalid HTTP Method: \"}");
    }
  }
}
void Web::handleGroupSortOrder(WebRequest &req) {
  if(req.method() == HTTP_OPTIONS) { req.send(200, "OK", ""); return; }
  if(!req.ensureAuth(true)) return;
  DynamicJsonDocument doc(512);
  DeserializationError err = deserializeJson(doc, req.body());
  if (err) {
    this->sendDeserializationError(req, err);
    return;
  }
  else {
    JsonArray arr = doc.as<JsonArray>();
    HTTPMethod method = req.method();
    if (method == HTTP_POST || method == HTTP_PUT) {
      // Parse out all the inputs.
      uint8_t order = 0;
      for(JsonVariant v : arr) {
        uint8_t groupId = v.as<uint8_t>();
        if (groupId != 255) {
          SomfyGroup *group = somfy.getGroupById(groupId);
          if(group) group->sortOrder = order++;
        }
      }
      req.send(200, "application/json", "{\"status\":\"OK\",\"desc\":\"Successfully set group order\"}");
    }
    else {
      req.send(201, "application/json", "{\"status\":\"ERROR\",\"desc\":\"Invalid HTTP Method: \"}");
    }
  }
}

void Web::beginShadeRoutes() {
  server.on("/controller", []() { webServer.handleController(server); });
  server.on("/rooms", []() { webServer.handleGetRooms(server); });
  server.on("/shades", []() { webServer.handleGetShades(server); });
  server.on("/groups", []() { webServer.handleGetGroups(server); });
  server.on("/room", []() { webServer.handleRoom(server); });
  server.on("/shade", []() { webServer.handleShade(server); });
  server.on("/group", []() { webServer.handleGroup(server); });
  server.on("/getNextRoom", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    JsonResponse resp;
    resp.beginResponse(&server, g_content, sizeof(g_content));
    resp.beginObject();
    resp.addElem("roomId", somfy.getNextRoomId());
    resp.endObject();
    resp.endResponse();
  });
  server.on("/getNextShade", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    uint8_t shadeId = somfy.getNextShadeId();
    JsonResponse resp;
    resp.beginResponse(&server, g_content, sizeof(g_content));
    resp.beginObject();
    resp.addElem("shadeId", shadeId);
    resp.addElem("remoteAddress", (uint32_t)somfy.getNextRemoteAddress(shadeId));
    resp.addElem("bitLength", somfy.transceiver.config.type);
    resp.addElem("stepSize", (uint8_t)100);
    resp.addElem("proto", static_cast<uint8_t>(somfy.transceiver.config.proto));
    resp.endObject();
    resp.endResponse();
    });
  server.on("/getNextGroup", []() {
    webServer.sendCORSHeaders(server);
    uint8_t groupId = somfy.getNextGroupId();
    JsonResponse resp;
    resp.beginResponse(&server, g_content, sizeof(g_content));
    resp.beginObject();
    resp.addElem("groupId", groupId);
    resp.addElem("remoteAddress", (uint32_t)somfy.getNextRemoteAddress(groupId));
    resp.addElem("bitLength", somfy.transceiver.config.type);
    resp.addElem("proto", static_cast<uint8_t>(somfy.transceiver.config.proto));
    resp.endObject();
    resp.endResponse();
    });
  // Mutations: shared WebRequest cores above, sync shells below. The async
  // twins are registered in WebAsync.cpp from the same cores.
  server.on("/addRoom", []() { WebSyncRequest req(server); webServer.handleAddRoom(req); });
  server.on("/addShade", []() { WebSyncRequest req(server); webServer.handleAddShade(req); });
  server.on("/addGroup", []() { WebSyncRequest req(server); webServer.handleAddGroup(req); });
  server.on("/groupOptions", []() { WebSyncRequest req(server); webServer.handleGroupOptions(req); });
  server.on("/saveRoom", []() { WebSyncRequest req(server); webServer.handleSaveRoom(req); });
  server.on("/saveShade", []() { WebSyncRequest req(server); webServer.handleSaveShade(req); });
  server.on("/saveGroup", []() { WebSyncRequest req(server); webServer.handleSaveGroup(req); });
  server.on("/setMyPosition", []() { WebSyncRequest req(server); webServer.handleSetMyPosition(req); });
  server.on("/setRollingCode", []() { WebSyncRequest req(server); webServer.handleSetRollingCode(req); });
  server.on("/setPaired", []() { WebSyncRequest req(server); webServer.handleSetPaired(req); });
  server.on("/unpairShade", []() { WebSyncRequest req(server); webServer.handleUnpairShade(req); });
  server.on("/linkRepeater", []() { WebSyncRequest req(server); webServer.handleLinkRepeater(req); });
  server.on("/unlinkRepeater", []() { WebSyncRequest req(server); webServer.handleUnlinkRepeater(req); });
  server.on("/unlinkRemote", []() { WebSyncRequest req(server); webServer.handleUnlinkRemote(req); });
  server.on("/linkRemote", []() { WebSyncRequest req(server); webServer.handleLinkRemote(req); });
  server.on("/linkToGroup", []() { WebSyncRequest req(server); webServer.handleLinkToGroup(req); });
  server.on("/unlinkFromGroup", []() { WebSyncRequest req(server); webServer.handleUnlinkFromGroup(req); });
  server.on("/deleteRoom", []() { WebSyncRequest req(server); webServer.handleDeleteRoom(req); });
  server.on("/deleteShade", []() { WebSyncRequest req(server); webServer.handleDeleteShade(req); });
  server.on("/deleteGroup", []() { WebSyncRequest req(server); webServer.handleDeleteGroup(req); });
  server.on("/roomSortOrder", []() { WebSyncRequest req(server); webServer.handleRoomSortOrder(req); });
  server.on("/shadeSortOrder", []() { WebSyncRequest req(server); webServer.handleShadeSortOrder(req); });
  server.on("/groupSortOrder", []() { WebSyncRequest req(server); webServer.handleGroupSortOrder(req); });
}
