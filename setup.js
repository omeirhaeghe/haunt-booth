#!/usr/bin/env node
// Haunt Booth setup wizard: asks a few questions and writes .env. Re-run any time; current values are the defaults.
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ENV = path.join(__dirname, '.env');
const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, orange: (s) => `\x1b[38;5;208m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m` };

function readEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(ENV, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* first run */ }
  return env;
}

const QUESTIONS = [
  { key: 'OPENAI_API_KEY', q: 'OpenAI API key (leave empty for demo mode)', secret: true,
    check: (v) => !v || /^sk-/.test(v) || 'OpenAI keys start with "sk-"' },
  { key: 'PARTY_TITLE', q: 'Party name (shown on the TV)', def: 'Halloween Party' },
  { key: 'PARTY_SUB', q: 'Subtitle: address, town or date (optional)', def: '' },
  { key: 'VIP_NAMES', q: 'Host first names, comma separated (they get glamour shots instead of monsters; optional)', def: '' },
  { key: 'VOTE_CLOSE', q: 'When does costume voting close? (HH:MM, 24h, or "off")', def: '23:00',
    check: (v) => /^(off|([01]?\d|2[0-3]):[0-5]\d)$/i.test(v) || 'use HH:MM like 22:30, or off' },
  { key: 'IMAGE_QUALITY', q: 'Image quality: low (fast, cheap) / medium / high', def: 'medium',
    check: (v) => /^(low|medium|high)$/.test(v) || 'low, medium or high' },
  { key: 'WIFI_NAME', q: 'Wi-Fi name for the "join the Wi-Fi" QR code (optional)', def: '' },
  { key: 'WIFI_PASSWORD', q: 'Wi-Fi password (stays on this computer)', def: '', secret: true, when: (a) => a.WIFI_NAME },
];

(async () => {
  const env = readEnv();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt) => { process.stdout.write(prompt); const n = await lines.next(); return n.done ? '' : n.value; };
  console.log(`\n  ${c.orange('🎃  HAUNT BOOTH SETUP')}\n  ${c.dim('Press Enter to keep the value in [brackets], type - to clear it.')}\n`);
  const answers = {};
  for (const item of QUESTIONS) {
    if (item.when && !item.when(answers)) continue;
    const cur = env[item.key] != null ? env[item.key] : (item.def || '');
    const shown = item.secret && cur ? cur.slice(0, 5) + '…' : cur;
    for (;;) {
      const raw = (await ask(`  ${c.bold(item.q)} ${shown ? c.dim(`[${shown}]`) : ''}\n  > `)).trim();
      const v = raw === '' ? cur : raw === '-' ? '' : raw;
      const ok = item.check ? item.check(v) : true;
      if (ok === true) { answers[item.key] = v; break; }
      console.log(`  ${c.orange('!')} ${ok}`);
    }
    console.log('');
  }
  rl.close();

  // Keep any other settings the user added by hand, update the ones we asked about.
  const merged = Object.assign({}, env, answers);
  if (!merged.WIFI_NAME) delete merged.WIFI_PASSWORD;
  const quote = (v) => (/[\s#'"]/.test(v) ? JSON.stringify(v) : v);
  const out = ['# Written by `npm run setup`. Edit by hand or re-run setup. See .env.example for every option.'];
  for (const [k, v] of Object.entries(merged)) if (v !== '') out.push(`${k}=${quote(v)}`);
  fs.writeFileSync(ENV, out.join('\n') + '\n', { mode: 0o600 });

  console.log(`  ${c.green('✓')} Saved settings to .env` +
    (answers.OPENAI_API_KEY ? '' : c.dim('  (no API key: demo mode, spooky filter instead of AI)')));
  console.log(`\n  Start the party:  ${c.bold('npm start')}   ${c.dim('(or double-click start.command on a Mac)')}\n`);
})().catch((e) => { console.error(e); process.exit(1); });
