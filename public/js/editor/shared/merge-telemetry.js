// Block-Level-Merge-Telemetrie: fire-and-forget Counter-Meldung an /telemetry/merge.
// Best-effort — Fehler werden geschluckt (Telemetrie darf den Save-Pfad nie blocken).
// Server-Gegenstück: routes/telemetry.js, persistiert in merge_telemetry, /metrics.

export function trackMerge(event, extra = null) {
  try {
    const body = extra ? { event, ...extra } : { event };
    fetch('/telemetry/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  } catch { /* ignore */ }
}
