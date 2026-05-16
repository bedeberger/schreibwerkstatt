// Phase 4c2 (BookStack-Exit, docs/bookstack-exit.md): Mailer + Templates.

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

test('mailer.getStatus: disabled-Default → mode=disabled, ready=false', () => {
  const s = mailer.getStatus();
  assert.equal(s.mode, 'disabled');
  assert.equal(s.ready, false);
});

test('mailer.getStatus: incomplete gmail-oauth → missing-keys werden gelistet', () => {
  appSettings.set('smtp.mode', 'gmail-oauth', { updatedBy: 'test' });
  appSettings.set('smtp.from_email', 'sender@example.com', { updatedBy: 'test' });
  // client_id/secret/refresh_token/user fehlen
  const s = mailer.getStatus();
  assert.equal(s.mode, 'gmail-oauth');
  assert.equal(s.ready, false);
  assert.ok(s.missing.includes('smtp.gmail.client_id'));
  assert.ok(s.missing.includes('smtp.gmail.refresh_token'));
});

test('mailer.send: disabled → sent=false reason=disabled', async () => {
  appSettings.set('smtp.mode', 'disabled', { updatedBy: 'test' });
  const r = await mailer.send({ to: 'x@y.com', template: 'test', ctx: {}, locale: 'de' });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'disabled');
});

test('mailer.send: incomplete config → sent=false reason=incomplete-config', async () => {
  appSettings.set('smtp.mode', 'gmail-oauth', { updatedBy: 'test' });
  appSettings.remove('smtp.from_email');
  const r = await mailer.send({ to: 'x@y.com', template: 'test', ctx: {}, locale: 'de' });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'incomplete-config');
  assert.ok(Array.isArray(r.missing));
});

test('mailer.send: end-to-end via jsonTransport-Stub', async () => {
  appSettings.set('smtp.mode', 'generic', { updatedBy: 'test' });
  appSettings.set('smtp.from_email', 'sender@example.com', { updatedBy: 'test' });
  appSettings.set('smtp.from_name', 'Schreibwerkstatt', { updatedBy: 'test' });
  appSettings.set('smtp.host', 'mock', { updatedBy: 'test' });
  appSettings.set('smtp.user', 'mockuser', { updatedBy: 'test' });
  appSettings.set('smtp.password', 'mockpass', { updatedBy: 'test' });

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
  // jsonTransport-Antwort: info.message ist JSON-string
  const msg = JSON.parse(r.info.message);
  assert.equal(msg.to[0].address, 'recipient@example.com');
  assert.match(msg.subject, /Einladung/);
  assert.match(msg.html, /Alice/);
});

test('mailer: Settings-Change-Event invalidiert Transporter-Cache', () => {
  // Test-Factory zuruecksetzen, damit der echte _buildTransporter laeuft
  mailer._setTestTransportFactory(null);
  // Vor-Setting
  appSettings.set('smtp.mode', 'generic', { updatedBy: 'test' });
  appSettings.set('smtp.from_email', 'sender@example.com', { updatedBy: 'test' });
  appSettings.set('smtp.host', 'mock', { updatedBy: 'test' });
  appSettings.set('smtp.user', 'mockuser', { updatedBy: 'test' });
  appSettings.set('smtp.password', 'mockpass', { updatedBy: 'test' });
  mailer.getTransporter(); // baut Singleton
  // Mode-Wechsel → Cache verworfen
  appSettings.set('smtp.mode', 'disabled', { updatedBy: 'test' });
  const t = mailer.getTransporter();
  assert.equal(t, null, 'Transporter sollte nach mode=disabled null sein');
});
