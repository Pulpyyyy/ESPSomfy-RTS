#include <Preferences.h>
#include <ELECHOUSE_CC1101_SRC_DRV.h>
#include <SPI.h>
#include <WebServer.h>
#include <esp_task_wdt.h>
#include "Utils.h"
#include "ConfigSettings.h"
#include "Somfy.h"
#include "Sockets.h"
#include "MQTT.h"
#include "ConfigFile.h"
#include "GitOTA.h"
#include "SomfyCodec.h"
#include "RfStats.h"

extern Preferences pref;
extern SomfyShadeController somfy;
extern SocketEmitter sockEmit;
extern ConfigSettings settings;
extern MQTTClass mqtt;
extern GitUpdater git;
extern RfStats rfStats;


// SETMY_REPEATS / TILT_REPEATS / TX_CONTIGUOUS_REPEATS live in Somfy.h: the movement
// engine and the controller transmit path both key off them.
// Minimum interval between two position-progress socket emits of the same shade
// while it travels. emitState() serialises the full shade and broadcasts it to
// every socket client; at up to SOMFY_MAX_SHADES moving at once, one emit per 1%
// step floods the loop so it runs slower and skips positions. Start/stop/arrival
// (direction changes) are still emitted immediately, so no transition is lost.
#define MOVE_EMIT_INTERVAL 250

somfy_commands translateSomfyCommand(const String& string) {
    if (string.equalsIgnoreCase("My")) return somfy_commands::My;
    else if (string.equalsIgnoreCase("Up")) return somfy_commands::Up;
    else if (string.equalsIgnoreCase("MyUp")) return somfy_commands::MyUp;
    else if (string.equalsIgnoreCase("Down")) return somfy_commands::Down;
    else if (string.equalsIgnoreCase("MyDown")) return somfy_commands::MyDown;
    else if (string.equalsIgnoreCase("UpDown")) return somfy_commands::UpDown;
    else if (string.equalsIgnoreCase("MyUpDown")) return somfy_commands::MyUpDown;
    else if (string.equalsIgnoreCase("Prog")) return somfy_commands::Prog;
    else if (string.equalsIgnoreCase("SunFlag")) return somfy_commands::SunFlag;
    else if (string.equalsIgnoreCase("StepUp")) return somfy_commands::StepUp;
    else if (string.equalsIgnoreCase("StepDown")) return somfy_commands::StepDown;
    else if (string.equalsIgnoreCase("Flag")) return somfy_commands::Flag;
    else if (string.equalsIgnoreCase("Sensor")) return somfy_commands::Sensor;
    else if (string.equalsIgnoreCase("Toggle")) return somfy_commands::Toggle;
    else if (string.equalsIgnoreCase("Favorite")) return somfy_commands::Favorite;
    else if (string.equalsIgnoreCase("Stop")) return somfy_commands::Stop;
    else if (string.startsWith("fav") || string.startsWith("FAV")) return somfy_commands::Favorite;
    else if (string.startsWith("mud") || string.startsWith("MUD")) return somfy_commands::MyUpDown;
    else if (string.startsWith("md") || string.startsWith("MD")) return somfy_commands::MyDown;
    else if (string.startsWith("ud") || string.startsWith("UD")) return somfy_commands::UpDown;
    else if (string.startsWith("mu") || string.startsWith("MU")) return somfy_commands::MyUp;
    else if (string.startsWith("su") || string.startsWith("SU")) return somfy_commands::StepUp;
    else if (string.startsWith("sd") || string.startsWith("SD")) return somfy_commands::StepDown;
    else if (string.startsWith("sen") || string.startsWith("SEN")) return somfy_commands::Sensor;
    else if (string.startsWith("p") || string.startsWith("P")) return somfy_commands::Prog;
    else if (string.startsWith("u") || string.startsWith("U")) return somfy_commands::Up;
    else if (string.startsWith("d") || string.startsWith("D")) return somfy_commands::Down;
    else if (string.startsWith("m") || string.startsWith("M")) return somfy_commands::My;
    else if (string.startsWith("f") || string.startsWith("F")) return somfy_commands::Flag;
    else if (string.startsWith("s") || string.startsWith("S")) return somfy_commands::SunFlag;
    else if (string.startsWith("t") || string.startsWith("T")) return somfy_commands::Toggle;
    else if (string.length() == 1) return static_cast<somfy_commands>(strtol(string.c_str(), nullptr, 16));
    else return somfy_commands::My;
}
String translateSomfyCommand(const somfy_commands cmd) {
    switch (cmd) {
    case somfy_commands::Up:
        return "Up";
    case somfy_commands::Down:
        return "Down";
    case somfy_commands::My:
        return "My";
    case somfy_commands::MyUp:
        return "My+Up";
    case somfy_commands::UpDown:
        return "Up+Down";
    case somfy_commands::MyDown:
        return "My+Down";
    case somfy_commands::MyUpDown:
        return "My+Up+Down";
    case somfy_commands::Prog:
        return "Prog";
    case somfy_commands::SunFlag:
        return "Sun Flag";
    case somfy_commands::Flag:
        return "Flag";
    case somfy_commands::StepUp:
        return "Step Up";
    case somfy_commands::StepDown:
        return "Step Down";
    case somfy_commands::Sensor:
        return "Sensor";
    case somfy_commands::Toggle:
        return "Toggle";
    case somfy_commands::Favorite:
        return "Favorite";
    case somfy_commands::Stop:
        return "Stop";
    default:
        return "Unknown(" + String((uint8_t)cmd) + ")";
    }
}
// The bit level primitives live in SomfyCodec.cpp so they can be unit tested on
// the host (test/test_somfy); the methods below stay as the callers know them.
byte somfy_frame_t::calc80Checksum(byte b0, byte b1, byte b2) { return somfy_codec::checksum80(b0, b1, b2); }
void somfy_frame_t::decodeFrame(byte* frame) {
    byte decoded[10];
    // The last 3 bytes are not encoded even on 80-bits. Go figure.
    somfy_codec::deobfuscate(frame, decoded, somfy_codec::FRAME_LEN_80);
    byte checksum = somfy_codec::checksumDecoded(decoded);

    this->checksum = decoded[1] & 0b1111;
    this->encKey = decoded[0];
    // Lets first determine the protocol.
    this->cmd = (somfy_commands)((decoded[1] >> 4));
    if(this->cmd == somfy_commands::RTWProto) {
      if(this->encKey >= 160) {
        this->proto = radio_proto::RTS;
        if(this->encKey == 164) this->cmd = somfy_commands::Toggle;
      }
      else if(this->encKey > 148) {
        this->proto = radio_proto::RTV;
        this->cmd = (somfy_commands)(this->encKey - 148);
      }
      else if(this->encKey > 132) {
        this->proto = radio_proto::RTW;
        this->cmd = (somfy_commands)(this->encKey - 132);
      }
    }
    else this->proto = radio_proto::RTS;
    // We reuse this memory address so we must reset the processed
    // flag.  This will ensure we can see frames on the first beat.
    this->processed = false;
    this->rollingCode = decoded[3] + (decoded[2] << 8);
    this->remoteAddress = (decoded[6] + (decoded[5] << 8) + (decoded[4] << 16));
    this->valid = this->checksum == checksum && this->remoteAddress > 0 && this->remoteAddress < 16777215;
    if (this->cmd != somfy_commands::Sensor && this->valid) this->valid = (this->rollingCode > 0);
    // Next lets process some of the RTS extensions for 80-bit frames
    if(this->valid && this->proto == radio_proto::RTS && this->bitLength == 80) {
      // Do a parity checksum on the 80 bit data.
      if((decoded[9] & 0x0F) != this->calc80Checksum(decoded[7], decoded[8], decoded[9])) this->valid = false;
      if(this->valid) {
        // Translate extensions for stop and favorite.
        if(this->cmd == somfy_commands::My) this->cmd = (somfy_commands)((decoded[1] >> 4) | ((decoded[8] & 0x0F) << 4));
        // Bit packing to get the step size prohibits translation on the byte.
        else if(this->cmd == somfy_commands::StepDown) this->cmd = (somfy_commands)((decoded[1] >> 4) | ((decoded[8] & 0x08) << 4));
      }
    }
    if (this->valid) {

        // Check for valid command.
        switch (this->cmd) {
        //case somfy_commands::Unknown0:
        case somfy_commands::My:
        case somfy_commands::Up:
        case somfy_commands::MyUp:
        case somfy_commands::Down:
        case somfy_commands::MyDown:
        case somfy_commands::UpDown:
        case somfy_commands::MyUpDown:
        case somfy_commands::Prog:
        case somfy_commands::Flag:
        case somfy_commands::SunFlag:
        case somfy_commands::Sensor:
            break;
        case somfy_commands::UnknownD:
        case somfy_commands::RTWProto:
            this->valid = false;
            break;
        case somfy_commands::StepUp:
        case somfy_commands::StepDown:
            // Decode the step size.
            this->stepSize = ((decoded[8] & 0x07) << 4) | ((decoded[9] & 0xF0) >> 4);
            break;
        case somfy_commands::Toggle:
        case somfy_commands::Favorite:
        case somfy_commands::Stop:
            break;
        default:
            this->valid = false;
            break;
        }
    }
    if(this->valid && this->encKey == 0) this->valid = false;
    // RF interference produces a steady stream of invalid frames; dumping ~30 serial
    // lines for each one stalls the loop. Off by default; define DEBUG_INVALID_FRAMES
    // to restore the full decode dump when diagnosing reception.
#ifdef DEBUG_INVALID_FRAMES
    if (!this->valid) {
        Serial.print("INVALID FRAME ");
        Serial.print("KEY:");
        Serial.print(this->encKey);
        Serial.print(" ADDR:");
        Serial.print(this->remoteAddress);
        Serial.print(" CMD:");
        Serial.print(translateSomfyCommand(this->cmd));
        Serial.print(" RCODE:");
        Serial.println(this->rollingCode);
        Serial.println("    KEY  1   2   3   4   5   6  ");
        Serial.println("--------------------------------");
        Serial.print("ENC ");
        for (byte i = 0; i < 10; i++) {
            if (frame[i] < 10)
                Serial.print("  ");
            else if (frame[i] < 100)
                Serial.print(" ");
            Serial.print(frame[i]);
            Serial.print(" ");
        }
        Serial.println();
        Serial.print("DEC ");
        for (byte i = 0; i < 10; i++) {
            if (decoded[i] < 10)
                Serial.print("  ");
            else if (decoded[i] < 100)
                Serial.print(" ");
            Serial.print(decoded[i]);
            Serial.print(" ");
        }
        Serial.println();
    }
#endif
}
void somfy_frame_t::decodeFrame(somfy_rx_t *rx) {
  this->hwsync = rx->cpt_synchro_hw;
  this->pulseCount = rx->pulseCount;
  this->bitLength = rx->bit_length;
  this->rssi = ELECHOUSE_cc1101.getRssi();
  this->decodeFrame(rx->payload);
}
byte somfy_frame_t::encode80Byte7(byte start, uint8_t repeat) { return somfy_codec::encode80Byte7(start, repeat); }
void somfy_frame_t::encode80BitFrame(byte *frame, uint8_t repeat) {
  switch(this->cmd) {
    // Step up and down commands encode the step size into the last 3 bytes.
    case somfy_commands::StepUp:
      if(repeat == 0) frame[1] = (static_cast<byte>(somfy_commands::StepDown) << 4) | (frame[1] & 0x0F);
      if(this->stepSize == 0) this->stepSize = 1;
      frame[7] = 132; // For simplicity this appears to be constant.
      frame[8] = ((this->stepSize & 0x70) >> 4) | 0x38;
      frame[9] = ((this->stepSize & 0x0F) << 4);
      frame[9] |= this->calc80Checksum(frame[7], frame[8], frame[9]);
      break;
    case somfy_commands::StepDown:
      if(repeat == 0) frame[1] = (static_cast<byte>(somfy_commands::StepDown) << 4) | (frame[1] & 0x0F);
      if(this->stepSize == 0) this->stepSize = 1;
      frame[7] = 132; // For simplicity this appears to be constant.
      frame[8] = ((this->stepSize & 0x70) >> 4) | 0x30;
      frame[9] = ((this->stepSize & 0x0F) << 4);
      frame[9] |= this->calc80Checksum(frame[7], frame[8], frame[9]);
      break;
    case somfy_commands::Favorite:
      if(repeat == 0) frame[1] = (static_cast<byte>(somfy_commands::My) << 4) | (frame[1] & 0x0F);
      frame[7] = repeat > 0 ? 132 : 196;
      frame[8] = 44;
      frame[9] = 0x90;
      frame[9] |= this->calc80Checksum(frame[7], frame[8], frame[9]);
      break;
    case somfy_commands::Stop:
      if(repeat == 0) frame[1] = (static_cast<byte>(somfy_commands::My) << 4) | (frame[1] & 0x0F);
      frame[7] = repeat > 0 ? 132 : 196;
      frame[8] = 47;
      frame[9] = 0xF0;
      frame[9] |= this->calc80Checksum(frame[7], frame[8], frame[9]);
      break;
    case somfy_commands::Toggle:
      frame[0] = 164;
      frame[1] |= 0xF0;
      frame[7] = this->encode80Byte7(196, repeat);
      frame[8] = 0;
      frame[9] = 0x10;
      frame[9] |= this->calc80Checksum(frame[7], frame[8], frame[9]);
      break;
    case somfy_commands::Up:
      frame[7] = this->encode80Byte7(196, repeat);
      frame[8] = 32;
      frame[9] = 0x00;
      frame[9] |= this->calc80Checksum(frame[7], frame[8], frame[9]);
      break;
    case somfy_commands::Down:
      frame[7] = this->encode80Byte7(196, repeat);
      frame[8] = 44;
      frame[9] = 0x80;
      frame[9] |= this->calc80Checksum(frame[7], frame[8], frame[9]);
      break;
    case somfy_commands::Prog:
    case somfy_commands::UpDown:
    case somfy_commands::MyDown:
    case somfy_commands::MyUp:
    case somfy_commands::MyUpDown:
    case somfy_commands::My:
      frame[7] = this->encode80Byte7(196, repeat);
      frame[8] = 0x00;
      frame[9] = 0x10;
      frame[9] |= this->calc80Checksum(frame[7], frame[8], frame[9]);
      break;      
    
    default:
      break;
  }
}
void somfy_frame_t::encodeFrame(byte *frame) { 
  const byte btn = static_cast<byte>(cmd);
  this->valid = true;
  frame[0] = this->encKey;              // Encryption key. Doesn't matter much
  frame[1] = (btn & 0x0F) << 4;         // Which button did you press? The 4 LSB will be the checksum
  frame[2] = this->rollingCode >> 8;    // Rolling code (big endian)
  frame[3] = this->rollingCode;         // Rolling code
  frame[4] = this->remoteAddress >> 16; // Remote address
  frame[5] = this->remoteAddress >> 8;  // Remote address
  frame[6] = this->remoteAddress;       // Remote address
  frame[7] = 132;
  frame[8] = 0;
  frame[9] = 29;
  // Ok so if this is an RTW things are a bit different.
  if(this->proto == radio_proto::RTW) {
    frame[1] = 0xF0;
    switch(this->cmd) {
      case somfy_commands::My:
        frame[0] = 133;
        break;
      case somfy_commands::Up:
        frame[0] = 134;
        break;
      case somfy_commands::MyUp:
        frame[0] = 135;
        break;
      case somfy_commands::Down:
        frame[0] = 136;
        break;
      case somfy_commands::MyDown:
        frame[0] = 137;
        break;
      case somfy_commands::UpDown:
        frame[0] = 138;
        break;
      case somfy_commands::MyUpDown:
        frame[0] = 139;
        break;
      case somfy_commands::Prog:
        frame[0] = 140;
        break;
      case somfy_commands::SunFlag:
        frame[0] = 141;
        break;
      case somfy_commands::Flag:
        frame[0] = 142;
        break;
      default:
        break;
    }
  }
  else if(this->proto == radio_proto::RTV) {
    frame[1] = 0xF0;
    switch(this->cmd) {
      case somfy_commands::My:
        frame[0] = 149;
        break;
      case somfy_commands::Up:
        frame[0] = 150;
        break;
      case somfy_commands::MyUp:
        frame[0] = 151;
        break;
      case somfy_commands::Down:
        frame[0] = 152;
        break;
      case somfy_commands::MyDown:
        frame[0] = 153;
        break;
      case somfy_commands::UpDown:
        frame[0] = 154;
        break;
      case somfy_commands::MyUpDown:
        frame[0] = 155;
        break;
      case somfy_commands::Prog:
        frame[0] = 156;
        break;
      case somfy_commands::SunFlag:
        frame[0] = 157;
        break;
      case somfy_commands::Flag:
        frame[0] = 158;
        break;
      default:
        break;
    }
    
  }
  else {
    if(this->bitLength == 80) this->encode80BitFrame(&frame[0], this->repeats);
  }
  // Checksum integration
  frame[1] |= somfy_codec::checksumPlain(frame);
  // Obfuscation: a XOR of all the bytes
  somfy_codec::obfuscate(frame);
}
void somfy_frame_t::print() {
    Serial.println("----------- Receiving -------------");
    Serial.print("RSSI:");
    Serial.print(this->rssi);
    Serial.print(" LQI:");
    Serial.println(this->lqi);
    Serial.print("CMD:");
    Serial.print(translateSomfyCommand(this->cmd));
    Serial.print(" ADDR:");
    Serial.print(this->remoteAddress);
    Serial.print(" RCODE:");
    Serial.println(this->rollingCode);
    Serial.print("KEY:");
    Serial.print(this->encKey, HEX);
    Serial.print(" CS:");
    Serial.println(this->checksum);
}
bool somfy_frame_t::isSynonym(somfy_frame_t &frame) { return this->remoteAddress == frame.remoteAddress && this->cmd != frame.cmd && this->rollingCode == frame.rollingCode; }
bool somfy_frame_t::isRepeat(somfy_frame_t &frame) { return this->remoteAddress == frame.remoteAddress && this->cmd == frame.cmd && this->rollingCode == frame.rollingCode; }
void somfy_frame_t::copy(somfy_frame_t &frame) {
  if(this->isRepeat(frame)) {
    this->repeats++;
    this->rssi = frame.rssi;
    this->lqi = frame.lqi;
  }
  else {
    this->synonym = this->isSynonym(frame);
    this->valid = frame.valid;
    if(!this->synonym) this->processed = frame.processed;
    this->rssi = frame.rssi;
    this->lqi = frame.lqi;
    this->cmd = frame.cmd;
    this->remoteAddress = frame.remoteAddress;
    this->rollingCode = frame.rollingCode;
    this->encKey = frame.encKey;
    this->checksum = frame.checksum;
    this->hwsync = frame.hwsync;
    this->repeats = frame.repeats;
  }
}
void SomfyShadeController::end() { this->transceiver.disableReceive(); }
SomfyShadeController::SomfyShadeController() {
  memset(this->m_shadeIds, 255, sizeof(this->m_shadeIds));
  uint64_t mac = ESP.getEfuseMac();
  this->startingAddress = mac & 0x0FFFFF;
}
bool SomfyShadeController::useNVS() { return !(settings.appVersion.major > 1 || settings.appVersion.minor >= 4); };
SomfyShade *SomfyShadeController::findShadeByRemoteAddress(uint32_t address) {
  for(uint8_t i = 0; i < SOMFY_MAX_SHADES; i++) {
    SomfyShade &shade = this->shades[i];
    if(shade.getRemoteAddress() == address) return &shade;
    else {
      for(uint8_t j = 0; j < SOMFY_MAX_LINKED_REMOTES; j++) {
        if(shade.linkedRemotes[j].getRemoteAddress() == address) return &shade;
      }
    }
  }
  return nullptr;
}
SomfyGroup *SomfyShadeController::findGroupByRemoteAddress(uint32_t address) {
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPS; i++) {
    SomfyGroup &group = this->groups[i];
    if(group.getRemoteAddress() == address) return &group;
  }
  return nullptr;
}
void SomfyShadeController::updateGroupFlags() {
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPS; i++) {
    SomfyGroup *group = &this->groups[i];
    if(group && group->getGroupId() != 255) {
      uint8_t flags = group->flags;
      group->updateFlags();
      if(flags != group->flags)
        group->emitState();
    }
  }
}
#ifdef USE_NVS
bool SomfyShadeController::loadLegacy() {
  Serial.println("Loading Legacy shades using NVS");
  pref.begin("Shades", true);
  pref.getBytes("shadeIds", this->m_shadeIds, sizeof(this->m_shadeIds));
  pref.end();
  for(uint8_t i = 0; i < sizeof(this->m_shadeIds); i++) {
    if(i != 0) DEBUG_SOMFY.print(",");
    DEBUG_SOMFY.print(this->m_shadeIds[i]);
  }
  DEBUG_SOMFY.println();
  sortArray<uint8_t>(this->m_shadeIds, sizeof(this->m_shadeIds));
  #ifdef DEBUG_SOMFY
  for(uint8_t i = 0; i < sizeof(this->m_shadeIds); i++) {
    if(i != 0) DEBUG_SOMFY.print(",");
    DEBUG_SOMFY.print(this->m_shadeIds[i]);
  }
  DEBUG_SOMFY.println();
  #endif

  uint8_t id = 0;
  for(uint8_t i = 0; i < sizeof(this->m_shadeIds); i++) {
    if(this->m_shadeIds[i] == id) this->m_shadeIds[i] = 255;
    id = this->m_shadeIds[i];
    SomfyShade *shade = &this->shades[i];
    shade->setShadeId(id);
    if(id == 255) {
      continue;
    }
    shade->load();
  }
  #ifdef DEBUG_SOMFY
  for(uint8_t i = 0; i < SOMFY_MAX_SHADES; i++) {
    DEBUG_SOMFY.print(this->shades[i].getShadeId());
    DEBUG_SOMFY.print(":");
    DEBUG_SOMFY.print(this->m_shadeIds[i]);
    if(i < SOMFY_MAX_SHADES - 1) DEBUG_SOMFY.print(",");
  }
  Serial.println();
  #endif
  #ifdef USE_NVS
  if(!this->useNVS()) {
    pref.begin("Shades");
    pref.putBytes("shadeIds", this->m_shadeIds, sizeof(this->m_shadeIds));
    pref.end();
  }
  #endif
  this->commit();
  return true;
}
#endif
bool SomfyShadeController::begin() {
  // Load up all the configuration data.
  //ShadeConfigFile::getAppVersion(this->appVersion);
  Serial.printf("App Version:%u.%u.%u\n", settings.appVersion.major, settings.appVersion.minor, settings.appVersion.build);
  #ifdef USE_NVS
  if(!this->useNVS()) {  // At 1.4 we started using the configuration file.  If the file doesn't exist then booh.
    // We need to remove all the extraeneous data from NVS for the shades.  From here on out we
    // will rely on the shade configuration.
    Serial.println("No longer using NVS");
    if(ShadeConfigFile::exists()) {
      ShadeConfigFile::load(this);
    }
    else {
      this->loadLegacy();
    }
    pref.begin("Shades");
    if(pref.isKey("shadeIds")) {
      pref.getBytes("shadeIds", this->m_shadeIds, sizeof(this->m_shadeIds));
      pref.clear(); // Delete all the keys.
    }
    pref.end();
    for(uint8_t i = 0; i < sizeof(this->m_shadeIds); i++) {
      // Start deleting the keys for the shades.
      if(this->m_shadeIds[i] == 255) continue;
      char shadeKey[15];
      sprintf(shadeKey, "SomfyShade%u", this->m_shadeIds[i]);
      pref.begin(shadeKey);
      pref.clear();
      pref.end();
    }
  }
  #endif
  if(ShadeConfigFile::exists()) {
    Serial.println("shades.cfg exists so we are using that");
    ShadeConfigFile::load(this);
  }
  else {
    Serial.println("Starting clean");
    #ifdef USE_NVS
    this->loadLegacy();
    #endif
  }
  this->transceiver.begin();

  // Set the radio type for shades that have yet to be specified.
  bool saveFlag = false;
  for(uint8_t i = 0; i < SOMFY_MAX_SHADES; i++) {
    SomfyShade *shade = &this->shades[i];
    if(shade->getShadeId() != 255 && shade->bitLength == 0) {
      //Serial.printf("Setting bit length to %d\n", this->transceiver.config.type);
      shade->bitLength = this->transceiver.config.type;
      saveFlag = true;
    }
  }
  if(saveFlag) somfy.commit();
  return true;
}
void SomfyShadeController::commit() {
  if(git.lockFS) return;
  esp_task_wdt_reset(); // Make sure we don't reset inadvertently.
  ShadeConfigFile file;
  if(!file.begin()) {
    // Keep isDirty so a later commit retries instead of dropping the changes.
    Serial.println("Cannot open shades.cfg for writing: config NOT saved!");
    return;
  }
  file.save(this);
  bool failed = file.hasWriteError();
  file.end(); // Keeps the previous file untouched when a write failed.
  if(failed) {
    // Keep isDirty so a later commit retries instead of dropping the changes.
    Serial.println("Write error saving shades.cfg: config NOT saved!");
    return;
  }
  this->isDirty = false;
  this->lastCommit = millis();
}
void SomfyShadeController::writeBackup() {
  if(git.lockFS) return;
  esp_task_wdt_reset(); // Make sure we don't reset inadvertently.
  ShadeConfigFile file;
  if(!file.begin("/controller.backup", false)) {
    Serial.println("Cannot open controller.backup for writing: backup NOT saved!");
    return;
  }
  file.backup(this);
  file.end();
}
SomfyRoom * SomfyShadeController::getRoomById(uint8_t roomId) {
  for(uint8_t i = 0; i < SOMFY_MAX_ROOMS; i++) {
    if(this->rooms[i].roomId == roomId) return &this->rooms[i];
  }
  return nullptr;
}
SomfyShade * SomfyShadeController::getShadeById(uint8_t shadeId) {
  for(uint8_t i = 0; i < SOMFY_MAX_SHADES; i++) {
    if(this->shades[i].getShadeId() == shadeId) return &this->shades[i];
  }
  return nullptr;
}
SomfyGroup * SomfyShadeController::getGroupById(uint8_t groupId) {
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPS; i++) {
    if(this->groups[i].getGroupId() == groupId) return &this->groups[i];
  }
  return nullptr;
}
void SomfyShade::clear() {
  this->setShadeId(255);
  this->setRemoteAddress(0);
  this->moveStart = 0;
  this->tiltStart = 0;
  this->noSunStart = 0;
  this->sunStart = 0;
  this->windStart = 0;
  this->windLast = 0;
  this->noWindStart = 0;
  this->noSunDone = true;
  this->sunDone = true;
  this->windDone = true;
  this->noWindDone = true;
  this->startPos = 0.0f;
  this->startTiltPos = 0.0f;
  this->startLiftPos = 0.0f;
  this->liftPos = 0.0f;
  this->settingMyPos = false;
  this->settingPos = false;
  this->settingTiltPos = false;
  this->pendingCmd = pending_cmd_t::none;
  this->pendingCmdStart = 0;
  this->pendingCmdDelay = 0;
  this->awaitMy = 0;
  this->flipPosition = false;
  this->flipCommands = false;
  this->lastRollingCode = 0;
  this->shadeType = shade_types::roller;
  this->tiltType = tilt_types::none;
  //this->txQueue.clear();
  this->currentPos = 0.0f;
  this->currentTiltPos = 0.0f;
  this->direction = 0;
  this->tiltDirection = 0;  
  this->target = 0.0f;
  this->tiltTarget = 0.0f;
  this->myPos = -1.0f;
  this->myTiltPos = -1.0f;
  this->bitLength = somfy.transceiver.config.type;
  this->proto = somfy.transceiver.config.proto;
  for(uint8_t i = 0; i < SOMFY_MAX_LINKED_REMOTES; i++)
    this->linkedRemotes[i].setRemoteAddress(0);
  this->paired = false;
  this->name[0] = 0x00;
  this->upTime = 10000;
  this->downTime = 10000;
  this->liftTime = 0;
  this->curveGain = 0.0f;
  this->tiltTime = 7000;
  this->stepSize = 100;
  this->repeats = 1;
  this->sortOrder = 255;
}
void SomfyRoom::clear() {
  this->roomId = 0;
  strcpy(this->name, "");
}
void SomfyGroup::clear() {
  this->setGroupId(255);
  this->setRemoteAddress(0);
  this->repeats = 0;
  this->roomId = 0;
  this->name[0] = 0x00;
  memset(&this->linkedShades, 0x00, sizeof(this->linkedShades));
}
bool SomfyShade::linkRemote(uint32_t address, uint16_t rollingCode) {
  // Check to see if the remote is already linked. If it is
  // just return true after setting the rolling code
  for(uint8_t i = 0; i < SOMFY_MAX_LINKED_REMOTES; i++) {
    if(this->linkedRemotes[i].getRemoteAddress() == address) {
      this->linkedRemotes[i].setRollingCode(rollingCode);
      return true;
    }
  }
  for(uint8_t i = 0; i < SOMFY_MAX_LINKED_REMOTES; i++) {
    if(this->linkedRemotes[i].getRemoteAddress() == 0) {
      this->linkedRemotes[i].setRemoteAddress(address);
      this->linkedRemotes[i].setRollingCode(rollingCode);
      #ifdef USE_NVS
      if(somfy.useNVS()) {
        uint32_t linkedAddresses[SOMFY_MAX_LINKED_REMOTES];
        memset(linkedAddresses, 0x00, sizeof(linkedAddresses));
        uint8_t j = 0;
        for(uint8_t i = 0; i < SOMFY_MAX_LINKED_REMOTES; i++) {
          SomfyLinkedRemote lremote = this->linkedRemotes[i];
          if(lremote.getRemoteAddress() != 0) linkedAddresses[j++] = lremote.getRemoteAddress();
        }
        char shadeKey[15];
        snprintf(shadeKey, sizeof(shadeKey), "SomfyShade%u", this->getShadeId());
        pref.begin(shadeKey);
        pref.putBytes("linkedAddr", linkedAddresses, sizeof(uint32_t) * SOMFY_MAX_LINKED_REMOTES);
        pref.end();
      }
      #endif
      this->commit();
      return true;
    }
  }
  return false;
}
bool SomfyGroup::linkShade(uint8_t shadeId) {
  // Check to see if the shade is already linked. If it is just return true
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPED_SHADES; i++) {
    if(this->linkedShades[i] == shadeId) {
      return true;
    }
  }
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPED_SHADES; i++) {
    if(this->linkedShades[i] == 0) {
      this->linkedShades[i] = shadeId;
      somfy.commit();
      return true;
    }
  }
  return false;
}
void SomfyShade::commit() { somfy.commit(); }
void SomfyShade::commitShadePosition() {
  somfy.isDirty = true;
  #ifdef USE_NVS
  char shadeKey[15];
  if(somfy.useNVS()) {
    snprintf(shadeKey, sizeof(shadeKey), "SomfyShade%u", this->shadeId);
    Serial.print("Writing current shade position: ");
    Serial.println(this->currentPos, 4);
    pref.begin(shadeKey);
    pref.putFloat("currentPos", this->currentPos);
    pref.end();
  }
  #endif
}
void SomfyShade::commitMyPosition() {
  somfy.isDirty = true;
  #ifdef USE_NVS
  if(somfy.useNVS()) {
    char shadeKey[15];
    snprintf(shadeKey, sizeof(shadeKey), "SomfyShade%u", this->shadeId);
    Serial.print("Writing my shade position:");
    Serial.print(this->myPos);
    Serial.println("%");
    pref.begin(shadeKey);
    pref.putUShort("myPos", this->myPos);
    pref.end();
  }
  #endif
}
void SomfyShade::commitTiltPosition() {
  somfy.isDirty = true;
  #ifdef USE_NVS
  if(somfy.useNVS()) {
    char shadeKey[15];
    snprintf(shadeKey, sizeof(shadeKey), "SomfyShade%u", this->shadeId);
    Serial.print("Writing current shade tilt position: ");
    Serial.println(this->currentTiltPos, 4);
    pref.begin(shadeKey);
    pref.putFloat("currentTiltPos", this->currentTiltPos);
    pref.end();
  }
  #endif
}
bool SomfyShade::unlinkRemote(uint32_t address) {
  for(uint8_t i = 0; i < SOMFY_MAX_LINKED_REMOTES; i++) {
    if(this->linkedRemotes[i].getRemoteAddress() == address) {
      this->linkedRemotes[i].setRemoteAddress(0);
      #ifdef USE_NVS
      if(somfy.useNVS()) {
        char shadeKey[15];
        snprintf(shadeKey, sizeof(shadeKey), "SomfyShade%u", this->getShadeId());
        uint32_t linkedAddresses[SOMFY_MAX_LINKED_REMOTES];
        memset(linkedAddresses, 0x00, sizeof(linkedAddresses));
        uint8_t j = 0;
        for(uint8_t i = 0; i < SOMFY_MAX_LINKED_REMOTES; i++) {
          SomfyLinkedRemote lremote = this->linkedRemotes[i];
          if(lremote.getRemoteAddress() != 0) linkedAddresses[j++] = lremote.getRemoteAddress();
        }
        pref.begin(shadeKey);
        pref.putBytes("linkedAddr", linkedAddresses, sizeof(uint32_t) * SOMFY_MAX_LINKED_REMOTES);
        pref.end();
      }
      #endif
      this->commit();
      return true;
    }
  }
  return false;
}
bool SomfyGroup::unlinkShade(uint8_t shadeId) {
  bool removed = false;
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPED_SHADES; i++) {
    if(this->linkedShades[i] == shadeId) {
      this->linkedShades[i] = 0;
      removed = true;
    }
  }
  // Compress the linked shade ids so we can stop looking on the first 0
  if(removed) {
    this->compressLinkedShadeIds();
    somfy.commit();
  }
  return removed;
}
void SomfyGroup::compressLinkedShadeIds() {
  // [1,0,4,3,0,0,0] i:0,j:0
  // [1,0,4,3,0,0,0] i:1,j:1
  // [1,4,0,3,0,0,0] i:2,j:1
  // [1,4,3,0,0,0,0] i:3,j:2
  // [1,4,3,0,0,0,0] i:4,j:2

  // [1,2,0,0,3,0,0] i:0,j:0
  // [1,2,0,0,3,0,0] i:1,j:1
  // [1,2,0,0,3,0,0] i:2,j:2
  // [1,2,0,0,3,0,0] i:3,j:2
  // [1,2,3,0,0,0,0] i:4,j:2
  // [1,2,3,0,0,0,0] i:5,j:3
  for(uint8_t i = 0, j = 0; i < SOMFY_MAX_GROUPED_SHADES; i++) {
    if(this->linkedShades[i] != 0) {
      if(i != j) {
        this->linkedShades[j] = this->linkedShades[i];
        this->linkedShades[i] = 0;
      }
      j++;
    }
  }
}
void SomfyShadeController::compressRepeaters() {
  for(uint8_t i = 0, j = 0; i < SOMFY_MAX_REPEATERS; i++) {
    if(this->repeaters[i] != 0) {
      if(i != j) {
        this->repeaters[j] = this->repeaters[i];
        this->repeaters[i] = 0;
      }
      j++;
    }
  }
}
bool SomfyGroup::hasShadeId(uint8_t shadeId) {
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPED_SHADES; i++) {
    if(this->linkedShades[i] == 0) break;
    if(this->linkedShades[i] == shadeId) return true;
  }
  return false;
}
bool SomfyShade::isAtTarget() { 
  float epsilon = .00001;
  if(this->tiltType == tilt_types::tiltonly) return fabs(this->currentTiltPos - this->tiltTarget) < epsilon;
  else if(this->tiltType == tilt_types::none) return fabs(this->currentPos - this->target) < epsilon;
  return fabs(this->currentPos - this->target) < epsilon && fabs(this->currentTiltPos - this->tiltTarget) < epsilon; 
}
bool SomfyRemote::simMy() { return (this->flags & static_cast<uint8_t>(somfy_flags_t::SimMy)) > 0; }
void SomfyRemote::setSimMy(bool bSimMy) { bSimMy ? this->flags |= static_cast<uint8_t>(somfy_flags_t::SimMy) : this->flags &= ~(static_cast<uint8_t>(somfy_flags_t::SimMy)); }
bool SomfyRemote::hasSunSensor() { return (this->flags & static_cast<uint8_t>(somfy_flags_t::SunSensor)) > 0;}
bool SomfyRemote::hasLight() { return (this->flags & static_cast<uint8_t>(somfy_flags_t::Light)) > 0; }
void SomfyRemote::setSunSensor(bool bHasSensor ) { bHasSensor ? this->flags |= static_cast<uint8_t>(somfy_flags_t::SunSensor) : this->flags &= ~(static_cast<uint8_t>(somfy_flags_t::SunSensor)); }
void SomfyRemote::setLight(bool bHasLight ) { bHasLight ? this->flags |= static_cast<uint8_t>(somfy_flags_t::Light) : this->flags &= ~(static_cast<uint8_t>(somfy_flags_t::Light)); }

void SomfyGroup::updateFlags() { 
  uint8_t oldFlags = this->flags;
  this->flags = 0;
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPED_SHADES; i++) {
    if(this->linkedShades[i] != 0) {
      SomfyShade *shade = somfy.getShadeById(this->linkedShades[i]);
      if(shade) this->flags |= shade->flags;
    }
    else break;
  }
  if(oldFlags != this->flags) this->emitState();
}
bool SomfyShade::isInGroup() {
  if(this->getShadeId() == 255) return false;
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPS; i++) {
    if(somfy.groups[i].getGroupId() != 255 && somfy.groups[i].hasShadeId(this->getShadeId())) return true;
  }
  return false;
}
void SomfyShade::setGPIOs() {
  if(this->proto == radio_proto::GP_Relay) {
    // Determine whether the direction needs to be set.
    uint8_t p_on = (this->gpioFlags & (uint8_t)gpio_flags_t::LowLevelTrigger) == 0x00 ? HIGH : LOW;
    uint8_t p_off = (this->gpioFlags & (uint8_t)gpio_flags_t::LowLevelTrigger) == 0x00 ? LOW : HIGH;
    
    int8_t dir = this->direction;
    if(dir == 0 && this->tiltType == tilt_types::integrated)
      dir = this->tiltDirection;
    else if(this->tiltType == tilt_types::tiltonly)
      dir = this->tiltDirection;
    if(this->shadeType == shade_types::drycontact) {
      digitalWrite(this->gpioDown, this->currentPos == 100 ? p_on : p_off);
      this->gpioDir = this->currentPos == 100 ? 1 : -1;
    }
    else if(this->shadeType == shade_types::drycontact2) {
      if(this->currentPos == 100) {
        digitalWrite(this->gpioDown, p_off);
        digitalWrite(this->gpioUp, p_on);
      }
      else {
        digitalWrite(this->gpioUp, p_off);
        digitalWrite(this->gpioDown, p_on);
      }
      this->gpioDir = this->currentPos == 100 ? 1 : -1;
    }
    else {
      switch(dir) {
        case -1:
          digitalWrite(this->gpioDown, p_off);
          digitalWrite(this->gpioUp, p_on);
          if(dir != this->gpioDir) Serial.printf("UP: true, DOWN: false\n");
          this->gpioDir = dir;
          break;
        case 1:
          digitalWrite(this->gpioUp, p_off);
          digitalWrite(this->gpioDown, p_on);
          if(dir != this->gpioDir) Serial.printf("UP: false, DOWN: true\n");
          this->gpioDir = dir;
          break;
        default:
          digitalWrite(this->gpioUp, p_off);
          digitalWrite(this->gpioDown, p_off);
          if(dir != this->gpioDir) Serial.printf("UP: false, DOWN: false\n");
          this->gpioDir = dir;
          break;
      }
    }
  }
  else if(this->proto == radio_proto::GP_Remote) {
    // gpioRelease == 0 means "already released": the null guard stops the pins being
    // rewritten every loop, and the subtractive compare keeps the deadline correct
    // across the millis() rollover (plain millis() > deadline breaks at the wrap).
    if(this->gpioRelease != 0 && (int32_t)(millis() - this->gpioRelease) >= 0) {
      //uint8_t p_on = (this->gpioFlags & (uint8_t)gpio_flags_t::LowLevelTrigger) == 0x00 ? HIGH : LOW;
      uint8_t p_off = (this->gpioFlags & (uint8_t)gpio_flags_t::LowLevelTrigger) == 0x00 ? LOW : HIGH;
      digitalWrite(this->gpioUp, p_off);
      digitalWrite(this->gpioDown, p_off);
      digitalWrite(this->gpioMy, p_off);
      this->gpioRelease = 0;
    }
  }
}
void SomfyRemote::triggerGPIOs(somfy_frame_t &frame) { }
void SomfyShade::triggerGPIOs(somfy_frame_t &frame) {
  if(this->proto == radio_proto::GP_Remote) {
    uint8_t p_on = (this->gpioFlags & (uint8_t)gpio_flags_t::LowLevelTrigger) == 0x00 ? HIGH : LOW;
    uint8_t p_off = (this->gpioFlags & (uint8_t)gpio_flags_t::LowLevelTrigger) == 0x00 ? LOW : HIGH;
    int8_t dir = 0;
    switch(frame.cmd) {
      case somfy_commands::My:
        if(this->shadeType != shade_types::drycontact && !this->isToggle()) {
          digitalWrite(this->gpioUp, p_off);
          digitalWrite(this->gpioDown, p_off);
          digitalWrite(this->gpioMy, p_on);
          dir = 0;
          if(dir != this->gpioDir) Serial.printf("UP: false, DOWN: false, MY: true\n");
        }
        break;
      case somfy_commands::Up:
        if(this->shadeType != shade_types::drycontact && !this->isToggle() && this->shadeType != shade_types::drycontact2) {
          digitalWrite(this->gpioMy, p_off);
          digitalWrite(this->gpioDown, p_off);
          digitalWrite(this->gpioUp, p_on);
          dir = -1;
          Serial.printf("UP: true, DOWN: false, MY: false\n");
        }
        break;
      case somfy_commands::Toggle:
      case somfy_commands::Down:
        if(this->shadeType != shade_types::drycontact && !this->isToggle() && this->shadeType != shade_types::drycontact2) {
          digitalWrite(this->gpioMy, p_off);
          digitalWrite(this->gpioUp, p_off);
        }
        digitalWrite(this->gpioDown, p_on);
        dir = 1;
        Serial.printf("UP: false, DOWN: true, MY: false\n");
        break;
      case somfy_commands::MyUp:
        if(this->shadeType != shade_types::drycontact && !this->isToggle() && this->shadeType != shade_types::drycontact2) {
          digitalWrite(this->gpioDown, p_off);
          digitalWrite(this->gpioMy, p_on);
          digitalWrite(this->gpioUp, p_on);
          Serial.printf("UP: true, DOWN: false, MY: true\n");
        }
        break;
      case somfy_commands::MyDown:
        if(this->shadeType != shade_types::drycontact && !this->isToggle() && this->shadeType != shade_types::drycontact2) {
          digitalWrite(this->gpioUp, p_off);
          digitalWrite(this->gpioMy, p_on);
          digitalWrite(this->gpioDown, p_on);
          Serial.printf("UP: false, DOWN: true, MY: true\n");
        }
        break;
      case somfy_commands::MyUpDown:
        if(this->shadeType != shade_types::drycontact && this->isToggle() && this->shadeType != shade_types::drycontact2) {
          digitalWrite(this->gpioUp, p_on);
          digitalWrite(this->gpioMy, p_on);
          digitalWrite(this->gpioDown, p_on);
          Serial.printf("UP: true, DOWN: true, MY: true\n");
        }
        break;
      default:
        break;
    }
    this->gpioRelease = millis() + (frame.repeats * 200);
    this->gpioDir = dir;
  }  
}
uint32_t SomfyShade::effectiveLiftTime() {
  // The slat lift dead time only applies to plain rollers/shutters with interlocking
  // slats. Tilted blinds model their closed-end dead time with tiltTime and dry
  // contacts have none, so liftTime is inert for those types.
  if(this->tiltType != tilt_types::none) return 0;
  if(this->shadeType == shade_types::drycontact || this->shadeType == shade_types::drycontact2) return 0;
  return this->liftTime;
}
// Map the time-linear internal position to the visible position (both in currentPos
// units: 0 = open, 100 = closed):
//   phi(p) = p + k*p*(100-p)/100 = (1+k)p - (k/100)p^2
// The roller is fast near open (large diameter), so the shade is MORE closed than the
// linear estimate at mid-travel -> the curve pushes toward closed (the +k term).
// Direction-independent: the same map applies going up and down. k clamped to [0, 0.95]
// to stay monotonic; 0 = linear. Endpoints are exact (0->0, 100->100).
float SomfyShade::curveForward(float pos) {
  float k = this->curveGain;
  if(k <= 0.0f) return pos;
  if(k > 0.95f) k = 0.95f;
  return pos + k * pos * (100.0f - pos) / 100.0f;
}
// Inverse of curveForward: visible position -> time-linear internal position.
// Solve (k/100)p^2 - (1+k)p + v = 0 for p, taking the root in [0,100].
float SomfyShade::curveInverse(float pos) {
  float k = this->curveGain;
  if(k <= 0.0f) return pos;
  if(k > 0.95f) k = 0.95f;
  float a = k / 100.0f;
  float b = 1.0f + k;
  float disc = b * b - 4.0f * a * pos;
  if(disc <= 0.0f) return pos;
  return (b - sqrtf(disc)) / (2.0f * a);
}
float SomfyShade::stepUpTarget(uint32_t msStep) {
  // Compute the position target for an up step jog of msStep ms. When the slats are
  // stacked the motor spends the jog unstacking them before the curtain can travel so
  // that time produces slat progress instead of movement.
  uint32_t liftTime = this->effectiveLiftTime();
  if(liftTime > 0 && this->liftPos > 0.0f) {
    float lp = this->liftPos - (float)msStep / (float)liftTime;
    if(lp > 0.0f) {
      // The whole jog went into unstacking the slats; the curtain did not move.
      this->liftPos = this->startLiftPos = lp;
      return this->currentPos;
    }
    // Part of the jog freed the slats; only the remainder travels.
    msStep = (uint32_t)floor(-lp * (float)liftTime);
    this->liftPos = this->startLiftPos = 0.0f;
  }
  // The msStep travel is time-linear; convert the current visible position to the
  // time-linear domain, apply the step, and map the result back through the curve.
  return this->curveForward(max(0.0f, this->curveInverse(this->currentPos) - (100.0f * (float)msStep / (float)this->upTime)));
}
float SomfyShade::stepDownTarget(uint32_t msStep) {
  // Compute the position target for a down step jog of msStep ms. The part of the jog
  // left after the curtain reaches the sill stacks the slats; a single step only closes
  // the vents completely if it also covers the remaining lift time.
  // Work in the time-linear domain (curveInverse is a no-op when curveGain is 0), where
  // the stacking check below and the downTime ratio are defined.
  float lin = this->curveInverse(this->currentPos) + (100.0f * (float)msStep / (float)this->downTime);
  uint32_t liftTime = this->effectiveLiftTime();
  if(lin > 100.0f && liftTime > 0) {
    float msStack = (lin - 100.0f) / 100.0f * (float)this->downTime;
    float lp = this->liftPos + msStack / (float)liftTime;
    if(lp < 1.0f) {
      // The curtain is at the sill but the slats are not fully stacked yet.
      this->liftPos = this->startLiftPos = lp;
      return 99.9f;
    }
    // The jog also finishes the stacking; let checkMovement close it out from the
    // snapshot taken when the command was received.
  }
  return this->curveForward(min(100.0f, lin));
}
void SomfyShade::startCmdGap(pending_cmd_t cmd, uint32_t ms) {
  // millis() is read here rather than reusing the curTime snapshot taken when
  // checkMovement() started: the gap must be measured from the end of the transmission
  // that just went out, which is exactly what the delay() call this replaces did.
  this->pendingCmd = cmd;
  this->pendingCmdStart = millis();
  this->pendingCmdDelay = ms;
}
void SomfyShade::checkMovement() {
  const uint32_t curTime = millis();
  // A pending command means an inter-command gap is running.  While it does, this shade
  // must behave exactly as it did when a delay() held the loop here: no position math, no
  // state change, only the deadline is evaluated.  The difference is that the rest of the
  // firmware -- watchdog, web server, sockets, MQTT and the other shades -- keeps running.
  if(this->pendingCmd != pending_cmd_t::none) {
    // Subtractive comparison so the 49.7-day millis() rollover cannot strand the gap.
    if(curTime - this->pendingCmdStart < this->pendingCmdDelay) return;  // still waiting
    const pending_cmd_t pending = this->pendingCmd;
    this->pendingCmd = pending_cmd_t::none;
    if(pending == pending_cmd_t::tiltTarget) {
      // Second half of the stop-then-tilt sequence.  The guards are the ones that were
      // true when it was scheduled; they are re-evaluated because the loop now runs during
      // the gap, so a frame from a physical remote can have cleared settingPos in the
      // meantime (processFrame aborts positioning for any non-internal frame).
      if(this->settingPos && !this->isAtTarget()) this->moveToTiltTarget(this->tiltTarget);
      // Fall through: the rest of this pass is what used to run on the loop pass that
      // followed the blocking delay.
    }
    else if(pending == pending_cmd_t::setMyPos) {
      if(this->settingMyPos && this->isAtTarget()) {
        this->finishSetMyPosition();
        return;  // the blocking version also ended the pass right after this block
      }
    }
  }
  const bool sunFlag = this->flags & static_cast<uint8_t>(somfy_flags_t::SunFlag);
  const bool isSunny = this->flags & static_cast<uint8_t>(somfy_flags_t::Sunny);
  const bool isWindy = this->flags & static_cast<uint8_t>(somfy_flags_t::Windy);
  int32_t downTime = (int32_t)this->downTime;
  int32_t upTime = (int32_t)this->upTime;
  int32_t tiltTime = (int32_t)this->tiltTime;
  int32_t liftTime = (int32_t)this->effectiveLiftTime();
  if(this->shadeType == shade_types::drycontact || this->shadeType == shade_types::drycontact2) downTime = upTime = tiltTime = 1;


  // We need to first evaluate the sensor flags as these could be triggering movement from previous sensor inputs. So
  // we must check this before setting the directional items or it will not get processed until the next loop.
  bool sensorRetarget = false;
  if (sunFlag) {
    if (isSunny && !isWindy) {  // It is sunny and there is no wind so we should be extended
      if (this->noWindDone
          && !this->sunDone
          && this->sunStart
          && (curTime - this->sunStart) >= SOMFY_SUN_TIMEOUT)
      {
        this->p_target(this->myPos >= 0 ? this->myPos : 100.0f);
        //this->target = this->myPos >= 0 ? this->myPos : 100.0f;
        this->sunDone = true;
        sensorRetarget = true;
        Serial.printf("[%u] Sun -> done\r\n", this->shadeId);
      }
      if (!this->noWindDone
          && this->noWindStart
          && (curTime - this->noWindStart) >= SOMFY_NO_WIND_TIMEOUT)
      {
        this->p_target(this->myPos >= 0 ? this->myPos : 100.0f);
        //this->target = this->myPos >= 0 ? this->myPos : 100.0f;
        this->noWindDone = true;
        sensorRetarget = true;
        Serial.printf("[%u] No Wind -> done\r\n", this->shadeId);
      }
    }
    if (!isSunny
        && !this->noSunDone
        && this->noSunStart
        && (curTime - this->noSunStart) >= SOMFY_NO_SUN_TIMEOUT)
    {
      if(this->tiltType == tilt_types::tiltonly) this->p_tiltTarget(0.0f);
      this->p_target(0.0f);
      this->noSunDone = true;
      sensorRetarget = true;
      Serial.printf("[%u] No Sun -> done\r\n", this->shadeId);
    }
  }

  if (isWindy
      && !this->windDone
      && this->windStart
      && (curTime - this->windStart) >= SOMFY_WIND_TIMEOUT)
  {
    if(this->tiltType == tilt_types::tiltonly) this->p_tiltTarget(0.0f);
    this->p_target(0.0f);
    this->windDone = true;
    sensorRetarget = true;
    Serial.printf("[%u] Wind -> done\r\n", this->shadeId);
  }
  if(sensorRetarget) {
    // The motor acts on sensor events by itself; re-baseline the movement math so the
    // position tracks that autonomous travel from where the shade is now. The stale
    // moveStart/startPos of a previous move would otherwise snap the position straight
    // to the new target (and abort any pending positioning like a remote command does).
    this->moveStart = this->tiltStart = curTime;
    this->startPos = this->currentPos;
    this->startTiltPos = this->currentTiltPos;
    this->startLiftPos = this->liftPos;
    this->settingMyPos = this->settingPos = this->settingTiltPos = false;
  }

  // We are checking movement for essentially 3 types of motors.
  // If this is an integrated tilt we need to first tilt in the direction we are moving then move.  We know
  // what needs to be done by the tilt type.  Set a tilt first flag to indicate whether we should be tilting or
  // moving. If this is only a tilt action then the regular tilt action should operate fine.
  int8_t currDir = this->direction;
  int8_t currTiltDir = this->tiltDirection;
  this->p_direction(this->currentPos == this->target ? 0 : this->currentPos > this->target ? -1 : 1);
  bool tilt_first = this->tiltType == tilt_types::integrated && ((this->direction == -1 && this->currentTiltPos != 0.0f) || (this->direction == 1 && this->currentTiltPos != 100.0f));

  this->p_tiltDirection(this->currentTiltPos == this->tiltTarget ? 0 : this->currentTiltPos > this->tiltTarget ? -1 : 1);
  if(tilt_first) this->p_tiltDirection(this->direction);
  else if(this->direction != 0) this->p_tiltDirection(0);
  uint8_t currPos = floor(this->currentPos);
  uint8_t currTiltPos = floor(this->currentTiltPos);
  if(this->direction != 0) this->lastMovement = this->direction;

  if(!tilt_first && this->direction > 0) {
    if(downTime == 0) {
      this->p_currentPos(100.0);
      this->liftPos = 1.0f;
      //this->p_direction(0);
    }
    else {
      // The shade is moving down so we need to calculate its position through the down position.
      // 10000ms from 0 to 100
      // The starting posion is a float value from 0-1 that indicates how much the shade is open. So
      // if we take the starting position * the total down time then this will tell us how many ms it
      // has moved in the down position.
      // startPos is stored in visible units; convert it back to the time-linear domain
      // before turning it into elapsed time (curveInverse is a no-op when curveGain is 0).
      int32_t msFrom0 = (int32_t)floor((this->curveInverse(this->startPos)/100) * downTime);

      // So if the start position is .1 it is 10% closed so we have a 1000ms (1sec) of time to account for
      // before we add any more time.
      msFrom0 += (curTime - this->moveStart);
      if(msFrom0 < downTime) {
        // The curtain is still travelling toward the sill. The current position is the
        // ratio of the time travelled over the total time to go 100%, mapped back to the
        // visible position through the winding curve.
        this->p_currentPos(this->curveForward(max((float)0.0, (float)msFrom0 / (float)downTime) * 100));
      }
      else if(this->target >= 100.0f && liftTime > 0) {
        // The curtain is at the sill but the slats still need liftTime ms to stack and close
        // the vents. Track that progress in liftPos, resuming from the snapshot taken when
        // the move (re)started so an interrupted or re-latched move never loses progress.
        this->liftPos = min((float)1.0, this->startLiftPos + (float)(msFrom0 - downTime) / (float)liftTime);
        // Hold the position just shy of closed until the slats are fully stacked. It must stay
        // strictly below 100 or the completion check below would end the move early.
        this->p_currentPos(this->liftPos >= 1.0f ? 100.0f : 99.9f);
      }
      else {
        this->p_currentPos(100.0f);
        // With no lift time configured a fully closed shade has its slats stacked.
        if(this->target >= 100.0f) this->liftPos = 1.0f;
      }
    }
    if(this->currentPos >= this->target) {
      this->p_currentPos(this->target);
      //if(this->settingMyPos) Serial.printf("IsAtTarget: %d  %f=%f\n", this->isAtTarget(), this->currentPos, this->target);
      // If we need to stop the shade do this before we indicate that we are
      // not moving otherwise the my function will kick in.
      if(this->settingPos) {
        if(!isAtTarget()) {
          Serial.printf("We are not at our tilt target: %.2f\n", this->tiltTarget);
          if(this->target != 100.0) SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
          // We now need to move the tilt to the position we requested, but the motor needs
          // a gap on the air between the stop above and that command.  Schedule it instead
          // of blocking the loop with delay(100): the tilt command still goes out 100ms
          // after the stop, and tiltStart below is unchanged, so the tilt position math and
          // the frame sequencing are the same as before.
          this->startCmdGap(pending_cmd_t::tiltTarget, 100);
        }
        else
          if(this->target != 100.0) SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
      }
      this->p_direction(0);
      this->tiltStart = curTime;
      this->startTiltPos = this->currentTiltPos;
      if(this->isAtTarget()) this->commitShadePosition();
    }
  }
  else if(!tilt_first && this->direction < 0) {
    if(upTime == 0) {
      this->p_currentPos(0);
      this->liftPos = 0.0f;
      //this->p_direction(0);
    }
    else {
      // The shade is moving up so we need to calculate its position through the up position. Shades
      // often move slower in the up position so since we are using a relative position the up time
      // can be calculated.
      // 10000ms from 100 to 0;
      int32_t msElapsed = (int32_t)(curTime - this->moveStart);
      if(liftTime > 0 && this->startLiftPos > 0.0f) {
        // The motor first unstacks the slats before the curtain leaves the sill; that time
        // does not move the shade. startLiftPos carries the stacking progress across stops
        // and re-latched frames so only the remaining unstack time is charged.
        int32_t unstackTime = (int32_t)floor(this->startLiftPos * (float)liftTime);
        this->liftPos = max((float)0.0, this->startLiftPos - (float)msElapsed / (float)liftTime);
        msElapsed = max((int32_t)0, msElapsed - unstackTime);
      }
      else this->liftPos = 0.0f;
      // startPos is stored in visible units; convert back to time-linear before deriving time.
      int32_t msFrom100 = upTime - (int32_t)floor((this->curveInverse(this->startPos)/100) * upTime);
      msFrom100 += msElapsed;
      msFrom100 = min(upTime, msFrom100);
      if(msFrom100 >= upTime) {
        this->p_currentPos(0.0f);
        //this->p_direction(0);
      }
      else {
        // Time-linear position, then mapped back to the visible position through the curve.
        float fpos = this->curveForward(((float)1.0 - min(max((float)0.0, (float)msFrom100 / (float)upTime), (float)1.0)) * 100);
        // We should now have the number of ms it will take to reach the shade fully open.
        // If we are at the top of the shade then set the movement to 0.
        if(fpos <= 0.0) {
          this->p_currentPos(0.0f);
          //this->p_direction(0);
        }
        else
          this->p_currentPos(fpos);
      }
    }
    if(this->currentPos <= this->target) {
      this->p_currentPos(this->target);
      //if(this->settingMyPos) Serial.printf("IsAtTarget: %d  %f=%f\n", this->isAtTarget(), this->currentPos, this->target);
      
      // If we need to stop the shade do this before we indicate that we are
      // not moving otherwise the my function will kick in.
      if(this->settingPos) {
        if(!isAtTarget()) {
          Serial.printf("We are not at our tilt target: %.2f\n", this->tiltTarget);
          if(this->target != 0.0) SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
          // Same stop-then-tilt gap as in the down direction: deferred rather than spun on,
          // so the command still goes out 100ms after the stop without freezing the loop.
          this->startCmdGap(pending_cmd_t::tiltTarget, 100);
        }
        else
          if(this->target != 0.0) SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
      }
      this->p_direction(0);
      this->tiltStart = curTime;
      this->startTiltPos = this->currentTiltPos;
      if(this->isAtTarget()) this->commitShadePosition();
    }
  }
  if(this->tiltDirection > 0) {
    if(tilt_first) this->moveStart = curTime;
    int32_t msFrom0 = (int32_t)floor((this->startTiltPos/100) * tiltTime);
    msFrom0 += (curTime - this->tiltStart);
    msFrom0 = min(tiltTime, msFrom0);
    if(msFrom0 >= tiltTime) {
      this->p_currentTiltPos(100.0f);
      //this->p_tiltDirection(0);        
      //Serial.printf("Setting tiltDirection to 0 (not enough time) %.4f %.4f\n", msFrom0, tiltTime);
    }
    else {
      float fpos = (min(max((float)0.0, (float)msFrom0 / (float)tiltTime), (float)1.0)) * 100;
      
      if(fpos > 100.0f) {
        this->p_currentTiltPos(100.0f);
        //this->p_tiltDirection(0);
        //Serial.println("Setting tiltDirection to 0 (100%)");
      }
      else this->p_currentTiltPos(fpos);
    }
    if(tilt_first) {
      if(this->currentTiltPos >= 100.0f) {
        this->p_currentTiltPos(100.0f);
        this->moveStart = curTime;
        this->startPos = this->currentPos;
        this->startLiftPos = this->liftPos;
        //this->p_tiltDirection(0);
        //Serial.println("Setting tiltDirection to 0 (tilt_first)");
      }
    }
    else if(this->currentTiltPos >= this->tiltTarget) {
      this->p_currentTiltPos(this->tiltTarget);
      // If we need to stop the shade do this before we indicate that we are
      // not moving otherwise the my function will kick in.
      if(this->settingTiltPos) {
        if(this->tiltType == tilt_types::integrated) {
          // If this is an integrated tilt mechanism the we will simply let it finish.  If it is not then we will stop it.
          //Serial.printf("Sending My -- tiltTarget: %.2f, tiltDirection: %d\n", this->tiltTarget, this->tiltDirection);
          if(this->tiltTarget != 100.0f || this->currentPos != 100.0f) SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
        }
        else {
          // This is a tilt motor so let it complete if it is going to 100.
          if(this->tiltTarget != 100.0f) SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
        }
      }
      this->p_tiltDirection(0);
      this->settingTiltPos = false;
      if(this->isAtTarget()) this->commitShadePosition();
    }
  }
  else if(this->tiltDirection < 0) {
    if(tilt_first) this->moveStart = curTime;
    if(tiltTime == 0) {
      this->p_tiltDirection(0);
      this->p_currentTiltPos(0.0f);
    }
    else {
      int32_t msFrom100 = tiltTime - (int32_t)floor((this->startTiltPos/100) * tiltTime);
      msFrom100 += (curTime - this->tiltStart);
      msFrom100 = min(tiltTime, msFrom100);
      if(msFrom100 >= tiltTime) {
        this->p_currentTiltPos(0.0f);
        //this->p_tiltDirection(0);
      }
      float fpos = ((float)1.0 - min(max((float)0.0, (float)msFrom100 / (float)tiltTime), (float)1.0)) * 100;
      // If we are at the top of the shade then set the movement to 0.
      if(fpos <= 0.0f) {
        this->p_currentTiltPos(0.0f);
        //this->p_tiltDirection(0);
      }
      else this->p_currentTiltPos(fpos);
    }
    if(tilt_first) {
      if(this->currentTiltPos <= 0.0f) {
        this->p_currentTiltPos(0.0f);
        this->moveStart = curTime;
        this->startPos = this->currentPos;
        this->startLiftPos = this->liftPos;
        //this->p_tiltDirection(0);
      }
    }
    else if(this->currentTiltPos <= this->tiltTarget) {
      this->p_currentTiltPos(this->tiltTarget);
      // If we need to stop the shade do this before we indicate that we are
      // not moving otherwise the my function will kick in.
      if(this->settingTiltPos) {
        if(this->tiltType == tilt_types::integrated) {
          // If this is an integrated tilt mechanism the we will simply let it finish.  If it is not then we will stop it.
          //Serial.printf("Sending My -- tiltTarget: %.2f, tiltDirection: %d\n", this->tiltTarget, this->tiltDirection);
          if(this->tiltTarget != 0.0 || this->currentPos != 0.0) SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
        }
        else {
          // This is a tilt motor so let it complete if it is going to 0.
          if(this->tiltTarget != 0.0) SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
        }
      }
      this->p_tiltDirection(0);
      this->settingTiltPos = false;
      Serial.println("Stopping at tilt position");
      if(this->isAtTarget()) this->commitShadePosition();
    }
  }
  if(this->settingMyPos && this->isAtTarget()) {
    // The motor has to see a gap after the stop that just went out before the long My press
    // that records the position.  This was delay(200); it is now a deadline so the loop is
    // not held for 200ms on top of the multi-second SETMY_REPEATS transmission that follows.
    // finishSetMyPosition() runs from the top of checkMovement() once the gap has elapsed.
    this->startCmdGap(pending_cmd_t::setMyPos, 200);
  }
  else if(currDir != this->direction || currTiltDir != this->tiltDirection) {
    // A direction change means the shade just started, stopped or reached its
    // target. Emit immediately so Home Assistant never misses a transition, and
    // reset the throttle window so the next progress emit is spaced from here.
    this->emitState();
    this->lastMoveEmit = curTime;
  }
  else if(currPos != floor(this->currentPos) || currTiltPos != floor(this->currentTiltPos)) {
    // Plain travel progress. Throttle to one emit per MOVE_EMIT_INTERVAL so many
    // shades moving together cannot flood the loop (subtractive compare is rollover
    // safe). The exact final position is still delivered by the direction-change
    // branch above when the shade stops.
    if(curTime - this->lastMoveEmit >= MOVE_EMIT_INTERVAL) {
      this->emitState();
      this->lastMoveEmit = curTime;
    }
  }
}
void SomfyShade::finishSetMyPosition() {
  // Body of the settingMyPos block that used to sit at the end of checkMovement() behind a
  // delay(200).  It is unchanged: the caller only guarantees that the gap has elapsed and
  // that the shade is still settling its My position on the target.
  // Set this position before sending the command.  If you don't the processFrame function
  // will send the shade back to its original My position.
  if(this->tiltType != tilt_types::none) {
    if(this->myTiltPos == this->currentTiltPos && this->myPos == this->currentPos) this->myPos = this->myTiltPos = -1;
    else {
      this->p_myPos(this->currentPos);
      this->p_myTiltPos(this->currentTiltPos);
    }
  }
  else {
    this->p_myTiltPos(-1);
    if(this->myPos == this->currentPos) this->p_myPos(-1);
    else this->p_myPos(this->currentPos);
  }
  SomfyRemote::sendCommand(somfy_commands::My, SETMY_REPEATS);
  this->settingMyPos = false;
  this->commitMyPosition();
  this->emitState();
}
#ifdef USE_NVS
void SomfyShade::load() {
    char shadeKey[15];
    uint32_t linkedAddresses[SOMFY_MAX_LINKED_REMOTES];
    memset(linkedAddresses, 0x00, sizeof(uint32_t) * SOMFY_MAX_LINKED_REMOTES);
    snprintf(shadeKey, sizeof(shadeKey), "SomfyShade%u", this->shadeId);
    // Now load up each of the shades into memory.
    //Serial.print("key:");
    //Serial.println(shadeKey);
    
    pref.begin(shadeKey, !somfy.useNVS());
    pref.getString("name", this->name, sizeof(this->name));
    this->paired = pref.getBool("paired", false);
    if(pref.isKey("upTime") && pref.getType("upTime") != PreferenceType::PT_U32) {
      // We need to convert these to 32 bits because earlier versions did not support this.
      this->upTime = static_cast<uint32_t>(pref.getUShort("upTime", 1000));
      this->downTime = static_cast<uint32_t>(pref.getUShort("downTime", 1000));
      this->tiltTime = static_cast<uint32_t>(pref.getUShort("tiltTime", 7000));
      if(somfy.useNVS()) {
        pref.remove("upTime");
        pref.putUInt("upTime", this->upTime);
        pref.remove("downTime");
        pref.putUInt("downTime", this->downTime);
        pref.remove("tiltTime");
        pref.putUInt("tiltTime", this->tiltTime);
      }
    }
    else {
      this->upTime = pref.getUInt("upTime", this->upTime);
      this->downTime = pref.getUInt("downTime", this->downTime);
      this->tiltTime = pref.getUInt("tiltTime", this->tiltTime);
    }
    this->liftTime = pref.getUInt("liftTime", this->liftTime);
    this->curveGain = pref.getFloat("curveGain", this->curveGain);
    this->setRemoteAddress(pref.getUInt("remoteAddress", 0));
    this->currentPos = pref.getFloat("currentPos", 0);
    this->target = floor(this->currentPos);
    // A shade that rebooted fully closed has its slats stacked.
    this->liftPos = this->startLiftPos = this->currentPos >= 100.0f ? 1.0f : 0.0f;
    this->myPos = static_cast<float>(pref.getUShort("myPos", this->myPos));
    this->tiltType = pref.getBool("hasTilt", false) ? tilt_types::none : tilt_types::tiltmotor;
    this->shadeType = static_cast<shade_types>(pref.getChar("shadeType", static_cast<uint8_t>(this->shadeType)));
    this->currentTiltPos = pref.getFloat("currentTiltPos", 0);
    this->tiltTarget = floor(this->currentTiltPos);
    pref.getBytes("linkedAddr", linkedAddresses, sizeof(linkedAddresses));
    pref.end();
    Serial.print("shadeId:");
    Serial.print(this->getShadeId());
    Serial.print(" name:");
    Serial.print(this->name);
    Serial.print(" address:");
    Serial.print(this->getRemoteAddress());
    Serial.print(" position:");
    Serial.print(this->currentPos);
    Serial.print(" myPos:");
    Serial.println(this->myPos);
    pref.begin("ShadeCodes");
    this->lastRollingCode = pref.getUShort(this->m_remotePrefId, 0);
    for(uint8_t j = 0; j < SOMFY_MAX_LINKED_REMOTES; j++) {
      SomfyLinkedRemote &lremote = this->linkedRemotes[j];
      lremote.setRemoteAddress(linkedAddresses[j]);
      lremote.lastRollingCode = pref.getUShort(lremote.getRemotePrefId(), 0);
    }
    pref.end();
}
#endif
// State Setters
float SomfyShade::p_currentPos(float pos) {
  float old = this->currentPos;
  this->currentPos = pos;
  if(floor(old) != floor(pos)) this->publish("position", this->transformPosition(static_cast<uint8_t>(floor(this->currentPos))));
  return old;
}
float SomfyShade::p_currentTiltPos(float pos) {
  float old = this->currentTiltPos;
  this->currentTiltPos = pos;
  if(floor(old) != floor(pos)) this->publish("tiltPosition", this->transformPosition(static_cast<uint8_t>(floor(this->currentTiltPos))));
  return old;
}
uint16_t SomfyShade::p_lastRollingCode(uint16_t code) {
  uint16_t old = SomfyRemote::p_lastRollingCode(code);
  if(old != code) this->publish("lastRollingCode", code);
  return old;
}
bool SomfyShade::p_flag(somfy_flags_t flag, bool val) {
  bool old = !!(this->flags & static_cast<uint8_t>(flag));
  if(val) 
      this->flags |= static_cast<uint8_t>(flag);
  else
      this->flags &= ~(static_cast<uint8_t>(flag));
  return old;
}
bool SomfyShade::p_sunFlag(bool val) {
  bool old = this->p_flag(somfy_flags_t::SunFlag, val);
  if(old != val) this->publish("sunFlag", static_cast<uint8_t>(val));
  return old;
}
bool SomfyShade::p_windy(bool val) {
  bool old = this->p_flag(somfy_flags_t::Windy, val);
  if(old != val) this->publish("windy", static_cast<uint8_t>(val));
  return old;
}
bool SomfyShade::p_sunny(bool val) {
  bool old = this->p_flag(somfy_flags_t::Sunny, val);
  if(old != val) this->publish("sunny", static_cast<uint8_t>(val));
  return old;
}
int8_t SomfyShade::p_direction(int8_t dir) {
  int8_t old = this->direction;
  if(old != dir) {
    this->direction = dir;
    this->publish("direction", this->direction, true);
  }
  return old;
}
int8_t SomfyGroup::p_direction(int8_t dir) {
  int8_t old = this->direction;
  if(old != dir) {
    this->direction = dir;
    this->publish("direction", this->direction);
  }
  return old;
}
int8_t SomfyShade::p_tiltDirection(int8_t dir) {
  int8_t old = this->tiltDirection;
  if(old != dir) {
    this->tiltDirection = dir;
    this->publish("tiltDirection", this->tiltDirection, true);
  }
  return old;
}
float SomfyShade::p_target(float target) {
  float old = this->target;
  if(old != target) {
    this->target = target;
    if(this->transformPosition(old) != this->transformPosition(target))
      this->publish("target", this->transformPosition(this->target), true);
  }
  return old;
}
float SomfyShade::p_tiltTarget(float target) {
  float old = this->tiltTarget;
  if(old != target) {
    this->tiltTarget = target;
    if(this->transformPosition(old) != this->transformPosition(target))
      this->publish("tiltTarget", this->transformPosition(this->tiltTarget), true);
  }
  return old;
}
float SomfyShade::p_myPos(float pos) {
  float old = this->myPos;
  if(old != pos) {
    //if(this->transformPosition(pos) == 0) Serial.println("MyPos = %.2f", pos);
    this->myPos = pos;
    if(this->transformPosition(old) != this->transformPosition(pos))
      this->publish("mypos", this->transformPosition(this->myPos), true);
  }
  return old;
}
float SomfyShade::p_myTiltPos(float pos) {
  float old = this->myTiltPos;
  if(old != pos) {
    this->myTiltPos = pos;
    if(this->transformPosition(old) != this->transformPosition(pos))
      this->publish("myTiltPos", this->transformPosition(this->myTiltPos), true);
  }
  return old;
}

int8_t SomfyShade::transformPosition(float fpos) { 
  if(fpos < 0) return -1;
  return static_cast<int8_t>(this->flipPosition && fpos >= 0.00f ? floor(100.0f - fpos) : floor(fpos)); 
}
bool SomfyShade::isIdle() {
  // A pending command means the shade is in the middle of a transmission sequence, waiting
  // out the gap between two frames.  That used to happen inside a delay() where nothing
  // could observe the shade at all, so it must not read as idle now that the loop runs.
  return this->pendingCmd == pending_cmd_t::none && this->isAtTarget() && this->direction == 0 && this->tiltDirection == 0;
}
void SomfyShade::processWaitingFrame() {
  if(this->shadeId == 255) {
    this->lastFrame.await = 0; 
    return;
  }
  if(this->lastFrame.processed) return;
  // Subtractive deadline: correct across the millis() rollover (await = 0 means "unset").
  if(this->lastFrame.await > 0 && (int32_t)(millis() - this->lastFrame.await) >= 0) {
    somfy_commands cmd = this->transformCommand(this->lastFrame.cmd);
    switch(cmd) {
      case somfy_commands::StepUp:
          this->lastFrame.processed = true;
          // Simply move the shade up by 1%.
          if(this->currentPos > 0) {
            this->p_target(floor(this->currentPos) - 1);
            this->setMovement(-1);
            this->emitCommand(cmd, "remote", this->lastFrame.remoteAddress);
          }
          break;
      case somfy_commands::StepDown:
          this->lastFrame.processed = true;
          // Simply move the shade down by 1%.
          if(this->currentPos < 100) {
            this->p_target(floor(this->currentPos) + 1);
            this->setMovement(1);
            this->emitCommand(cmd, "remote", this->lastFrame.remoteAddress);
          }
          break;
      case somfy_commands::Down:
      case somfy_commands::Up:
        if(this->tiltType == tilt_types::tiltmotor) { // Theoretically this should get here unless it does have a tilt motor.
          if(this->lastFrame.repeats >= TILT_REPEATS) {
            int8_t dir = this->lastFrame.cmd == somfy_commands::Up ? -1 : 1;
            this->p_tiltTarget(dir > 0 ? 100.0f : 0.0f);
            this->setTiltMovement(dir);
            this->lastFrame.processed = true;
            Serial.print(this->name);
            Serial.print(" Processing tilt ");
            Serial.print(translateSomfyCommand(this->lastFrame.cmd));
            Serial.print(" after ");
            Serial.print(this->lastFrame.repeats);
            Serial.println(" repeats");
            this->emitCommand(cmd, "remote", this->lastFrame.remoteAddress);
          }
          else {
            int8_t dir = this->lastFrame.cmd == somfy_commands::Up ? -1 : 1;
            this->p_target(dir > 0 ? 100 : 0);
            this->setMovement(dir);
            this->lastFrame.processed = true;
            this->emitCommand(cmd, "remote", this->lastFrame.remoteAddress);
          }
          if(this->lastFrame.repeats > TILT_REPEATS + 2) {
            this->lastFrame.processed = true;
            this->emitCommand(cmd, "remote", this->lastFrame.remoteAddress);
          }
        }
        else if(this->tiltType == tilt_types::euromode) {
          if(this->lastFrame.repeats >= TILT_REPEATS) {
            int8_t dir = this->lastFrame.cmd == somfy_commands::Up ? -1 : 1;
            this->p_target(dir > 0 ? 100.0f : 0.0f);
            this->setMovement(dir);
            this->lastFrame.processed = true;
            Serial.print(this->name);
            Serial.print(" Processing ");
            Serial.print(translateSomfyCommand(this->lastFrame.cmd));
            Serial.print(" after ");
            Serial.print(this->lastFrame.repeats);
            Serial.println(" repeats");
            this->emitCommand(cmd, "remote", this->lastFrame.remoteAddress);
          }
          else {
            int8_t dir = this->lastFrame.cmd == somfy_commands::Up ? -1 : 1;
            this->p_tiltTarget(dir > 0 ? 100 : 0);
            this->setTiltMovement(dir);
            this->lastFrame.processed = true;
            this->emitCommand(cmd, "remote", this->lastFrame.remoteAddress);
          }
          if(this->lastFrame.repeats > TILT_REPEATS + 2) {
            this->lastFrame.processed = true;
            this->emitCommand(cmd, "remote", this->lastFrame.remoteAddress);
          }
        }
        break;
      case somfy_commands::My:
        if(this->lastFrame.repeats >= SETMY_REPEATS && this->isIdle()) {
          if(floor(this->myPos) == floor(this->currentPos)) {
            // We are clearing it.
            this->p_myPos(-1);
            this->p_myTiltPos(-1);
          }
          else {
            this->p_myPos(this->currentPos);
            this->p_myTiltPos(this->currentTiltPos);
          }
          this->commitMyPosition();
          this->lastFrame.processed = true;
          this->emitState();
        }
        else if(this->isIdle()) {
          if(this->simMy())
            this->moveToMyPosition(); // Call out like this (instead of move to target) so that we don't get some of the goofy tilt only problems.
          else {
            if(this->myPos >= 0.0f && this->myPos <= 100.0f) this->p_target(this->myPos);
            if(this->myTiltPos >= 0.0f && this->myTiltPos <= 100.0f) this->p_tiltTarget(this->myTiltPos);
          }
          this->setMovement(0);
          this->lastFrame.processed = true;
          this->emitCommand(cmd, "remote", this->lastFrame.remoteAddress);
        }
        else {
          this->p_target(this->currentPos);
          this->p_tiltTarget(this->currentTiltPos);
        }
        if(this->lastFrame.repeats > SETMY_REPEATS + 2) this->lastFrame.processed = true;
        if(this->lastFrame.processed) {
          Serial.print(this->name);
          Serial.print(" Processing MY after ");
          Serial.print(this->lastFrame.repeats);
          Serial.println(" repeats");
        }
        break;
      default:
        break;
    }
  }
}
void SomfyShade::processFrame(somfy_frame_t &frame, bool internal) {
  // The reason why we are processing all frames here is so
  // any linked remotes that may happen to be on the same ESPSomfy RTS
  // device can trigger the appropriate actions.
  if(this->shadeId == 255) return; 
  bool hasRemote = this->getRemoteAddress() == frame.remoteAddress;
  if(!hasRemote) {
    for(uint8_t i = 0; i < SOMFY_MAX_LINKED_REMOTES; i++) {
      if(this->linkedRemotes[i].getRemoteAddress() == frame.remoteAddress) {
        if(frame.cmd != somfy_commands::Sensor) this->linkedRemotes[i].setRollingCode(frame.rollingCode);
        hasRemote = true;
        break;      
      }
    }
  }
  if(!hasRemote) return;
  const uint32_t curTime = millis();
  this->lastFrame.copy(frame);
  int8_t dir = 0;
  this->moveStart = this->tiltStart = curTime;
  this->startPos = this->currentPos;
  this->startTiltPos = this->currentTiltPos;
  this->startLiftPos = this->liftPos;
  // If the command is coming from a remote then we are aborting all these positioning operations.
  // A command deferred behind an inter-command gap belongs to one of them, so drop it too and
  // let checkMovement() resume tracking this frame immediately.
  if(!internal) {
    this->settingMyPos = this->settingPos = this->settingTiltPos = false;
    this->pendingCmd = pending_cmd_t::none;
  }
  somfy_commands cmd = this->transformCommand(frame.cmd);
  // At this point we are not processing the combo buttons
  // will need to see what the shade does when you press both.
  switch(cmd) {
    case somfy_commands::Sensor:
      this->lastFrame.processed = true;
      if(this->shadeType == shade_types::drycontact || this->shadeType == shade_types::drycontact2) return;
      {
        const uint8_t prevFlags = this->flags;
        const bool wasSunny = prevFlags & static_cast<uint8_t>(somfy_flags_t::Sunny);
        const bool wasWindy = prevFlags & static_cast<uint8_t>(somfy_flags_t::Windy);
        const uint16_t status = frame.rollingCode << 4;
        if (status & static_cast<uint8_t>(somfy_flags_t::Sunny))
          this->p_sunny(true);
          //this->flags |= static_cast<uint8_t>(somfy_flags_t::Sunny);
        else
          this->p_sunny(false);
          //this->flags &= ~(static_cast<uint8_t>(somfy_flags_t::Sunny));
        if (status & static_cast<uint8_t>(somfy_flags_t::Windy))
          this->p_windy(true);
          //this->flags |= static_cast<uint8_t>(somfy_flags_t::Windy);
        else
          this->p_windy(false);
          //this->flags &= ~(static_cast<uint8_t>(somfy_flags_t::Windy));
        if(frame.rollingCode & static_cast<uint8_t>(somfy_flags_t::DemoMode))
          this->flags |= static_cast<uint8_t>(somfy_flags_t::DemoMode);
        else
          this->flags &= ~(static_cast<uint8_t>(somfy_flags_t::DemoMode));
        const bool isSunny = this->flags & static_cast<uint8_t>(somfy_flags_t::Sunny);
        const bool isWindy = this->flags & static_cast<uint8_t>(somfy_flags_t::Windy);
        if (isSunny)
        {
          this->noSunStart = 0;
          this->noSunDone = true;
        }
        else
        {
          this->sunStart = 0;
          this->sunDone = true;
        }
        if (isWindy)
        {
          this->noWindStart = 0;
          this->noWindDone = true;
          this->windLast = curTime;
        }
        else
        {
          this->windStart = 0;
          this->windDone = true;
        }
        if (isSunny && !wasSunny)
        {
          this->sunStart = curTime;
          this->sunDone = false;
          Serial.printf("[%u] Sun -> start\r\n", this->shadeId);
        }
        else if (!isSunny && wasSunny)
        {
          this->noSunStart = curTime;
          this->noSunDone = false;
          Serial.printf("[%u] No Sun -> start\r\n", this->shadeId);
        }
        if (isWindy && !wasWindy)
        {
          this->windStart = curTime;
          this->windDone = false;
          Serial.printf("[%u] Wind -> start\r\n", this->shadeId);
        }
        else if (!isWindy && wasWindy)
        {
          this->noWindStart = curTime;
          this->noWindDone = false;
          Serial.printf("[%u] No Wind -> start\r\n", this->shadeId);
        }
        this->emitState();
        somfy.updateGroupFlags();
      }
      break;
    case somfy_commands::Prog:
    case somfy_commands::MyUp:
    case somfy_commands::MyDown:
    case somfy_commands::MyUpDown:
    case somfy_commands::UpDown:
      this->lastFrame.processed = true;
      if(this->shadeType == shade_types::drycontact || this->shadeType == shade_types::drycontact2) return;
      this->emitCommand(cmd, internal ? "internal" : "remote", frame.remoteAddress);
      break;
      
    case somfy_commands::Flag:
      this->lastFrame.processed = true;
      if(this->shadeType == shade_types::drycontact || this->shadeType == shade_types::drycontact2) return;
      if(this->lastFrame.rollingCode & 0x8000) return; // Some sensors send bogus frames with a rollingCode >= 32768 that cause them to change the state.
      this->p_sunFlag(false);
      //this->flags &= ~(static_cast<uint8_t>(somfy_flags_t::SunFlag));
      somfy.isDirty = true;
      this->emitState();
      this->emitCommand(cmd, internal ? "internal" : "remote", frame.remoteAddress);
      somfy.updateGroupFlags();
      break;    
    case somfy_commands::SunFlag:
      if(this->shadeType == shade_types::drycontact || this->shadeType == shade_types::drycontact2) return;
      if(this->lastFrame.rollingCode & 0x8000) return; // Some sensors send bogus frames with a rollingCode >= 32768 that cause them to change the state.
      {
        const bool isWindy = this->flags & static_cast<uint8_t>(somfy_flags_t::Windy);
        //this->flags |= static_cast<uint8_t>(somfy_flags_t::SunFlag);
        this->p_sunFlag(true);
        if (!isWindy)
        {
          const bool isSunny = this->flags & static_cast<uint8_t>(somfy_flags_t::Sunny);
          if (isSunny && this->sunDone) {
            if(this->tiltType == tilt_types::tiltonly)
              this->p_tiltTarget(this->myTiltPos >= 0 ? this->myTiltPos : 100.0f);
            else
              this->p_target(this->myPos >= 0 ? this->myPos : 100.0f);
          }
          else if (!isSunny && this->noSunDone) {
            if(this->tiltType == tilt_types::tiltonly)
              this->p_tiltTarget(0.0f);
            else
              this->p_target(0.0f);
          }
        }
        somfy.isDirty = true;
        this->emitState();
        this->emitCommand(cmd, internal ? "internal" : "remote", frame.remoteAddress);
        somfy.updateGroupFlags();
      }
      break;
    case somfy_commands::Up:
      if(this->shadeType == shade_types::drycontact) {
        this->lastFrame.processed = true;
        return;
      }
      else if(this->shadeType == shade_types::drycontact2) {
        if(this->lastFrame.processed) return;
        this->lastFrame.processed = true;
        if(this->currentPos != 0.0f) this->p_target(0);
        this->emitCommand(cmd, internal ? "internal" : "remote", frame.remoteAddress);
        return;
      }
      if(this->tiltType == tilt_types::tiltmotor || this->tiltType == tilt_types::euromode) {
        // Wait another half second just in case we are potentially processing a tilt.
        if(!internal) this->lastFrame.await = curTime + 500;
        else this->lastFrame.processed = true;
      }
      else {
        // If from a remote we will simply be going up.
        if(this->tiltType == tilt_types::tiltonly && !internal) this->p_tiltTarget(0.0f);
        else if(!internal) {
          if(this->tiltType != tilt_types::tiltonly) this->p_target(0.0f);
          this->p_tiltTarget(0.0f);
        }
        this->lastFrame.processed = true;
        this->emitCommand(cmd, internal ? "internal" : "remote", frame.remoteAddress);
      }
      break;
    case somfy_commands::Down:
      if(this->shadeType == shade_types::drycontact) {
        this->lastFrame.processed = true;
        return;
      }
      else if(this->shadeType == shade_types::drycontact2) {
        if(this->lastFrame.processed) return;
        this->lastFrame.processed = true;
        if(this->currentPos != 100.0f) this->p_target(100);
        this->emitCommand(cmd, internal ? "internal" : "remote", frame.remoteAddress);
        return;
      }
      if (!this->windLast || (curTime - this->windLast) >= SOMFY_NO_WIND_REMOTE_TIMEOUT) {
        if(this->tiltType == tilt_types::tiltmotor || this->tiltType == tilt_types::euromode) {
          // Wait another half seccond just in case we are potentially processing a tilt.
          if(!internal) this->lastFrame.await = curTime + 500;
          else this->lastFrame.processed = true;
        }
        else {
          this->lastFrame.processed = true;
          if(!internal) {
            if(this->tiltType != tilt_types::tiltonly) this->p_target(100.0f);
            if(this->tiltType != tilt_types::none) this->p_tiltTarget(100.0f);
          }
        }
        this->emitCommand(cmd, internal ? "internal" : "remote", frame.remoteAddress);
      }
      break;
    case somfy_commands::My:
      if(this->shadeType == shade_types::drycontact2) return;
      if(this->isToggle()) { // This is a one button device
        if(this->lastFrame.processed) return;
        this->lastFrame.processed = true;
        if(!this->isIdle()) this->p_target(this->currentPos);
        else if(this->currentPos == 100.0f) this->p_target(0.0f);
        else if(this->currentPos == 0.0f) this->p_target(100.0f);
        else this->p_target(this->lastMovement == -1 ? 100 : 0);
        this->emitCommand(cmd, internal ? "internal" : "remote", frame.remoteAddress);
        return;
      }
      else if(this->shadeType == shade_types::drycontact) {
        // In this case we need to toggle the contact but we only should do this if
        // this is not a repeat.
        if(this->lastFrame.processed) return;
        this->lastFrame.processed = true;
        if(this->currentPos == 100.0f) this->p_target(0);
        else if(this->currentPos == 0.0f) this->p_target(100);
        else this->p_target(this->lastMovement == -1 ? 100 : 0);
        this->emitCommand(cmd, internal ? "internal" : "remote", frame.remoteAddress);
        return;
      }
      if(this->isIdle()) {
        if(!internal) {
          // This frame is coming from a remote. We are potentially setting
          // the my position.
          this->lastFrame.await = curTime + 500;
        }
        else {
          if(this->lastFrame.processed) return;
          Serial.println("Moving to My target");
          this->lastFrame.processed = true;
          if(this->myTiltPos >= 0.0f && this->myTiltPos <= 100.0f) this->p_tiltTarget(this->myTiltPos);
          if(this->myPos >= 0.0f && this->myPos <= 100.0f && this->tiltType != tilt_types::tiltonly) this->p_target(this->myPos);
          this->emitCommand(cmd, internal ? "internal" : "remote", frame.remoteAddress);
        }
      }
      else {
        if(this->lastFrame.processed) return;
        this->lastFrame.processed = true;
        if(!internal) {
          if(this->tiltType != tilt_types::tiltonly) this->p_target(this->currentPos);
          this->p_tiltTarget(this->currentTiltPos);
        }
        this->emitCommand(cmd, internal ? "internal" : "remote", frame.remoteAddress);
      }
      break;
    case somfy_commands::StepUp:
      if(this->lastFrame.processed) return;
      this->lastFrame.processed = true;
      if(this->shadeType == shade_types::drycontact || this->shadeType == shade_types::drycontact2) return;
      dir = 0;
      // With the step commands and integrated shades
      // the motor must tilt in the direction first then move
      // so we have to calculate the target with this in mind.
      if(this->stepSize == 0) return; // Avoid divide by 0.
      if(this->lastFrame.stepSize == 0) this->lastFrame.stepSize = 1;
      if(this->tiltType == tilt_types::integrated) {
        // With integrated tilt this is more involved than ne would think because the step command can be moving not just the tilt
        // but the lift.  So a determination needs to be made as to whether we are currently moving and it should stop.
        // Conditions:
        // 1. If both the tilt and lift are at 0% do nothing
        // 2. If the tilt position is not currently at the top then shift the tilt.
        // 3. If the tilt position is not currently at the top then shift the lift.
        if(this->currentTiltPos <= 0.0f && this->currentPos <= 0.0f) return; // Do nothing
        else if(this->currentTiltPos > 0.0f) {
          // Set the tilt position.  This should stop the lift movement.
          this->p_target(this->currentPos);
          if(this->tiltTime == 0) return; // Avoid divide by 0.
          this->p_tiltTarget(max(0.0f, this->currentTiltPos - (100.0f/(static_cast<float>(this->tiltTime/static_cast<float>(this->stepSize * this->lastFrame.stepSize))))));
        }
        else {
          // We only have the lift to move.
          if(this->upTime == 0) return; // Avoid divide by 0.
          this->p_tiltTarget(this->currentTiltPos);
          this->p_target(max(0.0f, this->currentPos - (100.0f/(static_cast<float>(this->upTime/static_cast<float>(this->stepSize * this->lastFrame.stepSize))))));
        }
      }
      else if(this->tiltType == tilt_types::tiltonly) {
        if(this->tiltTime == 0 || this->stepSize == 0) return;
        this->p_tiltTarget(max(0.0f, this->currentTiltPos - (100.0f/(static_cast<float>(this->tiltTime/static_cast<float>(this->stepSize * this->lastFrame.stepSize))))));
      }
      else if(this->currentPos > 0.0f) {
        if(this->downTime == 0 || this->stepSize == 0) return;
        this->p_target(this->stepUpTarget((uint32_t)this->stepSize * this->lastFrame.stepSize));
      }
      this->emitCommand(cmd, internal ? "internal" : "remote", frame.remoteAddress);
      break;
    case somfy_commands::StepDown:
      if(this->lastFrame.processed) return;
      this->lastFrame.processed = true;
      if(this->shadeType == shade_types::drycontact || this->shadeType == shade_types::drycontact2) return;
      dir = 1;
      // With the step commands and integrated shades
      // the motor must tilt in the direction first then move
      // so we have to calculate the target with this in mind.
      if(this->stepSize == 0) return; // Avoid divide by 0.
      if(this->lastFrame.stepSize == 0) this->lastFrame.stepSize = 1;
      
      if(this->tiltType == tilt_types::integrated) {
        // With integrated tilt this is more involved than ne would think because the step command can be moving not just the tilt
        // but the lift.  So a determination needs to be made as to whether we are currently moving and it should stop.
        // Conditions:
        // 1. If both the tilt and lift are at 100% do nothing
        // 2. If the tilt position is not currently at the bottom then shift the tilt.
        // 3. If the tilt position is add the bottom then shift the lift.
        if(this->currentTiltPos >= 100.0f && this->currentPos >= 100.0f) return; // Do nothing
        else if(this->currentTiltPos < 100.0f) {
          // Set the tilt position.  This should stop the lift movement.
          this->p_target(this->currentPos);
          if(this->tiltTime == 0) return; // Avoid divide by 0.
          this->p_tiltTarget(min(100.0f, this->currentTiltPos + (100.0f/(static_cast<float>(this->tiltTime/static_cast<float>(this->stepSize * this->lastFrame.stepSize))))));
        }
        else {
          // We only have the lift to move.
          this->p_tiltTarget(this->currentTiltPos);
          if(this->downTime == 0) return; // Avoid divide by 0.
          this->p_target(min(100.0f, this->currentPos + (100.0f/(static_cast<float>(this->downTime/static_cast<float>(this->stepSize* this->lastFrame.stepSize))))));
        }
      }
      else if(this->tiltType == tilt_types::tiltonly) {
        if(this->tiltTime == 0 || this->stepSize == 0) return;
        this->p_tiltTarget(min(100.0f, this->currentTiltPos + (100.0f/(static_cast<float>(this->tiltTime/static_cast<float>(this->stepSize * this->lastFrame.stepSize))))));
      }
      else if(this->currentPos < 100.0f) {
        if(this->downTime == 0 || this->stepSize == 0) return;
        this->p_target(this->stepDownTarget((uint32_t)this->stepSize * this->lastFrame.stepSize));
      }
      this->emitCommand(cmd, internal ? "internal" : "remote", frame.remoteAddress);
      break;
    case somfy_commands::Toggle:
      if(this->lastFrame.processed) return;
      this->lastFrame.processed = true;
      if(!this->isIdle()) this->p_target(this->currentPos);
      else if(this->currentPos == 100.0f) this->p_target(0);
      else if(this->currentPos == 0.0f) this->p_target(100);
      else this->p_target(this->lastMovement == -1 ? 100 : 0);
      this->emitCommand(cmd, internal ? "internal" : "remote", frame.remoteAddress);
      break;
    case somfy_commands::Stop:
      if(this->lastFrame.processed) return;
      this->lastFrame.processed = true;
      this->p_target(this->currentPos);
      this->p_tiltTarget(this->currentTiltPos);      
      this->emitCommand(cmd, internal ? "internal" : "remote", frame.remoteAddress);
      break;
    case somfy_commands::Favorite:
      if(this->lastFrame.processed) return;
      this->lastFrame.processed = true;
      if(this->simMy()) {
        this->moveToMyPosition();
      }
      else {
        if(this->myTiltPos >= 0.0f && this->myTiltPos <= 100.0f) this->p_tiltTarget(this->myTiltPos);
        if(this->myPos >= 0.0f && this->myPos <= 100.0f && this->tiltType != tilt_types::tiltonly) this->p_target(this->myPos);
        this->emitCommand(cmd, internal ? "internal" : "remote", frame.remoteAddress);
      }
      break;
    default:
      dir = 0;
      break;
  }
  //if(dir == 0 && this->tiltType == tilt_types::tiltmotor && this->tiltDirection != 0) this->setTiltMovement(0);
  this->setMovement(dir);
}
void SomfyShade::processInternalCommand(somfy_commands cmd, uint8_t repeat) {
  // The reason why we are processing all frames here is so
  // any linked remotes that may happen to be on the same ESPSomfy RTS
  // device can trigger the appropriate actions.
  if(this->shadeId == 255) return; 
  const uint32_t curTime = millis();
  int8_t dir = 0;
  this->moveStart = this->tiltStart = curTime;
  this->startPos = this->currentPos;
  this->startTiltPos = this->currentTiltPos;
  this->startLiftPos = this->liftPos;
  // If the command is coming from a remote then we are aborting all these positioning operations.
  switch(cmd) {
    case somfy_commands::Up:
      if(this->tiltType == tilt_types::tiltmotor) {
        if(repeat >= TILT_REPEATS)
          this->p_tiltTarget(0.0f);
        else
          this->p_target(0.0f);
      }
      else if(this->tiltType == tilt_types::tiltonly) {
        this->p_target(100.0f);
        this->p_currentPos(100.0f);
        this->p_tiltTarget(0.0f);
      }
      else {
        this->p_target(0.0f);
        this->p_tiltTarget(0.0f);
      }
      break;
    case somfy_commands::Down:
      if (!this->windLast || (curTime - this->windLast) >= SOMFY_NO_WIND_REMOTE_TIMEOUT) {
        if(this->tiltType == tilt_types::tiltmotor) {
          if(repeat >= TILT_REPEATS)
            this->p_tiltTarget(100.0f);
          else
            this->p_target(100.0f);
        }
        else if(this->tiltType == tilt_types::tiltonly) {
          this->p_target(100.0f);
          this->p_currentPos(100.0f);
          this->p_tiltTarget(100.0f);
        }
        else {
            this->p_target(100.0f);
            if(this->tiltType != tilt_types::none) this->p_tiltTarget(100.0f);
        }
      }
      break;
    case somfy_commands::My:
      if(this->isIdle()) {
        Serial.printf("Shade #%d is idle\n", this->getShadeId());
        if(this->simMy()) {
          this->moveToMyPosition();
        }
        else {
          if(this->myTiltPos >= 0.0f && this->myTiltPos <= 100.0f) this->p_tiltTarget(this->myTiltPos);
          if(this->myPos >= 0.0f && this->myPos <= 100.0f && this->tiltType != tilt_types::tiltonly) this->p_target(this->myPos);
        }
      }
      else {
        if(this->tiltType == tilt_types::tiltonly) {
          this->p_target(100.0f);
        }
        else this->p_target(this->currentPos);
        this->p_tiltTarget(this->currentTiltPos);
      }
      break;
    case somfy_commands::StepUp:
      // With the step commands and integrated shades
      // the motor must tilt in the direction first then move
      // so we have to calculate the target with this in mind.
      if(this->stepSize == 0) return; // Avoid divide by 0.
      if(this->tiltType == tilt_types::integrated) {
        // With integrated tilt this is more involved than ne would think because the step command can be moving not just the tilt
        // but the lift.  So a determination needs to be made as to whether we are currently moving and it should stop.
        // Conditions:
        // 1. If both the tilt and lift are at 0% do nothing
        // 2. If the tilt position is not currently at the top then shift the tilt.
        // 3. If the tilt position is not currently at the top then shift the lift.
        if(this->currentTiltPos <= 0.0f && this->currentPos <= 0.0f) return; // Do nothing
        else if(this->currentTiltPos > 0.0f) {
          // Set the tilt position.  This should stop the lift movement.
          this->p_target(this->currentPos);
          if(this->tiltTime == 0) return; // Avoid divide by 0.
          this->p_tiltTarget(max(0.0f, this->currentTiltPos - (100.0f/(static_cast<float>(this->tiltTime/static_cast<float>(this->stepSize))))));
        }
        else {
          // We only have the lift to move.
          if(this->upTime == 0) return; // Avoid divide by 0.
          this->p_tiltTarget(this->currentTiltPos);
          this->p_target(max(0.0f, this->currentPos - (100.0f/(static_cast<float>(this->upTime/static_cast<float>(this->stepSize))))));
        }
      }
      else if(this->tiltType == tilt_types::tiltonly) {
        if(this->tiltTime == 0 || this->currentTiltPos <= 0.0f) return;
        this->p_tiltTarget(max(0.0f, this->currentTiltPos - (100.0f/(static_cast<float>(this->tiltTime/static_cast<float>(this->stepSize))))));
      }
      else if(this->currentPos > 0.0f) {
        if(this->upTime == 0) return;
        this->p_target(this->stepUpTarget(this->stepSize));
      }
      break;
    case somfy_commands::StepDown:
      dir = 1;
      // With the step commands and integrated shades
      // the motor must tilt in the direction first then move
      // so we have to calculate the target with this in mind.
      if(this->stepSize == 0) return; // Avoid divide by 0.
      if(this->tiltType == tilt_types::integrated) {
        // With integrated tilt this is more involved than ne would think because the step command can be moving not just the tilt
        // but the lift.  So a determination needs to be made as to whether we are currently moving and it should stop.
        // Conditions:
        // 1. If both the tilt and lift are at 100% do nothing
        // 2. If the tilt position is not currently at the bottom then shift the tilt.
        // 3. If the tilt position is add the bottom then shift the lift.
        if(this->currentTiltPos >= 100.0f && this->currentPos >= 100.0f) return; // Do nothing
        else if(this->currentTiltPos < 100.0f) {
          // Set the tilt position.  This should stop the lift movement.
          this->p_target(this->currentPos);
          if(this->tiltTime == 0) return; // Avoid divide by 0.
          this->p_tiltTarget(min(100.0f, this->currentTiltPos + (100.0f/(static_cast<float>(this->tiltTime/static_cast<float>(this->stepSize))))));
        }
        else {
          // We only have the lift to move.
          if(this->downTime == 0) return; // Avoid divide by 0.
          this->p_tiltTarget(this->currentTiltPos);
          this->p_target(min(100.0f, this->currentPos + (100.0f/(static_cast<float>(this->downTime/static_cast<float>(this->stepSize))))));
        }
      }
      else if(this->tiltType == tilt_types::tiltonly) {
        if(this->tiltTime == 0 || this->stepSize == 0 || this->currentTiltPos >= 100.0f) return;
        this->p_tiltTarget(min(100.0f, this->currentTiltPos + (100.0f/(static_cast<float>(this->tiltTime/static_cast<float>(this->stepSize))))));
      }
      else if(this->currentPos < 100.0f) {
        if(this->downTime == 0 || this->stepSize == 0) return;
        this->p_target(this->stepDownTarget(this->stepSize));
      }
      break;
    case somfy_commands::Flag:
      this->p_sunFlag(false);
      if(this->hasSunSensor()) {
        somfy.isDirty = true;
        this->emitState();
      }
      else {
        Serial.printf("Shade does not have sensor %d\n", this->flags);
      }
      break;    
    case somfy_commands::SunFlag:
      if(this->hasSunSensor()) {
        const bool isWindy = this->flags & static_cast<uint8_t>(somfy_flags_t::Windy);
        this->p_sunFlag(true);
        //this->flags |= static_cast<uint8_t>(somfy_flags_t::SunFlag);
        if (!isWindy)
        {
          const bool isSunny = this->flags & static_cast<uint8_t>(somfy_flags_t::Sunny);
          if (isSunny && this->sunDone)
            this->p_target(this->myPos >= 0 ? this->myPos : 100.0f);
          else if (!isSunny && this->noSunDone)
            this->p_target(0.0f);
        }
        somfy.isDirty = true;
        this->emitState();
      }
      else
        Serial.printf("Shade does not have sensor %d\n", this->flags);
      break;
    default:
      dir = 0;
      break;
  }
  this->setMovement(dir);
}
void SomfyShade::setTiltMovement(int8_t dir) {
  int8_t currDir = this->tiltDirection;
  if(dir == 0) {
    // The shade tilt is stopped.
    this->startTiltPos = this->currentTiltPos;
    this->tiltStart = 0;
    this->p_tiltDirection(dir);
    if(currDir != dir) {
      this->commitTiltPosition();
    }
  }
  else if(this->tiltDirection != dir) {
    this->tiltStart = millis();
    this->startTiltPos = this->currentTiltPos;
    this->p_tiltDirection(dir);
  }
  if(this->tiltDirection != currDir) {
    this->emitState();
  }
}
void SomfyShade::setMovement(int8_t dir) {
  int8_t currDir = this->direction;
  int8_t currTiltDir = this->tiltDirection;
  if(dir == 0) {
    if(currDir != dir || currTiltDir != dir) this->commitShadePosition();
  }
  else {
    this->tiltStart = this->moveStart = millis();
    this->startPos = this->currentPos;
    this->startTiltPos = this->currentTiltPos;
    this->startLiftPos = this->liftPos;
  }
  if(this->direction != currDir || currTiltDir != this->tiltDirection) {
    this->emitState();
  }
}
void SomfyShade::setMyPosition(int8_t pos, int8_t tilt) {
  if(!this->isIdle()) return; // Don't do this if it is moving.
  if(this->tiltType == tilt_types::tiltonly) {
    this->p_myPos(-1.0f);    
    if(tilt != floor(this->currentTiltPos)) {
      this->settingMyPos = true;
      if(tilt == floor(this->myTiltPos))
        this->moveToMyPosition();
      else 
        this->moveToTarget(100, tilt);
    }
    else if(tilt == floor(this->myTiltPos)) {
      // Of so we need to clear the my position. These motors are finicky so send
      // a my command to ensure we are actually at the my position then send the clear
      // command.  There really is no other way to do this.
      if(this->currentTiltPos != this->myTiltPos) {
        this->settingMyPos = true;
        this->moveToMyPosition();      
      }
      else {
        SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
        this->settingPos = false;
        this->settingMyPos = true;
      }
    }
    else {
      SomfyRemote::sendCommand(somfy_commands::My, SETMY_REPEATS);
      this->p_myTiltPos(this->currentTiltPos);
    }
    this->commitMyPosition();
    this->emitState();
  }
  else if(this->tiltType != tilt_types::none) {
      if(tilt < 0) tilt = 0;
      if(pos != floor(this->currentPos) || tilt != floor(this->currentTiltPos)) {
        this->settingMyPos = true;
        if(pos == floor(this->myPos) && tilt == floor(this->myTiltPos))
          this->moveToMyPosition();
        else
          this->moveToTarget(pos, tilt);
      }
      else if(pos == floor(this->myPos) && tilt == floor(this->myTiltPos)) {
        // Of so we need to clear the my position. These motors are finicky so send
        // a my command to ensure we are actually at the my position then send the clear
        // command.  There really is no other way to do this.
        if(this->currentPos != this->myPos || this->currentTiltPos != this->myTiltPos) {
          this->settingMyPos = true;
          this->moveToMyPosition();      
        }
        else {
          SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
          this->settingPos = false;
          this->settingMyPos = true;
        }
      }
      else {
        SomfyRemote::sendCommand(somfy_commands::My, SETMY_REPEATS);
        this->p_myPos(this->currentPos);
        this->p_myTiltPos(this->currentTiltPos);
      }
      this->commitMyPosition();
      this->emitState();
  }
  else {
    if(pos != floor(this->currentPos)) {
      this->settingMyPos = true;
      if(pos == floor(this->myPos))
        this->moveToMyPosition();
      else
        this->moveToTarget(pos);
    }
    else if(pos == floor(this->myPos)) {
      // Of so we need to clear the my position. These motors are finicky so send
      // a my command to ensure we are actually at the my position then send the clear
      // command.  There really is no other way to do this.
      if(this->myPos != this->currentPos) {
        this->settingMyPos = true;
        this->moveToMyPosition();      
      }
      else {
        SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
        this->settingPos = false;
        this->settingMyPos = true;
      }
    }
    else {
      SomfyRemote::sendCommand(somfy_commands::My, SETMY_REPEATS);
      this->p_myPos(currentPos);
      this->p_myTiltPos(-1);
      this->commitMyPosition();
      this->emitState();
    }
  }
}
void SomfyShade::moveToMyPosition() {
  if(!this->isIdle()) return;
  Serial.println("Moving to My Position");
  if(this->tiltType == tilt_types::tiltonly) {
    this->p_currentPos(100.0f);
    this->p_myPos(-1.0f);
  }
  if(this->currentPos == this->myPos) {
    if(this->tiltType != tilt_types::none) {
      if(this->currentTiltPos == this->myTiltPos) return; // Nothing to see here since we are already here.
    }
    else
      return;
  }
  if(this->myPos == -1 && (this->tiltType == tilt_types::none || this->myTiltPos == -1)) return;
  if(this->tiltType != tilt_types::tiltonly && this->myPos >= 0.0f && this->myPos <= 100.0f) this->p_target(this->myPos);
  if(this->myTiltPos >= 0.0f && this->myTiltPos <= 100.0f) this->p_tiltTarget(this->myTiltPos);
  this->settingPos = false;
  if(this->simMy()) {
    Serial.print("Moving to simulated favorite\n");
    this->moveToTarget(this->myPos, this->myTiltPos);
  }
  else
    SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
}
void SomfyShade::sendCommand(somfy_commands cmd) { this->sendCommand(cmd, this->repeats); }
void SomfyShade::sendCommand(somfy_commands cmd, uint8_t repeat, uint8_t stepSize) {
  // This sendCommand function will always be called externally. sendCommand at the remote level
  // is expected to be called internally when the motor needs commanded.
  if(this->bitLength == 0) this->bitLength = somfy.transceiver.config.type;
  if(cmd == somfy_commands::Up) {
    if(this->tiltType == tilt_types::euromode) {
      // In euromode we need to long press for 2 seconds on the
      // up command.
      SomfyRemote::sendCommand(cmd, TILT_REPEATS);
      this->p_target(0.0f);     
    }
    else {
      SomfyRemote::sendCommand(cmd, repeat);
      if(this->tiltType == tilt_types::tiltonly) {
        this->p_target(100.0f);
        this->p_tiltTarget(0.0f);
        this->p_currentPos(100.0f);
      }
      else this->p_target(0.0f);
      if(this->tiltType == tilt_types::integrated) this->p_tiltTarget(0.0f);
    }
  }
  else if(cmd == somfy_commands::Down) {
    if(this->tiltType == tilt_types::euromode) {
      // In euromode we need to long press for 2 seconds on the
      // down command.
      SomfyRemote::sendCommand(cmd, TILT_REPEATS);
      this->p_target(100.0f);     
    }
    else {
      SomfyRemote::sendCommand(cmd, repeat);
      if(this->tiltType == tilt_types::tiltonly) {
        this->p_target(100.0f);
        this->p_tiltTarget(100.0f);
        this->p_currentPos(100.0f);
      }
      else this->p_target(100.0f);
      if(this->tiltType == tilt_types::integrated) this->p_tiltTarget(100.0f);
    }
  }
  else if(cmd == somfy_commands::My) {
    if(this->isToggle() || this->shadeType == shade_types::drycontact)
      SomfyRemote::sendCommand(cmd, repeat);
    else if(this->shadeType == shade_types::drycontact2) return;   
    else if(this->isIdle()) {
      this->moveToMyPosition();      
      return;
    }
    else {
      SomfyRemote::sendCommand(cmd, repeat);
      if(this->tiltType != tilt_types::tiltonly) this->p_target(this->currentPos);
      this->p_tiltTarget(this->currentTiltPos);
    }
  }
  else if(cmd == somfy_commands::Toggle) {
    if(this->bitLength != 80) SomfyRemote::sendCommand(somfy_commands::My, repeat, stepSize);
    else SomfyRemote::sendCommand(somfy_commands::Toggle, repeat);
  }
  else if(this->isToggle() && cmd == somfy_commands::Prog) {
    SomfyRemote::sendCommand(somfy_commands::Toggle, repeat, stepSize);
  }
  else {
    SomfyRemote::sendCommand(cmd, repeat, stepSize);
  }
}
void SomfyGroup::sendCommand(somfy_commands cmd) { this->sendCommand(cmd, this->repeats); }
void SomfyGroup::sendCommand(somfy_commands cmd, uint8_t repeat, uint8_t stepSize) {
  // This sendCommand function will always be called externally. sendCommand at the remote level
  // is expected to be called internally when the motor needs commanded.
  if(this->bitLength == 0) this->bitLength = somfy.transceiver.config.type;
  SomfyRemote::sendCommand(cmd, repeat, stepSize);
  
  switch(cmd) {
    case somfy_commands::My:
      this->p_direction(0);
      break;
    case somfy_commands::Up:
      this->p_direction(-1);
      break;
    case somfy_commands::Down:
      this->p_direction(1);
      break;
    default:
      break;
  }
  
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPED_SHADES; i++) {
    if(this->linkedShades[i] != 0) {
      SomfyShade *shade = somfy.getShadeById(this->linkedShades[i]);
      if(shade) {
        shade->processInternalCommand(cmd, repeat);
        shade->emitCommand(cmd, "group", this->getRemoteAddress());
      }
    }
  }
  this->updateFlags();
  this->emitState();
  
}  
void SomfyShade::sendTiltCommand(somfy_commands cmd) {
  if(cmd == somfy_commands::Up) {
    SomfyRemote::sendCommand(cmd, this->tiltType == tilt_types::tiltmotor ? TILT_REPEATS : this->repeats);
    this->p_tiltTarget(0.0f);
  }
  else if(cmd == somfy_commands::Down) {
    SomfyRemote::sendCommand(cmd, this->tiltType == tilt_types::tiltmotor ? TILT_REPEATS : this->repeats);
    this->p_tiltTarget(100.0f);
  }
  else if(cmd == somfy_commands::My) {
    SomfyRemote::sendCommand(cmd, this->tiltType == tilt_types::tiltmotor ? TILT_REPEATS : this->repeats);
    this->p_tiltTarget(this->currentTiltPos);
  }
}
void SomfyShade::moveToTiltTarget(float target) {
  somfy_commands cmd = somfy_commands::My;
  if(target < this->currentTiltPos)
    cmd = somfy_commands::Up;
  else if(target > this->currentTiltPos)
    cmd = somfy_commands::Down;
  if(target >= 0.0f && target <= 100.0f) {
    // Only send a command if the lift is not moving.
    if(this->currentPos == this->target || this->tiltType == tilt_types::tiltmotor) {
      if(cmd != somfy_commands::My) {
        Serial.print("Moving Tilt to ");
        Serial.print(target);
        Serial.print("% from ");
        Serial.print(this->currentTiltPos);
        Serial.print("% using ");
        Serial.println(translateSomfyCommand(cmd));
        SomfyRemote::sendCommand(cmd, this->tiltType == tilt_types::tiltmotor ? TILT_REPEATS : this->repeats);
      }
      // If the blind is currently moving then the command to stop it
      // will occur on its own when the tilt target is set.
    }
    this->p_tiltTarget(target);
  }
  if(cmd != somfy_commands::My) this->settingTiltPos = true;
}
void SomfyShade::moveToTarget(float pos, float tilt) {
  somfy_commands cmd = somfy_commands::My;
  if(this->isToggle()) {
    // Overload this as we cannot seek a position on a garage door or single button device.
    this->p_target(pos);
    this->p_currentPos(pos);
    this->emitState();
    return;
  }
  if(this->tiltType == tilt_types::tiltonly) {
    this->p_target(100.0f);
    this->p_myPos(-1.0f);
    this->p_currentPos(100.0f);
    pos = 100;
    if(tilt < this->currentTiltPos) cmd = somfy_commands::Up;
    else if(tilt > this->currentTiltPos) cmd = somfy_commands::Down;
  }
  else {
    if(pos < this->currentPos)
      cmd = somfy_commands::Up;
    else if(pos > this->currentPos)
      cmd = somfy_commands::Down;
    else if(tilt >= 0 && tilt < this->currentTiltPos)
      cmd = somfy_commands::Up;
    else if(tilt >= 0 && tilt > this->currentTiltPos)
      cmd = somfy_commands::Down;
  }
  if(cmd != somfy_commands::My) {
    Serial.print("Moving to ");
    Serial.print(pos);
    Serial.print("% from ");
    Serial.print(this->currentPos);
    if(tilt >= 0) {
      Serial.print(" tilt ");
      Serial.print(tilt);
      Serial.print("% from ");
      Serial.print(this->currentTiltPos);
    }
    Serial.print("% using ");
    Serial.println(translateSomfyCommand(cmd));
    SomfyRemote::sendCommand(cmd, this->tiltType == tilt_types::euromode ? TILT_REPEATS : this->repeats);
    this->settingPos = true;
    this->p_target(pos);
    if(tilt >= 0) {
      this->p_tiltTarget(tilt);
      this->settingTiltPos = true;
    }
  }
}
bool SomfyShade::save() {
  #ifdef USE_NVS
  if(somfy.useNVS()) {
    char shadeKey[15];
    snprintf(shadeKey, sizeof(shadeKey), "SomfyShade%u", this->getShadeId());
    pref.begin(shadeKey);
    pref.clear();
    pref.putChar("shadeType", static_cast<uint8_t>(this->shadeType));
    pref.putUInt("remoteAddress", this->getRemoteAddress());
    pref.putString("name", this->name);
    pref.putBool("hasTilt", this->tiltType != tilt_types::none);
    pref.putBool("paired", this->paired);
    pref.putUInt("upTime", this->upTime);
    pref.putUInt("downTime", this->downTime);
    pref.putUInt("liftTime", this->liftTime);
    pref.putFloat("curveGain", this->curveGain);
    pref.putUInt("tiltTime", this->tiltTime);
    pref.putFloat("currentPos", this->currentPos);
    pref.putFloat("currentTiltPos", this->currentTiltPos);
    pref.putUShort("myPos", this->myPos);
    uint32_t linkedAddresses[SOMFY_MAX_LINKED_REMOTES];
    memset(linkedAddresses, 0x00, sizeof(linkedAddresses));
    uint8_t j = 0;
    for(uint8_t i = 0; i < SOMFY_MAX_LINKED_REMOTES; i++) {
      SomfyLinkedRemote lremote = this->linkedRemotes[i];
      if(lremote.getRemoteAddress() != 0) linkedAddresses[j++] = lremote.getRemoteAddress();
    }
    pref.remove("linkedAddr");
    pref.putBytes("linkedAddr", linkedAddresses, sizeof(uint32_t) * SOMFY_MAX_LINKED_REMOTES);
    pref.end();
  }
  #endif
  this->commit();
  this->publish();
  return true;
}
bool SomfyRoom::save() { somfy.commit(); return true; }
bool SomfyGroup::save() { somfy.commit(); return true; }
bool SomfyShade::isToggle() {
  switch(this->shadeType) {
    case shade_types::garage1:
    case shade_types::lgate1:
    case shade_types::cgate1:
    case shade_types::rgate1:
      return true;
    default:
      break;
  }
  return false;
}
bool SomfyShade::usesPin(uint8_t pin) {
  if(this->proto != radio_proto::GP_Remote && this->proto != radio_proto::GP_Relay) return false;
  if(this->gpioDown == pin) return true;
  else if(this->shadeType == shade_types::drycontact)
    return this->gpioDown == pin;
  else if(this->isToggle()) {
    if(this->proto == radio_proto::GP_Relay && this->gpioUp == pin) return true;    
  }
  else if(this->shadeType == shade_types::drycontact2) {
    if(this->proto == radio_proto::GP_Relay && (this->gpioUp == pin || this->gpioDown == pin)) return true;
  }
  else {
    if(this->gpioUp == pin) return true;
    else if(this->proto == radio_proto::GP_Remote && this->gpioMy == pin) return true;    
  }
  return false;
}
int8_t SomfyShade::validateJSON(JsonObject &obj) {
  int8_t ret = 0;
  shade_types type = this->shadeType;
  if(obj.containsKey("shadeType")) {
    if(obj["shadeType"].is<const char *>()) {
      if(strncmp(obj["shadeType"].as<const char *>(), "roller", 7) == 0)
        type = shade_types::roller;
      else if(strncmp(obj["shadeType"].as<const char *>(), "ldrapery", 9) == 0)
        type = shade_types::ldrapery;
      else if(strncmp(obj["shadeType"].as<const char *>(), "rdrapery", 9) == 0)
        type = shade_types::rdrapery;
      else if(strncmp(obj["shadeType"].as<const char *>(), "cdrapery", 9) == 0)
        type = shade_types::cdrapery;
      else if(strncmp(obj["shadeType"].as<const char *>(), "garage1", 7) == 0)
        type = shade_types::garage1;
      else if(strncmp(obj["shadeType"].as<const char *>(), "garage3", 7) == 0)
        type = shade_types::garage3;
      else if(strncmp(obj["shadeType"].as<const char *>(), "blind", 5) == 0)
        type = shade_types::blind;
      else if(strncmp(obj["shadeType"].as<const char *>(), "awning", 7) == 0)
        type = shade_types::awning;
      else if(strncmp(obj["shadeType"].as<const char *>(), "shutter", 8) == 0)
        type = shade_types::shutter;
      else if(strncmp(obj["shadeType"].as<const char *>(), "drycontact2", 12) == 0)
        type = shade_types::drycontact2;
      else if(strncmp(obj["shadeType"].as<const char *>(), "drycontact", 11) == 0)
        type = shade_types::drycontact;
    }
    else {
      this->shadeType = static_cast<shade_types>(obj["shadeType"].as<uint8_t>());
    }
  }
  if(obj.containsKey("proto")) {
    radio_proto proto = this->proto;
    if(proto == radio_proto::GP_Relay || proto == radio_proto::GP_Remote) {
      // Check to see if we are using the up and or down
      // GPIOs anywhere else.
      uint8_t upPin = obj.containsKey("gpioUp") ? obj["gpioUp"].as<uint8_t>() : this->gpioUp;
      uint8_t downPin = obj.containsKey("gpioDown") ? obj["gpioDown"].as<uint8_t>() : this->gpioDown;
      uint8_t myPin = obj.containsKey("gpioMy") ? obj["gpioMy"].as<uint8_t>() : this->gpioMy;
      if(type == shade_types::drycontact || 
        ((type == shade_types::garage1 || type == shade_types::lgate1 || type == shade_types::cgate1 || type == shade_types::rgate1) 
        && proto == radio_proto::GP_Remote)) upPin = myPin = 255;
      else if(type == shade_types::drycontact2) myPin = 255;
      if(proto == radio_proto::GP_Relay) myPin = 255;
      if(somfy.transceiver.config.enabled) {
        if((upPin != 255 && somfy.transceiver.usesPin(upPin)) ||
          (downPin != 255 && somfy.transceiver.usesPin(downPin)) ||
          (myPin != 255 && somfy.transceiver.usesPin(myPin)))
          ret = -10;
      }
      if(settings.connType == conn_types_t::ethernet || settings.connType == conn_types_t::ethernetpref) {
        if((upPin != 255 && settings.Ethernet.usesPin(upPin)) ||
          (downPin != 255 && somfy.transceiver.usesPin(downPin)) ||
          (myPin != 255 && somfy.transceiver.usesPin(myPin)))
          ret = -11;
      }
      if(ret == 0) {
        for(uint8_t i = 0; i < SOMFY_MAX_SHADES; i++) {
          SomfyShade *shade = &somfy.shades[i];
          if(shade->getShadeId() == this->getShadeId() || shade->getShadeId() == 255) continue;
          if((upPin != 255 && shade->usesPin(upPin)) ||
            (downPin != 255 && shade->usesPin(downPin)) ||
            (myPin != 255 && shade->usesPin(myPin))){
            ret = -12;
            break;
          }
        }
      }
    }
  }
  return ret;
}
int8_t SomfyShade::fromJSON(JsonObject &obj) {
  int8_t err = this->validateJSON(obj);
  if(err == 0) {
    if(obj.containsKey("name")) strlcpy(this->name, obj["name"], sizeof(this->name));
    if(obj.containsKey("roomId")) this->roomId = obj["roomId"];
    if(obj.containsKey("upTime")) this->upTime = obj["upTime"];
    if(obj.containsKey("downTime")) this->downTime = obj["downTime"];
    // Clamp to the same range as the UI; an out of range value cast to int32 in
    // checkMovement would otherwise wrap negative and break the position math.
    if(obj.containsKey("liftTime")) this->liftTime = min(obj["liftTime"].as<uint32_t>(), (uint32_t)60000);
    if(obj.containsKey("curveGain")) this->curveGain = constrain(obj["curveGain"].as<float>(), 0.0f, 0.95f);
    if(obj.containsKey("remoteAddress")) this->setRemoteAddress(obj["remoteAddress"]);
    if(obj.containsKey("tiltTime")) this->tiltTime = obj["tiltTime"];
    if(obj.containsKey("stepSize")) this->stepSize = obj["stepSize"];
    if(obj.containsKey("hasTilt")) this->tiltType = static_cast<bool>(obj["hasTilt"]) ? tilt_types::none : tilt_types::tiltmotor;
    if(obj.containsKey("bitLength")) this->bitLength = obj["bitLength"];
    if(obj.containsKey("proto")) this->proto = static_cast<radio_proto>(obj["proto"].as<uint8_t>());
    if(obj.containsKey("sunSensor")) this->setSunSensor(obj["sunSensor"]);
    if(obj.containsKey("simMy")) this->setSimMy(obj["simMy"]);
    if(obj.containsKey("light")) this->setLight(obj["light"]);
    if(obj.containsKey("gpioFlags")) this->gpioFlags = obj["gpioFlags"];
    if(obj.containsKey("gpioLLTrigger")) {
      if(obj["gpioLLTrigger"].as<bool>())
        this->gpioFlags |= (uint8_t)gpio_flags_t::LowLevelTrigger;
      else
        this->gpioFlags &= ~(uint8_t)gpio_flags_t::LowLevelTrigger;
    }
    
    if(obj.containsKey("shadeType")) {
      if(obj["shadeType"].is<const char *>()) {
        if(strncmp(obj["shadeType"].as<const char *>(), "roller", 7) == 0)
          this->shadeType = shade_types::roller;
        else if(strncmp(obj["shadeType"].as<const char *>(), "ldrapery", 9) == 0)
          this->shadeType = shade_types::ldrapery;
        else if(strncmp(obj["shadeType"].as<const char *>(), "rdrapery", 9) == 0)
          this->shadeType = shade_types::rdrapery;
        else if(strncmp(obj["shadeType"].as<const char *>(), "cdrapery", 9) == 0)
          this->shadeType = shade_types::cdrapery;
        else if(strncmp(obj["shadeType"].as<const char *>(), "garage1", 7) == 0)
          this->shadeType = shade_types::garage1;
        else if(strncmp(obj["shadeType"].as<const char *>(), "garage3", 7) == 0)
          this->shadeType = shade_types::garage3;
        else if(strncmp(obj["shadeType"].as<const char *>(), "blind", 5) == 0)
          this->shadeType = shade_types::blind;
        else if(strncmp(obj["shadeType"].as<const char *>(), "awning", 7) == 0)
          this->shadeType = shade_types::awning;
        else if(strncmp(obj["shadeType"].as<const char *>(), "shutter", 8) == 0)
          this->shadeType = shade_types::shutter;
        else if(strncmp(obj["shadeType"].as<const char *>(), "drycontact2", 12) == 0)
          this->shadeType = shade_types::drycontact2;
        else if(strncmp(obj["shadeType"].as<const char *>(), "drycontact", 11) == 0)
          this->shadeType = shade_types::drycontact;
      }
      else {
        this->shadeType = static_cast<shade_types>(obj["shadeType"].as<uint8_t>());
      }
    }
    if(obj.containsKey("flipCommands")) this->flipCommands = obj["flipCommands"].as<bool>();
    if(obj.containsKey("flipPosition")) this->flipPosition = obj["flipPosition"].as<bool>();
    if(obj.containsKey("repeats")) this->repeats = obj["repeats"];
    if(obj.containsKey("tiltType")) {
      if(obj["tiltType"].is<const char *>()) {
        if(strncmp(obj["tiltType"].as<const char *>(), "none", 4) == 0)
          this->tiltType = tilt_types::none;
        else if(strncmp(obj["tiltType"].as<const char *>(), "tiltmotor", 9) == 0)
          this->tiltType = tilt_types::tiltmotor;
        else if(strncmp(obj["tiltType"].as<const char *>(), "integ", 5) == 0)
          this->tiltType = tilt_types::integrated;
        else if(strncmp(obj["tiltType"].as<const char *>(), "tiltonly", 8) == 0)
          this->tiltType = tilt_types::tiltonly;
      }
      else {
        this->tiltType = static_cast<tilt_types>(obj["tiltType"].as<uint8_t>());
      }
    }
    if(obj.containsKey("linkedAddresses")) {
      uint32_t linkedAddresses[SOMFY_MAX_LINKED_REMOTES];
      memset(linkedAddresses, 0x00, sizeof(linkedAddresses));
      JsonArray arr = obj["linkedAddresses"];
      uint8_t i = 0;
      for(uint32_t addr : arr) {
        if(i >= SOMFY_MAX_LINKED_REMOTES) break;
        linkedAddresses[i++] = addr;
      }
      for(uint8_t j = 0; j < SOMFY_MAX_LINKED_REMOTES; j++) {
        this->linkedRemotes[j].setRemoteAddress(linkedAddresses[j]);
      }
    }
    if(obj.containsKey("flags")) this->flags = obj["flags"];
    if(this->proto == radio_proto::GP_Remote || this->proto == radio_proto::GP_Relay) {
      if(obj.containsKey("gpioUp")) this->gpioUp = obj["gpioUp"];
      if(obj.containsKey("gpioDown")) this->gpioDown = obj["gpioDown"];
      pinMode(this->gpioUp, OUTPUT);
      pinMode(this->gpioDown, OUTPUT);
    }
    if(this->proto == radio_proto::GP_Remote) {
      if(obj.containsKey("gpioMy")) this->gpioMy = obj["gpioMy"];
      pinMode(this->gpioMy, OUTPUT);
    }
  }
  return err;
}
void SomfyShade::toJSONRef(JsonResponse &json) { this->toJSONRef(json, true); }
void SomfyShade::toJSONRef(JsonResponse &json, bool includeSecrets) {
  json.addElem("shadeId", this->getShadeId());
  json.addElem("roomId", this->roomId);
  json.addElem("name", this->name);
  json.addElem("remoteAddress", includeSecrets ? (uint32_t)this->m_remoteAddress : (uint32_t)0);
  json.addElem("paired", this->paired);
  json.addElem("shadeType", static_cast<uint8_t>(this->shadeType));
  json.addElem("flipCommands", this->flipCommands);
  json.addElem("flipPosition", this->flipPosition);
  json.addElem("bitLength", this->bitLength);
  json.addElem("proto", static_cast<uint8_t>(this->proto));
  json.addElem("flags", this->flags);
  json.addElem("sunSensor", this->hasSunSensor());
  json.addElem("hasLight", this->hasLight());
  json.addElem("repeats", this->repeats);
  //SomfyRemote::toJSON(json);
}

void SomfyShade::toJSON(JsonResponse &json) { this->toJSON(json, true); }
void SomfyShade::toJSON(JsonResponse &json, bool includeSecrets) {
  json.addElem("shadeId", this->getShadeId());
  json.addElem("roomId", this->roomId);
  json.addElem("name", this->name);
  json.addElem("remoteAddress", includeSecrets ? (uint32_t)this->m_remoteAddress : (uint32_t)0);
  json.addElem("upTime", (uint32_t)this->upTime);
  json.addElem("downTime", (uint32_t)this->downTime);
  json.addElem("liftTime", (uint32_t)this->liftTime);
  json.addElem("curveGain", this->curveGain);
  json.addElem("paired", this->paired);
  json.addElem("lastRollingCode", includeSecrets ? (uint32_t)this->lastRollingCode : (uint32_t)0);
  json.addElem("position", this->transformPosition(this->currentPos));
  json.addElem("tiltType", static_cast<uint8_t>(this->tiltType));
  json.addElem("tiltPosition", this->transformPosition(this->currentTiltPos));
  json.addElem("tiltDirection", this->tiltDirection);
  json.addElem("tiltTime", (uint32_t)this->tiltTime);
  json.addElem("stepSize", (uint32_t)this->stepSize);
  json.addElem("tiltTarget", this->transformPosition(this->tiltTarget));
  json.addElem("target", this->transformPosition(this->target));
  json.addElem("myPos", this->transformPosition(this->myPos));
  json.addElem("myTiltPos", this->transformPosition(this->myTiltPos));
  json.addElem("direction", this->direction);
  json.addElem("shadeType", static_cast<uint8_t>(this->shadeType));
  json.addElem("bitLength", this->bitLength);
  json.addElem("proto", static_cast<uint8_t>(this->proto));
  json.addElem("flags", this->flags);
  json.addElem("flipCommands", this->flipCommands);
  json.addElem("flipPosition", this->flipPosition);
  json.addElem("inGroup", this->isInGroup());
  json.addElem("sunSensor", this->hasSunSensor());
  json.addElem("light", this->hasLight());
  json.addElem("repeats", this->repeats);
  json.addElem("sortOrder", this->sortOrder);  
  json.addElem("gpioUp", this->gpioUp);
  json.addElem("gpioDown", this->gpioDown);
  json.addElem("gpioMy", this->gpioMy);
  json.addElem("gpioLLTrigger", ((this->gpioFlags & (uint8_t)gpio_flags_t::LowLevelTrigger) == 0) ? false : true);
  json.addElem("simMy", this->simMy());
  json.beginArray("linkedRemotes");
  for(uint8_t i = 0; includeSecrets && i < SOMFY_MAX_LINKED_REMOTES; i++) {
    SomfyLinkedRemote &lremote = this->linkedRemotes[i];
    if(lremote.getRemoteAddress() != 0) {
      json.beginObject();
      lremote.toJSON(json);
      json.endObject();
    }
  }
  json.endArray();
}

/*
bool SomfyShade::toJSON(JsonObject &obj) {
  //Serial.print("Serializing Shade:");
  //Serial.print(this->getShadeId());
  //Serial.print("  ");
  //Serial.println(this->name);
  obj["shadeId"] = this->getShadeId();
  obj["roomId"] = this->roomId;
  obj["name"] = this->name;
  obj["remoteAddress"] = this->m_remoteAddress;
  obj["upTime"] = this->upTime;
  obj["downTime"] = this->downTime;
  obj["paired"] = this->paired;
  //obj["remotePrefId"] = this->getRemotePrefId();
  obj["lastRollingCode"] = this->lastRollingCode;
  obj["position"] = this->transformPosition(this->currentPos);
  obj["tiltPosition"] = this->transformPosition(this->currentTiltPos);
  obj["tiltDirection"] = this->tiltDirection;
  obj["tiltTime"] = this->tiltTime;
  obj["stepSize"] = this->stepSize;
  obj["tiltTarget"] = this->transformPosition(this->tiltTarget);
  obj["target"] = this->transformPosition(this->target);
  obj["myPos"] = this->transformPosition(this->myPos);
  obj["myTiltPos"] = this->transformPosition(this->myTiltPos);
  obj["direction"] = this->direction;
  obj["tiltType"] = static_cast<uint8_t>(this->tiltType);
  obj["tiltTime"] = this->tiltTime;
  obj["shadeType"] = static_cast<uint8_t>(this->shadeType);
  obj["bitLength"] = this->bitLength;
  obj["proto"] = static_cast<uint8_t>(this->proto);
  obj["flags"] = this->flags;
  obj["flipCommands"] = this->flipCommands;
  obj["flipPosition"] = this->flipPosition;
  obj["inGroup"] = this->isInGroup();
  obj["sunSensor"] = this->hasSunSensor();
  obj["light"] = this->hasLight();
  obj["repeats"] = this->repeats;
  obj["sortOrder"] = this->sortOrder;  
  obj["gpioUp"] = this->gpioUp;
  obj["gpioDown"] = this->gpioDown;
  obj["gpioMy"] = this->gpioMy;
  obj["gpioLLTrigger"] = ((this->gpioFlags & (uint8_t)gpio_flags_t::LowLevelTrigger) == 0) ? false : true;
  SomfyRemote::toJSON(obj);
  JsonArray arr = obj.createNestedArray("linkedRemotes");
  for(uint8_t i = 0; i < SOMFY_MAX_LINKED_REMOTES; i++) {
    SomfyLinkedRemote &lremote = this->linkedRemotes[i];
    if(lremote.getRemoteAddress() != 0) {
      JsonObject lro = arr.createNestedObject();
      lremote.toJSON(lro);
    }
  }
  return true;
}
*/
bool SomfyRoom::fromJSON(JsonObject &obj) {
  if(obj.containsKey("name")) strlcpy(this->name, obj["name"], sizeof(this->name));
  if(obj.containsKey("sortOrder")) this->sortOrder = obj["sortOrder"];
  return true;
}
/*
bool SomfyRoom::toJSON(JsonObject &obj) {
  obj["roomId"] = this->roomId;
  obj["name"] = this->name;
  obj["sortOrder"] = this->sortOrder;
  return true;
}
*/
void SomfyRoom::toJSON(JsonResponse &json) {
  json.addElem("roomId", this->roomId);
  json.addElem("name", this->name);
  json.addElem("sortOrder", this->sortOrder);
}

bool SomfyGroup::fromJSON(JsonObject &obj) {
  if(obj.containsKey("name")) strlcpy(this->name, obj["name"], sizeof(this->name));
  if(obj.containsKey("roomId")) this->roomId = obj["roomId"];
  if(obj.containsKey("remoteAddress")) this->setRemoteAddress(obj["remoteAddress"]);
  if(obj.containsKey("bitLength")) this->bitLength = obj["bitLength"];
  if(obj.containsKey("proto")) this->proto = static_cast<radio_proto>(obj["proto"].as<uint8_t>());
  if(obj.containsKey("flipCommands")) this->flipCommands = obj["flipCommands"].as<bool>();
  
  //if(obj.containsKey("sunSensor")) this->hasSunSensor() = obj["sunSensor"];  This is calculated
  if(obj.containsKey("repeats")) this->repeats = obj["repeats"];
  if(obj.containsKey("linkedShades")) {
    uint8_t linkedShades[SOMFY_MAX_GROUPED_SHADES];
    memset(linkedShades, 0x00, sizeof(linkedShades));
    JsonArray arr = obj["linkedShades"];
    uint8_t i = 0;
    for(uint8_t shadeId : arr) {
      if(i >= SOMFY_MAX_GROUPED_SHADES) break;
      linkedShades[i++] = shadeId;
    }
  }
  return true;
}
void SomfyGroup::toJSON(JsonResponse &json) { this->toJSON(json, true); }
void SomfyGroup::toJSON(JsonResponse &json, bool includeSecrets) {
  this->updateFlags();
  json.addElem("groupId", this->getGroupId());
  json.addElem("roomId", this->roomId);
  json.addElem("name", this->name);
  json.addElem("remoteAddress", includeSecrets ? (uint32_t)this->m_remoteAddress : (uint32_t)0);
  json.addElem("lastRollingCode", includeSecrets ? (uint32_t)this->lastRollingCode : (uint32_t)0);
  json.addElem("bitLength", this->bitLength);
  json.addElem("proto", static_cast<uint8_t>(this->proto));
  json.addElem("sunSensor", this->hasSunSensor());
  json.addElem("flipCommands", this->flipCommands);
  json.addElem("flags", this->flags);
  json.addElem("repeats", this->repeats);
  json.addElem("sortOrder", this->sortOrder);
  json.beginArray("linkedShades");
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPED_SHADES; i++) {
    uint8_t shadeId = this->linkedShades[i];
    if(shadeId > 0 && shadeId < 255) {
      SomfyShade *shade = somfy.getShadeById(shadeId);
      if(shade) {
        json.beginObject();
        shade->toJSONRef(json, includeSecrets);
        json.endObject();
      }
    }
  }
  json.endArray();
}
void SomfyGroup::toJSONRef(JsonResponse &json) { this->toJSONRef(json, true); }
void SomfyGroup::toJSONRef(JsonResponse &json, bool includeSecrets) {
  this->updateFlags();
  json.addElem("groupId", this->getGroupId());
  json.addElem("roomId", this->roomId);
  json.addElem("name", this->name);
  json.addElem("remoteAddress", includeSecrets ? (uint32_t)this->m_remoteAddress : (uint32_t)0);
  json.addElem("lastRollingCode", includeSecrets ? (uint32_t)this->lastRollingCode : (uint32_t)0);
  json.addElem("bitLength", this->bitLength);
  json.addElem("proto", static_cast<uint8_t>(this->proto));
  json.addElem("sunSensor", this->hasSunSensor());
  json.addElem("flipCommands", this->flipCommands);
  json.addElem("flags", this->flags);
  json.addElem("repeats", this->repeats);
  json.addElem("sortOrder", this->sortOrder);
}

/*
bool SomfyGroup::toJSON(JsonObject &obj) {
  this->updateFlags();
  obj["groupId"] = this->getGroupId();
  obj["roomId"] = this->roomId;
  obj["name"] = this->name;
  obj["remoteAddress"] = this->m_remoteAddress;
  obj["lastRollingCode"] = this->lastRollingCode;
  obj["bitLength"] = this->bitLength;
  obj["proto"] = static_cast<uint8_t>(this->proto);
  obj["sunSensor"] = this->hasSunSensor();
  obj["flipCommands"] = this->flipCommands;
  obj["flags"] = this->flags;
  obj["repeats"] = this->repeats;
  obj["sortOrder"] = this->sortOrder;
  SomfyRemote::toJSON(obj);
  JsonArray arr = obj.createNestedArray("linkedShades");
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPED_SHADES; i++) {
    uint8_t shadeId = this->linkedShades[i];
    if(shadeId > 0 && shadeId < 255) {
      SomfyShade *shade = somfy.getShadeById(shadeId);
      if(shade) {
        JsonObject lsd = arr.createNestedObject();
        shade->toJSONRef(lsd);
      }
    }
  }
  return true;
}
*/

void SomfyRemote::toJSON(JsonResponse &json) {
  json.addElem("remoteAddress", (uint32_t)this->getRemoteAddress());
  json.addElem("lastRollingCode", (uint32_t)this->lastRollingCode);
}
/*
bool SomfyRemote::toJSON(JsonObject &obj) {
  //obj["remotePrefId"] = this->getRemotePrefId();
  obj["remoteAddress"] = this->getRemoteAddress();
  obj["lastRollingCode"] = this->lastRollingCode;
  return true;  
}
*/
void SomfyRemote::setRemoteAddress(uint32_t address) { this->m_remoteAddress = address; snprintf(this->m_remotePrefId, sizeof(this->m_remotePrefId), "_%lu", (unsigned long)this->m_remoteAddress); }
uint32_t SomfyRemote::getRemoteAddress() { return this->m_remoteAddress; }
void SomfyShadeController::processFrame(somfy_frame_t &frame, bool internal) {
  // Internal frames are our own virtual remotes routed back through the pipeline
  // (GPIO triggers etc.); only frames that actually travelled over the air belong
  // in the RF statistics.
  if(!internal) rfStats.record(frame);
  for(uint8_t i = 0; i < SOMFY_MAX_SHADES; i++) {
    if(this->shades[i].getShadeId() != 255) this->shades[i].processFrame(frame, internal);
  }
}
void SomfyShadeController::processWaitingFrame() {
  for(uint8_t i = 0; i < SOMFY_MAX_SHADES; i++)
    if(this->shades[i].getShadeId() != 255) this->shades[i].processWaitingFrame();
}
uint8_t SomfyShadeController::getNextShadeId() {
  // There is no shortcut for this since the deletion of
  // a shade in the middle makes all of this very difficult.
  for(uint8_t i = 1; i < SOMFY_MAX_SHADES - 1; i++) {
    bool id_exists = false;
    for(uint8_t j = 0; j < SOMFY_MAX_SHADES; j++) {
      SomfyShade *shade = &this->shades[j];
      if(shade->getShadeId() == i) {
        id_exists = true;
        break;
      }
    }
    if(!id_exists) {
      Serial.print("Got next Shade Id:");
      Serial.print(i);
      return i;
    }
  }
  return 255;
}
int8_t SomfyShadeController::getMaxShadeOrder() {
  int8_t order = -1;
  for(uint8_t i = 0; i < SOMFY_MAX_SHADES; i++) {
    SomfyShade *shade = &this->shades[i];
    if(shade->getShadeId() == 255) continue;
    if(order < shade->sortOrder) order = shade->sortOrder;
  }
  return order;
}
int8_t SomfyShadeController::getMaxGroupOrder() {
  int8_t order = -1;
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPS; i++) {
    SomfyGroup *group = &this->groups[i];
    if(group->getGroupId() == 255) continue;
    if(order < group->sortOrder) order = group->sortOrder;
  }
  return order;
}
uint8_t SomfyShadeController::getNextGroupId() {
  // There is no shortcut for this since the deletion of
  // a group in the middle makes all of this very difficult.
  for(uint8_t i = 1; i < SOMFY_MAX_GROUPS - 1; i++) {
    bool id_exists = false;
    for(uint8_t j = 0; j < SOMFY_MAX_GROUPS; j++) {
      SomfyGroup *group = &this->groups[j];
      if(group->getGroupId() == i) {
        id_exists = true;
        break;
      }
    }
    if(!id_exists) {
      Serial.print("Got next Group Id:");
      Serial.print(i);
      return i;
    }
  }
  return 255;
}
uint8_t SomfyShadeController::getNextRoomId() {
  // There is no shortcut for this since the deletion of
  // a room in the middle makes all of this very difficult.
  for(uint8_t i = 1; i < SOMFY_MAX_ROOMS - 1; i++) {
    bool id_exists = false;
    for(uint8_t j = 0; j < SOMFY_MAX_ROOMS; j++) {
      SomfyRoom *room = &this->rooms[j];
      if(room->roomId == i) {
        id_exists = true;
        break;
      }
    }
    if(!id_exists) {
      Serial.print("Got next room Id:");
      Serial.print(i);
      return i;
    }
  }
  return 0;
}
int8_t SomfyShadeController::getMaxRoomOrder() {
  int8_t order = -1;
  for(uint8_t i = 0; i < SOMFY_MAX_ROOMS; i++) {
    SomfyRoom *room = &this->rooms[i];
    if(room->roomId == 0) continue;
    if(order < room->sortOrder) order = room->sortOrder;
  }
  return order;
}
uint8_t SomfyShadeController::repeaterCount() {
  uint8_t count = 0;
  for(uint8_t i = 0; i < SOMFY_MAX_REPEATERS; i++) {
    if(this->repeaters[i] != 0) count++;
  }
  return count;
}
uint8_t SomfyShadeController::roomCount() {
  uint8_t count = 0;
  for(uint8_t i = 0; i < SOMFY_MAX_ROOMS; i++) {
    if(this->rooms[i].roomId != 0) count++;
  }
  return count;
}
uint8_t SomfyShadeController::shadeCount() {
  uint8_t count = 0;
  for(uint8_t i = 0; i < SOMFY_MAX_SHADES; i++) {
    if(this->shades[i].getShadeId() != 255) count++;
  }
  return count;
}
uint8_t SomfyShadeController::groupCount() {
  uint8_t count = 0;
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPS; i++) {
    if(this->groups[i].getGroupId() != 255) count++;
  }
  return count;
}
uint32_t SomfyShadeController::getNextRemoteAddress(uint8_t id) {
  uint32_t address = this->startingAddress + id;
  uint8_t i = 0;
  // The assumption here is that the max number of groups will
  // always be less than or equal to the max number of shades.
  while(i < SOMFY_MAX_SHADES) {
    if((i < SOMFY_MAX_SHADES && this->shades[i].getShadeId() != 255 && this->shades[i].getRemoteAddress() == address) ||
      (i < SOMFY_MAX_GROUPS && this->groups[i].getGroupId() != 255 && this->groups[i].getRemoteAddress() == address)) {
      address++;
      i = 0; // Start over we cannot share addresses.
    }
    else i++;
  }
  i = 0;
  return address;
}
SomfyShade *SomfyShadeController::addShade(JsonObject &obj) {
  SomfyShade *shade = this->addShade();
  if(shade) {
    shade->fromJSON(obj);
    shade->save();
    shade->emitState("shadeAdded");
  }
  return shade;
}
SomfyShade *SomfyShadeController::addShade() {
  uint8_t shadeId = this->getNextShadeId();
  // So the next shade id will be the first one we run into with an id of 255 so
  // if it gets deleted in the middle then it will get the first slot that is empty.
  // There is no apparent way around this.  In the future we might actually add an indexer
  // to it for sorting later.  The time has come so the sort order is set below.
  if(shadeId == 255) return nullptr;
  SomfyShade *shade = &this->shades[shadeId - 1];
  if(shade) {
    shade->setShadeId(shadeId);
    shade->sortOrder = this->getMaxShadeOrder() + 1;
    Serial.printf("Sort order set to %d\n", shade->sortOrder);
    this->isDirty = true;
    #ifdef USE_NVS
    if(this->useNVS()) {
      for(uint8_t i = 0; i < sizeof(this->m_shadeIds); i++) {
        this->m_shadeIds[i] = this->shades[i].getShadeId();
      }
      sortArray<uint8_t>(this->m_shadeIds, sizeof(this->m_shadeIds));
      uint8_t id = 0;
      // This little diddy is about a bug I had previously that left duplicates in the
      // sorted array.  So we will walk the sorted array until we hit a duplicate where the previous
      // value == the current value.  Set it to 255 then sort the array again.
      // 1,1,2,2,3,3,255...
      bool hadDups = false;
      for(uint8_t i = 0; i < sizeof(this->m_shadeIds); i++) {
        if(this->m_shadeIds[i] == 255) break;
        if(id == this->m_shadeIds[i]) {
          id = this->m_shadeIds[i];
          this->m_shadeIds[i] = 255;
          hadDups = true;
        }
        else {
          id = this->m_shadeIds[i];
        }
      }
      if(hadDups) sortArray<uint8_t>(this->m_shadeIds, sizeof(this->m_shadeIds));
      pref.begin("Shades");
      pref.remove("shadeIds");
      int x = pref.putBytes("shadeIds", this->m_shadeIds, sizeof(this->m_shadeIds));
      Serial.printf("WROTE %d bytes to shadeIds\n", x);
      pref.end();
      for(uint8_t i = 0; i < sizeof(this->m_shadeIds); i++) {
        if(i != 0) Serial.print(",");
        else Serial.print("Shade Ids: ");
        Serial.print(this->m_shadeIds[i]);
      }
      Serial.println();
      pref.begin("Shades");
      pref.getBytes("shadeIds", this->m_shadeIds, sizeof(this->m_shadeIds));
      Serial.print("LENGTH:");
      Serial.println(pref.getBytesLength("shadeIds"));
      pref.end();
      for(uint8_t i = 0; i < sizeof(this->m_shadeIds); i++) {
        if(i != 0) Serial.print(",");
        else Serial.print("Shade Ids: ");
        Serial.print(this->m_shadeIds[i]);
      }
      Serial.println();
    }
    #endif
  }
  return shade;
}
bool SomfyShadeController::unlinkRepeater(uint32_t address) {
  for(uint8_t i = 0; i < SOMFY_MAX_REPEATERS; i++) {
    if(this->repeaters[i] == address) this->repeaters[i] = 0;
  }
  this->compressRepeaters();
  this->isDirty = true;
  return true;  
}
bool SomfyShadeController::linkRepeater(uint32_t address) {
  bool bSet = false;
  for(uint8_t i = 0; i < SOMFY_MAX_REPEATERS; i++) {
    if(!bSet && this->repeaters[i] == address) bSet = true;
    else if(bSet && this->repeaters[i] == address) this->repeaters[i] = 0;
  }
  if(!bSet) {
    for(uint8_t i = 0; i < SOMFY_MAX_REPEATERS; i++) {
      if(this->repeaters[i] == 0) {
        this->repeaters[i] = address;
        return true;
      }
    }
  }
  return true;
}
SomfyRoom *SomfyShadeController::addRoom(JsonObject &obj) {
  SomfyRoom *room = this->addRoom();
  if(room) {
    room->fromJSON(obj);
    room->save();
    room->emitState("roomAdded");
  }
  return room;
}
SomfyRoom *SomfyShadeController::addRoom() {
  uint8_t roomId = this->getNextRoomId();
  // So the next room id will be the first one we run into with an id of 0 so
  if(roomId == 0) return nullptr;
  SomfyRoom *room = &this->rooms[roomId - 1];
  if(room) {
    room->roomId = roomId;
    room->sortOrder = this->getMaxRoomOrder() + 1;
    this->isDirty = true;
  }
  return room;
}

SomfyGroup *SomfyShadeController::addGroup(JsonObject &obj) {
  SomfyGroup *group = this->addGroup();
  if(group) {
    group->fromJSON(obj);
    group->save();
    group->emitState("groupAdded");
  }
  return group;
}
SomfyGroup *SomfyShadeController::addGroup() {
  uint8_t groupId = this->getNextGroupId();
  // So the next shade id will be the first one we run into with an id of 255 so
  // if it gets deleted in the middle then it will get the first slot that is empty.
  // There is no apparent way around this.  In the future we might actually add an indexer
  // to it for sorting later.
  if(groupId == 255) return nullptr;
  SomfyGroup *group = &this->groups[groupId - 1];
  if(group) {
    group->setGroupId(groupId);
    group->sortOrder = this->getMaxGroupOrder() + 1;
    this->isDirty = true;
  }
  return group;
}
somfy_commands SomfyRemote::transformCommand(somfy_commands cmd) {
  if(this->flipCommands) {
    switch(cmd) {
      case somfy_commands::Up:
        return somfy_commands::Down;
      case somfy_commands::MyUp:
        return somfy_commands::MyDown;
      case somfy_commands::Down:
        return somfy_commands::Up;
      case somfy_commands::MyDown:
        return somfy_commands::MyUp;
      case somfy_commands::StepUp:
        return somfy_commands::StepDown;
      case somfy_commands::StepDown:
        return somfy_commands::StepUp;
      default:
        break;
    }
  }
  return cmd;
}
void SomfyRemote::sendSensorCommand(int8_t isWindy, int8_t isSunny, uint8_t repeat) {
  uint8_t flags = (this->flags >> 4) & 0x0F;
  if(isWindy > 0) flags |= 0x01;
  if(isSunny > 0) flags |= 0x02;
  if(isWindy == 0) flags &= ~0x01;
  if(isSunny == 0) flags &= ~0x02;

  // Now ship this off as an 80 bit command.
  this->lastFrame.remoteAddress = this->getRemoteAddress();
  this->lastFrame.repeats = repeat;
  this->lastFrame.bitLength = this->bitLength;
  this->lastFrame.rollingCode = (uint16_t)flags;
  this->lastFrame.encKey = 160; // Sensor commands are always encryption code 160.
  this->lastFrame.cmd = somfy_commands::Sensor;
  this->lastFrame.processed = false;
  Serial.print("CMD:");
  Serial.print(translateSomfyCommand(this->lastFrame.cmd));
  Serial.print(" ADDR:");
  Serial.print(this->lastFrame.remoteAddress);
  Serial.print(" RCODE:");
  Serial.print(this->lastFrame.rollingCode);
  Serial.print(" REPEAT:");
  Serial.println(repeat);
  somfy.sendFrame(this->lastFrame, repeat);
  somfy.processFrame(this->lastFrame, true);
}
void SomfyRemote::sendCommand(somfy_commands cmd) { this->sendCommand(cmd, this->repeats); }
void SomfyRemote::sendCommand(somfy_commands cmd, uint8_t repeat, uint8_t stepSize) {
  this->lastFrame.rollingCode = this->getNextRollingCode();
  this->lastFrame.remoteAddress = this->getRemoteAddress();
  this->lastFrame.cmd = this->transformCommand(cmd);
  this->lastFrame.repeats = repeat;
  this->lastFrame.bitLength = this->bitLength;
  this->lastFrame.stepSize = stepSize;
  this->lastFrame.valid = true;
  // Match the encKey to the rolling code.  These keys range from 160 to 175.
  this->lastFrame.encKey = 0xA0 | static_cast<uint8_t>(this->lastFrame.rollingCode & 0x000F);
  this->lastFrame.proto = this->proto;
  if(this->lastFrame.bitLength == 0) this->lastFrame.bitLength = somfy.transceiver.config.type;
  if(this->lastFrame.rollingCode == 0) Serial.println("ERROR: Setting rcode to 0");
  this->p_lastRollingCode(this->lastFrame.rollingCode);
  // We have to set the processed to clear this if we are sending
  // another command.
  this->lastFrame.processed = false;
  if(this->proto == radio_proto::GP_Relay) {
    Serial.print("CMD:");
    Serial.print(translateSomfyCommand(this->lastFrame.cmd));
    Serial.print(" ADDR:");
    Serial.print(this->lastFrame.remoteAddress);
    Serial.print(" RCODE:");
    Serial.print(this->lastFrame.rollingCode);
    Serial.println(" SETTING GPIO");
  }
  else if(this->proto == radio_proto::GP_Remote) {
    Serial.print("CMD:");
    Serial.print(translateSomfyCommand(this->lastFrame.cmd));
    Serial.print(" ADDR:");
    Serial.print(this->lastFrame.remoteAddress);
    Serial.print(" RCODE:");
    Serial.print(this->lastFrame.rollingCode);
    Serial.println(" TRIGGER GPIO");
    this->triggerGPIOs(this->lastFrame);
  }
  else {
    // Per-command TX logging allocates a String (translateSomfyCommand returns by value)
    // and can block on the serial buffer; multiplied by the 35 frames of a set-My and by
    // many shades starting at once it adds up in the hot path. Off by default; define
    // DEBUG_TX_FRAMES to restore it when diagnosing transmissions.
#ifdef DEBUG_TX_FRAMES
    Serial.print("CMD:");
    Serial.print(translateSomfyCommand(this->lastFrame.cmd));
    Serial.print(" ADDR:");
    Serial.print(this->lastFrame.remoteAddress);
    Serial.print(" RCODE:");
    Serial.print(this->lastFrame.rollingCode);
    Serial.print(" REPEAT:");
    Serial.println(repeat);
#endif
    somfy.sendFrame(this->lastFrame, repeat);
  }
  somfy.processFrame(this->lastFrame, true);
}
bool SomfyRemote::isLastCommand(somfy_commands cmd) {
  if(this->lastFrame.cmd != cmd || this->lastFrame.rollingCode != this->lastRollingCode) {
    Serial.printf("Not the last command %d: %d - %d\n", static_cast<uint8_t>(this->lastFrame.cmd), this->lastFrame.rollingCode, this->lastRollingCode);
    return false;
  }
  return true;
}
void SomfyRemote::repeatFrame(uint8_t repeat) {
  if(this->proto == radio_proto::GP_Relay)
    return;
  else if(this->proto == radio_proto::GP_Remote) {
    this->triggerGPIOs(this->lastFrame);
    return;
  }
  somfy.transceiver.beginTransmit();
  byte frm[10];
  this->lastFrame.encodeFrame(frm);
  this->lastFrame.repeats++;
  somfy.transceiver.sendFrame(frm, this->bitLength == 56 ? 2 : 12, this->bitLength);
  for(uint8_t i = 0; i < repeat; i++) {
    this->lastFrame.repeats++;
    if(this->lastFrame.bitLength == 80) this->lastFrame.encode80BitFrame(&frm[0], this->lastFrame.repeats);
    somfy.transceiver.sendFrame(frm, this->bitLength == 56 ? 7 : 6, this->bitLength);
    esp_task_wdt_reset();
  }
  somfy.transceiver.endTransmit();
  //somfy.processFrame(this->lastFrame, true);
}
void SomfyShadeController::sendFrame(somfy_frame_t &frame, uint8_t repeat) {
  byte frm[10];
  frame.encodeFrame(frm);
  const uint8_t firstSync = frame.bitLength == 56 ? 2 : 12;
  const uint8_t repeatSync = frame.bitLength == 56 ? 7 : 6;
  // Fully-synchronous contiguous send. Used for:
  //  - no repeats (nothing to offload),
  //  - hold/long-press commands (repeat >= TX_CONTIGUOUS_REPEATS: set-My, tilt holds, euromode)
  //    which the motor only registers from an uninterrupted frame train, and
  //  - the rare case where every queue slot is busy.
  // A brief loop freeze here is acceptable: set-My is a deliberate, infrequent action and holds
  // block the same way they always did. This path is byte-for-byte the original send.
  if(repeat == 0 || repeat >= TX_CONTIGUOUS_REPEATS || !this->transceiver.hasQueueSlot(frame.remoteAddress)) {
    this->transceiver.beginTransmit();
    this->transceiver.sendFrame(frm, firstSync, frame.bitLength);
    for(uint8_t i = 0; i < repeat; i++) {
      // For each 80-bit frame we need to adjust the byte encoding for the silence.
      if(frame.bitLength == 80) frame.encode80BitFrame(&frm[0], i + 1);
      this->transceiver.sendFrame(frm, repeatSync, frame.bitLength);
      esp_task_wdt_reset();
    }
    this->transceiver.endTransmit();
    return;
  }
  // Non-blocking path (approach a): transmit the first frame synchronously so the motor has
  // received a complete command by the time this returns -- the caller (processFrame, run right
  // after) anchors moveStart/startPos on this moment, so position tracking starts as it always
  // did. Only the repeat train is handed to the queue, to interleave with other shades'. The
  // first frame carries no trailing silence (false): that gap is scheduled before the first
  // queued repeat via nextSendAt. hasQueueSlot() was just checked, so queueRepeats() succeeds.
  this->transceiver.beginTransmit();
  this->transceiver.sendFrame(frm, firstSync, frame.bitLength, false);
  this->transceiver.endTransmit();
  this->transceiver.queueRepeats(frame, repeat);
}
bool SomfyShadeController::deleteShade(uint8_t shadeId) {
  for(uint8_t i = 0; i < SOMFY_MAX_SHADES; i++) {
    if(this->shades[i].getShadeId() == shadeId) {
      shades[i].emitState("shadeRemoved");
      shades[i].unpublish();
      this->shades[i].clear();
    }
  }
  #ifdef USE_NVS
  if(this->useNVS()) {
    for(uint8_t i = 0; i < sizeof(this->m_shadeIds) - 1; i++) {
      if(this->m_shadeIds[i] == shadeId) {
        this->m_shadeIds[i] = 255;
      }
    }
    
    sortArray<uint8_t>(this->m_shadeIds, sizeof(this->m_shadeIds));
    
    pref.begin("Shades");
    pref.putBytes("shadeIds", this->m_shadeIds, sizeof(this->m_shadeIds));
    pref.end();
  }
  #endif
  this->commit();
  return true;
}
bool SomfyShadeController::deleteRoom(uint8_t roomId) {
  for(uint8_t i = 0; i < SOMFY_MAX_ROOMS; i++) {
    if(this->rooms[i].roomId == roomId) {
      rooms[i].unpublish();
      for(uint8_t j = 0; j < SOMFY_MAX_SHADES; j++) {
        if(shades[j].roomId == roomId) {
          shades[j].roomId = 0;
          shades[j].emitState();
        }
      }
      for(uint8_t j = 0; j < SOMFY_MAX_GROUPS; j++) {
        if(groups[j].roomId == roomId) {
          groups[j].roomId = 0;
          groups[j].emitState();
        }
      }
      rooms[i].emitState("roomRemoved");
      this->rooms[i].clear();
    }
  }
  this->commit();
  return true;
}

bool SomfyShadeController::deleteGroup(uint8_t groupId) {
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPS; i++) {
    if(this->groups[i].getGroupId() == groupId) {
      groups[i].emitState("groupRemoved");
      groups[i].unpublish();
      this->groups[i].clear();
    }
  }
  this->commit();
  return true;
}

bool SomfyShadeController::loadShadesFile(const char *filename) { return ShadeConfigFile::load(this, filename); }
uint16_t SomfyRemote::getNextRollingCode() {
  pref.begin("ShadeCodes");
  uint16_t code = pref.getUShort(this->m_remotePrefId, 0);
  code++;
  pref.putUShort(this->m_remotePrefId, code);
  pref.end();
  this->p_lastRollingCode(code);
  //Serial.printf("Getting Next Rolling code %d\n", this->lastRollingCode);
  return code;
}
uint16_t SomfyRemote::p_lastRollingCode(uint16_t code) { 
  uint16_t old = this->lastRollingCode;
  this->lastRollingCode = code; 
  return old;
}
uint16_t SomfyRemote::setRollingCode(uint16_t code) {
  if(this->lastRollingCode != code) {
    pref.begin("ShadeCodes");
    pref.putUShort(this->m_remotePrefId, code);
    pref.end();  
    this->lastRollingCode = code;
    Serial.printf("Setting Last Rolling code %d\n", this->lastRollingCode);
  }
  return code;
}
void SomfyShadeController::toJSONRooms(JsonResponse &json) {
  for(uint8_t i = 0; i < SOMFY_MAX_ROOMS; i++) {
    SomfyRoom *room = &this->rooms[i];
    if(room->roomId != 0) {
      json.beginObject();
      room->toJSON(json);
      json.endObject();
    }
  }
}
void SomfyShadeController::toJSONShades(JsonResponse &json) { this->toJSONShades(json, true); }
void SomfyShadeController::toJSONShades(JsonResponse &json, bool includeSecrets) {
  for(uint8_t i = 0; i < SOMFY_MAX_SHADES; i++) {
    SomfyShade &shade = this->shades[i];
    if(shade.getShadeId() != 255) {
      json.beginObject();
      shade.toJSON(json, includeSecrets);
      json.endObject();
    }
  }
}

/*
bool SomfyShadeController::toJSON(DynamicJsonDocument &doc) {
  doc["maxRooms"] = SOMFY_MAX_ROOMS;
  doc["maxShades"] = SOMFY_MAX_SHADES;
  doc["maxGroups"] = SOMFY_MAX_GROUPS;
  doc["maxGroupedShades"] = SOMFY_MAX_GROUPED_SHADES;
  doc["maxLinkedRemotes"] = SOMFY_MAX_LINKED_REMOTES;
  doc["startingAddress"] = this->startingAddress;
  JsonObject objRadio = doc.createNestedObject("transceiver");
  this->transceiver.toJSON(objRadio);
  JsonArray arrRooms = doc.createNestedArray("rooms");
  this->toJSONRooms(arrRooms);
  JsonArray arrShades = doc.createNestedArray("shades");
  this->toJSONShades(arrShades);
  JsonArray arrGroups = doc.createNestedArray("groups");
  this->toJSONGroups(arrGroups);
  return true;
}
bool SomfyShadeController::toJSON(JsonObject &obj) {
  obj["maxShades"] = SOMFY_MAX_SHADES;
  obj["maxLinkedRemotes"] = SOMFY_MAX_LINKED_REMOTES;
  obj["startingAddress"] = this->startingAddress;
  JsonObject oradio = obj.createNestedObject("transceiver");
  this->transceiver.toJSON(oradio);
  JsonArray arrShades = obj.createNestedArray("shades");
  this->toJSONShades(arrShades);
  JsonArray arrGroups = obj.createNestedArray("groups");
  this->toJSONGroups(arrGroups);
  return true;
}


bool SomfyShadeController::toJSONShades(JsonArray &arr) {
  for(uint8_t i = 0; i < SOMFY_MAX_SHADES; i++) {
    SomfyShade &shade = this->shades[i];
    if(shade.getShadeId() != 255) {
      JsonObject oshade = arr.createNestedObject();
      shade.toJSON(oshade);
    }
  }
  return true;
}
bool SomfyShadeController::toJSONGroups(JsonArray &arr) {
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPS; i++) {
    SomfyGroup &group = this->groups[i];
    if(group.getGroupId() != 255) {
      JsonObject ogroup = arr.createNestedObject();
      group.toJSON(ogroup);
    }
  }
  return true;
}
*/
void SomfyShadeController::toJSONGroups(JsonResponse &json) { this->toJSONGroups(json, true); }
void SomfyShadeController::toJSONGroups(JsonResponse &json, bool includeSecrets) {
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPS; i++) {
    SomfyGroup &group = this->groups[i];
    if(group.getGroupId() != 255) {
      json.beginObject();
      group.toJSON(json, includeSecrets);
      json.endObject();
    }
  }
}
void SomfyShadeController::toJSONRepeaters(JsonResponse &json) {
  for(uint8_t i = 0; i < SOMFY_MAX_REPEATERS; i++) {
    if(somfy.repeaters[i] != 0) json.addElem((uint32_t)somfy.repeaters[i]);
  }
}
void SomfyShadeController::loop() {
  this->transceiver.loop();
  bool allIdle = true;
  for(uint8_t i = 0; i < SOMFY_MAX_SHADES; i++) {
    if(this->shades[i].getShadeId() != 255) {
      this->shades[i].checkMovement();
      this->shades[i].setGPIOs();
      if(!this->shades[i].isIdle()) allIdle = false;
    }
  }
  // Commit at most once per second, and not while a shade is travelling: the LittleFS
  // rewrite stalls the loop for tens of ms, which delays the STOP of any moving shade
  // and makes it overshoot. Defer until every shade is idle, with a 30 s cap so a shade
  // stuck in a moving state cannot postpone the write indefinitely (lastCommit is not
  // touched while deferring, so the cap measures the time since the last real commit).
  if(this->isDirty && millis() - this->lastCommit > 1000 &&
    (allIdle || millis() - this->lastCommit > 30000)) {
    this->commit();
  }
}
bool SomfyShadeController::allIdle() {
  for(uint8_t i = 0; i < SOMFY_MAX_SHADES; i++) {
    if(this->shades[i].getShadeId() != 255 && !this->shades[i].isIdle()) return false;
  }
  return true;
}
SomfyLinkedRemote::SomfyLinkedRemote() {}

