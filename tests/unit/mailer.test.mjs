// Phase 4c2 (BookStack-Exit, docs/bookstack-exit.md): Mailer + Templates.
// Mailer ist Gmail-only (App-Password via nodemailer service:'gmail').

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpDb = path.join(os.tmpdir(), `mailer-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-for-crypto';

await import('../../db/migrations.js');
const { db } = await import('../../db/connection.js');
const appSettings = (await import('../../lib/app-settings.js')).default ?? (await import('../../lib/app-settings.js'));
const { renderTemplate, listTemplates, _esc } = await import('../../lib/mailer-templates.js');
const mailer = (await import('../../lib/mailer.js')).default ?? (await import('../../lib/mailer.js'));

const SMTP_KEYS = [
  'smtp.gmail.user',
  'smtp.gmail.app_password',
  'smtp.from_name',
  'smtp.reply_to',
  'smtp.rate_limit_per_minute',
];

function clearSmtp() {
  for (const k of SMTP_KEYS) appSettings.remove(k, { updatedBy: 'test' });
  mailer._setTestTransportFactory(null);
}

test.after(() => {
  try { db.close(); } catch {}
  try { fs.unlinkSync(tmpDb); } catch {}
  try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
  try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
});

test('listTemplates: invite + test sind enthalten', () => {
  const names = listTemplates();
  assert.ok(names.includes('invite'));
  assert.ok(names.includes('test'));
});

test('renderTemplate: invite (de) erzeugt subject + html + text mit URL', () => {
  const r = renderTemplate('invite', {
    inviterName: 'Alice',
    inviteUrl: 'https://app.example.com/login?invite=abc',
    expiresAt: '2026-06-01',
    role: 'user',
  }, 'de');
  assert.match(r.subject, /Einladung/);
  assert.match(r.html, /Alice/);
  assert.match(r.html, /https:\/\/app\.example\.com\/login\?invite=abc/);
  assert.match(r.text, /Alice/);
  assert.match(r.text, /2026-06-01/);
});

test('renderTemplate: invite (en) wechselt Locale', () => {
  const r = renderTemplate('invite', { inviterName: 'Bob', inviteUrl: 'https://x/y' }, 'en');
  assert.match(r.subject, /Invitation/);
  assert.match(r.html, /Bob/);
});

test('renderTemplate: HTML-Escape verhindert Injection', () => {
  const r = renderTemplate('invite', {
    inviterName: '<script>alert(1)</script>',
    inviteUrl: 'https://x/y',
  }, 'de');
  assert.doesNotMatch(r.html, /<script>alert/);
  assert.match(r.html, /&lt;script&gt;/);
});

test('_esc: maskiert HTML-Sonderzeichen', () => {
  assert.equal(_esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
});

test('renderTemplate: unbekanntes Template wirft', () => {
  assert.throws(() => renderTemplate('does-not-exist', {}, 'de'), /unknown template/);
});

test('mailer.getStatus: ohne Config → mode=disabled, ready=false, missing listet user+app_password', () => {
  clearSmtp();
  const s = mailer.getStatus();
  assert.equal(s.mode, 'disabled');
  assert.equal(s.ready, false);
  assert.ok(s.missing.includes('smtp.gmail.user'));
  assert.ok(s.missing.includes('smtp.gmail.app_password'));
});

test('mailer.getStatus: nur user gesetzt → mode=disabled, missing=[app_password]', () => {
  clearSmtp();
  appSettings.set('smtp.gmail.user', 'sender@gmail.com', { updatedBy: 'test' });
  const s = mailer.getStatus();
  assert.equal(s.mode, 'disabled');
  assert.equal(s.ready, false);
  assert.deepEqual(s.missing, ['smtp.gmail.app_password']);
});

test('mailer.getStatus: vollständige Config → mode=gmail, ready=true, fromEmail=user', () => {
  clearSmtp();
  appSettings.set('smtp.gmail.user', 'sender@gmail.com', { updatedBy: 'test' });
  appSettings.set('smtp.gmail.app_password', 'abcd efgh ijkl mnop', { updatedBy: 'test' });
  const s = mailer.getStatus();
  assert.equal(s.mode, 'gmail');
  assert.equal(s.ready, true);
  assert.equal(s.fromEmail, 'sender@gmail.com');
  assert.deepEqual(s.missing, []);
});

test('mailer.send: ohne Config → sent=false reason=incomplete-config + missing-Array', async () => {
  clearSmtp();
  const r = await mailer.send({ to: 'x@y.com', template: 'test', ctx: {}, locale: 'de' });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'incomplete-config');
  assert.ok(Array.isArray(r.missing));
  assert.ok(r.missing.length > 0);
});

test('mailer.send: nur user gesetzt → sent=false reason=incomplete-config', async () => {
  clearSmtp();
  appSettings.set('smtp.gmail.user', 'sender@gmail.com', { updatedBy: 'test' });
  const r = await mailer.send({ to: 'x@y.com', template: 'test', ctx: {}, locale: 'de' });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'incomplete-config');
  assert.deepEqual(r.missing, ['smtp.gmail.app_password']);
});

test('mailer.send: end-to-end via jsonTransport-Stub', async () => {
  clearSmtp();
  appSettings.set('smtp.gmail.user', 'sender@gmail.com', { updatedBy: 'test' });
  appSettings.set('smtp.gmail.app_password', 'abcd efgh ijkl mnop', { updatedBy: 'test' });
  appSettings.set('smtp.from_name', 'Schreibwerkstatt', { updatedBy: 'test' });

  const nodemailer = (await import('nodemailer')).default ?? (await import('nodemailer'));
  mailer._setTestTransportFactory(() => nodemailer.createTransport({ jsonTransport: true }));

  const r = await mailer.send({
    to: 'recipient@example.com',
    template: 'invite',
    ctx: { inviterName: 'Alice', inviteUrl: 'https://app/login?invite=t1' },
    locale: 'de',
  });
  assert.equal(r.sent, true);
  assert.ok(r.info);
  const msg = JSON.parse(r.info.message);
  assert.equal(msg.to[0].address, 'recipient@example.com');
  assert.equal(msg.from.address, 'sender@gmail.com');
  assert.equal(msg.from.name, 'Schreibwerkstatt');
  assert.match(msg.subject, /Einladung/);
  assert.match(msg.html, /Alice/);
});

test('mailer: Settings-Change-Event invalidiert Transporter-Cache', () => {
  clearSmtp();
  appSettings.set('smtp.gmail.user', 'sender@gmail.com', { updatedBy: 'test' });
  appSettings.set('smtp.gmail.app_password', 'abcd efgh ijkl mnop', { updatedBy: 'test' });
  const t1 = mailer.getTransporter();
  assert.ok(t1, 'Transporter sollte mit vollständiger Config gebaut werden');

  appSettings.remove('smtp.gmail.app_password', { updatedBy: 'test' });
  const t2 = mailer.getTransporter();
  assert.equal(t2, null, 'Transporter sollte nach Entfernen des App-Passworts null sein');
});
