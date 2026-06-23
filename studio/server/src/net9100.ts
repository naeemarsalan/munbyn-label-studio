// net9100.ts — raw TCP port 9100 listener (JetDirect-style).
//
// Accepts a connection, buffers ALL bytes until the client closes the write
// side (end), then funnels the bytes to the printer device THROUGH THE SAME
// printer lock as /api/print by calling enqueue(() => writeBufferToDevice(buf)).
// This keeps only one physical print active at a time across both paths.
//
// Disabled by default; server.ts only calls startRaw9100 when ENABLE_RAW_9100==='1'.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const PRINTER_DEVICE = process.env.PRINTER_DEVICE || '/dev/usb/lp0';

/**
 * Write a raw buffer straight to the printer device, mirroring print.ts:
 * stage to a temp file, then `cat tmp > device` with a hard timeout, then unlink.
 */
async function writeBufferToDevice(buf: Buffer): Promise<void> {
  const filePath = path.join(
    os.tmpdir(),
    `raw9100-${Date.now()}-${randomBytes(6).toString('hex')}.bin`,
  );
  await fs.writeFile(filePath, buf);
  try {
    await execFileP('timeout', ['15', 'bash', '-c', 'cat "$0" > "$1"', filePath, PRINTER_DEVICE]);
  } finally {
    fs.unlink(filePath).catch(() => {
      /* best-effort cleanup */
    });
  }
}

export type Enqueue = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Start a raw-9100 server. `enqueue` MUST be the same serialization primitive
 * used by /api/print so the printer is never driven by two jobs at once.
 */
export function startRaw9100(port: number, enqueue: Enqueue): net.Server {
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    socket.on('error', () => {
      // Connection-level error; drop whatever we have.
      chunks.length = 0;
    });

    socket.on('end', () => {
      const buf = Buffer.concat(chunks);
      chunks.length = 0;
      if (buf.length === 0) {
        socket.end();
        return;
      }
      enqueue(() => writeBufferToDevice(buf))
        .then(() => {
          socket.end();
        })
        .catch(() => {
          socket.destroy();
        });
    });
  });

  server.on('error', (err) => {
    // Surface bind/listen failures to stderr; don't crash the whole process.
    // eslint-disable-next-line no-console
    console.error(`[raw9100] server error on port ${port}:`, err);
  });

  server.listen(port, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`[raw9100] listening on 0.0.0.0:${port}`);
  });

  return server;
}
