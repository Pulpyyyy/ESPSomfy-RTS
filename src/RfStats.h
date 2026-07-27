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
// through end().
#define RF_STATS_SAVE_INTERVAL 3600000UL
// Epochs below 2000-01-01 mean the clock has not been NTP-synced; store 0 so consumers
// can tell "unknown time" from a bogus 1970 date.
#define RF_STATS_MIN_EPOCH 946684800UL

// Incremental RSSI statistics for one observed remote address.  No frames are stored,
// only running aggregates, so the whole table costs ~1.3KB of RAM.
struct rf_stats_entry_t {
  uint32_t address = 0;    // 0 = free slot
  uint32_t frames = 0;     // frame samples, hardware repeats included
  uint32_t firstSeen = 0;  // epoch seconds, 0 when the clock was not set
  uint32_t lastSeen = 0;
  float rssiAvg = 0.0f;    // cumulative mean since first observation
  float rssiEwma = 0.0f;   // recent trend (alpha = 1/8) for drift detection
  int8_t rssiLast = 0;
  int8_t rssiMin = 0;
  int8_t rssiMax = 0;
  uint8_t proto = 0;       // radio_proto of the last frame
  void clear();
  void toJSON(JsonFormatter &json);
};
class RfStats {
  protected:
    rf_stats_entry_t entries[RF_STATS_MAX_ENTRIES];
    bool dirty = false;
    uint32_t lastSave = 0;
    rf_stats_entry_t *findEntry(uint32_t address);
    rf_stats_entry_t *createEntry(uint32_t address);
  public:
    void begin();
    void loop();
    void end();                             // save if dirty (graceful reboot path)
    void record(const somfy_frame_t &frame);
    uint8_t count();
    uint32_t totalFrames();
    bool save();
    bool load();
    void clear();                           // wipe the table and remove the file
    void toJSON(JsonFormatter &json);
};
#endif
