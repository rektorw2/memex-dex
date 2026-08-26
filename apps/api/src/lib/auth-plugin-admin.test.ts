import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let databaseRole: 'USER' | 'TRADER' | 'ADMIN' | null = 'USER';
const prismaMock = {
  user: { findUnique: vi.fn(async () => databaseRole == null ? null : { role: databaseRole }) },
};
vi.mock('./prisma.js', () => ({ prisma: prismaMock }));
const { authPlugin } = await import('./auth-plugin.js');

async function appWithAdminRoute() {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-only-secret-at-least-32-characters' });
  await app.register(authPlugin);
  app.post('/admin', { preHandler: [app.requireAdmin] }, async () => ({ ok: true }));
  return app;
}

beforeEach(() => { databaseRole = 'USER'; vi.clearAllMocks(); });

describe('requireAdmin читает роль из базы', () => {
  it('отвергает ADMIN из JWT, если роль снята в базе', async () => {
    const app = await appWithAdminRoute();
    const token = app.jwt.sign({ sub: 'user-1', role: 'ADMIN' });
    const response = await app.inject({ method: 'POST', url: '/admin', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('принимает настоящего ADMIN из базы даже со старым USER-снимком JWT', async () => {
    databaseRole = 'ADMIN';
    const app = await appWithAdminRoute();
    const token = app.jwt.sign({ sub: 'user-1', role: 'USER' });
    const response = await app.inject({ method: 'POST', url: '/admin', headers: { authorization: `Bearer ${token}` }, payload: { role: 'USER' } });
    expect(response.statusCode).toBe(200);
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' }, select: { role: true } });
    await app.close();
  });

  it('query, header и body не повышают обычного пользователя', async () => {
    const app = await appWithAdminRoute();
    const token = app.jwt.sign({ sub: 'user-1', role: 'USER' });
    const response = await app.inject({
      method: 'POST', url: '/admin?role=ADMIN',
      headers: { authorization: `Bearer ${token}`, 'x-role': 'ADMIN' }, payload: { role: 'ADMIN' },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
