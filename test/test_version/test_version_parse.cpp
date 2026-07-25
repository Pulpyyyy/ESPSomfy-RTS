// Unit tests for the version reader behind the GitHub OTA check
// (src/VersionParse.cpp, used by appver_t in src/ConfigSettings.cpp).
// A mis-read tag either hides an available update or offers a downgrade, and
// neither symptom is visible from the device.
#include <unity.h>

#include <string.h>

#include "VersionParse.h"

void setUp(void) {}
void tearDown(void) {}

static version_t parsed(const char *s) {
  version_t v;
  parseVersion(s, v);
  return v;
}

static void assertVersion(const char *s, uint8_t major, uint8_t minor, uint8_t build) {
  version_t v = parsed(s);
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(major, v.major, s);
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(minor, v.minor, s);
  TEST_ASSERT_EQUAL_UINT8_MESSAGE(build, v.build, s);
}

// ------------------------------------------------------------------- parsing

static void test_parses_a_release_tag(void) {
  assertVersion("v3.1.0", 3, 1, 0);
  assertVersion("3.1.0", 3, 1, 0);
  assertVersion("v2.6.12", 2, 6, 12);
}

static void test_missing_components_default_to_zero(void) {
  assertVersion("v3", 3, 0, 0);
  assertVersion("v3.1", 3, 1, 0);
  assertVersion("", 0, 0, 0);
}

static void test_multi_digit_components(void) {
  assertVersion("v10.20.30", 10, 20, 30);
  assertVersion("v12.34.56", 12, 34, 56);
  // Three digits used to be the sore point: the scratch buffer held exactly
  // three bytes with no room for its terminator, so atoi() read past its end.
  assertVersion("v100.200.250", 100, 200, 250);
}

// Every component is truncated to 8 bits, which is what the firmware has always
// done. Recorded so a future tag scheme does not wrap unnoticed.
static void test_components_are_truncated_to_eight_bits(void) {
  assertVersion("v256.0.0", 0, 0, 0);
  assertVersion("v300.0.0", 44, 0, 0);
}

// A pre-release tag must still yield the numeric part, otherwise the OTA sees
// 0.0.0 and offers the release as an upgrade over anything.
static void test_pre_release_tag_keeps_the_numbers(void) {
  assertVersion("v3.1.0-rc1", 3, 1, 0);
  assertVersion("v3.1.4-beta", 3, 1, 4);
}

// The suffix field is four bytes including the terminator, and appver_t
// publishes it as-is in its JSON. A longer tag must be truncated, never spill.
static void test_suffix_is_captured_and_bounded(void) {
  TEST_ASSERT_EQUAL_STRING("rc1", parsed("v3.1.0-rc1").suffix);
  TEST_ASSERT_EQUAL_STRING("bet", parsed("v3.1.4-beta").suffix);
  TEST_ASSERT_EQUAL_STRING("rel", parsed("v3.1.0-releasecandidate").suffix);
  TEST_ASSERT_EQUAL_STRING("", parsed("v3.1.0").suffix);
}

static void test_null_input_is_safe(void) {
  version_t v;
  v.major = 9; v.minor = 9; v.build = 9;
  parseVersion(NULL, v);
  TEST_ASSERT_EQUAL_UINT8(0, v.major);
  TEST_ASSERT_EQUAL_UINT8(0, v.minor);
  TEST_ASSERT_EQUAL_UINT8(0, v.build);
}

static void test_garbage_does_not_produce_a_version(void) {
  assertVersion("not-a-version", 0, 0, 0);
  assertVersion("vvvv", 0, 0, 0);
}

// The output must not depend on leftovers from a previous call: appver_t reuses
// the same instance for every release in the list.
static void test_parsing_resets_the_target(void) {
  version_t v;
  parseVersion("v4.5.6", v);
  parseVersion("v1", v);
  TEST_ASSERT_EQUAL_UINT8(1, v.major);
  TEST_ASSERT_EQUAL_UINT8(0, v.minor);
  TEST_ASSERT_EQUAL_UINT8(0, v.build);
}

// ---------------------------------------------------------------- comparison

static void test_compare_orders_on_major_then_minor_then_build(void) {
  TEST_ASSERT_EQUAL_INT8(0, compareVersion(parsed("v3.1.0"), parsed("v3.1.0")));
  TEST_ASSERT_EQUAL_INT8(1, compareVersion(parsed("v4.0.0"), parsed("v3.9.9")));
  TEST_ASSERT_EQUAL_INT8(-1, compareVersion(parsed("v3.9.9"), parsed("v4.0.0")));
  TEST_ASSERT_EQUAL_INT8(1, compareVersion(parsed("v3.2.0"), parsed("v3.1.9")));
  TEST_ASSERT_EQUAL_INT8(-1, compareVersion(parsed("v3.1.9"), parsed("v3.2.0")));
  TEST_ASSERT_EQUAL_INT8(1, compareVersion(parsed("v3.1.2"), parsed("v3.1.1")));
  TEST_ASSERT_EQUAL_INT8(-1, compareVersion(parsed("v3.1.1"), parsed("v3.1.2")));
}

// The comparison is used both ways round by the update check, so it has to be
// antisymmetric over the whole range it can see.
static void test_compare_is_antisymmetric(void) {
  const char *tags[] = {"v0.0.0", "v0.0.1", "v0.1.0", "v1.0.0", "v2.6.12", "v3.1.0", "v12.34.56"};
  const size_t n = sizeof(tags) / sizeof(tags[0]);
  for(size_t i = 0; i < n; i++) {
    for(size_t j = 0; j < n; j++) {
      int8_t forward = compareVersion(parsed(tags[i]), parsed(tags[j]));
      int8_t backward = compareVersion(parsed(tags[j]), parsed(tags[i]));
      TEST_ASSERT_EQUAL_INT8(-forward, backward);
      if(i == j) TEST_ASSERT_EQUAL_INT8(0, forward);
    }
  }
}

// The suffix takes no part in the ordering: v3.1.0-rc1 and v3.1.0 compare equal
// and the OTA will not offer one over the other.
static void test_pre_release_compares_equal_to_the_release(void) {
  TEST_ASSERT_EQUAL_INT8(0, compareVersion(parsed("v3.1.0-rc1"), parsed("v3.1.0")));
}

int main(int, char **) {
  UNITY_BEGIN();
  RUN_TEST(test_parses_a_release_tag);
  RUN_TEST(test_missing_components_default_to_zero);
  RUN_TEST(test_multi_digit_components);
  RUN_TEST(test_components_are_truncated_to_eight_bits);
  RUN_TEST(test_pre_release_tag_keeps_the_numbers);
  RUN_TEST(test_suffix_is_captured_and_bounded);
  RUN_TEST(test_null_input_is_safe);
  RUN_TEST(test_garbage_does_not_produce_a_version);
  RUN_TEST(test_parsing_resets_the_target);
  RUN_TEST(test_compare_orders_on_major_then_minor_then_build);
  RUN_TEST(test_compare_is_antisymmetric);
  RUN_TEST(test_pre_release_compares_equal_to_the_release);
  return UNITY_END();
}
