#ifndef TEXTCUT_H
#define TEXTCUT_H
#include <stddef.h>

// Length of the longest prefix of s[0..len) that does not end inside a UTF-8
// character. Names live in fixed byte buffers (shades.cfg records), so a cut at
// the buffer size can land between the bytes of an accented letter; dropping
// that partial letter keeps the stored text valid UTF-8.
static inline size_t textCutLen(const char *s, size_t len) {
  size_t start = len;
  // Step back over at most three continuation bytes (10xxxxxx).
  while(start > 0 && len - start < 3 && (static_cast<unsigned char>(s[start - 1]) & 0xC0) == 0x80) start--;
  if(start == 0) return len;
  unsigned char lead = static_cast<unsigned char>(s[start - 1]);
  size_t need = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1;
  // The character that begins at start - 1 needs more bytes than remain.
  if(need > 1 && len - (start - 1) < need) return start - 1;
  return len;
}

#endif
