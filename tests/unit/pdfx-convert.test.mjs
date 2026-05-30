import test from 'node:test';
import assert from 'node:assert';

// pdfx-convert liest ENV beim Call (nicht beim Require), darum koennen wir
// GS_DISABLED / GS_BIN / PDFX_ICC_PATH pro Test setzen.
const { convertToPdfX } = await import('../../lib/pdfx-convert.js');

const DUMMY = Buffer.from('%PDF-1.4\n%dummy\n');

test('GS_DISABLED → non-fatal, available:false (disabled)', async () => {
  const prev = process.env.GS_DISABLED;
  process.env.GS_DISABLED = 'true';
  try {
    const r = await convertToPdfX(DUMMY);
    assert.equal(r.available, false);
    assert.equal(r.reason, 'disabled');
  } finally {
    if (prev === undefined) delete process.env.GS_DISABLED; else process.env.GS_DISABLED = prev;
  }
});

test('fehlendes ICC → non-fatal, available:false (icc-missing)', async () => {
  const prevDis = process.env.GS_DISABLED;
  const prevIcc = process.env.PDFX_ICC_PATH;
  delete process.env.GS_DISABLED;
  process.env.PDFX_ICC_PATH = '/nonexistent/path/does-not-exist.icc';
  try {
    const r = await convertToPdfX(DUMMY);
    assert.equal(r.available, false);
    assert.equal(r.reason, 'icc-missing');
  } finally {
    if (prevDis === undefined) delete process.env.GS_DISABLED; else process.env.GS_DISABLED = prevDis;
    if (prevIcc === undefined) delete process.env.PDFX_ICC_PATH; else process.env.PDFX_ICC_PATH = prevIcc;
  }
});

test('fehlendes gs-Binary → non-fatal, available:false (binary-missing)', async () => {
  // ICC muss existieren, damit der Pfad bis zum Binary-Aufruf kommt — nutze
  // diese Testdatei selbst als vorhandenes "ICC".
  const prevDis = process.env.GS_DISABLED;
  const prevIcc = process.env.PDFX_ICC_PATH;
  const prevBin = process.env.GS_BIN;
  delete process.env.GS_DISABLED;
  process.env.PDFX_ICC_PATH = new URL(import.meta.url).pathname;
  process.env.GS_BIN = '/nonexistent/gs-binary-xyz';
  try {
    const r = await convertToPdfX(DUMMY);
    assert.equal(r.available, false);
    assert.equal(r.reason, 'binary-missing');
  } finally {
    if (prevDis === undefined) delete process.env.GS_DISABLED; else process.env.GS_DISABLED = prevDis;
    if (prevIcc === undefined) delete process.env.PDFX_ICC_PATH; else process.env.PDFX_ICC_PATH = prevIcc;
    if (prevBin === undefined) delete process.env.GS_BIN; else process.env.GS_BIN = prevBin;
  }
});
