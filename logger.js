const path = require('path');
const winston = require('winston');
const { getContext } = require('./lib/log-context');

const LOG_FILE = path.join(__dirname, 'schreibwerkstatt.log');

// Merged ALS-Context in jedes Log-Info-Objekt; explizite Felder am Call-Site
// haben Vorrang (info.job ?? c.job).
const enrichWithContext = winston.format((info) => {
  const c = getContext();
  if (info.job   == null && c.job   != null) info.job   = c.job;
  if (info.user  == null && c.user  != null) info.user  = c.user;
  if (info.book  == null && c.book  != null) info.book  = c.book;
  if (info.jobId == null && c.jobId != null) info.jobId = c.jobId;
  return info;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    enrichWithContext(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, job, user, book, jobId, stack }) => {
      const scope = job || 'app';
      const u = user || '-';
      const t = book != null && book !== '' ? String(book) : '-';
      const j = jobId ? `|${String(jobId).slice(0, 8)}` : '';
      const tail = stack ? `\n${stack}` : '';
      return `${timestamp} [${level.toUpperCase()}] [${scope}|${u}|${t}${j}] ${message}${tail}`;
    })
  ),
  transports: [
    new winston.transports.File({ filename: LOG_FILE, maxsize: 5 * 1024 * 1024, maxFiles: 5, tailable: true }),
    new winston.transports.Console(),
  ],
});

module.exports = logger;
