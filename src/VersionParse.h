#ifndef versionparse_h
#define versionparse_h
#include <stddef.h>
#include <stdint.h>

// Version parsing and ordering used by the GitHub OTA check (GitOTA.cpp) through
// appver_t (ConfigSettings.h). Kept free of Arduino so it can be unit tested on
// the host: an OTA that mis-reads a tag either offers a downgrade or hides an
// available update, and neither is visible from the device.
struct version_t {
  uint8_t major = 0;
  uint8_t minor = 0;
  uint8_t build = 0;
  // Pre-release part after the separator ("beta.10", "rc1"), empty on a release.
  char suffix[16] = "";
};

// Reads "v3.1.0", "3.1.0", "3.1", ... A leading non-digit prefix is skipped and
// each component is capped at three digits, then truncated to 8 bits. Anything
// that cannot be read leaves the corresponding field at 0.
void parseVersion(const char *ver, version_t &out);

// -1 / 0 / 1 on major, then minor, then build, then the pre-release suffix: a
// release ranks above its own pre-releases (4.1.0 > 4.1.0-rc1 > 4.1.0-beta.10),
// and two suffixes compare in natural order, digit runs as numbers (beta.10 >
// beta.9, rc10 > rc9) and everything else character by character.
int8_t compareVersion(const version_t &a, const version_t &b);
#endif
