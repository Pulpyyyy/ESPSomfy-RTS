#ifndef SOMFY_H
#define SOMFY_H
#include "ConfigSettings.h"
#include "WResp.h"
#include "Transceiver.h"

#define SOMFY_MAX_SHADES 32
#define SOMFY_MAX_GROUPS 16
#define SOMFY_MAX_LINKED_REMOTES 7
#define SOMFY_MAX_GROUPED_SHADES 32
#define SOMFY_MAX_ROOMS 16
#define SOMFY_MAX_REPEATERS 7

#define SECS_TO_MILLIS(x) ((x) * 1000)
#define MINS_TO_MILLIS(x) SECS_TO_MILLIS((x) * 60)

#define SOMFY_SUN_TIMEOUT MINS_TO_MILLIS(2)
#define SOMFY_NO_SUN_TIMEOUT MINS_TO_MILLIS(20)

#define SOMFY_WIND_TIMEOUT SECS_TO_MILLIS(2)
#define SOMFY_NO_WIND_TIMEOUT MINS_TO_MILLIS(12)
#define SOMFY_NO_WIND_REMOTE_TIMEOUT SECS_TO_MILLIS(30)

// Repeat counts for hold/long-press command trains.
#define SETMY_REPEATS 35
#define TILT_REPEATS 15
// A command whose repeat count reaches this is a "hold"/long-press (set-My = SETMY_REPEATS=35,
// tilt holds and euromode = TILT_REPEATS=15). Those need a CONTIGUOUS frame train for the motor
// to register them, so they are sent fully synchronously instead of being interleaved into the
// non-blocking queue. Normal presses (up/down/my/stop/step, a handful of repeats) do not need
// contiguity -- the repeater path already spaces such frames 100ms apart -- so they are queued.
#define TX_CONTIGUOUS_REPEATS TILT_REPEATS


enum class group_types : byte {
  channel = 0x00
};
enum class shade_types : byte {
  roller = 0x00,
  blind = 0x01,
  ldrapery = 0x02,
  awning = 0x03,
  shutter = 0x04,
  garage1 = 0x05,
  garage3 = 0x06,
  rdrapery = 0x07,
  cdrapery = 0x08,
  drycontact = 0x09,
  drycontact2 = 0x0A,
  lgate = 0x0B,
  cgate = 0x0C,
  rgate = 0x0D,
  lgate1 = 0x0E,
  cgate1 = 0x0F,
  rgate1 = 0x10
};
enum class tilt_types : byte {
  none = 0x00,
  tiltmotor = 0x01,
  integrated = 0x02,
  tiltonly = 0x03,
  euromode = 0x04
};
// Command that checkMovement() deferred because the sequence it belongs to must leave a
// short gap on the air after the transmission that precedes it.  The gap used to be a
// delay() inside checkMovement(), which froze the whole loop.
enum class pending_cmd_t : byte {
  none = 0x00,
  tiltTarget = 0x01,  // moveToTiltTarget() after the stop that ends a positioning move
  setMyPos = 0x02     // record the My position once the shade has settled on its target
};

enum class somfy_flags_t : byte {
    SunFlag = 0x01,
    SunSensor = 0x02,
    DemoMode = 0x04,
    Light = 0x08,
    Windy = 0x10,
    Sunny = 0x20,
    Lighted = 0x40,
    SimMy = 0x80
};
enum class gpio_flags_t : byte {
  LowLevelTrigger = 0x01
};

class SomfyRoom {
  public:
    uint8_t roomId = 0;
    char name[21] = "";
    int8_t sortOrder = 0;
    void clear();
    bool save();
    bool fromJSON(JsonObject &obj);
    void toJSON(JsonResponse &json);
    void emitState(const char *evt = "roomState");
    void emitState(uint8_t num, const char *evt = "roomState");
    void publish();
    void unpublish();
};

class SomfyRemote {
  // These sizes for the data have been
  // confirmed.  The address is actually 24bits
  // and the rolling code is 16 bits.
  protected:
    char m_remotePrefId[11] = "";
    uint32_t m_remoteAddress = 0;
  public:
    radio_proto proto = radio_proto::RTS;
    uint8_t gpioFlags = 0;
    int8_t gpioDir = 0;
    uint8_t gpioUp = 0;
    uint8_t gpioDown = 0;
    uint8_t gpioMy = 0;
    uint32_t gpioRelease = 0;
    somfy_frame_t lastFrame;
    bool flipCommands = false;
    uint16_t lastRollingCode = 0;
    uint8_t flags = 0;
    uint8_t bitLength = 0;
    uint8_t repeats = 1;
    virtual bool isLastCommand(somfy_commands cmd);
    char *getRemotePrefId() {return m_remotePrefId;}
    virtual void toJSON(JsonResponse &json);
    virtual void setRemoteAddress(uint32_t address);
    virtual uint32_t getRemoteAddress();
    virtual uint16_t getNextRollingCode();
    virtual uint16_t setRollingCode(uint16_t code);
    bool hasSunSensor();
    bool hasLight();
    bool simMy();
    void setSunSensor(bool bHasSensor);
    void setLight(bool bHasLight);
    void setSimMy(bool bSimMy);
    virtual void sendCommand(somfy_commands cmd);
    virtual void sendCommand(somfy_commands cmd, uint8_t repeat, uint8_t stepSize = 0);
    void sendSensorCommand(int8_t isWindy, int8_t isSunny, uint8_t repeat);
    void repeatFrame(uint8_t repeat);
    virtual uint16_t p_lastRollingCode(uint16_t code);
    somfy_commands transformCommand(somfy_commands cmd);
    virtual void triggerGPIOs(somfy_frame_t &frame);
   
};
class SomfyLinkedRemote : public SomfyRemote {
  public:
    SomfyLinkedRemote();    
};
class SomfyShade : public SomfyRemote {
  protected:
    uint8_t shadeId = 255;
    // millis() timestamps. Kept 32-bit so that (millis() - start) elapsed math wraps
    // correctly at the 49.7-day rollover; in uint64 the same subtraction produced a
    // huge value at the wrap and snapped a moving shade straight to its target.
    uint32_t moveStart = 0;
    uint32_t tiltStart = 0;
    uint32_t noSunStart = 0;
    uint32_t sunStart = 0;
    uint32_t windStart = 0;
    uint32_t windLast = 0;
    uint32_t noWindStart = 0;
    bool noSunDone = true;
    bool sunDone = true;
    bool windDone = true;
    bool noWindDone = true;
    float startPos = 0.0f;
    float startTiltPos = 0.0f;
    float startLiftPos = 0.0f;
    bool settingMyPos = false;
    bool settingPos = false;
    bool settingTiltPos = false;
    uint32_t awaitMy = 0;
    // Non-blocking inter-command gap.  Some sequences must leave a pause between two RTS
    // transmissions; that pause used to be a delay() inside checkMovement() which stalled
    // the entire loop (watchdog, sockets, MQTT and every other shade) while a shade was
    // moving.  It is now a deadline: checkMovement() leaves the shade untouched until the
    // gap has elapsed, then runs the deferred command.
    pending_cmd_t pendingCmd = pending_cmd_t::none;
    uint32_t pendingCmdStart = 0;  // millis() when the gap started
    uint32_t pendingCmdDelay = 0;  // length of the gap in ms
    uint32_t lastMoveEmit = 0;     // millis() of the last position-progress socket emit
    void startCmdGap(pending_cmd_t cmd, uint32_t ms);
    // Second stage of the "record the My position" sequence, split out of checkMovement()
    // so it can run when the gap that precedes it expires.
    void finishSetMyPosition();
  public:
    uint8_t roomId = 0;
    int8_t sortOrder = 0;
    bool flipPosition = false;
    shade_types shadeType = shade_types::roller;
    tilt_types tiltType = tilt_types::none;
    #ifdef USE_NVS
    void load();
    #endif
    float currentPos = 0.0f;
    float currentTiltPos = 0.0f;
    // Fraction of the slats stacked at the fully closed position (0=unstacked, 1=stacked).
    // Updated continuously in checkMovement like currentPos so that re-snapshotting
    // startPos/moveStart (received frames, stops) never loses slat progress.
    float liftPos = 0.0f;
    int8_t lastMovement = 0;
    int8_t direction = 0; // 0 = stopped, 1=down, -1=up.
    int8_t tiltDirection = 0; // 0=stopped, 1=clockwise, -1=counter clockwise
    float target = 0.0f;
    float tiltTarget = 0.0f;
    float myPos = -1.0f;
    float myTiltPos = -1.0f;
    SomfyLinkedRemote linkedRemotes[SOMFY_MAX_LINKED_REMOTES];
    bool paired = false;
    int8_t validateJSON(JsonObject &obj);
    void toJSONRef(JsonResponse &json);
    // includeSecrets=false blanks the remote address and rolling code, which are the
    // only secret in the RTS protocol.  Used when serving unauthenticated requests.
    void toJSONRef(JsonResponse &json, bool includeSecrets);
    int8_t fromJSON(JsonObject &obj);
    void toJSON(JsonResponse &json) override;
    void toJSON(JsonResponse &json, bool includeSecrets);
    
    char name[21] = "";
    void setShadeId(uint8_t id) { shadeId = id; }
    uint8_t getShadeId() { return shadeId; }
    uint32_t upTime = 10000;
    uint32_t downTime = 10000;
    // Time for the slats to stack/unstack at the fully closed position. The shade does not
    // actually travel during this time so it is added to upTime/downTime at the closed end.
    uint32_t liftTime = 0;
    uint32_t tiltTime = 7000;
    // Winding non-linearity correction (0 = linear/off). The roller changes diameter as the
    // curtain winds, so the visible position is not linear in travel time. curveForward maps
    // the time-linear internal position to the visible position; curveInverse does the reverse.
    // Kept internal to the timing engine so all stored positions stay in visible units.
    float curveGain = 0.0f;
    uint16_t stepSize = 100;
    bool save();
    bool isIdle();
    bool isInGroup();
    uint32_t effectiveLiftTime();
    float curveForward(float pos);  // time-linear internal % -> visible %
    float curveInverse(float pos);  // visible % -> time-linear internal %
    float stepUpTarget(uint32_t msStep);
    float stepDownTarget(uint32_t msStep);
    void checkMovement();
    void processFrame(somfy_frame_t &frame, bool internal = false);
    void processInternalCommand(somfy_commands cmd, uint8_t repeat = 1);
    void setTiltMovement(int8_t dir);
    void setMovement(int8_t dir);
    void setTarget(float target);
    bool isAtTarget();
    bool isToggle();
    void moveToTarget(float pos, float tilt = -1.0f);
    void moveToTiltTarget(float target);
    void sendTiltCommand(somfy_commands cmd);
    void sendCommand(somfy_commands cmd);
    void sendCommand(somfy_commands cmd, uint8_t repeat, uint8_t stepSize = 0);
    bool linkRemote(uint32_t remoteAddress, uint16_t rollingCode = 0);
    bool unlinkRemote(uint32_t remoteAddress);
    void emitState(const char *evt = "shadeState");
    void emitState(uint8_t num, const char *evt = "shadeState");
    void emitCommand(somfy_commands cmd, const char *source, uint32_t sourceAddress, const char *evt = "shadeCommand");
    void emitCommand(uint8_t num, somfy_commands cmd, const char *source, uint32_t sourceAddress, const char *evt = "shadeCommand");
    void setMyPosition(int8_t pos, int8_t tilt = -1);
    void moveToMyPosition();
    void processWaitingFrame();
    void publish();
    void unpublish();
    static void unpublish(uint8_t id);
    static void unpublish(uint8_t id, const char *topic);
    void publishState();
    void commit();
    void commitShadePosition();
    void commitTiltPosition();
    void commitMyPosition();
    void clear();
    int8_t transformPosition(float fpos);
    void setGPIOs();
    void triggerGPIOs(somfy_frame_t &frame);
    bool usesPin(uint8_t pin);
    // State Setters
    int8_t p_direction(int8_t dir);
    int8_t p_tiltDirection(int8_t dir);
    float p_target(float target);
    float p_tiltTarget(float target);
    float p_myPos(float pos);
    float p_myTiltPos(float pos);
    bool p_flag(somfy_flags_t flag, bool val);
    bool p_sunFlag(bool val);
    bool p_sunny(bool val);
    bool p_windy(bool val);
    float p_currentPos(float pos);
    float p_currentTiltPos(float pos);
    uint16_t p_lastRollingCode(uint16_t code);
    bool publish(const char *topic, const char *val, bool retain = false);
    bool publish(const char *topic, uint8_t val, bool retain = false);
    bool publish(const char *topic, int8_t val, bool retain = false);
    bool publish(const char *topic, uint32_t val, bool retain = false);
    bool publish(const char *topic, uint16_t val, bool retain = false);
    bool publish(const char *topic, bool val, bool retain = false);
    void publishDisco();
    void unpublishDisco();
};
class SomfyGroup : public SomfyRemote {
  protected:
    uint8_t groupId = 255;
  public:
    uint8_t roomId = 0;
    int8_t sortOrder = 0;
    group_types groupType = group_types::channel;
    int8_t direction = 0; // 0 = stopped, 1=down, -1=up.
    char name[21] = "";
    uint8_t linkedShades[SOMFY_MAX_GROUPED_SHADES];
    void setGroupId(uint8_t id) { groupId = id; }
    uint8_t getGroupId() { return groupId; }
    bool save();
    void clear();
    bool fromJSON(JsonObject &obj);
    //bool toJSON(JsonObject &obj);
    void toJSON(JsonResponse &json);
    void toJSON(JsonResponse &json, bool includeSecrets);
    void toJSONRef(JsonResponse &json);
    void toJSONRef(JsonResponse &json, bool includeSecrets);

    bool linkShade(uint8_t shadeId);
    bool unlinkShade(uint8_t shadeId);
    bool hasShadeId(uint8_t shadeId);
    void compressLinkedShadeIds();
    void publish();
    void unpublish();
    static void unpublish(uint8_t id);
    static void unpublish(uint8_t id, const char *topic);
    void publishState();
    void updateFlags();
    void emitState(const char *evt = "groupState");
    void emitState(uint8_t num, const char *evt = "groupState");
    void sendCommand(somfy_commands cmd);
    void sendCommand(somfy_commands cmd, uint8_t repeat, uint8_t stepSize = 0);
    int8_t p_direction(int8_t dir);
    bool publish(const char *topic, uint8_t val, bool retain = false);
    bool publish(const char *topic, int8_t val, bool retain = false);
    bool publish(const char *topic, uint32_t val, bool retain = false);
    bool publish(const char *topic, uint16_t val, bool retain = false);
    bool publish(const char *topic, bool val, bool retain = false);
};
class SomfyShadeController {
  protected:
    uint8_t m_shadeIds[SOMFY_MAX_SHADES];
    uint32_t lastCommit = 0;
  public:
    bool useNVS();
    bool isDirty = false;
    uint32_t startingAddress;
    uint8_t getNextRoomId();
    uint8_t getNextShadeId();
    uint8_t getNextGroupId();
    int8_t getMaxRoomOrder();
    int8_t getMaxShadeOrder();
    int8_t getMaxGroupOrder();
    uint32_t getNextRemoteAddress(uint8_t shadeId);
    SomfyShadeController();
    Transceiver transceiver;
    SomfyRoom *addRoom();
    SomfyRoom *addRoom(JsonObject &obj);
    SomfyShade *addShade();
    SomfyShade *addShade(JsonObject &obj);
    SomfyGroup *addGroup();
    SomfyGroup *addGroup(JsonObject &obj);
    bool deleteRoom(uint8_t roomId);
    bool deleteShade(uint8_t shadeId);
    bool deleteGroup(uint8_t groupId);
    bool begin();
    void loop();
    bool allIdle();  // true when no shade is travelling (guards blocking work in the loop)
    void end();
    void compressRepeaters();
    uint32_t repeaters[SOMFY_MAX_REPEATERS] = {0};
    SomfyRoom rooms[SOMFY_MAX_ROOMS];
    SomfyShade shades[SOMFY_MAX_SHADES];
    SomfyGroup groups[SOMFY_MAX_GROUPS];
    bool linkRepeater(uint32_t address);
    bool unlinkRepeater(uint32_t address);
    void toJSONShades(JsonResponse &json);
    void toJSONShades(JsonResponse &json, bool includeSecrets);
    void toJSONRooms(JsonResponse &json);
    void toJSONGroups(JsonResponse &json);
    void toJSONGroups(JsonResponse &json, bool includeSecrets);
    void toJSONRepeaters(JsonResponse &json);
    uint8_t repeaterCount();
    uint8_t roomCount();
    uint8_t shadeCount();
    uint8_t groupCount();
    void updateGroupFlags();
    SomfyShade * getShadeById(uint8_t shadeId);
    SomfyRoom * getRoomById(uint8_t roomId);
    SomfyGroup * getGroupById(uint8_t groupId);
    SomfyShade * findShadeByRemoteAddress(uint32_t address);
    SomfyGroup * findGroupByRemoteAddress(uint32_t address);
    void sendFrame(somfy_frame_t &frame, uint8_t repeats = 0);
    void processFrame(somfy_frame_t &frame, bool internal = false);
    void emitState(uint8_t num = 255);
    void publish();
    void processWaitingFrame();
    void commit();
    void writeBackup();
    bool loadShadesFile(const char *filename);
    #ifdef USE_NVS
    bool loadLegacy();
    #endif
};

#endif
