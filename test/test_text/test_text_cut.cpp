// Unit tests for textCutLen (src/TextCut.h): shade, group and room names live
// in 20-byte buffers, and a cut must never stop inside a UTF-8 character.
#include <unity.h>

#include <string.h>

#include "TextCut.h"

void setUp(void) {}
void tearDown(void) {}

static size_t cutAt(const char *s, size_t len) { return textCutLen(s, len); }

static void test_ascii_is_kept_whole(void) {
  TEST_ASSERT_EQUAL_UINT32(5, cutAt("Salon", 5));
  TEST_ASSERT_EQUAL_UINT32(3, cutAt("Salon", 3));
  TEST_ASSERT_EQUAL_UINT32(0, cutAt("", 0));
}

static void test_complete_two_byte_letter_is_kept(void) {
  // "Séjour": S, then e-acute on two bytes.
  const char *s = "S\xC3\xA9jour";
  TEST_ASSERT_EQUAL_UINT32(3, cutAt(s, 3));
}

static void test_lone_lead_byte_is_dropped(void) {
  const char *s = "S\xC3\xA9jour";
  TEST_ASSERT_EQUAL_UINT32(1, cutAt(s, 2));
}

static void test_partial_three_and_four_byte_characters_are_dropped(void) {
  const char *euro = "a\xE2\x82\xAC";       // a + euro sign
  TEST_ASSERT_EQUAL_UINT32(4, cutAt(euro, 4));
  TEST_ASSERT_EQUAL_UINT32(1, cutAt(euro, 3));
  TEST_ASSERT_EQUAL_UINT32(1, cutAt(euro, 2));
  const char *emoji = "a\xF0\x9F\x8F\xA0";  // a + house
  TEST_ASSERT_EQUAL_UINT32(5, cutAt(emoji, 5));
  TEST_ASSERT_EQUAL_UINT32(1, cutAt(emoji, 4));
}

static void test_twenty_byte_name_cut_inside_a_letter(void) {
  // "Salle de bain d'été" + "x": the 20-byte limit splits the second e-acute.
  const char *s = "Salle de bain d'\xC3\xA9t\xC3\xA9x";
  TEST_ASSERT_EQUAL_UINT32(19, cutAt(s, 20));
}

static void test_repair_of_a_stored_name(void) {
  // A name saved by older firmware, ending on a lone lead byte.
  char name[21] = "Chambre d'amis \xC3";
  name[textCutLen(name, strlen(name))] = '\0';
  TEST_ASSERT_EQUAL_STRING("Chambre d'amis ", name);
}

int main(int, char **) {
  UNITY_BEGIN();
  RUN_TEST(test_ascii_is_kept_whole);
  RUN_TEST(test_complete_two_byte_letter_is_kept);
  RUN_TEST(test_lone_lead_byte_is_dropped);
  RUN_TEST(test_partial_three_and_four_byte_characters_are_dropped);
  RUN_TEST(test_twenty_byte_name_cut_inside_a_letter);
  RUN_TEST(test_repair_of_a_stored_name);
  return UNITY_END();
}
