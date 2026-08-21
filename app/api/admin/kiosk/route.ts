import { getOperator } from "@/app/operator";
import { clearKioskDeviceCookie, createKioskDeviceCookie, hasKioskDeviceSession } from "@/app/pin-auth";
import {
  confirmKioskManualPayment,
  deleteKioskTestVisit,
  forceReleaseKioskHold,
  getKioskVisitAdminDetails,
  listKioskOperations,
  markKioskVisitReady,
  moveKioskGuidance,
  moveKioskProduct,
  removeKioskGuidance,
  removeKioskProduct,
  removeKioskRoomRecommendationRule,
  previewKioskCleanup,
  runKioskBulkCleanup,
  saveKioskGuidance,
  saveKioskDisplaySettings,
  saveKioskProduct,
  saveKioskRoomRecommendationRule,
  setKioskProductStatus,
  startKioskGameFromDevice,
  terminateKioskVisit,
} from "@/db/customer-flow";

export async function GET(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    return Response.json({ ...(await listKioskOperations()), devicePaired: await hasKioskDeviceSession(request) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "키오스크 상태를 불러오지 못했습니다." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "");
    if (action === "pair_device") {
      return Response.json({ ...(await listKioskOperations()), devicePaired: true }, { headers: { "set-cookie": await createKioskDeviceCookie() } });
    }
    if (action === "unpair_device") {
      return Response.json({ ...(await listKioskOperations()), devicePaired: false }, { headers: { "set-cookie": clearKioskDeviceCookie() } });
    }
    if (action === "start_game") return Response.json(await startKioskGameFromDevice(String(body.visitId ?? ""), `operator:${operator.email}`), { status: 202 });
    if (action === "ready") return Response.json(await markKioskVisitReady(String(body.visitId ?? ""), operator.email), { status: 202 });
    if (action === "release") return Response.json(await forceReleaseKioskHold(String(body.visitId ?? ""), operator.email));
    if (action === "visit_details") return Response.json(await getKioskVisitAdminDetails(String(body.visitId ?? "")));
    if (action === "terminate_visit") return Response.json(await terminateKioskVisit(
      String(body.visitId ?? ""), operator.email, String(body.reason ?? "관리자 진행 종료"),
    ));
    if (action === "delete_test_visit") return Response.json(await deleteKioskTestVisit(
      String(body.visitId ?? ""), operator.email, String(body.reason ?? "테스트 데이터 정리"),
    ));
    if (action === "cleanup_preview") return Response.json({ cleanupPreview: await previewKioskCleanup() });
    if (action === "bulk_cleanup") return Response.json(await runKioskBulkCleanup(
      operator.email, String(body.reason ?? "관리자 일괄 정리"),
    ));
    if (action === "confirm_payment") return Response.json(await confirmKioskManualPayment(
      String(body.visitId ?? ""), String(body.transactionId ?? ""), operator.email,
    ));
    if (action === "product_status") return Response.json(await setKioskProductStatus(String(body.productCode ?? ""), String(body.status ?? ""), operator.email));
    if (action === "product_save") return Response.json(await saveKioskProduct({
      productCode: String(body.productCode ?? ""), name: String(body.name ?? ""), price: body.price, requestedBy: operator.email,
    }));
    if (action === "product_move") return Response.json(await moveKioskProduct(String(body.productCode ?? ""), Number(body.direction), operator.email));
    if (action === "product_remove") return Response.json(await removeKioskProduct(String(body.productCode ?? ""), operator.email));
    if (action === "guidance_save") return Response.json(await saveKioskGuidance({
      id: String(body.id ?? ""), placement: String(body.placement ?? ""),
      title: String(body.title ?? ""), summary: String(body.summary ?? ""), content: String(body.content ?? ""),
      agreementText: String(body.agreementText ?? ""), required: body.required === true,
      active: body.active !== false, requestedBy: operator.email,
    }));
    if (action === "guidance_move") return Response.json(await moveKioskGuidance(String(body.id ?? ""), Number(body.direction)));
    if (action === "guidance_remove") return Response.json(await removeKioskGuidance(String(body.id ?? "")));
    if (action === "display_settings_save") return Response.json(await saveKioskDisplaySettings({
      homeTitle: body.homeTitle, homeSubtitle: body.homeSubtitle, requestedBy: operator.email,
    }));
    if (action === "recommendation_save") return Response.json(await saveKioskRoomRecommendationRule({
      id: String(body.id ?? ""), name: String(body.name ?? ""),
      adultMin: body.adultMin, adultMax: body.adultMax, youthMin: body.youthMin, youthMax: body.youthMax,
      totalMin: body.totalMin, totalMax: body.totalMax, primarySize: body.primarySize,
      secondarySize: body.secondarySize, active: body.active !== false, priority: body.priority,
    }));
    if (action === "recommendation_remove") return Response.json(await removeKioskRoomRecommendationRule(String(body.id ?? "")));
    return Response.json({ error: "지원하지 않는 요청입니다." }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "키오스크 운영 요청에 실패했습니다." }, { status: 409 });
  }
}
