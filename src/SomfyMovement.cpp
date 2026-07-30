#include <Arduino.h>
#include <Preferences.h>
#include <WebServer.h>
#include "Utils.h"
#include "ConfigSettings.h"
#include "Somfy.h"
#include "Sockets.h"

// Shade movement engine, split out of Somfy.cpp: position/tilt tracking through
// checkMovement(), the lift-time curves, step targets, My-position handling and
// the shade/group command senders.  Declarations stay in Somfy.h.

extern Preferences pref;
extern SomfyShadeController somfy;
extern SocketEmitter sockEmit;
extern ConfigSettings settings;

// engine and the controller transmit path both key off them.
// Minimum interval between two position-progress socket emits of the same shade
// while it travels. emitState() serialises the full shade and broadcasts it to
// every socket client; at up to SOMFY_MAX_SHADES moving at once, one emit per 1%
// step floods the loop so it runs slower and skips positions. Start/stop/arrival
// (direction changes) are still emitted immediately, so no transition is lost.
#define MOVE_EMIT_INTERVAL 250

uint32_t SomfyShade::effectiveLiftTime() {
  // The slat lift dead time only applies to plain rollers/shutters with interlocking
  // slats. Tilted blinds model their closed-end dead time with tiltTime and dry
  // contacts have none, so liftTime is inert for those types.
  if(this->tiltType != tilt_types::none) return 0;
  if(this->shadeType == shade_types::drycontact || this->shadeType == shade_types::drycontact2) return 0;
  return this->liftTime;
}
// Map the time-linear internal position to the visible position (both in currentPos
// units: 0 = open, 100 = closed):
//   phi(p) = p + k*p*(100-p)/100 = (1+k)p - (k/100)p^2
// The roller is fast near open (large diameter), so the shade is MORE closed than the
// linear estimate at mid-travel -> the curve pushes toward closed (the +k term).
// Direction-independent: the same map applies going up and down. k clamped to [0, 0.95]
// to stay monotonic; 0 = linear. Endpoints are exact (0->0, 100->100).
float SomfyShade::curveForward(float pos) {
  float k = this->curveGain;
  if(k <= 0.0f) return pos;
  if(k > 0.95f) k = 0.95f;
  return pos + k * pos * (100.0f - pos) / 100.0f;
}
// Inverse of curveForward: visible position -> time-linear internal position.
// Solve (k/100)p^2 - (1+k)p + v = 0 for p, taking the root in [0,100].
float SomfyShade::curveInverse(float pos) {
  float k = this->curveGain;
  if(k <= 0.0f) return pos;
  if(k > 0.95f) k = 0.95f;
  float a = k / 100.0f;
  float b = 1.0f + k;
  float disc = b * b - 4.0f * a * pos;
  if(disc <= 0.0f) return pos;
  return (b - sqrtf(disc)) / (2.0f * a);
}
float SomfyShade::stepUpTarget(uint32_t msStep) {
  // Compute the position target for an up step jog of msStep ms. When the slats are
  // stacked the motor spends the jog unstacking them before the curtain can travel so
  // that time produces slat progress instead of movement.
  uint32_t liftTime = this->effectiveLiftTime();
  if(liftTime > 0 && this->liftPos > 0.0f) {
    float lp = this->liftPos - (float)msStep / (float)liftTime;
    if(lp > 0.0f) {
      // The whole jog went into unstacking the slats; the curtain did not move.
      this->liftPos = this->startLiftPos = lp;
      return this->currentPos;
    }
    // Part of the jog freed the slats; only the remainder travels.
    msStep = (uint32_t)floor(-lp * (float)liftTime);
    this->liftPos = this->startLiftPos = 0.0f;
  }
  // The msStep travel is time-linear; convert the current visible position to the
  // time-linear domain, apply the step, and map the result back through the curve.
  return this->curveForward(max(0.0f, this->curveInverse(this->currentPos) - (100.0f * (float)msStep / (float)this->upTime)));
}
float SomfyShade::stepDownTarget(uint32_t msStep) {
  // Compute the position target for a down step jog of msStep ms. The part of the jog
  // left after the curtain reaches the sill stacks the slats; a single step only closes
  // the vents completely if it also covers the remaining lift time.
  // Work in the time-linear domain (curveInverse is a no-op when curveGain is 0), where
  // the stacking check below and the downTime ratio are defined.
  float lin = this->curveInverse(this->currentPos) + (100.0f * (float)msStep / (float)this->downTime);
  uint32_t liftTime = this->effectiveLiftTime();
  if(lin > 100.0f && liftTime > 0) {
    float msStack = (lin - 100.0f) / 100.0f * (float)this->downTime;
    float lp = this->liftPos + msStack / (float)liftTime;
    if(lp < 1.0f) {
      // The curtain is at the sill but the slats are not fully stacked yet.
      this->liftPos = this->startLiftPos = lp;
      return 99.9f;
    }
    // The jog also finishes the stacking; let checkMovement close it out from the
    // snapshot taken when the command was received.
  }
  return this->curveForward(min(100.0f, lin));
}
void SomfyShade::startCmdGap(pending_cmd_t cmd, uint32_t ms) {
  // millis() is read here rather than reusing the curTime snapshot taken when
  // checkMovement() started: the gap must be measured from the end of the transmission
  // that just went out, which is exactly what the delay() call this replaces did.
  this->pendingCmd = cmd;
  this->pendingCmdStart = millis();
  this->pendingCmdDelay = ms;
}
void SomfyShade::checkMovement() {
  const uint32_t curTime = millis();
  // A pending command means an inter-command gap is running.  While it does, this shade
  // must behave exactly as it did when a delay() held the loop here: no position math, no
  // state change, only the deadline is evaluated.  The difference is that the rest of the
  // firmware -- watchdog, web server, sockets, MQTT and the other shades -- keeps running.
  if(this->pendingCmd != pending_cmd_t::none) {
    // Subtractive comparison so the 49.7-day millis() rollover cannot strand the gap.
    if(curTime - this->pendingCmdStart < this->pendingCmdDelay) return;  // still waiting
    const pending_cmd_t pending = this->pendingCmd;
    this->pendingCmd = pending_cmd_t::none;
    if(pending == pending_cmd_t::tiltTarget) {
      // Second half of the stop-then-tilt sequence.  The guards are the ones that were
      // true when it was scheduled; they are re-evaluated because the loop now runs during
      // the gap, so a frame from a physical remote can have cleared settingPos in the
      // meantime (processFrame aborts positioning for any non-internal frame).
      if(this->settingPos && !this->isAtTarget()) this->moveToTiltTarget(this->tiltTarget);
      // Fall through: the rest of this pass is what used to run on the loop pass that
      // followed the blocking delay.
    }
    else if(pending == pending_cmd_t::setMyPos) {
      if(this->settingMyPos && this->isAtTarget()) {
        this->finishSetMyPosition();
        return;  // the blocking version also ended the pass right after this block
      }
    }
  }
  const bool sunFlag = this->flags & static_cast<uint8_t>(somfy_flags_t::SunFlag);
  const bool isSunny = this->flags & static_cast<uint8_t>(somfy_flags_t::Sunny);
  const bool isWindy = this->flags & static_cast<uint8_t>(somfy_flags_t::Windy);
  int32_t downTime = (int32_t)this->downTime;
  int32_t upTime = (int32_t)this->upTime;
  int32_t tiltTime = (int32_t)this->tiltTime;
  int32_t liftTime = (int32_t)this->effectiveLiftTime();
  if(this->shadeType == shade_types::drycontact || this->shadeType == shade_types::drycontact2) downTime = upTime = tiltTime = 1;


  // We need to first evaluate the sensor flags as these could be triggering movement from previous sensor inputs. So
  // we must check this before setting the directional items or it will not get processed until the next loop.
  bool sensorRetarget = false;
  if (sunFlag) {
    if (isSunny && !isWindy) {  // It is sunny and there is no wind so we should be extended
      if (this->noWindDone
          && !this->sunDone
          && this->sunStart
          && (curTime - this->sunStart) >= SOMFY_SUN_TIMEOUT)
      {
        this->p_target(this->myPos >= 0 ? this->myPos : 100.0f);
        //this->target = this->myPos >= 0 ? this->myPos : 100.0f;
        this->sunDone = true;
        sensorRetarget = true;
        Serial.printf("[%u] Sun -> done\r\n", this->shadeId);
      }
      if (!this->noWindDone
          && this->noWindStart
          && (curTime - this->noWindStart) >= SOMFY_NO_WIND_TIMEOUT)
      {
        this->p_target(this->myPos >= 0 ? this->myPos : 100.0f);
        //this->target = this->myPos >= 0 ? this->myPos : 100.0f;
        this->noWindDone = true;
        sensorRetarget = true;
        Serial.printf("[%u] No Wind -> done\r\n", this->shadeId);
      }
    }
    if (!isSunny
        && !this->noSunDone
        && this->noSunStart
        && (curTime - this->noSunStart) >= SOMFY_NO_SUN_TIMEOUT)
    {
      if(this->tiltType == tilt_types::tiltonly) this->p_tiltTarget(0.0f);
      this->p_target(0.0f);
      this->noSunDone = true;
      sensorRetarget = true;
      Serial.printf("[%u] No Sun -> done\r\n", this->shadeId);
    }
  }

  if (isWindy
      && !this->windDone
      && this->windStart
      && (curTime - this->windStart) >= SOMFY_WIND_TIMEOUT)
  {
    if(this->tiltType == tilt_types::tiltonly) this->p_tiltTarget(0.0f);
    this->p_target(0.0f);
    this->windDone = true;
    sensorRetarget = true;
    Serial.printf("[%u] Wind -> done\r\n", this->shadeId);
  }
  if(sensorRetarget) {
    // The motor acts on sensor events by itself; re-baseline the movement math so the
    // position tracks that autonomous travel from where the shade is now. The stale
    // moveStart/startPos of a previous move would otherwise snap the position straight
    // to the new target (and abort any pending positioning like a remote command does).
    this->moveStart = this->tiltStart = curTime;
    this->startPos = this->currentPos;
    this->startTiltPos = this->currentTiltPos;
    this->startLiftPos = this->liftPos;
    this->settingMyPos = this->settingPos = this->settingTiltPos = false;
  }

  // We are checking movement for essentially 3 types of motors.
  // If this is an integrated tilt we need to first tilt in the direction we are moving then move.  We know
  // what needs to be done by the tilt type.  Set a tilt first flag to indicate whether we should be tilting or
  // moving. If this is only a tilt action then the regular tilt action should operate fine.
  int8_t currDir = this->direction;
  int8_t currTiltDir = this->tiltDirection;
  this->p_direction(this->currentPos == this->target ? 0 : this->currentPos > this->target ? -1 : 1);
  bool tilt_first = this->tiltType == tilt_types::integrated && ((this->direction == -1 && this->currentTiltPos != 0.0f) || (this->direction == 1 && this->currentTiltPos != 100.0f));

  this->p_tiltDirection(this->currentTiltPos == this->tiltTarget ? 0 : this->currentTiltPos > this->tiltTarget ? -1 : 1);
  if(tilt_first) this->p_tiltDirection(this->direction);
  else if(this->direction != 0) this->p_tiltDirection(0);
  uint8_t currPos = floor(this->currentPos);
  uint8_t currTiltPos = floor(this->currentTiltPos);
  if(this->direction != 0) this->lastMovement = this->direction;

  if(!tilt_first && this->direction > 0) {
    if(downTime == 0) {
      this->p_currentPos(100.0);
      this->liftPos = 1.0f;
      //this->p_direction(0);
    }
    else {
      // The shade is moving down so we need to calculate its position through the down position.
      // 10000ms from 0 to 100
      // The starting posion is a float value from 0-1 that indicates how much the shade is open. So
      // if we take the starting position * the total down time then this will tell us how many ms it
      // has moved in the down position.
      // startPos is stored in visible units; convert it back to the time-linear domain
      // before turning it into elapsed time (curveInverse is a no-op when curveGain is 0).
      int32_t msFrom0 = (int32_t)floor((this->curveInverse(this->startPos)/100) * downTime);

      // So if the start position is .1 it is 10% closed so we have a 1000ms (1sec) of time to account for
      // before we add any more time.
      msFrom0 += (curTime - this->moveStart);
      if(msFrom0 < downTime) {
        // The curtain is still travelling toward the sill. The current position is the
        // ratio of the time travelled over the total time to go 100%, mapped back to the
        // visible position through the winding curve.
        this->p_currentPos(this->curveForward(max((float)0.0, (float)msFrom0 / (float)downTime) * 100));
      }
      else if(this->target >= 100.0f && liftTime > 0) {
        // The curtain is at the sill but the slats still need liftTime ms to stack and close
        // the vents. Track that progress in liftPos, resuming from the snapshot taken when
        // the move (re)started so an interrupted or re-latched move never loses progress.
        this->liftPos = min((float)1.0, this->startLiftPos + (float)(msFrom0 - downTime) / (float)liftTime);
        // Hold the position just shy of closed until the slats are fully stacked. It must stay
        // strictly below 100 or the completion check below would end the move early.
        this->p_currentPos(this->liftPos >= 1.0f ? 100.0f : 99.9f);
      }
      else {
        this->p_currentPos(100.0f);
        // With no lift time configured a fully closed shade has its slats stacked.
        if(this->target >= 100.0f) this->liftPos = 1.0f;
      }
    }
    if(this->currentPos >= this->target) {
      this->p_currentPos(this->target);
      //if(this->settingMyPos) Serial.printf("IsAtTarget: %d  %f=%f\n", this->isAtTarget(), this->currentPos, this->target);
      // If we need to stop the shade do this before we indicate that we are
      // not moving otherwise the my function will kick in.
      if(this->settingPos) {
        if(!isAtTarget()) {
          Serial.printf("We are not at our tilt target: %.2f\n", this->tiltTarget);
          if(this->target != 100.0) SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
          // We now need to move the tilt to the position we requested, but the motor needs
          // a gap on the air between the stop above and that command.  Schedule it instead
          // of blocking the loop with delay(100): the tilt command still goes out 100ms
          // after the stop, and tiltStart below is unchanged, so the tilt position math and
          // the frame sequencing are the same as before.
          this->startCmdGap(pending_cmd_t::tiltTarget, 100);
        }
        else
          if(this->target != 100.0) SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
      }
      this->p_direction(0);
      this->tiltStart = curTime;
      this->startTiltPos = this->currentTiltPos;
      if(this->isAtTarget()) this->commitShadePosition();
    }
  }
  else if(!tilt_first && this->direction < 0) {
    if(upTime == 0) {
      this->p_currentPos(0);
      this->liftPos = 0.0f;
      //this->p_direction(0);
    }
    else {
      // The shade is moving up so we need to calculate its position through the up position. Shades
      // often move slower in the up position so since we are using a relative position the up time
      // can be calculated.
      // 10000ms from 100 to 0;
      int32_t msElapsed = (int32_t)(curTime - this->moveStart);
      if(liftTime > 0 && this->startLiftPos > 0.0f) {
        // The motor first unstacks the slats before the curtain leaves the sill; that time
        // does not move the shade. startLiftPos carries the stacking progress across stops
        // and re-latched frames so only the remaining unstack time is charged.
        int32_t unstackTime = (int32_t)floor(this->startLiftPos * (float)liftTime);
        this->liftPos = max((float)0.0, this->startLiftPos - (float)msElapsed / (float)liftTime);
        msElapsed = max((int32_t)0, msElapsed - unstackTime);
      }
      else this->liftPos = 0.0f;
      // startPos is stored in visible units; convert back to time-linear before deriving time.
      int32_t msFrom100 = upTime - (int32_t)floor((this->curveInverse(this->startPos)/100) * upTime);
      msFrom100 += msElapsed;
      msFrom100 = min(upTime, msFrom100);
      if(msFrom100 >= upTime) {
        this->p_currentPos(0.0f);
        //this->p_direction(0);
      }
      else {
        // Time-linear position, then mapped back to the visible position through the curve.
        float fpos = this->curveForward(((float)1.0 - min(max((float)0.0, (float)msFrom100 / (float)upTime), (float)1.0)) * 100);
        // We should now have the number of ms it will take to reach the shade fully open.
        // If we are at the top of the shade then set the movement to 0.
        if(fpos <= 0.0) {
          this->p_currentPos(0.0f);
          //this->p_direction(0);
        }
        else
          this->p_currentPos(fpos);
      }
    }
    if(this->currentPos <= this->target) {
      this->p_currentPos(this->target);
      //if(this->settingMyPos) Serial.printf("IsAtTarget: %d  %f=%f\n", this->isAtTarget(), this->currentPos, this->target);
      
      // If we need to stop the shade do this before we indicate that we are
      // not moving otherwise the my function will kick in.
      if(this->settingPos) {
        if(!isAtTarget()) {
          Serial.printf("We are not at our tilt target: %.2f\n", this->tiltTarget);
          if(this->target != 0.0) SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
          // Same stop-then-tilt gap as in the down direction: deferred rather than spun on,
          // so the command still goes out 100ms after the stop without freezing the loop.
          this->startCmdGap(pending_cmd_t::tiltTarget, 100);
        }
        else
          if(this->target != 0.0) SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
      }
      this->p_direction(0);
      this->tiltStart = curTime;
      this->startTiltPos = this->currentTiltPos;
      if(this->isAtTarget()) this->commitShadePosition();
    }
  }
  if(this->tiltDirection > 0) {
    if(tilt_first) this->moveStart = curTime;
    int32_t msFrom0 = (int32_t)floor((this->startTiltPos/100) * tiltTime);
    msFrom0 += (curTime - this->tiltStart);
    msFrom0 = min(tiltTime, msFrom0);
    if(msFrom0 >= tiltTime) {
      this->p_currentTiltPos(100.0f);
      //this->p_tiltDirection(0);        
      //Serial.printf("Setting tiltDirection to 0 (not enough time) %.4f %.4f\n", msFrom0, tiltTime);
    }
    else {
      float fpos = (min(max((float)0.0, (float)msFrom0 / (float)tiltTime), (float)1.0)) * 100;
      
      if(fpos > 100.0f) {
        this->p_currentTiltPos(100.0f);
        //this->p_tiltDirection(0);
        //Serial.println("Setting tiltDirection to 0 (100%)");
      }
      else this->p_currentTiltPos(fpos);
    }
    if(tilt_first) {
      if(this->currentTiltPos >= 100.0f) {
        this->p_currentTiltPos(100.0f);
        this->moveStart = curTime;
        this->startPos = this->currentPos;
        this->startLiftPos = this->liftPos;
        //this->p_tiltDirection(0);
        //Serial.println("Setting tiltDirection to 0 (tilt_first)");
      }
    }
    else if(this->currentTiltPos >= this->tiltTarget) {
      this->p_currentTiltPos(this->tiltTarget);
      // If we need to stop the shade do this before we indicate that we are
      // not moving otherwise the my function will kick in.
      if(this->settingTiltPos) {
        if(this->tiltType == tilt_types::integrated) {
          // If this is an integrated tilt mechanism the we will simply let it finish.  If it is not then we will stop it.
          //Serial.printf("Sending My -- tiltTarget: %.2f, tiltDirection: %d\n", this->tiltTarget, this->tiltDirection);
          if(this->tiltTarget != 100.0f || this->currentPos != 100.0f) SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
        }
        else {
          // This is a tilt motor so let it complete if it is going to 100.
          if(this->tiltTarget != 100.0f) SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
        }
      }
      this->p_tiltDirection(0);
      this->settingTiltPos = false;
      if(this->isAtTarget()) this->commitShadePosition();
    }
  }
  else if(this->tiltDirection < 0) {
    if(tilt_first) this->moveStart = curTime;
    if(tiltTime == 0) {
      this->p_tiltDirection(0);
      this->p_currentTiltPos(0.0f);
    }
    else {
      int32_t msFrom100 = tiltTime - (int32_t)floor((this->startTiltPos/100) * tiltTime);
      msFrom100 += (curTime - this->tiltStart);
      msFrom100 = min(tiltTime, msFrom100);
      if(msFrom100 >= tiltTime) {
        this->p_currentTiltPos(0.0f);
        //this->p_tiltDirection(0);
      }
      float fpos = ((float)1.0 - min(max((float)0.0, (float)msFrom100 / (float)tiltTime), (float)1.0)) * 100;
      // If we are at the top of the shade then set the movement to 0.
      if(fpos <= 0.0f) {
        this->p_currentTiltPos(0.0f);
        //this->p_tiltDirection(0);
      }
      else this->p_currentTiltPos(fpos);
    }
    if(tilt_first) {
      if(this->currentTiltPos <= 0.0f) {
        this->p_currentTiltPos(0.0f);
        this->moveStart = curTime;
        this->startPos = this->currentPos;
        this->startLiftPos = this->liftPos;
        //this->p_tiltDirection(0);
      }
    }
    else if(this->currentTiltPos <= this->tiltTarget) {
      this->p_currentTiltPos(this->tiltTarget);
      // If we need to stop the shade do this before we indicate that we are
      // not moving otherwise the my function will kick in.
      if(this->settingTiltPos) {
        if(this->tiltType == tilt_types::integrated) {
          // If this is an integrated tilt mechanism the we will simply let it finish.  If it is not then we will stop it.
          //Serial.printf("Sending My -- tiltTarget: %.2f, tiltDirection: %d\n", this->tiltTarget, this->tiltDirection);
          if(this->tiltTarget != 0.0 || this->currentPos != 0.0) SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
        }
        else {
          // This is a tilt motor so let it complete if it is going to 0.
          if(this->tiltTarget != 0.0) SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
        }
      }
      this->p_tiltDirection(0);
      this->settingTiltPos = false;
      Serial.println("Stopping at tilt position");
      if(this->isAtTarget()) this->commitShadePosition();
    }
  }
  if(this->settingMyPos && this->isAtTarget()) {
    // The motor has to see a gap after the stop that just went out before the long My press
    // that records the position.  This was delay(200); it is now a deadline so the loop is
    // not held for 200ms on top of the multi-second SETMY_REPEATS transmission that follows.
    // finishSetMyPosition() runs from the top of checkMovement() once the gap has elapsed.
    this->startCmdGap(pending_cmd_t::setMyPos, 200);
  }
  else if(currDir != this->direction || currTiltDir != this->tiltDirection) {
    // A direction change means the shade just started, stopped or reached its
    // target. Emit immediately so Home Assistant never misses a transition, and
    // reset the throttle window so the next progress emit is spaced from here.
    this->emitState();
    this->lastMoveEmit = curTime;
  }
  else if(currPos != floor(this->currentPos) || currTiltPos != floor(this->currentTiltPos)) {
    // Plain travel progress. Throttle to one emit per MOVE_EMIT_INTERVAL so many
    // shades moving together cannot flood the loop (subtractive compare is rollover
    // safe). The exact final position is still delivered by the direction-change
    // branch above when the shade stops.
    if(curTime - this->lastMoveEmit >= MOVE_EMIT_INTERVAL) {
      this->emitState();
      this->lastMoveEmit = curTime;
    }
  }
}
void SomfyShade::finishSetMyPosition() {
  // Body of the settingMyPos block that used to sit at the end of checkMovement() behind a
  // delay(200).  It is unchanged: the caller only guarantees that the gap has elapsed and
  // that the shade is still settling its My position on the target.
  // Set this position before sending the command.  If you don't the processFrame function
  // will send the shade back to its original My position.
  if(this->tiltType != tilt_types::none) {
    if(this->myTiltPos == this->currentTiltPos && this->myPos == this->currentPos) this->myPos = this->myTiltPos = -1;
    else {
      this->p_myPos(this->currentPos);
      this->p_myTiltPos(this->currentTiltPos);
    }
  }
  else {
    this->p_myTiltPos(-1);
    if(this->myPos == this->currentPos) this->p_myPos(-1);
    else this->p_myPos(this->currentPos);
  }
  SomfyRemote::sendCommand(somfy_commands::My, SETMY_REPEATS);
  this->settingMyPos = false;
  this->commitMyPosition();
  this->emitState();
}

void SomfyShade::setTiltMovement(int8_t dir) {
  int8_t currDir = this->tiltDirection;
  if(dir == 0) {
    // The shade tilt is stopped.
    this->startTiltPos = this->currentTiltPos;
    this->tiltStart = 0;
    this->p_tiltDirection(dir);
    if(currDir != dir) {
      this->commitTiltPosition();
    }
  }
  else if(this->tiltDirection != dir) {
    this->tiltStart = millis();
    this->startTiltPos = this->currentTiltPos;
    this->p_tiltDirection(dir);
  }
  if(this->tiltDirection != currDir) {
    this->emitState();
  }
}
void SomfyShade::setMovement(int8_t dir) {
  int8_t currDir = this->direction;
  int8_t currTiltDir = this->tiltDirection;
  if(dir == 0) {
    if(currDir != dir || currTiltDir != dir) this->commitShadePosition();
  }
  else {
    this->tiltStart = this->moveStart = millis();
    this->startPos = this->currentPos;
    this->startTiltPos = this->currentTiltPos;
    this->startLiftPos = this->liftPos;
  }
  if(this->direction != currDir || currTiltDir != this->tiltDirection) {
    this->emitState();
  }
}
void SomfyShade::setMyPosition(int8_t pos, int8_t tilt) {
  if(!this->isIdle()) return; // Don't do this if it is moving.
  if(this->tiltType == tilt_types::tiltonly) {
    this->p_myPos(-1.0f);    
    if(tilt != floor(this->currentTiltPos)) {
      this->settingMyPos = true;
      if(tilt == floor(this->myTiltPos))
        this->moveToMyPosition();
      else 
        this->moveToTarget(100, tilt);
    }
    else if(tilt == floor(this->myTiltPos)) {
      // Of so we need to clear the my position. These motors are finicky so send
      // a my command to ensure we are actually at the my position then send the clear
      // command.  There really is no other way to do this.
      if(this->currentTiltPos != this->myTiltPos) {
        this->settingMyPos = true;
        this->moveToMyPosition();      
      }
      else {
        SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
        this->settingPos = false;
        this->settingMyPos = true;
      }
    }
    else {
      SomfyRemote::sendCommand(somfy_commands::My, SETMY_REPEATS);
      this->p_myTiltPos(this->currentTiltPos);
    }
    this->commitMyPosition();
    this->emitState();
  }
  else if(this->tiltType != tilt_types::none) {
      if(tilt < 0) tilt = 0;
      if(pos != floor(this->currentPos) || tilt != floor(this->currentTiltPos)) {
        this->settingMyPos = true;
        if(pos == floor(this->myPos) && tilt == floor(this->myTiltPos))
          this->moveToMyPosition();
        else
          this->moveToTarget(pos, tilt);
      }
      else if(pos == floor(this->myPos) && tilt == floor(this->myTiltPos)) {
        // Of so we need to clear the my position. These motors are finicky so send
        // a my command to ensure we are actually at the my position then send the clear
        // command.  There really is no other way to do this.
        if(this->currentPos != this->myPos || this->currentTiltPos != this->myTiltPos) {
          this->settingMyPos = true;
          this->moveToMyPosition();      
        }
        else {
          SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
          this->settingPos = false;
          this->settingMyPos = true;
        }
      }
      else {
        SomfyRemote::sendCommand(somfy_commands::My, SETMY_REPEATS);
        this->p_myPos(this->currentPos);
        this->p_myTiltPos(this->currentTiltPos);
      }
      this->commitMyPosition();
      this->emitState();
  }
  else {
    if(pos != floor(this->currentPos)) {
      this->settingMyPos = true;
      if(pos == floor(this->myPos))
        this->moveToMyPosition();
      else
        this->moveToTarget(pos);
    }
    else if(pos == floor(this->myPos)) {
      // Of so we need to clear the my position. These motors are finicky so send
      // a my command to ensure we are actually at the my position then send the clear
      // command.  There really is no other way to do this.
      if(this->myPos != this->currentPos) {
        this->settingMyPos = true;
        this->moveToMyPosition();      
      }
      else {
        SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
        this->settingPos = false;
        this->settingMyPos = true;
      }
    }
    else {
      SomfyRemote::sendCommand(somfy_commands::My, SETMY_REPEATS);
      this->p_myPos(currentPos);
      this->p_myTiltPos(-1);
      this->commitMyPosition();
      this->emitState();
    }
  }
}
void SomfyShade::moveToMyPosition() {
  if(!this->isIdle()) return;
  Serial.println("Moving to My Position");
  if(this->tiltType == tilt_types::tiltonly) {
    this->p_currentPos(100.0f);
    this->p_myPos(-1.0f);
  }
  if(this->currentPos == this->myPos) {
    if(this->tiltType != tilt_types::none) {
      if(this->currentTiltPos == this->myTiltPos) return; // Nothing to see here since we are already here.
    }
    else
      return;
  }
  if(this->myPos == -1 && (this->tiltType == tilt_types::none || this->myTiltPos == -1)) return;
  if(this->tiltType != tilt_types::tiltonly && this->myPos >= 0.0f && this->myPos <= 100.0f) this->p_target(this->myPos);
  if(this->myTiltPos >= 0.0f && this->myTiltPos <= 100.0f) this->p_tiltTarget(this->myTiltPos);
  this->settingPos = false;
  if(this->simMy()) {
    Serial.print("Moving to simulated favorite\n");
    this->moveToTarget(this->myPos, this->myTiltPos);
  }
  else
    SomfyRemote::sendCommand(somfy_commands::My, this->repeats);
}
void SomfyShade::sendCommand(somfy_commands cmd) { this->sendCommand(cmd, this->repeats); }
void SomfyShade::sendCommand(somfy_commands cmd, uint8_t repeat, uint8_t stepSize) {
  // This sendCommand function will always be called externally. sendCommand at the remote level
  // is expected to be called internally when the motor needs commanded.
  if(this->bitLength == 0) this->bitLength = somfy.transceiver.config.type;
  if(cmd == somfy_commands::Up) {
    if(this->tiltType == tilt_types::euromode) {
      // In euromode we need to long press for 2 seconds on the
      // up command.
      SomfyRemote::sendCommand(cmd, TILT_REPEATS);
      this->p_target(0.0f);     
    }
    else {
      SomfyRemote::sendCommand(cmd, repeat);
      if(this->tiltType == tilt_types::tiltonly) {
        this->p_target(100.0f);
        this->p_tiltTarget(0.0f);
        this->p_currentPos(100.0f);
      }
      else this->p_target(0.0f);
      if(this->tiltType == tilt_types::integrated) this->p_tiltTarget(0.0f);
    }
  }
  else if(cmd == somfy_commands::Down) {
    if(this->tiltType == tilt_types::euromode) {
      // In euromode we need to long press for 2 seconds on the
      // down command.
      SomfyRemote::sendCommand(cmd, TILT_REPEATS);
      this->p_target(100.0f);     
    }
    else {
      SomfyRemote::sendCommand(cmd, repeat);
      if(this->tiltType == tilt_types::tiltonly) {
        this->p_target(100.0f);
        this->p_tiltTarget(100.0f);
        this->p_currentPos(100.0f);
      }
      else this->p_target(100.0f);
      if(this->tiltType == tilt_types::integrated) this->p_tiltTarget(100.0f);
    }
  }
  else if(cmd == somfy_commands::My) {
    if(this->isToggle() || this->shadeType == shade_types::drycontact)
      SomfyRemote::sendCommand(cmd, repeat);
    else if(this->shadeType == shade_types::drycontact2) return;   
    else if(this->isIdle()) {
      this->moveToMyPosition();      
      return;
    }
    else {
      SomfyRemote::sendCommand(cmd, repeat);
      if(this->tiltType != tilt_types::tiltonly) this->p_target(this->currentPos);
      this->p_tiltTarget(this->currentTiltPos);
    }
  }
  else if(cmd == somfy_commands::Toggle) {
    if(this->bitLength != 80) SomfyRemote::sendCommand(somfy_commands::My, repeat, stepSize);
    else SomfyRemote::sendCommand(somfy_commands::Toggle, repeat);
  }
  else if(this->isToggle() && cmd == somfy_commands::Prog) {
    SomfyRemote::sendCommand(somfy_commands::Toggle, repeat, stepSize);
  }
  else {
    SomfyRemote::sendCommand(cmd, repeat, stepSize);
  }
}
void SomfyGroup::sendCommand(somfy_commands cmd) { this->sendCommand(cmd, this->repeats); }
void SomfyGroup::sendCommand(somfy_commands cmd, uint8_t repeat, uint8_t stepSize) {
  // This sendCommand function will always be called externally. sendCommand at the remote level
  // is expected to be called internally when the motor needs commanded.
  if(this->bitLength == 0) this->bitLength = somfy.transceiver.config.type;
  SomfyRemote::sendCommand(cmd, repeat, stepSize);
  
  switch(cmd) {
    case somfy_commands::My:
      this->p_direction(0);
      break;
    case somfy_commands::Up:
      this->p_direction(-1);
      break;
    case somfy_commands::Down:
      this->p_direction(1);
      break;
    default:
      break;
  }
  
  for(uint8_t i = 0; i < SOMFY_MAX_GROUPED_SHADES; i++) {
    if(this->linkedShades[i] != 0) {
      SomfyShade *shade = somfy.getShadeById(this->linkedShades[i]);
      if(shade) {
        shade->processInternalCommand(cmd, repeat);
        shade->emitCommand(cmd, "group", this->getRemoteAddress());
      }
    }
  }
  this->updateFlags();
  this->emitState();
  
}  
void SomfyShade::sendTiltCommand(somfy_commands cmd) {
  if(cmd == somfy_commands::Up) {
    SomfyRemote::sendCommand(cmd, this->tiltType == tilt_types::tiltmotor ? TILT_REPEATS : this->repeats);
    this->p_tiltTarget(0.0f);
  }
  else if(cmd == somfy_commands::Down) {
    SomfyRemote::sendCommand(cmd, this->tiltType == tilt_types::tiltmotor ? TILT_REPEATS : this->repeats);
    this->p_tiltTarget(100.0f);
  }
  else if(cmd == somfy_commands::My) {
    SomfyRemote::sendCommand(cmd, this->tiltType == tilt_types::tiltmotor ? TILT_REPEATS : this->repeats);
    this->p_tiltTarget(this->currentTiltPos);
  }
}
void SomfyShade::moveToTiltTarget(float target) {
  somfy_commands cmd = somfy_commands::My;
  if(target < this->currentTiltPos)
    cmd = somfy_commands::Up;
  else if(target > this->currentTiltPos)
    cmd = somfy_commands::Down;
  if(target >= 0.0f && target <= 100.0f) {
    // Only send a command if the lift is not moving.
    if(this->currentPos == this->target || this->tiltType == tilt_types::tiltmotor) {
      if(cmd != somfy_commands::My) {
        Serial.print("Moving Tilt to ");
        Serial.print(target);
        Serial.print("% from ");
        Serial.print(this->currentTiltPos);
        Serial.print("% using ");
        Serial.println(translateSomfyCommand(cmd));
        SomfyRemote::sendCommand(cmd, this->tiltType == tilt_types::tiltmotor ? TILT_REPEATS : this->repeats);
      }
      // If the blind is currently moving then the command to stop it
      // will occur on its own when the tilt target is set.
    }
    this->p_tiltTarget(target);
  }
  if(cmd != somfy_commands::My) this->settingTiltPos = true;
}
void SomfyShade::moveToTarget(float pos, float tilt) {
  somfy_commands cmd = somfy_commands::My;
  if(this->isToggle()) {
    // Overload this as we cannot seek a position on a garage door or single button device.
    this->p_target(pos);
    this->p_currentPos(pos);
    this->emitState();
    return;
  }
  if(this->tiltType == tilt_types::tiltonly) {
    this->p_target(100.0f);
    this->p_myPos(-1.0f);
    this->p_currentPos(100.0f);
    pos = 100;
    if(tilt < this->currentTiltPos) cmd = somfy_commands::Up;
    else if(tilt > this->currentTiltPos) cmd = somfy_commands::Down;
  }
  else {
    if(pos < this->currentPos)
      cmd = somfy_commands::Up;
    else if(pos > this->currentPos)
      cmd = somfy_commands::Down;
    else if(tilt >= 0 && tilt < this->currentTiltPos)
      cmd = somfy_commands::Up;
    else if(tilt >= 0 && tilt > this->currentTiltPos)
      cmd = somfy_commands::Down;
  }
  if(cmd != somfy_commands::My) {
    Serial.print("Moving to ");
    Serial.print(pos);
    Serial.print("% from ");
    Serial.print(this->currentPos);
    if(tilt >= 0) {
      Serial.print(" tilt ");
      Serial.print(tilt);
      Serial.print("% from ");
      Serial.print(this->currentTiltPos);
    }
    Serial.print("% using ");
    Serial.println(translateSomfyCommand(cmd));
    SomfyRemote::sendCommand(cmd, this->tiltType == tilt_types::euromode ? TILT_REPEATS : this->repeats);
    this->settingPos = true;
    this->p_target(pos);
    if(tilt >= 0) {
      this->p_tiltTarget(tilt);
      this->settingTiltPos = true;
    }
  }
}
