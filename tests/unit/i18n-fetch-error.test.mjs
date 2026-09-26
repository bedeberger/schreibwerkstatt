// tFetchErrorRaw (i18n.js): Fehlertext für einen geworfenen fetchJson-Fehler.
// Übersetzter error_code › roher Code (keine Übersetzung vorhanden) › Message.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { tFetchErrorRaw } = await import('../../public/js/i18n.js');

test('ohne Übersetzung: roher error_code statt „error.CODE"-Key', () => {
  const err = Object.assign(new Error('HTTP 400'), { status: 400, code: 'SOME_UNTRANSLATED_CODE', body: { error_code: 'SOME_UNTRANSLATED_CODE' } });
  assert.equal(tFetchErrorRaw(err), 'SOME_UNTRANSLATED_CODE');
});

test('ohne Code: die Error-Message (Netzfehler, HTTP-Status)', () => {
  assert.equal(tFetchErrorRaw(Object.assign(new Error('HTTP 502'), { status: 502, code: null })), 'HTTP 502');
  assert.equal(tFetchErrorRaw(new TypeError('Failed to fetch')), 'Failed to fetch');
});

test('ohne Fehlerobjekt: kein Crash', () => {
  assert.equal(typeof tFetchErrorRaw(null), 'string');
});
