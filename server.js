#!/usr/bin/env node
// Haunt Booth - zero-dependency server (Node 18+).
// Guests snap a photo on their phone -> OpenAI turns them into a monster ->
// the TV page rotates the results and everything lands in ./album.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------- config (.env file or environment variables) ----------
(function loadEnv() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* ignore */ }
})();

const PORT = parseInt(process.env.PORT, 10) || 3000;
const KEY = process.env.OPENAI_API_KEY || '';
const BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gpt-image-1';
const TEXT_MODEL = process.env.TEXT_MODEL || 'gpt-4o-mini';
const QUALITY = process.env.IMAGE_QUALITY || 'medium'; // low = faster/cheaper, medium = scarier
const MAX_PARALLEL = parseInt(process.env.MAX_PARALLEL, 10) || 4;
const DEMO = !KEY || process.env.DEMO === '1';
const PARTY_TITLE = process.env.PARTY_TITLE || 'Halloween Party';
const PARTY_SUB = process.env.PARTY_SUB || '';

const ALBUM = path.resolve(__dirname, process.env.ALBUM_DIR || 'album');
const PUB = path.join(__dirname, 'public');
// TV background, also used as "the house" in group scenes. Any image in public/ (default bg.jpg).
const BACKGROUND = path.join(PUB, path.basename(process.env.BACKGROUND || 'bg.jpg'));
fs.mkdirSync(ALBUM, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- monsters ----------
const MONSTERS = [
  { key: 'zombie', desc: 'a decayed, shambling zombie with gray-green rotting skin, sunken eyes and tattered clothes' },
  { key: 'vampire', desc: 'an ancient gothic vampire with deathly pale skin, glowing red eyes, long fangs and a high-collared cape' },
  { key: 'ghost', desc: 'a translucent ghost fading into drifting mist, with hollow glowing eyes, old chains and spectral wisps' },
  { key: 'werewolf', desc: 'a snarling werewolf mid-transformation with matted fur, yellow eyes and sharp teeth' },
  { key: 'witch', desc: 'a sinister swamp witch with warty green skin, a crooked hat, glowing eyes and crackling green magic' },
  { key: 'skeleton', desc: 'a skeletal revenant whose face is half bone, with glowing blue eye sockets, cobwebs and grave dirt' },
  { key: 'doll', desc: 'a possessed antique porcelain doll with cracked glassy skin, black tear tracks and unblinking eyes' },
  { key: 'clown', desc: 'a nightmarish carnival jester with smeared makeup, a jagged grin and a ragged ruffled costume' },
  { key: 'mummy', desc: 'an ancient mummy wrapped in rotting bandages with glowing eyes and drifting sand' },
  { key: 'swamp', desc: 'a swamp creature covered in moss, slime and tangled roots, with luminous eyes' },
  { key: 'demon', desc: 'a horned demon with ember-glowing skin, smoldering eyes and curling smoke' },
  { key: 'forest', desc: 'a haunted antlered forest spirit with a bone-white mask-like face, glowing eyes and thorny vines' },
];

// Art styles and settings rotate so the album doesn't look like 50 copies of the same picture.
const STYLES = [
  { key: 'cinematic', desc: 'Cinematic Halloween horror movie still: moody low-key lighting, drifting fog, rich photographic detail' },
  { key: 'classic-bw', desc: 'Vintage 1930s black-and-white monster movie still: high-contrast silver film grain, dramatic shadows, old Hollywood horror glamour' },
  { key: 'oil-portrait', desc: 'Gothic oil painting portrait in an ornate tarnished gold frame, as if hanging in a haunted mansion: visible brushstrokes, candlelit chiaroscuro' },
  { key: 'vhs-poster', desc: '1980s VHS horror movie poster art: airbrushed painted look, lurid neon glow, dramatic rim lighting, worn cover texture (no text or lettering)' },
  { key: 'daguerreotype', desc: 'Antique Victorian spirit photograph: sepia daguerreotype with scratches, vignetting, ghostly double exposure and faded edges' },
  { key: 'comic', desc: 'Retro 1950s horror comic book cover illustration: bold inked lines, halftone dots, saturated pulp colors (no text or speech bubbles)' },
  { key: 'stop-motion', desc: 'Whimsical gothic stop-motion animation style: handcrafted clay and fabric puppet look, spindly proportions, miniature set, soft studio lighting' },
  { key: 'dia-de-muertos', desc: 'Vibrant Day of the Dead style: ornate sugar-skull face painting, marigolds, candles and papel picado glow' },
  { key: 'animated-3d', desc: 'Playful 3D animated family movie style: expressive stylized character, glossy rendering, spooky but charming' },
  { key: 'neon', desc: 'Eerie neon synthwave horror: glowing purple and orange rim light, dark haze, electric atmosphere' },
];
const SETTINGS = [
  'a fog-drenched graveyard under a full moon', 'a candlelit haunted mansion hallway with crooked portraits',
  'an abandoned midnight carnival', 'a twisted dark forest with clawing branches', 'a cobwebbed crypt lit by torches',
  'a creaky Victorian attic', 'a witch\'s cluttered potion laboratory', 'a misty swamp with glowing will-o\'-wisps',
];
// Shuffled decks: every option gets used before any repeats.
function deck(list) {
  let pile = [];
  return () => { if (!pile.length) pile = list.slice().sort(() => Math.random() - 0.5); return pile.pop(); };
}
const nextStyle = deck(STYLES);
const nextMonster = deck(MONSTERS);
const nextSetting = deck(SETTINGS);

// Easter egg: the hosts don't become monsters, they become the most beautiful people in the room.
// VIP_NAMES=alex,sam (first names, comma separated). Empty = off.
const VIP_NAMES = (process.env.VIP_NAMES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const isVip = (name) => {
  const first = normName(name)[0];
  return !!first && VIP_NAMES.includes(first);
};
const VIP_STYLES = [
  'Glamorous old-Hollywood studio portrait: soft golden key light, satin and velvet, flawless film-star retouching, timeless elegance',
  'High-fashion magazine cover shoot (no text or lettering): radiant beauty lighting, couture Halloween-gala outfit, glowing skin, editorial perfection',
  'Regal Renaissance royal portrait in an ornate gold frame: luminous skin, jewels, rich velvet robes, adoring candlelight',
  'Red-carpet gala photo at a candlelit masquerade ball: elegant gown or tuxedo, sparkling jewelry, dreamy bokeh of candles and pumpkins',
];
function vipPrompt() {
  return 'Transform the person in this photo into the most beautiful, glamorous, radiant person at the Halloween party - ' +
    'a stunning, flattering, idealized version of themselves, glowing with confidence and charm. Absolutely not a monster: no fangs, no scars, no creepy features. ' +
    'Keep their face shape, expression, pose and hair recognizable so their friends can tell who it is, just at their most gorgeous. ' +
    `Art style: ${pickOne(VIP_STYLES)}. Tasteful, elegant, non-revealing outfit. Subtle elegant Halloween touches in the background (candles, a few pumpkins, soft mist). ` +
    'No text or lettering. Keep the same framing as the original photo.';
}

// Optional per-guest hints (hobby, job, home country) from guest-hints.json, keyed by first name or first two names.
// Re-read on every lookup so the host can edit it mid-party without a restart.
const HINTS_FILE = path.join(__dirname, 'guest-hints.json');
const normName = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
function guestHint(name) {
  const words = normName(name);
  if (!words.length) return null;
  let hints;
  try { hints = JSON.parse(fs.readFileSync(HINTS_FILE, 'utf8')); } catch (_) { return null; }
  let best = null, bestLen = 0;
  for (const [k, v] of Object.entries(hints)) {
    if (k.startsWith('_') || typeof v !== 'string') continue;
    const kw = normName(k);
    const joined = kw.join('');
    // "Beth Anne", "Beth-Anne" and "Bethanne" all match "beth anne"; "Mary" alone does not match "mary claire".
    const hit = (kw.length <= words.length && kw.every((w, i) => words[i] === w)) || words[0] === joined;
    if (hit && kw.length > bestLen) { best = v.slice(0, 300); bestLen = kw.length; }
  }
  return best;
}

function monsterPrompt(m, style, setting, hint) {
  return `Transform the person in this photo into ${m.desc}. ` +
    'Keep their face shape, expression, pose and hair recognizable so their friends can tell who it is. ' +
    'If they are already wearing a costume, twist it into the monster. ' +
    (hint ? `Fun personal touch: this guest ${hint} - work a playful visual nod to that into the monster and scene. ` : '') +
    `Art style: ${style.desc}. Setting: ${setting}. ` +
    'Scary but not gory or graphic - no blood splatter, wounds or injuries. Keep the same framing as the original photo.';
}

// ---------- records ----------
const records = new Map();
function save(r) {
  fs.writeFileSync(path.join(ALBUM, r.id + '.json'), JSON.stringify(r, null, 2));
}
for (const f of fs.readdirSync(ALBUM)) {
  if (!f.endsWith('.json') || ['votes.json', 'awards.json', 'scenes.json'].includes(f)) continue;
  try {
    const r = JSON.parse(fs.readFileSync(path.join(ALBUM, f), 'utf8'));
    if (r.status === 'pending') { r.status = 'fallback'; r.error = 'server restarted'; save(r); }
    records.set(r.id, r);
  } catch (_) { /* skip bad file */ }
}

function pub(r) {
  return {
    id: r.id,
    createdAt: r.createdAt,
    status: r.status,
    name: r.name,
    monster: r.monster,
    card: r.card || null,
    judge: r.judge || null,
    votes: voteCount(r.id),
    vip: !!r.vip,
    orig: `/photos/${r.id}.orig.jpg`,
    monsterImg: r.monsterFile ? `/photos/${r.monsterFile}` : null,
  };
}

// ---------- crowd voting ----------
// Each phone gets a random voter id (kept in its browser) and VOTE_LIMIT votes. Voting auto-closes at VOTE_CLOSE
// (server clock, HH:MM today; "off" = never) or when the host presses C on the TV page.
const VOTE_LIMIT = parseInt(process.env.VOTE_LIMIT, 10) || 3;
const VOTE_CLOSE = (process.env.VOTE_CLOSE || '23:00').trim();
function computeCloseAt() {
  if (/^(off|none|never)$/i.test(VOTE_CLOSE)) return null;
  const m = VOTE_CLOSE.match(/^(\d{1,2}):(\d{2})$/);
  if (m) { const d = new Date(); d.setHours(+m[1], +m[2], 0, 0); return d.getTime(); }
  const t = Date.parse(VOTE_CLOSE);
  return Number.isNaN(t) ? null : t;
}
const CLOSE_AT = computeCloseAt();
let forceClosed = false;
const VOTES_FILE = path.join(ALBUM, 'votes.json');
let votes = {}; // voterId -> [photoId, ...]
try { votes = JSON.parse(fs.readFileSync(VOTES_FILE, 'utf8')).votes || {}; } catch (_) { /* none yet */ }
function saveVotes() {
  const tmp = VOTES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ votes }, null, 1));
  fs.renameSync(tmp, VOTES_FILE);
}
const voteOpen = () => !forceClosed && (CLOSE_AT === null || Date.now() < CLOSE_AT);
function voteCount(id) {
  let n = 0;
  for (const v of Object.values(votes)) if (v.includes(id)) n++;
  return n;
}

// ---------- awards: People's Choice (votes) + AI's Choice (judge; ties settled by the AI) ----------
const AWARDS_FILE = path.join(ALBUM, 'awards.json');
let awardsCache = null, awardsPromise = null;
try { awardsCache = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8')); } catch (_) { /* none yet */ }

// Several costumes tied for the top judge score: show the AI the finalists side by side and let it pick one.
async function deliberate(finalists) {
  const content = [{ type: 'text', text: 'You are the final judge of a Halloween costume contest. These costumes tied for the top score. ' +
    'Pick the single best costume overall (creativity, effort, execution, humor). Judge only the costumes, never anyone\'s looks, body or identity. ' +
    'Candidates follow, each as a label then a photo.' }];
  finalists.forEach((r, i) => {
    content.push({ type: 'text', text: `Candidate ${i + 1}: ${r.name || 'guest'} (costume guess: ${r.judge.costume})` });
    const b64 = fs.readFileSync(path.join(ALBUM, r.id + '.orig.jpg')).toString('base64');
    content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64, detail: 'low' } });
  });
  content.push({ type: 'text', text: 'Reply with JSON only: {"winner": <candidate number>, "verdict": "<one funny, specific sentence announcing why they won, max 180 characters>"}' });
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.JUDGE_MODEL || TEXT_MODEL,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error('deliberation HTTP ' + res.status);
  const j = await res.json();
  const c = JSON.parse(j.choices[0].message.content);
  const n = parseInt(c.winner, 10);
  if (!(n >= 1 && n <= finalists.length)) throw new Error('bad winner index');
  return { record: finalists[n - 1], verdict: String(c.verdict || '').slice(0, 220) };
}

async function computeAwards() {
  const vis = [...records.values()].filter((r) => !r.hidden && !r.vip && r.status !== 'pending' && r.judge); // hosts don't compete
  if (!vis.length) return { ai: null, crowd: null };
  const cnt = {};
  vis.forEach((r) => { cnt[r.id] = voteCount(r.id); });
  const crowd = vis.filter((r) => cnt[r.id] > 0)
    .sort((a, b) => cnt[b.id] - cnt[a.id] || b.judge.score - a.judge.score || a.createdAt - b.createdAt)[0];
  const top = Math.max(...vis.map((r) => r.judge.score));
  const finalists = vis.filter((r) => r.judge.score === top).sort((a, b) => a.createdAt - b.createdAt).slice(0, 6);
  let aiRec = finalists[0], verdict = aiRec.judge.roast, method = 'score';
  if (finalists.length > 1 && !DEMO) {
    try {
      const d = await deliberate(finalists);
      aiRec = d.record; verdict = d.verdict || aiRec.judge.roast; method = 'deliberation';
    } catch (e) {
      console.warn('AI deliberation failed, using earliest top-scorer:', e.message);
    }
  }
  return {
    ai: { id: aiRec.id, verdict, method, score: aiRec.judge.score },
    crowd: crowd ? { id: crowd.id, votes: cnt[crowd.id] } : null,
  };
}

// While voting is open this is a live preview (never cached). Once closed it is computed once and kept.
function getAwards() {
  if (voteOpen()) { awardsCache = null; return computeAwards(); }
  if (awardsCache) return Promise.resolve(awardsCache);
  if (!awardsPromise) {
    awardsPromise = computeAwards().then((a) => {
      awardsCache = a;
      try { fs.writeFileSync(AWARDS_FILE, JSON.stringify(a, null, 1)); } catch (_) { /* best effort */ }
      return a;
    }).finally(() => { awardsPromise = null; });
  }
  return awardsPromise;
}

// ---------- OpenAI ----------
async function callEdit(buf, prompt, extras) {
  const form = new FormData();
  form.append('model', IMAGE_MODEL);
  form.append('prompt', prompt);
  form.append('size', '1024x1024');
  for (const [k, v] of Object.entries(extras)) form.append(k, v);
  form.append('image', new Blob([buf], { type: 'image/jpeg' }), 'guest.jpg');
  const res = await fetch(BASE + '/images/edits', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY },
    body: form,
    signal: AbortSignal.timeout(150000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  if (!res.ok) {
    const err = new Error((json && json.error && json.error.message) || text.slice(0, 200) || ('HTTP ' + res.status));
    err.status = res.status;
    err.code = json && json.error && json.error.code;
    throw err;
  }
  return json;
}

// Ask the text model to look at the guest and invent a one-of-a-kind transformation that fits their costume.
// The safety / likeness rules are added around it by us, so the model can't drop them. Returns null on any failure.
async function inventConcept(r, buf, m, style, setting) {
  if (process.env.AI_PROMPTS === '0') return null;
  try {
    const res = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TEXT_MODEL,
        response_format: { type: 'json_object' },
        temperature: 1.1,
        messages: [
          { role: 'system', content: 'You are the creative director of a Halloween party photo booth. You invent a unique, imaginative monster transformation for each guest photo. PG-13 spooky fun: no blood, gore, wounds, weapons, violence or anything sexual. Never comment on the person\'s body, weight, age or looks. Reply with JSON only.' },
          { role: 'user', content: [
            { type: 'text', text:
              (r.hint ? `Personal detail from the host: this guest ${r.hint}. Weave a clever, playful visual nod to it into the monster, outfit or scene (it should be noticeable).\n` : '') +
              `Inspiration (remix freely): monster type "${m.key}" (${m.desc}); setting: ${setting}; art style: ${style.desc}.\n` +
              'Look at their costume, props, hair and pose. If they wear a costume, build the monster around it (e.g. a pirate becomes a drowned ghost captain). ' +
              'Return JSON {"concept": "..."}: one vivid paragraph, max 70 words, describing what they transform into, their monstrous features and outfit, and the scene around them. ' +
              'Do not describe the art style (that is added separately). No text or lettering in the image.' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + buf.toString('base64'), detail: 'low' } },
          ] },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const c = String(JSON.parse(j.choices[0].message.content).concept || '').trim().slice(0, 600);
    return c.length > 20 ? c : null;
  } catch (e) {
    console.warn(`[${r.id}] concept failed, using standard prompt: ${e.message}`);
    return null;
  }
}

async function makeMonster(r, buf) {
  const m = MONSTERS.find((x) => x.key === r.monster);
  const style = STYLES.find((x) => x.key === r.style) || STYLES[0];
  const setting = r.setting || SETTINGS[0];
  const concept = r.vip ? null : await inventConcept(r, buf, m, style, setting);
  if (concept) { r.concept = concept; console.log(`[${r.id}] concept: ${concept}`); }
  const prompt = r.vip ? vipPrompt() : concept
    ? `Transform the person in this photo: ${concept} ` +
      'Keep their face shape, expression, pose and hair recognizable so their friends can tell who it is. ' +
      `Art style: ${style.desc}. ` +
      'Scary but not gory or graphic - no blood splatter, wounds or injuries. No text or lettering. Keep the same framing as the original photo.'
    : monsterPrompt(m, style, setting, r.hint);
  const isGptImage = /^gpt-image/.test(IMAGE_MODEL);
  const extras = isGptImage
    ? { quality: QUALITY, output_format: 'jpeg', output_compression: '85' }
    : {};
  if (/^gpt-image-1/.test(IMAGE_MODEL)) extras.input_fidelity = 'high'; // gpt-image-2+ rejects this param
  let json;
  try {
    json = await callEdit(buf, prompt, extras);
  } catch (e) {
    if (e.status === 401 || e.status === 403) throw e;
    if (e.code === 'moderation_blocked' || /safety system|safety_violations/i.test(e.message || '')) {
      // The safety filter sometimes flags spooky prompts as "violence". Retry once with a gentle costume-style prompt.
      console.warn(`[${r.id}] safety filter tripped (${style.key}, ${m.key}); retrying with a gentler prompt`);
      const gentle = r.vip ? vipPrompt() : `Give the person in this photo a fun, family-friendly Halloween ${m.key} costume and makeup look. ` +
        'Keep their face, expression, pose and hair recognizable. Spooky-cute, theatrical, friendly. ' +
        'Moody Halloween portrait lighting with soft fog and glowing jack-o\'-lanterns in the background. Keep the same framing.';
      json = await callEdit(buf, gentle, extras);
    } else if (e.status === 400 && Object.keys(extras).length) {
      json = await callEdit(buf, prompt, {}); // drop optional params and retry
    } else if (e.status === 429 || e.status >= 500) {
      await sleep(4000);
      json = await callEdit(buf, prompt, extras);
    } else {
      throw e;
    }
  }
  const item = json && json.data && json.data[0];
  if (item && item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item && item.url) {
    const rr = await fetch(item.url);
    return Buffer.from(await rr.arrayBuffer());
  }
  throw new Error('No image returned');
}

const CANNED = {
  titles: ['Duke of the Dusty Crypt', 'Lord of Lukewarm Graves', 'The Midnight Snacker', 'Baron Von Spooksworth',
    'Keeper of Creaky Stairs', 'Queen of the Cold Spots', 'The Haunted Houseguest', 'Count Snackula', 'Sir Boos-a-Lot',
    'Warden of the Wobbly Tombstone'],
  curses: [
    'Cursed to forever hear the fridge door open and find nothing good inside.',
    'Died of laughing at their own jokes. The jokes are still not good.',
    'Doomed to haunt every party and eat all the candy corn nobody wanted.',
    'Cursed with perfect hair in the afterlife but no mirror to enjoy it.',
    'Trapped between worlds, mostly because the Wi-Fi in both is terrible.',
    'Cursed to whisper "one more episode" until the end of time.',
    'Rose from the grave solely to claim the last slice of pizza.',
    'Eternally lost on the way to the party bathroom.',
  ],
  last: ['I regret nothing. Except the dip.', 'Tell them I was fashionably late.', 'Is there still candy?',
    'Boo. ...Was that okay?', 'I knew that door was a bad idea.', 'Save me a seat in the afterlife.'],
};
const NICK = {
  adj: ['Ghastly', 'Shadowy', 'Wicked', 'Creepy', 'Moonlit', 'Howling', 'Grim', 'Cursed', 'Spectral', 'Midnight', 'Rattling', 'Wailing'],
  noun: ['Stranger', 'Phantom', 'Wraith', 'Goblin', 'Banshee', 'Specter', 'Ghoul', 'Lurker', 'Haunter', 'Visitor', 'Fiend', 'Shade'],
};
const cannedNickname = () => `The ${pickOne(NICK.adj)} ${pickOne(NICK.noun)}`;
const pickOne = (a) => a[Math.floor(Math.random() * a.length)];
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

function cannedCard() {
  return {
    title: pickOne(CANNED.titles),
    curse: pickOne(CANNED.curses),
    last_words: pickOne(CANNED.last),
    stats: { fright: randInt(40, 99), charm: randInt(10, 99), stamina: randInt(10, 99) },
  };
}

async function makeCard(r) {
  if (r.vip) return makeVipCard(r);
  const m = MONSTERS.find((x) => x.key === r.monster);
  const sys = 'You write short, funny, party-friendly (PG) Halloween "cursed trading cards" for party guests who were just turned into monsters. Reply with JSON only.';
  const user = `Monster form: ${m.key}. Guest first name: ${r.name || 'unknown (invent a spooky nickname)'}.\n` +
    (r.hint ? `Fun fact about this guest: they ${r.hint.replace(/\s*\(.*\)\s*$/, '')}. Work a playful reference to it into the title or curse.\n` : '') +
    'Return JSON with keys: ' +
    (r.name ? '' : '"nickname" (a fun spooky name to call this anonymous guest, 2-3 words, max 22 characters, fits the monster form, e.g. "Ghastly Gus", "Countess Creepsalot"), ') +
    '"title" (fun monster title, max 6 words, e.g. "Duke of the Dusty Crypt"), ' +
    '"curse" (one funny sentence, max 140 characters, about their curse or cause of death - lighthearted and PG), ' +
    '"last_words" (max 80 characters, funny), ' +
    '"stats" (object with integer keys "fright", "charm", "stamina", each 1-99).';
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TEXT_MODEL,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('card HTTP ' + res.status);
  const j = await res.json();
  const c = JSON.parse(j.choices[0].message.content);
  const clamp = (n) => Math.max(1, Math.min(99, parseInt(n, 10) || randInt(20, 90)));
  const nickname = String(c.nickname || '').replace(/[^\p{L}\p{N} '\-.]/gu, '').trim().slice(0, 24);
  return {
    nickname: nickname || undefined,
    title: String(c.title || pickOne(CANNED.titles)).slice(0, 60),
    curse: String(c.curse || pickOne(CANNED.curses)).slice(0, 180),
    last_words: String(c.last_words || pickOne(CANNED.last)).slice(0, 100),
    stats: {
      fright: clamp(c.stats && c.stats.fright),
      charm: clamp(c.stats && c.stats.charm),
      stamina: clamp(c.stats && c.stats.stamina),
    },
  };
}

const VIP_CANNED = {
  titles: ['The Most Beautiful Person in the Room', 'Too Gorgeous to Haunt', 'Royalty of the Night', 'The Monster Who Refused'],
  curses: ['The spirits tried to turn them into a monster and simply could not. Too radiant.',
    'Cursed with being so beautiful that the ghosts asked for a selfie.'],
  last: ['Monsters? Not tonight, darling.', 'The mirror said thank you.'],
};
function vipStats() { return { fright: randInt(1, 9), charm: 99, stamina: randInt(90, 99) }; }
async function makeVipCard(r) {
  const fallback = { title: pickOne(VIP_CANNED.titles), curse: pickOne(VIP_CANNED.curses), last_words: pickOne(VIP_CANNED.last), stats: vipStats() };
  try {
    const res = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TEXT_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You write short, funny, glowing (PG) party cards for the hosts of a Halloween party. The photo booth turns every guest into a monster, but the hosts are a secret easter egg: they are the most beautiful people in the room. Reply with JSON only.' },
          { role: 'user', content: `Host first name: ${r.name}.\nReturn JSON with keys: "title" (max 6 words, over-the-top flattering, e.g. "The Most Beautiful Person in the Room"), ` +
            '"curse" (one funny sentence, max 140 characters, about how the monster curse failed because they are too gorgeous), ' +
            '"last_words" (max 80 characters, a confident, charming one-liner).' },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const c = JSON.parse((await res.json()).choices[0].message.content);
    return {
      title: String(c.title || fallback.title).slice(0, 60),
      curse: String(c.curse || fallback.curse).slice(0, 180),
      last_words: String(c.last_words || fallback.last_words).slice(0, 100),
      stats: vipStats(),
    };
  } catch (e) {
    console.warn(`[${r.id}] VIP card failed, using canned: ${e.message}`);
    return fallback;
  }
}

const CANNED_JUDGE = [
  { costume: 'A bold choice', roast: 'The effort is there. The commitment is... suggested. I have seen scarier shower curtains.', score: 5 },
  { costume: 'Mystery costume', roast: 'I cannot tell what you are, and neither can the ghosts. Points for confidence.', score: 6 },
  { costume: 'Last-minute special', roast: 'This had the energy of a costume assembled in the car on the way here. It worked, barely.', score: 4 },
  { costume: 'Surprisingly good', roast: 'Against all odds this is working. I hate that I respect it.', score: 8 },
];
function cannedJudge() { return Object.assign({}, pickOne(CANNED_JUDGE)); }

// Optional: look at the photo, then web-search what the costume is (JUDGE_SEARCH=1). Best effort, never throws.
async function researchCostume(r, buf) {
  try {
    const res = await fetch(BASE + '/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.JUDGE_SEARCH_MODEL || 'gpt-4o',
        tools: [{ type: 'web_search_preview' }],
        input: [{ role: 'user', content: [
          { type: 'input_text', text: 'This is a photo from a Halloween party. Identify the costume (what character, movie, meme, pun or group it is). ' +
            'If it looks like a specific character, show, movie, game, meme or trend, use web search to confirm what it is and find one funny or recognizable detail about it. ' +
            'Only describe the costume, never the person. Reply with JSON only: {"costume":"best guess, max 6 words","what_it_is":"one sentence on what it is","funny_detail":"one short detail"}. ' +
            'If there is no costume, set costume to "No costume".' },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,' + buf.toString('base64') },
        ] }],
      }),
      signal: AbortSignal.timeout(50000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    let text = j.output_text || '';
    if (!text && Array.isArray(j.output)) {
      for (const it of j.output) {
        if (it.type === 'message') for (const c of it.content || []) if (c.type === 'output_text') text += c.text;
      }
    }
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    return {
      costume: String(o.costume || '').slice(0, 80),
      what: String(o.what_it_is || '').slice(0, 240),
      detail: String(o.funny_detail || '').slice(0, 200),
    };
  } catch (e) {
    console.warn(`[${r.id}] costume search failed (judge continues without it): ${e.message}`);
    return null;
  }
}

async function makeJudge(r, buf) {
  const notes = process.env.JUDGE_SEARCH === '1' ? await researchCostume(r, buf) : null;
  const sys = (r.vip
    ? 'This guest is one of the party hosts (a secret easter egg): instead of roasting, the judge is completely starstruck. ' +
      'Gush about the costume (or their effortless style if there is no costume) in a funny, over-the-top way, and give a score of 10. ' +
      'Never comment on body, weight, age, skin color, gender or identity. '
    : '') +
    'You are the savage but good-natured judge of a Halloween costume contest at a house party. PG-13, no profanity. ' +
    'Look at the photo. Identify the costume if there is one. Roast ONLY the costume: effort, creativity, execution, puns, how recognizable it is. ' +
    'NEVER comment on anyone\'s body, face, weight, age, skin color, gender, disability or identity. ' +
    'If there is no costume, playfully roast the lack of effort (e.g. came as a person who forgot it was Halloween). ' +
    'If the person looks like a child, be warm and playful, never harsh, and score 8-10. ' +
    'Be specific to what you actually see. Reply with JSON only.';
  const user = [
    { type: 'text', text: (notes && notes.costume ? `Research notes from a web search (trust these for what the costume is): costume = ${notes.costume}; what it is = ${notes.what}; detail = ${notes.detail}.\n` : '') +
      `Guest first name: ${r.name || 'unknown'}.\nReturn JSON with keys: "costume" (your best guess at what they are, max 6 words), "roast" (max 170 characters, funny, specific to the costume), "score" (integer 1-10, be stingy: 6 is average).` },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + buf.toString('base64'), detail: 'low' } },
  ];
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.JUDGE_MODEL || TEXT_MODEL,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error('judge HTTP ' + res.status);
  const j = await res.json();
  const c = JSON.parse(j.choices[0].message.content);
  const score = r.vip ? 10 : Math.max(1, Math.min(10, parseInt(c.score, 10) || 6));
  return {
    costume: String(c.costume || 'Mystery costume').slice(0, 60),
    roast: String(c.roast || pickOne(CANNED_JUDGE).roast).slice(0, 220),
    score,
  };
}

// ---------- job queue ----------
let active = 0;
const queue = [];
function enqueue(fn) { queue.push(fn); pump(); }
function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    const fn = queue.shift();
    active++;
    fn().catch((e) => console.error('job error', e)).finally(() => { active--; pump(); });
  }
}

async function processRecord(r, buf) {
  if (DEMO) {
    await sleep(3500);
    r.card = r.vip ? { title: VIP_CANNED.titles[0], curse: pickOne(VIP_CANNED.curses), last_words: pickOne(VIP_CANNED.last), stats: vipStats() } : cannedCard();
    r.judge = cannedJudge();
    if (r.vip) r.judge.score = 10;
    if (!r.name) { r.name = cannedNickname(); r.nicknamed = true; }
    r.status = 'fallback';
    r.error = 'demo mode (no OPENAI_API_KEY)';
    save(r);
    console.log(`[${r.id}] demo result for ${r.name || 'guest'}`);
    return;
  }
  const [img, card, judge] = await Promise.allSettled([makeMonster(r, buf), makeCard(r), makeJudge(r, buf)]);
  r.judge = judge.status === 'fulfilled' ? judge.value : cannedJudge();
  if (judge.status === 'rejected') console.warn(`[${r.id}] judge failed: ${judge.reason && judge.reason.message}`);
  r.card = card.status === 'fulfilled' ? card.value : cannedCard();
  if (card.status === 'rejected') console.warn(`[${r.id}] card text failed: ${card.reason && card.reason.message}`);
  // Anonymous guest: give them the AI's spooky nickname (or a random one) instead of "Unknown Guest".
  if (!r.name) { r.name = r.card.nickname || cannedNickname(); r.nicknamed = true; }
  delete r.card.nickname;
  if (img.status === 'fulfilled') {
    const b = img.value;
    const ext = b.slice(0, 4).toString('hex') === '89504e47' ? 'png' : 'jpg';
    r.monsterFile = `${r.id}.monster.${ext}`;
    fs.writeFileSync(path.join(ALBUM, r.monsterFile), b);
    r.status = 'done';
    console.log(`[${r.id}] ${r.name || 'guest'} -> ${r.monster} done`);
  } else {
    r.status = 'fallback';
    r.error = String((img.reason && img.reason.message) || img.reason).slice(0, 300);
    console.error(`[${r.id}] image failed, using fallback: ${r.error}`);
  }
  save(r);
  scheduleScene(); // costume scenes use every guest's original photo, even if their monster failed
}

// ---------- group scenes: everyone partying in front of the house ----------
// Two kinds of group painting, each split into groups of SCENE_MAX guests in arrival order (1-15, 16-30, ...):
//   monster: the guests' monster portraits throwing a party (the Monster Bash)
//   costume: the guests as themselves, from their original photos, in their real costumes (the Costume Party).
//            Selfies are usually cropped, so the AI completes the parts of each costume it can't see.
// Each group is repainted (debounced) only when its guest list changes, so new arrivals only repaint the newest group.
// One image edit call takes up to 16 inputs: the house + SCENE_MAX guests.
const SCENE_FILE = path.join(ALBUM, 'scenes.json');
const SCENE_MAX = Math.min(15, parseInt(process.env.SCENE_MAX, 10) || 15);
const SCENE_DELAY = parseInt(process.env.SCENE_DELAY_MS, 10) || 20000;
const SCENE_KINDS = ['monster'].concat(process.env.SCENE_COSTUME === '0' ? [] : ['costume']);
let scenes = { monster: [], costume: [] }, sceneBusy = false, sceneDirty = false, sceneTimer = null;
try {
  const saved = JSON.parse(fs.readFileSync(SCENE_FILE, 'utf8'));
  if (Array.isArray(saved)) scenes.monster = saved; // older format: monster scenes only
  else Object.assign(scenes, saved);
} catch (_) { /* none yet */ }
const saveScenes = () => fs.writeFileSync(SCENE_FILE, JSON.stringify(scenes, null, 2));

function sceneGroups(kind) {
  const all = [...records.values()]
    .filter((r) => !r.hidden && (kind === 'costume' ? r.status !== 'pending' : r.status === 'done' && r.monsterFile))
    .sort((a, b) => a.createdAt - b.createdAt);
  const groups = [];
  for (let i = 0; i < all.length; i += SCENE_MAX) groups.push(all.slice(i, i + SCENE_MAX));
  // A lone guest can't throw a party by themselves: a group only gets painted once it has 2 guests.
  return groups.filter((g) => g.length >= 2);
}
function scheduleScene() {
  if (DEMO || process.env.SCENE === '0') return;
  if (sceneBusy) { sceneDirty = true; return; }
  clearTimeout(sceneTimer);
  sceneTimer = setTimeout(() => makeScenes().catch((e) => console.error('scene failed:', e.message)), SCENE_DELAY);
}
async function makeScenes() {
  sceneBusy = true; sceneDirty = false;
  try {
    for (const kind of SCENE_KINDS) {
      const groups = sceneGroups(kind);
      scenes[kind] = (scenes[kind] || []).slice(0, groups.length); // groups vanish if guests were hidden
      for (let gi = 0; gi < groups.length; gi++) {
        const sig = groups[gi].map((r) => r.id).join(',');
        if (scenes[kind][gi] && scenes[kind][gi].sig === sig) continue;
        try {
          scenes[kind][gi] = await paintScene(kind, groups[gi], gi, sig);
        } catch (e) {
          console.error(`[${kind} scene ${gi + 1}] failed: ${e.message}`); // keep going with the other groups/kinds
        }
        saveScenes();
      }
    }
    saveScenes();
  } finally {
    sceneBusy = false;
    if (sceneDirty) scheduleScene();
  }
}

const SCENE_MOODS = ['dancing wildly under party lights', 'gathered around a roaring bonfire roasting marshmallows', 'posing for a group photo on the front steps',
  'doing a spooky conga line across the lawn', 'toasting with glowing potions around a cauldron punch bowl', 'crowding around a DJ booth on the driveway'];
const HOUSE_RULE = 'Keep the house recognizable (same architecture, roof, windows and garage) but decorated for Halloween night: glowing windows, jack-o\'-lanterns, fog, cobwebs, a big full moon, purple and orange party lights. ';

function scenePrompt(kind, group, gi) {
  const n = group.length;
  const names = group.map((r, i) => `image ${i + 2}: ${r.name || 'a guest'}`).join('; ');
  const mood = SCENE_MOODS[(gi + (kind === 'costume' ? 3 : 0)) % SCENE_MOODS.length];
  if (kind === 'costume') {
    return `Image 1 is a house. Images 2 to ${n + 1} are photos of ${n} real Halloween party guests in their costumes (${names}). ` +
      `Create ONE wide group picture of these exact ${n} people, as themselves in their own costumes (not monsters), throwing a joyful Halloween costume party ` +
      `on the front lawn and driveway of THIS exact house at night, ${mood}. ` + HOUSE_RULE +
      'Each person must look as close as possible to their photo: same face, hair, skin tone, glasses, facial hair, makeup and expression, so friends instantly recognize them. ' +
      'Keep every visible part of each costume exactly as it is (colors, patterns, hats, masks, wigs, props). ' +
      'Most photos are close-up selfies that cut off the body: show everyone full-length or three-quarter, and complete the parts of each costume that are not visible ' +
      'in a way that naturally matches the visible part (same character, colors and materials). ' +
      `Every one of the ${n} guests must appear exactly once, faces clearly visible and not hidden. No other people. ` +
      'Realistic, like a fun professional party photo with warm, cinematic lighting. No text or lettering.';
  }
  return `Image 1 is a house. Images 2 to ${n + 1} are ${n} Halloween party guests who were each turned into a monster (${names}). ` +
    `Create ONE wide cinematic group picture: all ${n} of these monsters together throwing a wild, joyful Halloween party on the front lawn and driveway of THIS exact house at night, ` +
    `${mood}. ` + HOUSE_RULE.replace('decorated for Halloween night', 'haunted') +
    `Every one of the ${n} monsters must appear exactly once, keeping their face, costume, colors and monster look from their image so friends can spot them. ` +
    'Everyone clearly visible, faces not hidden. No other people besides these monsters. ' +
    'Spooky but fun, not gory. Painterly, highly detailed, rich cinematic lighting. No text or lettering.';
}

async function paintScene(kind, group, gi, sig) {
  const n = group.length;
  const form = new FormData();
  form.append('model', IMAGE_MODEL);
  form.append('prompt', scenePrompt(kind, group, gi));
  form.append('size', '1536x1024');
  form.append('quality', process.env.SCENE_QUALITY || QUALITY);
  form.append('output_format', 'jpeg');
  form.append('output_compression', '85');
  // Faces matter most when painting people as themselves.
  if (kind === 'costume' && /^gpt-image-1/.test(IMAGE_MODEL)) form.append('input_fidelity', 'high');
  form.append('image[]', new Blob([fs.readFileSync(BACKGROUND)], { type: /\.png$/i.test(BACKGROUND) ? 'image/png' : 'image/jpeg' }), path.basename(BACKGROUND));
  for (const r of group) {
    const file = kind === 'costume' ? `${r.id}.orig.jpg` : r.monsterFile;
    form.append('image[]', new Blob([fs.readFileSync(path.join(ALBUM, file))], { type: /\.png$/.test(file) ? 'image/png' : 'image/jpeg' }), file);
  }
  const label = `[${kind} scene ${gi + 1}]`;
  console.log(`${label} painting ${n} guests partying in front of the house...`);
  const t0 = Date.now();
  const res = await fetch(BASE + '/images/edits', {
    method: 'POST', headers: { Authorization: 'Bearer ' + KEY }, body: form, signal: AbortSignal.timeout(300000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  if (!res.ok) throw new Error((json && json.error && json.error.message) || text.slice(0, 200));
  const item = json && json.data && json.data[0];
  if (!item || !item.b64_json) throw new Error('no image returned');
  const file = `${kind === 'costume' ? 'costume-' : ''}scene${gi + 1}-${Date.now().toString(36)}.jpg`;
  fs.writeFileSync(path.join(ALBUM, file), Buffer.from(item.b64_json, 'base64'));
  console.log(`${label} done: ${n} guests in ${Math.round((Date.now() - t0) / 1000)}s -> ${file}`);
  return { file, sig, count: n, names: group.map((r) => r.name || 'Guest'), createdAt: Date.now() };
}
setTimeout(scheduleScene, 3000); // catch up after a restart if the guest list changed

// ---------- http ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendFile(res, file, extraHeaders) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, Object.assign({
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
    }, extraHeaders || {}));
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Wi-Fi join QR for the TV. Re-read from .env on every call, so the host can add it without a restart.
function wifiInfo() {
  let env = {};
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(WIFI_[A-Z]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* no .env */ }
  const name = env.WIFI_NAME || process.env.WIFI_NAME || '';
  const pw = env.WIFI_PASSWORD != null ? env.WIFI_PASSWORD : (process.env.WIFI_PASSWORD || '');
  if (!name) return null;
  const e = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');
  const sec = pw ? (env.WIFI_SECURITY || process.env.WIFI_SECURITY || 'WPA') : 'nopass';
  return { name, qr: `WIFI:T:${sec};S:${e(name)};${pw ? `P:${e(pw)};` : ''};` };
}

function lanIp() {
  const c = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) c.push(i.address);
  }
  return c.find((a) => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a)) || c[0] || 'localhost';
}

// Requests through a tunnel (ngrok) also arrive from 127.0.0.1, but carry forwarding headers: those are guests, not the host.
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
  && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'] && !req.headers['ngrok-trace-id'];
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const baseUrl = (ip) => PUBLIC_URL || `http://${ip}:${PORT}`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'GET') {
      if (p === '/') return sendFile(res, path.join(PUB, 'booth.html'));
      if (p === '/tv') return sendFile(res, path.join(PUB, 'tv.html'));
      if (p === '/album') return sendFile(res, path.join(PUB, 'album.html'));
      if (p === '/roam') return sendFile(res, path.join(PUB, 'roam.html'));
      if (p === '/vote') return sendFile(res, path.join(PUB, 'vote.html'));
      if (p === '/print') return sendFile(res, path.join(PUB, 'print.html'));
      if (p === '/qrcode.js') return sendFile(res, path.join(PUB, 'qrcode.js'));
      if (p === '/bg.jpg') return sendFile(res, BACKGROUND, { 'Cache-Control': 'no-cache' });
      if (p === '/api/scene') {
        const list = [];
        for (const kind of ['monster', 'costume']) {
          (scenes[kind] || []).forEach((x, i) => x && list.push({ kind, url: `/photos/${x.file}`, part: i + 1, parts: scenes[kind].length, count: x.count, createdAt: x.createdAt }));
        }
        return sendJson(res, 200, { scenes: list });
      }
      if (p === '/api/awards') {
        const a = await getAwards();
        return sendJson(res, 200, Object.assign({ open: voteOpen() }, a));
      }
      if (p === '/api/votes') {
        const voter = url.searchParams.get('voter') || '';
        return sendJson(res, 200, { open: voteOpen(), closesAt: CLOSE_AT, limit: VOTE_LIMIT, mine: votes[voter] || [] });
      }
      if (p === '/manifest.json') {
        return sendJson(res, 200, {
          name: 'Haunt Roam', short_name: 'Haunt', start_url: '/roam', scope: '/', display: 'standalone',
          orientation: 'portrait', background_color: '#0a0612', theme_color: '#0a0612', icons: [],
        });
      }

      if (p === '/api/info') {
        const ip = lanIp();
        const wifi = wifiInfo();
        return sendJson(res, 200, {
          boothUrl: `${baseUrl(ip)}/`,
          albumUrl: `${baseUrl(ip)}/album`,
          demo: DEMO,
          partyTitle: PARTY_TITLE,
          partySub: PARTY_SUB,
          voteUrl: `${baseUrl(ip)}/vote`,
          voteOpen: voteOpen(),
          closesAt: CLOSE_AT,
          isLocal: isLocal(req),
          // The Wi-Fi password only goes to the TV on this Mac (it's printed in the QR code there anyway).
          wifi: wifi ? (isLocal(req) ? wifi : { name: wifi.name }) : null,
        });
      }
      if (p === '/api/photos') {
        const list = [...records.values()].filter((r) => !r.hidden)
          .sort((a, b) => a.createdAt - b.createdAt).map(pub);
        return sendJson(res, 200, list);
      }
      if (p.startsWith('/api/photo/')) {
        const r = records.get(path.basename(p));
        return r && !r.hidden ? sendJson(res, 200, pub(r)) : sendJson(res, 404, { error: 'not found' });
      }
      if (p.startsWith('/photos/')) {
        const f = path.basename(p);
        if (!/\.(jpg|png)$/.test(f)) { res.writeHead(404); return res.end(); }
        return sendFile(res, path.join(ALBUM, f), { 'Cache-Control': 'public, max-age=31536000, immutable' });
      }
    }

    if (req.method === 'POST' && p === '/api/upload') {
      const buf = await readBody(req, 15 * 1024 * 1024);
      if (buf.length < 1000 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
        return sendJson(res, 415, { error: 'send a JPEG' });
      }
      const name = (url.searchParams.get('name') || '').replace(/[^\p{L}\p{N} '\-.]/gu, '').trim().slice(0, 24);
      const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      const monster = nextMonster().key;
      const style = nextStyle().key;
      const setting = nextSetting();
      fs.writeFileSync(path.join(ALBUM, id + '.orig.jpg'), buf);
      const r = { id, createdAt: Date.now(), status: 'pending', name, monster, style, setting };
      if (isVip(name)) r.vip = true;
      else { const h = guestHint(name); if (h) r.hint = h; }
      records.set(id, r);
      save(r);
      console.log(`[${id}] upload from ${name || 'guest'} (${Math.round(buf.length / 1024)} KB) -> ` +
        (r.vip ? 'VIP easter egg: most beautiful person in the room' : `${monster}, ${style} style, ${setting}` + (r.hint ? ` | hint: ${r.hint}` : '')));
      enqueue(() => processRecord(r, buf));
      return sendJson(res, 200, { id });
    }

    if (req.method === 'POST' && p === '/api/vote') {
      let body;
      try { body = JSON.parse((await readBody(req, 2048)).toString('utf8') || '{}'); } catch (e) {
        if (e.status) throw e;
        return sendJson(res, 400, { error: 'bad request' });
      }
      const voter = String(body.voter || ''), id = String(body.id || '');
      if (!/^[a-z0-9]{8,40}$/i.test(voter)) return sendJson(res, 400, { error: 'bad voter id' });
      if (!voteOpen()) return sendJson(res, 403, { error: 'Voting is closed. Thanks for playing!', open: false });
      const r = records.get(id);
      if (!r || r.hidden || r.status === 'pending') return sendJson(res, 404, { error: 'not found' });
      if (r.vip && body.on !== false) return sendJson(res, 403, { error: 'The hosts are not competing. Vote for a guest!' });
      const mine = votes[voter] || [];
      const has = mine.includes(id);
      if (body.on === false) {
        if (has) votes[voter] = mine.filter((x) => x !== id);
      } else if (!has) {
        if (mine.length >= VOTE_LIMIT) {
          return sendJson(res, 409, { error: `You've used all ${VOTE_LIMIT} votes. Tap a ❤ to take one back first.`, mine });
        }
        votes[voter] = [...mine, id];
      }
      saveVotes();
      return sendJson(res, 200, { ok: true, mine: votes[voter] || [], left: VOTE_LIMIT - (votes[voter] || []).length });
    }

    if (req.method === 'POST' && p === '/api/votes/close') {
      if (!isLocal(req)) return sendJson(res, 403, { error: 'host only (use localhost)' });
      forceClosed = true;
      console.log('Voting closed by host.');
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p.startsWith('/api/hide/')) {
      if (!isLocal(req)) return sendJson(res, 403, { error: 'host only (use localhost)' });
      const r = records.get(path.basename(p));
      if (!r) return sendJson(res, 404, { error: 'not found' });
      r.hidden = true;
      save(r);
      scheduleScene();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p.startsWith('/api/rename/')) {
      if (!isLocal(req)) return sendJson(res, 403, { error: 'host only (use localhost)' });
      const r = records.get(path.basename(p));
      if (!r) return sendJson(res, 404, { error: 'not found' });
      r.name = (url.searchParams.get('name') || '').replace(/[^\p{L}\p{N} '\-.]/gu, '').trim().slice(0, 24);
      save(r);
      console.log(`[${r.id}] renamed to ${r.name || 'guest'}`);
      return sendJson(res, 200, { ok: true, name: r.name });
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    console.error('request error', e && e.message);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanIp();
  console.log('\n  HAUNT BOOTH is alive\n');
  console.log(`  Guests (phone, same Wi-Fi):  http://${ip}:${PORT}/`);
  console.log(`  Roaming photographer (you):  http://${ip}:${PORT}/roam`);
  console.log(`  Printable signs (QR codes):  http://localhost:${PORT}/print`);
  console.log(`  Crowd vote page (guests):    http://${ip}:${PORT}/vote   (${CLOSE_AT === null ? 'no auto-close' : 'closes ' + new Date(CLOSE_AT).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, ${VOTE_LIMIT} votes each)`);
  console.log(`  TV screen (on this Mac):     http://localhost:${PORT}/tv`);
  console.log(`  Album / host controls:       http://localhost:${PORT}/album`);
  console.log(`  Mode: ${DEMO ? 'DEMO (no OPENAI_API_KEY found - spooky filter only)' : `OpenAI (${IMAGE_MODEL}, quality ${QUALITY})`}\n`);
});
