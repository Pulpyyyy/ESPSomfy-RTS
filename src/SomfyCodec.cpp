#include "SomfyCodec.h"

namespace somfy_codec {

void obfuscate(uint8_t *frame) {
  for(uint8_t i = 1; i <= OBFUSCATED_LAST; i++) frame[i] ^= frame[i - 1];
}

void deobfuscate(const uint8_t *frame, uint8_t *decoded, uint8_t len) {
  if(len == 0) return;
  decoded[0] = frame[0];
  for(uint8_t i = 1; i < len; i++)
    decoded[i] = (i <= OBFUSCATED_LAST) ? static_cast<uint8_t>(frame[i] ^ frame[i - 1]) : frame[i];
}

uint8_t checksumDecoded(const uint8_t *decoded) {
  uint8_t checksum = 0;
  // Only the upper nibble of the command byte: the lower one holds the checksum.
  for(uint8_t i = 0; i < 7; i++) {
    if(i == 1) checksum = checksum ^ (decoded[i] >> 4);
    else checksum = checksum ^ decoded[i] ^ (decoded[i] >> 4);
  }
  return checksum & 0b1111;
}

uint8_t checksumPlain(const uint8_t *frame) {
  uint8_t checksum = 0;
  for(uint8_t i = 0; i < 7; i++) checksum = checksum ^ frame[i] ^ (frame[i] >> 4);
  return checksum & 0b1111;
}

uint8_t checksum80(uint8_t b0, uint8_t b1, uint8_t b2) {
  uint8_t cs80 = 0;
  cs80 = (((b0 & 0xF0) >> 4) ^ ((b1 & 0xF0) >> 4));
  cs80 ^= ((b2 & 0xF0) >> 4);
  cs80 ^= (b0 & 0x0F);
  cs80 ^= (b1 & 0x0F);
  return cs80;
}

uint8_t encode80Byte7(uint8_t start, uint8_t repeat) {
  while((repeat * 4) + start > 255) repeat -= 15;
  return start + (repeat * 4);
}

}  // namespace somfy_codec
