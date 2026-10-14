import { StringDecoder } from 'node:string_decoder';

// Newline-delimited JSON framing shared by provider transports.
export class JsonlDecoder {
  constructor({ label, maxLineBytes = 4_194_304 }) {
    this.label = label;
    this.maxLineBytes = maxLineBytes;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
  }

  // Yields complete objects; throws on oversize or invalid lines. Unread lines stay buffered.
  *push(chunk) {
    this.buffer += this.decoder.write(chunk);
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > this.maxLineBytes) throw new Error(`${this.label} line exceeds size limit.`);
      let message;
      try { message = JSON.parse(line); }
      catch (error) { throw new Error(`${this.label} failure: ${error.message}`); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw new Error(`${this.label} failure: Expected a protocol object.`);
      }
      yield message;
    }
    if (Buffer.byteLength(this.buffer) > this.maxLineBytes) throw new Error(`${this.label} line exceeds size limit.`);
  }
}
