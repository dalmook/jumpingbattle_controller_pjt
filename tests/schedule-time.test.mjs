import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../app/admin/schedule-time.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { currentOperatingSlot } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

const slots = ["16:00", "16:20", "16:40", "17:00"];

test("예약 시간은 시작 후 2분까지 현재로 유지하고 3분부터 다음 시간으로 넘긴다", () => {
  assert.equal(currentOperatingSlot("16:20", slots), "16:20");
  assert.equal(currentOperatingSlot("16:22", slots), "16:20");
  assert.equal(currentOperatingSlot("16:23", slots), "16:40");
});

test("첫 운영 전과 마지막 운영 이후에도 유효한 시간대를 반환한다", () => {
  assert.equal(currentOperatingSlot("09:00", slots), "16:00");
  assert.equal(currentOperatingSlot("23:00", slots), "17:00");
});
