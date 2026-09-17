// Polls a dedicated IMAP mailbox (order@tgm.co.th) for incoming PO emails from customers/hotels and
// stores their PDF/image attachments in po_emails (see db/schema.sql) — tgm-wms's "เอกสาร PO ล่วงหน้า"
// page lists these for a Planner to pick, review, and turn into a real po_document (same extraction
// pipeline already used for manual upload). This job never deletes/modifies mail beyond marking
// processed messages \Seen (informational only — de-dup is by our own po_emails.id primary key, not
// the \Seen flag, so a message re-marked unseen elsewhere never gets re-imported as a duplicate).
//
// Only searches messages from the last EMAIL_LOOKBACK_DAYS, not the whole mailbox history — this
// account had ~3750 historical messages sitting unread the first time this was tested (2026-08-27),
// and importing years of backlog on first run would flood the review queue. A short overlap window
// (vs. exactly "since last run") tolerates the job being down for a day or two without losing mail.
const { ImapFlow } = require('imapflow');

const EMAIL_LOOKBACK_DAYS = 3;
const ATTACHMENT_MIME_ALLOW = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif'];
const ATTACHMENT_MIN_BYTES = 5 * 1024; // skip tiny inline logos/signatures misflagged as attachments

function imapConfigured() {
  return !!(process.env.PO_EMAIL_IMAP_HOST && process.env.PO_EMAIL_USER && process.env.PO_EMAIL_PASSWORD);
}

async function importPoFromEmail(db) {
  if (!imapConfigured()) return { skipped: true, reason: 'PO_EMAIL_IMAP_* not configured' };

  const port = Number(process.env.PO_EMAIL_IMAP_PORT) || 993;
  const client = new ImapFlow({
    host: process.env.PO_EMAIL_IMAP_HOST,
    port,
    secure: port === 993,
    auth: { user: process.env.PO_EMAIL_USER, pass: process.env.PO_EMAIL_PASSWORD },
    logger: false,
  });

  const insert = db.prepare(`
    INSERT OR IGNORE INTO po_emails (id, subject, from_addr, received_at, filename, mime_type, content, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'new')
  `);

  let inserted = 0;
  let scanned = 0;
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - EMAIL_LOOKBACK_DAYS * 86400000);
      const uids = await client.search({ since }, { uid: true });
      for (const uid of uids) {
        scanned++;
        const id = `${client.mailbox.uidValidity}:${uid}`;
        // cheap pre-check to avoid downloading full attachment bytes for messages we already have
        const already = db.prepare('SELECT 1 FROM po_emails WHERE id LIKE ? LIMIT 1').get(`${id}%`);
        if (already) continue;

        let msg;
        try {
          msg = await client.fetchOne(uid, { envelope: true, bodyStructure: true }, { uid: true });
        } catch (e) {
          console.warn(`[importPoFromEmail] could not fetch uid ${uid}:`, e.message);
          continue;
        }
        const subject = msg?.envelope?.subject || '';
        const fromAddr = msg?.envelope?.from?.[0]?.address || '';
        const receivedAt = msg?.envelope?.date ? new Date(msg.envelope.date).toISOString() : null;

        const attachments = collectAttachments(msg?.bodyStructure);
        if (!attachments.length) continue;

        for (const att of attachments) {
          const partData = await client.download(uid, att.part, { uid: true });
          const buf = await streamToBuffer(partData.content);
          if (buf.length < ATTACHMENT_MIN_BYTES) continue;
          const rowId = `${id}:${att.part}`;
          const res = insert.run(rowId, subject, fromAddr, receivedAt, att.filename || `attachment-${att.part}`, att.type, buf);
          if (res.changes > 0) inserted++;
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  console.log(`[importPoFromEmail] scanned ${scanned} messages (last ${EMAIL_LOOKBACK_DAYS}d), inserted ${inserted} new attachments`);
  return { scanned, inserted };
}

// Walks bodyStructure recursively (multipart messages nest) collecting disposition:"attachment"
// parts whose mime type we care about — inline images (signatures/logos in HTML bodies) are
// disposition:"inline" and never reach here.
function collectAttachments(node, acc = []) {
  if (!node) return acc;
  const mime = (node.type || '').toLowerCase();
  if (node.disposition === 'attachment' && ATTACHMENT_MIME_ALLOW.includes(mime)) {
    acc.push({ part: node.part, filename: node.dispositionParameters?.filename || node.parameters?.name || null, type: mime });
  }
  for (const child of node.childNodes || []) collectAttachments(child, acc);
  return acc;
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

module.exports = { importPoFromEmail, imapConfigured };
