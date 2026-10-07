#include <Preferences.h>
#include <ELECHOUSE_CC1101_SRC_DRV.h>
#include <SPI.h>
#include <WebServer.h>
#include <esp_task_wdt.h>
#include "Utils.h"
#include "ConfigSettings.h"
#include "Somfy.h"
#include "Sockets.h"
#include "RfStats.h"

// Radio hardware implementation, split out of Somfy.cpp: CC1101 configuration,
// the RTS receive ISR with its queues, the frequency scan, and the blocking +
// non-blocking transmit paths.  The class declarations stay in Somfy.h.

extern Preferences pref;
extern SomfyShadeController somfy;
extern SocketEmitter sockEmit;
extern RfStats rfStats;

uint8_t rxmode = 0;  // Indicates whether the radio is in receive mode.  Just to ensure there isn't more than one interrupt hooked.
#define SYMBOL 640
#if defined(ESP8266)
    #define RECEIVE_ATTR ICACHE_RAM_ATTR
#elif defined(ESP32)
    #define RECEIVE_ATTR IRAM_ATTR
#else
    #define RECEIVE_ATTR
#endif

#define TX_QUEUE_DELAY 100
// Air gap left between two repeat frames on the non-blocking path. It replaces the ~27ms
// trailing silence that Transceiver::sendFrame() used to spin on for 56-bit frames, only now it
// is real loop time. Motors tolerate a wide inter-frame gap (the repeater path uses
// TX_QUEUE_DELAY=100ms) and interleaving several shades widens each one's effective spacing, so
// this only needs to be a floor.
#define TX_REPEAT_GAP 30
// Minimum silence between ANY two frames on the air, whichever shade they belong to. The RTS
// inter-frame silence measures ~27.5ms and the motors rely on it to delimit frames.
// TX_REPEAT_GAP only spaces frames of the SAME job, so with two or more shades transmitting
// (interleaved repeat trains, or a burst of commands each sending its first frame straight off
// the mutex handoff) frames used to follow each other within loop-pass time -- a wall of RF a
// motor can fail to decode, leaving the shade still while the ESP dead-reckons it as moving.
// The queue drain checks this floor without blocking; beginTransmit() waits it out (bounded)
// for the synchronous sends.
#define TX_FRAME_SILENCE 35

static int interruptPin = 0;
// Default TX bit length, refreshed from the radio config by transceiver_config_t::apply().
static uint8_t bit_length = 56;

// Transceiver Implementation
#define TOLERANCE_MIN 0.7
#define TOLERANCE_MAX 1.3

static const uint32_t tempo_wakeup_pulse = 9415;
static const uint32_t tempo_wakeup_min = 9415 * TOLERANCE_MIN;
static const uint32_t tempo_wakeup_max = 9415 * TOLERANCE_MAX;
static const uint32_t tempo_wakeup_silence = 89565;
static const uint32_t tempo_wakeup_silence_min = 89565 * TOLERANCE_MIN;
static const uint32_t tempo_wakeup_silence_max = 89565 * TOLERANCE_MAX;
static const uint32_t tempo_synchro_hw_min = SYMBOL * 4 * TOLERANCE_MIN;
static const uint32_t tempo_synchro_hw_max = SYMBOL * 4 * TOLERANCE_MAX;
static const uint32_t tempo_synchro_sw_min = 4850 * TOLERANCE_MIN;
static const uint32_t tempo_synchro_sw_max = 4850 * TOLERANCE_MAX;
static const uint32_t tempo_half_symbol_min = SYMBOL * TOLERANCE_MIN;
static const uint32_t tempo_half_symbol_max = SYMBOL * TOLERANCE_MAX;
static const uint32_t tempo_symbol_min = SYMBOL * 2 * TOLERANCE_MIN;
static const uint32_t tempo_symbol_max = SYMBOL * 2 * TOLERANCE_MAX;
static const uint32_t tempo_if_gap = 30415;  // Gap between frames


static int16_t  bitMin = SYMBOL * TOLERANCE_MIN;
static somfy_rx_t somfy_rx;
static somfy_rx_queue_t rx_queue;
// Millis() at the end of the last frame received; the radio task keeps quiet
// for RADIO_RX_HOLDOFF after it (a remote held down repeats every ~27ms).
static volatile uint32_t lastRxFrameEnd = 0;
// micros() of the last edge the receive ISR saw, glitches included.
static volatile uint32_t lastRxEdgeUs = 0;
// End of the last frame's data on the air (stamped before any spun trailing silence), the
// reference point TX_FRAME_SILENCE is measured from.
static uint32_t lastTxEnd = 0;
// Guards the rx_queue handoff between the IRAM receive ISR (producer) and the
// main loop (consumer).  Only the small bookkeeping (length + index[]) is held
// under this spinlock; the ~1.2KB per-frame copy is always done outside it.
static portMUX_TYPE rxMux = portMUX_INITIALIZER_UNLOCKED;
// Bumped by the ISR whenever the frame in progress ends (queued or abandoned),
// so an RSSI sample taken across that boundary is not credited to the next one.
static volatile uint8_t rxFrameSeq = 0;

// ---------------------------------------------------------------------------
// Radio task.
//
// Every transmission is queued and sent by a task pinned to core 1, so the
// HTTP, MQTT and socket handlers only queue an order and answer at once, and
// the bit-banged frames run away from the WiFi stack on core 0. The task owns
// the radio while it transmits (g_radioLock), never takes the shared-state
// lock (SomfyGuard), and reports each command's first frame back to the loop
// (popTxEvent) so position tracking starts when the motor heard the order.
//
// It listens before talking: RTS has no acknowledgement and two overlapping
// frames are both lost, so it waits while a frame is being received, for
// RADIO_RX_HOLDOFF after one, and while the RSSI says the channel is busy --
// each wait capped, so a stuck channel cannot hold an order forever.
// ---------------------------------------------------------------------------
#define RADIO_MAX_JOBS 16
#define RADIO_RX_HOLDOFF 150         // ms of quiet after a received frame
#define RADIO_LBT_MAX_RX 3000        // longest wait behind decoded RTS traffic
#define RADIO_LBT_MAX_URGENT 500     // ... for a stop
#define RADIO_LBT_MAX_CARRIER 500    // longest wait behind an undecoded carrier
#define RADIO_CARRIER_MARGIN 10.0f   // dB over the noise baseline that means busy
#define RADIO_RX_EDGE_TIMEOUT_US 20000 // a frame in progress has an edge at least every ~2.6ms
#define RADIO_TX_SETTLE 50           // ms after our own frame before the RSSI is trusted
#define RADIO_SAME_REMOTE_GAP 200    // ms after a remote's first frame before its next order
#define RADIO_AIRTIME_BUDGET 300000  // ms per hour, under the 10% (360s) duty cycle
#define RADIO_TASK_PRIORITY 2        // above loop() (1): the bit timing is not preempted by it
static SemaphoreHandle_t g_radioLock = nullptr; // recursive: the CC1101 and the RX interrupt
static SemaphoreHandle_t g_jobLock = nullptr;   // the job table
static QueueHandle_t g_txEvents = nullptr;
static TaskHandle_t g_radioTask = nullptr;
static radio_job_t g_jobs[RADIO_MAX_JOBS];
static uint32_t g_nextJobId = 1;
static volatile bool g_txSuspended = false;
static volatile bool g_scanAbortRequested = false;
static radio_tx_stats_t g_txStats;
static uint32_t g_airtime[60] = {};             // ms on the air per minute, last hour
static uint32_t g_airtimeMinute = 0;
// The radio lock, held around every CC1101 access. wait 0 tries once.
class RadioGuard {
  private:
    bool _held;
  public:
    explicit RadioGuard(TickType_t wait = portMAX_DELAY)
      : _held(g_radioLock != nullptr && xSemaphoreTakeRecursive(g_radioLock, wait) == pdTRUE) {}
    ~RadioGuard() { if(this->_held) xSemaphoreGiveRecursive(g_radioLock); }
    // Before Transceiver::begin() there is no lock and nothing else to contend with.
    bool held() const { return this->_held || g_radioLock == nullptr; }
};
void somfy_rx_queue_t::init() { 
  Serial.println("Initializing RX Queue");
  for (uint8_t i = 0; i < MAX_RX_BUFFER; i++)
    this->items[i].clear();
  // index[] is volatile now, so assign element-wise instead of memset().
  for (uint8_t i = 0; i < MAX_RX_BUFFER; i++)
    this->index[i] = 255;
  this->length = 0;
}
bool somfy_rx_queue_t::pop(somfy_rx_t *rx) {
  // Read off the data from the oldest index.
  //Serial.println("Popping RX Queue");
  // Claim the oldest queued slot under the spinlock.  Only the small bookkeeping
  // (length + index[]) runs under the lock; we detach the slot from index[] but
  // leave items[ndx].pulseCount != 0 so the ISR's free-slot scan will not reuse
  // it while we copy it out below.
  uint8_t ndx = 255;
  portENTER_CRITICAL(&rxMux);
  for(int8_t i = MAX_RX_BUFFER - 1; i >= 0; i--) {
    if(this->index[i] < MAX_RX_BUFFER) {
      ndx = this->index[i];
      if(this->length > 0) this->length--;
      this->index[i] = 255;
      break;
    }
  }
  portEXIT_CRITICAL(&rxMux);
  if(ndx >= MAX_RX_BUFFER) return false;
  // Bulk copy happens unlocked: the slot is no longer referenced by index[] and
  // still marked in use (pulseCount != 0), so neither the ISR nor a concurrent
  // pop can touch it.  This keeps the ~1.2KB copy out of the critical section.
  memcpy(rx, &this->items[ndx], sizeof(somfy_rx_t));
  // Return the slot to the free pool.  clear() writes pulseCount = 0 last, which
  // is the single point that hands the slot back to the ISR's free-slot scan.
  this->items[ndx].clear();
  return true;
}

void Transceiver::sendFrame(byte *frame, uint8_t sync, uint8_t bitLength, bool interFrameGap) {
  if(!this->config.enabled) return;
  uint32_t pin = 1 << this->config.TXPin;
  if (sync == 2 || sync == 12) {  // Only with the first frame.  Repeats do not get a wakeup pulse.
    // All information online for the wakeup pulse appears to be incorrect.  While there is a wakeup
    // pulse it only sends an initial pulse.  There is no further delay after this.
    
    // Wake-up pulse
    //Serial.printf("Sending wakeup pulse: %d\n", sync);
    REG_WRITE(GPIO_OUT_W1TS_REG, pin);
    delayMicroseconds(10920);
    //delayMicroseconds(9415);
    
    // There is no silence after the wakeup pulse.  I tested this with Telis and no silence
    // was detected.  I suspect that for some battery powered shades the shade would go back
    // to sleep from the time of the initial pulse while the silence was occurring.
    REG_WRITE(GPIO_OUT_W1TC_REG, pin);
    delayMicroseconds(7357);
    //delayMicroseconds(9565);
    //delay(80);
  }
  // Depending on the bitness of the protocol we will be sending a different hwsync.
  // 56-bit 2 pulses for the first frame and 7 for the repeats
  // 80-bit 24 pulses for the first frame and 14 pulses for the repeats
  for (int i = 0; i < sync; i++) {
    REG_WRITE(GPIO_OUT_W1TS_REG, pin);
    delayMicroseconds(4 * SYMBOL);
    REG_WRITE(GPIO_OUT_W1TC_REG, pin);
    delayMicroseconds(4 * SYMBOL);
  }
  // Software sync
  REG_WRITE(GPIO_OUT_W1TS_REG, pin);
  //delayMicroseconds(4450); -- Initial timing.
  delayMicroseconds(4850);
  // Start 0
  REG_WRITE(GPIO_OUT_W1TC_REG, pin);
  delayMicroseconds(SYMBOL);
  // Payload starting with the most significant bit.  The frame is always supplied in 80 bits
  // but if the protocol is calling for 56 bits it will only send 56 bits of the frame.
  uint8_t last_bit = 0;
  for (byte i = 0; i < bitLength; i++) {
    if (((frame[i / 8] >> (7 - (i % 8))) & 1) == 1) {
      REG_WRITE(GPIO_OUT_W1TC_REG, pin);
      delayMicroseconds(SYMBOL);
      REG_WRITE(GPIO_OUT_W1TS_REG, pin);
      delayMicroseconds(SYMBOL);
      last_bit = 1;
    } else {
      REG_WRITE(GPIO_OUT_W1TS_REG, pin);
      delayMicroseconds(SYMBOL);
      REG_WRITE(GPIO_OUT_W1TC_REG, pin);
      delayMicroseconds(SYMBOL);
      last_bit = 0;
    }
  }
  // End with a 0 no matter what.  This accommodates the 56-bit protocol by telling the
  // motor that there are no more follow on bits.
  if(last_bit == 0) {
    REG_WRITE(GPIO_OUT_W1TS_REG, pin);
    //delayMicroseconds(SYMBOL);
  }
    
  // Inter-frame silence for 56-bit protocols are around 34ms.  However, an 80 bit protocol should
  // reduce this by the transmission of SYMBOL * 24 or 15,360us
  REG_WRITE(GPIO_OUT_W1TC_REG, pin);
  // Stamp the end of the data before any spun silence so that silence counts toward the
  // TX_FRAME_SILENCE floor the next transmission has to respect.
  lastTxEnd = millis();
  // Below are the original calculations for inter-frame silence.  However, when actually inspecting this from
  // the remote it appears to be closer to 27500us.  The delayMicoseconds call cannot be called with
  // values larger than 16383.
  // Skipped on the non-blocking repeat path (interFrameGap == false): the gap between frames is
  // scheduled between loop passes there instead of being spun on here.
  if(interFrameGap && bitLength != 80) {
    delayMicroseconds(13717);
    delayMicroseconds(13717);
  }
}
void RECEIVE_ATTR Transceiver::handleReceive() {
    static unsigned long last_time = 0;
    const long time = micros();
    lastRxEdgeUs = time;
    const unsigned int duration = time - last_time;
    if (duration < bitMin) {
        // The incoming bit is < 448us so it is probably a glitch so blow it off.
        // We need to ignore this bit.
        // REMOVE THIS AFTER WE DETERMINE THAT THE out-of-bounds stuff isn't a problem.  If there are bits
        // from the previous frame then we will capture this data here.
        if(somfy_rx.pulseCount < MAX_TIMINGS && somfy_rx.cpt_synchro_hw > 0) somfy_rx.pulses[somfy_rx.pulseCount++] = duration;
        return;
    }
    last_time = time;
    switch (somfy_rx.status) {
    case waiting_synchro:
        if(somfy_rx.pulseCount < MAX_TIMINGS) somfy_rx.pulses[somfy_rx.pulseCount++] = duration;
        if (duration > tempo_synchro_hw_min && duration < tempo_synchro_hw_max) {
            // We have found a hardware sync bit.  There should be at least 4 of these.
            ++somfy_rx.cpt_synchro_hw;
        }
        else if (duration > tempo_synchro_sw_min && duration < tempo_synchro_sw_max && somfy_rx.cpt_synchro_hw >= 4) {
            // If we have a full hardware sync then we should look for the software sync.  If we have a software sync
            // bit and enough hardware sync bits then we should start receiving data.  It turns out that a 56 bit packet
            // with give 4 or 14 bits of hardware sync.  An 80 bit packet gives 12, 13 or 24 bits of hw sync.  Early on
            // I had some shorter and longer hw syncs but I can no longer repeat this.
            memset(somfy_rx.payload, 0x00, sizeof(somfy_rx.payload));
            somfy_rx.previous_bit = 0x00;
            somfy_rx.waiting_half_symbol = false;
            somfy_rx.cpt_bits = 0;
            // Keep an eye on this as it is possible that we might get fewer or more synchro bits.
            if (somfy_rx.cpt_synchro_hw <= 7) somfy_rx.bit_length = 56;
            else if (somfy_rx.cpt_synchro_hw == 14) somfy_rx.bit_length = 56;
            else if (somfy_rx.cpt_synchro_hw == 13) somfy_rx.bit_length = 80; // The RS485 device sends this sync.
            else if (somfy_rx.cpt_synchro_hw == 12) somfy_rx.bit_length = 80;
            else if (somfy_rx.cpt_synchro_hw > 17) somfy_rx.bit_length = 80;
            else somfy_rx.bit_length = 56;
            //somfy_rx.bit_length = 80;
            somfy_rx.status = receiving_data;
        }
        else {
            // Reset and start looking for hardware sync again.
            somfy_rx.cpt_synchro_hw = 0;
            somfy_rx.rssi = RX_RSSI_NONE;
            rxFrameSeq++;
            // Try to capture the wakeup pulse.
            if(duration > tempo_wakeup_min && duration < tempo_wakeup_max)
            {
                memset(&somfy_rx.payload, 0x00, sizeof(somfy_rx.payload));
                somfy_rx.previous_bit = 0x00;
                somfy_rx.waiting_half_symbol = false;
                somfy_rx.cpt_bits = 0;
                somfy_rx.bit_length = 56;
            }
            else if((somfy_rx.pulseCount > 20 && somfy_rx.cpt_synchro_hw == 0) || duration > 250000) {
              somfy_rx.pulseCount = 0;
            }
        }
        break;
    case receiving_data:
        if(somfy_rx.pulseCount < MAX_TIMINGS) somfy_rx.pulses[somfy_rx.pulseCount++] = duration;
        // We should be receiving data at this point.
        if (duration > tempo_symbol_min && duration < tempo_symbol_max && !somfy_rx.waiting_half_symbol) {
            somfy_rx.previous_bit = 1 - somfy_rx.previous_bit;
            // Bits come in high order bit first.
            somfy_rx.payload[somfy_rx.cpt_bits / 8] += somfy_rx.previous_bit << (7 - somfy_rx.cpt_bits % 8);
            ++somfy_rx.cpt_bits;
        }
        else if (duration > tempo_half_symbol_min && duration < tempo_half_symbol_max) {
            if (somfy_rx.waiting_half_symbol) {
                somfy_rx.waiting_half_symbol = false;
                somfy_rx.payload[somfy_rx.cpt_bits / 8] += somfy_rx.previous_bit << (7 - somfy_rx.cpt_bits % 8);
                ++somfy_rx.cpt_bits;
            }
            else {
                somfy_rx.waiting_half_symbol = true;
            }
        }
        else {
            //++somfy_rx.cpt_bits;
            // Start over we are not within our parameters for bit timing.
            memset(&somfy_rx.payload, 0x00, sizeof(somfy_rx.payload));
            somfy_rx.pulseCount = 1;
            somfy_rx.cpt_synchro_hw = 0;
            somfy_rx.previous_bit = 0x00;
            somfy_rx.waiting_half_symbol = false;
            somfy_rx.cpt_bits = 0;
            somfy_rx.bit_length = 56;
            somfy_rx.status = waiting_synchro;
            somfy_rx.pulses[0] = duration;
            somfy_rx.rssi = RX_RSSI_NONE;
            rxFrameSeq++;
        }
        break;
    default:
        break;
    }
    if (somfy_rx.status == receiving_data && somfy_rx.cpt_bits >= somfy_rx.bit_length) {
        // Since we are operating within the interrupt all data really needs to be static
        // for the handoff to the frame decoder.  For this reason we are buffering up to
        // 3 total frames.  Althought it may not matter considering the length of a packet
        // will likely not push over the loop timing.  For now lets assume that there
        // may be some pressure on the loop for features.
        // Reserve a slot under the spinlock: handle overflow (drop the oldest)
        // and locate a free slot.  Only the length + index[] bookkeeping runs
        // under the lock here; the 1.2KB frame copy is done afterwards.
        uint8_t first = 255;
        portENTER_CRITICAL_ISR(&rxMux);
        if(rx_queue.length >= MAX_RX_BUFFER) {
          // We have overflowed the buffer simply empty the last item
          // in this instance we will simply throw it away.
          uint8_t ndx = rx_queue.index[MAX_RX_BUFFER - 1];
          if(ndx < MAX_RX_BUFFER) rx_queue.items[ndx].pulseCount = 0;
          //memset(&this->items[ndx], 0x00, sizeof(somfy_rx_t));
          rx_queue.index[MAX_RX_BUFFER - 1] = 255;
          rx_queue.length--;
        }
        // Find the first empty slot.  There will be one unless the consumer is
        // mid-copy on the last slot, in which case we simply drop this frame.
        for(uint8_t i = 0; i < MAX_RX_BUFFER; i++) {
          if(rx_queue.items[i].pulseCount == 0) {
            first = i;
            break;
          }
        }
        portEXIT_CRITICAL_ISR(&rxMux);
        if(first < MAX_RX_BUFFER) {
          // Copy the captured frame into the reserved slot outside the lock.  The
          // slot is not yet referenced by index[], so pop() cannot see it, and the
          // ISR is the only producer, so no concurrent writer exists.
          memcpy(&rx_queue.items[first], &somfy_rx, sizeof(somfy_rx_t));
          // Publish the slot under the lock so the consumer can pick it up.
          portENTER_CRITICAL_ISR(&rxMux);
          // Move the index so that it is the at position 0.  The oldest item will fall off.
          for(uint8_t i = MAX_RX_BUFFER - 1; i > 0; i--) {
            rx_queue.index[i] = rx_queue.index[i - 1];
          }
          rx_queue.length++;
          rx_queue.index[0] = first;
          portEXIT_CRITICAL_ISR(&rxMux);
        }
        memset(&somfy_rx.payload, 0x00, sizeof(somfy_rx.payload));
        somfy_rx.cpt_synchro_hw = 0;
        somfy_rx.previous_bit = 0x00;
        somfy_rx.waiting_half_symbol = false;
        somfy_rx.cpt_bits = 0;
        somfy_rx.pulseCount = 0;
        somfy_rx.status = waiting_synchro;
        somfy_rx.rssi = RX_RSSI_NONE;
        rxFrameSeq++;
        lastRxFrameEnd = millis();
    }
}
// Samples the RSSI while a frame is on the air (from its first hardware sync to
// its last bit) and keeps the strongest reading on the frame, which the ISR
// queues with it. The sequence check drops a sample whose frame ended during
// the SPI read; an ISR running on the other core can still slip in between the
// check and the write, which at worst skews one frame's reading.
static void sampleFrameRssi() {
  static uint32_t lastSample = 0;
  if((rxmode != 1 && rxmode != 3) || somfy_rx.cpt_synchro_hw == 0) return;
  if(millis() - lastSample < 2) return;
  RadioGuard radio(0); // the radio task is transmitting: nothing to sample anyway
  if(!radio.held()) return;
  lastSample = millis();
  const uint8_t seq = rxFrameSeq;
  const int16_t rssi = static_cast<int16_t>(ELECHOUSE_cc1101.getRssi());
  portENTER_CRITICAL(&rxMux);
  if(seq == rxFrameSeq && somfy_rx.cpt_synchro_hw > 0 && (somfy_rx.rssi == RX_RSSI_NONE || rssi > somfy_rx.rssi))
    somfy_rx.rssi = rssi;
  portEXIT_CRITICAL(&rxMux);
}
// ---------------------------------------------------------------------------
// Frequency scan v2: two-pass edge calibration.
//
// The RTS carrier cannot be measured directly (FREQEST needs FSK; RTS is OOK),
// so the remote is located through the RX filter response.  With a ~100kHz
// bandwidth the RSSI-vs-frequency curve is a flat-topped plateau: taking the
// maximum, as the old scan did, draws a random point inside the plateau because
// per-frame RSSI noise (+/-2-3dB) swamps the filter-edge slope.  Instead:
//
//  - coarse pass: legacy 10kHz sweep at the configured bandwidth until a frame
//    decodes with a solid level; that decode sits somewhere on the plateau;
//  - fine pass: bandwidth narrowed to 58kHz, +/-80kHz window walked in 5kHz
//    steps, dwelling on each step until a couple of frames decode (or a
//    timeout).  The result is the MIDPOINT between the two -6dB edges of the
//    decoded plateau, which is robust to RSSI noise where the maximum is not.
//
// Centring the remote in our RX filter cancels this module's crystal offset,
// and since RX and TX share the same crystal the correction holds for TX too.
float currFreq = 433.0f;
int currRSSI = -100;
float markFreq = 433.0f;
int markRSSI = -100;
uint32_t lastScan = 0;
#define SCAN_FINE_STEPS 33
#define SCAN_FINE_STEP 0.005f
#define SCAN_FINE_HALF_SPAN 0.08f
#define SCAN_FINE_BW 58.03f
#define SCAN_STEP_TIMEOUT 1200UL   // ms on one fine step without enough decodes
#define SCAN_STEP_DECODES 2        // decodes that advance a fine step early
#define SCAN_COARSE_LEVEL -85      // decode level that ends the coarse pass
#define SCAN_EDGE_DROP 6           // dB below peak that defines a plateau edge
static uint8_t scanPhase = 0;      // 0=idle 1=coarse 2=fine 3=done
static float fineCenter = 433.42f;
static float fineLow = 0.0f;       // resolved -6dB edges, exposed once done
static float fineHigh = 0.0f;
static int8_t fineRssi[SCAN_FINE_STEPS];
static uint8_t fineDecodes[SCAN_FINE_STEPS];
static uint8_t fineStep = 0;
static uint32_t stepStart = 0;
static float scanFineFreq(uint8_t step) { return fineCenter - SCAN_FINE_HALF_SPAN + (float)step * SCAN_FINE_STEP; }
void Transceiver::beginFrequencyScan() {
  RadioGuard radio;
  if(this->config.enabled) {
    this->disableReceive();
    rxmode = 3;
    pinMode(this->config.RXPin, INPUT);
    interruptPin = digitalPinToInterrupt(this->config.RXPin);
    ELECHOUSE_cc1101.setRxBW(this->config.rxBandwidth);              // Set the Receive Bandwidth in kHz. Value from 58.03 to 812.50. Default is 812.50 kHz.
    ELECHOUSE_cc1101.SetRx();
    markFreq = currFreq = 433.0f;
    markRSSI = -100;
    scanPhase = 1;
    fineLow = fineHigh = 0.0f;
    fineStep = 0;
    memset(fineDecodes, 0x00, sizeof(fineDecodes));
    for(uint8_t i = 0; i < SCAN_FINE_STEPS; i++) fineRssi[i] = -128;
    ELECHOUSE_cc1101.setMHZ(currFreq);
    Serial.printf("Begin frequency scan on Pin #%d\n", this->config.RXPin);
    attachInterrupt(interruptPin, handleReceive, CHANGE);
    this->emitFrequencyScan();
  }
}
void Transceiver::processFrequencyScan(bool received) {
  if(!this->config.enabled || rxmode != 3) return;
  RadioGuard radio;
  if(scanPhase == 1) {
    if(received) {
      currRSSI = this->frame.rssi; // sampled while the frame was on the air
      if(currRSSI > markRSSI) {
        markRSSI = currRSSI;
        markFreq = currFreq;
      }
      if(currRSSI > SCAN_COARSE_LEVEL) {
        // Somewhere on the plateau: switch to the narrow-band fine sweep around it.
        fineCenter = currFreq;
        scanPhase = 2;
        fineStep = 0;
        stepStart = millis();
        ELECHOUSE_cc1101.setRxBW(SCAN_FINE_BW);
        currFreq = scanFineFreq(0);
        ELECHOUSE_cc1101.setMHZ(currFreq);
        Serial.printf("Frequency scan: fine pass around %.3fMHz\n", fineCenter);
        this->emitFrequencyScan();
        return;
      }
    }
    else currRSSI = -100;
    if(millis() - lastScan > 100 && somfy_rx.status == waiting_synchro) {
      lastScan = millis();
      this->emitFrequencyScan();
      currFreq += 0.01f;
      if(currFreq > 434.0f) currFreq = 433.0f;
      ELECHOUSE_cc1101.setMHZ(currFreq);
    }
  }
  else if(scanPhase == 2) {
    if(received) {
      currRSSI = this->frame.rssi; // sampled while the frame was on the air
      if(currRSSI > fineRssi[fineStep]) fineRssi[fineStep] = (int8_t)currRSSI;
      if(fineDecodes[fineStep] < 255) fineDecodes[fineStep]++;
    }
    bool advance = fineDecodes[fineStep] >= SCAN_STEP_DECODES || millis() - stepStart > SCAN_STEP_TIMEOUT;
    if(advance && somfy_rx.status == waiting_synchro) {
      // Increment before emitting so the reported progress counts COMPLETED steps
      // and reaches 100% on the last one instead of stalling at 32/33.
      fineStep++;
      this->emitFrequencyScan();
      if(fineStep >= SCAN_FINE_STEPS) {
        // Resolve the plateau: peak over decoded steps, then the outermost steps
        // still within SCAN_EDGE_DROP of it; the recommendation is their midpoint.
        int8_t peak = -128;
        for(uint8_t i = 0; i < SCAN_FINE_STEPS; i++)
          if(fineDecodes[i] > 0 && fineRssi[i] > peak) peak = fineRssi[i];
        if(peak > -128) {
          uint8_t iLow = 255, iHigh = 0;
          for(uint8_t i = 0; i < SCAN_FINE_STEPS; i++) {
            if(fineDecodes[i] == 0 || fineRssi[i] < peak - SCAN_EDGE_DROP) continue;
            if(iLow == 255) iLow = i;
            iHigh = i;
          }
          fineLow = scanFineFreq(iLow);
          fineHigh = scanFineFreq(iHigh);
          markFreq = (fineLow + fineHigh) / 2.0f;
          markRSSI = peak;
          Serial.printf("Frequency scan: plateau %.3f-%.3fMHz, recommending %.3fMHz\n", fineLow, fineHigh, markFreq);
        } // else: nothing decoded in the fine window; keep the coarse best
        scanPhase = 3;
        currRSSI = -100;
        this->emitFrequencyScan();
      }
      else {
        currFreq = scanFineFreq(fineStep);
        ELECHOUSE_cc1101.setMHZ(currFreq);
        stepStart = millis();
        currRSSI = -100;
      }
    }
  }
  // scanPhase == 3: hold the result on screen until the user ends the scan.
}
void Transceiver::endFrequencyScan() {
  RadioGuard radio;
  // Also runs when a transmission killed the scan (rxmode left 3 via
  // disableReceive): the state machine must still be reset and the configured
  // frequency/bandwidth restored, otherwise the radio stays parked on the scan
  // frequency at 58kHz and the UI stop button does nothing.
  if(rxmode == 3 || scanPhase != 0) {
    if(rxmode == 3) {
      rxmode = 0;
      if(interruptPin > 0) detachInterrupt(interruptPin);
      interruptPin = 0;
    }
    scanPhase = 0;
    this->config.apply();
    this->emitFrequencyScan();
  }
}
void Transceiver::emitFrequencyScan(uint8_t num) {
  JsonSockEvent *json = sockEmit.beginEmit("frequencyScan");
  json->beginObject();
  json->addElem("scanning", rxmode == 3);
  json->addElem("phase", scanPhase);
  // Coarse progress is indeterminate (it ends on the first decode); fine progress is stepwise.
  json->addElem("progress", (uint8_t)(scanPhase < 2 ? 0 : (scanPhase == 2 ? (fineStep * 100) / SCAN_FINE_STEPS : 100)));
  json->addElem("testFreq", currFreq);
  json->addElem("testRSSI", (int32_t)currRSSI);
  json->addElem("frequency", markFreq);
  json->addElem("RSSI", (int32_t)markRSSI);
  json->addElem("fLow", fineLow);
  json->addElem("fHigh", fineHigh);
  json->endObject();
  sockEmit.endEmit(num);
}
bool Transceiver::receive(somfy_rx_t *rx) {
    // Check to see if there is anything in the buffer
    if(rx_queue.length > 0) {
      //Serial.printf("Processing receive %d\n", rx_queue.length);
      rx_queue.pop(rx);
      this->frame.decodeFrame(rx);
      this->emitFrame(&this->frame, rx);
      return this->frame.valid;
    }
    return false;
}
void Transceiver::emitFrame(somfy_frame_t *frame, somfy_rx_t *rx) {
  if(sockEmit.activeClients(ROOM_EMIT_FRAME) > 0) {
    JsonSockEvent *json = sockEmit.beginEmit("remoteFrame");
    json->beginObject();
    json->addElem("encKey", frame->encKey);
    json->addElem("address", (uint32_t)frame->remoteAddress);
    json->addElem("rcode", (uint32_t)frame->rollingCode);
    json->addElem("command", translateSomfyCommand(frame->cmd).c_str());
    json->addElem("rssi", (int32_t)frame->rssi);
    json->addElem("bits", rx->bit_length);
    json->addElem("proto", static_cast<uint8_t>(frame->proto));
    json->addElem("valid", frame->valid);
    json->addElem("sync", frame->hwsync);
    if(frame->cmd == somfy_commands::StepUp || frame->cmd == somfy_commands::StepDown)
      json->addElem("stepSize", frame->stepSize);
    json->beginArray("pulses");
    if(rx) {
      for(uint16_t i = 0; i < rx->pulseCount; i++) {
        json->addElem((uint32_t)rx->pulses[i]);
      }
    }
    json->endArray();
    json->endObject();
    sockEmit.endEmitRoom(ROOM_EMIT_FRAME);
    /*
    ClientSocketEvent evt("remoteFrame");
    char buf[30];
    snprintf(buf, sizeof(buf), "{\"encKey\":%d,", frame->encKey);
    evt.appendMessage(buf);
    snprintf(buf, sizeof(buf), "\"address\":%d,", frame->remoteAddress);
    evt.appendMessage(buf);
    snprintf(buf, sizeof(buf), "\"rcode\":%d,", frame->rollingCode);
    evt.appendMessage(buf);
    snprintf(buf, sizeof(buf), "\"command\":\"%s\",", translateSomfyCommand(frame->cmd).c_str());
    evt.appendMessage(buf);
    snprintf(buf, sizeof(buf), "\"rssi\":%d,", frame->rssi);
    evt.appendMessage(buf);
    snprintf(buf, sizeof(buf), "\"bits\":%d,", rx->bit_length);
    evt.appendMessage(buf);
    snprintf(buf, sizeof(buf), "\"proto\":%d,", static_cast<uint8_t>(frame->proto));
    evt.appendMessage(buf);
    snprintf(buf, sizeof(buf), "\"valid\":%s,", frame->valid ? "true" : "false");
    evt.appendMessage(buf);
    snprintf(buf, sizeof(buf), "\"sync\":%d,\"pulses\":[", frame->hwsync);
    evt.appendMessage(buf);
    
    if(rx) {
      for(uint16_t i = 0; i < rx->pulseCount; i++) {
        snprintf(buf, sizeof(buf), "%s%d", i != 0 ? "," : "", rx->pulses[i]);
        evt.appendMessage(buf);
      }
    }
    evt.appendMessage("]}");
    sockEmit.sendToRoom(ROOM_EMIT_FRAME, &evt);
    */
  }
}
void Transceiver::clearReceived(void) {
    //packet_received = false;
    //memset(receive_buffer, 0x00, sizeof(receive_buffer));
    if(this->config.enabled)
      //attachInterrupt(interruptPin, handleReceive, FALLING);
      attachInterrupt(interruptPin, handleReceive, CHANGE);
}
void Transceiver::enableReceive(void) {
    RadioGuard radio;
    uint32_t timing = millis();
    if(rxmode > 0) return;
    if(this->config.enabled) {
      rxmode = 1;
      pinMode(this->config.RXPin, INPUT);
      interruptPin = digitalPinToInterrupt(this->config.RXPin);
      ELECHOUSE_cc1101.SetRx();
      //attachInterrupt(interruptPin, handleReceive, FALLING);
      attachInterrupt(interruptPin, handleReceive, CHANGE);
      Serial.printf("Enabled receive on Pin #%d Timing: %ld\n", this->config.RXPin, millis() - timing);
    }
}
void Transceiver::disableReceive(void) {
  RadioGuard radio;
  rxmode = 0;
  if(interruptPin > 0) detachInterrupt(interruptPin); 
  interruptPin = 0;
  
}
void Transceiver::toJSON(JsonResponse& json) {
    json.beginObject("config");
    this->config.toJSON(json);
    json.endObject();
}
/*
bool Transceiver::toJSON(JsonObject& obj) {
    //Serial.println("Setting Transceiver Json");
    JsonObject objConfig = obj.createNestedObject("config");
    this->config.toJSON(objConfig);
    return true;
}
*/
bool Transceiver::fromJSON(JsonObject& obj) {
    if (obj.containsKey("config")) {
      JsonObject objConfig = obj["config"];
      this->config.fromJSON(objConfig);
    }
    return true;
}
bool Transceiver::usesPin(uint8_t pin) {
  if(this->config.enabled) {
    if(this->config.SCKPin == pin ||
      this->config.TXPin == pin ||
      this->config.RXPin == pin ||
      this->config.MOSIPin == pin ||
      this->config.MISOPin == pin ||
      this->config.CSNPin == pin)
      return true;
  }
  return false;  
}
bool Transceiver::save() {
    this->config.save();
    this->config.apply();
    return true;
}
bool Transceiver::end() {
    // Also holds the queued transmissions (OTA flash, reboot): resumeTx() restarts both.
    this->suspendTx();
    this->disableReceive();
    return true;
}
void transceiver_config_t::fromJSON(JsonObject& obj) {
    //Serial.print("Deserialize Radio JSON ");
    if(obj.containsKey("type")) this->type = obj["type"];
    if(obj.containsKey("CSNPin")) this->CSNPin = obj["CSNPin"];
    if(obj.containsKey("MISOPin")) this->MISOPin = obj["MISOPin"];
    if(obj.containsKey("MOSIPin")) this->MOSIPin = obj["MOSIPin"];
    if(obj.containsKey("RXPin")) this->RXPin = obj["RXPin"];
    if(obj.containsKey("SCKPin")) this->SCKPin = obj["SCKPin"];
    if(obj.containsKey("TXPin")) this->TXPin = obj["TXPin"];
    // Clamp to the CC1101's documented ranges. radioBoardType selects a host board pinout
    // (D1 mini, WT32-ETH01, Olimex PoE, XIAO-C3, ...), not a different transceiver: the
    // CC1101 driver is the only one linked in, and these limits come from the chip, so
    // they hold for every board. The frequency bound spans all three CC1101 bands, well
    // beyond the 433 MHz range the UI slider offers, so no reachable setting is rejected.
    // Values are persisted and later formatted into a fixed-size buffer, so an unchecked
    // float from /saveRadio both programmed the radio with nonsense and overflowed it.
    if(obj.containsKey("rxBandwidth")) this->rxBandwidth = constrain((float)obj["rxBandwidth"], 58.03f, 812.50f);
    if(obj.containsKey("frequency")) this->frequency = constrain((float)obj["frequency"], 300.0f, 928.0f);
    if(obj.containsKey("deviation")) this->deviation = constrain((float)obj["deviation"], 1.58f, 380.85f);
    if(obj.containsKey("enabled")) this->enabled = obj["enabled"];
    if(obj.containsKey("txPower")) this->txPower = obj["txPower"];
    if(obj.containsKey("proto")) this->proto = static_cast<radio_proto>(obj["proto"].as<uint8_t>());
    if(obj.containsKey("radioBoardType")) this->radioBoardType = obj["radioBoardType"];
    /*
    if (obj.containsKey("internalCCMode")) this->internalCCMode = obj["internalCCMode"];
    if (obj.containsKey("modulationMode")) this->modulationMode = obj["modulationMode"];
    if (obj.containsKey("channel")) this->channel = obj["channel"];
    if (obj.containsKey("channelSpacing")) this->channelSpacing = obj["channelSpacing"]; // float
    if (obj.containsKey("dataRate")) this->dataRate = obj["dataRate"]; // float
    if (obj.containsKey("syncMode")) this->syncMode = obj["syncMode"];
    if (obj.containsKey("syncWordHigh")) this->syncWordHigh = obj["syncWordHigh"];
    if (obj.containsKey("syncWordLow")) this->syncWordLow = obj["syncWordLow"];
    if (obj.containsKey("addrCheckMode")) this->addrCheckMode = obj["addrCheckMode"];
    if (obj.containsKey("checkAddr")) this->checkAddr = obj["checkAddr"];
    if (obj.containsKey("dataWhitening")) this->dataWhitening = obj["dataWhitening"];
    if (obj.containsKey("pktFormat")) this->pktFormat = obj["pktFormat"];
    if (obj.containsKey("pktLengthMode")) this->pktLengthMode = obj["pktLengthMode"];
    if (obj.containsKey("pktLength")) this->pktLength = obj["pktLength"];
    if (obj.containsKey("useCRC")) this->useCRC = obj["useCRC"];
    if (obj.containsKey("autoFlushCRC")) this->autoFlushCRC = obj["autoFlushCRC"];
    if (obj.containsKey("disableDCFilter")) this->disableDCFilter = obj["disableCRCFilter"];
    if (obj.containsKey("enableManchester")) this->enableManchester = obj["enableManchester"];
    if (obj.containsKey("enableFEC")) this->enableFEC = obj["enableFEC"];
    if (obj.containsKey("minPreambleBytes")) this->minPreambleBytes = obj["minPreambleBytes"];
    if (obj.containsKey("pqtThreshold")) this->pqtThreshold = obj["pqtThreshold"];
    if (obj.containsKey("appendStatus")) this->appendStatus = obj["appendStatus"];
    if (obj.containsKey("printBuffer")) this->printBuffer = obj["printBuffer"];
    */
    Serial.printf("SCK:%u MISO:%u MOSI:%u CSN:%u RX:%u TX:%u\n", this->SCKPin, this->MISOPin, this->MOSIPin, this->CSNPin, this->RXPin, this->TXPin);
}
void transceiver_config_t::toJSON(JsonResponse &json) {
    json.addElem("type", this->type);
    json.addElem("TXPin", this->TXPin);
    json.addElem("RXPin", this->RXPin);
    json.addElem("SCKPin", this->SCKPin);
    json.addElem("MOSIPin", this->MOSIPin);
    json.addElem("MISOPin", this->MISOPin);
    json.addElem("CSNPin", this->CSNPin);
    json.addElem("rxBandwidth", this->rxBandwidth); // float
    json.addElem("frequency", this->frequency);  // float
    json.addElem("deviation", this->deviation);  // float
    json.addElem("txPower", this->txPower);
    json.addElem("proto", static_cast<uint8_t>(this->proto));
    json.addElem("enabled", this->enabled);
    json.addElem("radioInit", this->radioInit);
    json.addElem("radioBoardType", this->radioBoardType);
}
/*
void transceiver_config_t::toJSON(JsonObject& obj) {
    obj["type"] = this->type;
    obj["TXPin"] = this->TXPin;
    obj["RXPin"] = this->RXPin;
    obj["SCKPin"] = this->SCKPin;
    obj["MOSIPin"] = this->MOSIPin;
    obj["MISOPin"] = this->MISOPin;
    obj["CSNPin"] = this->CSNPin;
    obj["rxBandwidth"] = this->rxBandwidth; // float
    obj["frequency"] = this->frequency;  // float
    obj["deviation"] = this->deviation;  // float
    obj["txPower"] = this->txPower;
    obj["proto"] = static_cast<uint8_t>(this->proto);
    //obj["internalCCMode"] = this->internalCCMode;
    //obj["modulationMode"] = this->modulationMode;
    //obj["channel"] = this->channel;
    //obj["channelSpacing"] = this->channelSpacing; // float
    //obj["dataRate"] = this->dataRate; // float
    //obj["syncMode"] = this->syncMode;
    //obj["syncWordHigh"] = this->syncWordHigh;
    //obj["syncWordLow"] = this->syncWordLow;
    //obj["addrCheckMode"] = this->addrCheckMode;
    //obj["checkAddr"] = this->checkAddr;
    //obj["dataWhitening"] = this->dataWhitening;
    //obj["pktFormat"] = this->pktFormat;
    //obj["pktLengthMode"] = this->pktLengthMode;
    //obj["pktLength"] = this->pktLength;
    //obj["useCRC"] = this->useCRC;
    //obj["autoFlushCRC"] = this->autoFlushCRC;
    //obj["disableDCFilter"] = this->disableDCFilter;
    //obj["enableManchester"] = this->enableManchester;
    //obj["enableFEC"] = this->enableFEC;
    //obj["minPreambleBytes"] = this->minPreambleBytes;
    //obj["pqtThreshold"] = this->pqtThreshold;
    //obj["appendStatus"] = this->appendStatus;
    //obj["printBuffer"] = somfy.transceiver.printBuffer;
    obj["enabled"] = this->enabled;
    obj["radioInit"] = this->radioInit;
    //Serial.print("Serialize Radio JSON ");
    //Serial.printf("SCK:%u MISO:%u MOSI:%u CSN:%u RX:%u TX:%u\n", this->SCKPin, this->MISOPin, this->MOSIPin, this->CSNPin, this->RXPin, this->TXPin);
}
*/
void transceiver_config_t::save() {
    pref.begin("CC1101");
    pref.putUChar("type", this->type);
    pref.putUChar("TXPin", this->TXPin);
    pref.putUChar("RXPin", this->RXPin);
    pref.putUChar("SCKPin", this->SCKPin);
    pref.putUChar("MOSIPin", this->MOSIPin);
    pref.putUChar("MISOPin", this->MISOPin);
    pref.putUChar("CSNPin", this->CSNPin);
    pref.putFloat("frequency", this->frequency);  // float
    pref.putFloat("deviation", this->deviation);  // float
    pref.putFloat("rxBandwidth", this->rxBandwidth); // float
    pref.putBool("enabled", this->enabled);
    pref.putBool("radioInit", true);
    pref.putChar("txPower", this->txPower);
    pref.putChar("proto", static_cast<uint8_t>(this->proto));
    pref.putUChar("radioBoardType", this->radioBoardType);

    
    /*
    pref.putBool("internalCCMode", this->internalCCMode);
    pref.putUChar("modulationMode", this->modulationMode);
    pref.putUChar("channel", this->channel);
    pref.putFloat("channelSpacing", this->channelSpacing); // float
    pref.putFloat("rxBandwidth", this->rxBandwidth); // float
    pref.putFloat("dataRate", this->dataRate); // float
    pref.putChar("txPower", this->txPower);
    pref.putUChar("syncMode", this->syncMode);
    pref.putUShort("syncWordHigh", this->syncWordHigh);
    pref.putUShort("syncWordLow", this->syncWordLow);
    pref.putUChar("addrCheckMode", this->addrCheckMode);
    pref.putUChar("checkAddr", this->checkAddr);
    pref.putBool("dataWhitening", this->dataWhitening);
    pref.putUChar("pktFormat", this->pktFormat);
    pref.putUChar("pktLengthMode", this->pktLengthMode);
    pref.putUChar("pktLength", this->pktLength);
    pref.putBool("useCRC", this->useCRC);
    pref.putBool("autoFlushCRC", this->autoFlushCRC);
    pref.putBool("disableDCFilter", this->disableDCFilter);
    pref.putBool("enableManchester", this->enableManchester);
    pref.putBool("enableFEC", this->enableFEC);
    pref.putUChar("minPreambleBytes", this->minPreambleBytes);
    pref.putUChar("pqtThreshold", this->pqtThreshold);
    pref.putBool("appendStatus", this->appendStatus);
    */
    pref.end();
   
    Serial.print("Save Radio Settings ");
    Serial.printf("SCK:%u MISO:%u MOSI:%u CSN:%u RX:%u TX:%u\n", this->SCKPin, this->MISOPin, this->MOSIPin, this->CSNPin, this->RXPin, this->TXPin);
}
void transceiver_config_t::removeNVSKey(const char *key) {
  if(pref.isKey(key)) {
    Serial.printf("Removing NVS Key: CC1101.%s\n", key);
    pref.remove(key);
  }
}
void transceiver_config_t::load() {
    esp_chip_info_t ci;
    esp_chip_info(&ci);
    switch(ci.model) {
      case esp_chip_model_t::CHIP_ESP32S3:
        Serial.println("Setting S3 Transceiver Defaults...");
        this->TXPin = 15;
        this->RXPin = 14;
        this->MOSIPin = 11;
        this->MISOPin = 13;
        this->SCKPin = 12;
        this->CSNPin = 10;
        break;
      case esp_chip_model_t::CHIP_ESP32S2:
        this->TXPin = 15;
        this->RXPin = 14;
        this->MOSIPin = 35;
        this->MISOPin = 37;
        this->SCKPin = 36;
        this->CSNPin = 34;
        break;
      case esp_chip_model_t::CHIP_ESP32C3:
        this->TXPin = 13;
        this->RXPin = 12;
        this->MOSIPin = 16;
        this->MISOPin = 17;
        this->SCKPin = 15;
        this->CSNPin = 14;
        break;
      default:
        this->TXPin = 13;
        this->RXPin = 12;
        this->MOSIPin = 23;
        this->MISOPin = 19;
        this->SCKPin = 18;
        this->CSNPin = 5;
        break;
    }
    pref.begin("CC1101");
    this->type = pref.getUChar("type", 56);
    this->TXPin = pref.getUChar("TXPin", this->TXPin);
    this->RXPin = pref.getUChar("RXPin", this->RXPin);
    this->SCKPin = pref.getUChar("SCKPin", this->SCKPin);
    this->MOSIPin = pref.getUChar("MOSIPin", this->MOSIPin);
    this->MISOPin = pref.getUChar("MISOPin", this->MISOPin);
    this->CSNPin = pref.getUChar("CSNPin", this->CSNPin);
    this->frequency = pref.getFloat("frequency", this->frequency);  // float
    this->deviation = pref.getFloat("deviation", this->deviation);  // float
    this->enabled = pref.getBool("enabled", this->enabled);
    this->txPower = pref.getChar("txPower", this->txPower);
    this->rxBandwidth = pref.getFloat("rxBandwidth", this->rxBandwidth);
    this->proto = static_cast<radio_proto>(pref.getChar("proto", static_cast<uint8_t>(this->proto)));
    this->radioBoardType = pref.getUChar("radioBoardType", 0);
    this->removeNVSKey("internalCCMode");
    this->removeNVSKey("modulationMode");
    this->removeNVSKey("channel");
    this->removeNVSKey("channelSpacing");
    this->removeNVSKey("dataRate");
    this->removeNVSKey("syncMode");
    this->removeNVSKey("syncWordHigh");
    this->removeNVSKey("syncWordLow");
    this->removeNVSKey("addrCheckMode");
    this->removeNVSKey("checkAddr");
    this->removeNVSKey("dataWhitening");
    this->removeNVSKey("pktFormat");
    this->removeNVSKey("pktLengthMode");
    this->removeNVSKey("pktLength");
    this->removeNVSKey("useCRC");
    this->removeNVSKey("autoFlushCRC");
    this->removeNVSKey("disableDCFilter");
    this->removeNVSKey("enableManchester");
    this->removeNVSKey("enableFEC");
    this->removeNVSKey("minPreambleBytes");
    this->removeNVSKey("pqtThreshold");
    this->removeNVSKey("appendStatus");
    pref.end();
    //this->printBuffer = somfy.transceiver.printBuffer;
}
void transceiver_config_t::apply() {
    RadioGuard radio; // waits for a transmission in progress
    somfy.transceiver.disableReceive();
    bit_length = this->type;    
    if(this->enabled) {
      bool radioInit = true;
      pref.begin("CC1101");
      radioInit = pref.getBool("radioInit", true);
      // If the radio locks up then we can simply reboot and re-enable the radio.
      pref.putBool("radioInit", false);
      this->radioInit = false;
      pref.end();
      if(!radioInit) return;
      Serial.print("Applying radio settings ");
      Serial.printf("Setting Data Pins RX:%u TX:%u\n", this->RXPin, this->TXPin);
      //if(this->TXPin != this->RXPin)
      //  pinMode(this->TXPin, OUTPUT);
      //pinMode(this->RXPin, INPUT);
      // Essentially these call only preform the two functions above.
      if(this->TXPin == this->RXPin)
        ELECHOUSE_cc1101.setGDO0(this->TXPin); // This pin may be shared.
      else
        ELECHOUSE_cc1101.setGDO(this->TXPin, this->RXPin); // GDO0, GDO2
      Serial.printf("Setting SPI Pins SCK:%u MISO:%u MOSI:%u CSN:%u\n", this->SCKPin, this->MISOPin, this->MOSIPin, this->CSNPin);
      ELECHOUSE_cc1101.setSpiPin(this->SCKPin, this->MISOPin, this->MOSIPin, this->CSNPin);
      Serial.println("Radio Pins Configured!");
      ELECHOUSE_cc1101.Init();
      ELECHOUSE_cc1101.setCCMode(0);                            // set config for internal transmission mode.
      ELECHOUSE_cc1101.setMHZ(this->frequency);                 // Here you can set your basic frequency. The lib calculates the frequency automatically (default = 433.92).The cc1101 can: 300-348 MHZ, 387-464MHZ and 779-928MHZ. Read More info from datasheet.
      ELECHOUSE_cc1101.setRxBW(this->rxBandwidth);              // Set the Receive Bandwidth in kHz. Value from 58.03 to 812.50. Default is 812.50 kHz.
      ELECHOUSE_cc1101.setDeviation(this->deviation);           // Set the Frequency deviation in kHz. Value from 1.58 to 380.85. Default is 47.60 kHz.
      ELECHOUSE_cc1101.setPA(this->txPower);                    // Set TxPower. The following settings are possible depending on the frequency band.  (-30  -20  -15  -10  -6    0    5    7    10   11   12) Default is max!
      ELECHOUSE_cc1101.setModulation(2);                        // Set modulation mode. 0 = 2-FSK, 1 = GFSK, 2 = ASK/OOK, 3 = 4-FSK, 4 = MSK.
      ELECHOUSE_cc1101.setManchester(1);                        // Enables Manchester encoding/decoding. 0 = Disable. 1 = Enable.
      ELECHOUSE_cc1101.setPktFormat(3);                         // Format of RX and TX data. 
                                                                // 0 = Normal mode, use FIFOs for RX and TX. 
                                                                // 1 = Synchronous serial mode, Data in on GDO0 and data out on either of the GDOx pins. 
                                                                // 2 = Random TX mode; sends random data using PN9 generator. Used for test. Works as normal mode, setting 0 (00), in RX. 
                                                                // 3 = Asynchronous serial mode, Data in on GDO0 and data out on either of the GDOx pins.
      ELECHOUSE_cc1101.setDcFilterOff(0);                       // Disable digital DC blocking filter before demodulator. Only for data rates â‰¤ 250 kBaud The recommended IF frequency changes when the DC blocking is disabled. 
                                                                // 1 = Disable (current optimized). 
                                                                // 0 = Enable (better sensitivity).
      ELECHOUSE_cc1101.setCrc(0);                               // 1 = CRC calculation in TX and CRC check in RX enabled. 0 = CRC disabled for TX and RX.
      ELECHOUSE_cc1101.setCRC_AF(0);                            // Enable automatic flush of RX FIFO when CRC is not OK. This requires that only one packet is in the RXIFIFO and that packet length is limited to the RX FIFO size.
      ELECHOUSE_cc1101.setSyncMode(4);                          // Combined sync-word qualifier mode. 
                                                                // 0 = No preamble/sync. 
                                                                // 1 = 16 sync word bits detected. 
                                                                // 2 = 16/16 sync word bits detected. 
                                                                // 3 = 30/32 sync word bits detected. 
                                                                // 4 = No preamble/sync, carrier-sense above threshold. 
                                                                // 5 = 15/16 + carrier-sense above threshold. 
                                                                // 6 = 16/16 + carrier-sense above threshold. 
                                                                // 7 = 30/32 + carrier-sense above threshold.
      ELECHOUSE_cc1101.setAdrChk(0);                            // Controls address check configuration of received packages. 
                                                                // 0 = No address check. 
                                                                // 1 = Address check, no broadcast. 
                                                                // 2 = Address check and 0 (0x00) broadcast. 
                                                                // 3 = Address check and 0 (0x00) and 255 (0xFF) broadcast.
    
      
      if (!ELECHOUSE_cc1101.getCC1101()) {
          Serial.println("Error setting up the radio");
          this->radioInit = false;
      }
      else {
          Serial.println("Successfully set up the radio");
          somfy.transceiver.enableReceive();
          this->radioInit = true;
      }
      pref.begin("CC1101");
      pref.putBool("radioInit", true);
      pref.end();
      
    }
    else {
      if(this->radioInit) ELECHOUSE_cc1101.setSidle();
      somfy.transceiver.disableReceive();
      this->radioInit = false;
    }
    /*
    ELECHOUSE_cc1101.setChannel(this->channel);               // Set the Channelnumber from 0 to 255. Default is cahnnel 0.
    ELECHOUSE_cc1101.setChsp(this->channelSpacing);           // The channel spacing is multiplied by the channel number CHAN and added to the base frequency in kHz. Value from 25.39 to 405.45. Default is 199.95 kHz.
    ELECHOUSE_cc1101.setDRate(this->dataRate);                // Set the Data Rate in kBaud. Value from 0.02 to 1621.83. Default is 99.97 kBaud!
    ELECHOUSE_cc1101.setSyncMode(this->syncMode);             // Combined sync-word qualifier mode. 0 = No preamble/sync. 1 = 16 sync word bits detected. 2 = 16/16 sync word bits detected. 3 = 30/32 sync word bits detected. 4 = No preamble/sync, carrier-sense above threshold. 5 = 15/16 + carrier-sense above threshold. 6 = 16/16 + carrier-sense above threshold. 7 = 30/32 + carrier-sense above threshold.
    ELECHOUSE_cc1101.setSyncWord(this->syncWordHigh, this->syncWordLow); // Set sync word. Must be the same for the transmitter and receiver. (Syncword high, Syncword low)
    ELECHOUSE_cc1101.setAdrChk(this->addrCheckMode);          // Controls address check configuration of received packages. 0 = No address check. 1 = Address check, no broadcast. 2 = Address check and 0 (0x00) broadcast. 3 = Address check and 0 (0x00) and 255 (0xFF) broadcast.
    ELECHOUSE_cc1101.setAddr(this->checkAddr);                // Address used for packet filtration. Optional broadcast addresses are 0 (0x00) and 255 (0xFF).
    ELECHOUSE_cc1101.setWhiteData(this->dataWhitening);       // Turn data whitening on / off. 0 = Whitening off. 1 = Whitening on.
    ELECHOUSE_cc1101.setPktFormat(this->pktFormat);           // Format of RX and TX data. 0 = Normal mode, use FIFOs for RX and TX. 1 = Synchronous serial mode, Data in on GDO0 and data out on either of the GDOx pins. 2 = Random TX mode; sends random data using PN9 generator. Used for test. Works as normal mode, setting 0 (00), in RX. 3 = Asynchronous serial mode, Data in on GDO0 and data out on either of the GDOx pins.
    ELECHOUSE_cc1101.setLengthConfig(this->pktLengthMode);    // 0 = Fixed packet length mode. 1 = Variable packet length mode. 2 = Infinite packet length mode. 3 = Reserved
    ELECHOUSE_cc1101.setPacketLength(this->pktLength);        // Indicates the packet length when fixed packet length mode is enabled. If variable packet length mode is used, this value indicates the maximum packet length allowed.
    ELECHOUSE_cc1101.setCrc(this->useCRC);                    // 1 = CRC calculation in TX and CRC check in RX enabled. 0 = CRC disabled for TX and RX.
    ELECHOUSE_cc1101.setCRC_AF(this->autoFlushCRC);           // Enable automatic flush of RX FIFO when CRC is not OK. This requires that only one packet is in the RXIFIFO and that packet length is limited to the RX FIFO size.
    ELECHOUSE_cc1101.setDcFilterOff(this->disableDCFilter);   // Disable digital DC blocking filter before demodulator. Only for data rates â‰¤ 250 kBaud The recommended IF frequency changes when the DC blocking is disabled. 1 = Disable (current optimized). 0 = Enable (better sensitivity).
    ELECHOUSE_cc1101.setManchester(this->enableManchester);   // Enables Manchester encoding/decoding. 0 = Disable. 1 = Enable.
    ELECHOUSE_cc1101.setFEC(this->enableFEC);                 // Enable Forward Error Correction (FEC) with interleaving for packet payload (Only supported for fixed packet length mode. 0 = Disable. 1 = Enable.
    ELECHOUSE_cc1101.setPRE(this->minPreambleBytes);          // Sets the minimum number of preamble bytes to be transmitted. Values: 0 : 2, 1 : 3, 2 : 4, 3 : 6, 4 : 8, 5 : 12, 6 : 16, 7 : 24
    ELECHOUSE_cc1101.setPQT(this->pqtThreshold);              // Preamble quality estimator threshold. The preamble quality estimator increases an internal counter by one each time a bit is received that is different from the previous bit, and decreases the counter by 8 each time a bit is received that is the same as the last bit. A threshold of 4âˆ™PQT for this counter is used to gate sync word detection. When PQT=0 a sync word is always accepted.
    ELECHOUSE_cc1101.setAppendStatus(this->appendStatus);     // When enabled, two status bytes will be appended to the payload of the packet. The status bytes contain RSSI and LQI values, as well as CRC OK.
    */
    //somfy.transceiver.printBuffer = this->printBuffer;
}
static void radioTaskMain(void *arg) {
  Transceiver *radio = static_cast<Transceiver *>(arg);
  for(;;) {
    // Woken by every queued order; the timeout re-checks deadlines and the
    // listen-before-talk waits.
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(5));
    while(radio->radioStep()) {}
  }
}
bool Transceiver::begin() {
    if(!g_radioLock) g_radioLock = xSemaphoreCreateRecursiveMutex();
    if(!g_jobLock) g_jobLock = xSemaphoreCreateMutex();
    if(!g_txEvents) g_txEvents = xQueueCreate(RADIO_MAX_JOBS, sizeof(radio_tx_event_t));
    this->config.load();
    this->config.apply();
    rx_queue.init();
    if(!g_radioTask) xTaskCreatePinnedToCore(radioTaskMain, "radio", 5120, this, RADIO_TASK_PRIORITY, &g_radioTask, 1);
    return true;
}
void Transceiver::loop() {
  // The radio task does not transmit while a frequency scan runs; it asks the
  // loop to end the scan, whose socket emit needs the shared-state lock.
  if(g_scanAbortRequested) {
    g_scanAbortRequested = false;
    if(rxmode == 3) this->endFrequencyScan();
  }
  sampleFrameRssi();
  somfy_rx_t rx;
  if(rxmode == 3) {
    if(this->receive(&rx))
      this->processFrequencyScan(true);
    else
      this->processFrequencyScan(false);
  }
  else if (this->receive(&rx)) {
    for(uint8_t i = 0; i < SOMFY_MAX_REPEATERS; i++) {
      if(somfy.repeaters[i] == frame.remoteAddress) {
        this->queueRaw(rx.cpt_synchro_hw, rx.payload, rx.bit_length);
        Serial.println("Queued repeater frame...");
        break;
      }
    }
    somfy.processFrame(this->frame, false);
  }
  else {
    somfy.processWaitingFrame();
    // Idle noise-floor sampling for the RF statistics.  Only while the radio sits in
    // plain receive with no synchro in progress, so the reading is ambient noise and
    // not the head of a frame; the register read is a cheap SPI transaction.
    static uint32_t lastNoiseSample = 0;
    if(rxmode == 1 && somfy_rx.status == waiting_synchro && somfy_rx.cpt_synchro_hw == 0
      && millis() - lastNoiseSample > RF_STATS_NOISE_INTERVAL) {
      RadioGuard radio(0); // skipped while the radio task transmits
      if(radio.held()) {
        lastNoiseSample = millis();
        rfStats.recordNoise(ELECHOUSE_cc1101.getRssi());
      }
    }
  }
}
somfy_frame_t& Transceiver::lastFrame() { return this->frame; }
void Transceiver::beginTransmit() {
    if(this->config.enabled) {
      // Never on the scan frequency: the radio task does not transmit while a
      // frequency scan runs (rxmode 3), the loop ends the scan first.
      // Inter-frame silence floor. radioStep() already waited it out; this is
      // the safety net, bounded by TX_FRAME_SILENCE.
      uint32_t sinceTx = millis() - lastTxEnd;
      if(sinceTx < TX_FRAME_SILENCE) delay(TX_FRAME_SILENCE - sinceTx);
      this->disableReceive();
      pinMode(this->config.TXPin, OUTPUT);
      digitalWrite(this->config.TXPin, 0);
      ELECHOUSE_cc1101.SetTx();
    }
}
void Transceiver::endTransmit() {
    if(this->config.enabled) {
      ELECHOUSE_cc1101.setSidle();
      //delay(100);
      this->enableReceive();
    }
}
int radioReadRssi() {
  RadioGuard radio(0);
  return radio.held() ? ELECHOUSE_cc1101.getRssi() : 0;
}
// Airtime of the last hour, in one-minute buckets.
static uint32_t airtimeLastHour(uint32_t now) {
  const uint32_t minute = now / 60000;
  if(minute != g_airtimeMinute) {
    const uint32_t gap = minute - g_airtimeMinute;
    for(uint32_t i = 1; i <= gap && i <= 60; i++) g_airtime[(g_airtimeMinute + i) % 60] = 0;
    g_airtimeMinute = minute;
  }
  uint32_t total = 0;
  for(uint8_t i = 0; i < 60; i++) total += g_airtime[i];
  return total;
}
// 0 when the channel is clear, 1 while RTS traffic is being received or just
// was, 2 when the RSSI shows an undecoded carrier.
static uint8_t channelBusy() {
  if(rxmode != 1) return 0;  // not listening: nothing to defer to
  // A frame is coming in: hardware syncs counted and edges still arriving. The
  // counter is only reset by the next edge, so on a quiet channel one noise
  // pulse of sync length left it set for good and every order waited out the
  // full cap behind traffic that did not exist.
  if(somfy_rx.cpt_synchro_hw > 0 && (uint32_t)(micros() - lastRxEdgeUs) < RADIO_RX_EDGE_TIMEOUT_US) return 1;
  if(lastRxFrameEnd != 0 && millis() - lastRxFrameEnd < RADIO_RX_HOLDOFF) return 1;
  // Carrier sense. The OOK receiver's RSSI swings from one read to the next,
  // so a single read over the threshold proved nothing: take the median of
  // three reads 1ms apart, and none right after our own frame.
  const float base = rfStats.noiseBaselineDbm();
  if(base < 0.0f && millis() - lastTxEnd >= RADIO_TX_SETTLE) {
    int r[3];
    for(uint8_t i = 0; i < 3; i++) {
      {
        RadioGuard radio;
        r[i] = ELECHOUSE_cc1101.getRssi();
      }
      if(i < 2) vTaskDelay(pdMS_TO_TICKS(1));
    }
    const int median = max(min(r[0], r[1]), min(max(r[0], r[1]), r[2]));
    if(median > base + RADIO_CARRIER_MARGIN) return 2;
  }
  return 0;
}
// Caller holds g_jobLock. True while an older job of this remote still has to
// go first (first frame pending, or a transmission in progress).
static bool olderJobPending(const radio_job_t &j) {
  for(uint8_t i = 0; i < RADIO_MAX_JOBS; i++) {
    const radio_job_t &o = g_jobs[i];
    if(!o.used || o.id == j.id || o.kind != radio_job_kind_t::command || o.remoteAddress != j.remoteAddress) continue;
    if((int32_t)(o.id - j.id) < 0 && (!o.firstSent || o.inFlight)) return true;
  }
  return false;
}
// Millis() of the last first frame sent for each recent remote, for the gap a
// remote's next order has to leave (the motor needs it, e.g. after a stop and
// before the long My press that records a position).
struct radio_remote_tx_t { uint32_t address; uint32_t firstEnd; };
static radio_remote_tx_t g_remoteTx[8] = {};
static void noteFirstFrame(uint32_t address, uint32_t when) {
  if(address == 0) return;
  uint8_t slot = 0;
  for(uint8_t i = 0; i < 8; i++) {
    if(g_remoteTx[i].address == address) { slot = i; break; }
    if((int32_t)(g_remoteTx[i].firstEnd - g_remoteTx[slot].firstEnd) < 0) slot = i;
  }
  g_remoteTx[slot].address = address;
  g_remoteTx[slot].firstEnd = when;
}
static bool remoteGapElapsed(uint32_t address, uint16_t gapMs, uint32_t now) {
  if(gapMs == 0 || address == 0) return true;
  for(uint8_t i = 0; i < 8; i++)
    if(g_remoteTx[i].address == address) return now - g_remoteTx[i].firstEnd >= gapMs;
  return true;
}
// Caller holds g_jobLock. Stops first, then the other orders in order of
// arrival. Orders go out as contiguous trains (queueCommand()); the repeat
// rank only serves a job queued with its repeats left to interleave.
static int8_t pickJob(uint32_t now, bool overBudget) {
  int8_t best = -1;
  uint8_t bestRank = 255;
  for(uint8_t i = 0; i < RADIO_MAX_JOBS; i++) {
    radio_job_t &j = g_jobs[i];
    if(!j.used || j.inFlight) continue;
    uint8_t rank;
    if(!j.firstSent) {
      if((int32_t)(now - j.notBefore) < 0) continue;
      if(j.kind == radio_job_kind_t::command && (olderJobPending(j) || !remoteGapElapsed(j.remoteAddress, j.gapMs, now))) continue;
      rank = j.urgent ? 0 : 1;
    }
    else {
      if(j.cancelRepeats || j.repeatsLeft == 0 || (int32_t)(now - j.nextSendAt) < 0) continue;
      rank = 2;
    }
    if(overBudget && rank != 0) continue;
    if(rank < bestRank) { best = i; bestRank = rank; continue; }
    if(rank != bestRank) continue;
    if(rank < 2 ? (int32_t)(j.id - g_jobs[best].id) < 0 : (int32_t)(j.nextSendAt - g_jobs[best].nextSendAt) < 0) best = i;
  }
  return best;
}
static int8_t jobSlot(uint32_t id) {
  for(uint8_t i = 0; i < RADIO_MAX_JOBS; i++) if(g_jobs[i].used && g_jobs[i].id == id) return i;
  return -1;
}
static void postTxEvent(uint32_t id, uint32_t when) {
  radio_tx_event_t evt;
  evt.jobId = id;
  evt.firstFrameEnd = when;
  if(g_txEvents) xQueueSend(g_txEvents, &evt, 0);
}
// Radio switched off: drop everything, releasing the shades that wait for a first frame.
static void dropAllJobs() {
  xSemaphoreTake(g_jobLock, portMAX_DELAY);
  for(uint8_t i = 0; i < RADIO_MAX_JOBS; i++) {
    if(!g_jobs[i].used) continue;
    if(!g_jobs[i].firstSent) postTxEvent(g_jobs[i].id, millis());
    g_jobs[i].used = false;
  }
  xSemaphoreGive(g_jobLock);
}
static uint32_t enqueueJob(Transceiver *radio, radio_job_t &job) {
  if(!radio->config.enabled || !g_jobLock) return 0;
  // An order must not go out on the scan frequency: end the scan here, where
  // the caller holds the shared-state lock its socket emit needs.
  if(rxmode == 3) radio->endFrequencyScan();
  const uint32_t deadline = millis() + 3000;
  for(;;) {
    xSemaphoreTake(g_jobLock, portMAX_DELAY);
    int8_t slot = -1;
    for(uint8_t i = 0; i < RADIO_MAX_JOBS; i++) if(!g_jobs[i].used) { slot = i; break; }
    if(slot >= 0) {
      job.id = g_nextJobId++;
      if(g_nextJobId == 0) g_nextJobId = 1;
      job.used = true;
      job.enqueuedAt = millis();
      if(job.kind == radio_job_kind_t::command) {
        // A newer order of this remote supersedes the repeats of the older ones
        // (their older rolling code would be ignored after it anyway). An older
        // order whose first frame has not gone yet still goes first.
        for(uint8_t i = 0; i < RADIO_MAX_JOBS; i++) {
          radio_job_t &o = g_jobs[i];
          if(!o.used || o.kind != radio_job_kind_t::command || o.remoteAddress != job.remoteAddress) continue;
          if(o.firstSent && !o.inFlight) o.used = false;
          else o.cancelRepeats = true;
        }
      }
      g_jobs[slot] = job;
      g_txStats.jobs++;
      const uint32_t id = job.id;
      xSemaphoreGive(g_jobLock);
      if(g_radioTask) xTaskNotifyGive(g_radioTask);
      return id;
    }
    xSemaphoreGive(g_jobLock);
    if((int32_t)(millis() - deadline) >= 0) {
      g_txStats.dropped++;
      Serial.println("Radio queue full: order dropped");
      return 0;
    }
    vTaskDelay(pdMS_TO_TICKS(10)); // the radio task needs no lock the caller holds
  }
}
uint32_t Transceiver::queueCommand(somfy_frame_t &frame, uint8_t repeats) {
  radio_job_t job;
  job.kind = radio_job_kind_t::command;
  job.remoteAddress = frame.remoteAddress;
  frame.encodeFrame(job.encoded);
  job.frame = frame; // plain copy: every field encode80BitFrame() needs
  job.bitLength = frame.bitLength;
  job.firstSync = frame.bitLength == 56 ? 2 : 12;
  job.repeatSync = frame.bitLength == 56 ? 7 : 6;
  job.repeatsLeft = repeats;
  job.ordinal = 1; // the first frame is ordinal 0; repeats continue from 1
  // Every order goes out as one contiguous train, frames ~27ms apart, the way a
  // remote sends a button press. Interleaving the repeats of several orders
  // left each one a lone first frame followed by its repeats at 140ms+
  // intervals between other shades' frames, and in bursts motors missed those
  // orders. A burst now takes longer (one train after the other) but each
  // order arrives whole.
  job.contiguous = true;
  // A short My/Stop is a stop; a long My press records the favorite position.
  job.urgent = repeats < TX_CONTIGUOUS_REPEATS && (frame.cmd == somfy_commands::My || frame.cmd == somfy_commands::Stop);
  job.gapMs = RADIO_SAME_REMOTE_GAP;
  this->lastQueuedJob = enqueueJob(this, job);
  return this->lastQueuedJob;
}
uint32_t Transceiver::queueContinuation(somfy_frame_t &frame, uint8_t repeats) {
  // More of the press in progress, as one contiguous train continuing its
  // 80-bit ordinals; no gap behind the frames it continues.
  radio_job_t job;
  job.kind = radio_job_kind_t::command;
  job.remoteAddress = frame.remoteAddress;
  frame.encodeFrame(job.encoded);
  frame.repeats++;
  job.ordinal = frame.repeats + 1;
  frame.repeats += repeats;
  job.frame = frame;
  job.bitLength = frame.bitLength;
  job.firstSync = frame.bitLength == 56 ? 2 : 12;
  job.repeatSync = frame.bitLength == 56 ? 7 : 6;
  job.repeatsLeft = repeats;
  job.contiguous = true;
  job.gapMs = 0;
  return enqueueJob(this, job);
}
void Transceiver::queueRaw(uint8_t hwsync, byte *payload, uint8_t bitLength) {
  radio_job_t job;
  job.kind = radio_job_kind_t::raw;
  memcpy(job.encoded, payload, sizeof(job.encoded));
  job.bitLength = bitLength;
  job.firstSync = hwsync;
  job.notBefore = millis() + TX_QUEUE_DELAY; // a full frame beat after the original
  enqueueJob(this, job);
}
bool Transceiver::popTxEvent(radio_tx_event_t &evt) {
  return g_txEvents != nullptr && xQueueReceive(g_txEvents, &evt, 0) == pdTRUE;
}
bool Transceiver::txIdle() {
  if(!g_jobLock) return true;
  xSemaphoreTake(g_jobLock, portMAX_DELAY);
  bool idle = true;
  for(uint8_t i = 0; i < RADIO_MAX_JOBS && idle; i++) if(g_jobs[i].used) idle = false;
  xSemaphoreGive(g_jobLock);
  return idle;
}
void Transceiver::suspendTx() {
  g_txSuspended = true;
  RadioGuard radio; // let a transmission in progress finish
}
void Transceiver::resumeTx() {
  g_txSuspended = false;
  this->enableReceive();
  if(g_radioTask) xTaskNotifyGive(g_radioTask);
}
void Transceiver::txStatsToJSON(JsonResponse &json) {
  uint8_t pending = 0;
  uint32_t airtime = 0;
  if(g_jobLock) {
    xSemaphoreTake(g_jobLock, portMAX_DELAY); // the airtime buckets are the radio task's too
    for(uint8_t i = 0; i < RADIO_MAX_JOBS; i++) if(g_jobs[i].used) pending++;
    airtime = airtimeLastHour(millis());
    xSemaphoreGive(g_jobLock);
  }
  json.addElem("jobs", g_txStats.jobs);
  json.addElem("frames", g_txStats.frames);
  json.addElem("pending", pending);
  json.addElem("lbtDeferred", g_txStats.lbtDeferred);
  json.addElem("lbtRx", g_txStats.lbtRx);
  json.addElem("lbtCarrier", g_txStats.lbtCarrier);
  json.addElem("lbtForced", g_txStats.lbtForced);
  json.addElem("dropped", g_txStats.dropped);
  json.addElem("delayLast", g_txStats.delayLast);
  json.addElem("delayMax", g_txStats.delayMax);
  json.addElem("airtimeHour", airtime);
}
bool Transceiver::radioStep() {
  if(!g_jobLock) return false;
  if(!this->config.enabled) { dropAllJobs(); return false; }
  if(g_txSuspended) return false;
  if(rxmode == 3) { g_scanAbortRequested = true; return false; }
  uint32_t now = millis();
  if(now - lastTxEnd < TX_FRAME_SILENCE) return false;
  // Pick, then listen without holding the job table: the RSSI read waits for the radio lock.
  xSemaphoreTake(g_jobLock, portMAX_DELAY);
  int8_t slot = pickJob(now, airtimeLastHour(now) >= RADIO_AIRTIME_BUDGET);
  const uint32_t id = slot >= 0 ? g_jobs[slot].id : 0;
  xSemaphoreGive(g_jobLock);
  if(slot < 0) return false;
  const uint8_t busy = channelBusy();
  radio_job_t job;
  xSemaphoreTake(g_jobLock, portMAX_DELAY);
  slot = jobSlot(id);
  if(slot < 0) { xSemaphoreGive(g_jobLock); return true; } // superseded meanwhile: pick again
  radio_job_t &j = g_jobs[slot];
  now = millis();
  if(busy) {
    if(j.lbtSince == 0) {
      j.lbtSince = now ? now : 1;
      g_txStats.lbtDeferred++;
      if(busy == 2) g_txStats.lbtCarrier++;
      else g_txStats.lbtRx++;
    }
    const uint32_t cap = busy == 2 ? RADIO_LBT_MAX_CARRIER : (j.urgent ? RADIO_LBT_MAX_URGENT : RADIO_LBT_MAX_RX);
    if(now - j.lbtSince < cap) { xSemaphoreGive(g_jobLock); return false; }
    g_txStats.lbtForced++;
  }
  j.inFlight = true;
  job = j;
  xSemaphoreGive(g_jobLock);

  const bool first = !job.firstSent;
  uint32_t firstEnd = 0;
  uint8_t frames = 0;
  const uint32_t txStart = millis();
  {
    RadioGuard radio;
    this->beginTransmit();
    if(job.kind == radio_job_kind_t::raw) {
      this->sendFrame(job.encoded, job.firstSync, job.bitLength);
      frames++;
    }
    else if(first) {
      this->sendFrame(job.encoded, job.firstSync, job.bitLength, job.contiguous);
      firstEnd = lastTxEnd;
      frames++;
      // Report now, not after a hold's whole train: the motor started here.
      postTxEvent(job.id, firstEnd);
      if(job.contiguous) {
        for(uint8_t i = 0; i < job.repeatsLeft; i++) {
          if(job.bitLength == 80) job.frame.encode80BitFrame(job.encoded, job.ordinal + i);
          this->sendFrame(job.encoded, job.repeatSync, job.bitLength, true);
          frames++;
        }
      }
    }
    else {
      if(job.bitLength == 80) job.frame.encode80BitFrame(job.encoded, job.ordinal);
      this->sendFrame(job.encoded, job.repeatSync, job.bitLength, false);
      frames++;
    }
    this->endTransmit();
  }
  const uint32_t txEnd = millis();

  xSemaphoreTake(g_jobLock, portMAX_DELAY);
  g_txStats.frames += frames;
  airtimeLastHour(txEnd);
  g_airtime[g_airtimeMinute % 60] += txEnd - txStart;
  slot = jobSlot(id);
  if(slot >= 0) {
    radio_job_t &d = g_jobs[slot];
    d.inFlight = false;
    d.lbtSince = 0;
    if(first && d.kind == radio_job_kind_t::command) {
      d.firstSent = true;
      noteFirstFrame(d.remoteAddress, firstEnd);
      g_txStats.delayLast = firstEnd - d.enqueuedAt;
      if(g_txStats.delayLast > g_txStats.delayMax) g_txStats.delayMax = g_txStats.delayLast;
    }
    else if(!first) {
      if(d.repeatsLeft > 0) d.repeatsLeft--;
      d.ordinal++;
    }
    if(d.kind == radio_job_kind_t::raw || d.contiguous || d.cancelRepeats || d.repeatsLeft == 0) d.used = false;
    else d.nextSendAt = txEnd + TX_REPEAT_GAP;
  }
  xSemaphoreGive(g_jobLock);
  return true;
}
