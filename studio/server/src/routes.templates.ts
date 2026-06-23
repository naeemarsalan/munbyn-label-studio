// routes.templates.ts — Fastify plugin for the template endpoints.
//
//   GET    /api/templates       -> Template[] (newest updatedAt first)
//   POST   /api/templates       -> 201 Template | 400
//   GET    /api/templates/:id   -> Template | 404
//   PUT    /api/templates/:id   -> 200 | 404 | 400
//   DELETE /api/templates/:id   -> 204 | 404

import type { FastifyInstance } from 'fastify';
import { store, StoreError } from './store.js';
import type { CreateTemplateBody } from '../../shared/types';

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

export default async function templatesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/templates', async () => store.templates.list());

  app.post<{ Body: CreateTemplateBody }>('/api/templates', async (req, reply) => {
    try {
      const tpl = await store.templates.create(req.body ?? ({} as CreateTemplateBody));
      return reply.code(201).send(tpl);
    } catch (err) {
      if (err instanceof StoreError) {
        return reply.code(statusFor(err.code)).send({ error: err.message, code: err.code });
      }
      req.log.error(err);
      return reply.code(500).send({ error: 'Failed to create template.' });
    }
  });

  app.get<{ Params: { id: string } }>('/api/templates/:id', async (req, reply) => {
    const tpl = store.templates.get(req.params.id);
    if (!tpl) return reply.code(404).send({ error: 'Template not found.', code: 'NOT_FOUND' });
    return reply.code(200).send(tpl);
  });

  app.put<{ Params: { id: string }; Body: CreateTemplateBody }>(
    '/api/templates/:id',
    async (req, reply) => {
      try {
        const tpl = await store.templates.update(req.params.id, req.body ?? ({} as CreateTemplateBody));
        return reply.code(200).send(tpl);
      } catch (err) {
        if (err instanceof StoreError) {
          return reply.code(statusFor(err.code)).send({ error: err.message, code: err.code });
        }
        req.log.error(err);
        return reply.code(500).send({ error: 'Failed to update template.' });
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/templates/:id', async (req, reply) => {
    try {
      await store.templates.remove(req.params.id);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof StoreError) {
        return reply.code(statusFor(err.code)).send({ error: err.message, code: err.code });
      }
      req.log.error(err);
      return reply.code(500).send({ error: 'Failed to delete template.' });
    }
  });
}
