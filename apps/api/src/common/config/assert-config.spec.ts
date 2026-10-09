import { assertConfig, collectConfigProblems } from './assert-config';

const base = { DATABASE_URL: 'postgresql://localhost/db' };
const prod = {
  ...base,
  NODE_ENV: 'production',
  JWT_SECRET: 'a-real-secret',
  TRUST_PROXY_HOPS: '1',
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

  it('rejects an EXPRESS_TARGET that is not an http(s) URL', () => {
    expect(collectConfigProblems({ ...base, EXPRESS_TARGET: 'localhost:3000' })).toHaveLength(1);
    expect(collectConfigProblems({ ...base, EXPRESS_TARGET: 'http://127.0.0.1:3000' })).toEqual([]);
  });

  it('rejects missing or default JWT_SECRET in production', () => {
    expect(collectConfigProblems({ ...prod, JWT_SECRET: undefined })).toHaveLength(1);
    expect(collectConfigProblems({ ...prod, JWT_SECRET: 'changeme' })).toHaveLength(1);
  });

  it('requires TRUST_PROXY_HOPS >= 1 in production', () => {
    expect(collectConfigProblems({ ...prod, TRUST_PROXY_HOPS: undefined })).toHaveLength(1);
    expect(collectConfigProblems({ ...prod, TRUST_PROXY_HOPS: '0' })).toHaveLength(1);
  });

  it('does not require production-only vars outside production', () => {
    expect(collectConfigProblems({ ...base, NODE_ENV: 'development' })).toEqual([]);
  });
});

describe('assertConfig', () => {
  it('reports every problem in a single error', () => {
    expect(() => assertConfig({ NODE_ENV: 'production' })).toThrow(
      /3 problems[\s\S]*DATABASE_URL[\s\S]*JWT_SECRET[\s\S]*TRUST_PROXY_HOPS/,
    );
  });

  it('does not throw for a valid config', () => {
    expect(() => assertConfig(prod)).not.toThrow();
  });
});
