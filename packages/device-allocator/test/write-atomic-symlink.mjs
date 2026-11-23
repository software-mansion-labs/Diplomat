// A write through a symlink lands on the file it points at and leaves the link.
//
// Regression: ~/.claude/CLAUDE.md linked into a dotfiles repo. A changed managed block
// read as drift, and the reinstall's temp-and-rename replaced the link with a regular
// file, so the user's global rules and their dotfiles stopped seeing each other's edits.
// Run: node test/write-atomic-symlink.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { sweepDeadTmp, writeAtomic } from '../../daemon-core/src/fsio.js';
import { killDaemonsUnder, onInterrupt } from './lib/interrupt.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_JS = path.join(__dirname, '..', 'src', 'install.js');

// Short: the daemon --install starts puts its socket under BASE, and sun_path caps at 104 bytes.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'da-link-'));
const BASE = path.join(ROOT, 'b');
onInterrupt(() => { killDaemonsUnder(BASE); fs.rmSync(ROOT, { recursive: true, force: true }); });

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  PASS', name); passed++; };

function tmpFiles(dir) {
  return fs.readdirSync(dir, { recursive: true }).filter((f) => /\.tmp\.\d+$/.test(f));
}

// `link` is still the same link, and `target` holds `text`.
function linked(name, link, to, target, text) {
  ok(`${name}: still a symlink`, fs.lstatSync(link).isSymbolicLink());
  ok(`${name}: pointing where it did`, fs.readlinkSync(link) === to);
  ok(`${name}: the target holds the new bytes`, fs.readFileSync(target, 'utf8') === text);
}

try {
  console.log('writeAtomic through a symlink');
  const home = path.join(ROOT, 'home');
  const dot = path.join(ROOT, 'dotfiles');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(dot, 'claude'), { recursive: true });
  const link = (name, to) => { fs.symlinkSync(to, path.join(home, name)); return path.join(home, name); };

  fs.writeFileSync(path.join(dot, 'abs.md'), 'old\n');
  writeAtomic(link('abs.md', path.join(dot, 'abs.md')), 'absolute\n');
  linked('an absolute link', path.join(home, 'abs.md'), path.join(dot, 'abs.md'), path.join(dot, 'abs.md'), 'absolute\n');

  fs.writeFileSync(path.join(dot, 'rel.md'), 'old\n');
  writeAtomic(link('rel.md', '../dotfiles/rel.md'), 'relative\n');
  linked('a relative link', path.join(home, 'rel.md'), '../dotfiles/rel.md', path.join(dot, 'rel.md'), 'relative\n');

  fs.writeFileSync(path.join(dot, 'chain.md'), 'old\n');
  link('hop.md', '../dotfiles/chain.md');
  writeAtomic(link('chain.md', 'hop.md'), 'chain\n');
  linked('a chain of links', path.join(home, 'chain.md'), 'hop.md', path.join(dot, 'chain.md'), 'chain\n');
  ok('a chain of links: the middle link is left too', fs.lstatSync(path.join(home, 'hop.md')).isSymbolicLink());

  // ~/.claude itself linked into dotfiles/claude, and a link inside it climbing out
  // with `..`: from the real directory that is dotfiles/, never home/.
  link('.claude', '../dotfiles/claude');
  fs.symlinkSync('../up.md', path.join(dot, 'claude', 'up.md'));
  fs.writeFileSync(path.join(dot, 'up.md'), 'old\n');
  writeAtomic(path.join(home, '.claude', 'up.md'), 'up\n');
  linked('a relative link in a symlinked directory', path.join(dot, 'claude', 'up.md'), '../up.md', path.join(dot, 'up.md'), 'up\n');
  ok('a relative link in a symlinked directory: nothing is written beside the directory link', !fs.existsSync(path.join(home, 'up.md')));

  writeAtomic(link('dangling.md', '../dotfiles/new/dangling.md'), 'dangling\n');
  linked('a dangling link', path.join(home, 'dangling.md'), '../dotfiles/new/dangling.md', path.join(dot, 'new', 'dangling.md'), 'dangling\n');

  writeAtomic(path.join(home, 'plain.md'), 'plain\n');
  ok('a path that is no link is written as a regular file',
    fs.lstatSync(path.join(home, 'plain.md')).isFile() && fs.readFileSync(path.join(home, 'plain.md'), 'utf8') === 'plain\n');

  link('loop-a', 'loop-b');
  link('loop-b', 'loop-a');
  assert.throws(() => writeAtomic(path.join(home, 'loop-a'), 'loop\n'), { code: 'ELOOP' });
  ok('a cycle of links throws ELOOP and replaces neither link',
    fs.lstatSync(path.join(home, 'loop-a')).isSymbolicLink() && fs.lstatSync(path.join(home, 'loop-b')).isSymbolicLink());

  ok('no tmp file is left in either tree', tmpFiles(ROOT).length === 0);

  const deadPid = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  const deadTmp = path.join(dot, `abs.md.tmp.${deadPid}`);
  fs.writeFileSync(deadTmp, '{');
  sweepDeadTmp(path.join(home, 'abs.md'));
  ok('sweepDeadTmp on a link reaps a dead writer\'s tmp beside the target', !fs.existsSync(deadTmp));

  console.log('install through a symlinked ~/.claude/CLAUDE.md and ~/.claude.json');
  const iHome = path.join(ROOT, 'ihome');
  const iDot = path.join(ROOT, 'idot');
  const claudeMd = path.join(iHome, '.claude', 'CLAUDE.md');
  const claudeJson = path.join(iHome, '.claude.json');
  const mine = '# Mine\n\nKeep this.\n';
  fs.mkdirSync(path.join(iHome, '.claude'), { recursive: true });
  fs.mkdirSync(iDot);
  fs.writeFileSync(path.join(iDot, 'CLAUDE.md'), mine);
  fs.writeFileSync(path.join(iDot, 'claude.json'), JSON.stringify({ theme: 'dark' }));
  fs.symlinkSync('../../idot/CLAUDE.md', claudeMd);
  fs.symlinkSync('../idot/claude.json', claudeJson);
  const fake = path.join(ROOT, 'fake.json');
  fs.writeFileSync(fake, '[]');
  const run = (arg) => JSON.parse(execFileSync(process.execPath, [INSTALL_JS, arg], {
    encoding: 'utf8',
    env: { ...process.env, HOME: iHome, DA_BASE_DIR: BASE, DA_FAKE_DEVICES: fake },
  }));
  const bothLinked = () => fs.lstatSync(claudeMd).isSymbolicLink() && fs.lstatSync(claudeJson).isSymbolicLink();
  const BEGIN = '<!-- diplomat-device-allocator';
  const END = '<!-- end diplomat-device-allocator -->';

  ok('--install installs', run('--install').installed === true);
  ok('--install leaves both links', bothLinked());
  const md = fs.readFileSync(path.join(iDot, 'CLAUDE.md'), 'utf8');
  ok('the block lands in the dotfiles CLAUDE.md, after the user\'s text', md.startsWith(`${mine}\n${BEGIN}`));
  const j = JSON.parse(fs.readFileSync(path.join(iDot, 'claude.json'), 'utf8'));
  ok('the registration lands in the dotfiles claude.json', !!j.mcpServers['diplomat-device-allocator'] && j.theme === 'dark');

  // The incident: an older block reads as drift, and the reinstall rewrites the file.
  const begin = md.indexOf(BEGIN);
  const beginLine = md.slice(begin, md.indexOf('\n', begin));
  fs.writeFileSync(path.join(iDot, 'CLAUDE.md'), `${md.slice(0, begin)}${beginLine}\nolder wording\n${md.slice(md.indexOf(END))}`);
  assert.deepEqual(run('--check').drift, ['claudeMd']);
  ok('a reinstall over a stale block clears the drift', run('--install').drift.length === 0);
  ok('and leaves both links', bothLinked());
  ok('with the current block in the dotfiles CLAUDE.md', fs.readFileSync(path.join(iDot, 'CLAUDE.md'), 'utf8') === md);

  ok('--uninstall uninstalls', run('--uninstall').installed === false);
  ok('--uninstall leaves both links', bothLinked());
  ok('and the dotfiles CLAUDE.md holds only the user\'s text again', fs.readFileSync(path.join(iDot, 'CLAUDE.md'), 'utf8') === mine);
  ok('no tmp file is left beside the links or their targets', tmpFiles(iHome).length + tmpFiles(iDot).length === 0);

  console.log(`\nwrite-atomic-symlink: ${passed} checks passed`);
} finally {
  killDaemonsUnder(BASE);
  fs.rmSync(ROOT, { recursive: true, force: true });
}
