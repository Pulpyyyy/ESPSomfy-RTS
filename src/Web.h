#include <WebServer.h>
#include "Somfy.h"
#ifndef webserver_h
#define webserver_h
// One parsed command payload for the shade/group/tilt/repeat routes, shared by
// the sync and async transports; each transport only differs in how it fills it.
struct somfy_cmd_req_t {
  uint8_t shadeId = 255;
  uint8_t groupId = 255;
  uint8_t target = 255;
  uint8_t stepSize = 0;
  int8_t repeat = -1;
  somfy_commands command = somfy_commands::My;
};
class Web {
private:
  // Failed /login attempts, and the millis() deadline until which logins are refused.
  // A 4-digit PIN is only 10000 combinations, so an unthrottled endpoint is walkable
  // in seconds over a LAN.
  uint8_t _failedLogins = 0;
  uint32_t _lockoutUntil = 0;
  bool _loginLocked();
  void _loginFailed();
public:
  bool uploadSuccess = false;
  // millis() of the last served HTTP request; lets background work that blocks
  // the loop (the GitHub release check) stay out of the way of an active UI.
  uint32_t lastActivity = 0;
  // Length-independent comparison, so a wrong secret cannot be narrowed down by timing.
  static bool secureEquals(const char *a, const char *b);
  void handleLang(WebServer &server);
  void handleSetLang(WebServer &server);

  void sendCORSHeaders(WebServer &server);
  void sendCacheHeaders(uint32_t seconds = 604800);
  void startup();
  void handleLogin(WebServer &server);
  void handleLogout(WebServer &server);
  void handleStreamFile(WebServer &server, const char *filename, const char *encoding);
  void handleController(WebServer &server);
  void handleLoginContext(WebServer &server);
  void handleGetRepeaters(WebServer &server);
  void handleGetRooms(WebServer &server);
  void handleGetShades(WebServer &server);
  void handleGetGroups(WebServer &server);
  void handleShadeCommand(WebServer &server);
  void handleRepeatCommand(WebServer &server);
  void handleGroupCommand(WebServer &server);
  void handleTiltCommand(WebServer &server);
  void handleDiscovery(WebServer &server);
  void handleNotFound(WebServer &server);
  void handleRoom(WebServer &server);
  void handleShade(WebServer &server);
  void handleGroup(WebServer &server);
  void handleSetPositions(WebServer &server);
  void handleSetSensor(WebServer &server);
  void handleDownloadFirmware(WebServer &server);
  void handleBackup(WebServer &server, bool attach = false);
  void handleReboot(WebServer &server);
  void handleDeserializationError(WebServer &server, DeserializationError &err);
  void begin();
  // Route registration split by concern; begin() calls these in order.  The shade
  // and system groups live in WebRoutesShades.cpp / WebRoutesSystem.cpp.
  void beginApiRoutes();
  void beginShadeRoutes();
  void beginSystemRoutes();
  void beginNetworkRoutes();
  void beginRadioRoutes();
  void loop();
  void end();
  // Web Handlers
  bool createAPIToken(const IPAddress ipAddress, char *token);
  bool createAPIToken(const char *payload, char *token);
  bool createAPIPinToken(const IPAddress ipAddress, const char *pin, char *token);
  bool createAPIPasswordToken(const IPAddress ipAddress, const char *username, const char *password, char *token);
  bool isAuthenticated(WebServer &server, bool cfg = false);
  bool ensureAuth(WebServer &server, bool cfg = false);
  // CSRF / DNS-rebinding guard for the browser-facing server. Returns false and
  // sends a 403 when the request is cross-origin or targets a rebinding host.
  bool isSameOrigin(WebServer &server);
  bool sameOriginOK(WebServer &server);
  // Pure origin/host policy shared by the sync and async transports: a single
  // source of truth for the CSRF/anti-rebinding decision (and a native-test
  // candidate once de-Arduino-ized).
  bool originAllowed(const String &hostHeader, const String &origin, const String &referer);
  // Transport-neutral JSON bodies, called by both the sync and async routes.
  void emitLoginContext(JsonResponse &resp);
  void emitRfStats(JsonResponse &resp);
  void emitModuleSettings(JsonResponse &resp);
  void emitController(JsonResponse &resp, bool includeSecrets);
  // Command cores shared by the transports: they only write into resp when the
  // target exists (headers go out at the first flush), so the shells can still
  // answer the exact legacy error texts otherwise.
  void parseCommandJson(JsonObject &obj, somfy_cmd_req_t &cmd);
  bool execShadeCommand(somfy_cmd_req_t &cmd, JsonResponse &resp);
  bool execTiltCommand(somfy_cmd_req_t &cmd, JsonResponse &resp);
  bool execGroupCommand(somfy_cmd_req_t &cmd, JsonResponse &resp);
  // 0 = sent, 1 = shade missing, 2 = group missing, 3 = no id supplied.
  uint8_t execRepeatCommand(somfy_cmd_req_t &cmd, JsonResponse &resp);
  void emitNetworkSettings(JsonResponse &resp);
  void emitMqttSettings(JsonResponse &resp);
  void emitRadio(JsonResponse &resp);
  // Serialized into buff (the security payload goes through ArduinoJson, not
  // the streaming formatter); returns the JSON text length.
  size_t buildSecurityJson(char *buff, size_t size);

  //void chunkRoomsResponse(WebServer &server, const char *elem = nullptr);
  //void chunkShadesResponse(WebServer &server, const char *elem = nullptr);
  //void chunkGroupsResponse(WebServer &server, const char *elem = nullptr);
  //void chunkGroupResponse(WebServer &server, SomfyGroup *, const char *prefix = nullptr);
};
// Shared between the Web*.cpp translation units.  One response buffer for the whole
// (single-threaded) server, and the canonical MIME strings.  handleStreamFile()
// compares encodings by POINTER (encoding == _encoding_html), so every file must
// reference these single definitions in Web.cpp -- duplicating the string literals
// per file would silently break that comparison.
#define WEB_MAX_RESPONSE 4096
extern char g_content[WEB_MAX_RESPONSE];
extern const char _response_404[];
extern const char _encoding_text[];
extern const char _encoding_html[];
extern const char _encoding_json[];
extern WebServer server;
extern WebServer apiServer;
#endif
