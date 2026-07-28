#include <Arduino.h>
#include <LittleFS.h>
#include <time.h>
#include "RfStats.h"

extern SomfyShadeController somfy;

// Passive RF statistics.  Every valid external RTS frame already decoded by the
// transceiver feeds record(); the table keeps one aggregate row per remote address.
// This deliberately measures the remote->ESP path only: RTS is unidirectional, so the
// ESP->motor path is never observable.  The stats are used by the RF diagnostics page
// to rank remotes by link quality and to spot drift over time.

void rf_stats_entry_t::clear() {
  this->address = 0;
  this->frames = 0;
  this->firstSeen = 0;
  this->lastSeen = 0;
  this->guidedAt = 0;
  this->rssiAvg = 0.0f;
  this->rssiEwma = 0.0f;
  this->rssiLast = 0;
  this->rssiMin = 0;
  this->rssiMax = 0;
  this->guidedRssi = 0;
  this->proto = 0;
}
void rf_stats_entry_t::toJSON(JsonFormatter &json) {
  json.addElem("address", this->address);
  json.addElem("proto", this->proto);
  json.addElem("frames", this->frames);
  json.addElem("firstSeen", this->firstSeen);
  json.addElem("lastSeen", this->lastSeen);
  json.addElem("last", this->rssiLast);
  json.addElem("min", this->rssiMin);
  json.addElem("max", this->rssiMax);
  json.addElem("avg", this->rssiAvg);
  json.addElem("recent", this->rssiEwma);
  json.addElem("guided", this->guidedRssi);
  json.addElem("guidedAt", this->guidedAt);
}
void rf_epoch_t::clear() {
  this->start = 0;
  this->seconds = 0;
  this->frames = 0;
  this->noiseCount = 0;
  this->noiseAvg = 0.0f;
  this->frequency = 0.0f;
  this->rxBandwidth = 0.0f;
  this->txPower = 0;
  this->decodeFloor = 0;
}
void rf_epoch_t::toJSON(JsonFormatter &json) {
  json.addElem("start", this->start);
  json.addElem("seconds", this->seconds);
  json.addElem("frames", this->frames);
  json.addElem("floor", this->decodeFloor);
  json.addElem("noiseAvg", this->noiseAvg);
  json.addElem("frequency", this->frequency);
  json.addElem("rxBandwidth", this->rxBandwidth);
  json.addElem("txPower", this->txPower);
}
rf_stats_entry_t *RfStats::findEntry(uint32_t address) {
  for(uint8_t i = 0; i < RF_STATS_MAX_ENTRIES; i++) {
    if(this->entries[i].address == address) return &this->entries[i];
  }
  return nullptr;
}
rf_stats_entry_t *RfStats::createEntry(uint32_t address) {
  rf_stats_entry_t *evict = nullptr;
  bool evictGuided = true;
  for(uint8_t i = 0; i < RF_STATS_MAX_ENTRIES; i++) {
    rf_stats_entry_t &e = this->entries[i];
    if(e.address == 0) { evict = &e; break; }
    // Full table: evict the least observed row, oldest last-seen on ties, so a
    // passing one-off remote cannot displace a well-established one.  Rows that
    // carry a guided measurement are a deliberate user action: only evict one
    // when every row is guided.
    bool guided = e.guidedRssi != 0;
    if(!evict
      || (evictGuided && !guided)
      || (guided == evictGuided
        && (e.frames < evict->frames
          || (e.frames == evict->frames && e.lastSeen < evict->lastSeen)))) {
      evict = &e;
      evictGuided = guided;
    }
  }
  if(evict) {
    evict->clear();
    evict->address = address;
  }
  return evict;
}
void RfStats::record(const somfy_frame_t &frame) {
  if(!frame.valid || frame.remoteAddress == 0) return;
  rf_stats_entry_t *e = this->findEntry(frame.remoteAddress);
  if(!e) e = this->createEntry(frame.remoteAddress);
  if(!e) return;
  int8_t rssi = (int8_t)constrain(frame.rssi, -127, 0);
  // time() never blocks (unlike getLocalTime) which matters in the receive path.
  time_t t = time(nullptr);
  uint32_t epoch = t >= (time_t)RF_STATS_MIN_EPOCH ? (uint32_t)t : 0;
  if(e->frames == 0) {
    e->rssiMin = e->rssiMax = e->rssiLast = rssi;
    e->rssiAvg = e->rssiEwma = (float)rssi;
    e->firstSeen = epoch;
  }
  else {
    if(rssi < e->rssiMin) e->rssiMin = rssi;
    if(rssi > e->rssiMax) e->rssiMax = rssi;
    e->rssiAvg += ((float)rssi - e->rssiAvg) / (float)(e->frames + 1);
    e->rssiEwma += ((float)rssi - e->rssiEwma) / 8.0f;
    e->rssiLast = rssi;
  }
  // Backfill timestamps recorded before the NTP sync (boot-time frames, epochs
  // started offline) as soon as the clock becomes valid.
  if(e->firstSeen == 0 && epoch) e->firstSeen = epoch;
  if(this->epochCur.start == 0 && epoch) this->epochCur.start = epoch;
  e->proto = static_cast<uint8_t>(frame.proto);
  if(epoch) e->lastSeen = epoch;
  if(e->frames < UINT32_MAX) e->frames++;
  // Epoch KPIs: frame count and decode floor validate a config change over time.
  if(this->epochCur.frames < UINT32_MAX) this->epochCur.frames++;
  if(this->epochCur.decodeFloor == 0 || rssi < this->epochCur.decodeFloor) this->epochCur.decodeFloor = rssi;
  this->dirty = true;
}
void RfStats::recordNoise(int rssi) {
  float v = (float)constrain(rssi, -127, 0);
  if(this->noiseSamples == 0) this->noiseEwma = this->noiseBaseline = v;
  else {
    this->noiseEwma += (v - this->noiseEwma) / RF_STATS_NOISE_ALPHA;
    this->noiseBaseline += (v - this->noiseBaseline) / RF_STATS_NOISE_BASELINE_ALPHA;
  }
  if(this->noiseSamples < UINT32_MAX) this->noiseSamples++;
  if(this->epochCur.noiseCount < UINT32_MAX) {
    this->epochCur.noiseCount++;
    this->epochCur.noiseAvg += (v - this->epochCur.noiseAvg) / (float)this->epochCur.noiseCount;
  }
  this->dirty = true;
}
bool RfStats::setGuided(uint32_t address, int rssi) {
  if(address == 0 || rssi >= 0 || rssi < -127) return false;
  rf_stats_entry_t *e = this->findEntry(address);
  if(!e) e = this->createEntry(address);
  if(!e) return false;
  e->guidedRssi = (int8_t)rssi;
  time_t t = time(nullptr);
  e->guidedAt = t >= (time_t)RF_STATS_MIN_EPOCH ? (uint32_t)t : 0;
  this->dirty = true;
  return true;
}
void RfStats::syncEpoch(float frequency, float rxBandwidth, int8_t txPower) {
  rf_epoch_t &c = this->epochCur;
  if(c.frequency != 0.0f
    && c.frequency == frequency && c.rxBandwidth == rxBandwidth && c.txPower == txPower) return;
  if(c.frequency != 0.0f) this->epochPrev = c;
  c.clear();
  c.frequency = frequency;
  c.rxBandwidth = rxBandwidth;
  c.txPower = txPower;
  time_t t = time(nullptr);
  c.start = t >= (time_t)RF_STATS_MIN_EPOCH ? (uint32_t)t : 0;
  this->dirty = true;
}
uint8_t RfStats::count() {
  uint8_t n = 0;
  for(uint8_t i = 0; i < RF_STATS_MAX_ENTRIES; i++)
    if(this->entries[i].address != 0) n++;
  return n;
}
uint32_t RfStats::totalFrames() {
  uint32_t n = 0;
  for(uint8_t i = 0; i < RF_STATS_MAX_ENTRIES; i++)
    if(this->entries[i].address != 0) n += this->entries[i].frames;
  return n;
}
void RfStats::begin() {
  this->load();
  LittleFS.remove(RF_STATS_TEMP_FILE);  // leftover from a save interrupted by a crash
  this->lastSave = millis();
  this->lastSecTick = millis();
  // Detect a config that changed while we were offline (NVS restore, manual edit):
  // the epoch stored in the stats file must match the active radio settings.
  transceiver_config_t &cfg = somfy.transceiver.config;
  this->syncEpoch(cfg.frequency, cfg.rxBandwidth, cfg.txPower);
}
void RfStats::loop() {
  while(millis() - this->lastSecTick >= 60000UL) {
    this->lastSecTick += 60000UL;
    this->epochCur.seconds += 60;
  }
  if(this->dirty && millis() - this->lastSave > RF_STATS_SAVE_INTERVAL) this->save();
}
void RfStats::end() {
  if(this->dirty) this->save();
}
bool RfStats::save() {
  // Stamp the attempt time first: a failing filesystem (full, error) must retry
  // on the next interval, not on every loop pass -- that would hammer the flash
  // and stall the receive path.
  this->lastSave = millis();
  File f = LittleFS.open(RF_STATS_TEMP_FILE, "w");
  if(!f) return false;
  // Raw struct dump: only ever read back by the same firmware on the same MCU, and the
  // header carries the struct sizes so a layout change simply invalidates the file.
  uint8_t hdr[7] = {'R', 'F', 'S', 2, (uint8_t)sizeof(rf_stats_entry_t), (uint8_t)sizeof(rf_epoch_t), this->count()};
  bool ok = f.write(hdr, sizeof(hdr)) == sizeof(hdr);
  if(ok) ok = f.write((uint8_t *)&this->noiseEwma, sizeof(float)) == sizeof(float);
  if(ok) ok = f.write((uint8_t *)&this->noiseBaseline, sizeof(float)) == sizeof(float);
  if(ok) ok = f.write((uint8_t *)&this->noiseSamples, sizeof(uint32_t)) == sizeof(uint32_t);
  if(ok) ok = f.write((uint8_t *)&this->epochCur, sizeof(rf_epoch_t)) == sizeof(rf_epoch_t);
  if(ok) ok = f.write((uint8_t *)&this->epochPrev, sizeof(rf_epoch_t)) == sizeof(rf_epoch_t);
  for(uint8_t i = 0; ok && i < RF_STATS_MAX_ENTRIES; i++) {
    if(this->entries[i].address == 0) continue;
    ok = f.write((uint8_t *)&this->entries[i], sizeof(rf_stats_entry_t)) == sizeof(rf_stats_entry_t);
  }
  f.close();
  if(!ok) {
    LittleFS.remove(RF_STATS_TEMP_FILE);
    return false;
  }
  // littlefs rename atomically replaces an existing destination; removing it
  // first would open a power-loss window with no data file at all.
  if(!LittleFS.rename(RF_STATS_TEMP_FILE, RF_STATS_FILE)) return false;
  this->dirty = false;
  return true;
}
bool RfStats::load() {
  for(uint8_t i = 0; i < RF_STATS_MAX_ENTRIES; i++) this->entries[i].clear();
  if(!LittleFS.exists(RF_STATS_FILE)) return false;
  File f = LittleFS.open(RF_STATS_FILE, "r");
  if(!f) return false;
  uint8_t hdr[7];
  bool ok = f.read(hdr, sizeof(hdr)) == sizeof(hdr)
    && hdr[0] == 'R' && hdr[1] == 'F' && hdr[2] == 'S'
    && hdr[3] == 2 && hdr[4] == (uint8_t)sizeof(rf_stats_entry_t)
    && hdr[5] == (uint8_t)sizeof(rf_epoch_t)
    && hdr[6] <= RF_STATS_MAX_ENTRIES;
  if(ok) ok = f.read((uint8_t *)&this->noiseEwma, sizeof(float)) == sizeof(float);
  if(ok) ok = f.read((uint8_t *)&this->noiseBaseline, sizeof(float)) == sizeof(float);
  if(ok) ok = f.read((uint8_t *)&this->noiseSamples, sizeof(uint32_t)) == sizeof(uint32_t);
  if(ok) ok = f.read((uint8_t *)&this->epochCur, sizeof(rf_epoch_t)) == sizeof(rf_epoch_t);
  if(ok) ok = f.read((uint8_t *)&this->epochPrev, sizeof(rf_epoch_t)) == sizeof(rf_epoch_t);
  if(ok) {
    for(uint8_t i = 0; i < hdr[6]; i++) {
      if(f.read((uint8_t *)&this->entries[i], sizeof(rf_stats_entry_t)) != sizeof(rf_stats_entry_t)) {
        ok = false;  // truncated body: distrust the whole file, not just this row
        break;
      }
    }
  }
  f.close();
  // Flash corruption that keeps the header intact can still poison the floats; a
  // NaN in an EWMA never recovers and breaks the JSON output (%f prints nan).
  if(ok) {
    if(!isfinite(this->noiseEwma) || !isfinite(this->noiseBaseline)) ok = false;
    if(!isfinite(this->epochCur.noiseAvg) || !isfinite(this->epochPrev.noiseAvg)) ok = false;
    for(uint8_t i = 0; ok && i < RF_STATS_MAX_ENTRIES; i++) {
      if(this->entries[i].address == 0) continue;
      if(!isfinite(this->entries[i].rssiAvg) || !isfinite(this->entries[i].rssiEwma)) ok = false;
    }
  }
  if(!ok) {
    // Unknown or stale layout: start fresh rather than trusting partial reads.
    this->noiseEwma = this->noiseBaseline = 0.0f;
    this->noiseSamples = 0;
    this->epochCur.clear();
    this->epochPrev.clear();
    for(uint8_t i = 0; i < RF_STATS_MAX_ENTRIES; i++) this->entries[i].clear();
  }
  this->dirty = false;
  return ok;
}
void RfStats::clear() {
  for(uint8_t i = 0; i < RF_STATS_MAX_ENTRIES; i++) this->entries[i].clear();
  this->noiseEwma = this->noiseBaseline = 0.0f;
  this->noiseSamples = 0;
  this->epochCur.clear();
  this->epochPrev.clear();
  LittleFS.remove(RF_STATS_FILE);
  LittleFS.remove(RF_STATS_TEMP_FILE);
  this->dirty = false;
  // Restart the epoch from the active config so KPI accumulation resumes immediately.
  transceiver_config_t &cfg = somfy.transceiver.config;
  this->syncEpoch(cfg.frequency, cfg.rxBandwidth, cfg.txPower);
}
static void restoreEpoch(rf_epoch_t &ep, JsonObject o) {
  if(o.isNull()) return;
  ep.start = o["start"] | 0UL;
  ep.seconds = o["seconds"] | 0UL;
  ep.frames = o["frames"] | 0UL;
  ep.decodeFloor = o["floor"] | 0;
  float avg = o["noiseAvg"] | 0.0f;
  ep.noiseAvg = isfinite(avg) ? avg : 0.0f;
  // The stored mean stays meaningful when sampling resumes only if the count is
  // plausible; the export does not carry it, so approximate from the duration.
  ep.noiseCount = ep.noiseAvg != 0.0f ? (ep.seconds / (RF_STATS_NOISE_INTERVAL / 1000UL)) : 0;
  ep.frequency = o["frequency"] | 0.0f;
  ep.rxBandwidth = o["rxBandwidth"] | 0.0f;
  ep.txPower = o["txPower"] | 0;
}
bool RfStats::restoreJSON(JsonObject &obj) {
  // Accepts exactly what /rfStats emits, so a saved export re-injects as-is.
  if(!obj.containsKey("entries")) return false;
  this->clear();
  float v = obj["noise"] | 0.0f;
  this->noiseEwma = isfinite(v) ? v : 0.0f;
  v = obj["noiseBaseline"] | 0.0f;
  this->noiseBaseline = isfinite(v) ? v : 0.0f;
  this->noiseSamples = obj["noiseSamples"] | 0UL;
  restoreEpoch(this->epochCur, obj["epoch"]);
  restoreEpoch(this->epochPrev, obj["epochPrev"]);
  uint8_t n = 0;
  for(JsonObject o : obj["entries"].as<JsonArray>()) {
    if(n >= RF_STATS_MAX_ENTRIES) break;
    uint32_t addr = o["address"] | 0UL;
    if(addr == 0) continue;
    rf_stats_entry_t &e = this->entries[n++];
    e.clear();
    e.address = addr;
    e.proto = o["proto"] | 0;
    e.frames = o["frames"] | 0UL;
    e.firstSeen = o["firstSeen"] | 0UL;
    e.lastSeen = o["lastSeen"] | 0UL;
    e.rssiLast = o["last"] | 0;
    e.rssiMin = o["min"] | 0;
    e.rssiMax = o["max"] | 0;
    float f = o["avg"] | 0.0f;
    e.rssiAvg = isfinite(f) ? f : 0.0f;
    f = o["recent"] | 0.0f;
    e.rssiEwma = isfinite(f) ? f : 0.0f;
    e.guidedRssi = o["guided"] | 0;
    e.guidedAt = o["guidedAt"] | 0UL;
  }
  this->dirty = true;
  return this->save();
}
void RfStats::toJSON(JsonFormatter &json) {
  json.addElem("remotes", this->count());
  json.addElem("frames", this->totalFrames());
  json.addElem("noise", this->noiseEwma);
  json.addElem("noiseBaseline", this->noiseBaseline);
  json.addElem("noiseSamples", this->noiseSamples);
  json.beginObject("epoch");
  this->epochCur.toJSON(json);
  json.endObject();
  json.beginObject("epochPrev");
  this->epochPrev.toJSON(json);
  json.endObject();
  json.beginArray("entries");
  for(uint8_t i = 0; i < RF_STATS_MAX_ENTRIES; i++) {
    if(this->entries[i].address == 0) continue;
    json.beginObject();
    this->entries[i].toJSON(json);
    json.endObject();
  }
  json.endArray();
}
