import { assertConfig, collectConfigProblems } from './assert-config';

const base = { DATABASE_URL: 'postgresql://localhost/db' };
const prod = {
  ...base,
  NODE_ENV: 'production',
  JWT_SECRET: 'a-real-secret',
  TRUST_PROXY_HOPS: '1',
  FRONTEND_URL: 'https://approve.example.com',
  SMTP_HOST: 'smtp.example.com',
  SMTP_FROM: 'noreply@example.com',
  APP_BASE_URL: 'https://approve.example.com',
  EMAIL_TOKEN_SECRET: 'another-secret',
};

describe('collectConfigProblems', () => {
  it('accepts a minimal dev config', () => {
    expect(collectConfigProblems(base)).toEqual([]);
  });

  it('accepts a complete production config', () => {
    expect(collectConfigProblems(prod)).toEqual([]);
  });

  it('requires DATABASE_URL in every environment', () => {
    expect(collectConfigProblems({})).toEqual(['DATABASE_URL is not set']);
  });

  it('rejects a non-integer TRUST_PROXY_HOPS', () => {
    expect(collectConfigProblems({ ...base, TRUST_PROXY_HOPS: 'true' })).toHaveLength(1);
  });

  it('rejects missing or default JWT_SECRET in production', () => {
    expect(collectConfigProblems({ ...prod, JWT_SECRET: undefined })).toHaveLength(1);
    expect(collectConfigProblems({ ...prod, JWT_SECRET: 'changeme' })).toHaveLength(1);
  });

  it('requires TRUST_PROXY_HOPS >= 1 in production', () => {
    expect(collectConfigProblems({ ...prod, TRUST_PROXY_HOPS: undefined })).toHaveLength(1);
    expect(collectConfigProblems({ ...prod, TRUST_PROXY_HOPS: '0' })).toHaveLength(1);
  });

  it('requires FRONTEND_URL and SMTP settings in production', () => {
    expect(collectConfigProblems({ ...prod, FRONTEND_URL: 'approve.example.com' })).toHaveLength(1);
    const problems = collectConfigProblems({ ...prod, SMTP_HOST: undefined, SMTP_FROM: ' ' });
    expect(problems).toEqual(['SMTP_HOST, SMTP_FROM not set — notification emails cannot be sent']);
  });

  it('requires APP_BASE_URL and EMAIL_TOKEN_SECRET in production', () => {
    expect(
      collectConfigProblems({
        ...prod,
        APP_BASE_URL: 'approve.example.com',
        EMAIL_TOKEN_SECRET: '',
      }),
    ).toEqual([
      'APP_BASE_URL must be an http(s) URL (one-click approve links in emails)',
      'EMAIL_TOKEN_SECRET is not set — approver emails cannot be signed',
    ]);
  });

  it('does not require production-only vars outside production', () => {
    expect(collectConfigProblems({ ...base, NODE_ENV: 'development' })).toEqual([]);
  });
});

describe('assertConfig', () => {
  it('reports every problem in a single error', () => {
    expect(() => assertConfig({ NODE_ENV: 'production' })).toThrow(
      /7 problems[\s\S]*DATABASE_URL[\s\S]*JWT_SECRET[\s\S]*TRUST_PROXY_HOPS[\s\S]*FRONTEND_URL[\s\S]*APP_BASE_URL[\s\S]*EMAIL_TOKEN_SECRET[\s\S]*SMTP_HOST/,
    );
  });

  it('does not throw for a valid config', () => {
    expect(() => assertConfig(prod)).not.toThrow();
  });
});
