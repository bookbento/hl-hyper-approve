import * as express from 'express';
import * as request from 'supertest';
import { allowedOrigins, originPolicy } from './origin-policy';

function appFor(env: NodeJS.ProcessEnv) {
  const app = express();
  app.use(...originPolicy(env));
  app.all(/.*/, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('originPolicy', () => {
  const prod = { NODE_ENV: 'production', FRONTEND_URL: 'https://ememo.example.test/' };

  it('collects origins from env (normalised, deduped) and adds localhost outside production', () => {
    expect(allowedOrigins({ CORS_ORIGIN: '"https://a.test/", https://a.test', NODE_ENV: 'production' })).toEqual([
      'https://a.test',
      'https://e-approval.hylifeconnect.com',
    ]);
    expect(allowedOrigins({})).toContain('http://localhost:5173');
  });

  describe('production no-origin filter', () => {
    const app = appFor(prod);

    it('rejects an /api request without Origin, Sec-Fetch-Site or a trusted Referer', async () => {
      const res = await request(app).get('/api/memos');
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ message: 'Not allowed by CORS', error: 'CORS_NOT_ALLOWED' });
    });

    it('lets through same-origin browsers, trusted referers and public endpoints', async () => {
      expect((await request(app).get('/api/memos').set('Sec-Fetch-Site', 'same-origin')).status).toBe(200);
      expect((await request(app).get('/api/memos').set('Referer', 'https://ememo.example.test/memo/1')).status).toBe(200);
      expect((await request(app).get('/api/health')).status).toBe(200);
      expect((await request(app).get('/api/memos/action/email?token=x')).status).toBe(200);
      expect((await request(app).post('/api/memos/action/email')).status).toBe(403);
    });

    it('is off outside production', async () => {
      expect((await request(appFor({})).get('/api/memos')).status).toBe(200);
    });
  });

  describe('CORS allow-list', () => {
    const app = appFor(prod);

    it('echoes an allowed origin with credentials', async () => {
      const res = await request(app).get('/api/memos').set('Origin', 'https://ememo.example.test');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://ememo.example.test');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('answers preflight for an allowed origin', async () => {
      const res = await request(app)
        .options('/api/memos')
        .set('Origin', 'https://ememo.example.test')
        .set('Access-Control-Request-Method', 'POST');
      expect(res.status).toBe(204);
    });

    it('rejects any other origin with 403', async () => {
      const res = await request(app).get('/api/memos').set('Origin', 'https://evil.test');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('CORS_NOT_ALLOWED');
    });

    it('skips CORS for the one-click email link', async () => {
      const res = await request(app).get('/api/memos/action/email').set('Origin', 'https://evil.test');
      expect(res.status).toBe(200);
    });
  });
});
