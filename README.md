# IoT-Based Smart Patient Health Monitoring and Engagement System

This folder has a web dashboard that reads live vitals from an **ESP8266 NodeMCU over USB**, using the browser's Web Serial API. The dashboard shows heart rate, SpO₂, temperature and activity. It also computes a patient engagement score, raises alerts and exports the session as CSV.

```
firmware/esp8266_patient_monitor/   Arduino sketch for the NodeMCU
dashboard/                          Web dashboard (plain HTML/CSS/JS, no build step, works offline)
  login.html                        Sign in / create account (Doctor or Patient)
  patients.html                     Doctor's patient list
  index.html                        Monitor (a patient's own, or the patient a doctor opened)
  analysis.html                     Analysis & reports: charts, CSV import, date-wise printable reports
  js/firebase-config.js             ← paste your Firebase web config here
database.rules.json                 Realtime Database security rules (paste into the Firebase console)
serve.py                            Local web server (no caching, so updates show up immediately)
start-dashboard.bat                 Double-click to serve the dashboard and open it in Edge
```

## 1. Wiring

| Sensor   | Pin       | NodeMCU                 |
|----------|-----------|-------------------------|
| MAX30102 | VIN / GND | 3V3 / GND               |
|          | SDA / SCL | D2 / D1                 |
| MPU6050  | VCC / GND | 3V3 / GND               |
|          | SDA / SCL | D5 / D6 (MAX30100 sketch), or D2 / D1 shared with the pulse sensor via a breadboard |
|          | AD0       | GND                     |
| LM35     | +Vs       | **VIN** (5 V from USB)  |
|          | GND       | GND                     |
|          | Vout      | A0                      |

The LM35 needs at least 4 V of supply, so power it from **VIN** and not 3V3. Its output at body temperature is about 0.37 V, which is safe for A0.

## 2. Flash the firmware

There are two versions of the firmware. Pick the one that matches your pulse sensor chip:

| Pulse sensor | Sketch | Library to install |
|---|---|---|
| **MAX30100** | `firmware/esp8266_patient_monitor_max30100/` | **MAX30100lib** by OXullo Intersecans |
| **MAX30102** | `firmware/esp8266_patient_monitor/` | **SparkFun MAX3010x Pulse and Proximity Sensor Library** |

Both sketches send the same data to the dashboard. If you flash the wrong one, the dashboard's serial console tells you which one to use instead. The MPU6050 is read directly with `Wire.h`, so it needs no library. Sensors that aren't wired up show as "missing" instead of stopping the board.

1. In the Arduino IDE, go to **File → Preferences** and add `http://arduino.esp8266.com/stable/package_esp8266com_index.json` to **Additional boards manager URLs**. Then install **esp8266 by ESP8266 Community** from **Boards Manager** and select **NodeMCU 1.0 (ESP-12E Module)**.
2. In **Library Manager**, install the library for your sensor from the table above.
3. Open the sketch for your sensor, pick the NodeMCU's COM port (not a Bluetooth one), and upload.
4. Open the Serial Monitor at **115200** baud to check. You should see one JSON line per second. **Close the Serial Monitor before using the dashboard**, because only one program can hold the COM port at a time.

If Windows doesn't show a COM port, install the USB driver for your board's chip: **CH340** for most v3 boards, or **CP2102** for v2 boards.

## 3. Run the dashboard

Web Serial only works in **Google Chrome or Microsoft Edge** on a desktop, and only from `localhost` or `https`.

- **Windows:** double-click `start-dashboard.bat`.
- **Any OS:** run `python serve.py`, then open http://localhost:8000.

Click **Connect USB** and choose the NodeMCU's port (it shows up as CH340 or CP210x). Readings start within a few seconds. Place a finger on the MAX30102 and hold it still for about 5 s to get HR and SpO₂.

**Demo mode** streams simulated ESP8266 data, so you can present without hardware. It has buttons to simulate tachycardia, low SpO₂, fever, a fall, or the sensor being removed.

## 4. Connect Firebase (accounts + cloud sync)

Until you fill in `dashboard/js/firebase-config.js`, the dashboard runs locally with no login. Once it's filled in, everyone signs in and gets one of two account types:

| Account | Creates it | Sees |
|---------|-----------|------|
| **Patient** | themselves, on the sign-in page → **Create account → Patient** | only their own monitor: live readings, last hour of history, their alerts |
| **Doctor** | themselves, with the clinic's **doctor registration code** | the **patient list** (`patients.html`): every patient with latest vitals and status. Clicking a patient opens that patient's monitor |

Both can plug in the ESP8266. A patient's readings always go to their own record. A doctor's readings go to the patient they have open, for example when checking a patient in the clinic. A doctor watching a patient who is recording at home sees the readings arrive live.

### Setup

1. **Create the project.** Go to https://console.firebase.google.com and click **Add project**. You can turn Google Analytics off.
2. **Turn on login.** Go to **Build → Authentication → Sign-in method** and enable **Email/Password**.
3. **Create the database.** Go to **Build → Realtime Database → Create database** and choose **Start in locked mode**.
4. **Set the security rules.** On the **Rules** tab, paste the contents of `database.rules.json` and click **Publish**. Publish again whenever this file changes.
5. **Set the doctor registration code.** On the **Data** tab, hover over the root and click **+**. Add `config` with a child `doctorCode` whose value is a code you choose, for example `CLINIC-2026`. Only people you give this code to can create doctor accounts. The rules check it on Firebase's side, and no user can read it.
6. **Register the web app.** Go to **Project settings → Your apps → Web (`</>`)** and copy the `firebaseConfig` values into `dashboard/js/firebase-config.js`. Make sure `databaseURL` is included.
7. Open the dashboard. You'll be sent to the sign-in page, where you can use **Create account**.

**Approving a doctor without the code:** add `/staff/{their User UID}: true` in the console, as a boolean. When they sign in, they finish setup as a doctor without needing the code. This also works for accounts created under **Authentication → Users**.

The web config (`apiKey` and the rest) is not a secret. The security rules protect the data:
- patients can read and write only their own records
- doctors can read and write all patient records
- a user can't change their role after sign-up
- vital-sign history can't be edited or deleted from the dashboard

**Database layout:**

```
/config/doctorCode                  doctor sign-up code (console only; unreadable by users)
/staff/{uid}: true                  doctors approved manually in the console
/users/{uid}                        { role: "doctor" | "patient", name, email, createdAt }
/doctors/{uid}                      { name, specialty, code, createdAt }
/patients/{uid}                     { name, email, age, gender, phone, caregiverEmail, createdAt, lastSeen }
/latest/{uid}                       newest reading, overwritten every second (used by the patient list)
/vitals/{uid}/{pushId}              full history: ts, hr, spo2, temp, motion, steps, finger, fall, eng, demo
/alerts/{uid}/{pushId}              rule, severity, message, at, resolvedAt, acked, ackedBy, ackedAt
```

Other behavior:
- **Alerts are shared.** They're raised by whichever computer is recording, and both the doctor and the patient see them live. An acknowledgement from either side shows who acknowledged it.
- Demo-mode readings are tagged `demo: true`, so you can filter them out of analysis.
- If the internet drops, the Firebase SDK queues writes and sends them on reconnect. The top bar shows **Cloud · offline (N queued)** while this is happening. Uploading can be paused with the checkbox in **Device & session**.
- If Firebase can't be reached at all, the monitor offers **Continue offline**. USB monitoring keeps working without the cloud.

## Dashboard features

- **Live tiles:** HR, SpO₂, temperature and activity (steps and movement level), color-coded against the alert thresholds.
- **Trends:** 1 min / 5 min / 15 min / 1 h charts, with the normal range shaded.
- **Engagement score (0–100)** over the last 10 minutes:
  - Sensor worn: 35%
  - Activity: 25%
  - Vitals in range: 25%
  - Data continuity: 15%

  This is a transparent rule-based baseline in `dashboard/js/engagement.js`. It is the place to plug in the trained AI model (Objective 2).
- **Alerts:**
  - High or low HR, low SpO₂, high or low temperature
  - Possible fall (MPU6050 detects free-fall followed by an impact)
  - Sensor not worn for more than 1 min, low engagement
  - No data from the device, USB unplugged

  Alerts are debounced and shown with severity, active/resolved status and acknowledgement. Sound and desktop notifications are optional. Thresholds can be edited in the page.
- **Serial console:** shows the raw device output and lets you send commands (`INFO`, `RESET_STEPS`).
- **Export:** session vitals and alert log as CSV. The vitals CSV is the training data for the engagement model.

## Analysis & reports

Open **Analysis & reports** from the top bar, or click **Analyze this session** on the monitor.

- **Data sources**
  - **Cloud history:** the patient's saved readings from Firebase. Doctors pick the patient.
  - **Imported CSV:** drag in one or more files. The monitor's "Export data (CSV)" files work, and so do other CSVs that have a time column plus heart rate / SpO₂ / temperature columns. Comma or semicolon separators, ISO or day/month/year dates. Files are read in the browser and not uploaded.
  - **Session from the monitor:** the readings currently shown on the monitor tab.
- **Period:** Today, Yesterday, 7 days, 30 days, All, or any From/To dates. Everything below follows the same period.
- **Analysis view**
  - an overall verdict and averages with a status label for each vital
  - plain-language findings ("Heart rate … was in the normal range 96% of the time…")
  - time-in-range bars
  - trend charts with the normal range shaded (hover, or use the arrow keys, for values)
  - day-by-day charts and table
  - out-of-range events, meaning episodes of 10 s or longer, and possible falls
- **Report view:** a printable report for the chosen dates, either one report for the whole period or **one page per day**. It contains patient details, summary, key measurements, trends, a day-by-day table, events and, for cloud data, the alerts raised by the monitor. Use **Print / Save as PDF**.

Normal ranges follow the alert thresholds set on the monitor page.

## Serial protocol

The device sends one JSON object per line at 115200 baud. `null` means the reading is missing or not valid yet.

```json
{"type":"hello","device":"ESP8266","fw":"1.0.0","sensors":{"max30102":true,"mpu6050":true,"lm35":true}}
{"type":"data","t":12345,"hr":72,"spo2":98,"finger":1,"ir":81234,"temp":36.4,"motion":0.042,"steps":120,"fall":0}
```

| Field    | Meaning                                                        |
|----------|----------------------------------------------------------------|
| `hr`     | Heart rate, bpm (MAX30102, Maxim algorithm, 4 s sliding window)|
| `spo2`   | Blood oxygen, %                                                |
| `finger` | 1 if a finger is on the sensor (IR ≥ 50 000)                   |
| `temp`   | LM35 temperature, °C (average of 10 samples)                   |
| `motion` | Mean deviation of acceleration from 1 g over the last second   |
| `steps`  | Step count since boot                                          |
| `fall`   | 1 if a fall was detected in the last second                    |

## Accuracy notes

- The LM35 measures **skin or ambient** temperature, not core body temperature. Calibrate `TEMP_OFFSET_C` in the sketch against a clinical thermometer.
- Pulse oximeter readings need a still finger and steady, light pressure. Movement makes them unreliable.
- If a MAX30100 is found but heart rate stays empty, change `IR_CURRENT` in the sketch. Try `MAX30100_LED_CURR_24MA` if no beats are detected, or a lower value if readings are erratic. Many cheap purple MAX30100 boards also have their I²C pull-up resistors tied to 1.8 V, which makes the sensor unreliable. Search "MAX30100 pull-up fix" if it's detected only some of the time.
- This is a student prototype and **not a medical device**.
