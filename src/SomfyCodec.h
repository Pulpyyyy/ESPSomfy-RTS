#ifndef somfycodec_h
#define somfycodec_h
#include <stdint.h>

// Bit level encoding of a Somfy RTS payload, split out of Somfy.cpp so it can
// be unit tested on the host: nothing here touches the radio, Arduino or the
// shade state. A mistake in these few lines produces frames a motor silently
// ignores, which is impossible to tell apart from a range problem in the field.
namespace somfy_codec {
  // Bytes 1..6 travel XOR chained with their predecessor. Byte 0 (the
  // encryption key) and, on an 80 bit frame, bytes 7..9 travel in clear.
  static const uint8_t OBFUSCATED_LAST = 6;
  static const uint8_t FRAME_LEN_56 = 7;
  static const uint8_t FRAME_LEN_80 = 10;

  // Applies the XOR chain in place over bytes 1..6 of a frame being sent.
  void obfuscate(uint8_t *frame);
  // Reverses it. `len` is 7 for a 56 bit frame, 10 for an 80 bit one; the bytes
  // past the chain are copied verbatim. `frame` and `decoded` must not overlap.
  void deobfuscate(const uint8_t *frame, uint8_t *decoded, uint8_t len);

  // The 4 bit checksum sits in the low nibble of byte 1.
  // On a received (already deobfuscated) frame that nibble carries the checksum
  // itself, so the command byte contributes only its high nibble.
  uint8_t checksumDecoded(const uint8_t *decoded);
  // On a frame being built the nibble is still zero, so the plain XOR is used.
  // Both forms yield the same value for a well formed frame.
  uint8_t checksumPlain(const uint8_t *frame);

  // Parity nibble over the three extension bytes of an 80 bit RTS frame.
  uint8_t checksum80(uint8_t b0, uint8_t b1, uint8_t b2);
  // Byte 7 of an 80 bit frame folds the repeat counter into a base value.
  uint8_t encode80Byte7(uint8_t start, uint8_t repeat);
}
#endif
