// print.ts — send a raw TSPL stream straight to the printer's USB character
// device (/dev/usb/lp0 via the kernel usblp driver).
//
// We deliberately do NOT go through CUPS: the ITPP941 is a TSPL printer and
// CUPS's libusb backend detaches usblp and wedges it. Writing to the kernel
// device is the path that actually works.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, constants as fsConstants } from 'node:fs';

const execFileP = promisify(execFile);

export interface DeviceConfig {
  device: string; // e.g. /dev/usb/lp0
}

export type JobState = 'pending' | 'processing' | 'completed' | 'error';

export interface JobStatus {
  state: JobState;
  message?: string;
}

let jobSeq = 0;

/**
 * Write the prepared TSPL file to the printer device. A hard `timeout` guards
 * against a wedged printer hanging the request forever. The write is
 * synchronous from the caller's perspective: once it returns, the bytes have
 * been delivered to the printer. Does NOT unlink the file (server.ts owns that).
 */
export async function submit(filePath: string, cfg: DeviceConfig): Promise<{ jobId: string }> {
  // `cat "$0" > "$1"` — positional args avoid any shell-escaping of paths.
  await execFileP('timeout', ['15', 'bash', '-c', 'cat "$0" > "$1"', filePath, cfg.device]);
  jobSeq += 1;
  return { jobId: `label-${jobSeq}` };
}

/**
 * Direct device writes are synchronous, so by the time a job has an id it has
 * already been delivered. Report completed.
 */
export async function status(_jobId: string, _cfg: DeviceConfig): Promise<JobStatus> {
  return { state: 'completed' };
}

/** True if the printer device exists and is writable. */
export async function deviceOk(cfg: DeviceConfig): Promise<boolean> {
  try {
    await fs.access(cfg.device, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}
