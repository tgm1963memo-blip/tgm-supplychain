const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { migrateCustomerProfileRollups } = require('../db/customerProfileRollups');
const workflow = require('../../shared/approval-workflow');
const { getApiBase } = require('../../deploy-shared/api-config');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');
const { isExcludedSalesDocNum } = require('../jobs/importFromExpress');

test('profile migration reconciles history and keeps financial values through insert/update/delete/rename/rollback', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE customer_profiles(code TEXT PRIMARY KEY,category TEXT,corporate TEXT);
    CREATE TABLE v_sales_overview_sales_monthly(cust_code TEXT,category TEXT,corporate TEXT,qty REAL,amount REAL,invoice_count INTEGER);
    INSERT INTO customer_profiles VALUES('A','new','group');
    INSERT INTO v_sales_overview_sales_monthly VALUES('A','old','old',10,100,2),('B','old','old',20,200,3);`);
  const values = () => JSON.stringify(db.prepare('SELECT qty,amount,invoice_count FROM v_sales_overview_sales_monthly').all());
  const baseline = values();
  migrateCustomerProfileRollups(db); migrateCustomerProfileRollups(db);
  assert.equal(db.prepare("SELECT corporate FROM v_sales_overview_sales_monthly WHERE cust_code='A'").get().corporate, 'group');
  db.exec("INSERT INTO customer_profiles VALUES('B',NULL,'B-group')");
  db.exec("UPDATE customer_profiles SET corporate=NULL WHERE code='A'");
  assert.equal(db.prepare("SELECT corporate FROM v_sales_overview_sales_monthly WHERE cust_code='A'").get().corporate, null);
  db.exec("BEGIN; UPDATE customer_profiles SET corporate='rollback'; ROLLBACK;");
  assert.equal(db.prepare("SELECT corporate FROM v_sales_overview_sales_monthly WHERE cust_code='B'").get().corporate, 'B-group');
  db.exec("DELETE FROM customer_profiles WHERE code='B'; UPDATE customer_profiles SET code='B',corporate='renamed' WHERE code='A'");
  assert.equal(db.prepare("SELECT corporate FROM v_sales_overview_sales_monthly WHERE cust_code='A'").get().corporate, null);
  assert.equal(db.prepare("SELECT corporate FROM v_sales_overview_sales_monthly WHERE cust_code='B'").get().corporate, 'renamed');
  const insert = db.prepare('INSERT INTO customer_profiles VALUES(?,?,?)');
  db.exec('BEGIN'); for (let i=0;i<5000;i++) insert.run(`B${i}`,null,'bulk'); db.exec('COMMIT');
  assert.equal(values(), baseline);
  db.close();
});

test('approval helper enforces any/all, stages, rejection, membership and active users', () => {
  const levels = [{ mode:'all',approvers:[{uid:'A'},{uid:'B'}] },{ mode:'any',approvers:[{uid:'C'},{uid:'D'}] }];
  let r = workflow.advance(levels,0,'A',true); assert.equal(r.current,0);
  r = workflow.advance(r.levels,0,'B',true); assert.equal(r.current,1);
  assert.equal(workflow.advance(r.levels,1,'C',true).complete,true);
  assert.equal(workflow.advance(levels,0,'A',false).rejected,true);
  assert.throws(()=>workflow.advance(levels,0,'X',true));
  assert.ok(workflow.validate([],[]));
  assert.ok(workflow.validate([{mode:'any',approvers:[{uid:'A'}]}],[{uid:'A',is_active:0}]));
  assert.equal(levels[0].approvers[0].status,undefined);
});

test('API origin validation', () => {
  assert.match(getApiBase({}), /^https:/);
  assert.equal(getApiBase({TGM_API_BASE_URL:'https://supplychain.tgm.co.th/'}),'https://supplychain.tgm.co.th');
  for (const value of ['', 'http://host', 'https://x/path','https://u:p@x','https://x?x','https://x#x',"https://x/'"]) assert.throws(()=>getApiBase({TGM_API_BASE_URL:value}));
});


test('invoice sales excludes LF/LE/LG document series only', () => {
  for (const docNum of ['LF690001', 'LE690002', 'LG690003', ' lf690004 ']) assert.equal(isExcludedSalesDocNum(docNum), true);
  for (const docNum of ['AI690001', 'IV690001', 'ON690001', 'SE690001', '', null]) assert.equal(isExcludedSalesDocNum(docNum), false);
});

test('isolated API approval and both attachment contracts', async t => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname,'../db/schema.sql'),'utf8'));
  runMigrations(db);
  const tokens = {};
  for (const [uid,role] of [['A','superadmin'],['B','sales_manager'],['S','sales'],['P','planning']]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash) VALUES(?,?,?,?)').run(uid,uid,role,'test');
    tokens[uid]=createSession(db,uid).token;
  }
  const server=buildApp(db).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const call=async(route,method='GET',body,uid='A')=>{
    const response=await fetch(base+route,{method,headers:{Authorization:`Bearer ${tokens[uid]}`,...(body ? {'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    return {status:response.status,data:response.status===204?null:await response.json()};
  };
  const levels=[{id:'l1',mode:'any',approvers:[{uid:'B'}]}];
  db.prepare('INSERT INTO approval_workflow_templates(entity_type,levels_json) VALUES(?,?)').run('promo_draft',JSON.stringify(levels));
  const made=await call('/promo_draft_headers','POST',{is_npd:1}); assert.equal(made.status,201);
  const route=`/promo_draft_headers?draft_no=eq.${made.data.draft_no}`;
  assert.equal((await call(route,'PATCH',{status:'pending_approval'})).status,400);
  assert.equal((await call(route,'PATCH',{status:'approved'})).status,400);
  db.prepare('INSERT INTO approval_workflow_templates(entity_type,levels_json) VALUES(?,?)').run('promo_draft_exec',JSON.stringify([{mode:'all',approvers:[{uid:'A'}]}]));
  assert.equal((await call(route,'PATCH',{status:'pending_approval'})).status,200);
  assert.equal((await call(route,'PATCH',{status:'approved'},'S')).status,400);
  db.exec("DELETE FROM approval_workflow_templates WHERE entity_type='promo_draft_exec'");
  assert.equal((await call(route,'PATCH',{status:'pending_exec_approval'},'B')).status,400);
  assert.equal((await call(route)).data[0].status,'pending_approval');
  db.prepare('INSERT INTO approval_workflow_templates(entity_type,levels_json) VALUES(?,?)').run('promo_draft_exec',JSON.stringify([{mode:'all',approvers:[{uid:'A'}]}]));
  assert.equal((await call(route,'PATCH',{status:'pending_exec_approval'},'B')).data[0].status,'pending_exec_approval');
  assert.equal((await call(route,'PATCH',{status:'approved'},'B')).status,400);
  const approved=await call(route,'PATCH',{status:'approved'}); assert.equal(approved.data[0].status,'approved'); assert.ok(approved.data[0].promo_no);
  assert.equal((await call(route,'PATCH',{status:'approved'})).data[0].promo_no,approved.data[0].promo_no);
  for (const [api,parent,param] of [['custreg_attachments','sub_id','CR1'],['promo_draft_attachments','draft_no',made.data.draft_no]]) {
    const upload=async(bytes,type,uid='A')=>{
      const form=new FormData();form.set('file',new Blob([bytes],{type}),'file.png');form.set('slotId','shop');
      return fetch(`${base}/${api}/${param}`,{method:'POST',headers:{Authorization:`Bearer ${tokens[uid]}`},body:form});
    };
    const bytes=Buffer.from('89504e470d0a1a0a00000000','hex');
    assert.equal((await upload(bytes,'image/png','P')).status,403);
    assert.equal((await upload('<script>bad</script>','image/png')).status,400);
    assert.equal((await upload(bytes,'text/html')).status,400);
    assert.equal((await upload(Buffer.alloc(15*1024*1024+1),'image/png')).status,400);
    const response=await upload(bytes,'image/png');assert.equal(response.status,201);const file=await response.json();
    assert.equal(file[parent],param);
    assert.equal((await call(`/${api}?${parent}=${param}`)).data.length,1);
    const download=await fetch(`${base}/${api}/${file.id}/content`,{headers:{Authorization:`Bearer ${tokens.A}`}});
    assert.equal(download.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
    assert.equal((await fetch(`${base}/${api}/${file.id}/content`)).status,401);
    assert.equal((await call(`/${api}/${file.id}`,'DELETE')).status,204);
  }
});
