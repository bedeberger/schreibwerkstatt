const path = require('path');
const winston = require('winston');
const { getContext } = require('./lib/log-context');

const LOG_FILE = path.join(__dirname, 'lektorat.log');

// Merged ALS-Context in jedes Log-Info-Objekt; explizite Felder am Call-Site
// haben Vorrang (info.job ?? c.job).
const enrichWithContext = winston.format((info) => {
  const c = getContext();
  if (info.job  == null && c.job  != null) info.job  = c.job;
  if (info.user == null && c.user != null) info.user = c.user;
  if (info.book == null && c.book != null) info.book = c.book;
  return info;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    enrichWithContext(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, job, user, book, stack }) => {
      const scope = job || 'app';
      const u = user || '-';
      const t = book != null && book !== '' ? String(book) : '-';
      const tail = stack ? `\n${stack}` : '';
      return `${timestamp} [${level.toUpperCase()}] [${scope}|${u}|${t}] ${message}${tail}`;
    })
  ),
  transports: [
    new winston.transports.File({ filename: LOG_FILE, maxsize: 5 * 1024 * 1024, maxFiles: 3 }),
    new winston.transports.Console(),
  ],
});

module.exports = logger;
