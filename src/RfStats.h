#include <Arduino.h>
#include "Somfy.h"
#include "JsonFormatter.h"

#ifndef rfstats_h
#define rfstats_h

#define RF_STATS_MAX_ENTRIES 48
#define RF_STATS_FILE "/rfstats.dat"
#define RF_STATS_TEMP_FILE "/rfstats.tmp"
// Persist at most once per hour.  The table lives in RAM and only matters over weeks of
// observations, so losing up to an hour on a hard reset is fine; a graceful reboot saves
// through end().  Noise sampling marks the state dirty every 10s, so in practice this IS
// one write per hour whenever the radio is enabled: ~24 flash writes/day of a ~2KB file,
// deliberate and far below LittleFS wear-leveled endurance.
#define RF_STATS_SAVE_INTERVAL 3600000UL
// Epochs below 2000-01-01 mean the clock has not been NTP-synced; store 0 so consumers
// can tell "unknown time" from a bogus 1970 date.
#define RF_STATS_MIN_EPOCH 946684800UL
// Idle noise floor is sampled every 10s from the receive loop.  The fast EWMA
// (1/90 ~ 15min) answers "is something jamming right now"; the slow baseline
// (1/8640 ~ 24h of samples) is what drift gets compared against.
#define RF_STATS_NOISE_INTERVAL 10000UL
#define RF_STATS_NOISE_ALPHA 90.0f
#define RF_STATS_NOISE_BASELINE_ALPHA 8640.0f

// Incremental RSSI statistics for one observed remote address.  No frames are stored,
// only running aggregates, so the whole table costs ~1.3KB of RAM.
struct rf_stats_entry_t {
  uint32_t address = 0;    // 0 = free slot
  uint32_t frames = 0;     // frame samples, hardware repeats included
  uint32_t firstSeen = 0;  // epoch seconds, 0 when the clock was not set
  uint32_t lastSeen = 0;
  uint32_t guidedAt = 0;   // when the guided measurement was taken (0 = never)
  float rssiAvg = 0.0f;    // cumulative mean since first observation
  float rssiEwma = 0.0f;   // recent trend (alpha = 1/8) for drift detection
  int8_t rssiLast = 0;
  int8_t rssiMin = 0;
  int8_t rssiMax = 0;
  // RSSI measured with the remote held NEXT TO ITS SHADE (guided session).  By antenna
  // reciprocity this approximates the ESP->motor path where passive samples only
  // reflect wherever the remote happens to be pressed from.  0 = not measured.
  int8_t guidedRssi = 0;
  uint8_t proto = 0;       // radio_proto of the last frame
  void clear();
  void toJSON(JsonFormatter &json);
};
// One radio-config "epoch": the KPIs accumulated while a given (frequency,
// bandwidth, txPower) tuple was active.  Keeping the previous epoch alongside the
// current one gives the before/after comparison that validates a config change.
struct rf_epoch_t {
  uint32_t start = 0;       // epoch seconds when this config became active (0 = clock unknown)
  uint32_t seconds = 0;     // active seconds accumulated under this config
  uint32_t frames = 0;      // frames decoded under this config
  uint32_t noiseCount = 0;
  float noiseAvg = 0.0f;    // running mean of the idle noise floor (0 = no sample yet)
  float frequency = 0.0f;   // 0 = epoch slot unused
  float rxBandwidth = 0.0f;
  int8_t txPower = 0;
  int8_t decodeFloor = 0;   // weakest RSSI decoded (0 = none yet)
  void clear();
  void toJSON(JsonFormatter &json);
};
class RfStats {
  protected:
    rf_stats_entry_t entries[RF_STATS_MAX_ENTRIES];
    rf_epoch_t epochCur;
    rf_epoch_t epochPrev;
    float noiseEwma = 0.0f;      // fast EWMA of the idle noise floor
    float noiseBaseline = 0.0f;  // slow EWMA, the long-term reference
    uint32_t noiseSamples = 0;
    bool dirty = false;
    uint32_t lastSave = 0;
    uint32_t lastSecTick = 0;
    rf_stats_entry_t *findEntry(uint32_t address);
    rf_stats_entry_t *createEntry(uint32_t address);
  public:
    void begin();
    void loop();
    void end();                             // save if dirty (graceful reboot path)
    void record(const somfy_frame_t &frame);
    void recordNoise(int rssi);             // idle-channel RSSI sample (no frame on air)
    bool setGuided(uint32_t address, int rssi);  // store a guided-session measurement
    // Roll the epoch when the active radio config actually changed; no-op otherwise.
    void syncEpoch(float frequency, float rxBandwidth, int8_t txPower);
    uint8_t count();
    uint32_t totalFrames();
    bool save();
    bool load();
    void clear();                           // wipe the table and remove the file
    void toJSON(JsonFormatter &json);
};
#endif
