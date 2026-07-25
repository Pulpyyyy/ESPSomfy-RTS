#include "JsonFormatter.h"
#include <stdio.h>
#include <string.h>

void JsonFormatter::beginObject(const char *name) {
  if(name && strlen(name) > 0) this->appendElem(name);
  else if(!this->_nocomma) this->_safecat(",");
  this->_safecat("{");
  this->_objects++;
  this->_nocomma = true;
}
void JsonFormatter::endObject() {
  this->_safecat("}");
  this->_objects--;
  this->_nocomma = false;
}
void JsonFormatter::beginArray(const char *name) {
  if(name && strlen(name) > 0) this->appendElem(name);
  else if(!this->_nocomma) this->_safecat(",");
  this->_safecat("[");
  this->_arrays++;
  this->_nocomma = true;
}
void JsonFormatter::endArray() {
  this->_safecat("]");
  this->_arrays--;
  this->_nocomma = false;
}

void JsonFormatter::appendElem(const char *name) {
  if(!this->_nocomma) this->_safecat(",");
  if(name && strlen(name) > 0) {
    this->_safecat(name, true);
    this->_safecat(":");
  }
  this->_nocomma = false;
}

void JsonFormatter::addElem(const char *name, const char *val) {
  if(!val) return;
  this->appendElem(name);
  this->_safecat(val, true);
}
void JsonFormatter::addElem(const char *val) { this->addElem(nullptr, val); }
void JsonFormatter::addElem(float fval) { snprintf(this->_numbuff, sizeof(this->_numbuff), "%.4f", fval); this->_appendNumber(nullptr); }
void JsonFormatter::addElem(int8_t nval) { snprintf(this->_numbuff, sizeof(this->_numbuff), "%d", nval); this->_appendNumber(nullptr); }
void JsonFormatter::addElem(uint8_t nval) { snprintf(this->_numbuff, sizeof(this->_numbuff), "%u", nval); this->_appendNumber(nullptr); }
void JsonFormatter::addElem(int32_t nval) { snprintf(this->_numbuff, sizeof(this->_numbuff), "%ld", (long)nval); this->_appendNumber(nullptr); }
void JsonFormatter::addElem(uint32_t nval) { snprintf(this->_numbuff, sizeof(this->_numbuff), "%lu", (unsigned long)nval); this->_appendNumber(nullptr); }
void JsonFormatter::addElem(bool bval) { strcpy(this->_numbuff, bval ? "true" : "false"); this->_appendNumber(nullptr); }

void JsonFormatter::addElem(const char *name, float fval) { snprintf(this->_numbuff, sizeof(this->_numbuff), "%.4f", fval); this->_appendNumber(name); }
void JsonFormatter::addElem(const char *name, int8_t nval) { snprintf(this->_numbuff, sizeof(this->_numbuff), "%d", nval); this->_appendNumber(name); }
void JsonFormatter::addElem(const char *name, uint8_t nval) { snprintf(this->_numbuff, sizeof(this->_numbuff), "%u", nval); this->_appendNumber(name); }
void JsonFormatter::addElem(const char *name, int32_t nval) { snprintf(this->_numbuff, sizeof(this->_numbuff), "%ld", (long)nval); this->_appendNumber(name); }
void JsonFormatter::addElem(const char *name, uint32_t nval) { snprintf(this->_numbuff, sizeof(this->_numbuff), "%lu", (unsigned long)nval); this->_appendNumber(name); }
void JsonFormatter::addElem(const char *name, bool bval) { strcpy(this->_numbuff, bval ? "true" : "false"); this->_appendNumber(name); }

void JsonFormatter::_safecat(const char *val, bool escape) {
  // One strlen of the buffer, then append through the pointer. The old strcat chain
  // rescanned the whole buffer up to four times per element, making a long event
  // (hundreds of elements) O(n^2) in the buffer size.
  size_t curlen = strlen(this->buff);
  size_t vlen = (escape ? this->calcEscapedLength(val) : strlen(val)) + (escape ? 2 : 0);
  if(curlen + vlen >= this->buffSize) return;
  char *p = this->buff + curlen;
  if(escape) {
    *p++ = '"';
    p += this->escapeString(val, p);
    *p++ = '"';
    *p = '\0';
  }
  else strcpy(p, val);
}
void JsonFormatter::_appendNumber(const char *name) { this->appendElem(name); this->_safecat(this->_numbuff); }
uint32_t JsonFormatter::calcEscapedLength(const char *raw) {
  // The previous loop ran from strlen(raw) down to 1: it counted the '\0' and
  // skipped raw[0], under-counting by one byte when the first character needed
  // escaping, which let _safecat overflow the buffer by one byte.
  uint32_t len = 0;
  for(size_t i = strlen(raw); i > 0; i--) {
    switch(raw[i - 1]) {
      case '"':
      case '/':
      case '\b':
      case '\f':
      case '\n':
      case '\r':
      case '\t':
      case '\\':
        len += 2;
        break;
      default:
        len++;
        break;
    }
  }
  return len;
}
size_t JsonFormatter::escapeString(const char *raw, char *escaped) {
  // Direct pointer writes: the previous strcat-per-character version rescanned
  // the whole output on every character, making escaping O(n^2). Bounds are
  // guaranteed by the callers, which check calcEscapedLength() first. Returns the
  // number of characters written so _safecat can advance without a fresh strlen.
  char *p = escaped;
  for(const char *s = raw; *s; s++) {
    switch(*s) {
      case '"':  *p++ = '\\'; *p++ = '"';  break;
      case '/':  *p++ = '\\'; *p++ = '/';  break;
      case '\b': *p++ = '\\'; *p++ = 'b';  break;
      case '\f': *p++ = '\\'; *p++ = 'f';  break;
      case '\n': *p++ = '\\'; *p++ = 'n';  break;
      case '\r': *p++ = '\\'; *p++ = 'r';  break;
      case '\t': *p++ = '\\'; *p++ = 't';  break;
      case '\\': *p++ = '\\'; *p++ = '\\'; break;
      default:   *p++ = *s;                break;
    }
  }
  *p = '\0';
  return (size_t)(p - escaped);
}
