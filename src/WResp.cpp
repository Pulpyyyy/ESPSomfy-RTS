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
