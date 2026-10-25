// security.js — deterministic guardrails layered on top of the LLM review.
// The LLM can miss things; regexes do not get tired. Two passes:
//   1) scanSecrets: committed credentials in added lines
//   2) scanRisks:   structural risk heuristics (auth/money/migrations touched,
//                   deps added, big files, .env committed)
import { maskSecret } from '../util.js';

const SECRET_PATTERNS = [
  { id: 'aws_access_key', re: /AKIA[0-9A-Z]{16}/, label: 'AWS access key' },
  { id: 'github_token', re: /gh[pousr]_[A-Za-z0-9]{30,}/, label: 'GitHub token' },
  { id: 'slack_token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/, label: 'Slack token' },
  { id: 'google_api_key', re: /AIza[0-9A-Za-z_-]{35}/, label: 'Google API key' },
  { id: 'stripe_key', re: /[sp]k_(live|test)_[0-9a-zA-Z]{20,}/, label: 'Stripe key' },
  { id: 'private_key', re: /-----BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/, label: 'Private key block' },
  { id: 'supabase_jwt', re: /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, label: 'JWT (possible Supabase service role / auth secret)' },
  { id: 'db_uri', re: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s"']+@[^\s"']+/i, label: 'Database URI with embedded credentials' },
  { id: 'paystack_key', re: /(sk|pk)_(test|live)_[0-9a-f]{32}/i, label: 'Paystack secret key' },
  { id: 'npm_token', re: /npm_[A-Za-z0-9]{30,}/, label: 'npm token' },
];

/**
 * Scan ADDED diff lines only (so pre-existing secrets upstream don't re-alarm).
 * @param {Array} parsedFiles output of parseUnifiedDiff
 * @returns {Array<{file, line, id, label, snippet}>}
 */
export function scanSecrets(parsedFiles) {
  const findings = [];
  for (const f of parsedFiles) {
    for (const [ln, code] of f.addedLines) {
      for (const p of SECRET_PATTERNS) {
        if (p.re.test(code)) {
          findings.push({ file: f.path, line: ln, id: p.id, label: p.label, snippet: maskSecret(code.trim().slice(0, 80)) });
          break; // one finding per line is enough
        }
      }
    }
  }
  return findings;
}

const RISKY_PATHS = [
  { re: /(^|\/)(auth|middleware|security|admin)(\/|$)/i, note: 'touches auth/authorization surface' },
  { re: /(^|\/)(wallet|payment|pay|billing|money|withdraw|deposit|payout)(\/|$)|\.sql$/i, note: 'touches money/payment or SQL migration surface' },
  { re: /(^|\/)(\.github\/workflows|Dockerfile|docker-compose)/i, note: 'changes CI/container definition' },
  { re: /(supabase|prisma|schema)\.(ts|js|sql)$/i, note: 'changes data schema client' },
];

export function scanRisks(parsedFiles, { rawDiff = '' } = {}) {
  const risks = [];
  let added = 0;
  let removed = 0;
  const paths = new Set();

  for (const f of parsedFiles) {
    added += f.additions;
    removed += f.deletions;
    paths.add(f.path);
    for (const r of RISKY_PATHS) {
      if (r.re.test(f.path)) risks.push({ file: f.path, note: r.note });
    }
    if (/\.env($|\.)|credentials|secret/i.test(f.path) && !f.path.includes('.example')) {
      risks.push({ file: f.path, note: 'environment/secret-like file committed' });
    }
    if (f.path.endsWith('package.json') && f.addedLines.size > 0) {
      const newDeps = [...f.addedLines.values()].filter((l) => /"[^"]+"\s*:/.test(l) && !/version|name|main|scripts|babel|eslint|jest|tsconfig/i.test(l));
      if (newDeps.length) risks.push({ file: f.path, note: `dependencies changed (${newDeps.length} lines)` });
    }
    if (f.additions + f.deletions > 600) {
      risks.push({ file: f.path, note: `very large change (+${f.additions}/-${f.deletions})` });
    }
  }
  if (rawDiff && /\bforce-push\b|password\s*=\s*['"]|allow_insecure|verify\s*=\s*false|ssl_verify|nossl|rejectUnauthorized\s*:\s*false|eval\(|new Function\(/i.test(rawDiff)) {
    risks.push({ file: '(diff-wide)', note: 'insecure pattern detected in diff (eval/Function/disabled TLS verification/hardcoded password)' });
  }
  return { risks: risks.slice(0, 20), totalAdded: added, totalRemoved: removed, files: paths.size };
}
