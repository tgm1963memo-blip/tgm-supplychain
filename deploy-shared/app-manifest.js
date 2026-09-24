// แผนที่การเป็นเจ้าของฟังก์ชัน/ตัวแปรระดับ top-level ของ index.html สำหรับตัดแยกเป็น 2 แอป (Sales/Planning)
// ตามแผนที่อนุมัติแล้ว (menu-fuzzy-willow.md) — ใช้หลัก "default-keep, explicit-delete": ชื่อที่ไม่ได้
// ระบุไว้ในไฟล์นี้เลย ถือว่าเป็น shared/core และจะถูกเก็บไว้ใน "ทั้ง 2" แอปเสมอ (ปลอดภัยกว่าการลืมระบุ
// แล้วโดนลบทิ้งไปทั้งที่จำเป็น) — deploy-shared/extract.js เป็นตัวใช้แผนที่นี้จริง
//
// ยืนยันจากการสำรวจโค้ดจริง (ไม่ใช่แค่เดาจากชื่อ) ว่า pgDash()/dashRenderBody() ต้องพึ่งฟังก์ชันที่อยู่
// ในก้อนโค้ดเดียวกันกับ Sales Overview (_sd*/sd* cluster) จริงๆ — ฟังก์ชันเหล่านั้นจึงถูก "จงใจไม่ระบุ" ไว้
// ในไฟล์นี้เลย (= อยู่ในกลุ่ม default-keep/core) แม้ว่าชื่อจะขึ้นต้นด้วย _sb/_merge/_two ก็ตาม ห้ามเพิ่มเข้าไป
// ใน SALES_ONLY โดยไม่ตรวจสอบ dependency chain ใหม่ก่อน (ดู loadDashboardSalesHist() ที่เรียก
// _twoYearWindow/_monthsBetweenYm/_mergeSalesRows/_sbSalesRows ตรงๆ, และ _sbSalesRows เองเรียก
// _salesNameMap/_splitBranchSlm/_isConsiBranch/_companyFromExpressBranch/_salesRowsForMode/
// _isConsignmentRow ต่ออีกที — ทั้งหมดนี้ต้องอยู่ core)

// ── Sales-only: หน้า Sales Overview, ฝากขาย CONSI, เอกสารโปรโมชัน/ใบเคาะราคา, ข้อมูลลูกค้า (custreg) ──
const SALES_ONLY = [
  // Sales Overview page + state (ไม่รวมฟังก์ชัน core ที่ pgDash/allCustomerRows/มุมมอง admin อื่นๆ ต้องใช้ —
  // ดูคอมเมนต์ด้านบน — ยืนยันจากการรัน extract.js's safety-net check จริงแล้วว่าฟังก์ชัน/ตัวแปรต่อไปนี้แม้จะขึ้น
  // ต้น sd/_sd หรือดูเหมือนเป็นของ Sales Overview แต่มีจุดอื่น (core/shared) เรียกใช้ตรงๆ จึง "ห้ามใส่" ใน
  // รายการนี้: _salesNameMap/_splitBranchSlm (ใช้ใน _sbSalesRows), SD_CUSTS/SD_SALES (ใช้ใน allCustomerRows),
  // _sdF (ใช้ในหน้า admin/invoice หลายจุด), _dateToDisplayTh (ใช้ในตารางวันที่ทั่วไป), _promoJsKey/promoFmtD
  // (ใช้ใน mpoSelect ของ Planning ด้วย), refreshSalesOverviewGrouping (เรียกจาก saveCustomerGroup/
  // confirmCustomerGroup ฝั่ง admin ที่ใช้ทั้ง 2 แอป)
  'SD_MTH', 'SD_MD', 'SD_WM', 'SD_PRODS', 'SD_VS',
  '_sd', '_sdApi', '_SD_CACHE_TTL', '_sdNum', '_sdCmp', '_sdByValue', '_sdResetBuildCache',
  '_sdMonthRange', '_companyFromExpressSlm',
  '_sdKpiFromRows', '_sdSalesListFromRows', '_sdBuildKey', '_sdEnsureBuilt', '_applySalesRowsToSd',
  '_loadSalesFromSupabase', '_loadSalesSummaryFromSupabase', '_sdFmtTotal', '_sdUseLatestMonthIfEmpty',
  '_sdApiMonth', '_loadSalesFromAllHist', '_sdApiYear', '_sdWeekFactor', '_sdV', '_sdPeriodLabel',
  'sdLoad', 'sdLoadYear', '_STKGRP_LABELS', 'expressGroupLabel',
  '_sdBuildCusts', '_sdBuildProds', '_sdBuildSlms',
  // Dashboard's Top 10 สินค้า/ลูกค้า (2026-09-16) — defined in the Dashboard section of the file, not
  // Sales Overview, but its body calls _sdBuildProds/_sdBuildCusts/_sdFmtTotal/_sdBar directly so it
  // must be stripped alongside them. dashRenderBody() (core, both apps use Dashboard) guards its call
  // site with `typeof _sdBuildProds==='function'` — see index.html's _dashHasSalesCluster.
  // dashSetSlmFilter is deliberately NOT listed here: its own body has no sales-only references (just
  // sets window._dashSlmF + calls pgDash()), so it's harmless to keep as core/unused on Planning —
  // the <select> that calls it only renders when _dashHasSalesCluster is true anyway.
  'dashTopTables',
  '_sbInvoiceSalesRows', '_sbInvoiceSalesRowsRange', '_sdScaleProdsToTotal',
  '_sdBuildCustsFromInvoice', '_sdBuildSlmsFromInvoice', '_sdUpdateSlmDrop',
  '_sdD', '_sdWI', '_sdVs', '_sdBar', 'sdTogOp',
  '_ymAddYear', '_dateAddYear', '_yoyPct', '_sdYoYMaps', '_sdYoYHead', '_sdYoYCell', '_sdLoadYoY', 'sdTogYoY',
  '_dateToYm', 'sdSetDateRange', 'sdApplyCustomRange', 'sdSetDatePreset', 'sdLoadCustom',
  'pgMySales', 'sdRender', 'sdUpdateLabel', 'sdKPI', '_xa', '_custsByItemGrouped',
  'sdCust', 'sdProd', 'sdSlm', 'sdSetPT', 'sdNav', 'sdGoNow', 'sdTab', 'sdTogView', 'sdSort',
  'sdSetYear', 'sdSetQ', 'sdClear', 'sdExport',

  // ฝากขาย CONSI
  '_consiRows', '_consiCustF', '_consiProdF', '_consiBranchF', '_consiStartF', '_consiEndF',
  '_consiLoaded', '_consiErr', '_consiOp', 'consiTogOp', 'pgConsignment', '_sbConsiRows', 'consiRender', 'expConsi',

  // เอกสารโปรโมชัน (ประวัติ, mirror จาก Express) — ไม่รวม _promoJsKey/promoFmtD (ใช้ใน mpoSelect ของ
  // Planning ด้วย ยืนยันจาก safety-net check จริง — ย้ายไป core)
  '_promoEmptyFilters', '_promoCurrentYearRange', '_promo', '_promoRangeKey', 'pgPromoHistory',
  'promoReloadForCreateRange', 'promoSetDateRange', 'promoApplyDateRange', 'promoClear', 'promoSort',
  '_promoFiltered', 'promoIsCompensate', 'promoTypeBadge', 'PROMO_MS_FIELDS',
  '_promoBuildOptions', '_promoOptionsFor', 'promoMsLabel', 'promoMsButton', 'promoMsItems',
  '_promoTableDebounce', 'promoMsSearch', 'promoMsConfirm', 'promoMsToggle', 'promoMsClear',
  'promoRender', 'promoRenderBody', 'promoStatusBadge', 'expPromoHistory',

  // ใบเคาะราคา (promo_drafts v2)
  'DRAFT_CONDITION_TYPES', 'DRAFT_ITEM_TYPES', 'DRAFT_STATUS_LABELS',
  'DRAFT_AUDIT_ACTION_LABELS', 'PROMO_DRAFT_WF_ENTITY', 'PROMO_DRAFT_EXEC_WF_ENTITY',
  '_draftEditNo', '_draftHeader', '_draftEditStatus', '_draftEditCreatedBy', '_draftOtherCosts',
  '_draftAttachments', '_draftSelGroups', '_draftSelCats', '_draftMsQ', '_draftRefData',
  '_draftSkuRows', '_draftSkuLoadPromise',
  '_draftEmptyLine', '_draftHasAlphaSuffixSku', '_draftIsSpecialPriceSku', '_draftLineNumbers', 'draftAddSubItem',
  '_draftDaysCount', 'draftUpdateDayCounts', 'draftItemTypeChanged', 'draftStatusBadgeHtml',
  'draftClose', 'showPromoDraftModal', 'draftCanEditStatus', 'draftEscalateChanged',
  '_draftBranchGroups', 'draftGroupLabel', 'draftGroupPickerHtml', 'draftGroupListHtml', 'draftGroupRefresh',
  'draftGroupToggle', 'draftGroupSelectAll', 'draftGroupClear', '_draftGroupQ', 'draftGroupSearch',
  '_draftCatsForGroups', '_draftPruneCats', 'draftCatLabel', 'draftCatPickerHtml', 'draftCatListHtml',
  'draftCatRefresh', 'draftCatToggle', 'draftCatSelectAll', 'draftCatClear',
  'draftMsLabel', 'draftMsButton', 'draftMsItems', 'draftMsSearch', 'draftMsRefresh', 'draftMsToggle', 'draftMsSelectAll',
  '_draftSkuList', 'draftEnsureSkuCatalog', '_draftFindSku', 'draftApplySku',
  // เรียกจากฟอร์มใบเคาะราคาเท่านั้น แต่ตัวเองเรียก draftLineField/draftGroupRefresh/draftMsRefresh (sales-only)
  'draftApplyDefaultGp', 'draftRefreshCustomerCatalog', 'draftCostSameChanged', '_draftRefreshLineRefDataNow', '_draftRefPromise',
  '_pdWfUsers', '_pdWfPickerHtml', 'pdWfPickerClose', 'pdWfPickerOpen', 'pdWfSetField',
  'draftRenderApprovalTrail', '_draftAnchorCmts', '_draftCmtMode', 'DRAFT_LINE_COL_LABELS', '_draftAnchorFor', '_draftElForAnchor',
  '_acmSplit', 'draftLoadAnchorComments', 'draftRenderAnchorPins', 'draftJumpToAnchor', 'draftToggleCommentMode',
  'draftCloseAnchorPopover', 'draftOpenAnchorPopover', '_draftAskApprovalComment',
  'pdWfTogglePick', '_draftPickUsers', '_draftPickState', '_draftAskPickApprovers', '_draftPickRender', '_draftPickToggle', '_draftPickDone',
  'draftAddLine', 'draftRemoveLine', 'draftLineField', 'draftSyncLineDates', 'draftRenderLines',
  '_draftOverlapDebounce', 'draftCheckOverlap', '_draftCheckOverlapNow', 'draftRefreshLineRefData', 'draftRenderRefCells',
  'draftRefreshCommentCounts', 'draftOpenLineComments', 'draftAddLineComment',
  'draftRenderAttachments', 'draftUploadAttachment', 'draftDeleteAttachment',
  'draftRenderOtherCosts', 'draftAddOtherCost', 'draftRemoveOtherCost', 'draftOtherCostField',
  'saveDraftPromo', '_draftListStatusFilter', '_pdListView', 'pgPromoDrafts', 'pgPromoDraftsRenderBody',
  'draftMarkKeyed', '_draftConfirmMarkKeyed', 'draftDeleteConfirm', '_draftAfterStatusChange',
  'draftSubmitForApproval', '_draftNeedsEscalation', '_draftCheckExecRoute', '_draftApplyApproval', 'draftApprove', '_draftFinishNormalRoute', 'draftExecApprove',
  '_pdWfNormalLevels', '_pdWfExecLevels', 'pgPromoDraftWorkflowSettings', '_pdWfLevelsFor',
  'pdWfAddLevel', 'pdWfRemLevel', 'pdWfAddApprover', 'pdWfRemApprover', 'pdWfSave',
  'draftAuditActionLabel', 'draftRenderAuditTrail', 'draftOpenCopyPicker', 'draftCopyFrom', 'draftPreviewPDF',
  // ใบเคาะราคา v3 (2026-09-24): สินค้า NPD / ค่าใช้จ่ายนอกสัญญา, Pro Period ก่อน / Pro No. ล่าสุด, เส้นทางอนุมัติหลายแบบ
  '_draftFormExtraHtml', '_draftOtherCostSum', '_draftBranchesFrom', '_draftIsOffContract', 'draftOffContractChanged', '_draftDocDate', '_draftPickSetRoute',
  'PROMO_DRAFT_ROUTES_ENTITY', '_draftRouteEntity', '_draftLoadRoutes', '_draftNorm', '_draftDocRouteFacts', '_draftRouteMatch', '_draftSuggestRoute',
  '_pdWfRoutes', '_pdWfRouteId', '_pdWfCorpOpts', '_pdWfCurRoute', 'pdWfSelectRoute', 'pdWfAddRoute', 'pdWfDelRoute',
  'pdWfRouteName', 'pdWfRouteMatch', 'pdWfRouteType', 'pdWfRouteCorpAdd', 'pdWfRouteCorpRem',
  '_draftEquipKeep', '_draftSyncOtherCostBox', 'DRAFT_LINE_COL_KEYS', 'DRAFT_LINE_COL_KEYS_V2', '_pdWfDirty',
  '_draftCorpBase', '_draftOverlap', '_draftRenderOverlapMarks', 'draftShowOverlap', '_draftCopyHeader', '_draftCopySrcNo', '_draftLinesFromRows', 'pdWfCopyRoute',
  '_draftPlan', '_draftPlanOpts', '_draftPlanRoutes', '_draftPlanUsers', '_draftPlanLoading', '_draftPlanLoad', '_draftFormRouteFacts', '_draftPlanOpt',
  '_draftPlanFillDefaults', '_draftPlanHtml', 'draftPlanSetRoute', 'draftPlanAuto', 'draftPlanAdd', 'draftPlanAddByText', 'draftPlanRem', '_draftPlanForSave', '_draftPromoDocsCache', '_draftRefSeq', '_draftFormSeq', '_draftLoadRouteOptions',

  // ข้อมูลลูกค้า (custreg — สมัคร/แก้ไขข้อมูลลูกค้าใหม่) — ไม่รวม custregSubToRow/custregRowToSub (ใช้ใน
  // SB.getCustregSubs()/upsertCustreg() ซึ่งเป็นส่วนหนึ่งของ SB object กลาง อยู่ทั้ง 2 แอปเสมอ — ย้ายไป core)
  'CR_DOC_SLOTS', '_cr', '_crReset', '_crInitIfNeeded', '_crSave', '_crV', '_crCk',
  'crVisibleCustomerRows', '_crCustRefreshing', '_crRefreshCustomersFromExpress', 'crRenderCustomerHome',
  'crStartCustomerChange', 'pgCustRegEntry', 'pgCustReg', 'crTab', 'crGoStep', 'crNext', 'crBack', 'crToSummary',
  'crRender', 'crRequestTypes', 'crIsExistingChange', 'crToggleExistingChange', 'crIsChangeSub', 'crDocFileLink',
  'crSalesUsers', 'crSalesName', 'crOwnerUid', 'crCustomerMasterRows', 'crCustomerOptionHtml', 'crLoadExistingCustomer',
  'crVisibleSubs', 'crSubMailBody', 'crMailExternal', 'crRenderSummary', 'crShowSummaryDetail',
  'crSec0', 'crSec1', 'crSec2', 'crSec3', 'crTogBillingField', 'crTogDocOther', 'crSec4',
  'crRenderDocSlots', 'crRenderSlot', 'crToggleSlot', 'crTrigUpload', 'crReadFileDataUrl', 'crHandleFiles', 'crDelFile',
  '_crOcrParsed', '_crOcrSend', '_crParseCert', '_crCleanVatText', '_crVatAfter', '_crParseVat20', '_crParseAnyOcr',
  'crOcrTrigger', 'crOcrHandleFile', 'crOcrApply', 'crOcrRetry', 'crSec5', 'crSec6', 'crNewForm',
  'crApListHtml', 'crToggleApprover', '_crUploadPendingFiles', 'crConfirmApproval', 'crRenderApprove',
  'crShowDetail', 'crRenderDocsForSub', 'crOpenAttachment', 'crRenderApproveDetail', 'crHideDetail', 'crDoReject',
  'pgCrWorkflowSettings', 'crWfAddLevel', 'crWfRemLevel', 'crWfAddApprover', 'crWfRemApprover', 'crWfSave',
  'crOpenApproval', 'crConfirmWithWorkflow', 'crDoApprove', 'pgCustMap',
  'crImportCustomersFile', 'crExportCustomers', 'crDownloadCustomerTemplate',
];

// ── Planning-only: Stock & Planning, Production Planning, จองสินค้า PO/SO, สรุปการจอง, สั่งยอดผลิต, ──
// ── เปรียบเทียบผลิต, + 3 หน้าที่เข้าไม่ถึงเลยในระบบปัจจุบัน (ย้ายมาไว้ที่นี่ตามที่ยืนยันแล้ว) ──
const PLANNING_ONLY = [
  // Stock & Planning
  '_psCrits', '_psSort', '_psInitPeriod', 'PS_CRITS_ALL', 'psCritToggle', '_psView', 'psSetView', '_psViewTabs',
  'pgPlanStock', '_psDaily', '_psDailyDefaultRange', 'pgPlanStockDaily',
  'psdBackToList', 'psdSetSku', 'psdListLoad', 'psdListRender', 'psdLoad', 'psdRender',
  'planStkT', 'psSortBy', 'quickOrder', 'expPlanStk',

  // สั่งยอดผลิต (Production Planning entry)
  '_pp', 'pgProdPlan', 'ppSetPT', 'ppGetRange', 'ppGanttCols', 'ppRenderGantt', 'ppEditModal', 'ppSaveModal',
  'ppRender', 'ppShowOrder', 'ppSaveOrder', 'ppEditOrder', 'ppDeleteOrder', 'ppLinkToWMS', 'ppExport',

  // Production Planning (PO/SO matching)
  'pgPO', 'poMergeWithLocal', 'poRenderTable', 'poT', 'handlePOPaste', 'cfmPOPaste', 'showPOModal',
  'updPOInfo', 'savePO', 'showEditPO', 'updatePO', 'matchPO', 'mpoManualInput', 'mpoRenderList', 'mpoSelect',
  'syncSO', 'expPO',

  // จองสินค้า PO/SO + สรุปการจอง
  // หมายเหตุ (ยืนยันจากการรัน extract.js's safety-net check จริง 2026-09-15): normalizeBookingRow,
  // mergeBookings, และ bookingSoNo (เรียกจากใน normalizeBookingRow เอง) ถูกเรียกจาก SB.getBookings()
  // (core, ใช้ทุกแอป) และ pgForecast() (cross-dept, ใช้ทุกแอป) โดยตรง — ห้ามใส่ในรายการนี้ ปล่อยเป็น
  // core/shared แทน (bookingDocNo/useBookings ยืนยันแล้วว่าถูกเรียกจากฟังก์ชัน Planning-only เท่านั้นจริงๆ
  // จึงตัดได้ปลอดภัย)
  'bookingDocNo', 'useBookings',
  '_bkFilters', 'pgPlanBooking', 'bkSaveAndRefresh', 'bkClearFilters', 'bkChangeStockStatus', 'bkSetConfirmDate',
  'showBkModal', 'saveBk', 'bkStatusControl', 'bkChangeStatus', 'deleteBk', 'expBookings',
  'bookingSummaryRenderFromAgg', 'bookingSummaryRenderFallback', 'pgBookingSummary', 'expBkSummary',

  // เปรียบเทียบผลิต/แผน vs จริง
  '_psv', 'psvActualBtnHtml', 'psvActualBannerHtml', 'pgProdSummary', 'psvClearActual', 'psvImportClick',
  'psvDownloadTemplate', 'psvImportFile', 'psvSetPeriod', 'psvRender', 'expPsvSummary',

  // 3 หน้าที่เข้าไม่ถึงเลยในระบบปัจจุบัน (ยืนยันแล้วว่าย้ายมา Planning ทั้งหมด)
  'pgForecastDoc', 'expFcDoc',
  'pgStock', 'scLookup', 'submitScan', 'clearScan', 'handleStkPaste', 'cfmStkPaste', 'stkT', 'renderStkLog', 'expStk',
  'pgExpiry', 'expExpiry',
];

// ── WMS: legacy stub ที่แค่ลิงก์ออกไปแอป WMS จริง (tgm-wms) — ตัดทิ้งจากทั้ง 2 แอปใหม่ ──
const WMS_ONLY = [
  'pgWMS', 'saveWmsUrl', 'wmsLoadStock',
];

module.exports = { SALES_ONLY, PLANNING_ONLY, WMS_ONLY };
