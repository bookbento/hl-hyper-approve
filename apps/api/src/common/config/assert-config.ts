/**
 * Validate environment config before Nest boots.
 *
 * Collects every problem first and throws once, so a bad deploy can be fixed
 * in one pass instead of redeploying once per missing variable.
 */
export function collectConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];

  if (!env['DATABASE_URL']?.trim()) {
    problems.push('DATABASE_URL is not set');
  }

  const hops = env['TRUST_PROXY_HOPS']?.trim();
  if (hops && !isNonNegativeInt(hops)) {
    problems.push(`TRUST_PROXY_HOPS must be an integer >= 0 (got "${hops}")`);
  }

  const expressTarget = env['EXPRESS_TARGET']?.trim();
  if (expressTarget && !/^https?:\/\/[^/]+/.test(expressTarget)) {
    problems.push(`EXPRESS_TARGET must be an http(s) URL (got "${expressTarget}")`);
  }

  if (env['NODE_ENV'] === 'production') {
    // Every JwtModule falls back to 'changeme' when JWT_SECRET is missing,
    // which would make tokens forgeable by anyone who has read this repo.
    const jwtSecret = env['JWT_SECRET']?.trim();
    if (!jwtSecret || jwtSecret === 'changeme') {
      problems.push('JWT_SECRET is not set (or is the "changeme" fallback)');
    }

    // Behind nginx, without this req.ip is nginx's address for every request,
    // so LoginLog / AdminLog IP columns become useless. nginx → Nest = 1 hop.
    if (!hops || Number(hops) < 1) {
      problems.push('TRUST_PROXY_HOPS must be >= 1 in production (nginx in front = 1)');
    }
  }

  return problems;
}

export function assertConfig(env: NodeJS.ProcessEnv = process.env): void {
  const problems = collectConfigProblems(env);
  if (problems.length === 0) return;

  throw new Error(
    `Invalid config (${problems.length} problem${problems.length > 1 ? 's' : ''}) — fix all before redeploying:\n` +
      problems.map((p, i) => `  ${i + 1}) ${p}`).join('\n'),
  );
}

function isNonNegativeInt(value: string): boolean {
  return /^\d+$/.test(value);
}
