import fs from "node:fs";
import path from "node:path";

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,64}(\.[a-z0-9]{1,5})?$/;

function safe(segment: string): string {
  if (!SAFE_SEGMENT.test(segment)) throw new Error(`Unsafe path segment: ${segment}`);
  return segment;
}

/**
 * Private files (generated audio, retained voice recordings). Nothing here is
 * served statically: the API checks ownership before sending any file.
 */
export class FileStore {
  readonly audioRoot: string;
  readonly recordingRoot: string;

  constructor(dataDir: string) {
    this.audioRoot = path.join(dataDir, "audio");
    this.recordingRoot = path.join(dataDir, "recordings");
    fs.mkdirSync(this.audioRoot, { recursive: true });
    fs.mkdirSync(this.recordingRoot, { recursive: true });
  }

  audioPath(userId: string, fileName: string): string {
    return path.join(this.audioRoot, safe(userId), safe(fileName));
  }

  writeAudio(userId: string, fileName: string, data: Buffer): string {
    const p = this.audioPath(userId, fileName);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data, { mode: 0o600 });
    return p;
  }

  recordingPath(userId: string, fileName: string): string {
    return path.join(this.recordingRoot, safe(userId), safe(fileName));
  }

  writeRecording(userId: string, fileName: string, data: Buffer): string {
    const p = this.recordingPath(userId, fileName);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data, { mode: 0o600 });
    return p;
  }

  exists(p: string): boolean {
    return fs.existsSync(p);
  }

  remove(p: string): void {
    fs.rmSync(p, { force: true });
  }

  removeUserFiles(userId: string): void {
    fs.rmSync(path.join(this.audioRoot, safe(userId)), { recursive: true, force: true });
    fs.rmSync(path.join(this.recordingRoot, safe(userId)), { recursive: true, force: true });
  }
}
