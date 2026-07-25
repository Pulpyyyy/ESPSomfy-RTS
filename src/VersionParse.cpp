#include "VersionParse.h"
#include <ctype.h>
#include <string.h>

// Reads the next numeric part of a version string starting at *pos and stops on
// the '.' separator or at the end of the string. Digits are accumulated straight
// into an integer rather than into a scratch char buffer, which is what used to
// be handed to atoi() without room for its terminator. When stopOnNonDigit is
// set the part ends at the first non numeric character (the suffix separator),
// otherwise non numeric characters are skipped (the leading "v", ...).
static uint8_t parseVersionPart(const char *ver, size_t len, size_t *pos, bool stopOnNonDigit) {
  uint16_t val = 0;
  uint8_t digits = 0;
  while(*pos < len) {
    char ch = ver[(*pos)++];
    if(ch == '.') break;
    if(!isdigit(static_cast<unsigned char>(ch))) {
      if(stopOnNonDigit) break;
      continue;
    }
    if(digits < 3) {
      val = static_cast<uint16_t>((val * 10) + (ch - '0'));
      digits++;
    }
  }
  return static_cast<uint8_t>(val & 0xFF);
}

void parseVersion(const char *ver, version_t &out) {
  out = version_t();
  if(!ver) return;
  const size_t len = strlen(ver);
  size_t i = 0;
  out.major = parseVersionPart(ver, len, &i, false);
  out.minor = parseVersionPart(ver, len, &i, false);
  out.build = parseVersionPart(ver, len, &i, true);
  if(i < len) {
    strncpy(out.suffix, &ver[i], sizeof(out.suffix) - 1);
    out.suffix[sizeof(out.suffix) - 1] = '\0';
  }
}

int8_t compareVersion(const version_t &a, const version_t &b) {
  if(a.major == b.major && a.minor == b.minor && a.build == b.build) return 0;
  if(a.major > b.major) return 1;
  else if(a.major < b.major) return -1;
  else {
    if(a.minor > b.minor) return 1;
    else if(a.minor < b.minor) return -1;
    else {
      if(a.build > b.build) return 1;
      else if(a.build < b.build) return -1;
    }
  }
  return 0;
}
