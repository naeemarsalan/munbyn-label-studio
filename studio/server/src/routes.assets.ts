// routes.assets.ts — Fastify plugin for the asset endpoints.
//
//   GET    /api/assets            -> AssetMeta[] (newest first)
//   POST   /api/assets            -> 201 AssetMeta | 400
//   GET    /api/assets/:id/bytes  -> raw bytes (Content-Type meta.mime)
//   GET    /api/assets/:id/thumb  -> image/webp
//   DELETE /api/assets/:id        -> 204 | 404 | 409 {error:'IN_USE'}

import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { store, StoreError } from './store.js';
import type { CreateAssetBody } from '../../shared/types';

function statusFor(code: StoreError['code']): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'IN_USE':
      return 409;
    default:
      return 400;
  }
}

function decodeBase64(input: string): Buffer {
  const comma = input.indexOf(',');
  const b64 = input.startsWith('data:') && comma >= 0 ? input.slice(comma + 1) : input;
  return Buffer.from(b64, 'base64');
}

export default async function assetsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/assets', async () => store.assets.list());

  app.post<{ Body: CreateAssetBody }>('/api/assets', async (req, reply) => {
    const body = req.body ?? ({} as CreateAssetBody);
    if (typeof body.pngBase64 !== 'string' || !body.pngBase64) {
      return reply.code(400).send({ error: 'Missing pngBase64.' });
    }
    let buf: Buffer;
    try {
      buf = decodeBase64(body.pngBase64);
    } catch {
      return reply.code(400).send({ error: 'pngBase64 is not valid base64.' });
    }
    try {
      const meta = await store.assets.create(body.name, buf);
      return reply.code(201).send(meta);
    } catch (err) {
      if (err instanceof StoreError) {
        return reply.code(statusFor(err.code)).send({ error: err.message, code: err.code });
      }
      req.log.error(err);
      return reply.code(500).send({ error: 'Failed to store asset.' });
    }
  });

  app.get<{ Params: { id: string } }>('/api/assets/:id/bytes', async (req, reply) => {
    try {
      const { path: filePath, mime } = store.assets.bytesPath(req.params.id);
      return reply.type(mime).send(createReadStream(filePath));
    } catch (err) {
      if (err instanceof StoreError) {
        return reply.code(statusFor(err.code)).send({ error: err.message, code: err.code });
      }
      req.log.error(err);
      return reply.code(500).send({ error: 'Failed to read asset.' });
    }
  });

  app.get<{ Params: { id: string } }>('/api/assets/:id/thumb', async (req, reply) => {
    try {
      const filePath = store.assets.thumbPath(req.params.id);
      return reply.type('image/webp').send(createReadStream(filePath));
    } catch (err) {
      if (err instanceof StoreError) {
        return reply.code(statusFor(err.code)).send({ error: err.message, code: err.code });
      }
      req.log.error(err);
      return reply.code(500).send({ error: 'Failed to read thumbnail.' });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/assets/:id', async (req, reply) => {
    try {
      await store.assets.remove(req.params.id);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof StoreError) {
        return reply.code(statusFor(err.code)).send({ error: err.code, message: err.message });
      }
      req.log.error(err);
      return reply.code(500).send({ error: 'Failed to delete asset.' });
    }
  });
}
