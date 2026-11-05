import { createHash } from "node:crypto";

/** Verify bounded streams without loading whole downloads or logging their contents. */
export class FileEvidence {
  readonly #hash = createHash("sha256");
  readonly #needle?: Buffer;
  #tail = Buffer.alloc(0);
  #matched = false;
  bytes = 0;
  constructor(
    private readonly sha256?: string,
    text?: string,
  ) {
    if (!sha256 && !text) throw new Error("Expected content evidence is required");
    if (text) this.#needle = Buffer.from(text);
  }
  update(chunk: Buffer) {
    this.bytes += chunk.length;
    if (this.bytes > 32 * 1024 * 1024) throw new Error("File verification exceeds 32 MiB");
    this.#hash.update(chunk);
    if (this.#needle && !this.#matched) {
      const data = Buffer.concat([this.#tail, chunk]);
      this.#matched = data.includes(this.#needle);
      this.#tail = Buffer.from(data.subarray(Math.max(0, data.length - this.#needle.length + 1)));
    }
  }
  matches() {
    return (!this.#needle || this.#matched) && (!this.sha256 || this.sha256 === this.#hash.digest("hex"));
  }
}
