// routes.settings.ts — Fastify plugin for the printer settings endpoints.
//
//   GET /api/settings -> Settings
//   PUT /api/settings (Partial<PrinterSettings>) -> 200 Settings (clamped)

import type { FastifyInstance } from 'fastify';
import { store, StoreError } from './store.js';
import type { PrinterSettings } from '../../shared/types';

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => store.settings.get());

  app.put<{ Body: Partial<PrinterSettings> }>('/api/settings', async (req, reply) => {
    try {
      const next = await store.settings.update(req.body ?? {});
      return reply.code(200).send(next);
    } catch (err) {
      if (err instanceof StoreError) {
        const code = err.code === 'NOT_FOUND' ? 404 : err.code === 'IN_USE' ? 409 : 400;
        return reply.code(code).send({ error: err.message, code: err.code });
      }
      req.log.error(err);
      return reply.code(500).send({ error: 'Failed to update settings.' });
    }
  });
}
