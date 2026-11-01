/*
  Smart Patient Health Monitoring & Engagement System
  ESP8266 NodeMCU firmware — USB serial mode, MAX30100 pulse oximeter version

  Use this sketch if your pulse sensor is a MAX30100 (the common purple/green
  "MAX30100" breakout). For a MAX30102 use firmware/esp8266_patient_monitor instead.
  This sketch checks the chip at start-up and reports if it finds the other one.

  Streams one JSON object per line over USB at 115200 baud for the web dashboard
  (dashboard/index.html, "Connect USB"). Same protocol as the MAX30102 sketch.

  Wiring (NodeMCU v2/v3):
    MAX30100  VIN -> 3V3   GND -> GND   SDA -> D2 (GPIO4)   SCL -> D1 (GPIO5)
    MPU6050   VCC -> 3V3   GND -> GND   SDA -> D5 (GPIO14)  SCL -> D6 (GPIO12)  AD0 -> GND (0x68)
              (or share the MAX30100's D2/D1 through a breadboard; the sketch checks both at start-up)
    LM35      +Vs -> VIN (5 V from USB)   GND -> GND   Vout -> A0

  Required library (Arduino IDE > Library Manager):
    "MAX30100lib" by OXullo Intersecans
  Board: "NodeMCU 1.0 (ESP-12E Module)" from the ESP8266 boards package.

  Serial protocol (device -> dashboard), one JSON object per line:
    {"type":"hello","device":"ESP8266","fw":"1.0.0-max30100","sensors":{"max30100":true,"mpu6050":true,"lm35":true}}
    {"type":"data","t":12345,"hr":72,"spo2":98,"finger":1,"temp":36.4,"motion":0.042,"steps":120,"fall":0}
  Missing / invalid readings are sent as null. Sensors that aren't connected are
  reported as false in the hello line; the sketch keeps running without them.

  Commands (dashboard -> device), newline terminated:
    INFO         re-send the hello line
    RESET_STEPS  zero the step counter
    SCAN         list the I2C devices that answer (also run automatically when a sensor is missing)
    A0           report the voltage on A0 in mV (wiring diagnostic)
    RAW          check the MAX30100 still answers and report raw IR/red light levels
    IRSWEEP      measure the IR level at several LED currents (finger on the sensor)
    IR <1-15>    set the IR LED current code until restart
*/

#include <ESP8266WiFi.h>
#include <Wire.h>
#include "MAX30100_PulseOximeter.h"

// ---------- Configuration ----------
// Turn sensors on/off. A disabled sensor isn't searched for and isn't listed to the dashboard.
const bool     USE_MPU6050     = true;   // set to false to run without the MPU6050 (D5/D6)
const bool     USE_LM35        = true;   // set to false to run without the LM35 (A0)

const uint32_t BAUD            = 115200;
const uint32_t REPORT_MS       = 1000;   // one JSON line per second
const uint32_t IMU_PERIOD_MS   = 20;     // 50 Hz accelerometer sampling
const uint32_t TEMP_PERIOD_MS  = 100;    // 10 Hz LM35 sampling, averaged per report
const uint32_t BEAT_TIMEOUT_MS = 4000;   // no heartbeat for this long = no finger / no valid reading
const float    ADC_VREF        = 3.3;    // NodeMCU boards scale A0 to 0-3.3 V (bare ESP-12 module: 1.0)
const float    TEMP_OFFSET_C   = 0.0;    // calibration offset, tune against a reference thermometer
const uint8_t  MPU_ADDR        = 0x68;
const uint8_t  PULSE_ADDR      = 0x57;   // MAX30100 and MAX30102 share this address
const char*    FW_VERSION      = "1.0.0-max30100";

// IR LED current. Measured with the IRSWEEP command on this board: the IR signal saturates
// (stuck at 65535, no beats detected) from ~40 mA up, including the library's 50 mA default.
// 20.8 mA puts it mid-range. Re-run IRSWEEP with a finger on the sensor if you change boards.
const LEDCurrent IR_CURRENT = MAX30100_LED_CURR_20_8MA;
LEDCurrent irCurrent = IR_CURRENT;  // active setting; the "IR <code>" command changes it until restart

// ---------- MAX30100 (heart rate + SpO2) ----------
PulseOximeter pox;
bool hasPulse = false;
int pulsePartId = -1;   // 0x11 = MAX30100, 0x15 = MAX30102, -1 = no answer
uint32_t lastBeatMs = 0;
bool mpuAt69 = false;   // MPU6050 found at 0x69 = its AD0 pin is high/floating

// ---------- MPU6050 (activity, steps, falls) ----------
// The MPU6050 may share the MAX30100's pins (D2/D1) or have its own (D5/D6). On its own pins
// it is driven by a small bit-banged I2C (SoftI2C below), so the Wire bus the MAX30100
// library uses is never reconfigured while it's sampling.
const uint8_t MAIN_SDA = 4, MAIN_SCL = 5;          // D2, D1
const uint8_t MPU_OWN_SDA = 14, MPU_OWN_SCL = 12;  // D5, D6
bool mpuOwnBus = false;
bool mpuLinesLow = false;  // D5/D6 held low at start-up: MPU6050 unpowered or shorted
bool hasMpu = false;
float motionSum = 0;
uint16_t motionN = 0;
uint32_t steps = 0;
float magLp = 1.0;
bool stepHigh = false;
uint32_t lastStepMs = 0, freefallMs = 0;
bool fallFlag = false;

// ---------- LM35 (temperature) ----------
uint32_t tempSum = 0;
uint16_t tempN = 0;

uint32_t lastImuMs = 0, lastTempMs = 0, lastReportMs = 0;

// ---------------------------------------------------------------------------

uint16_t beatCount = 0;  // beats detected since the last report (diagnostic "beats" field)

void onBeatDetected() {
  lastBeatMs = millis();
  beatCount++;
}

/* Reads the PART_ID register: 0x11 = MAX30100, 0x15 = MAX30102, -1 = nothing answered. */
int readPulsePartId() {
  Wire.beginTransmission(PULSE_ADDR);
  Wire.write(0xFF);
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom(PULSE_ADDR, (uint8_t)1) != 1) return -1;
  return Wire.read();
}

/* Minimal bit-banged I2C master (~100 kHz, open-drain via pinMode, supports clock stretching). */
class SoftI2C {
 public:
  void begin(uint8_t sda, uint8_t scl) {
    _sda = sda;
    _scl = scl;
    release(_sda);
    release(_scl);
  }

  /* Both lines must idle high (pulled up by the sensor board). If either reads low, the sensor
     has no power or a wire is shorted to GND, and any "answer" would be fake. */
  bool linesHigh() {
    release(_sda);
    release(_scl);
    delayMicroseconds(20);
    return digitalRead(_sda) && digitalRead(_scl);
  }

  bool writeReg(uint8_t addr, uint8_t reg, uint8_t val) {
    _fault = false;
    start();
    bool ok = write(addr << 1) && write(reg) && write(val);
    stop();
    return ok && !_fault;
  }

  bool readRegs(uint8_t addr, uint8_t reg, uint8_t* buf, uint8_t n) {
    _fault = false;
    start();
    if (!write(addr << 1) || !write(reg)) {
      stop();
      return false;
    }
    start();  // repeated start
    if (!write((addr << 1) | 1)) {
      stop();
      return false;
    }
    for (uint8_t i = 0; i < n && !_fault; i++) buf[i] = read(i + 1 < n);
    stop();
    return !_fault;
  }

 private:
  uint8_t _sda = 0, _scl = 0;
  bool _fault = false;  // SCL never went high: abort instead of waiting on every bit

  static void pull(uint8_t pin) {
    digitalWrite(pin, LOW);
    pinMode(pin, OUTPUT);
  }
  static void release(uint8_t pin) { pinMode(pin, INPUT_PULLUP); }
  static void pause() { delayMicroseconds(5); }

  void sclHigh() {
    release(_scl);
    if (_fault) return;
    uint16_t t = 1000;  // allow up to ~1 ms of clock stretching
    while (!digitalRead(_scl) && --t) delayMicroseconds(1);
    if (!t) _fault = true;
  }

  void start() {
    release(_sda);
    sclHigh();
    pause();
    pull(_sda);
    pause();
    pull(_scl);
    pause();
  }

  void stop() {
    pull(_sda);
    pause();
    sclHigh();
    pause();
    release(_sda);
    pause();
  }

  bool write(uint8_t b) {
    if (_fault) return false;
    for (uint8_t m = 0x80; m; m >>= 1) {
      if (b & m) release(_sda);
      else pull(_sda);
      pause();
      sclHigh();
      pause();
      pull(_scl);
    }
    release(_sda);  // let the device ACK
    pause();
    sclHigh();
    pause();
    bool ack = !digitalRead(_sda);
    pull(_scl);
    pause();
    return ack && !_fault;
  }

  uint8_t read(bool ack) {
    uint8_t b = 0;
    release(_sda);
    for (uint8_t i = 0; i < 8; i++) {
      pause();
      sclHigh();
      pause();
      b = (b << 1) | (digitalRead(_sda) ? 1 : 0);
      pull(_scl);
    }
    if (ack) pull(_sda);
    else release(_sda);
    pause();
    sclHigh();
    pause();
    pull(_scl);
    release(_sda);
    pause();
    return b;
  }
};

SoftI2C mpuBus;

bool mpuWrite(uint8_t reg, uint8_t val) {
  if (mpuOwnBus) return mpuBus.writeReg(MPU_ADDR, reg, val);
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool mpuReadReg(uint8_t reg, uint8_t &val) {
  if (mpuOwnBus) return mpuBus.readRegs(MPU_ADDR, reg, &val, 1);
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MPU_ADDR, (uint8_t)1) != 1) return false;
  val = Wire.read();
  return true;
}

bool mpuInit() {
  // WHO_AM_I must return a real ID (0x68 on genuine chips, other values on clones).
  // 0x00/0xFF means nothing is really answering, e.g. a data line stuck low.
  uint8_t who = 0;
  if (!mpuReadReg(0x75, who) || who == 0x00 || who == 0xFF) return false;
  if (!mpuWrite(0x6B, 0x00)) return false;  // PWR_MGMT_1: wake up
  mpuWrite(0x1C, 0x08);                     // ACCEL_CONFIG: +/-4 g (8192 LSB/g)
  mpuWrite(0x1A, 0x03);                     // CONFIG: DLPF ~44 Hz
  return true;
}

bool mpuReadAccel(float &ax, float &ay, float &az) {
  uint8_t b[6];
  if (mpuOwnBus) {
    if (!mpuBus.readRegs(MPU_ADDR, 0x3B, b, 6)) return false;  // ACCEL_XOUT_H..ZOUT_L
  } else {
    Wire.beginTransmission(MPU_ADDR);
    Wire.write(0x3B);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom(MPU_ADDR, (uint8_t)6) != 6) return false;
    for (uint8_t i = 0; i < 6; i++) b[i] = Wire.read();
  }
  ax = (int16_t)((b[0] << 8) | b[1]) / 8192.0;
  ay = (int16_t)((b[2] << 8) | b[3]) / 8192.0;
  az = (int16_t)((b[4] << 8) | b[5]) / 8192.0;
  return true;
}

void sendHello() {
  Serial.print(F("{\"type\":\"hello\",\"device\":\"ESP8266\",\"fw\":\""));
  Serial.print(FW_VERSION);
  Serial.print(F("\",\"sensors\":{\"max30100\":"));
  Serial.print(hasPulse ? F("true") : F("false"));
  if (USE_MPU6050) {
    Serial.print(F(",\"mpu6050\":"));
    Serial.print(hasMpu ? F("true") : F("false"));
  }
  if (USE_LM35) Serial.print(F(",\"lm35\":true"));
  Serial.println(F("}}"));
}

void sendError(const __FlashStringHelper* msg) {
  Serial.print(F("{\"type\":\"error\",\"msg\":\""));
  Serial.print(msg);
  Serial.println(F("\"}"));
}

void sendInfo(const __FlashStringHelper* msg) {
  Serial.print(F("{\"type\":\"info\",\"msg\":\""));
  Serial.print(msg);
  Serial.println(F("\"}"));
}

/* True if both pins idle high with pull-ups. A line held low (unpowered sensor, short to GND)
   would make the I2C driver wait for clock stretching on every bit. */
bool pinsIdleHigh(uint8_t a, uint8_t b) {
  pinMode(a, INPUT_PULLUP);
  pinMode(b, INPUT_PULLUP);
  delayMicroseconds(20);
  return digitalRead(a) && digitalRead(b);
}

/* Wire.begin() for probing: short clock-stretch limit so a bad line costs ~2 ms, not 150 ms. */
void probeBusBegin(uint8_t sda, uint8_t scl) {
  Wire.begin(sda, scl);
  Wire.setClock(100000);
  Wire.setClockStretchLimit(2000);
}

/* Probes every I2C address on the given pins. Prints {"type":"scan",...} and returns how many answered. */
int scanBus(uint8_t sda, uint8_t scl, const __FlashStringHelper* label, bool &foundPulse, bool &foundMpu) {
  foundPulse = foundMpu = false;
  Serial.print(F("{\"type\":\"scan\",\"pins\":\""));
  Serial.print(label);
  if (!pinsIdleHigh(sda, scl)) {
    Serial.println(F("\",\"found\":[],\"held_low\":true}"));
    return 0;
  }
  probeBusBegin(sda, scl);
  int count = 0;
  Serial.print(F("\",\"found\":["));
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      if (count++) Serial.print(',');
      Serial.print(F("\"0x"));
      if (addr < 16) Serial.print('0');
      Serial.print(addr, HEX);
      Serial.print('"');
      if (addr == PULSE_ADDR) foundPulse = true;
      if (addr == MPU_ADDR) foundMpu = true;
      if (addr == MPU_ADDR + 1) mpuAt69 = true;
    }
    yield();
  }
  Serial.println(F("]}"));
  return count;
}

bool probe(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

/* Looks for the MPU6050 on every other usable NodeMCU pin pair, to catch wires plugged
   into the wrong pins. GPIO1/3 (USB serial), 15 (boot pull-down) and 16 (no I2C) are skipped. */
const uint8_t PROBE_GPIO[] = {4, 5, 0, 2, 14, 12, 13};
const char* const PROBE_NAME[] = {"D2", "D1", "D3", "D4", "D5", "D6", "D7"};

/* Searches every usable pin pair for a device at addrA/addrB and reports where its wires are.
   requireIdleHigh skips pairs held low (fast); off for the MAX30100, whose 1.8 V pull-ups can read low. */
bool findDevicePins(uint8_t addrA, uint8_t addrB, bool requireIdleHigh,
                    const __FlashStringHelper* name, const __FlashStringHelper* advice) {
  const uint8_t n = sizeof(PROBE_GPIO);
  for (uint8_t i = 0; i < n; i++) {
    for (uint8_t j = 0; j < n; j++) {
      if (i == j || (PROBE_GPIO[i] == 4 && PROBE_GPIO[j] == 5)) continue;  // 4/5 = the normal wiring, already scanned
      if (requireIdleHigh && !pinsIdleHigh(PROBE_GPIO[i], PROBE_GPIO[j])) continue;
      probeBusBegin(PROBE_GPIO[i], PROBE_GPIO[j]);
      bool found = probe(addrA) || (addrB != addrA && probe(addrB));
      yield();
      if (found) {
        Wire.begin(4, 5);
        Serial.print(F("{\"type\":\"error\",\"msg\":\""));
        Serial.print(name);
        Serial.print(F(" found with its SDA wire on "));
        Serial.print(PROBE_NAME[i]);
        Serial.print(F(" and its SCL wire on "));
        Serial.print(PROBE_NAME[j]);
        Serial.print(F(". "));
        Serial.print(advice);
        Serial.println(F("\"}"));
        return true;
      }
    }
  }
  Wire.begin(4, 5);
  return false;
}

void findMpuPins() {
  if (!findDevicePins(MPU_ADDR, MPU_ADDR + 1, true, F("MPU6050"),
                      F("Move them to D5 (SDA) and D6 (SCL), or share D2/D1 with the MAX30100 through a breadboard."))) {
    sendError(F("MPU6050 does not answer on any NodeMCU pins. If its red power LED is on, its SDA/SCL wires are loose or broken somewhere between the sensor and the NodeMCU (check breadboard rows). If the LED is off, check VCC and GND."));
  }
}

void findPulsePins() {
  if (!findDevicePins(PULSE_ADDR, PULSE_ADDR, false, F("MAX30100"),
                      F("It works, so move them to D2 (SDA) and D1 (SCL)."))) {
    sendError(F("MAX30100 does not answer on any NodeMCU pins: it has no power (check VIN->3V3 and GND->G with fresh jumper wires) or the module is faulty."));
  }
}

/* Scans with the expected wiring and with SDA/SCL swapped, and explains the result. */
void diagnoseBus() {
  bool p1, m1, p2, m2;
  int normal = scanBus(4, 5, F("SDA=D2, SCL=D1"), p1, m1);
  int swapped = scanBus(5, 4, F("SDA=D1, SCL=D2 (swapped)"), p2, m2);
  Wire.begin(4, 5);  // back to the real wiring

  if (normal == 0 && swapped > 0) {
    sendError(F("I2C sensors answer only with SDA/SCL swapped: swap the two wires on D1 and D2."));
  } else if (normal == 0) {
    if (!hasPulse) findPulsePins();  // maybe its wires are on other pins
    else sendError(F("No I2C device answers on D1/D2. Check each sensor's VCC->3V3 and GND->G, that SDA/SCL go to D2/D1, and that the sensor header pins are soldered (pins only pushed through the holes don't connect)."));
  } else {
    if (!p1) {
      findPulsePins();
    } else if (!hasPulse && pulsePartId != 0x15) {
      Serial.print(F("{\"type\":\"error\",\"msg\":\"A device answers at 0x57 but reports part ID 0x"));
      Serial.print(pulsePartId, HEX);
      Serial.println(F(" instead of 0x11 (MAX30100). It may be a clone or a different chip.\"}"));
    }
    if (!m1 && mpuAt69) sendError(F("MPU6050 answers at 0x69 instead of 0x68: connect its AD0 pin to GND."));
    // Search other pins only if the MPU isn't already known to be on D5/D6 (working or unpowered).
    else if (USE_MPU6050 && !m1 && !mpuOwnBus && !mpuLinesLow) findMpuPins();
  }
  Wire.begin(4, 5);       // restores the normal clock-stretch limit too
  Wire.setClock(400000);  // back to the speed the MAX30100 library set
}

void setup() {
  Serial.begin(BAUD);
  WiFi.mode(WIFI_OFF);  // USB mode: radio off lowers power and ADC noise
  delay(200);
  Serial.println();

  Wire.begin(4, 5);  // SDA = GPIO4 (NodeMCU D2), SCL = GPIO5 (NodeMCU D1); GPIO numbers work with any ESP8266 board setting

  int partId = pulsePartId = readPulsePartId();
  if (partId == 0x15) {
    sendError(F("Found a MAX30102, not a MAX30100. Flash firmware/esp8266_patient_monitor instead."));
  } else {
    hasPulse = pox.begin();  // also sets the I2C bus to 400 kHz
    if (hasPulse) {
      pox.setIRLedCurrent(IR_CURRENT);
      pox.setOnBeatDetectedCallback(onBeatDetected);
    } else {
      sendError(F("MAX30100 not found. Check wiring (SDA=D2, SCL=D1, VIN=3V3)."));
    }
  }

  // MPU6050: first on the shared D2/D1 bus, then on its own D5/D6 pins.
  hasMpu = USE_MPU6050 && mpuInit();
  if (USE_MPU6050 && !hasMpu) {
    mpuOwnBus = true;
    mpuBus.begin(MPU_OWN_SDA, MPU_OWN_SCL);
    mpuLinesLow = !mpuBus.linesHigh();
    hasMpu = !mpuLinesLow && mpuInit();
    if (hasMpu) sendInfo(F("MPU6050 found on its own pins (SDA=D5, SCL=D6)."));
    else mpuOwnBus = false;
  }
  if (mpuLinesLow) {
    sendError(F("D5/D6 are held LOW: the MPU6050 is probably not powered (its red LED should be on; check VCC->3V3 and GND->G) or one of its SDA/SCL wires touches GND."));
  } else if (USE_MPU6050 && !hasMpu) {
    sendError(F("MPU6050 not found on D2/D1 or D5/D6. Check wiring and that AD0 is connected to GND."));
  }

  if (!hasPulse || (USE_MPU6050 && !hasMpu)) diagnoseBus();

  sendHello();
}

void readImu(uint32_t now) {
  float ax, ay, az;
  if (!mpuReadAccel(ax, ay, az)) return;
  float mag = sqrt(ax * ax + ay * ay + az * az);

  motionSum += fabs(mag - 1.0);  // deviation from gravity = movement intensity
  motionN++;

  // Step counter: rising edge on low-passed magnitude with hysteresis + refractory period.
  magLp = magLp * 0.8 + mag * 0.2;
  if (!stepHigh && magLp > 1.15 && now - lastStepMs > 300) {
    stepHigh = true;
    steps++;
    lastStepMs = now;
  } else if (stepHigh && magLp < 1.02) {
    stepHigh = false;
  }

  // Fall: free-fall (< 0.4 g) followed by an impact (> 2.5 g) within 1 s.
  if (mag < 0.4) freefallMs = now;
  if (freefallMs && now - freefallMs < 1000 && mag > 2.5) {
    fallFlag = true;
    freefallMs = 0;
  }
}

void printNum(const char* key, float v, int decimals, bool valid) {
  Serial.print(",\"");
  Serial.print(key);
  Serial.print("\":");
  if (valid) Serial.print(v, decimals);
  else Serial.print("null");
}

void report(uint32_t now) {
  // The MAX30100 library has no finger-detect; recent heartbeats are the best signal.
  bool finger = hasPulse && lastBeatMs && now - lastBeatMs < BEAT_TIMEOUT_MS;
  float hr = hasPulse ? pox.getHeartRate() : 0;
  uint8_t spo2 = hasPulse ? pox.getSpO2() : 0;
  bool hrOk = finger && hr >= 40 && hr <= 200;
  bool spo2Ok = finger && spo2 >= 70 && spo2 <= 100;

  float tempC = 0;
  bool tempOk = false;
  if (tempN) {
    float mv = (tempSum / (float)tempN) * ADC_VREF * 1000.0 / 1024.0;
    tempC = mv / 10.0 + TEMP_OFFSET_C;  // LM35: 10 mV per degree C
    tempOk = tempC > 5 && tempC < 60;   // outside this range the sensor is likely disconnected
  }

  float motion = motionN ? motionSum / motionN : 0;

  Serial.print("{\"type\":\"data\",\"t\":");
  Serial.print(now);
  printNum("hr", hr, 0, hrOk);
  printNum("spo2", spo2, 0, spo2Ok);
  Serial.print(",\"finger\":");
  Serial.print(finger ? 1 : 0);
  printNum("temp", tempC, 1, tempOk);
  printNum("motion", motion, 3, hasMpu && motionN);
  printNum("steps", steps, 0, hasMpu);
  Serial.print(",\"fall\":");
  Serial.print(fallFlag ? 1 : 0);
  Serial.print(",\"beats\":");
  Serial.print(beatCount);
  Serial.println("}");

  beatCount = 0;
  motionSum = 0;
  motionN = 0;
  tempSum = 0;
  tempN = 0;
  fallFlag = false;
}

/* Signal diagnostic: checks the MAX30100 still answers and reports raw IR/red levels over ~1 s.
   No finger: low IR. Finger on: much higher IR that varies a little with the pulse.
   IR stuck near 65535: LED too bright (saturated). (Briefly pauses the pulse algorithm.) */
void rawDiagnostic() {
  int id = readPulsePartId();
  uint16_t irMin = 65535, irMax = 0, redMin = 65535, redMax = 0;
  uint32_t irSum = 0;
  uint16_t n = 0;
  if (id == 0x11) {
    for (uint8_t i = 0; i < 100; i++) {
      Wire.beginTransmission(PULSE_ADDR);
      Wire.write(0x05);  // FIFO_DATA: IR (16 bit) then red (16 bit)
      if (Wire.endTransmission(false) == 0 && Wire.requestFrom(PULSE_ADDR, (uint8_t)4) == 4) {
        uint16_t ir = (Wire.read() << 8) | Wire.read();
        uint16_t red = (Wire.read() << 8) | Wire.read();
        irMin = min(irMin, ir);
        irMax = max(irMax, ir);
        redMin = min(redMin, red);
        redMax = max(redMax, red);
        irSum += ir;
        n++;
      }
      delay(10);
    }
  }
  Serial.print(F("{\"type\":\"raw\",\"part_id\":"));
  Serial.print(id);
  Serial.print(F(",\"samples\":"));
  Serial.print(n);
  if (n) {
    Serial.print(F(",\"ir_min\":"));
    Serial.print(irMin);
    Serial.print(F(",\"ir_max\":"));
    Serial.print(irMax);
    Serial.print(F(",\"ir_avg\":"));
    Serial.print(irSum / n);
    Serial.print(F(",\"red_min\":"));
    Serial.print(redMin);
    Serial.print(F(",\"red_max\":"));
    Serial.print(redMax);
  }
  Serial.println(F("}"));
}

/* Tries several IR LED currents (finger on the sensor) and reports the IR level for each,
   to choose IR_CURRENT: pick the highest one whose ir_max stays well below 65535. */
void irSweep() {
  if (!hasPulse) {
    sendError(F("IRSWEEP needs the MAX30100 to be connected."));
    return;
  }
  // LEDCurrent register codes and their currents in mA x10.
  const uint8_t codes[] = {1, 2, 3, 4, 5, 6, 8, 10, 12, 15};
  const uint16_t ma10[] = {44, 76, 110, 142, 174, 208, 271, 338, 402, 500};
  for (uint8_t k = 0; k < sizeof(codes); k++) {
    pox.setIRLedCurrent((LEDCurrent)codes[k]);
    delay(150);  // let the new brightness settle
    uint16_t irMin = 65535, irMax = 0;
    uint32_t irSum = 0;
    uint8_t n = 0;
    for (uint8_t i = 0; i < 30; i++) {
      Wire.beginTransmission(PULSE_ADDR);
      Wire.write(0x05);
      if (Wire.endTransmission(false) == 0 && Wire.requestFrom(PULSE_ADDR, (uint8_t)4) == 4) {
        uint16_t ir = (Wire.read() << 8) | Wire.read();
        Wire.read();
        Wire.read();
        irMin = min(irMin, ir);
        irMax = max(irMax, ir);
        irSum += ir;
        n++;
      }
      delay(10);
    }
    Serial.print(F("{\"type\":\"irsweep\",\"code\":"));
    Serial.print(codes[k]);
    Serial.print(F(",\"ma\":"));
    Serial.print(ma10[k] / 10.0, 1);
    Serial.print(F(",\"ir_min\":"));
    Serial.print(n ? irMin : 0);
    Serial.print(F(",\"ir_max\":"));
    Serial.print(irMax);
    Serial.print(F(",\"ir_avg\":"));
    Serial.print(n ? irSum / n : 0);
    Serial.println(F("}"));
    yield();
  }
  pox.setIRLedCurrent(irCurrent);  // back to the active setting
}

void runCommand(String cmd) {
  cmd.trim();
  cmd.toUpperCase();
  if (cmd == "INFO") {
    sendHello();
  } else if (cmd == "RESET_STEPS") {
    steps = 0;
  } else if (cmd == "SCAN") {
    diagnoseBus();
  } else if (cmd == "RAW") {
    rawDiagnostic();
  } else if (cmd == "IRSWEEP") {
    irSweep();
  } else if (cmd.startsWith("IR ") && hasPulse) {
    // IR <code 0-15>: change the IR LED current until the next restart (see irSweep for codes).
    int code = cmd.substring(3).toInt();
    if (code < 1 || code > 15) {
      sendError(F("IR needs a code from 1 to 15."));
      return;
    }
    irCurrent = (LEDCurrent)code;
    pox.setIRLedCurrent(irCurrent);
  } else if (cmd == "A0") {
    // Wiring diagnostic: voltage on A0 in millivolts (e.g. put a sensor's SDA wire on A0 to see its idle level).
    uint32_t sum = 0;
    for (uint8_t i = 0; i < 16; i++) {
      sum += analogRead(A0);
      delay(2);
    }
    Serial.print(F("{\"type\":\"info\",\"msg\":\"A0 = "));
    Serial.print((uint32_t)(sum / 16.0 * ADC_VREF * 1000.0 / 1024.0));
    Serial.println(F(" mV\"}"));
  } else {
    Serial.print(F("{\"type\":\"error\",\"msg\":\"unknown command\",\"cmd\":\""));
    Serial.print(cmd);
    Serial.println(F("\"}"));
    return;
  }
  Serial.print(F("{\"type\":\"ack\",\"cmd\":\""));
  Serial.print(cmd);
  Serial.println(F("\"}"));
}

void handleCommands() {
  static String cmd;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (cmd.length()) runCommand(cmd);
      cmd = "";
    } else if (cmd.length() < 32) {
      cmd += c;
    }
  }
}

void loop() {
  // Must run as often as possible: the MAX30100 buffer overflows after ~160 ms,
  // so nothing in this loop may block (no delay(), no network calls).
  if (hasPulse) pox.update();

  uint32_t now = millis();
  handleCommands();

  if (hasMpu && now - lastImuMs >= IMU_PERIOD_MS) {
    lastImuMs = now;
    readImu(now);
  }

  if (USE_LM35 && now - lastTempMs >= TEMP_PERIOD_MS) {
    lastTempMs = now;
    tempSum += analogRead(A0);
    tempN++;
  }

  if (now - lastReportMs >= REPORT_MS) {
    lastReportMs = now;
    report(now);
  }
}
