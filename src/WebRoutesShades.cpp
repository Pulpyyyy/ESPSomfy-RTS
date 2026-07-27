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

extern ConfigSettings settings;
extern SomfyShadeController somfy;
extern Web webServer;

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
  server.on("/addRoom", []() {
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    HTTPMethod method = server.method();
    SomfyRoom * room = nullptr;
    if (method == HTTP_POST || method == HTTP_PUT) {
      Serial.println("Adding a room");
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, server.arg("plain"));
      if (err) {
        webServer.handleDeserializationError(server, err);
        return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        Serial.println("Counting rooms");
        if (somfy.roomCount() > SOMFY_MAX_ROOMS) {
          server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Maximum number of rooms exceeded.\"}"));
          return;
        }
        else {
          Serial.println("Adding room");
          room = somfy.addRoom(obj);
          if (!room) {
            server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Error adding room.\"}"));
            return;
          }
        }
      }
    }
    if (room) {
      JsonResponse resp;
      resp.beginResponse(&server, g_content, sizeof(g_content));
      resp.beginObject();
      room->toJSON(resp);
      resp.endObject();
      resp.endResponse();
    }
    else {
      server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Error saving Somfy Room.\"}"));
    }
    });
  server.on("/addShade", []() {
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    HTTPMethod method = server.method();
    SomfyShade* shade = nullptr;
    if (method == HTTP_POST || method == HTTP_PUT) {
      Serial.println("Adding a shade");
      DynamicJsonDocument doc(1024);
      DeserializationError err = deserializeJson(doc, server.arg("plain"));
      if (err) {
        webServer.handleDeserializationError(server, err);
        return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        Serial.println("Counting shades");
        if (somfy.shadeCount() > SOMFY_MAX_SHADES) {
          server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Maximum number of shades exceeded.\"}"));
          return;
        }
        else {
          Serial.println("Adding shade");
          shade = somfy.addShade(obj);
          if (!shade) {
            server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Error adding shade.\"}"));
            return;
          }
        }
      }
    }
    if (shade) {
      //Serial.println("Serializing shade");
      JsonResponse resp;
      resp.beginResponse(&server, g_content, sizeof(g_content));
      resp.beginObject();
      shade->toJSON(resp);
      resp.endObject();
      resp.endResponse();
    }
    else {
      server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Error saving Somfy Shade.\"}"));
    }
    });
  server.on("/addGroup", []() {
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    HTTPMethod method = server.method();
    SomfyGroup * group = nullptr;
    if (method == HTTP_POST || method == HTTP_PUT) {
      Serial.println("Adding a group");
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, server.arg("plain"));
      if (err) {
        webServer.handleDeserializationError(server, err);
        return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        Serial.println("Counting shades");
        if (somfy.groupCount() > SOMFY_MAX_GROUPS) {
          server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Maximum number of groups exceeded.\"}"));
          return;
        }
        else {
          Serial.println("Adding group");
          group = somfy.addGroup(obj);
          if (!group) {
            server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Error adding group.\"}"));
            return;
          }
        }
      }
    }
    if (group) {
      JsonResponse resp;
      resp.beginResponse(&server, g_content, sizeof(g_content));
      resp.beginObject();
      group->toJSON(resp);
      resp.endObject();
      resp.endResponse();
    }
    else {
      server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Error saving Somfy Group.\"}"));
    }
    });
  server.on("/groupOptions", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    HTTPMethod method = server.method();
    if (method == HTTP_GET || method == HTTP_POST) {
      if (server.hasArg("groupId")) {
        int groupId = atoi(server.arg("groupId").c_str());
        SomfyGroup* group = somfy.getGroupById(groupId);
        if (group) {
          JsonResponse resp;
          resp.beginResponse(&server, g_content, sizeof(g_content));
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
          resp.endResponse();
        }
        else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Group Id not found.\"}"));
      }
      else {
        server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"You must supply a valid group id.\"}"));
      }
    }
    
    });
  server.on("/saveRoom", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    HTTPMethod method = server.method();
    if (method == HTTP_PUT || method == HTTP_POST) {
      // We are updating an existing room.
      if (server.hasArg("plain")) {
        Serial.println("Updating a room");
        DynamicJsonDocument doc(512);
        DeserializationError err = deserializeJson(doc, server.arg("plain"));
        if (err) {
          webServer.handleDeserializationError(server, err);
          return;
        }
        else {
          JsonObject obj = doc.as<JsonObject>();
          if (obj.containsKey("roomId")) {
            SomfyRoom* room = somfy.getRoomById(obj["roomId"]);
            if (room) {
              room->fromJSON(obj);
              room->save();
              JsonResponse resp;
              resp.beginResponse(&server, g_content, sizeof(g_content));
              resp.beginObject();
              room->toJSON(resp);
              resp.endObject();
              resp.endResponse();
            }
            else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Room Id not found.\"}"));
          }
          else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No room id was supplied.\"}"));
        }
      }
      else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No room object supplied.\"}"));
    }
  });

  server.on("/saveShade", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    HTTPMethod method = server.method();
    if (method == HTTP_PUT || method == HTTP_POST) {
      // We are updating an existing shade.
      if (server.hasArg("plain")) {
        Serial.println("Updating a shade");
        DynamicJsonDocument doc(1024);
        DeserializationError err = deserializeJson(doc, server.arg("plain"));
        if (err) {
          webServer.handleDeserializationError(server, err);
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
                JsonResponse resp;
                resp.beginResponse(&server, g_content, sizeof(g_content));
                resp.beginObject();
                shade->toJSON(resp);
                resp.endObject();
                resp.endResponse();
              }
              else {
                snprintf(g_content, sizeof(g_content), "{\"status\":\"DATA\",\"desc\":\"Data Error.\", \"code\":%d}", err);
                server.send(500, _encoding_json, g_content);
              }
            }
            else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Shade Id not found.\"}"));
          }
          else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No shade id was supplied.\"}"));
        }
      }
      else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No shade object supplied.\"}"));
    }
  });
  server.on("/saveGroup", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    HTTPMethod method = server.method();
    if (method == HTTP_PUT || method == HTTP_POST) {
      // We are updating an existing shade.
      if (server.hasArg("plain")) {
        Serial.println("Updating a group");
        DynamicJsonDocument doc(512);
        DeserializationError err = deserializeJson(doc, server.arg("plain"));
        if (err) {
          webServer.handleDeserializationError(server, err);
          return;
        }
        else {
          JsonObject obj = doc.as<JsonObject>();
          if (obj.containsKey("groupId")) {
            SomfyGroup* group = somfy.getGroupById(obj["groupId"]);
            if (group) {
              group->fromJSON(obj);
              group->save();
              JsonResponse resp;
              resp.beginResponse(&server, g_content, sizeof(g_content));
              resp.beginObject();
              group->toJSON(resp);
              resp.endObject();
              resp.endResponse();
            }
            else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Group Id not found.\"}"));
          }
          else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No group id was supplied.\"}"));
        }
      }
      else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No group object supplied.\"}"));
    }
    });
  server.on("/setMyPosition", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    HTTPMethod method = server.method();
    uint8_t shadeId = 255;
    int8_t pos = -1;
    int8_t tilt = -1;
    if (method == HTTP_GET || method == HTTP_PUT || method == HTTP_POST) {
      if (server.hasArg("shadeId")) {
        shadeId = atoi(server.arg("shadeId").c_str());
        if(server.hasArg("pos")) pos = atoi(server.arg("pos").c_str());
        if(server.hasArg("tilt")) tilt = atoi(server.arg("tilt").c_str());
      }
      else if (server.hasArg("plain")) {
        DynamicJsonDocument doc(256);
        DeserializationError err = deserializeJson(doc, server.arg("plain"));
        if (err) {
          webServer.handleDeserializationError(server, err);
          return;
        }
        else {
          JsonObject obj = doc.as<JsonObject>();
          if (obj.containsKey("shadeId")) shadeId = obj["shadeId"];
          else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No shade id was supplied.\"}"));
          if(obj.containsKey("pos")) pos = obj["pos"].as<int8_t>();
          if(obj.containsKey("tilt")) tilt = obj["tilt"].as<int8_t>();
        }
      }
      else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No shade object supplied.\"}"));
      SomfyShade* shade = somfy.getShadeById(shadeId);
      if (shade) {
        // Send the command to the shade.
        if(tilt < 0) tilt = shade->myPos;
        if(shade->tiltType == tilt_types::none) tilt = -1;
        if(pos >= 0 && pos <= 100)
          shade->setMyPosition(shade->transformPosition(pos), shade->transformPosition(tilt));
          JsonResponse resp;
          resp.beginResponse(&server, g_content, sizeof(g_content));
          resp.beginObject();
          shade->toJSONRef(resp);
          resp.endObject();
          resp.endResponse();
      }
      else {
        server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Shade with the specified id not found.\"}"));
      }
    }
    else 
      server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Invalid Http method\"}"));
    });
  server.on("/setRollingCode", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    HTTPMethod method = server.method();
    if (method == HTTP_PUT || method == HTTP_POST) {
      uint8_t shadeId = 255;
      uint16_t rollingCode = 0;
      if (server.hasArg("plain")) {
        // Its coming in the body.
        StaticJsonDocument<129> doc;
        DeserializationError err = deserializeJson(doc, server.arg("plain"));
        if (err) {
          webServer.handleDeserializationError(server, err);
          return;
        }
        else {
          JsonObject obj = doc.as<JsonObject>();
          if (obj.containsKey("shadeId")) shadeId = obj["shadeId"];
          if(obj.containsKey("rollingCode")) rollingCode = obj["rollingCode"];
        }
      }
      else if (server.hasArg("shadeId")) {
        shadeId = atoi(server.arg("shadeId").c_str());
        rollingCode = atoi(server.arg("rollingCode").c_str());
      }
      SomfyShade* shade = nullptr;
      if (shadeId != 255) shade = somfy.getShadeById(shadeId);
      if (!shade) {
        server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Shade not found to set rolling code\"}"));
      }
      else {
        shade->setRollingCode(rollingCode);
        JsonResponse resp;
        resp.beginResponse(&server, g_content, sizeof(g_content));
        resp.beginObject();
        shade->toJSON(resp);
        resp.endObject();
        resp.endResponse();
      }
    }
  });
  server.on("/setPaired", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    uint8_t shadeId = 255;
    bool paired = false;
    if(server.hasArg("plain")) {
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, server.arg("plain"));
      if(err) {
          webServer.handleDeserializationError(server, err);
          return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        if (obj.containsKey("shadeId")) shadeId = obj["shadeId"];
        if(obj.containsKey("paired")) paired = obj["paired"];
      }
    }
    else if (server.hasArg("shadeId"))
      shadeId = atoi(server.arg("shadeId").c_str());
    if(server.hasArg("paired"))
      paired = toBoolean(server.arg("paired").c_str(), false);
    SomfyShade* shade = nullptr;
    if (shadeId != 255) shade = somfy.getShadeById(shadeId);
    if (!shade) {
      server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Shade not found to pair\"}"));
    }
    else {
      shade->paired = paired;
      shade->save();
      JsonResponse resp;
      resp.beginResponse(&server, g_content, sizeof(g_content));
      resp.beginObject();
      shade->toJSON(resp);
      resp.endObject();
      resp.endResponse();
    }
  });
  server.on("/unpairShade", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    HTTPMethod method = server.method();
    if (method == HTTP_PUT || method == HTTP_POST) {
      uint8_t shadeId = 255;
      if (server.hasArg("plain")) {
        // Its coming in the body.
        DynamicJsonDocument doc(512);
        DeserializationError err = deserializeJson(doc, server.arg("plain"));
        if (err) {
          webServer.handleDeserializationError(server, err);
          return;
        }
        else {
          JsonObject obj = doc.as<JsonObject>();
          if (obj.containsKey("shadeId")) shadeId = obj["shadeId"];
        }
      }
      else if (server.hasArg("shadeId"))
        shadeId = atoi(server.arg("shadeId").c_str());
      SomfyShade* shade = nullptr;
      if (shadeId != 255) shade = somfy.getShadeById(shadeId);
      if (!shade) {
        server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Shade not found to unpair\"}"));
      }
      else {
        if(shade->bitLength == 56)
          shade->sendCommand(somfy_commands::Prog, 7);
        else
          shade->sendCommand(somfy_commands::Prog, 1);
        shade->paired = false;
        shade->save();
        JsonResponse resp;
        resp.beginResponse(&server, g_content, sizeof(g_content));
        resp.beginObject();
        shade->toJSON(resp);
        resp.endObject();
        resp.endResponse();
      }
    }
    });
  server.on("/linkRepeater", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    HTTPMethod method = server.method();
    if (method == HTTP_PUT || method == HTTP_POST) {
      // We are adding a linked repeater.
      uint32_t address = 0;
      if (server.hasArg("plain")) {
        Serial.println("Linking a repeater");
        DynamicJsonDocument doc(512);
        DeserializationError err = deserializeJson(doc, server.arg("plain"));
        if (err) {
          webServer.handleDeserializationError(server, err);
          return;
        }
        else {
          JsonObject obj = doc.as<JsonObject>();
          if (obj.containsKey("address")) address = obj["address"];
          else if(obj.containsKey("remoteAddress")) address = obj["remoteAddress"];
        }
      }
      else if(server.hasArg("address"))
        address = atoi(server.arg("address").c_str());
      if(address == 0)
          server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No repeater address was supplied.\"}"));
      else {
        somfy.linkRepeater(address);
        JsonResponse resp;
        resp.beginResponse(&server, g_content, sizeof(g_content));
        resp.beginArray();
        somfy.toJSONRepeaters(resp);
        resp.endArray();
        resp.endResponse();
      }
    }
  });
  server.on("/unlinkRepeater", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    HTTPMethod method = server.method();
    if (method == HTTP_PUT || method == HTTP_POST) {
      // We are adding a linked repeater.
      uint32_t address = 0;
      if (server.hasArg("plain")) {
        Serial.println("Unlinking a repeater");
        DynamicJsonDocument doc(512);
        DeserializationError err = deserializeJson(doc, server.arg("plain"));
        if (err) {
          webServer.handleDeserializationError(server, err);
          return;
        }
        else {
          JsonObject obj = doc.as<JsonObject>();
          if (obj.containsKey("address")) address = obj["address"];
          else if(obj.containsKey("remoteAddress")) address = obj["remoteAddress"];
        }
      }
      else if(server.hasArg("address"))
        address = atoi(server.arg("address").c_str());
      if(address == 0)
          server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No repeater address was supplied.\"}"));
      else {
        somfy.unlinkRepeater(address);
        JsonResponse resp;
        resp.beginResponse(&server, g_content, sizeof(g_content));
        resp.beginArray();
        somfy.toJSONRepeaters(resp);
        resp.endArray();
        resp.endResponse();
      }
    }
  });
  server.on("/unlinkRemote", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    HTTPMethod method = server.method();
    if (method == HTTP_PUT || method == HTTP_POST) {
      // We are updating an existing shade by adding a linked remote.
      if (server.hasArg("plain")) {
        DynamicJsonDocument doc(512);
        DeserializationError err = deserializeJson(doc, server.arg("plain"));
        if (err) {
          webServer.handleDeserializationError(server, err);
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
                server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Remote address not provided.\"}"));
              }
              JsonResponse resp;
              resp.beginResponse(&server, g_content, sizeof(g_content));
              resp.beginObject();
              shade->toJSON(resp);
              resp.endObject();
              resp.endResponse();
            }
            else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Shade Id not found.\"}"));
          }
          else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No shade id was supplied.\"}"));
        }
      }
      else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No remote object supplied.\"}"));
    }
    });
  server.on("/linkRemote", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    HTTPMethod method = server.method();
    if (method == HTTP_PUT || method == HTTP_POST) {
      // We are updating an existing shade by adding a linked remote.
      if (server.hasArg("plain")) {
        Serial.println("Linking a remote");
        DynamicJsonDocument doc(512);
        DeserializationError err = deserializeJson(doc, server.arg("plain"));
        if (err) {
          webServer.handleDeserializationError(server, err);
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
                server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Remote address not provided.\"}"));
              }
              JsonResponse resp;
              resp.beginResponse(&server, g_content, sizeof(g_content));
              resp.beginObject();
              shade->toJSON(resp);
              resp.endObject();
              resp.endResponse();
            }
            else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Shade Id not found.\"}"));
          }
          else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No shade id was supplied.\"}"));
        }
      }
      else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No remote object supplied.\"}"));
    }
    });
  server.on("/linkToGroup", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    HTTPMethod method = server.method();
    if (method == HTTP_PUT || method == HTTP_POST) {
      if (server.hasArg("plain")) {
        Serial.println("Linking a shade to a group");
        DynamicJsonDocument doc(512);
        DeserializationError err = deserializeJson(doc, server.arg("plain"));
        if (err) {
          webServer.handleDeserializationError(server, err);
          return;
        }
        else {
          JsonObject obj = doc.as<JsonObject>();
          uint8_t shadeId = obj.containsKey("shadeId") ? obj["shadeId"] : 0;
          uint8_t groupId = obj.containsKey("groupId") ? obj["groupId"] : 0;
          if(groupId == 0) {
            server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Group id not provided.\"}"));
            return;
          }
          if(shadeId == 0) {
            server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Shade id not provided.\"}"));
            return;
          }
          SomfyGroup * group = somfy.getGroupById(groupId);
          if(!group) {
            server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Group id not found.\"}"));
            return;
          }
          SomfyShade * shade = somfy.getShadeById(shadeId);
          if(!shade) {
            server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Shade id not found.\"}"));
            return;
          }
          group->linkShade(shadeId);
          JsonResponse resp;
          resp.beginResponse(&server, g_content, sizeof(g_content));
          resp.beginObject();
          group->toJSON(resp);
          resp.endObject();
          resp.endResponse();
        }
      }
      else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No linking object supplied.\"}"));
    }
  });
  server.on("/unlinkFromGroup", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    HTTPMethod method = server.method();
    if (method == HTTP_PUT || method == HTTP_POST) {
      if (server.hasArg("plain")) {
        Serial.println("Unlinking a shade from a group");
        DynamicJsonDocument doc(512);
        DeserializationError err = deserializeJson(doc, server.arg("plain"));
        if (err) {
          switch (err.code()) {
          case DeserializationError::InvalidInput:
            server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Invalid JSON payload\"}"));
            break;
          case DeserializationError::NoMemory:
            server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Out of memory parsing JSON\"}"));
            break;
          default:
            server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"General JSON Deserialization failed\"}"));
            break;
          }
        }
        else {
          JsonObject obj = doc.as<JsonObject>();
          uint8_t shadeId = obj.containsKey("shadeId") ? obj["shadeId"] : 0;
          uint8_t groupId = obj.containsKey("groupId") ? obj["groupId"] : 0;
          if(groupId == 0) {
            server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Group id not provided.\"}"));
            return;
          }
          if(shadeId == 0) {
            server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Shade id not provided.\"}"));
            return;
          }
          SomfyGroup * group = somfy.getGroupById(groupId);
          if(!group) {
            server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Group id not found.\"}"));
            return;
          }
          SomfyShade * shade = somfy.getShadeById(shadeId);
          if(!shade) {
            server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Shade id not found.\"}"));
            return;
          }
          group->unlinkShade(shadeId);
          JsonResponse resp;
          resp.beginResponse(&server, g_content, sizeof(g_content));
          resp.beginObject();
          group->toJSON(resp);
          resp.endObject();
          resp.endResponse();
        }
      }
      else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No unlinking object supplied.\"}"));
    }
  });
  server.on("/deleteRoom", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    HTTPMethod method = server.method();
    uint8_t roomId = 0;
    if (method == HTTP_GET || method == HTTP_PUT || method == HTTP_POST) {
      if (server.hasArg("roomId")) {
        roomId = atoi(server.arg("roomId").c_str());
      }
      else if (server.hasArg("plain")) {
        Serial.println("Deleting a Room");
        DynamicJsonDocument doc(256);
        DeserializationError err = deserializeJson(doc, server.arg("plain"));
        if (err) {
          webServer.handleDeserializationError(server, err);
          return;
        }
        else {
          JsonObject obj = doc.as<JsonObject>();
          if (obj.containsKey("roomId")) roomId = obj["roomId"];
          else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No room id was supplied.\"}"));
        }
      }
      else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No room object supplied.\"}"));
    }
    SomfyRoom* room = somfy.getRoomById(roomId);
    if (!room) server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Room with the specified id not found.\"}"));
    else {
      somfy.deleteRoom(roomId);
      server.send(200, _encoding_json, F("{\"status\":\"SUCCESS\",\"desc\":\"Room deleted.\"}"));
    }
    });
  server.on("/deleteShade", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    HTTPMethod method = server.method();
    uint8_t shadeId = 255;
    if (method == HTTP_GET || method == HTTP_PUT || method == HTTP_POST) {
      if (server.hasArg("shadeId")) {
        shadeId = atoi(server.arg("shadeId").c_str());
      }
      else if (server.hasArg("plain")) {
        Serial.println("Deleting a shade");
        DynamicJsonDocument doc(256);
        DeserializationError err = deserializeJson(doc, server.arg("plain"));
        if (err) {
          webServer.handleDeserializationError(server, err);
          return;
        }
        else {
          JsonObject obj = doc.as<JsonObject>();
          if (obj.containsKey("shadeId")) shadeId = obj["shadeId"];
          else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No shade id was supplied.\"}"));
        }
      }
      else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No shade object supplied.\"}"));
    }
    SomfyShade* shade = somfy.getShadeById(shadeId);
    if (!shade) server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Shade with the specified id not found.\"}"));
    else if(shade->isInGroup()) {
      server.send(400, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"This shade is a member of a group and cannot be deleted.\"}"));
    }
    else {
      somfy.deleteShade(shadeId);
      server.send(200, _encoding_json, F("{\"status\":\"SUCCESS\",\"desc\":\"Shade deleted.\"}"));
    }
    });
  server.on("/deleteGroup", []() {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    HTTPMethod method = server.method();
    uint8_t groupId = 255;
    if (method == HTTP_GET || method == HTTP_PUT || method == HTTP_POST) {
      if (server.hasArg("groupId")) {
        groupId = atoi(server.arg("groupId").c_str());
      }
      else if (server.hasArg("plain")) {
        Serial.println("Deleting a group");
        DynamicJsonDocument doc(256);
        DeserializationError err = deserializeJson(doc, server.arg("plain"));
        if (err) {
          webServer.handleDeserializationError(server, err);
          return;
        }
        else {
          JsonObject obj = doc.as<JsonObject>();
          if (obj.containsKey("groupId")) groupId = obj["groupId"];
          else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No group id was supplied.\"}"));
        }
      }
      else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No group object supplied.\"}"));
    }
    SomfyGroup * group = somfy.getGroupById(groupId);
    if (!group) server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Group with the specified id not found.\"}"));
    else {
      somfy.deleteGroup(groupId);
      server.send(200, _encoding_json, F("{\"status\":\"SUCCESS\",\"desc\":\"Group deleted.\"}"));
    }
    });
  server.on("/roomSortOrder", []() {
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    DynamicJsonDocument doc(512);
    Serial.print("Plain: ");
    Serial.print(server.method());
    Serial.println(server.arg("plain"));
    DeserializationError err = deserializeJson(doc, server.arg("plain"));
    if (err) {
      webServer.handleDeserializationError(server, err);
      return;
    }
    else {
      JsonArray arr = doc.as<JsonArray>();
      HTTPMethod method = server.method();
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
        server.send(200, "application/json", "{\"status\":\"OK\",\"desc\":\"Successfully set room order\"}");
      }
      else {
        server.send(201, "application/json", "{\"status\":\"ERROR\",\"desc\":\"Invalid HTTP Method: \"}");
      }
    }
  });
  server.on("/shadeSortOrder", []() {
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    DynamicJsonDocument doc(512);
    Serial.print("Plain: ");
    Serial.print(server.method());
    Serial.println(server.arg("plain"));
    DeserializationError err = deserializeJson(doc, server.arg("plain"));
    if (err) {
      webServer.handleDeserializationError(server, err);
      return;
    }
    else {
      JsonArray arr = doc.as<JsonArray>();
      HTTPMethod method = server.method();
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
        server.send(200, "application/json", "{\"status\":\"OK\",\"desc\":\"Successfully set shade order\"}");
      }
      else {
        server.send(201, "application/json", "{\"status\":\"ERROR\",\"desc\":\"Invalid HTTP Method: \"}");
      }
    }
  });
  server.on("/groupSortOrder", []() {
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!webServer.ensureAuth(server, true)) return;
    DynamicJsonDocument doc(512);
    Serial.print("Plain: ");
    Serial.print(server.method());
    Serial.println(server.arg("plain"));
    DeserializationError err = deserializeJson(doc, server.arg("plain"));
    if (err) {
      webServer.handleDeserializationError(server, err);
      return;
    }
    else {
      JsonArray arr = doc.as<JsonArray>();
      HTTPMethod method = server.method();
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
        server.send(200, "application/json", "{\"status\":\"OK\",\"desc\":\"Successfully set group order\"}");
      }
      else {
        server.send(201, "application/json", "{\"status\":\"ERROR\",\"desc\":\"Invalid HTTP Method: \"}");
      }
    }
  });  
}
