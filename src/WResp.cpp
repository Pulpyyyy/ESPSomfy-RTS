#include "WResp.h"
void JsonSockEvent::beginEvent(WebSocketsServer *server, const char *evt, char *buff, size_t buffSize) {
  this->server = server;
  this->buff = buff;
  this->buffSize = buffSize;
  this->_nocomma = true;
  this->_closed = false;
  snprintf(this->buff, buffSize, "42[%s,", evt);
}
void JsonSockEvent::closeEvent() {
  if(!this->_closed) {
    // strlen == buffSize - 1 means the buffer is exactly full: strcat would put
    // the terminator one byte past the end. Overwrite the last character with
    // the closing bracket instead so the string stays in bounds and terminated.
    if(strlen(this->buff) < this->buffSize - 1) strcat(this->buff, "]");
    else {
      this->buff[this->buffSize - 2] = ']';
      this->buff[this->buffSize - 1] = '\0';
    }
  }
  this->_nocomma = true;
  this->_closed = true;
}
void JsonSockEvent::endEvent(uint8_t num) {
  this->closeEvent();
  if(num == 255) this->server->broadcastTXT(this->buff);
  else this->server->sendTXT(num, this->buff);
}
void JsonSockEvent::_safecat(const char *val, bool escape) {
  // Track the buffer length locally and append through the pointer so each element
  // costs one strlen instead of the four the strcat chain used to run (O(n) instead
  // of O(n^2) over a long event). The overflow no longer dumps the whole buffer
  // (that 2 KB serial print stalled the loop with the sniffer UI open).
  size_t curlen = strlen(this->buff);
  size_t vlen = (escape ? this->calcEscapedLength(val) : strlen(val)) + (escape ? 2 : 0);
  if(curlen + vlen >= this->buffSize) {
    Serial.printf("Socket exceeded buffer size %d - %d\n", this->buffSize, curlen + vlen);
    return;
  }
  char *p = this->buff + curlen;
  if(escape) {
    *p++ = '"';
    p += this->escapeString(val, p);
    *p++ = '"';
    *p = '\0';
  }
  else strcpy(p, val);
}
void JsonResponse::beginResponse(WebServer *server, char *buff, size_t buffSize) {
  this->server = server;
  this->buff = buff;
  this->buffSize = buffSize;
  this->buff[0] = 0x00;
  this->_nocomma = true;
  server->setContentLength(CONTENT_LENGTH_UNKNOWN);
}
void JsonResponse::endResponse() {
  if(strlen(buff)) this->send();
  server->sendContent("", 0);
}
void JsonResponse::send() {
  if(!this->_headersSent) server->send_P(200, "application/json", this->buff);
  else server->sendContent(this->buff);
  //Serial.printf("Sent %d bytes %d\n", strlen(this->buff), this->buffSize);
  this->buff[0] = 0x00;
  this->_headersSent = true;
}
void JsonResponse::_safecat(const char *val, bool escape) {
  size_t vlen = (escape ? this->calcEscapedLength(val) : strlen(val)) + (escape ? 2 : 0);
  if(vlen + strlen(this->buff) >= this->buffSize) {
    this->send();
    // A value larger than the whole buffer cannot be sent even after the
    // flush: drop it instead of overflowing the buffer.
    if(vlen >= this->buffSize) {
      Serial.printf("JSON value exceeds response buffer %d - %d\n", this->buffSize, vlen);
      return;
    }
  }
  // Append through the pointer after any flush: one strlen instead of the strcat
  // chain's repeated tail rescans.
  char *p = this->buff + strlen(this->buff);
  if(escape) {
    *p++ = '"';
    p += this->escapeString(val, p);
    *p++ = '"';
    *p = '\0';
  }
  else strcpy(p, val);
}

void JsonFormatter::beginObject(const char *name) {
  if(name && strlen(name) > 0) this->appendElem(name);
  else if(!this->_nocomma) this->_safecat(",");
  this->_safecat("{");
  this->_objects++;
  this->_nocomma = true;
}
void JsonFormatter::endObject() {
  //if(strlen(this->buff) + 1 > this->buffSize - 1) this->send();
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
  //if(strlen(this->buff) + 1 > this->buffSize - 1) this->send();
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
void JsonFormatter::addElem(float fval) { sprintf(this->_numbuff, "%.4f", fval); this->_appendNumber(nullptr); }
void JsonFormatter::addElem(int8_t nval) { sprintf(this->_numbuff, "%d", nval); this->_appendNumber(nullptr); }
void JsonFormatter::addElem(uint8_t nval) { sprintf(this->_numbuff, "%u", nval); this->_appendNumber(nullptr); }
void JsonFormatter::addElem(int32_t nval) { sprintf(this->_numbuff, "%ld", (long)nval); this->_appendNumber(nullptr); }
void JsonFormatter::addElem(uint32_t nval) { sprintf(this->_numbuff, "%lu", (unsigned long)nval); this->_appendNumber(nullptr); }

/*
void JsonFormatter::addElem(int16_t nval) { sprintf(this->_numbuff, "%d", nval); this->_appendNumber(nullptr); }
void JsonFormatter::addElem(uint16_t nval) { sprintf(this->_numbuff, "%u", nval); this->_appendNumber(nullptr); }
void JsonFormatter::addElem(int64_t lval) { sprintf(this->_numbuff, "%lld", (long long)lval); this->_appendNumber(nullptr); }
void JsonFormatter::addElem(uint64_t lval) { sprintf(this->_numbuff, "%llu", (unsigned long long)lval); this->_appendNumber(nullptr); }
*/
void JsonFormatter::addElem(bool bval) { strcpy(this->_numbuff, bval ? "true" : "false"); this->_appendNumber(nullptr); }

void JsonFormatter::addElem(const char *name, float fval) { sprintf(this->_numbuff, "%.4f", fval); this->_appendNumber(name); }
void JsonFormatter::addElem(const char *name, int8_t nval) { sprintf(this->_numbuff, "%d", nval); this->_appendNumber(name); }
void JsonFormatter::addElem(const char *name, uint8_t nval) { sprintf(this->_numbuff, "%u", nval); this->_appendNumber(name); }
void JsonFormatter::addElem(const char *name, int32_t nval) { sprintf(this->_numbuff, "%ld", (long)nval); this->_appendNumber(name); }
void JsonFormatter::addElem(const char *name, uint32_t nval) { sprintf(this->_numbuff, "%lu", (unsigned long)nval); this->_appendNumber(name); }

/*
void JsonFormatter::addElem(const char *name, int16_t nval) { sprintf(this->_numbuff, "%d", nval); this->_appendNumber(name); }
void JsonFormatter::addElem(const char *name, uint16_t nval) { sprintf(this->_numbuff, "%u", nval); this->_appendNumber(name); }
void JsonFormatter::addElem(const char *name, int64_t lval) { sprintf(this->_numbuff, "%lld", (long long)lval); this->_appendNumber(name); }
void JsonFormatter::addElem(const char *name, uint64_t lval) { sprintf(this->_numbuff, "%llu", (unsigned long long)lval); this->_appendNumber(name); }
*/
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
