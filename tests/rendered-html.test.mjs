import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("배포 산출물에 원격제어와 예약·정산 기능이 포함된다", async () => {
  const server = await readFile(new URL("dist/server/index.js", root), "utf8");
  const assetRoot = new URL("dist/client/assets/", root);
  const client = (
    await Promise.all(
      (await readdir(assetRoot))
        .filter((name) => name.endsWith(".js"))
        .map((name) => readFile(new URL(name, assetRoot), "utf8")),
    )
  ).join("\n");

  assert.match(server, /점핑배틀 원격 운영실/);
  assert.match(server, /화성병점점/);
  assert.match(server, /route:\/api\/status/);
  assert.match(server, /route:\/api\/commands/);
  assert.match(server, /route:\/api\/agent\/sync/);
  assert.match(server, /route:\/api\/agent\/ack/);
  assert.match(server, /route:\/api\/agent\/parking-commands/);
  assert.match(server, /route:\/api\/agent\/parking-policy/);
  assert.match(server, /route:\/api\/agent\/parking-ack/);
  assert.match(server, /route:\/api\/parking-discount\/register/);
  assert.match(server, /route:\/api\/pin-login/);
  assert.match(server, /route:\/api\/pin-logout/);
  assert.match(server, /운영자 PIN/);
  assert.match(server, /route:\/reserve/);
  assert.match(server, /route:\/admin/);
  assert.match(server, /route:\/admin\/analytics/);
  assert.match(server, /route:\/admin\/settings/);
  assert.match(server, /route:\/api\/reservations/);
  assert.match(server, /route:\/api\/admin\/reservations/);
  assert.match(server, /route:\/api\/admin\/daily-sales/);
  assert.match(server, /route:\/api\/admin\/analytics/);
  assert.match(server, /route:\/api\/admin\/settings/);
  assert.match(server, /route:\/api\/import\/reservations/);
  assert.match(client, /\uc9c1\uc811 \uc785\ub825/);
  assert.match(client, /\ucd94\uac00\u00b7\ub300\uae30/);
  assert.match(client, /\uce78 \ube44\uc6b0\uae30/);
  assert.match(client, /설명 1분/);
  assert.match(client, /분 고정/);
  assert.match(client, /통합 운영 관리/);
  assert.match(client, /매장 실시간 원격제어/);
  assert.match(client, /실제 남은시간/);
  assert.match(client, /이용 가능 예상/);
  assert.match(client, /다음 예약 게임/);
  assert.match(client, /다음 예약 .* 반영/);
  assert.match(client, /예약 칸 통합 관리/);
  assert.match(client, /관리자에 입력/);
  assert.match(client, /게임 정지/);
  assert.match(client, /결제 저장/);
  assert.match(client, /현장 결제금액/);
  assert.match(client, /완료/);
  assert.match(client, /남음/);
  assert.match(client, /한 번 결제/);
  assert.match(client, /N분의1/);
  assert.match(client, /직접 나누기/);
  assert.match(client, /결제 순서/);
  assert.doesNotMatch(client, /상세관리로 이동/);
  assert.match(client, /권장/);
  assert.match(client, /가장 빠른/);
  assert.match(client, /예약 마감/);
  assert.match(client, /전체 시간대별 예약 현황/);
  assert.match(client, /‘이동’ 손잡이를 끌어 원하는 시간·방으로 옮길 수 있습니다/);
  assert.match(client, /같은 칸 추가/);
  assert.match(client, /이미 같은 칸에 있는 예약입니다/);
  assert.match(client, /합계/);
  assert.match(client, /예상 매출/);
  assert.match(client, /전체 정지/);
  assert.match(client, /매장 수동 시작/);
  assert.match(client, /팀명만 빠르게 전송/);
  assert.match(client, /매출 분석/);
  assert.match(client, /일매출·일인원/);
  assert.match(client, /시간대별 매출·인원/);
  assert.match(client, /복합결제 합계/);
  assert.match(client, /공용 부가매출/);
  assert.match(client, /판매 개수/);
  assert.match(client, /오늘 누적/);
  assert.match(client, /저장 후 0 초기화/);
  assert.match(client, /누적 저장 완료/);
  assert.match(client, /네이버 예약/);
  assert.match(client, /예약 접수 사이트/);
  assert.match(client, /네이버 예약금/);
  assert.match(client, /현장 결제금액/);
  assert.match(client, /한판 더/);
  assert.match(client, /미결제 상태로 만들어집니다/);
  assert.match(client, /완료·취소 기록 삭제/);
  assert.match(client, /완료 예약 수정/);
  assert.match(client, /00:00이 되어도 자동 종료되지 않으며/);
});

test("배포 설정, 데이터베이스 마이그레이션, 공유 이미지가 포함된다", async () => {
  const [hosting, migration, runtimeMigration, reservationMigration, sharedSalesMigration, sharedSalesCountMigration, paymentSplitMigration, sharedOtherMigration, passSalesMigration, scheduleOverrideMigration, cancellationMigration, pricingMigration, previewImage] = await Promise.all([
    readFile(new URL("dist/.openai/hosting.json", root), "utf8"),
    readFile(new URL("dist/.openai/drizzle/0000_burly_genesis.sql", root), "utf8"),
    readFile(
      new URL("dist/.openai/drizzle/0001_wooden_krista_starr.sql", root),
      "utf8",
    ),
    readFile(
      new URL("dist/.openai/drizzle/0002_sleepy_whistler.sql", root),
      "utf8",
    ),
    readFile(
      new URL("dist/.openai/drizzle/0003_dapper_the_professor.sql", root),
      "utf8",
    ),
    readFile(
      new URL("dist/.openai/drizzle/0004_shallow_spirit.sql", root),
      "utf8",
    ),
    readFile(
      new URL("dist/.openai/drizzle/0005_true_black_tom.sql", root),
      "utf8",
    ),
    readFile(
      new URL("dist/.openai/drizzle/0006_outgoing_the_watchers.sql", root),
      "utf8",
    ),
    readFile(
      new URL("dist/.openai/drizzle/0009_closed_spectrum.sql", root),
      "utf8",
    ),
    readFile(
      new URL("dist/.openai/drizzle/0010_polite_madame_web.sql", root),
      "utf8",
    ),
    readFile(
      new URL("dist/.openai/drizzle/0011_fat_mariko_yashida.sql", root),
      "utf8",
    ),
    readFile(
      new URL("dist/.openai/drizzle/0014_pricing_settings.sql", root),
      "utf8",
    ),
    readFile(new URL("dist/client/og.png", root)),
  ]);

  assert.match(hosting, /replace-with-sites-project-id/);
  assert.match(hosting, /"d1"\s*:\s*"DB"/);
  assert.match(migration, /CREATE TABLE `commands`/);
  assert.match(runtimeMigration, /CREATE TABLE `agent_runtime`/);
  assert.match(runtimeMigration, /CREATE TABLE `room_metadata`/);
  assert.match(reservationMigration, /CREATE TABLE `reservations`/);
  assert.match(reservationMigration, /reservations_active_slot_key_uidx/);
  assert.match(reservationMigration, /CREATE TABLE `reservation_events`/);
  assert.match(sharedSalesMigration, /CREATE TABLE `daily_shared_sales`/);
  assert.match(sharedSalesCountMigration, /ADD `slush_card_count`/);
  assert.match(sharedSalesCountMigration, /ADD `beverage_account_count`/);
  assert.match(sharedSalesCountMigration, /WHERE `source` = 'naver'/);
  assert.match(paymentSplitMigration, /payment_card_amount/);
  assert.match(paymentSplitMigration, /payment_cash_amount/);
  assert.match(paymentSplitMigration, /payment_account_amount/);
  assert.match(sharedOtherMigration, /ADD `other_card_count`/);
  assert.match(sharedOtherMigration, /ADD `other_account_count`/);
  assert.match(
    sharedOtherMigration,
    /`other_card_count` = `other_card_count` \+ min\(`beverage_card_count`, 12\)/,
  );
  assert.match(sharedOtherMigration, /WHERE `sales_date` = '2026-07-30'/);
  assert.match(passSalesMigration, /ADD `youth_pass_10_card_count`/);
  assert.match(passSalesMigration, /ADD `adult_pass_20_account_count`/);
  assert.match(scheduleOverrideMigration, /ADD `schedule_overridden`/);
  assert.match(scheduleOverrideMigration, /`event_type` = 'move'/);
  assert.match(cancellationMigration, /ADD `cancelled_at`/);
  assert.match(cancellationMigration, /'import_cancelled'/);
  assert.match(pricingMigration, /CREATE TABLE `pricing_settings`/);
  assert.match(pricingMigration, /`adult_pass_20_price` integer DEFAULT 110000/);
  assert.deepEqual([...previewImage.subarray(0, 8)], [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  assert.ok(previewImage.length > 100_000);
});

test("네이버 예약금은 현장 결제에서만 차감되고 총매출에는 포함된다", async () => {
  const [adminSource, reservationSource, pricingSource, settingsSource] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("db/reservations.ts", root), "utf8"),
    readFile(new URL("app/pricing-config.ts", root), "utf8"),
    readFile(new URL("app/admin/settings/PricingSettingsForm.tsx", root), "utf8"),
  ]);

  assert.match(adminSource, /pricing\.naverDepositAmount/);
  assert.match(pricingSource, /slushPrice: 1_500/);
  assert.match(pricingSource, /beveragePrice: 1_000/);
  assert.match(pricingSource, /otherPrice: 1_000/);
  assert.match(adminSource, /paymentAmount: grossPaymentAmount/);
  assert.match(adminSource, /grossPaymentAmount - depositAmount/);
  assert.match(reservationSource, /input\.totalCount \* adultPrice/);
  assert.match(settingsSource, /운영 가격 설정/);
  assert.match(settingsSource, /\/api\/admin\/settings/);
});

test("공용 부가매출은 상단에서 누적 저장되고 입력값은 0으로 초기화된다", async () => {
  const [adminSource, dailySalesSource, analyticsSource, analyticsUiSource, salesClassificationSource, pricingSource] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("db/daily-sales.ts", root), "utf8"),
    readFile(new URL("db/analytics.ts", root), "utf8"),
    readFile(new URL("app/admin/analytics/AnalyticsDashboard.tsx", root), "utf8"),
    readFile(new URL("app/admin/sales-classification.ts", root), "utf8"),
    readFile(new URL("app/pricing-config.ts", root), "utf8"),
  ]);

  const sideRailStart = adminSource.indexOf('<aside className="admin-side-rail"');
  const summaryStart = adminSource.indexOf('<section className="admin-overview-strip"');
  const sharedSalesPlacement = adminSource.indexOf("<SharedSalesPanel", sideRailStart);
  assert.ok(sideRailStart >= 0 && sharedSalesPlacement > sideRailStart);
  assert.ok(sharedSalesPlacement < summaryStart);
  assert.match(adminSource, /setSharedSalesDraft\(emptySharedSales\(date\)\)/);
  assert.match(adminSource, /공용 부가매출 결제수단별 누적 합계/);
  assert.match(adminSource, /지금 입력한 판매 금액/);
  assert.match(adminSource, /현재 합계/);
  assert.match(
    adminSource,
    /<strong>\{won\(sharedSalesTotal\(sales, unitPrices\)\)\}원<\/strong>/,
  );
  assert.match(adminSource, /\{ value: "other", label: "양말" \}/);
  assert.match(pricingSource, /youthPass10Price: 45_000/);
  assert.match(pricingSource, /youthPass20Price: 80_000/);
  assert.match(pricingSource, /adultPass10Price: 60_000/);
  assert.match(pricingSource, /adultPass20Price: 110_000/);
  assert.match(adminSource, /label: "청소년 10회"/);
  assert.match(adminSource, /label: "성인 20회"/);
  assert.doesNotMatch(adminSource, /label: "청소년 10회권"/);
  assert.match(adminSource, /const \[passesOpen, setPassesOpen\] = useState\(false\)/);
  assert.match(adminSource, /aria-expanded=\{passesOpen\}/);
  assert.match(adminSource, /passesOpen \? "접기 ▲" : "펼치기 ▼"/);
  assert.match(
    adminSource,
    /sharedSalesAmountByMethod\(totalSales, method\.value, unitPrices\)/,
  );
  const kpiLabels = ["예약금", "취소 수수료", "카드", "현금", "계좌", "총 매출", "게임건수", "인원"];
  const kpiSection = adminSource.slice(summaryStart, adminSource.indexOf("</section>", summaryStart));
  let previousKpi = -1;
  for (const label of kpiLabels) {
    const position = kpiSection.indexOf(`<span>${label}</span>`);
    assert.ok(position > previousKpi, `${label} KPI 순서가 올바르지 않습니다.`);
    previousKpi = position;
  }
  assert.match(
    dailySalesSource,
    /daily_shared_sales\.slush_card_count \+ excluded\.slush_card_count/,
  );
  assert.match(
    dailySalesSource,
    /daily_shared_sales\.beverage_account_count \+ excluded\.beverage_account_count/,
  );
  assert.match(
    dailySalesSource,
    /daily_shared_sales\.other_card_count \+ excluded\.other_card_count/,
  );
  assert.match(
    dailySalesSource,
    /daily_shared_sales\.adult_pass_20_account_count \+ excluded\.adult_pass_20_account_count/,
  );
  assert.match(dailySalesSource, /replaceDailySharedSales/);
  assert.match(dailySalesSource, /slush_card_count = excluded\.slush_card_count/);
  assert.match(salesClassificationSource, /row\.slush_card_count \* pricing\.slushPrice/);
  assert.match(salesClassificationSource, /row\.other_card_count \* pricing\.otherPrice/);
  assert.match(salesClassificationSource, /row\.youth_pass_10_card_count \* pricing\.youthPass10Price/);
  assert.match(salesClassificationSource, /row\.adult_pass_20_account_count \* pricing\.adultPass20Price/);
  assert.match(analyticsSource, /date\((?:reservations\.)?cancelled_at, '\+9 hours'\) = (?:reservations\.)?scheduled_date/);
  assert.match(analyticsSource, /bucket\.cancellationFee = sales\.cancellationFee/);
  assert.match(salesClassificationSource, /gameDeposit: cancellationFeeAmount/);
  assert.match(adminSource, /pricing\.naverCancellationFeeAmount/);
  assert.match(adminSource, /네이버 당일 취소/);
  assert.match(analyticsUiSource, /기타 부가매출/);
  assert.match(analyticsUiSource, /summary\.sharedOther/);
  assert.match(analyticsUiSource, /summary\.passes/);
  assert.match(analyticsUiSource, /게임비 매출/);
  assert.match(analyticsUiSource, /부가매출/);
  assert.match(analyticsUiSource, /day\.gameDeposit/);
  assert.match(analyticsUiSource, /day\.gameRevenue/);
  assert.match(analyticsUiSource, /day\.gameCard/);
  assert.match(analyticsUiSource, /day\.addOnRevenue/);
  assert.match(analyticsUiSource, /day\.addOnCard/);
  assert.match(analyticsUiSource, /취소수수료 포함/);
  assert.match(analyticsSource, /bucket\.gameRevenue = sales\.gameRevenue/);
  assert.match(analyticsSource, /bucket\.addOnRevenue = sales\.addOnRevenue/);
});

test("이용 가능 시각은 크게 표시되고 수동 시작은 팀명만 전송한다", async () => {
  const [adminSource, cssSource] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);

  assert.match(adminSource, /<b>\{availability\.availableAt\} 예상<\/b>/);
  assert.doesNotMatch(adminSource, /· \$\{availability\.availableAt\} 예상/);
  assert.match(adminSource, /mapIndex: manualStartOnly \? 0 : difficulty\.mapIndex/);
  assert.match(adminSource, /mapIndex: manualStartOnly \? 0 : reservation\.mapIndex/);
  assert.match(adminSource, /mapIndex: informationOnly \? 0 : room\?\.mapIndex \?\? 0/);
  assert.match(adminSource, /manualStartMode\s*\? !room\.teamName/);
  assert.match(adminSource, /useState\(true\)/);
  assert.doesNotMatch(adminSource, /jumping-admin-manual-start-v2/);
  assert.match(cssSource, /\.room-availability > strong > b/);
  assert.match(cssSource, /flex-wrap: nowrap/);
});

test("예약 상세는 접을 수 있고 드래그는 이동 손잡이로 클릭과 분리된다", async () => {
  const [adminSource, cssSource] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);

  assert.match(adminSource, /aria-expanded=\{detailPanelOpen\}/);
  assert.match(adminSource, /상세 관리 접기/);
  assert.match(adminSource, /className="schedule-drag-handle"/);
  assert.match(adminSource, /suppressSelectionUntil/);
  assert.match(adminSource, /onPointerDown=\{\(event\) => beginPointerDrag/);
  assert.match(adminSource, /data-schedule-drop-key=\{key\}/);
  assert.match(adminSource, /useState\(false\)/);
  assert.match(adminSource, /mode: sharedSalesEditMode \? "replace" : "add"/);
  assert.match(cssSource, /\.reservation-detail-content\[hidden\]/);
  assert.match(cssSource, /\.schedule-drag-handle/);
  assert.match(cssSource, /\.admin-side-rail/);
});

test("관리자 예약 변경은 즉시 반영하고 짧은 주기로 안전하게 재검증한다", async () => {
  const adminSource = await readFile(
    new URL("app/admin/ReservationsAdmin.tsx", root),
    "utf8",
  );

  assert.match(adminSource, /type ReservationListChange/);
  assert.match(adminSource, /applyReservationListChange/);
  assert.match(adminSource, /sameReservationSnapshot/);
  assert.match(adminSource, /reservationRefreshDatesInFlight/);
  assert.match(
    adminSource,
    /window\.setInterval\(refreshVisibleReservations, 3_000\)/,
  );
  assert.match(
    adminSource,
    /window\.addEventListener\("focus", refreshVisibleReservations\)/,
  );
  assert.match(
    adminSource,
    /document\.addEventListener\("visibilitychange", refreshVisibleReservations\)/,
  );
  assert.match(adminSource, /onChanged=\{commitReservationChange\}/);
  assert.match(adminSource, /onSaved=\{commitReservationChange\}/);
  assert.doesNotMatch(
    adminSource,
    /setInterval\(\(\) => void refreshReservations\(true\), 15_000\)/,
  );
});

test("시간대 순서, 자동 완료, 완료 후 수정, 복합결제를 안전하게 처리한다", async () => {
  const [adminSource, reservationSource, autoCompleteSource, gameHistoryUtils, analyticsSource] =
    await Promise.all([
      readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
      readFile(new URL("db/reservations.ts", root), "utf8"),
      readFile(new URL("app/api/agent/auto-complete.ts", root), "utf8"),
      readFile(new URL("app/admin/game-history-utils.ts", root), "utf8"),
      readFile(new URL("db/analytics.ts", root), "utf8"),
    ]);

  assert.match(adminSource, /SCHEDULE_ROOM_CODES = \["C2", "B1", "C1", "A1"\]/);
  assert.match(adminSource, /disabled=\{isCancelled\}/);
  assert.match(adminSource, /paymentCardAmount: split\.card/);
  assert.match(adminSource, /paymentCashAmount: split\.cash/);
  assert.match(adminSource, /paymentAccountAmount: split\.account/);
  assert.match(reservationSource, /PAYMENT_SPLIT_MISMATCH/);
  assert.match(reservationSource, /const paymentStatus = "paid"/);
  assert.doesNotMatch(
    reservationSource,
    /command\.paymentAmount > 0 \? "paid" : "unpaid"/,
  );
  assert.match(reservationSource, /auto_complete_game_stopped/);
  assert.match(reservationSource, /resolveImportedOperationalState/);
  assert.match(reservationSource, /locally_completed/);
  assert.match(
    reservationSource,
    /difficulty_code = CASE WHEN details_overridden = 1 THEN difficulty_code ELSE \? END/,
  );
  assert.match(autoCompleteSource, /isStoppedGameTransition/);
  assert.match(gameHistoryUtils, /previousStatus === "running"/);
  assert.match(gameHistoryUtils, /nextStatus === "waiting"/);
  assert.match(analyticsSource, /getMonthlyAnalytics/);
});

test("moved Naver bookings block the manager-selected room and ignore source completion", async () => {
  const [reservationSource, stockSource, sourceState] = await Promise.all([
    readFile(new URL("db/reservations.ts", root), "utf8"),
    readFile(new URL("db/naver-stock.ts", root), "utf8"),
    readFile(
      new URL("app/api/import/reservations/source-state.ts", root),
      "utf8",
    ),
  ]);

  assert.match(reservationSource, /schedule_overridden === 1/);
  assert.match(reservationSource, /effectiveRoom/);
  assert.match(stockSource, /event_type IN \('assign', 'move', 'details'\)/);
  assert.match(stockSource, /status IN \('booked', 'arrived', 'completed'\)/);
  assert.match(sourceState, /if \(sourceState === "cancelled"\) return "cancelled"/);
  assert.match(sourceState, /return "booked"/);
});

test("예약표에서 입장을 즉시 처리하고 원복하며 상세 화면에서 수동 완료할 수 있다", async () => {
  const [adminSource, reservationSource, cssSource] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("db/reservations.ts", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);

  assert.match(adminSource, /className=\{`schedule-arrival-toggle/);
  assert.match(adminSource, /"● 입장 완료 · 원복"/);
  assert.match(adminSource, /action: "arrive" \| "undo_arrive"/);
  assert.match(adminSource, /<th className="schedule-total-column">합계<\/th>/);
  assert.match(adminSource, /action: "complete"/);
  assert.match(adminSource, /className="quick-complete-button"/);
  assert.match(adminSource, /"이용완료"\}<\/button>/);
  assert.match(reservationSource, /\| \{ action: "undo_arrive" \}/);
  assert.match(
    reservationSource,
    /status = 'booked'.+status = 'arrived'/,
  );
  assert.match(cssSource, /\.schedule-reservation-item\.cell-arrived/);
  assert.match(cssSource, /background: #6d28d9/);
  assert.match(
    adminSource,
    /schedule-source-row[\s\S]+schedule-vehicle-badge[\s\S]+schedule-cell-bottom[\s\S]+difficultyLabel/,
  );
  assert.match(cssSource, /\.schedule-reservation-chip \{[\s\S]+min-height: 48px/);
  assert.match(cssSource, /\.schedule-source-row \{[\s\S]+white-space: nowrap/);
});

test("예약표는 기본 활성화된 지난 시간 숨김 토글로 현재 바로 이전 시간부터 표시한다", async () => {
  const [adminSource, cssSource] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);

  assert.match(
    adminSource,
    /const \[hidePastSlots, setHidePastSlots\] = useState\(true\)/,
  );
  assert.match(adminSource, /지난 시간 숨김/);
  assert.match(
    adminSource,
    /OPERATING_SLOTS\.slice\(Math\.max\(0, currentSlotIndex - 1\)\)/,
  );
  assert.match(adminSource, /visibleOperatingSlots\.map/);
  assert.match(adminSource, /disabled=\{selectedDate !== today\}/);
  assert.match(cssSource, /\.schedule-past-toggle input:checked/);
});

test("예약 현황 크게 보기는 같은 관리 기능을 전용 화면에서 연다", async () => {
  const [adminSource, schedulePage, cssSource] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("app/admin/schedule/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);

  assert.match(adminSource, /className="schedule-expand-link"/);
  assert.match(adminSource, /\/admin\/schedule\?date=/);
  assert.match(adminSource, /target="_blank"/);
  assert.match(adminSource, /scheduleOnly/);
  assert.match(schedulePage, /initialSelectedDate/);
  assert.match(schedulePage, /scheduleOnly/);
  assert.match(cssSource, /\.admin-schedule-only-shell/);
  assert.match(cssSource, /height: 100dvh/);
  assert.match(
    cssSource,
    /\.admin-schedule-only-shell \.schedule-panel \{[\s\S]*flex: 1 1 auto/,
  );
  assert.match(
    cssSource,
    /\.admin-schedule-only-shell \.schedule-scroll \{[\s\S]*max-height: none;[\s\S]*flex: 1 1 auto/,
  );
});

test("고객 예약은 오늘만 단계별로 접수하고 차량번호를 예약표에 바로 표시한다", async () => {
  const [reserveSource, reservePage, reservationApi, reservationConfig, adminSource, cssSource] =
    await Promise.all([
      readFile(new URL("app/reserve/ReserveForm.tsx", root), "utf8"),
      readFile(new URL("app/reserve/page.tsx", root), "utf8"),
      readFile(new URL("app/api/reservations/route.ts", root), "utf8"),
      readFile(new URL("app/reservation-config.ts", root), "utf8"),
      readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
      readFile(new URL("app/globals.css", root), "utf8"),
    ]);

  assert.match(reserveSource, /type Step = 1 \| 2 \| 3 \| 4/);
  assert.match(reserveSource, /직원이 안내한 방을/);
  assert.match(reserveSource, /자동 배정된 가장 빠른 시간/);
  assert.match(reserveSource, /scheduledDate: today/);
  assert.match(reserveSource, /동의하고 예약 접수/);
  assert.match(reserveSource, /enterKeyHint="next"/);
  assert.match(reserveSource, /inputId="reserve-team-name"/);
  assert.match(reserveSource, /kind="korean"/);
  assert.match(reserveSource, /inputId="reserve-vehicle-last4"/);
  assert.match(reserveSource, /kind="numeric"/);
  assert.match(reserveSource, /난이도 선택하기/);
  assert.match(reserveSource, /인원·팀명 입력하기/);
  assert.doesNotMatch(
    reserveSource,
    /step === 2 && \(totalCount < 1 \|\| !teamName\.trim\(\)\)/,
  );
  assert.match(reserveSource, /필수안내를 확인했고 동의합니다/);
  assert.match(
    reserveSource,
    /부주의로 인한 사고·부상 및 LED로 인한 어지러움\/구토 등의/,
  );
  assert.doesNotMatch(reserveSource, /이용 전 꼭 확인해주세요/);
  assert.doesNotMatch(reserveSource, /안전수칙과 입장 예정 시간을 모두 확인했습니다/);
  assert.match(reserveSource, /window\.visualViewport/);
  assert.match(reserveSource, /setInterval\(refreshAvailability, 5_000\)/);
  assert.match(reserveSource, /visibilitychange/);
  assert.match(reserveSource, /scrollIntoView/);
  assert.doesNotMatch(reserveSource, /autoFocus/);
  assert.doesNotMatch(reserveSource, /type="date"/);
  assert.doesNotMatch(reserveSource, /입장 예정 시간<\/span>\s*<select/);
  assert.doesNotMatch(reserveSource, /<span>오늘 입장 예정<\/span>/);
  assert.match(reservationApi, /const minimumTime = nextBookableTime\(\)/);
  assert.match(
    reservationConfig,
    /CUSTOMER_CURRENT_SLOT_LAST_MINUTE = 3/,
  );
  assert.doesNotMatch(reservePage, /maxDate/);
  assert.match(reservationApi, /return value === dateInSeoul\(\)/);
  assert.match(reservationApi, /await listOccupiedSlots\(scheduledDate\)/);
  assert.match(reservationApi, /!occupiedKeys\.has\(`\$\{roomCode\}\|\$\{time\}`\)/);
  assert.match(adminSource, /className="schedule-vehicle-badge"/);
  assert.match(adminSource, /차량 \{reservation\.vehicleLast4\}/);
  assert.match(cssSource, /\.reserve-step-actions/);
  assert.match(cssSource, /bottom: var\(--reserve-keyboard-inset, 0px\)/);
  assert.match(cssSource, /\.schedule-vehicle-badge/);
});

test("고객 예약 화면은 관리자 앱과 별개의 설치 앱으로 제공된다", async () => {
  const [rootLayout, homePage, adminLayout, adminManifest, reserveManifest, reservePage, reserveSource, cssSource] = await Promise.all([
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/admin/layout.tsx", root), "utf8"),
    readFile(new URL("app/manifest.ts", root), "utf8"),
    readFile(new URL("app/reserve/manifest.webmanifest/route.ts", root), "utf8"),
    readFile(new URL("app/reserve/page.tsx", root), "utf8"),
    readFile(new URL("app/reserve/ReserveForm.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);

  assert.match(adminManifest, /id: "\/admin"/);
  assert.match(adminManifest, /scope: "\/admin"/);
  assert.doesNotMatch(rootLayout, /manifest: "\/manifest\.webmanifest"/);
  assert.match(homePage, /manifest: "\/manifest\.webmanifest"/);
  assert.match(adminLayout, /manifest: "\/manifest\.webmanifest"/);
  assert.match(reserveManifest, /name: "점핑배틀 고객 예약"/);
  assert.match(reserveManifest, /id: "\/reserve"/);
  assert.match(reserveManifest, /start_url: "\/reserve"/);
  assert.match(reservePage, /manifest: "\/reserve\/manifest\.webmanifest"/);
  assert.match(reserveSource, /beforeinstallprompt/);
  assert.match(reserveSource, /className="reserve-install-button"/);
  assert.match(cssSource, /\.reserve-install-button \{/);
});

test("고객이 단계 입력을 마치면 펭귄이 다음 버튼을 안내한다", async () => {
  const [reserveSource, reservePage, cssSource, keyboardCss, penguin] = await Promise.all([
    readFile(new URL("app/reserve/ReserveForm.tsx", root), "utf8"),
    readFile(new URL("app/reserve/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL("app/kiosk/kiosk-keyboard.css", root), "utf8"),
    readFile(new URL("public/reservation-penguin.png", root)),
  ]);

  assert.match(reserveSource, /STEP_COMPLETION_MESSAGES/);
  assert.match(reserveSource, /const stepReady = !validateStep\(step\)/);
  assert.doesNotMatch(reserveSource, /showStepNudge/);
  assert.match(reservePage, /KioskKeyboardProvider/);
  assert.match(reservePage, /kiosk-keyboard\.css/);
  assert.match(reserveSource, /useKioskKeyboard/);
  assert.match(reserveSource, /activeId === "reserve-team-name"/);
  assert.match(reserveSource, /inputId="reserve-team-name"/);
  assert.match(reserveSource, /step === 2 && teamInputFocused \? "is-team-input-focused"/);
  assert.match(reserveSource, /src="\/reservation-penguin\.png"/);
  assert.match(reserveSource, /아래 버튼을 눌러 난이도를 골라요/);
  assert.match(reserveSource, /동의가 완료됐어요/);
  assert.match(reserveSource, /아래 예약 접수 버튼을 눌러주세요/);
  assert.match(reserveSource, /inputId="reserve-vehicle-last4"/);
  assert.match(reserveSource, /closeKioskKeyboard\(\)/);
  assert.match(reserveSource, /safetyAgreementRef\.current\?\.scrollIntoView/);
  assert.match(cssSource, /@keyframes reserve-penguin-rise/);
  assert.match(cssSource, /\.reserve-step-actions\.has-step-ready \.step-next-button/);
  assert.match(cssSource, /\.reserve-step-nudge\.is-team-input-focused/);
  assert.match(keyboardCss, /@media \(max-width: 560px\)/);
  assert.match(keyboardCss, /min-height: 50px/);
  assert.match(cssSource, /pointer-events: none/);
  assert.match(cssSource, /prefers-reduced-motion: reduce/);
  assert.deepEqual([...penguin.subarray(0, 8)], [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  assert.ok(penguin.length > 100_000);
});

test("B1 관리자 맵 선택은 대형과 중형 모드를 모두 제공하고 상태를 빠르게 갱신한다", async () => {
  const [configSource, adminSource] = await Promise.all([
    readFile(new URL("app/reservation-config.ts", root), "utf8"),
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
  ]);

  assert.match(configSource, /B1_MEDIUM_DIFFICULTY_OPTIONS/);
  assert.match(configSource, /code: "b1-medium-basic".+mapIndex: 11/);
  assert.match(configSource, /code: "b1-medium-kids".+mapIndex: 18/);
  assert.match(configSource, /roomCode === "B1" \? B1_DIFFICULTY_OPTIONS/);
  assert.match(adminSource, /getDifficultyOptions\(roomCode\)/);
  assert.match(adminSource, /setInterval\(refreshVisibleStatus, 1_000\)/);
  assert.match(adminSource, /correctedRemainingSeconds\(room, serverNow\)/);
  assert.match(adminSource, /hasRunningRoom \? 1_000 : 30_000/);
  assert.match(adminSource, /roomRunning \? formatRemaining\(liveRemainingSeconds\) : "00:00"/);
  assert.doesNotMatch(adminSource, /"동기화 대기"/);
  assert.doesNotMatch(adminSource, /"상태 갱신 중"/);
  assert.match(adminSource, /controlState === "ERROR" \|\| controlState === "DEGRADED"/);
  assert.match(adminSource, /void refreshStatus\(\), 650/);
  assert.match(adminSource, /void refreshStatus\(\), 1_500/);
});

test("Naver schedule cards show the customer name beside the source label", async () => {
  const [adminSource, cssSource] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);

  assert.match(adminSource, /reservation\.source === "naver" && reservation\.customerName/);
  assert.match(adminSource, /schedule-naver-customer/);
  assert.match(adminSource, /예약자 \{reservation\.customerName\}/);
  assert.match(cssSource, /\.schedule-source-row/);
  assert.match(cssSource, /\.schedule-naver-customer/);
});

test("Naver difficulty labels initialize the booking editor with the imported game", async () => {
  const [configSource, adminSource, importSource] = await Promise.all([
    readFile(new URL("app/reservation-config.ts", root), "utf8"),
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("app/api/import/reservations/route.ts", root), "utf8"),
  ]);

  assert.match(configSource, /resolveReservationDifficultyCode/);
  assert.match(configSource, /embeddedCode/);
  assert.match(adminSource, /initialReservation\.difficultyLabel/);
  assert.match(adminSource, /resolveReservationDifficultyCode/);
  assert.match(importSource, /const difficulty = getDifficulty\(row\[9\]\)/);
});

test("native Naver bookings stay excluded while admin-moved Naver bookings block stock", async () => {
  const [stockSource, reservationSource, adminSource] = await Promise.all([
    readFile(new URL("db/naver-stock.ts", root), "utf8"),
    readFile(new URL("db/reservations.ts", root), "utf8"),
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
  ]);

  assert.match(stockSource, /status IN \('booked', 'arrived', 'completed'\)/);
  assert.match(stockSource, /source <> 'naver'[\s\S]*OR schedule_overridden = 1/);
  assert.match(
    reservationSource,
    /CASE WHEN schedule_overridden = 1 THEN scheduled_date ELSE \? END/,
  );
  assert.doesNotMatch(stockSource, /naver_stock_overrides/);
  assert.doesNotMatch(adminSource, /schedule-stock-control/);
  assert.doesNotMatch(adminSource, /api\/admin\/naver-stock/);
});

test("한판 더는 복사된 예약 편집창을 즉시 열고 원격 입력은 인원을 건드리지 않는다", async () => {
  const [adminSource, commandSource, controlTypes] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("app/api/commands/route.ts", root), "utf8"),
    readFile(new URL("app/types.ts", root), "utf8"),
  ]);

  assert.match(adminSource, /onOpenCopied\(data\.reservation\)/);
  assert.match(adminSource, /function openCopiedReservation\(reservation: ReservationRecord\)/);
  assert.match(adminSource, /reservation: data\.reservation/);
  assert.match(adminSource, /skipPeople: true/);
  assert.match(adminSource, /people: 0/);
  assert.match(adminSource, /인원은 변경하지 않았습니다/);
  assert.match(commandSource, /const skipPeople = input\.skipPeople === true/);
  assert.match(controlTypes, /skipPeople\?: boolean/);
});

test("예약표 복사 손잡이는 원본과 결제를 유지하지 않고 원하는 칸에 복제한다", async () => {
  const [adminSource, routeSource, reservationSource, cssSource] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("app/api/admin/reservations/route.ts", root), "utf8"),
    readFile(new URL("db/reservations.ts", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);

  assert.match(adminSource, /schedule-copy-handle/);
  assert.match(adminSource, /beginPointerDrag\(event, reservation, "copy"\)/);
  assert.match(adminSource, /schedule-copy-handle \$\{reservation\.status === "completed" \? "is-only" : ""\}/);
  const copyHandlerSegment = adminSource.slice(
    adminSource.indexOf("async function copyReservationTo"),
    adminSource.indexOf("function endPointerDrag"),
  );
  assert.doesNotMatch(copyHandlerSegment, /reservation\.status === "completed"/);
  assert.match(adminSource, /copyFromId: reservation\.id,[\s\S]+scheduledTime,[\s\S]+roomCode/);
  assert.match(routeSource, /copyReservationToSlot/);
  assert.match(reservationSource, /"schedule_copied"/);
  const copySegment = reservationSource.slice(
    reservationSource.indexOf("async function copyReservationRowToSlot"),
    reservationSource.indexOf("export async function copyReservationToSlot"),
  );
  assert.doesNotMatch(copySegment, /payment_amount/);
  assert.match(cssSource, /\.schedule-copy-handle \{[\s\S]+right: 49px/);
  assert.match(cssSource, /\.schedule-copy-handle\.is-only \{[\s\S]+right: 5px/);
  assert.match(cssSource, /\.schedule-drop-zone\.is-copy-target/);
  assert.match(adminSource, /schedule-cell-bottom[\s\S]+schedule-people-count/);
  assert.match(cssSource, /\.schedule-people-count \{/);
  assert.match(cssSource, /\.schedule-cell-top,[\s\S]+\.schedule-source-row \{[\s\S]+padding-right: 86px/);
});

test("예약 직접 입력에서 팀명과 차량번호를 바로 복사한다", async () => {
  const [adminSource, cssSource] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);

  assert.match(adminSource, /navigator\.clipboard\.writeText\(normalized\)/);
  assert.match(adminSource, /aria-label="팀명 복사"/);
  assert.match(adminSource, /aria-label="차량번호 복사"/);
  assert.match(adminSource, /주차등록/);
  assert.match(adminSource, /DRY RUN/);
  assert.match(adminSource, /disabled=\{!teamName\.trim\(\)\}/);
  assert.match(adminSource, /disabled=\{!vehicleLast4\.trim\(\)\}/);
  assert.match(cssSource, /\.quick-copy-field/);
  assert.match(cssSource, /\.quick-parking-register/);
});

test("wide admin layout keeps live controls readable and shows more schedule rows", async () => {
  const cssSource = await readFile(new URL("app/globals.css", root), "utf8");

  assert.match(cssSource, /@media \(min-width: 1700px\)/);
  assert.match(cssSource, /"timer availability"/);
  assert.match(cssSource, /grid-area: availability/);
  assert.match(cssSource, /min-height: 84px/);
  assert.match(
    cssSource,
    /height: clamp\(440px, calc\(100vh - 410px\), 720px\)/,
  );
  assert.match(cssSource, /\.schedule-table thead th \{[\s\S]*position: sticky/);
});

test("admin header tools, compact KPI row, and optional control freeze share the first viewport", async () => {
  const [adminSource, cssSource] = await Promise.all([
    readFile(new URL("app/admin/ReservationsAdmin.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);

  assert.match(adminSource, /className="admin-topbar-tools"/);
  assert.match(adminSource, /className="admin-overview-strip"/);
  assert.doesNotMatch(adminSource, /오늘 운영 현황/);
  assert.match(adminSource, /CONTROL_PIN_STORAGE_KEY/);
  assert.match(adminSource, /aria-pressed=\{controlPinned\}/);
  assert.match(cssSource, /\.admin-main-column\.is-control-pinned \.admin-control-stack/);
  assert.match(cssSource, /position: sticky/);
  assert.match(cssSource, /height: clamp\(320px, calc\(100vh - 520px\), 720px\)/);
});

test("admin room cards use the compact remaining-time label", async () => {
  const adminSource = await readFile(
    new URL("app/admin/ReservationsAdmin.tsx", root),
    "utf8",
  );

  assert.match(adminSource, />실제 남은시간</);
  assert.doesNotMatch(adminSource, /컨트롤러 실제 남은시간/);
});
