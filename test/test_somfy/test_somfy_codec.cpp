// Unit tests for the Somfy RTS bit level codec (src/SomfyCodec.cpp), used by
// somfy_frame_t::encodeFrame() and ::decodeFrame(). A mistake here produces
// frames a motor silently ignores, or drops valid frames on reception, and
// neither is distinguishable from a radio range problem in the field.
#include <unity.h>

#include <string.h>

#include "SomfyCodec.h"

void setUp(void) {}
void tearDown(void) {}

// Mirrors the payload layout somfy_frame_t::encodeFrame() builds for a 56 bit
// RTS frame, so the primitives are exercised the way the firmware composes them.
static void buildFrame(uint8_t *frame, uint8_t cmd, uint16_t rollingCode,
                       uint32_t address, uint8_t encKey = 0xA7) {
  frame[0] = encKey;
  frame[1] = (uint8_t)((cmd & 0x0F) << 4);
  frame[2] = (uint8_t)(rollingCode >> 8);
  frame[3] = (uint8_t)rollingCode;
  frame[4] = (uint8_t)(address >> 16);
  frame[5] = (uint8_t)(address >> 8);
  frame[6] = (uint8_t)address;
  frame[7] = 132;
  frame[8] = 0;
  frame[9] = 29;
  frame[1] |= somfy_codec::checksumPlain(frame);
  somfy_codec::obfuscate(frame);
}

// ------------------------------------------------------------- obfuscation

// Golden vector: cmd Up (0x2), rolling code 0x0102, address 0x123456, default
// encryption key. Frozen so a reordering of the checksum and the XOR chain in
// encodeFrame() cannot pass unnoticed.
static void test_known_frame_is_encoded_byte_for_byte(void) {
  uint8_t frame[10];
  buildFrame(frame, 0x2, 0x0102, 0x123456);
  const uint8_t expected[7] = {0xA7, 0x8C, 0x8D, 0x8F, 0x9D, 0xA9, 0xFF};
  TEST_ASSERT_EQUAL_UINT8_ARRAY(expected, frame, 7);
}

static void test_deobfuscate_reverses_obfuscate(void) {
  uint8_t frame[10];
  buildFrame(frame, 0x2, 0x0102, 0x123456);
  uint8_t decoded[10];
  somfy_codec::deobfuscate(frame, decoded, somfy_codec::FRAME_LEN_56);
  const uint8_t expected[7] = {0xA7, 0x2B, 0x01, 0x02, 0x12, 0x34, 0x56};
  TEST_ASSERT_EQUAL_UINT8_ARRAY(expected, decoded, 7);
}

// On an 80 bit frame the three extension bytes are sent in clear: the XOR chain
// must stop at byte 6 or the step size and the 80 bit checksum are destroyed.
static void test_extension_bytes_are_not_obfuscated(void) {
  uint8_t frame[10];
  buildFrame(frame, 0x8, 0x0001, 0x000001);
  frame[7] = 0xAB;
  frame[8] = 0xCD;
  frame[9] = 0xEF;
  uint8_t decoded[10];
  somfy_codec::deobfuscate(frame, decoded, somfy_codec::FRAME_LEN_80);
  TEST_ASSERT_EQUAL_UINT8(0xAB, decoded[7]);
  TEST_ASSERT_EQUAL_UINT8(0xCD, decoded[8]);
  TEST_ASSERT_EQUAL_UINT8(0xEF, decoded[9]);
}

static void test_obfuscate_leaves_the_key_byte_alone(void) {
  uint8_t frame[10];
  memset(frame, 0, sizeof(frame));
  frame[0] = 0xA7;
  somfy_codec::obfuscate(frame);
  TEST_ASSERT_EQUAL_UINT8(0xA7, frame[0]);
}

// ---------------------------------------------------------------- checksums

// The transmitter computes the checksum on a frame whose low nibble of byte 1
// is still zero; the receiver computes it on a frame where that nibble carries
// the checksum. The two formulas differ and must nevertheless agree, otherwise
// every frame this firmware sends is rejected by the next one that reads it.
static void test_transmit_and_receive_checksums_agree(void) {
  uint8_t frame[10];
  uint8_t decoded[10];
  for(uint8_t cmd = 0; cmd < 16; cmd++) {
    const uint16_t codes[] = {1, 0x1234, 0xFFFF};
    const uint32_t addrs[] = {1, 0x123456, 0xFFFFFE};
    for(size_t c = 0; c < 3; c++) {
      for(size_t a = 0; a < 3; a++) {
        buildFrame(frame, cmd, codes[c], addrs[a]);
        somfy_codec::deobfuscate(frame, decoded, somfy_codec::FRAME_LEN_56);
        TEST_ASSERT_EQUAL_UINT8(decoded[1] & 0x0F, somfy_codec::checksumDecoded(decoded));
      }
    }
  }
}

// The payload itself must survive the round trip, in the byte order
// decodeFrame() reads it back in.
static void test_address_command_and_rolling_code_survive_the_round_trip(void) {
  uint8_t frame[10];
  uint8_t decoded[10];
  const uint16_t rollingCode = 0x1234;
  const uint32_t address = 0xFEDCBA;
  buildFrame(frame, 0x4, rollingCode, address);
  somfy_codec::deobfuscate(frame, decoded, somfy_codec::FRAME_LEN_56);
  TEST_ASSERT_EQUAL_UINT8(0x4, decoded[1] >> 4);
  TEST_ASSERT_EQUAL_UINT16(rollingCode, (uint16_t)(decoded[3] + (decoded[2] << 8)));
  TEST_ASSERT_EQUAL_UINT32(address, (uint32_t)(decoded[6] + (decoded[5] << 8) + (decoded[4] << 16)));
}

// Any single bit changed in the decoded payload - a different address, a
// different rolling code - must break the checksum, otherwise a corrupted frame
// drives the wrong shade.
static void test_a_corrupted_payload_fails_its_checksum(void) {
  uint8_t frame[10];
  uint8_t decoded[10];
  int detected = 0;
  int total = 0;
  for(uint8_t byteIndex = 2; byteIndex < 7; byteIndex++) {
    for(uint8_t bit = 0; bit < 8; bit++) {
      buildFrame(frame, 0x2, 0x0102, 0x123456);
      somfy_codec::deobfuscate(frame, decoded, somfy_codec::FRAME_LEN_56);
      decoded[byteIndex] ^= (uint8_t)(1 << bit);
      total++;
      if(somfy_codec::checksumDecoded(decoded) != (decoded[1] & 0x0F)) detected++;
    }
  }
  TEST_ASSERT_EQUAL_INT(total, detected);
}

// NOTE: this records a property of the RTS protocol, not a defect of this code.
// A bit flipped on air lands in two consecutive decoded bytes at the same
// position, and the two contributions cancel in the nibble checksum, so only a
// flip in the last chained byte is caught. Anything relying on this checksum to
// reject radio noise (repeat counting, rolling code acceptance) has to allow
// for it.
static void test_the_checksum_does_not_catch_flips_in_the_obfuscated_stream(void) {
  uint8_t frame[10];
  uint8_t decoded[10];
  int detected = 0;
  for(uint8_t byteIndex = 2; byteIndex < 7; byteIndex++) {
    for(uint8_t bit = 0; bit < 8; bit++) {
      buildFrame(frame, 0x2, 0x0102, 0x123456);
      frame[byteIndex] ^= (uint8_t)(1 << bit);
      somfy_codec::deobfuscate(frame, decoded, somfy_codec::FRAME_LEN_56);
      if(somfy_codec::checksumDecoded(decoded) != (decoded[1] & 0x0F)) detected++;
    }
  }
  // Only the eight flips of the last chained byte are caught, out of forty.
  TEST_ASSERT_EQUAL_INT(8, detected);
}

// ------------------------------------------------------------ 80 bit frames

static void test_checksum80_known_values(void) {
  // The two combinations encode80BitFrame() emits for Stop and for My.
  TEST_ASSERT_EQUAL_UINT8(0x0D, somfy_codec::checksum80(132, 0, 0x10));
  TEST_ASSERT_EQUAL_UINT8(0x0F, somfy_codec::checksum80(196, 44, 0x90));
  TEST_ASSERT_EQUAL_UINT8(0x00, somfy_codec::checksum80(0, 0, 0));
  TEST_ASSERT_EQUAL_UINT8(0x0F, somfy_codec::checksum80(0xFF, 0xFF, 0xFF));
}

// encode80BitFrame() ORs the result straight into the low nibble of the very
// byte it passes as b2, and decodeFrame() then recomputes it on the received
// byte with that nibble present. The two only agree because the low nibble of
// b2 takes no part in the sum. If that ever changes, every 80 bit frame this
// firmware sends becomes invalid on reception.
static void test_checksum80_ignores_the_low_nibble_of_the_last_byte(void) {
  for(int b0 = 0; b0 < 256; b0 += 7) {
    for(int b1 = 0; b1 < 256; b1 += 11) {
      for(int b2 = 0; b2 < 256; b2 += 13) {
        uint8_t withNibble = somfy_codec::checksum80((uint8_t)b0, (uint8_t)b1, (uint8_t)b2);
        uint8_t withoutNibble = somfy_codec::checksum80((uint8_t)b0, (uint8_t)b1, (uint8_t)(b2 & 0xF0));
        TEST_ASSERT_EQUAL_UINT8(withoutNibble, withNibble);
        TEST_ASSERT_TRUE(withNibble <= 0x0F);
      }
    }
  }
}

// The repeat counter is folded into byte 7 in steps of 4 and wraps by 15 so the
// byte never exceeds 255. Frozen for the repeat range the transmitter uses.
static void test_encode80_byte7_folds_the_repeat_counter(void) {
  TEST_ASSERT_EQUAL_UINT8(196, somfy_codec::encode80Byte7(196, 0));
  TEST_ASSERT_EQUAL_UINT8(200, somfy_codec::encode80Byte7(196, 1));
  TEST_ASSERT_EQUAL_UINT8(216, somfy_codec::encode80Byte7(196, 5));
  TEST_ASSERT_EQUAL_UINT8(252, somfy_codec::encode80Byte7(196, 14));
  // 15 * 4 + 196 would overflow, so the counter wraps back to 0.
  TEST_ASSERT_EQUAL_UINT8(196, somfy_codec::encode80Byte7(196, 15));
  TEST_ASSERT_EQUAL_UINT8(200, somfy_codec::encode80Byte7(196, 16));
  TEST_ASSERT_EQUAL_UINT8(132, somfy_codec::encode80Byte7(132, 0));
  TEST_ASSERT_EQUAL_UINT8(188, somfy_codec::encode80Byte7(132, 14));
}

int main(int, char **) {
  UNITY_BEGIN();
  RUN_TEST(test_known_frame_is_encoded_byte_for_byte);
  RUN_TEST(test_deobfuscate_reverses_obfuscate);
  RUN_TEST(test_extension_bytes_are_not_obfuscated);
  RUN_TEST(test_obfuscate_leaves_the_key_byte_alone);
  RUN_TEST(test_transmit_and_receive_checksums_agree);
  RUN_TEST(test_address_command_and_rolling_code_survive_the_round_trip);
  RUN_TEST(test_a_corrupted_payload_fails_its_checksum);
  RUN_TEST(test_the_checksum_does_not_catch_flips_in_the_obfuscated_stream);
  RUN_TEST(test_checksum80_known_values);
  RUN_TEST(test_checksum80_ignores_the_low_nibble_of_the_last_byte);
  RUN_TEST(test_encode80_byte7_folds_the_repeat_counter);
  return UNITY_END();
}
