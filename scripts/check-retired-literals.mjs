#!/usr/bin/env node
/**
 * retired literals: no retired Designesy brand colour ships in this action.
 *
 * WHY THIS EXISTS
 * Designesy identity v1 retired the old signal blue, the old yellows, the old
 * indigo hues and the old grade D orange (brand ledger D44). The action posts
 * a comment, renders a README and bundles its own code, and any of them could
 * carry a retired colour. The owner put the same gate on every Designesy
 * repo and package, from one list (D46).
 *
 * THE LIST
 * Not kept here. retired-literals.lock.json names the canonical file in
 * LE-VAI/designesy-org and the commit to read it at; this script fetches that
 * file and nothing else. Only data crosses the repo boundary: the patterns
 * are built here, and the list's own self-test vectors prove they mean what
 * the upstream gates mean before anything is scanned.
 *
 * WHAT IT READS
 * src/, action.yml, README.md and dist/ (the committed bundle is what runs).
 * Not dist/*.map: a source map is one line holding a copy of src/ and of the
 * bundled dependencies, both of which are read already (src/ directly, the
 * dependencies inside dist/index.js), so it adds no coverage, only a second,
 * unreadable report of the same line.
 *
 * THE ALLOWLIST
 * Explicit, per file and per line, each with its reason. An entry that no
 * longer matches fails the gate. It is empty.
 *
 * Usage:  node scripts/check-retired-literals.mjs [--json] [--list <file>]
 *         node scripts/check-retired-literals.mjs --upstream
 * --list reads a local copy of the list instead of fetching (offline use).
 * --upstream compares the pinned list with the upstream default branch.
 * Exits 1 on a finding, a stale allowlist entry, a failed self-test or proof,
 * or a list that cannot be fetched (it never passes on a failed fetch).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = JSON.parse(fs.readFileSync(path.join(ROOT, 'retired-literals.lock.json'), 'utf8'));

const SCAN = ['src', 'action.yml', 'README.md', 'dist'];
const SKIP = (rel) => rel.endsWith('.map');

/** Lines allowed to carry a retired literal: { file, includes, reason }. */
const ALLOWLIST = [];

const rawUrl = (ref) => `https://raw.githubusercontent.com/${LOCK.repo}/${ref}/${LOCK.path}`;

async function fetchText(url) {
  const res = await fetch(url);
  // Always drain the body: an unread response keeps a socket open.
  const text = await res.text();
  return { status: res.status, text: res.status === 200 ? text : null };
}

function parseList(text, where) {
  const list = JSON.parse(text);
  if (list.schema !== 1) throw new Error(`${where}: unknown schema ${list.schema}`);
  if (!Array.isArray(list.hex) || !list.hex.length) throw new Error(`${where}: hex list is empty`);
  for (const h of list.hex) if (!/^[0-9a-f]{6}$/.test(h.hex)) throw new Error(`${where}: bad hex ${JSON.stringify(h)}`);
  for (const r of list.rgb || []) {
    if (!Array.isArray(r.rgb) || r.rgb.length !== 3 || !r.rgb.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)) {
      throw new Error(`${where}: bad rgb ${JSON.stringify(r)}`);
    }
  }
  if (!list.selfTest?.mustMatch?.length || !list.selfTest?.mustNotMatch?.length) {
    throw new Error(`${where}: selfTest vectors missing`);
  }
  return list;
}

function buildPatterns(list) {
  const pats = list.hex.map(({ hex, why }) => ({
    label: `#${hex}`,
    why,
    // #rrggbb or #rrggbbaa, and not the first six digits of a longer hex.
    re: new RegExp(`#${hex}(?:[0-9a-f]{2})?(?![0-9a-f])`, 'gi'),
  }));
  for (const { label, rgb: [r, g, b], why } of list.rgb || []) {
    // rgb(1,51,203) rgba(1, 51, 203, .2) rgb(1 51 203 / .4)
    pats.push({ label, why, re: new RegExp(`rgba?\\(\\s*${r}\\s*[,\\s]\\s*${g}\\s*[,\\s]\\s*${b}(?![0-9])`, 'gi') });
  }
  return pats;
}

function selfTest(patterns, list) {
  const test = (p, s) => { p.re.lastIndex = 0; return p.re.test(s); };
  const hit = (s) => patterns.some((p) => test(p, s));
  const { mustMatch, mustNotMatch } = list.selfTest;
  const missed = mustMatch.filter((s) => !hit(s));
  const falsePos = mustNotMatch.filter((s) => hit(s));
  const unproved = patterns.filter((p) => !mustMatch.some((s) => test(p, s))).map((p) => p.label);
  console.log(`retired-literals self-test: ${mustMatch.length - missed.length}/${mustMatch.length} caught, ${falsePos.length} false positives`);
  if (missed.length) console.log('  missed: ' + missed.join(', '));
  if (falsePos.length) console.log('  false positives: ' + falsePos.join(', '));
  if (unproved.length) console.log('  patterns no mustMatch vector exercises: ' + unproved.join(', '));
  return !missed.length && !falsePos.length && !unproved.length;
}

function scanText(file, text, patterns) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const p of patterns) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(line))) out.push({ file, line: i + 1, literal: m[0], retired: p.label, why: p.why, text: line.trim().slice(0, 160) });
    }
  });
  return out;
}

function classify(findings) {
  const used = new Set();
  const blocked = [];
  const allowed = [];
  for (const f of findings) {
    const idx = ALLOWLIST.findIndex((a) => a.file === f.file && f.text.includes(a.includes));
    if (idx === -1) blocked.push(f);
    else { used.add(idx); allowed.push({ ...f, reason: ALLOWLIST[idx].reason }); }
  }
  return { blocked, allowed, stale: ALLOWLIST.filter((_, i) => !used.has(i)) };
}

function walk(abs, out) {
  const st = fs.statSync(abs);
  if (!st.isDirectory()) { out.push(abs); return out; }
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    walk(path.join(abs, e.name), out);
  }
  return out;
}

async function upstream() {
  const pinned = await fetchText(rawUrl(LOCK.commit));
  if (pinned.status !== 200) {
    console.log(`retired-literals upstream: FAIL - the pinned list ${rawUrl(LOCK.commit)} returned HTTP ${pinned.status}`);
    return false;
  }
  const head = await fetchText(rawUrl(LOCK.defaultBranch));
  if (head.status === 404) {
    if (LOCK.pendingUpstreamMerge) {
      console.log(`::warning::retired-literals upstream: ${LOCK.path} is not on ${LOCK.repo}@${LOCK.defaultBranch} yet; the pin is an open pull request's head (pendingUpstreamMerge). Move the pin to the merge commit once it merges.`);
      return true;
    }
    console.log(`retired-literals upstream: FAIL - ${LOCK.path} is gone from ${LOCK.repo}@${LOCK.defaultBranch}; the canonical list moved or was removed. Find it and update retired-literals.lock.json.`);
    return false;
  }
  if (head.status !== 200) {
    console.log(`retired-literals upstream: FAIL - ${rawUrl(LOCK.defaultBranch)} returned HTTP ${head.status}`);
    return false;
  }
  if (LOCK.pendingUpstreamMerge) {
    console.log(`retired-literals upstream: FAIL - the list is on ${LOCK.defaultBranch} now, so the upstream pull request merged. Set "commit" in retired-literals.lock.json to the merge commit and remove "pendingUpstreamMerge".`);
    return false;
  }
  const same = JSON.stringify(JSON.parse(pinned.text)) === JSON.stringify(JSON.parse(head.text));
  if (!same) {
    console.log(`retired-literals upstream: FAIL - the list at ${LOCK.repo}@${LOCK.defaultBranch} differs from the pinned commit ${LOCK.commit.slice(0, 12)}. Move "commit" in retired-literals.lock.json to the upstream commit that changed it.`);
    return false;
  }
  console.log(`retired-literals upstream: the pinned list equals ${LOCK.repo}@${LOCK.defaultBranch}`);
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--upstream')) return (await upstream()) ? 0 : 1;
  const asJson = args.includes('--json');
  const listIdx = args.indexOf('--list');

  let text;
  let source;
  if (listIdx !== -1) {
    source = path.resolve(args[listIdx + 1]);
    text = fs.readFileSync(source, 'utf8');
  } else {
    source = rawUrl(LOCK.commit);
    const got = await fetchText(source);
    if (got.status !== 200) {
      console.log(`retired-literals: FAIL - could not fetch the list (${source} returned HTTP ${got.status}); the gate does not pass unread`);
      return 1;
    }
    text = got.text;
  }
  const list = parseList(text, source);
  const patterns = buildPatterns(list);
  if (!selfTest(patterns, list)) return 1;

  const findings = [];
  const proofFailures = [];
  let filesRead = 0;
  for (const entry of SCAN) {
    const abs = path.join(ROOT, entry);
    if (!fs.existsSync(abs)) { proofFailures.push(`${entry}: listed to be read but missing`); continue; }
    let probe = null;
    for (const f of walk(abs, [])) {
      const rel = path.relative(ROOT, f).split(path.sep).join('/');
      if (SKIP(rel)) continue;
      const buf = fs.readFileSync(f);
      if (buf.includes(0)) continue;
      const body = buf.toString('utf8');
      filesRead++;
      if (!probe) probe = { rel, body };
      findings.push(...scanText(rel, body, patterns));
    }
    // The proof: a retired literal added to a file read here must be blocked.
    if (!probe) proofFailures.push(`${entry}: no text file read`);
    else {
      const injected = scanText(probe.rel, `${probe.body}\n/* injected by the proof */ #${list.hex[0].hex.toUpperCase()}`, patterns);
      if (!classify(injected).blocked.some((f) => f.text.startsWith('/* injected by the proof */'))) {
        proofFailures.push(`${entry}: a literal injected into ${probe.rel} was not blocked`);
      }
    }
  }

  const { blocked, allowed, stale } = classify(findings);
  const ok = !blocked.length && !stale.length && !proofFailures.length;
  if (asJson) {
    console.log(JSON.stringify({ ok, list: source, filesRead, blocked, allowed, stale, proofFailures }, null, 2));
    return ok ? 0 : 1;
  }
  const counts = Object.fromEntries(patterns.map((p) => [p.label, 0]));
  for (const f of blocked) counts[f.retired]++;
  console.log(`retired-literals: list ${listIdx === -1 ? `${LOCK.repo}@${LOCK.commit.slice(0, 12)}` : source}, ${filesRead} files read (${SCAN.join(', ')}; not dist/*.map), ${blocked.length} blocked, ${allowed.length} allowlisted, ${stale.length} stale allowlist entries`);
  for (const p of patterns) console.log(`  ${p.label.padEnd(14)} ${counts[p.label]}`);
  console.log(`  proof: ${SCAN.length - proofFailures.length}/${SCAN.length} read paths block an injected literal`);
  for (const f of blocked) console.log(`  BLOCKED ${f.file}:${f.line}  ${f.literal}  (${f.why})`);
  for (const f of allowed) console.log(`  allowed ${f.file}:${f.line}  ${f.literal}`);
  for (const a of stale) console.log(`  STALE allowlist entry: ${a.file} "${a.includes}"`);
  for (const r of proofFailures) console.log(`  PROOF FAILED ${r}`);
  return ok ? 0 : 1;
}

// exitCode, not process.exit(): exiting while fetch's sockets are closing
// aborts Node on Windows (a libuv assertion) with a misleading status.
main().then(
  (code) => { process.exitCode = code; },
  (e) => {
    console.log(`retired-literals: FAIL - ${e.message}`);
    process.exitCode = 1;
  },
);
