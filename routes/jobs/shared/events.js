'use strict';
const { EventEmitter } = require('events');

// Prozess-interner Bus für Job-Zustandsänderungen. Einzige Quelle für den
// SSE-Stream (stream.js). Gefeuert ausschliesslich aus dem Job-Lifecycle
// (jobs.js: create/update/complete/fail/cancel, queue.js: enqueue/Start) —
// Job-Module rufen das nie selbst auf, sie gehen über updateJob & Co.
//
// 'change' (job, terminal): der Job hat sich verändert; `terminal` = done/error/
//   cancelled, der Stream flusht dann sofort statt gedrosselt.
// 'shift': die FIFO hat sich bewegt (Job gestartet oder aus der Warteschlange
//   entfernt) — die Warteposition ALLER wartenden Jobs kann sich geändert haben,
//   auch die fremder User.
const bus = new EventEmitter();
bus.setMaxListeners(0); // ein Listener-Paar pro offenem Stream

function emitJobChange(job, terminal = false) {
  if (job) bus.emit('change', job, terminal);
}

function emitQueueShift() {
  bus.emit('shift');
}

module.exports = { bus, emitJobChange, emitQueueShift };
