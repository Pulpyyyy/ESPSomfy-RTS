#ifndef TRANSCEIVER_H
#define TRANSCEIVER_H
#include "ConfigSettings.h"
#include "WResp.h"

// Radio layer declarations, split out of Somfy.h: the RTS protocol enums, the
// ISR receive/transmit structures, the frame codec and the CC1101 transceiver.
// Somfy.h includes this header, so existing includers are unaffected.

enum class radio_proto : byte { // Ordinal byte 0-255
  RTS = 0x00,
  RTW = 0x01,
  RTV = 0x02,
  GP_Relay = 0x08,
  GP_Remote = 0x09
};
enum class somfy_commands : byte {
    Unknown0 = 0x0,
    My = 0x1,
    Up = 0x2,
    MyUp = 0x3,
    Down = 0x4,
    MyDown = 0x5,
    UpDown = 0x6,
    MyUpDown = 0x7,
    Prog = 0x8,
    SunFlag = 0x9,
    Flag = 0xA,
    StepDown = 0xB,
    Toggle = 0xC,
    UnknownD = 0xD,
    Sensor = 0xE,
    RTWProto = 0xF, // RTW Protocol
    // Command extensions for 80 bit frames
    StepUp = 0x8B,
    Favorite = 0xC1,
    Stop = 0xF1
};

String translateSomfyCommand(const somfy_commands cmd);
somfy_commands translateSomfyCommand(const String& string);

#define MAX_TIMINGS 300
#define MAX_RX_BUFFER 3
#define MAX_TX_BUFFER 5

typedef enum {
    waiting_synchro = 0,
    receiving_data = 1,
    complete = 2
} t_status;

// No RSSI sampled for the frame in progress yet.
#define RX_RSSI_NONE (-32768)
struct somfy_rx_t {
    void clear() {
      this->status = t_status::waiting_synchro;
      this->bit_length = 56;
      this->cpt_synchro_hw = 0;
      this->cpt_bits = 0;
      this->previous_bit = 0;
      this->waiting_half_symbol = false;
      memset(this->payload, 0, sizeof(this->payload));
      memset(this->pulses, 0, sizeof(this->pulses));
      this->pulseCount = 0;
      this->rssi = RX_RSSI_NONE;
    }
    // status / cpt_synchro_hw are written by the IRAM receive ISR and polled by
    // the main loop, and pulseCount doubles as the slot-ownership flag shared
    // between the ISR (producer) and pop() (consumer), so all three must be
    // volatile to prevent the compiler from caching them across contexts.
    volatile t_status status;
    uint8_t bit_length = 56;
    volatile uint8_t cpt_synchro_hw = 0;
    uint8_t cpt_bits = 0;
    uint8_t previous_bit = 0;
    bool waiting_half_symbol;
    uint8_t payload[10];
    unsigned int pulses[MAX_TIMINGS];
    volatile uint16_t pulseCount = 0;
    // Strongest RSSI the loop sampled while this frame was on the air (the ISR
    // cannot talk SPI). Reading it at decode time measured the silence after
    // the frame instead.
    volatile int16_t rssi = RX_RSSI_NONE;
};
// A simple FIFO queue to hold rx buffers.  We are using
// a byte index to make it so we don't have to reorganize
// the storage each time we push or pop.
struct somfy_rx_queue_t {
  void init();
  // length and index[] are the shared bookkeeping mutated by the receive ISR
  // and the consumer loop; they are guarded by rxMux and marked volatile so the
  // unlocked pre-check in Transceiver::receive() always sees the current value.
  volatile uint8_t length = 0;
  volatile uint8_t index[MAX_RX_BUFFER];
  somfy_rx_t items[MAX_RX_BUFFER];
  void push(somfy_rx_t *rx);
  bool pop(somfy_rx_t *rx);
};
struct somfy_frame_t {
    bool valid = false;
    bool processed = false;
    bool synonym = false;
    radio_proto proto = radio_proto::RTS;
    int rssi = 0;
    byte lqi = 0x0;
    somfy_commands cmd;
    uint32_t remoteAddress = 0;
    uint16_t rollingCode = 0;
    uint8_t encKey = 0xA7;
    uint8_t checksum = 0;
    uint8_t hwsync = 0;
    uint8_t repeats = 0;
    uint32_t await = 0;
    uint8_t bitLength = 56;
    uint16_t pulseCount = 0;
    uint8_t stepSize = 0;
    void print();
    // header: the frame is still in clear (encodeFrame). Repeats re-encode only
    // bytes 7-9, on a buffer whose bytes 1-6 are already obfuscated.
    void encode80BitFrame(byte *frame, uint8_t repeat, bool header = false);
    byte calc80Checksum(byte b0, byte b1, byte b2);
    byte encode80Byte7(byte start, uint8_t repeat);
    void encodeFrame(byte *frame);
    void decodeFrame(byte* frame);
    void decodeFrame(somfy_rx_t *rx);
    bool isRepeat(somfy_frame_t &f);
    bool isSynonym(somfy_frame_t &f);
    void copy(somfy_frame_t &f);
};

// A transmission queued for the radio task (see Transceiver::queueCommand()).
enum class radio_job_kind_t : uint8_t { command = 0, raw = 1 };
struct radio_job_t {
  bool used = false;
  bool inFlight = false;      // the radio task is transmitting it right now
  bool firstSent = false;
  bool contiguous = false;    // hold/long press: the whole train in one go
  bool urgent = false;        // a stop: goes before the other first frames
  bool cancelRepeats = false; // superseded by a newer order of the same remote
  radio_job_kind_t kind = radio_job_kind_t::command;
  uint32_t id = 0;
  uint32_t remoteAddress = 0;
  somfy_frame_t frame;        // 80-bit repeats re-encode bytes 7-9 per ordinal
  byte encoded[10] = {};
  uint8_t bitLength = 56;
  uint8_t firstSync = 2;
  uint8_t repeatSync = 7;
  uint8_t repeatsLeft = 0;
  uint8_t ordinal = 1;
  uint16_t gapMs = 0;         // quiet required after this remote's previous first frame
  uint32_t enqueuedAt = 0;
  uint32_t notBefore = 0;     // millis(): earliest first frame
  uint32_t nextSendAt = 0;    // millis(): earliest next repeat
  uint32_t lbtSince = 0;      // millis() the channel was first found busy for it
};
// Reported by the radio task when a command's first frame has gone out.
struct radio_tx_event_t {
  uint32_t jobId = 0;
  uint32_t firstFrameEnd = 0;
};
struct radio_tx_stats_t {
  uint32_t jobs = 0;          // orders queued
  uint32_t frames = 0;        // frames transmitted
  uint32_t lbtDeferred = 0;   // orders that waited for a busy channel
  uint32_t lbtRx = 0;         // ...behind RTS traffic being received
  uint32_t lbtCarrier = 0;    // ...behind an undecoded carrier
  uint32_t lbtForced = 0;     // ...and went anyway once the wait hit its cap
  uint32_t dropped = 0;       // orders lost to a full queue
  uint32_t delayLast = 0;     // ms from an order to the end of its first frame
  uint32_t delayMax = 0;
};
// RSSI read for the receive path, which must not talk to the radio while the
// radio task transmits: 0 when the radio is busy.
int radioReadRssi();

struct transceiver_config_t {
    bool printBuffer = false;
    bool enabled = false;
    uint8_t type = 56;                // 56 or 80 bit protocol..
    uint8_t radioBoardType;
    radio_proto proto = radio_proto::RTS;
    uint8_t SCKPin = 18;
    uint8_t TXPin = 13;
    uint8_t RXPin = 12;
    uint8_t MOSIPin = 23;
    uint8_t MISOPin = 19;
    uint8_t CSNPin = 5;
    bool radioInit = false;
    float frequency = 433.42;         // Basic frequency
    float deviation = 47.60;          // Set the Frequency deviation in kHz. Value from 1.58 to 380.85. Default is 47.60 kHz.
    float rxBandwidth = 99.97;        // Receive bandwidth in kHz.  Value from 58.03 to 812.50.  Default is 99.97kHz.
    int8_t txPower = 10;              // Transmission power {-30, -20, -15, -10, -6, 0, 5, 7, 10, 11, 12}.  Default is 12.
/*    
    bool internalCCMode = false;      // Use internal transmission mode FIFO buffers.
    byte modulationMode = 2;          // Modulation mode. 0 = 2-FSK, 1 = GFSK, 2 = ASK/OOK, 3 = 4-FSK, 4 = MSK.
    uint8_t channel = 0;              // The channel number from 0 to 255
    float channelSpacing = 199.95;    // Channel spacing in multiplied by the channel number and added to the base frequency in kHz. 25.39 to 405.45.  Default 199.95
    float dataRate = 99.97;           // The data rate in kBaud.  0.02 to 1621.83 Default is 99.97.
    uint8_t syncMode = 0;             // 0=No preamble/sync, 
    // 1=16 sync word bits detected, 
    // 2=16/16 sync words bits detected. 
    // 3=30/32 sync word bits detected, 
    // 4=No preamble/sync carrier above threshold
    // 5=15/16 + carrier above threshold. 
    // 6=16/16 + carrier-sense above threshold
    // 7=0/32 + carrier-sense above threshold
    uint16_t syncWordHigh = 211;      // The sync word used to the sync mode.
    uint16_t syncWordLow = 145;       // The sync word used to the sync mode.
    uint8_t addrCheckMode = 0;        // 0=No address filtration
    // 1=Check address without broadcast.
    // 2=Address check with 0 as broadcast.
    // 3=Address check with 0 or 255 as broadcast.
    uint8_t checkAddr = 0;            // Packet filter address depending on addrCheck settings.
    bool dataWhitening = false;       // Indicates whether data whitening should be applied.
    uint8_t pktFormat = 0;            // 0=Use FIFO buffers form RX and TX
    // 1=Synchronous serial mode.  RX on GDO0 and TX on either GDOx pins.
    // 2=Random TX mode.  Send data using PN9 generator.
    // 3=Asynchronous serial mode.  RX on GDO0 and TX on either GDOx pins.
    uint8_t pktLengthMode = 0;        // 0=Fixed packet length
    // 1=Variable packet length
    // 2=Infinite packet length
    // 3=Reserved
    uint8_t pktLength = 0;            // Packet length
    bool useCRC = false;              // Indicates whether CRC is to be used.
    bool autoFlushCRC = false;        // Automatically flush RX FIFO when CRC fails.  If more than one packet is in the buffer it too will be flushed.
    bool disableDCFilter = false;     // Digital blocking filter for demodulator.  Only for data rates <= 250k.
    bool enableManchester = true;     // Enable/disable Manchester encoding.
    bool enableFEC = false;           // Enable/disable forward error correction.
    uint8_t minPreambleBytes = 0;     // The minimum number of preamble bytes to be transmitten.
    // 0=2bytes
    // 1=3bytes
    // 2=4bytes
    // 3=6bytes
    // 4=8bytes
    // 5=12bytes
    // 6=16bytes
    // 7=24bytes
    uint8_t pqtThreshold = 0;         // Preamble quality estimator threshold.  The preable quality estimator increase an internal counter by one each time a bit is received that is different than the prevoius bit and
    // decreases the bounter by 8 each time a bit is received that is the same as the lats bit.  A threshold of 4 PQT for this counter is used to gate sync word detection.  
    // When PQT = 0 a sync word is always accepted.
    bool appendStatus = false;        // Appends the RSSI and LQI values to the TX packed as well as the CRC.
 */
    void fromJSON(JsonObject& obj);
    //void toJSON(JsonObject& obj);
    void toJSON(JsonResponse& json);
    void save();
    void load();
    void apply();
    void removeNVSKey(const char *key);
};
class Transceiver {
  private:
    static void handleReceive();
    bool _received = false;
    somfy_frame_t frame;
  public:
    transceiver_config_t config;
    bool printBuffer = false;
    //bool toJSON(JsonObject& obj);
    void toJSON(JsonResponse& json);
    bool fromJSON(JsonObject& obj);
    bool save();
    bool begin();
    void loop();
    bool end();
    bool receive(somfy_rx_t *rx);
    void clearReceived();
    void enableReceive();
    void disableReceive();
    somfy_frame_t& lastFrame();
    // Radio task only. interFrameGap keeps the ~27ms trailing silence that separates the
    // frames of a contiguous train; queued repeats get their gap between transmissions.
    void sendFrame(byte *frame, uint8_t sync, uint8_t bitLength = 56, bool interFrameGap = true);
    void beginTransmit();
    void endTransmit();
    // Transmit queue, drained by the radio task. Callers hold SomfyGuard; the
    // calls return at once (a full queue waits up to 3s, then drops the order).
    // queueCommand() returns the job id, also left in lastQueuedJob for the
    // shades that anchor their movement on it, or 0 when nothing was queued.
    uint32_t queueCommand(somfy_frame_t &frame, uint8_t repeats);
    uint32_t queueContinuation(somfy_frame_t &frame, uint8_t repeats);
    void queueRaw(uint8_t hwsync, byte *payload, uint8_t bitLength);
    uint32_t lastQueuedJob = 0;
    bool popTxEvent(radio_tx_event_t &evt);
    bool txIdle();
    void suspendTx();
    void resumeTx();
    void txStatsToJSON(JsonResponse &json);
    bool radioStep();      // radio task: transmits at most one frame or train
    void emitFrame(somfy_frame_t *frame, somfy_rx_t *rx = nullptr);
    void beginFrequencyScan();
    void endFrequencyScan();
    void processFrequencyScan(bool received = false);
    void emitFrequencyScan(uint8_t num = 255);
    bool usesPin(uint8_t pin);
};
#endif
