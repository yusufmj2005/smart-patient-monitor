/* USB link to the ESP8266 using the Web Serial API (Chrome / Edge desktop).
   Reads newline-delimited text and hands each complete line to onLine(). */

const USB_CHIPS = {
  0x1a86: 'CH340',   // most NodeMCU v3 / LoLin boards
  0x10c4: 'CP210x',  // NodeMCU v2 (Amica)
  0x0403: 'FTDI',
};

class SerialLink {
  static supported() {
    return 'serial' in navigator;
  }

  constructor({ onLine, onClose }) {
    this.onLine = onLine;
    this.onClose = onClose;
    this.port = null;
    this.reader = null;
    this.readableClosed = null;
    this.closing = false;

    navigator.serial.addEventListener('disconnect', (e) => {
      if (e.target === this.port) this._finish(false);
    });
  }

  get connected() {
    return !!this.port;
  }

  /* Opens the browser's port chooser. Throws NotFoundError if the user cancels. */
  async connect(baudRate) {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate });
    this.port = port;
    this.closing = false;
    this._readLoop();
    await this.resetBoard();

    const info = port.getInfo();
    const chip = USB_CHIPS[info.usbVendorId];
    return { chip: chip || (info.usbVendorId ? `USB ${info.usbVendorId.toString(16)}` : 'Serial') };
  }

  async _readLoop() {
    const port = this.port;
    while (port.readable && !this.closing) {
      const decoder = new TextDecoderStream();
      this.readableClosed = port.readable.pipeTo(decoder.writable).catch(() => {});
      this.reader = decoder.readable.getReader();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          buf += value;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, '');
            buf = buf.slice(i + 1);
            if (line) this.onLine(line);
          }
          if (buf.length > 8192) buf = ''; // no newline for a long time: garbage, drop it
        }
      } catch (e) {
        // Framing/parity/break errors are recoverable; the outer loop re-acquires the stream.
      } finally {
        this.reader.releaseLock();
        this.reader = null;
      }
    }
    if (!this.closing) this._finish(false);
  }

  /* Restarts the ESP8266 into normal run mode via the NodeMCU auto-reset circuit
     (RTS pulls EN low; DTR released keeps GPIO0 high), like the Arduino IDE does.
     This guarantees a fresh "hello" line and that the board isn't left in upload mode.
     Boards without the circuit simply ignore it. */
  async resetBoard() {
    if (!this.port) return;
    try {
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: true });
      await new Promise((r) => setTimeout(r, 120));
    } catch {
      // Some USB-serial chips / browsers don't support control signals; the board keeps running as-is.
    } finally {
      // Always release reset, or the board would stay frozen.
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: false }).catch(() => {});
    }
  }

  async send(text) {
    if (!this.port || !this.port.writable) return;
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(text + '\n'));
    } finally {
      writer.releaseLock();
    }
  }

  async disconnect() {
    if (!this.port) return;
    this.closing = true;
    if (this.reader) await this.reader.cancel().catch(() => {});
    if (this.readableClosed) await this.readableClosed;
    await this.port.close().catch(() => {});
    this._finish(true);
  }

  _finish(userInitiated) {
    if (!this.port) return;
    this.port = null;
    this.closing = true;
    this.onClose(userInitiated);
  }
}
