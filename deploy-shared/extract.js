// เครื่องมือตัดโค้ด index.html ให้เหลือเฉพาะแผนกเดียว (Sales หรือ Planning) — ใช้ acorn parse เป็น AST
// แล้วตัด top-level function/variable declaration ตาม offset จริง (ไม่ใช้ regex/นับวงเล็บมือ ซึ่งเสี่ยง
// พังกับ template literal/regex literal/ข้อความไทยในไฟล์) ตามแผนที่อนุมัติแล้ว (menu-fuzzy-willow.md)
//
// ปรัชญา "default-keep, explicit-delete": อะไรไม่ได้ระบุใน app-manifest.js ถือว่าเป็น shared/core
// เก็บไว้ในทั้ง 2 แอปเสมอ — ปลอดภัยกว่าการลืมระบุแล้วโดนลบทิ้งไปทั้งที่จำเป็น
//
// Safety net: หลังตัดแล้ว สแกนโค้ดที่เหลือหา identifier reference ที่ชี้ไปยังชื่อที่ถูกลบไปแล้ว — ถ้าเจอ
// throw error พร้อมรายชื่อ+ตำแหน่งทันที (จับที่ build time ไม่ใช่ปล่อยให้ user เจอ ReferenceError ตอนใช้งานจริง)
const acorn = require('acorn');
const { SALES_ONLY, PLANNING_ONLY, WMS_ONLY } = require('./app-manifest');

// page-id (RNAV/nav) → เจ้าของ — คนละชุดกับ function-name manifest ด้านบน (RNAV เป็นข้อมูล ไม่ใช่ฟังก์ชัน)
const PAGE_ID_OWNER = {
  mysales: 'sales', consi: 'sales', promo_history: 'sales', custreg: 'sales',
  planstock: 'planning', po: 'planning', planbook: 'planning', booksummary: 'planning',
  prodplan: 'planning', prodsummary: 'planning', forecastdoc: 'planning', stock: 'planning', expiry: 'planning',
  wms: 'wms', // ตัดทิ้งจากทั้ง 2 แอปเสมอ
  // dash, forecast, sample, skuadmin, groups, reports, users, perms, auditlog = shared (ไม่อยู่ในนี้)
};

function findScriptBounds(html) {
  const openTag = '<script>';
  const start = html.indexOf(openTag);
  const end = html.indexOf('</script>', start);
  if (start === -1 || end === -1) throw new Error('extract.js: ไม่พบ <script> เดี่ยวๆ ใน index.html (โครงสร้างไฟล์เปลี่ยนไปหรือเปล่า?)');
  return { codeStart: start + openTag.length, codeEnd: end };
}

function getTopLevelNamedNodes(ast) {
  const nodes = [];
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' && node.id) {
      nodes.push({ name: node.id.name, start: node.start, end: node.end, node });
    } else if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        if (d.id.type === 'Identifier') {
          // ทั้ง declaration (ไม่ใช่แค่ declarator เดี่ยว) ต่อ 1 ชื่อ — ปลอดภัยกว่าถ้ามีหลายตัวใน const a=1,b=2
          // (ในทางปฏิบัติ manifest นี้ไม่มีชื่อไหนประกาศรวมกันแบบนั้น แต่กันไว้)
          nodes.push({ name: d.id.name, start: node.start, end: node.end, node, isMultiDeclarator: node.declarations.length > 1 });
        }
      }
    }
  }
  return nodes;
}

function findRnavNode(ast) {
  for (const node of ast.body) {
    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        if (d.id.type === 'Identifier' && d.id.name === 'RNAV' && d.init && d.init.type === 'ObjectExpression') {
          return { declStart: node.start, declEnd: node.end, objInit: d.init };
        }
      }
    }
  }
  throw new Error('extract.js: ไม่พบ "const RNAV = {...}" ใน index.html — โครงสร้างเปลี่ยนไปหรือเปล่า?');
}

function rewriteRnav(code, rnavInfo, targetApp) {
  const { declStart, declEnd, objInit } = rnavInfo;
  const rnavSource = code.slice(objInit.start, objInit.end);
  // ปลอดภัย: RNAV เป็น object literal ข้อมูลนิ่งที่เราเขียนเองในซอร์ส ไม่ใช่ input จากผู้ใช้/ภายนอก
  const rnav = new Function('return (' + rnavSource + ')')();

  const otherDept = targetApp === 'sales' ? 'planning' : 'sales';
  const deptExclusiveRoleKeys = {
    sales: ['sales_manager', 'sales_officer', 'sales_worker', 'sales'],
    planning: ['planning_manager', 'planning_officer', 'planning_worker', 'planning'],
  };

  const out = {};
  for (const [roleKey, pages] of Object.entries(rnav)) {
    // ลบ role ที่เป็นของแผนกตรงข้ามทิ้งทั้ง key (เช่น ตัด sales_manager ออกจากแอป Planning)
    if (deptExclusiveRoleKeys[otherDept].includes(roleKey)) continue;
    // 'warehouse' (legacy role) เป็นของ Planning เท่านั้น (เกี่ยวกับ PO/สต็อก ไม่เกี่ยวกับ Sales เลย)
    if (roleKey === 'warehouse' && targetApp === 'sales') continue;
    // role ที่เหลือ (superadmin/admin/manager + role ของแผนกตัวเอง) — กรองเอาเฉพาะ page-id ที่ไม่ใช่ของ
    // แผนกตรงข้าม และไม่ใช่ wms (ตัดทิ้งทั้ง 2 แอปเสมอ)
    out[roleKey] = pages.filter(([pageId]) => {
      const owner = PAGE_ID_OWNER[pageId];
      if (owner === 'wms') return false;
      if (owner === otherDept) return false;
      return true;
    });
  }

  const newRnavSource = JSON.stringify(out);
  const newDecl = code.slice(declStart, objInit.start) + newRnavSource + code.slice(objInit.end, declEnd);
  return { newDecl, declStart, declEnd };
}

/**
 * @param {string} html - เนื้อหา index.html เต็มไฟล์
 * @param {'sales'|'planning'} targetApp
 * @returns {string} html ที่ตัดแล้ว
 */
function extract(html, targetApp) {
  if (targetApp !== 'sales' && targetApp !== 'planning') {
    throw new Error(`extract.js: targetApp ต้องเป็น 'sales' หรือ 'planning' เท่านั้น ได้รับ: ${targetApp}`);
  }
  const { codeStart, codeEnd } = findScriptBounds(html);
  const code = html.slice(codeStart, codeEnd);

  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script' });
  const topLevel = getTopLevelNamedNodes(ast);
  const rnavInfo = findRnavNode(ast);

  const removeNames = new Set([
    ...WMS_ONLY,
    ...(targetApp === 'sales' ? PLANNING_ONLY : SALES_ONLY),
  ]);

  // FIXED (2026-09-15, พบจริงตอนรัน extract.js ครั้งแรก): หลายชื่อในไฟล์นี้ประกาศรวมกันในบรรทัดเดียว
  // (เช่น `let _consiRows=[], _consiCustF='', ...;` — 9 ชื่อ, node เดียวกันทั้งหมด) ถ้าปล่อยให้แต่ละชื่อ
  // สร้าง entry แยกกันใน toDelete (โดยใช้ start/end ของทั้ง declaration ซ้ำกัน) การลบซ้ำหลายรอบที่ตำแหน่ง
  // เดิมจะทำให้ offset ของรอบถัดไปเพี้ยน (เพราะ string สั้นลงไปแล้วจากรอบก่อน) ตัดโค้ดผิดตำแหน่งกลาง
  // template literal อื่นที่ไม่เกี่ยวข้องเลย — ยืนยันจากการทดสอบจริงกับ _consi* cluster ตรงๆ
  // แก้โดย: จัดกลุ่มตาม (start,end) ก่อน เก็บ range ไว้ครั้งเดียวต่อ declaration — และเช็คว่า "ทุกชื่อ" ใน
  // declaration เดียวกันต้องอยู่ใน removeNames ครบ (ไม่งั้น throw error ชัดเจน แทนที่จะลบทิ้งผิดๆ เงียบๆ
  // หรือลบทั้ง declaration ทั้งที่มีตัวแปร shared ปนอยู่)
  const byRange = new Map(); // "start:end" -> { start, end, names: [] }
  for (const n of topLevel) {
    const key = `${n.start}:${n.end}`;
    if (!byRange.has(key)) byRange.set(key, { start: n.start, end: n.end, names: [] });
    byRange.get(key).names.push(n.name);
  }
  const toDelete = [];
  for (const { start, end, names } of byRange.values()) {
    const matched = names.filter((nm) => removeNames.has(nm));
    if (matched.length === 0) continue;
    if (matched.length !== names.length) {
      throw new Error(
        `extract.js: การประกาศตัวแปรร่วมบรรทัดเดียวกัน [${names.join(', ')}] มีบางชื่อ (${matched.join(', ')}) ` +
        `อยู่ใน manifest ให้ลบ แต่บางชื่อไม่ได้ระบุไว้ (จะกลายเป็น shared) — ต้องระบุให้ครบทุกชื่อในบรรทัดเดียวกัน ` +
        `ทั้งหมดหรือไม่ระบุเลยสักชื่อ (แก้ app-manifest.js แล้วรันใหม่)`
      );
    }
    toDelete.push({ start, end });
  }
  toDelete.sort((a, b) => b.start - a.start); // ลบจากท้ายไปหน้า กัน offset ก่อนหน้าเพี้ยน

  let newCode = code;
  for (const { start, end } of toDelete) {
    newCode = newCode.slice(0, start) + newCode.slice(end);
  }

  // ตอนนี้ RNAV's offset อาจขยับไปแล้วถ้ามีอะไรถูกลบ "ก่อน" RNAV ในไฟล์ — parse ใหม่รอบเดียวเพื่อหา RNAV
  // ตำแหน่งจริงในโค้ดที่ตัดแล้ว (เร็วพอ ไฟล์นี้ไม่ใหญ่ขนาดที่ parse 2 รอบจะช้าจนมีปัญหา)
  const astAfterDelete = acorn.parse(newCode, { ecmaVersion: 2022, sourceType: 'script' });
  const rnavInfo2 = findRnavNode(astAfterDelete);
  const { newDecl, declStart, declEnd } = rewriteRnav(newCode, rnavInfo2, targetApp);
  newCode = newCode.slice(0, declStart) + newDecl + newCode.slice(declEnd);

  // Safety net: parse โค้ดสุดท้ายอีกรอบ หา identifier ที่ยังอ้างถึงชื่อที่ถูกลบไปแล้ว (เช่น ลืมระบุ manifest
  // ไม่ครบ) — จับที่ build time เป็นข้อความ error ชัดเจน แทนที่จะปล่อยให้ user เจอ ReferenceError ตอนใช้งานจริง
  const danglingRefs = findDanglingReferences(newCode, removeNames);
  if (danglingRefs.length) {
    const preview = danglingRefs.slice(0, 30).map((r) => {
      const ctx = newCode.slice(Math.max(0, r.start - 60), r.start + 20).replace(/\s+/g, ' ');
      return `  - "${r.name}" ที่ offset ${r.start} (แถวประมาณ ${lineOf(newCode, r.start)}) ... "${ctx}"`;
    }).join('\n');
    throw new Error(
      `extract.js: พบ ${danglingRefs.length} จุดที่โค้ดที่เหลือยังเรียกใช้ชื่อที่ถูกตัดทิ้งไปแล้ว (targetApp=${targetApp}) — ` +
      `แปลว่า app-manifest.js ระบุ dependency ไม่ครบ (มีฟังก์ชัน "shared" ที่ดันไปเรียกฟังก์ชัน "${targetApp === 'sales' ? 'planning' : 'sales'}-only" อยู่) ` +
      `ต้องย้ายชื่อที่ถูกอ้างถึงเหล่านี้ออกจาก manifest (ทำให้เป็น core/shared แทน) ก่อน build ใหม่:\n${preview}`
    );
  }

  return html.slice(0, codeStart) + newCode + html.slice(codeEnd);
}

// หา Identifier ที่ไม่ใช่ property key/declaration ของตัวเอง ซึ่งชื่อตรงกับ removeNames — เดินผ่านทุก node
// แบบง่าย (ไม่ได้ใช้ acorn-walk เพราะไม่อยากเพิ่ม dependency ใหม่) ด้วยการ re-parse + walk มือแบบ recursive
// ฟังก์ชันที่ตรวจสอบมือแล้วว่าอ้างชื่อของแผนกอื่นได้อย่างปลอดภัยเสมอ เพราะมี early-return/short-circuit
// guard ครอบไว้ตั้งแต่บรรทัดแรกของฟังก์ชัน (ตรวจสอบด้วยตาจริง ไม่ใช่แค่เดา) — ข้ามการสแกน body ของ
// ฟังก์ชันเหล่านี้ไปเลย ไม่งั้น safety net จะ false-positive ทุกครั้งที่มีการตัดแอปแยกแผนก:
//   - nav(): switch(page){...} ประเมินเฉพาะ case ที่ตรง page เท่านั้น (ดูคอมเมนต์ในนั้น)
//   - refreshSalesOverviewGrouping(): `if(sessionStorage.getItem('_pg')!=='mysales'||!_sdApi.loaded)return;`
//     เป็นบรรทัดแรกสุด — ในแอป Planning หน้า 'mysales' ไม่มีจริง ผู้ใช้ไม่มีทาง set _pg เป็นค่านี้ได้เลย
//     และแม้แต่การอ้าง _sdApi.loaded ในเงื่อนไขเดียวกันก็ปลอดภัยเพราะ || short-circuit ทันทีที่ฝั่งซ้ายเป็น
//     true (_pg!=='mysales' เป็น true เสมอในแอปนี้) ไม่มีทางไปถึง !_sdApi.loaded เลย
const SAFE_LAZY_DISPATCH_FUNCTIONS = new Set(['nav', 'refreshSalesOverviewGrouping']);

// หา identifier ที่ถูก "typeof X === 'function'" หรือ "typeof X !== 'undefined'" การันตีไว้ใน test ของ
// if — เดิน &&-chain (LogicalExpression) ทั้งสองด้าน — เจอ pattern นี้แปลว่าอ้างชื่อ X ใน consequent ได้
// อย่างปลอดภัย (typeof ไม่ throw กับตัวแปรที่ไม่ประกาศไว้เลย, และ && short-circuit ก่อนถึงส่วนที่เรียกจริง)
function namesGuardedByTest(node, out = new Set()) {
  if (!node) return out;
  if (node.type === 'LogicalExpression' && node.operator === '&&') {
    namesGuardedByTest(node.left, out);
    namesGuardedByTest(node.right, out);
  } else if (node.type === 'BinaryExpression' && (node.operator === '===' || node.operator === '!==')) {
    const sides = [node.left, node.right];
    const typeofSide = sides.find((s) => s.type === 'UnaryExpression' && s.operator === 'typeof' && s.argument.type === 'Identifier');
    const litSide = sides.find((s) => s.type === 'Literal');
    if (typeofSide && litSide) {
      const guardsExistence = (node.operator === '===' && litSide.value === 'function') ||
        (node.operator === '!==' && litSide.value === 'undefined');
      if (guardsExistence) out.add(typeofSide.argument.name);
    }
  }
  return out;
}

function findDanglingReferences(code, removeNames) {
  if (removeNames.size === 0) return [];
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script' });
  const found = [];
  function visit(node, parent, key, guarded) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'FunctionDeclaration' && node.id && SAFE_LAZY_DISPATCH_FUNCTIONS.has(node.id.name)) return;
    if (node.type === 'Identifier' && removeNames.has(node.name)) {
      // ข้าม key ของ ObjectExpression property แบบ non-computed (เช่น {pgWMS: fn} เขียนโค้ดแบบนี้ไม่มีในไฟล์นี้
      // อยู่แล้ว แต่กันไว้) และข้ามชื่อ property ของ MemberExpression ที่ไม่ใช่ computed (เช่น obj.pgWMS)
      const isObjectKey = parent && parent.type === 'Property' && key === 'key' && !parent.computed;
      const isMemberProp = parent && parent.type === 'MemberExpression' && key === 'property' && !parent.computed;
      // typeof X เอง (ไม่ว่า X จะประกาศไว้จริงหรือไม่) ไม่มีทาง throw — ปลอดภัยเสมอ ไม่ต้องมี guard เพิ่ม
      const isTypeofArg = parent && parent.type === 'UnaryExpression' && parent.operator === 'typeof' && key === 'argument';
      const isGuarded = guarded && guarded.has(node.name);
      if (!isObjectKey && !isMemberProp && !isTypeofArg && !isGuarded) found.push({ name: node.name, start: node.start });
    }
    // IfStatement: ชื่อที่ typeof-guard ไว้ใน test ปลอดภัยเฉพาะใน consequent (ไม่ใช่ alternate/else)
    const childGuarded = node.type === 'IfStatement' ? namesGuardedByTest(node.test, new Set(guarded)) : guarded;
    for (const k of Object.keys(node)) {
      if (k === 'start' || k === 'end' || k === 'loc' || k === 'range' || k === 'type') continue;
      const val = node[k];
      const useGuarded = node.type === 'IfStatement' && k === 'consequent' ? childGuarded : guarded;
      if (Array.isArray(val)) {
        for (const v of val) if (v && typeof v.type === 'string') visit(v, node, k, useGuarded);
      } else if (val && typeof val.type === 'string') {
        visit(val, node, k, useGuarded);
      }
    }
  }
  for (const node of ast.body) visit(node, null, null, new Set());
  return found;
}

function lineOf(code, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < code.length; i++) if (code[i] === '\n') line++;
  return line;
}

module.exports = { extract, PAGE_ID_OWNER };
