#include <Arduino.h>
#include <time.h>
#include "Utils.h"


/*********************************************************************
 * Timestamp class members
 ********************************************************************/
unsigned long Timestamp::epoch() {
  struct tm tmNow;
  time_t now;
  if(!getLocalTime(&tmNow,50)) return 0;
  time(&now);
  return now;
}
time_t Timestamp::now() {
  struct tm tmNow;
  getLocalTime(&tmNow,50);
  return mktime(&tmNow);
}
time_t Timestamp::getUTC() { 
  time_t t;
  time(&t);
  return t; 
}
time_t Timestamp::mkUTCTime(struct tm *dt) {
  time_t tsBadLocal = mktime(dt);

  struct tm tmUTC;
  struct tm tmLocal;
  gmtime_r(&tsBadLocal, &tmUTC);
  localtime_r(&tsBadLocal, &tmLocal);
  time_t tsBadUTC = mktime(&tmUTC);
  time_t tsLocal = mktime(&tmLocal);
  time_t tsLocalOffset = tsLocal - tsBadUTC;
  return tsBadLocal + tsLocalOffset;
}
// Reads the next numeric field of an ISO timestamp starting at *pos and stops on
// any of the supplied delimiters (or at the end of the string).  Digits are
// accumulated straight into an int so there is no intermediate char buffer that
// could be filled to the brim and handed to atoi() without a null terminator.
// At most maxDigits digits contribute to the value; the rest of the field is
// consumed so the caller stays aligned on the following delimiter.
static int _parseTimePart(const char *buff, size_t len, size_t *pos, const char *delims, uint8_t maxDigits) {
  int val = 0;
  uint8_t digits = 0;
  while(*pos < len) {
    char ch = buff[(*pos)++];
    if(strchr(delims, ch) != nullptr) break;
    if(!isdigit(static_cast<unsigned char>(ch))) continue;
    if(digits < maxDigits) {
      val = (val * 10) + (ch - '0');
      digits++;
    }
  }
  return val;
}
time_t Timestamp::parseUTCTime(const char *buff) {
  struct tm dt;
  dt.tm_hour = 0;
  dt.tm_mday = 0;
  dt.tm_mon = 0;
  dt.tm_year = 0;
  dt.tm_wday = 0;
  dt.tm_yday = 0;
  dt.tm_isdst = false;
  if(!buff) return Timestamp::mkUTCTime(&dt);
  size_t len = strlen(buff);
  size_t i = 0;
  dt.tm_year = _parseTimePart(buff, len, &i, "-", 4) - 1900;
  dt.tm_mon = _parseTimePart(buff, len, &i, "-", 2) - 1;
  dt.tm_mday = _parseTimePart(buff, len, &i, "-Tt", 2);
  dt.tm_hour = _parseTimePart(buff, len, &i, "-:", 2);
  dt.tm_min = _parseTimePart(buff, len, &i, "-:", 2);
  dt.tm_sec = _parseTimePart(buff, len, &i, "-:Z", 2);
  //Serial.printf("Y:%d M:%d D:%d H:%d M:%d S:%d\n", dt.tm_year, dt.tm_mon, dt.tm_mday, dt.tm_hour, dt.tm_min, dt.tm_sec);
  return Timestamp::mkUTCTime(&dt);
}
time_t Timestamp::getUTC(time_t t) {
  tm tmUTC;
  gmtime_r(&t, &tmUTC);
  return mktime(&tmUTC);
}
char * Timestamp::getISOTime() { return this->getISOTime(this->getUTC()); }
char * Timestamp::getISOTime(time_t epoch) {
  struct tm *dt = localtime((time_t *)&epoch);
  return this->formatISO(dt, this->tzOffset());
}
char * Timestamp::formatISO(struct tm *dt, int tz) {
  int tzHrs = floor(tz/100);
  int tzMin = tz - (tzHrs * 100);
  int ms = millis() % 1000;
  snprintf(this->_timeBuffer, sizeof(this->_timeBuffer), "%04d-%02d-%02dT%02d:%02d:%02d.%03d%s%02d%02d", 
    dt->tm_year + 1900, dt->tm_mon + 1, dt->tm_mday, dt->tm_hour, dt->tm_min, dt->tm_sec, ms, tzHrs < 0 ? "-" : "+", abs(tzHrs), abs(tzMin));
  return this->_timeBuffer;
}
int Timestamp::calcTZOffset(time_t *dt) {
  tm tmLocal, tmUTC;
  gmtime_r(dt, &tmUTC);
  localtime_r(dt, &tmLocal);
  long diff = mktime(&tmLocal) - mktime(&tmUTC);
  if(tmLocal.tm_isdst) diff += 3600;
  int hrs = (int)((diff/3600) * 100);
  int mins = diff - (hrs * 36);
  return hrs + mins;
}
int Timestamp::tzOffset() {
  time_t now;
  time(&now);
  return Timestamp::calcTZOffset(&now);
}
