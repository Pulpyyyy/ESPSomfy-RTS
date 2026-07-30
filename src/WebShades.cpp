#include <WiFi.h>
#include <WebServer.h>
#include "ConfigSettings.h"
#include "Utils.h"
#include "Somfy.h"
#include "WResp.h"
#include "Web.h"
#include "Network.h"
#include "GitOTA.h"

// REST handlers for shades, rooms, groups, repeaters, commands, positions and
// the discovery document, split out of Web.cpp.  Declarations stay in Web.h;
// the shared response buffer and MIME strings are defined in Web.cpp.

extern ConfigSettings settings;
extern SomfyShadeController somfy;
extern Web webServer;
extern Network net;
extern GitUpdater git;

void Web::handleGetRepeaters(WebServer &server) {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    HTTPMethod method = server.method();
    if (method == HTTP_POST || method == HTTP_GET) {
      JsonResponse resp;
      resp.beginResponse(&server, g_content, sizeof(g_content));
      resp.beginArray();
      somfy.toJSONRepeaters(resp);
      resp.endArray();
      resp.endResponse();
      server.client().stop();
    }
    else server.send(404, _encoding_text, _response_404);
}
void Web::handleGetRooms(WebServer &server) {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!this->ensureAuth(server, false)) return;
    HTTPMethod method = server.method();
    if (method == HTTP_POST || method == HTTP_GET) {
      JsonResponse resp;
      resp.beginResponse(&server, g_content, sizeof(g_content));
      resp.beginArray();
      somfy.toJSONRooms(resp);
      resp.endArray();
      resp.endResponse();
      server.client().stop();
    }
    else server.send(404, _encoding_text, _response_404);
}
void Web::handleGetShades(WebServer &server) {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!this->ensureAuth(server, false)) return;
    HTTPMethod method = server.method();
    if (method == HTTP_POST || method == HTTP_GET) {
      JsonResponse resp;
      resp.beginResponse(&server, g_content, sizeof(g_content));
      resp.beginArray();
      somfy.toJSONShades(resp, this->isAuthenticated(server, true));
      resp.endArray();
      resp.endResponse();
      server.client().stop();
    }
    else server.send(404, _encoding_text, _response_404);
}
void Web::handleGetGroups(WebServer &server) {
    webServer.sendCORSHeaders(server);
    if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
    if(!this->ensureAuth(server, false)) return;
    HTTPMethod method = server.method();
    if (method == HTTP_POST || method == HTTP_GET) {
      JsonResponse resp;
      resp.beginResponse(&server, g_content, sizeof(g_content));
      resp.beginArray();
      somfy.toJSONGroups(resp, this->isAuthenticated(server, true));
      resp.endArray();
      resp.endResponse();
      server.client().stop();
    }
    else server.send(404, _encoding_text, _response_404);
}
// ---- Command cores shared by the sync and async transports. --------------
void Web::parseCommandJson(JsonObject &obj, somfy_cmd_req_t &cmd) {
  if (obj.containsKey("shadeId")) cmd.shadeId = obj["shadeId"];
  if (obj.containsKey("groupId")) cmd.groupId = obj["groupId"];
  if (obj.containsKey("command")) {
    String scmd = obj["command"];
    cmd.command = translateSomfyCommand(scmd);
  }
  else if (obj.containsKey("target")) cmd.target = obj["target"].as<uint8_t>();
  if (obj.containsKey("repeat")) cmd.repeat = obj["repeat"].as<uint8_t>();
  if (obj.containsKey("stepSize")) cmd.stepSize = obj["stepSize"].as<uint8_t>();
}
bool Web::execShadeCommand(somfy_cmd_req_t &cmd, JsonResponse &resp) {
  SomfyShade *shade = somfy.getShadeById(cmd.shadeId);
  if (!shade) return false;
  if (cmd.target <= 100)
    shade->moveToTarget(shade->transformPosition(cmd.target));
  else
    shade->sendCommand(cmd.command, cmd.repeat > 0 ? cmd.repeat : shade->repeats, cmd.stepSize);
  resp.beginObject();
  shade->toJSONRef(resp);
  resp.endObject();
  return true;
}
bool Web::execTiltCommand(somfy_cmd_req_t &cmd, JsonResponse &resp) {
  SomfyShade *shade = somfy.getShadeById(cmd.shadeId);
  if (!shade) return false;
  if (cmd.target <= 100)
    shade->moveToTiltTarget(shade->transformPosition(cmd.target));
  else
    shade->sendTiltCommand(cmd.command);
  resp.beginObject();
  shade->toJSONRef(resp);
  resp.endObject();
  return true;
}
bool Web::execGroupCommand(somfy_cmd_req_t &cmd, JsonResponse &resp) {
  SomfyGroup *group = somfy.getGroupById(cmd.groupId);
  if (!group) return false;
  group->sendCommand(cmd.command, cmd.repeat >= 0 ? cmd.repeat : group->repeats, cmd.stepSize);
  resp.beginObject();
  group->toJSONRef(resp);
  resp.endObject();
  return true;
}
uint8_t Web::execRepeatCommand(somfy_cmd_req_t &cmd, JsonResponse &resp) {
  if (cmd.shadeId != 255) {
    SomfyShade *shade = somfy.getShadeById(cmd.shadeId);
    if (!shade) return 1;
    somfy_commands command = cmd.command;
    if (shade->shadeType == shade_types::garage1 && command == somfy_commands::Prog) command = somfy_commands::Toggle;
    if (!shade->isLastCommand(command))
      shade->sendCommand(command, cmd.repeat >= 0 ? cmd.repeat : shade->repeats, cmd.stepSize);
    else
      shade->repeatFrame(cmd.repeat >= 0 ? cmd.repeat : shade->repeats);
    // Historical quirk kept as-is: the shade branch answers an array wrapper.
    resp.beginArray();
    shade->toJSONRef(resp);
    resp.endArray();
    return 0;
  }
  if (cmd.groupId != 255) {
    SomfyGroup *group = somfy.getGroupById(cmd.groupId);
    if (!group) return 2;
    if (!group->isLastCommand(cmd.command))
      group->sendCommand(cmd.command, cmd.repeat >= 0 ? cmd.repeat : group->repeats, cmd.stepSize);
    else
      group->repeatFrame(cmd.repeat >= 0 ? cmd.repeat : group->repeats);
    resp.beginObject();
    group->toJSONRef(resp);
    resp.endObject();
    return 0;
  }
  return 3;
}
void Web::handleShadeCommand(WebServer& server) {
  webServer.sendCORSHeaders(server);
  if (server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
  if(!this->ensureAuth(server, false)) return;
  HTTPMethod method = server.method();
  somfy_cmd_req_t cmd;
  if (method == HTTP_GET || method == HTTP_PUT || method == HTTP_POST) {
    if (server.hasArg("shadeId")) {
      cmd.shadeId = atoi(server.arg("shadeId").c_str());
      if (server.hasArg("command")) cmd.command = translateSomfyCommand(server.arg("command"));
      else if (server.hasArg("target")) cmd.target = atoi(server.arg("target").c_str());
      if (server.hasArg("repeat")) cmd.repeat = atoi(server.arg("repeat").c_str());
      if(server.hasArg("stepSize")) cmd.stepSize = atoi(server.arg("stepSize").c_str());
    }
    else if (server.hasArg("plain")) {
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, server.arg("plain"));
      if (err) {
        this->handleDeserializationError(server, err);
        return;
      }
      JsonObject obj = doc.as<JsonObject>();
      if (!obj.containsKey("shadeId")) server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No shade id was supplied.\"}"));
      this->parseCommandJson(obj, cmd);
    }
    else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No shade object supplied.\"}"));
    JsonResponse resp;
    resp.beginResponse(&server, g_content, sizeof(g_content));
    if (this->execShadeCommand(cmd, resp)) resp.endResponse();
    else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Shade with the specified id not found.\"}"));
  }
  else
    server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Invalid Http method\"}"));
}
void Web::handleRepeatCommand(WebServer& server) {
  webServer.sendCORSHeaders(server);
  HTTPMethod method = server.method();
  if (method == HTTP_OPTIONS) { server.send(200, "OK"); return; }
  if(!this->ensureAuth(server, false)) return;
  somfy_cmd_req_t cmd;
  if (method == HTTP_GET || method == HTTP_PUT || method == HTTP_POST) {
    if(server.hasArg("shadeId")) cmd.shadeId = atoi(server.arg("shadeId").c_str());
    else if(server.hasArg("groupId")) cmd.groupId = atoi(server.arg("groupId").c_str());
    if(server.hasArg("command")) cmd.command = translateSomfyCommand(server.arg("command"));
    if(server.hasArg("repeat")) cmd.repeat = atoi(server.arg("repeat").c_str());
    if(server.hasArg("stepSize")) cmd.stepSize = atoi(server.arg("stepSize").c_str());
    if(cmd.shadeId == 255 && cmd.groupId == 255 && server.hasArg("plain")) {
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, server.arg("plain"));
      if (err) {
        this->handleDeserializationError(server, err);
        return;
      }
      JsonObject obj = doc.as<JsonObject>();
      this->parseCommandJson(obj, cmd);
    }
    JsonResponse resp;
    resp.beginResponse(&server, g_content, sizeof(g_content));
    switch(this->execRepeatCommand(cmd, resp)) {
      case 0: resp.endResponse(); break;
      case 1: server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Shade reference could not be found.\"}")); break;
      case 2: server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Group reference could not be found.\"}")); break;
      // Used to fall through without any response; an explicit error replaces
      // the bare connection close (same fix as /restore).
      default: server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No shade or group id supplied.\"}")); break;
    }
  }
  else {
    server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Invalid Http method\"}"));
  }
}
void Web::handleGroupCommand(WebServer &server) {
  webServer.sendCORSHeaders(server);
  if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
  if(!this->ensureAuth(server, false)) return;
  HTTPMethod method = server.method();
  somfy_cmd_req_t cmd;
  if (method == HTTP_GET || method == HTTP_PUT || method == HTTP_POST) {
    if (server.hasArg("groupId")) {
      cmd.groupId = atoi(server.arg("groupId").c_str());
      if (server.hasArg("command")) cmd.command = translateSomfyCommand(server.arg("command"));
      if(server.hasArg("repeat")) cmd.repeat = atoi(server.arg("repeat").c_str());
      if(server.hasArg("stepSize")) cmd.stepSize = atoi(server.arg("stepSize").c_str());
    }
    else if (server.hasArg("plain")) {
      DynamicJsonDocument doc(256);
      DeserializationError err = deserializeJson(doc, server.arg("plain"));
      if (err) {
        this->handleDeserializationError(server, err);
        return;
      }
      JsonObject obj = doc.as<JsonObject>();
      if (!obj.containsKey("groupId")) {
        server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No group id was supplied.\"}"));
        return;
      }
      this->parseCommandJson(obj, cmd);
    }
    else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No group object supplied.\"}"));
    JsonResponse resp;
    resp.beginResponse(&server, g_content, sizeof(g_content));
    if (this->execGroupCommand(cmd, resp)) resp.endResponse();
    else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Group with the specified id not found.\"}"));
  }
  else
    server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Invalid Http method\"}"));
}
void Web::handleTiltCommand(WebServer &server) {
  webServer.sendCORSHeaders(server);
  if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
  if(!this->ensureAuth(server, false)) return;
  HTTPMethod method = server.method();
  somfy_cmd_req_t cmd;
  if (method == HTTP_GET || method == HTTP_PUT || method == HTTP_POST) {
    if (server.hasArg("shadeId")) {
      cmd.shadeId = atoi(server.arg("shadeId").c_str());
      if (server.hasArg("command")) cmd.command = translateSomfyCommand(server.arg("command"));
      else if(server.hasArg("target")) cmd.target = atoi(server.arg("target").c_str());
    }
    else if (server.hasArg("plain")) {
      DynamicJsonDocument doc(256);
      DeserializationError err = deserializeJson(doc, server.arg("plain"));
      if (err) {
        this->handleDeserializationError(server, err);
        return;
      }
      JsonObject obj = doc.as<JsonObject>();
      if (!obj.containsKey("shadeId")) server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No shade id was supplied.\"}"));
      this->parseCommandJson(obj, cmd);
    }
    else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No shade object supplied.\"}"));
    JsonResponse resp;
    resp.beginResponse(&server, g_content, sizeof(g_content));
    if (this->execTiltCommand(cmd, resp)) resp.endResponse();
    else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Shade with the specified id not found.\"}"));
  }
  else
    server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Invalid Http method\"}"));
}
void Web::handleRoom(WebServer &server) {
  webServer.sendCORSHeaders(server);
  if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
  HTTPMethod method = server.method();
  if (method == HTTP_GET) {
    if (server.hasArg("roomId")) {
      int roomId = atoi(server.arg("roomId").c_str());
      SomfyRoom* room = somfy.getRoomById(roomId);
      if (room) {
        JsonResponse resp;
        resp.beginResponse(&server, g_content, sizeof(g_content));
        resp.beginObject();
        room->toJSON(resp);
        resp.endObject();
        resp.endResponse();
      }
      else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Room Id not found.\"}"));
    }
    else {
      server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"You must supply a valid room id.\"}"));
    }
  }
  else if (method == HTTP_PUT || method == HTTP_POST) {
    // We are updating an existing room.
    if(!this->ensureAuth(server, true)) return;
    if (server.hasArg("plain")) {
      Serial.println("Updating a room");
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, server.arg("plain"));
      if (err) {
        this->handleDeserializationError(server, err);
        return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        if (obj.containsKey("roomId")) {
          SomfyRoom* room = somfy.getRoomById(obj["roomId"]);
          if (room) {
            uint8_t err = room->fromJSON(obj);
            if(err == 0) {
              room->save();
              JsonResponse resp;
              resp.beginResponse(&server, g_content, sizeof(g_content));
              resp.beginObject();
              room->toJSON(resp);
              resp.endObject();
              resp.endResponse();
            }
            else {
              snprintf(g_content, sizeof(g_content), "{\"status\":\"DATA\",\"desc\":\"Data Error.\", \"code\":%d}", err);
              server.send(500, _encoding_json, g_content);
            }
          }
          else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Room Id not found.\"}"));
        }
        else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No room id was supplied.\"}"));
      }
    }
    else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"No room object supplied.\"}"));
  }
  else
    server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Invalid Http method\"}"));
}
void Web::handleShade(WebServer &server) {
  webServer.sendCORSHeaders(server);
  if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
  HTTPMethod method = server.method();
  if (method == HTTP_GET) {
    if (server.hasArg("shadeId")) {
      int shadeId = atoi(server.arg("shadeId").c_str());
      SomfyShade* shade = somfy.getShadeById(shadeId);
      if (shade) {
        JsonResponse resp;
        resp.beginResponse(&server, g_content, sizeof(g_content));
        resp.beginObject();
        shade->toJSON(resp, this->isAuthenticated(server, true));
        resp.endObject();
        resp.endResponse();
      }
      else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Shade Id not found.\"}"));
    }
    else {
      server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"You must supply a valid shade id.\"}"));
    }
  }
  else if (method == HTTP_PUT || method == HTTP_POST) {
    // We are updating an existing shade.
    if(!this->ensureAuth(server, true)) return;
    if (server.hasArg("plain")) {
      Serial.println("Updating a shade");
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, server.arg("plain"));
      if (err) {
        this->handleDeserializationError(server, err);
        return;
      }
      else {
        JsonObject obj = doc.as<JsonObject>();
        if (obj.containsKey("shadeId")) {
          SomfyShade* shade = somfy.getShadeById(obj["shadeId"]);
          if (shade) {
            uint8_t err = shade->fromJSON(obj);
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
  else
    server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Invalid Http method\"}"));
}
void Web::handleGroup(WebServer &server) {
  webServer.sendCORSHeaders(server);
  if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
  HTTPMethod method = server.method();
  if (method == HTTP_GET) {
    if (server.hasArg("groupId")) {
      int groupId = atoi(server.arg("groupId").c_str());
      SomfyGroup* group = somfy.getGroupById(groupId);
      if (group) {
        JsonResponse resp;
        resp.beginResponse(&server, g_content, sizeof(g_content));
        resp.beginObject();
        group->toJSON(resp, this->isAuthenticated(server, true));
        resp.endObject();
        resp.endResponse();
      }
      else server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Group Id not found.\"}"));
    }
    else {
      server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"You must supply a valid shade id.\"}"));
    }
  }
  else if (method == HTTP_PUT || method == HTTP_POST) {
    // We are updating an existing group.
    if(!this->ensureAuth(server, true)) return;
    if (server.hasArg("plain")) {
      Serial.println("Updating a group");
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, server.arg("plain"));
      if (err) {
        this->handleDeserializationError(server, err);
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
  else
    server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"Invalid Http method\"}"));
}
void Web::handleDiscovery(WebServer &server) {
  HTTPMethod method = apiServer.method();
  if (method == HTTP_POST || method == HTTP_GET) {
    Serial.println("Discovery Requested");
    char connType[10] = "Unknown";
    if(net.connType == conn_types_t::ethernet) strcpy(connType, "Ethernet");
    else if(net.connType == conn_types_t::wifi) strcpy(connType, "Wifi");

    JsonResponse resp;
    resp.beginResponse(&server, g_content, sizeof(g_content));
    resp.beginObject();
    resp.addElem("serverId", settings.serverId);
    resp.addElem("version", settings.fwVersion.name);
    resp.addElem("latest", git.latest.name);
    resp.addElem("model", "ESPSomfyRTS");
    resp.addElem("hostname", settings.hostname);
    resp.addElem("authType", static_cast<uint8_t>(settings.Security.type));
    resp.addElem("permissions", settings.Security.permissions);
    resp.addElem("chipModel", settings.chipModel);
    resp.addElem("connType", connType);
    resp.addElem("checkForUpdate", settings.checkForUpdate);
    resp.beginObject("memory");
    resp.addElem("max", ESP.getMaxAllocHeap());
    resp.addElem("free", ESP.getFreeHeap());
    resp.addElem("min", ESP.getMinFreeHeap());
    resp.addElem("total", ESP.getHeapSize());
    resp.endObject();
    // Identity fields above stay open so discovery/config-flow can find the device;
    // the room/shade/group names below are private and only served once authenticated
    // (passthrough for None/ConfigOnly, hidden in full-auth mode without a token).
    if(this->isAuthenticated(server, false)) {
      resp.beginArray("rooms");
      somfy.toJSONRooms(resp);
      resp.endArray();
      resp.beginArray("shades");
      somfy.toJSONShades(resp, this->isAuthenticated(server, true));
      resp.endArray();
      resp.beginArray("groups");
      somfy.toJSONGroups(resp, this->isAuthenticated(server, true));
      resp.endArray();
    }
    resp.endObject();
    resp.endResponse();
    server.client().stop();
    net.needsBroadcast = true;
  }
  else
    server.send(500, _encoding_text, "Invalid http method");
}

void Web::handleSetPositions(WebServer &server) {
  webServer.sendCORSHeaders(server);
  if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
  if(!this->ensureAuth(server, false)) return;
  uint8_t shadeId = (server.hasArg("shadeId")) ? atoi(server.arg("shadeId").c_str()) : 255;
  int8_t pos = (server.hasArg("position")) ? atoi(server.arg("position").c_str()) : -1;
  int8_t tiltPos = (server.hasArg("tiltPosition")) ? atoi(server.arg("tiltPosition").c_str()) : -1;
  if(server.hasArg("plain")) {
    DynamicJsonDocument doc(512);
    DeserializationError err = deserializeJson(doc, server.arg("plain"));
    if (err) {
      this->handleDeserializationError(server, err);
      return;
    }
    else {
      JsonObject obj = doc.as<JsonObject>();
      if(obj.containsKey("shadeId")) shadeId = obj["shadeId"];
      if(obj.containsKey("position")) pos = obj["position"];
      if(obj.containsKey("tiltPosition")) tiltPos = obj["tiltPosition"];
    }
  }
  if(shadeId != 255) {
    SomfyShade *shade = somfy.getShadeById(shadeId);
    if(shade) {
      if(pos >= 0) shade->target = shade->currentPos = pos;
      if(tiltPos >= 0 && shade->tiltType != tilt_types::none) shade->tiltTarget = shade->currentTiltPos = tiltPos;
      shade->emitState();
      JsonResponse resp;
      resp.beginResponse(&server, g_content, sizeof(g_content));
      resp.beginObject();
      shade->toJSON(resp);
      resp.endObject();
      resp.endResponse();
    }
    else
      server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"An invalid shadeId was provided\"}"));
  }
  else {
    server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"shadeId was not provided\"}"));
  }
}
void Web::handleSetSensor(WebServer &server) {
  webServer.sendCORSHeaders(server);
  if(server.method() == HTTP_OPTIONS) { server.send(200, "OK"); return; }
  if(!this->ensureAuth(server, false)) return;
  uint8_t shadeId = (server.hasArg("shadeId")) ? atoi(server.arg("shadeId").c_str()) : 255;
  uint8_t groupId = (server.hasArg("groupId")) ? atoi(server.arg("groupId").c_str()) : 255;
  int8_t sunny = (server.hasArg("sunny")) ? toBoolean(server.arg("sunny").c_str(), false) ? 1 : 0 : -1;
  int8_t windy = (server.hasArg("windy")) ? atoi(server.arg("windy").c_str()) : -1;
  int8_t repeat = (server.hasArg("repeat")) ? atoi(server.arg("repeat").c_str()) : -1;
  if(server.hasArg("plain")) {
    DynamicJsonDocument doc(512);
    DeserializationError err = deserializeJson(doc, server.arg("plain"));
    if (err) {
      this->handleDeserializationError(server, err);
      return;
    }
    else {
      JsonObject obj = doc.as<JsonObject>();
      if(obj.containsKey("shadeId")) shadeId = obj["shadeId"].as<uint8_t>();
      if(obj.containsKey("groupId")) groupId = obj["groupId"].as<uint8_t>();
      if(obj.containsKey("sunny")) {
        if(obj["sunny"].is<bool>())
          sunny = obj["sunny"].as<bool>() ? 1 : 0;
        else
          sunny = obj["sunny"].as<int8_t>();
      }
      if(obj.containsKey("windy")) {
        if(obj["windy"].is<bool>())
          windy = obj["windy"].as<bool>() ? 1 : 0;
        else
          windy = obj["windy"].as<int8_t>();
      }
      if(obj.containsKey("repeat")) repeat = obj["repeat"].as<uint8_t>();
    }
  }
  if(shadeId != 255) {
    SomfyShade *shade = somfy.getShadeById(shadeId);
    if(shade) {
      shade->sendSensorCommand(windy, sunny, repeat >= 0 ? (uint8_t)repeat : shade->repeats);
      shade->emitState();
      JsonResponse resp;
      resp.beginResponse(&server, g_content, sizeof(g_content));
      resp.beginObject();
      shade->toJSON(resp);
      resp.endObject();
      resp.endResponse();
    }
    else
      server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"An invalid shadeId was provided\"}"));
      
  }
  else if(groupId != 255) {
    SomfyGroup *group = somfy.getGroupById(groupId);
    if(group) {
      group->sendSensorCommand(windy, sunny, repeat >= 0 ? (uint8_t)repeat : group->repeats);
      group->emitState();
      JsonResponse resp;
      resp.beginResponse(&server, g_content, sizeof(g_content));
      resp.beginObject();
      group->toJSON(resp);
      resp.endObject();
      resp.endResponse();
    }
    else
      server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"An invalid groupId was provided\"}"));
  }
  else {
    server.send(500, _encoding_json, F("{\"status\":\"ERROR\",\"desc\":\"shadeId was not provided\"}"));
  }
}
