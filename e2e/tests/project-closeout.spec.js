const { test, expect } = require('@playwright/test');

test('NPD submission is blocked until executive route is configured, then can be resubmitted', async ({page}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    UID='SALES'; ROLE='sales';
    SB.getPromoDraftHeader=async()=>({draft_no:'D',status:'draft',is_npd:1});
    let configured=false;const calls=[];
    SB.getApprovalWorkflowTemplate=async entity=>entity==='promo_draft_exec' && configured ? [{mode:'all',approvers:[{uid:'EXEC'}]}] : [];
    SB.updatePromoDraftHeader=async(no,patch)=>{calls.push(patch);return {};};
    SB.audit=async()=>{};window._draftAfterStatusChange=()=>{};
    await draftSubmitForApproval('D');const before=calls.length;
    configured=true;await draftSubmitForApproval('D');
    return {before,after:calls.length,status:calls[0]?.status};
  });
  expect(result).toEqual({before:0,after:1,status:'pending_approval'});
});

test('workflow settings clearly warn about absent executive route',async({page})=>{
  await page.goto('/');
  await page.evaluate(async()=>{
    document.getElementById('app').classList.remove('hidden');document.getElementById('ls').classList.add('hidden');
    SB.getApprovalWorkflowTemplate=async()=>[];
    await pgPromoDraftWorkflowSettings();
  });
  await expect(page.locator('#ct')).toContainText('ยังไม่ได้ตั้งค่าผู้บริหาร');
});

test('profile save invalidates sales and dashboard caches after server success',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(()=>{
    CACHE._store.sales_hist_old=[{corporate:'old'}];window._dashCustRows=[{corporate:'old'}];
    _sdApi.loaded=true;
    invalidateCustomerGroupingCaches();
    return {old:CACHE._store.sales_hist_old,dash:window._dashCustRows,loaded:_sdApi.loaded};
  });
  expect(result).toEqual({old:undefined,dash:null,loaded:false});
});
