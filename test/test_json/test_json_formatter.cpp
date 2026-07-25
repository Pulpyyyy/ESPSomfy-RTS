// Unit tests for the JSON serialiser behind every HTTP response and every
// websocket event (src/JsonFormatter.cpp). The output buffer is fixed size and
// shared, so the interesting properties are the bounds, not the happy path.
#include <unity.h>

#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "JsonFormatter.h"

// JsonFormatter is meant to be subclassed by a transport (JsonResponse,
// JsonSockEvent). This stand-in exposes the protected buffer and _safecat so
// the base behaviour can be exercised without a WebServer.
class TestFormatter : public JsonFormatter {
  public:
    void begin(char *b, size_t sz) {
      this->buff = b;
      this->buffSize = sz;
      this->buff[0] = '\0';
      this->_nocomma = true;
      this->_objects = 0;
      this->_arrays = 0;
      this->_headersSent = false;
    }
    void cat(const char *val, bool escape = false) { this->_safecat(val, escape); }
};

static char buffer[512];
static TestFormatter fmt;

void setUp(void) {
  memset(buffer, 0, sizeof(buffer));
  fmt.begin(buffer, sizeof(buffer));
}
void tearDown(void) {}

// ---------------------------------------------------------------- escapeString

static void test_escape_leaves_plain_text_untouched(void) {
  char out[64];
  size_t written = fmt.escapeString("hello world", out);
  TEST_ASSERT_EQUAL_STRING("hello world", out);
  TEST_ASSERT_EQUAL_UINT32(11, (uint32_t)written);
}

static void test_escape_covers_every_special_character(void) {
  char out[64];
  size_t written = fmt.escapeString("\"/\b\f\n\r\t\\", out);
  TEST_ASSERT_EQUAL_STRING("\\\"\\/\\b\\f\\n\\r\\t\\\\", out);
  // Eight escaped characters, two bytes each.
  TEST_ASSERT_EQUAL_UINT32(16, (uint32_t)written);
}

static void test_escape_of_empty_string(void) {
  char out[4] = {'x', 'x', 'x', 'x'};
  TEST_ASSERT_EQUAL_UINT32(0, (uint32_t)fmt.escapeString("", out));
  TEST_ASSERT_EQUAL_STRING("", out);
}

// The return value is what _safecat uses to advance its write pointer. If it
// ever disagreed with the number of bytes actually written, the closing quote
// would land inside the value or past the terminator.
static void test_escape_return_matches_bytes_written(void) {
  const char *samples[] = {"", "a", "\"", "a\"b", "\\\\", "line1\nline2", "a/b/c", "\t\t\t"};
  char out[128];
  for(size_t i = 0; i < sizeof(samples) / sizeof(samples[0]); i++) {
    size_t written = fmt.escapeString(samples[i], out);
    TEST_ASSERT_EQUAL_UINT32((uint32_t)strlen(out), (uint32_t)written);
  }
}

// ----------------------------------------------------------- calcEscapedLength

// calcEscapedLength is the bound _safecat trusts before writing, so it must
// never under-count - in particular not for a special character in first
// position, an off-by-one that used to let the value run past the buffer.
static void test_escaped_length_matches_escape_output(void) {
  const char *samples[] = {"", "a", "\"", "\"abc", "abc\"", "a\"b", "\\", "\n\n\n",
                           "no specials here", "/leading slash", "trailing\t"};
  char out[128];
  for(size_t i = 0; i < sizeof(samples) / sizeof(samples[0]); i++) {
    uint32_t predicted = fmt.calcEscapedLength(samples[i]);
    uint32_t actual = (uint32_t)fmt.escapeString(samples[i], out);
    TEST_ASSERT_EQUAL_UINT32(actual, predicted);
  }
}

static void test_escaped_length_counts_the_first_character(void) {
  TEST_ASSERT_EQUAL_UINT32(2, fmt.calcEscapedLength("\""));
  TEST_ASSERT_EQUAL_UINT32(5, fmt.calcEscapedLength("\"abc"));
}

// ------------------------------------------------------------------- _safecat

static void test_safecat_appends_and_quotes(void) {
  fmt.cat("{");
  fmt.cat("name", true);
  fmt.cat(":");
  fmt.cat("value", true);
  fmt.cat("}");
  TEST_ASSERT_EQUAL_STRING("{\"name\":\"value\"}", buffer);
}

// A value that does not fit is dropped whole: the buffer must stay exactly as
// it was, still terminated, never truncated mid-escape.
static void test_safecat_drops_a_value_that_does_not_fit(void) {
  char small[16];
  TestFormatter f;
  f.begin(small, sizeof(small));
  f.cat("0123456789");            // 10 chars
  f.cat("abcdef", true);          // 6 + 2 quotes = 8, so 18 > 16: dropped
  TEST_ASSERT_EQUAL_STRING("0123456789", small);
}

// The guard is `curlen + vlen >= buffSize`, so the last byte stays reserved for
// the terminator and nothing is ever written past the declared size.
static void test_safecat_never_writes_past_the_buffer(void) {
  char small[16];
  memset(small, 'Z', sizeof(small));
  TestFormatter f;
  f.begin(small, 8);              // only the first 8 bytes may be used
  f.cat("1234567");               // 7 chars + terminator == 8: fits exactly
  TEST_ASSERT_EQUAL_STRING("1234567", small);
  f.cat("x");                     // 7 + 1 >= 8: dropped
  TEST_ASSERT_EQUAL_STRING("1234567", small);
  for(size_t i = 8; i < sizeof(small); i++)
    TEST_ASSERT_EQUAL_UINT8((uint8_t)'Z', (uint8_t)small[i]);
}

// The bound must be computed on the escaped size, not on the raw size.
static void test_safecat_bounds_use_the_escaped_size(void) {
  char small[16];
  memset(small, 'Z', sizeof(small));
  TestFormatter f;
  f.begin(small, sizeof(small));
  // Eight quotes escape to 16 bytes, plus the 2 surrounding quotes: 18 > 16.
  f.cat("\"\"\"\"\"\"\"\"", true);
  TEST_ASSERT_EQUAL_STRING("", small);
  for(size_t i = 1; i < sizeof(small); i++)
    TEST_ASSERT_EQUAL_UINT8((uint8_t)'Z', (uint8_t)small[i]);
}

// ------------------------------------------------------------- document shape

static void test_object_and_array_nesting(void) {
  fmt.beginObject();
  fmt.addElem("shadeId", (uint8_t)3);
  fmt.addElem("name", "Salon");
  fmt.addElem("up", true);
  fmt.beginArray("codes");
  fmt.addElem((uint32_t)1234);
  fmt.addElem((uint32_t)5678);
  fmt.endArray();
  fmt.endObject();
  TEST_ASSERT_EQUAL_STRING(
    "{\"shadeId\":3,\"name\":\"Salon\",\"up\":true,\"codes\":[1234,5678]}", buffer);
}

static void test_names_and_values_are_escaped(void) {
  fmt.beginObject();
  fmt.addElem("na\"me", "a\\b\nc");
  fmt.endObject();
  TEST_ASSERT_EQUAL_STRING("{\"na\\\"me\":\"a\\\\b\\nc\"}", buffer);
}

// addElem(name, const char *) returns early on a null value: no key, no comma,
// so the document must be unchanged rather than left with a dangling key.
static void test_null_value_is_skipped_entirely(void) {
  fmt.beginObject();
  fmt.addElem("a", (const char *)NULL);
  fmt.addElem("b", "ok");
  fmt.endObject();
  TEST_ASSERT_EQUAL_STRING("{\"b\":\"ok\"}", buffer);
}

static void test_signed_and_negative_numbers(void) {
  fmt.beginArray();
  fmt.addElem((int8_t)-42);
  fmt.addElem((int32_t)-70000);
  fmt.addElem(false);
  fmt.endArray();
  TEST_ASSERT_EQUAL_STRING("[-42,-70000,false]", buffer);
}

// ----------------------------------------------------------------- at scale

// A shade list or a sniffer event fills the whole buffer one small element at a
// time, and the buffer is a fixed slab the rest of the firmware also uses. What
// must hold is that no byte is ever written past the declared size and that no
// value is cut in half, whatever the caller keeps appending.
// NOTE: a buffer filled to the brim yields truncated JSON - the closing bracket
// itself gets dropped. That is why JsonSockEvent::closeEvent() forces a ']'
// over the last character instead of relying on _safecat.
// NOTE: _safecat still calls strlen() over the whole buffer for every element,
// so filling a buffer of size n costs O(n^2); the comment in JsonFormatter.cpp
// claiming O(n) is optimistic - it removed three of the four scans, not the
// quadratic term. The time budget below is sized for that reality and only
// catches a catastrophic regression.
static void test_a_full_buffer_never_overflows(void) {
  const size_t size = 64 * 1024;
  const size_t canary = 1024;
  char *big = (char *)malloc(size + canary);
  TEST_ASSERT_NOT_NULL(big);
  memset(big + size, 0x5A, canary);
  TestFormatter f;
  f.begin(big, size);
  f.beginArray();
  clock_t started = clock();
  // 5000 x 19 bytes is far more than the buffer holds, so the tail of the loop
  // exercises the drop path as well.
  for(int i = 0; i < 5000; i++) f.addElem("0123456789abcdef");
  double seconds = (double)(clock() - started) / CLOCKS_PER_SEC;
  f.endArray();
  const size_t len = strlen(big);
  // The buffer was really filled, and stayed inside its declared size.
  TEST_ASSERT_TRUE(len > size / 2);
  TEST_ASSERT_TRUE(len < size);
  TEST_ASSERT_EQUAL_UINT8((uint8_t)'[', (uint8_t)big[0]);
  // An even number of quotes: no value was cut in half when the buffer filled.
  size_t quotes = 0;
  for(size_t i = 0; i < len; i++) if(big[i] == '"') quotes++;
  TEST_ASSERT_EQUAL_UINT32(0, (uint32_t)(quotes % 2));
  // Nothing was written past the size the caller declared.
  for(size_t i = size; i < size + canary; i++)
    TEST_ASSERT_EQUAL_UINT8(0x5A, (uint8_t)big[i]);
  free(big);
  TEST_ASSERT_TRUE_MESSAGE(seconds < 10.0, "filling the buffer took far too long");
}

int main(int, char **) {
  UNITY_BEGIN();
  RUN_TEST(test_escape_leaves_plain_text_untouched);
  RUN_TEST(test_escape_covers_every_special_character);
  RUN_TEST(test_escape_of_empty_string);
  RUN_TEST(test_escape_return_matches_bytes_written);
  RUN_TEST(test_escaped_length_matches_escape_output);
  RUN_TEST(test_escaped_length_counts_the_first_character);
  RUN_TEST(test_safecat_appends_and_quotes);
  RUN_TEST(test_safecat_drops_a_value_that_does_not_fit);
  RUN_TEST(test_safecat_never_writes_past_the_buffer);
  RUN_TEST(test_safecat_bounds_use_the_escaped_size);
  RUN_TEST(test_object_and_array_nesting);
  RUN_TEST(test_names_and_values_are_escaped);
  RUN_TEST(test_null_value_is_skipped_entirely);
  RUN_TEST(test_signed_and_negative_numbers);
  RUN_TEST(test_a_full_buffer_never_overflows);
  return UNITY_END();
}
