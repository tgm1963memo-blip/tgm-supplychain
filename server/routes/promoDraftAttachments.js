const { attachmentRoutes } = require('../lib/attachments');
module.exports = (db, writeRoles) => attachmentRoutes(db, writeRoles, { table: 'promo_draft_attachments', parent: 'draft_no', param: 'draftNo', prefix: 'PDA' });
