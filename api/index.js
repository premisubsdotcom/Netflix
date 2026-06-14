require('dotenv').config();

const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');
const { nanoid } = require('nanoid');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const MAIL_DB = process.env.DATABASE1 || 'MAILS';
const URL_DB = process.env.DATABASE2 || 'URL';
const DELETE_PASSWORD = process.env.PASSWORD || '12345678';

const logClients = new Set();
const recentLogs = [];
function writeLog(message, level = 'INFO') {
  const line = `[${istDate()} IST] [${level}] ${message}`;
  recentLogs.push(line);
  if (recentLogs.length > 500) recentLogs.shift();
  console.log(line);
  const payload = `data: ${JSON.stringify(line)}\n\n`;
  for (const res of logClients) {
    try { res.write(payload); } catch (_) {}
  }
}

if (!MONGODB_URI) console.warn('Missing MONGODB_URI in .env');

app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));
app.use(express.static(path.join(process.cwd(), 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

let clientPromise;
function getClient() {
  if (!clientPromise) {
    const client = new MongoClient(MONGODB_URI);
    clientPromise = client.connect();
  }
  return clientPromise;
}
async function mailDb() { return (await getClient()).db(MAIL_DB); }
async function urlDb() { return (await getClient()).db(URL_DB); }

function istDate(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.day}.${parts.month}.${parts.year}-${parts.hour}:${parts.minute}:${parts.second}`;
}
function collectionName(domain) {
  return domain.toLowerCase().replace(/[^a-z0-9]/g, '_');
}
function cleanDomain(domain) {
  return String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}
function isDomain(domain) {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain);
}
function baseUrl(req) {
  return process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
}

function isValidUrlOrUri(value) {
  const text = String(value || '').trim();
  if (text.length < 3 || text.length > 8000) return false;
  // Allows http://, https://, upi://, mailto:, tel:, whatsapp://, etc.
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:.+/.test(text);
}
function isWebUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

const firstNames = ['vasanth','surya','arjun','rohit','kiran','rahul','nikhil','sai','aditya','vijay','ravi','akhil','manoj','charan','varun','tarun','gokul','naveen','deepak','sandeep'];
const lastNames = ['chityala','reddy','kumar','sharma','naidu','patel','gupta','mehta','rao','verma','singh','yadav','joshi','agarwal','nath','roy','das','pillai','menon','shetty'];
function randomLocalPart() {
  const f = firstNames[Math.floor(Math.random() * firstNames.length)];
  const l = lastNames[Math.floor(Math.random() * lastNames.length)];
  const styles = [`${f}${l}`, `${f}.${l}`, `${f}${Math.floor(100 + Math.random()*900)}`, `${f}.${l}${Math.floor(10 + Math.random()*90)}`];
  return styles[Math.floor(Math.random() * styles.length)];
}

async function ensureIndexes() {
  const udb = await urlDb();
  await udb.collection('shorteners').createIndex({ code: 1 }, { unique: true });
  await udb.collection('shorteners').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  const mdb = await mailDb();
  await mdb.collection('domains').createIndex({ domain: 1 }, { unique: true });
  writeLog('MongoDB indexes checked');
}
ensureIndexes().catch(console.error);

async function cleanupExpiredUrls() {
  const db = await urlDb();
  await db.collection('shorteners').deleteMany({ expiresAt: { $lte: new Date() } });
}

async function moveOldMailsToTrash() {
  const db = await mailDb();
  const cutoff = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
  const domains = await db.collection('domains').find({}).toArray();
  const trash = db.collection('trashmails');
  await trash.createIndex({ email: 1 }, { unique: true });
  await trash.createIndex({ movedAt: 1 });

  let moved = 0;
  for (const item of domains) {
    const domain = item.domain;
    const coll = db.collection(collectionName(domain));
    const oldMails = await coll.find({ createdAt: { $lt: cutoff } }).toArray();
    if (!oldMails.length) continue;

    for (const mail of oldMails) {
      await trash.updateOne(
        { email: mail.email },
        {
          $setOnInsert: {
            email: mail.email,
            domain,
            createdIST: mail.createdIST || istDate(mail.createdAt || new Date()),
            createdAt: mail.createdAt || new Date(),
            movedIST: istDate(),
            movedAt: new Date()
          }
        },
        { upsert: true }
      );
    }

    const ids = oldMails.map(m => m._id);
    await coll.deleteMany({ _id: { $in: ids } });
    moved += oldMails.length;
  }

  if (moved) writeLog(`Moved ${moved} mail(s) older than 35 days to trashmails`, 'WARN');
}

app.get('/', (req, res) => res.render('home'));

app.get('/mail', async (req, res) => {
  await moveOldMailsToTrash();
  const db = await mailDb();
  const domainsCount = await db.collection('domains').countDocuments();
  res.render('mail', { generated: null, domainsCount, error: req.query.error || null, ok: req.query.ok || null });
});

app.post('/mail/generate', async (req, res) => {
  const db = await mailDb();
  const domains = await db.collection('domains').find({}).sort({ domain: 1 }).toArray();
  let generated = null;

  if (!domains.length) {
    return res.render('mail', { generated: null, domainsCount: 0, error: 'No domains added yet. Add a domain first.', ok: null });
  }

  for (let i = 0; i < 100; i++) {
    const domain = domains[Math.floor(Math.random() * domains.length)].domain;
    const email = `${randomLocalPart()}@${domain}`;
    const exists = await db.collection(collectionName(domain)).findOne({ email });
    if (!exists) {
      generated = { email, domain };
      break;
    }
  }

  if (!generated) {
    return res.render('mail', { generated: null, domainsCount: domains.length, error: 'Could not create a unique email. Try again.', ok: null });
  }

  writeLog(`Generated preview mail ${generated.email}. Not saved yet.`);
  res.render('mail', { generated, domainsCount: domains.length, error: null, ok: 'Email generated. Click Add to save it to database.' });
});

app.post('/mail/add-generated', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const domain = cleanDomain(req.body.domain);

  if (!email || !domain || !email.endsWith(`@${domain}`)) return res.redirect('/mail?error=Invalid generated mail');

  const db = await mailDb();
  const domainExists = await db.collection('domains').findOne({ domain });
  if (!domainExists) return res.redirect('/mail?error=Domain not found');

  const coll = db.collection(collectionName(domain));
  const alreadyExists = await coll.findOne({ email });
  if (alreadyExists) return res.redirect('/mail?error=This mail already exists. Generate another one.');

  const createdIST = istDate();
  await coll.insertOne({ email, createdIST, createdAt: new Date(), domain });
  writeLog(`Added mail ${email} to ${domain}`);
  res.redirect('/mail?ok=Mail added to database');
});

app.post('/mail/add-domain', async (req, res) => {
  const domain = cleanDomain(req.body.domain);
  if (!isDomain(domain)) return res.redirect('/mail?error=Invalid domain');
  const db = await mailDb();
  await db.collection('domains').updateOne(
    { domain },
    { $setOnInsert: { domain, collection: collectionName(domain), createdIST: istDate(), createdAt: new Date() } },
    { upsert: true }
  );
  await db.collection(collectionName(domain)).createIndex({ email: 1 }, { unique: true });
  writeLog(`Added domain ${domain}`);
  res.redirect('/mail?ok=Domain added');
});

app.get('/mail/domains', async (req, res) => {
  await moveOldMailsToTrash();
  const db = await mailDb();
  const domains = await db.collection('domains').find({}).sort({ domain: 1 }).toArray();
  res.render('domains', { domains, error: req.query.error || null, ok: req.query.ok || null });
});

app.get('/mail/domain/:domain.txt', async (req, res) => {
  await moveOldMailsToTrash();
  const domain = cleanDomain(req.params.domain);
  const db = await mailDb();
  const exists = await db.collection('domains').findOne({ domain });
  if (!exists) return res.status(404).type('text/plain').send('Domain not found');
  const mails = await db.collection(collectionName(domain)).find({}).sort({ createdAt: 1 }).toArray();
  res.type('text/plain').send(mails.map(m => `${m.email}:${m.createdIST}`).join('\n'));
});

app.post('/mail/delete-domain', async (req, res) => {
  const domain = cleanDomain(req.body.domain);
  if (req.body.password !== DELETE_PASSWORD) return res.redirect('/mail/domains?error=Wrong password');
  const db = await mailDb();
  await db.collection(collectionName(domain)).drop().catch(() => null);
  await db.collection('domains').deleteOne({ domain });
  writeLog(`Deleted domain ${domain}`, 'WARN');
  res.redirect('/mail/domains?ok=Domain deleted');
});

app.post('/mail/update-email', async (req, res) => {
  await moveOldMailsToTrash();
  const email = String(req.body.email || '').trim().toLowerCase();
  const domain = cleanDomain(email.split('@')[1]);
  if (!email || !domain || !isDomain(domain)) return res.redirect('/mail?error=Invalid email');

  const db = await mailDb();
  const domainExists = await db.collection('domains').findOne({ domain });
  if (!domainExists) return res.redirect('/mail?error=Email domain not found in database');

  const result = await db.collection(collectionName(domain)).updateOne(
    { email },
    { $set: { createdAt: new Date(), createdIST: istDate(), updatedAt: new Date(), updatedIST: istDate() } }
  );

  if (!result.matchedCount) return res.redirect('/mail?error=Email not found in database');
  writeLog(`Updated mail time ${email}`);
  res.redirect('/mail?ok=Email date and time updated to current IST');
});

app.post('/mail/delete-email', async (req, res) => {
  await moveOldMailsToTrash();
  const email = String(req.body.email || '').trim().toLowerCase();
  const domain = cleanDomain(email.split('@')[1]);
  if (!email || !domain || !isDomain(domain)) return res.redirect('/mail?error=Invalid email');

  const db = await mailDb();
  const domainExists = await db.collection('domains').findOne({ domain });
  if (!domainExists) return res.redirect('/mail?error=Email domain not found in database');

  const result = await db.collection(collectionName(domain)).deleteOne({ email });
  if (!result.deletedCount) return res.redirect('/mail?error=Email not found in database');
  writeLog(`Deleted mail ${email}`, 'WARN');
  res.redirect('/mail?ok=Email deleted from database');
});

app.get('/trashmails', async (req, res) => {
  await moveOldMailsToTrash();
  const db = await mailDb();
  const rows = await db.collection('trashmails').find({}).sort({ createdAt: 1 }).toArray();
  res.type('text/plain').send(rows.map(m => `${m.email}:${m.createdIST}:moved-${m.movedIST || ''}`).join('\n'));
});

app.get('/url', async (req, res) => {
  await cleanupExpiredUrls();
  const db = await urlDb();
  const rows = await db.collection('shorteners').find({ expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).toArray();
  res.render('url', { rows, created: null, error: req.query.error || null, base: baseUrl(req) });
});

app.post('/url', async (req, res) => {
  await cleanupExpiredUrls();
  const longUrl = String(req.body.longUrl || '').trim();
  if (!isValidUrlOrUri(longUrl)) {
    return res.redirect('/url?error=Enter a valid URL or URI, for example https://example.com or upi://pay?...');
  }
  const db = await urlDb();
  let code = nanoid(7);
  while (await db.collection('shorteners').findOne({ code })) code = nanoid(7);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
  const shortUrl = `${baseUrl(req)}/url/${code}`;
  const qrData = await QRCode.toDataURL(longUrl, { margin: 1, width: 220 });
  const doc = { longUrl, shortUrl, code, qrData, createdAt: now, expiresAt, deleteIST: istDate(expiresAt) };
  await db.collection('shorteners').insertOne(doc);
  writeLog(`Created shortener ${shortUrl} -> ${longUrl}. Expires ${doc.deleteIST} IST`);
  const rows = await db.collection('shorteners').find({ expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).toArray();
  res.render('url', { rows, created: doc, error: null, base: baseUrl(req) });
});

app.get('/url/:code', async (req, res) => {
  await cleanupExpiredUrls();
  const db = await urlDb();
  const row = await db.collection('shorteners').findOne({ code: req.params.code, expiresAt: { $gt: new Date() } });
  if (!row) return res.status(404).render('expired');
  writeLog(`Opened shortener ${row.shortUrl} -> ${row.longUrl}`);
  return res.redirect(row.longUrl);
});

app.get('/url/info/:code', async (req, res) => {
  await cleanupExpiredUrls();
  const db = await urlDb();
  const row = await db.collection('shorteners').findOne({ code: req.params.code, expiresAt: { $gt: new Date() } });
  if (!row) return res.status(404).render('expired');
  res.render('url-info', { row });
});


app.get('/logs', (req, res) => {
  res.render('logs');
});

app.get('/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  logClients.add(res);
  res.write(`data: ${JSON.stringify(`[${istDate()} IST] [SSE] Connection opened`)}\n\n`);
  for (const line of recentLogs) res.write(`data: ${JSON.stringify(line)}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    logClients.delete(res);
  });
});

if (require.main === module) app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
module.exports = app;
