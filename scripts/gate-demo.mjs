// gate-demo — print the REAL approval-gate verdicts from src/tools/local.js.
// Nothing here is scripted prose: isDangerousBash() and blockedBashReason()
// are the exact functions the bash tool consults on every call (riskyWhen),
// so what this prints is what the gate does.
import { isDangerousBash, blockedBashReason } from '../src/tools/local.js';

const safe = ['git status', 'npm test', 'node --test test/version.test.js'];
const danger = ['rm scratch.txt', 'git checkout -- .', 'git restore src/index.js'];

console.log('$ node scripts/gate-demo.mjs');
console.log('');
console.log('isDangerousBash() — the bash tool\'s riskyWhen: true → the gate asks, false → runs silent');
for (const c of [...safe, ...danger]) {
  const v = isDangerousBash(c);
  console.log(`  ${c.padEnd(34)} → ${v}`);
}
console.log('');
console.log('blockedBashReason() — the shell blocklist (refused BEFORE any human is asked):');
for (const c of ['git push origin main', 'rm -rf /']) {
  const reason = blockedBashReason(c);
  console.log(`  ${c.padEnd(34)} → ${reason ? `REFUSED: ${reason}` : '(allowed)'}`);
}
