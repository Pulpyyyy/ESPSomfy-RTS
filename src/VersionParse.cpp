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

// Natural order of two pre-release suffixes: digit runs compare as numbers,
// any other character by its code. Comparing them as plain strings put beta.10
// below beta.9.
static int8_t compareSuffix(const char *a, const char *b) {
  while(*a && *b) {
    if(isdigit(static_cast<unsigned char>(*a)) && isdigit(static_cast<unsigned char>(*b))) {
      uint32_t na = 0, nb = 0;
      while(isdigit(static_cast<unsigned char>(*a))) { if(na < 100000) na = na * 10 + (*a - '0'); a++; }
      while(isdigit(static_cast<unsigned char>(*b))) { if(nb < 100000) nb = nb * 10 + (*b - '0'); b++; }
      if(na != nb) return na > nb ? 1 : -1;
      continue;
    }
    if(*a != *b) return static_cast<unsigned char>(*a) > static_cast<unsigned char>(*b) ? 1 : -1;
    a++; b++;
  }
  if(*a) return 1;   // longer with an equal start ranks higher: rc1.1 > rc1
  if(*b) return -1;
  return 0;
}

int8_t compareVersion(const version_t &a, const version_t &b) {
  if(a.major == b.major && a.minor == b.minor && a.build == b.build) {
    // Same numbers: the suffix decides. It used to take no part, so a device
    // on 4.1.0-beta.10 saw the 4.1.0 release as its own version and was never
    // offered the update.
    const bool aPre = a.suffix[0] != '\0', bPre = b.suffix[0] != '\0';
    if(aPre != bPre) return aPre ? -1 : 1; // a release ranks above its pre-releases
    return compareSuffix(a.suffix, b.suffix);
  }
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
