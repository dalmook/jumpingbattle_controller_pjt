import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../app/admin/ReservationsAdmin.tsx", import.meta.url),
  "utf8",
);

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

const quickModal = section("export function QuickBookingModal", "function expectedAmount");
const reservationCard = section("function ReservationCard", "export default function ReservationsAdmin");
const terminalControls = section("export function TerminalPaymentControls", "function nextOperatingSlot");

test("reservation detail surfaces use domain operations instead of a global busy lock", () => {
  assert.doesNotMatch(quickModal, /const \[busy, setBusy\]/);
  assert.doesNotMatch(reservationCard, /const \[busy, setBusy\]/);
  assert.match(quickModal, /const controlBusy = operations\.control/);
  assert.match(quickModal, /const paymentBusy = operations\.payment/);
  assert.match(quickModal, /const memoBusy = operations\.memo/);
  assert.match(quickModal, /const parkingBusy = operations\.parking/);
  assert.match(reservationCard, /const reservationBusy = operations\.reservation/);
});

test("the same domain rejects a second operation while independent domains remain separate", () => {
  assert.match(source, /if \(operationsRef\.current\[domain\]\) return false/);
  assert.match(source, /if \(operationsRef\.current\[domain\] !== action\) return/);
  assert.match(quickModal, /startOperation\("control", action\)/);
  assert.match(quickModal, /startOperation\("payment", action\)/);
  assert.match(quickModal, /startOperation\("reservation", action\)/);
  assert.match(quickModal, /startOperation\("parking", action\)/);
});

test("manager input does not disable payment or memo controls", () => {
  assert.match(quickModal, /disabled=\{Boolean\(paymentBusy\) \|\| Boolean\(isCancelled\)/);
  assert.match(quickModal, /disabled=\{Boolean\(memoBusy\) \|\| Boolean\(isCancelled\)/);
  assert.doesNotMatch(quickModal, /<TerminalPaymentControls[\s\S]{0,500}disabled=\{[^}]*controlBusy/);
  assert.match(reservationCard, /disabled=\{Boolean\(paymentBusy\) \|\| reservation\.status === "cancelled"\}/);
  assert.match(reservationCard, /disabled=\{Boolean\(memoBusy\)\}/);
});

test("control and reservation conflicts remain blocked while read navigation stays available", () => {
  assert.match(quickModal, /const reservationControlBusy = Boolean\(reservationBusy \|\| controlBusy\)/);
  assert.match(reservationCard, /const reservationControlBusy = Boolean\(reservationBusy \|\| controlBusy\)/);
  assert.match(quickModal, /className="quick-cancel-button" onClick=\{onClose\}/);
  assert.match(reservationCard, /disabled=\{reservationControlBusy\}[\s\S]{0,120}deleteRecord/);
});

test("payment safety remains local to TerminalPaymentControls", () => {
  assert.match(terminalControls, /const \[busy, setBusy\] = useState\(""\)/);
  assert.match(terminalControls, /disabled=\{disabled \|\| Boolean\(busy\) \|\| !draftValid\}/);
  assert.match(terminalControls, /hasProcessing/);
  assert.match(terminalControls, /summary\?\.hasUnknown/);
});

test("each completion releases only its own domain and action", () => {
  assert.match(quickModal, /finishOperation\("control", action\)/);
  assert.match(quickModal, /finishOperation\("payment", action\)/);
  assert.match(quickModal, /finishOperation\("reservation", action\)/);
  assert.match(quickModal, /finishOperation\("parking", action\)/);
  assert.match(reservationCard, /finishOperation\(domain, command\.action\)/);
});
