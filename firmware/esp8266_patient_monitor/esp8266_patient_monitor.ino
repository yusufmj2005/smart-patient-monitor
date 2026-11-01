/*
  Smart Patient Health Monitoring & Engagement System
  ESP8266 NodeMCU firmware — USB serial mode

  Streams one JSON object per line over USB at 115200 baud. The web dashboard
  (dashboard/index.html) reads these lines through the browser's Web Serial API.

  Wiring (NodeMCU v2/v3, both I2C devices share the bus):
    MAX30102  VIN -> 3V3   GND -> GND   SDA -> D2 (GPIO4)   SCL -> D1 (GPIO5)
    MPU6050   VCC -> 3V3   GND -> GND   SDA -> D2 (GPIO4)   SCL -> D1 (GPIO5)   AD0 -> GND (0x68)
    LM35      +Vs -> VIN (5 V from USB)   GND -> GND   Vout -> A0
              (the LM35 needs >= 4 V supply; its output at body temperature is ~0.37 V, safe for A0)

  Required library (Arduino IDE > Library Manager):
    "SparkFun MAX3010x Pulse and Proximity Sensor Library"
  Board: "NodeMCU 1.0 (ESP-12E Module)" from the ESP8266 boards package.

  Serial protocol (device -> dashboard), one JSON object per line:
    {"type":"hello","device":"ESP8266","fw":"1.0.0","sensors":{"max30102":true,"mpu6050":true,"lm35":true}}
    {"type":"data","t":12345,"hr":72,"spo2":98,"finger":1,"ir":81234,"temp":36.4,"motion":0.042,"steps":120,"fall":0}
  Missing / invalid readings are sent as null.

  Commands (dashboard -> device), newline terminated:
    INFO         re-send the hello line
    RESET_STEPS  zero the step counter
*/

#include <ESP8266WiFi.h>
#include <Wire.h>
#include "MAX30105.h"
#include "spo2_algorithm.h"

// ---------- Configuration ----------
const uint32_t BAUD           = 115200;
const uint32_t REPORT_MS      = 1000;   // one JSON line per second
const uint32_t IMU_PERIOD_MS  = 20;     // 50 Hz accelerometer sampling
const uint32_t TEMP_PERIOD_MS = 100;    // 10 Hz LM35 sampling, averaged per report
const uint32_t FINGER_IR_MIN  = 50000;  // IR level below this = no finger on the MAX30102
const uint32_t VITAL_HOLD_MS  = 5000;   // keep last valid HR/SpO2 this long before reporting null
const float    ADC_VREF       = 3.3;    // NodeMCU boards scale A0 to 0-3.3 V (bare ESP-12 module: 1.0)
const float    TEMP_OFFSET_C  = 0.0;    // calibration offset, tune against a reference thermometer
const uint8_t  MPU_ADDR       = 0x68;
const char*    FW_VERSION     = "1.0.0";

// ---------- MAX30102 (heart rate + SpO2) ----------
// The Maxim algorithm expects 100 samples at 25 Hz (4 s). We slide the window by
// 25 samples, so a fresh estimate is produced every second once the buffer fills.
const int32_t BUF_LEN = 100;
const int32_t BUF_STEP = 25;
MAX30105 pulse;
bool hasMax = false;
uint32_t irBuf[BUF_LEN], redBuf[BUF_LEN];
int32_t bufCount = 0;
uint32_t lastIr = 0;
float hrSmooth = 0, spo2Smooth = 0;
uint32_t hrValidAt = 0, spo2ValidAt = 0;

// ---------- MPU6050 (activity, steps, falls) ----------
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

bool mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool mpuInit() {
  if (!mpuWrite(0x6B, 0x00)) return false;  // PWR_MGMT_1: wake up
  mpuWrite(0x1C, 0x08);                     // ACCEL_CONFIG: +/-4 g (8192 LSB/g)
  mpuWrite(0x1A, 0x03);                     // CONFIG: DLPF ~44 Hz
  return true;
}

bool mpuReadAccel(float &ax, float &ay, float &az) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);  // ACCEL_XOUT_H
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MPU_ADDR, (uint8_t)6) != 6) return false;
  int16_t x = (Wire.read() << 8) | Wire.read();
  int16_t y = (Wire.read() << 8) | Wire.read();
  int16_t z = (Wire.read() << 8) | Wire.read();
  ax = x / 8192.0;
  ay = y / 8192.0;
  az = z / 8192.0;
  return true;
}

/* Reads the PART_ID register: 0x15 = MAX30102, 0x11 = MAX30100, -1 = nothing answered. */
int readPulsePartId() {
  Wire.beginTransmission(0x57);
  Wire.write(0xFF);
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom((uint8_t)0x57, (uint8_t)1) != 1) return -1;
  return Wire.read();
}

void sendError(const __FlashStringHelper* msg) {
  Serial.print(F("{\"type\":\"error\",\"msg\":\""));
  Serial.print(msg);
  Serial.println(F("\"}"));
}

void sendHello() {
  Serial.print(F("{\"type\":\"hello\",\"device\":\"ESP8266\",\"fw\":\""));
  Serial.print(FW_VERSION);
  Serial.print(F("\",\"sensors\":{\"max30102\":"));
  Serial.print(hasMax ? F("true") : F("false"));
  Serial.print(F(",\"mpu6050\":"));
  Serial.print(hasMpu ? F("true") : F("false"));
  Serial.println(F(",\"lm35\":true}}"));
}

void setup() {
  Serial.begin(BAUD);
  WiFi.mode(WIFI_OFF);  // USB mode: radio off lowers power and ADC noise
  delay(200);
  Serial.println();

  Wire.begin();  // SDA = D2 (GPIO4), SCL = D1 (GPIO5)

  hasMax = pulse.begin(Wire, I2C_SPEED_FAST);
  if (hasMax) {
    // brightness, sampleAverage, ledMode (2 = red+IR), sampleRate, pulseWidth, adcRange
    // 100 Hz / 4 averaged = 25 Hz effective, as the SpO2 algorithm expects.
    pulse.setup(60, 4, 2, 100, 411, 4096);
  } else if (readPulsePartId() == 0x11) {
    sendError(F("Found a MAX30100, not a MAX30102. Flash firmware/esp8266_patient_monitor_max30100 instead."));
  } else {
    sendError(F("MAX30102 not found. Check wiring (SDA=D2, SCL=D1, VIN=3V3)."));
  }
  hasMpu = mpuInit();
  if (!hasMpu) sendError(F("MPU6050 not found. Check wiring and that AD0 is connected to GND."));

  sendHello();
}

void resetPulseBuffer() {
  bufCount = 0;
}

void readPulse(uint32_t now) {
  pulse.check();
  while (pulse.available()) {
    uint32_t red = pulse.getFIFORed();
    uint32_t ir = pulse.getFIFOIR();
    pulse.nextSample();
    lastIr = ir;

    if (ir < FINGER_IR_MIN) {  // no finger: discard the partial window
      resetPulseBuffer();
      continue;
    }

    if (bufCount == BUF_LEN) {  // slide window
      memmove(irBuf, irBuf + BUF_STEP, (BUF_LEN - BUF_STEP) * sizeof(uint32_t));
      memmove(redBuf, redBuf + BUF_STEP, (BUF_LEN - BUF_STEP) * sizeof(uint32_t));
      bufCount = BUF_LEN - BUF_STEP;
    }
    irBuf[bufCount] = ir;
    redBuf[bufCount] = red;
    bufCount++;

    if (bufCount == BUF_LEN) {
      int32_t spo2, hr;
      int8_t spo2Valid, hrValid;
      maxim_heart_rate_and_oxygen_saturation(irBuf, BUF_LEN, redBuf, &spo2, &spo2Valid, &hr, &hrValid);
      if (hrValid && hr >= 40 && hr <= 200) {
        hrSmooth = (now - hrValidAt > VITAL_HOLD_MS) ? hr : hrSmooth * 0.7 + hr * 0.3;
        hrValidAt = now;
      }
      if (spo2Valid && spo2 >= 70 && spo2 <= 100) {
        spo2Smooth = (now - spo2ValidAt > VITAL_HOLD_MS) ? spo2 : spo2Smooth * 0.5 + spo2 * 0.5;
        spo2ValidAt = now;
      }
    }
  }
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
  bool finger = hasMax && lastIr >= FINGER_IR_MIN;
  bool hrOk = finger && hrValidAt && now - hrValidAt <= VITAL_HOLD_MS;
  bool spo2Ok = finger && spo2ValidAt && now - spo2ValidAt <= VITAL_HOLD_MS;

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
  printNum("hr", hrSmooth, 0, hrOk);
  printNum("spo2", spo2Smooth, 0, spo2Ok);
  Serial.print(",\"finger\":");
  Serial.print(finger ? 1 : 0);
  printNum("ir", lastIr, 0, hasMax);
  printNum("temp", tempC, 1, tempOk);
  printNum("motion", motion, 3, hasMpu && motionN);
  printNum("steps", steps, 0, hasMpu);
  Serial.print(",\"fall\":");
  Serial.print(fallFlag ? 1 : 0);
  Serial.println("}");

  motionSum = 0;
  motionN = 0;
  tempSum = 0;
  tempN = 0;
  fallFlag = false;
}

void runCommand(String cmd) {
  cmd.trim();
  cmd.toUpperCase();
  if (cmd == "INFO") {
    sendHello();
  } else if (cmd == "RESET_STEPS") {
    steps = 0;
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
  uint32_t now = millis();
  handleCommands();

  if (hasMax) readPulse(now);

  if (hasMpu && now - lastImuMs >= IMU_PERIOD_MS) {
    lastImuMs = now;
    readImu(now);
  }

  if (now - lastTempMs >= TEMP_PERIOD_MS) {
    lastTempMs = now;
    tempSum += analogRead(A0);
    tempN++;
  }

  if (now - lastReportMs >= REPORT_MS) {
    lastReportMs = now;
    report(now);
  }
}
