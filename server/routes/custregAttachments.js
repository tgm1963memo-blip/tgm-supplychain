const { attachmentRoutes } = require('../lib/attachments');
module.exports = (db, writeRoles) => attachmentRoutes(db, writeRoles, { table: 'custreg_attachments', parent: 'sub_id', param: 'subId', prefix: 'CRA', slot: true });
