import test from "node:test";
import assert from "node:assert/strict";
import { applyHangulKey, backspaceHangul } from "../app/kiosk/hangul-composer.ts";
import { formatKoreanPhone } from "../app/kiosk/kiosk-input-utils.ts";

function typeKeys(keys) {
  return Array.from(keys).reduce((value, key) => applyHangulKey(value, key), "");
}

test("초성·중성·종성을 완성형 한글로 조합한다", () => {
  assert.equal(typeKeys("ㄱㅣㅁ"), "김");
  assert.equal(typeKeys("ㅁㅣㄴ"), "민");
  assert.equal(typeKeys("ㅅㅜ"), "수");
  assert.equal(typeKeys("ㄱㅣㅁㅁㅣㄴㅅㅜ"), "김민수");
  assert.equal(typeKeys("ㅂㅏㄱㅅㅓㅇㅠㄴ"), "박서윤");
  assert.equal(typeKeys("ㅇㅣㅎㅖㅅㅓ"), "이혜서");
  assert.equal(typeKeys("ㅊㅚㅇㅠㅈㅣㄴ"), "최유진");
});

test("쌍자음·복합모음·쌍받침을 조합한다", () => {
  assert.equal(typeKeys("ㄲㅏ"), "까");
  assert.equal(typeKeys("ㄱㅗㅏ"), "과");
  assert.equal(typeKeys("ㅇㅜㅓ"), "워");
  assert.equal(typeKeys("ㅇㅡㅣ"), "의");
  assert.equal(typeKeys("ㄱㅏㅂㅅ"), "값");
  assert.equal(typeKeys("ㅇㅣㄹㄱ"), "읽");
});

test("받침 뒤 모음은 다음 음절의 초성으로 이동한다", () => {
  assert.equal(typeKeys("ㄱㅏㄴㅏ"), "가나");
  assert.equal(typeKeys("ㄱㅏㅂㅅㅣ"), "갑시");
  assert.equal(typeKeys("ㅇㅣㄹㄱㅓ"), "일거");
  assert.equal(applyHangulKey("밖", "ㅏ"), "바까");
  assert.equal(applyHangulKey("있", "ㅓ"), "이써");
});

test("백스페이스는 조합 단위를 한 단계씩 분해한다", () => {
  assert.equal(backspaceHangul("값"), "갑");
  assert.equal(backspaceHangul("갑"), "가");
  assert.equal(backspaceHangul("과"), "고");
  assert.equal(backspaceHangul("고"), "ㄱ");
  assert.equal(backspaceHangul("까"), "ㄲ");
  assert.equal(backspaceHangul("ㄲ"), "ㄱ");
  assert.equal(backspaceHangul("ㄱ"), "");
});

test("띄어쓰기와 완성된 문자열을 보존한다", () => {
  let value = typeKeys("ㄱㅣㅁ");
  value = applyHangulKey(value, " ");
  value = Array.from("민수").reduce((current, key) => applyHangulKey(current, key), value);
  assert.equal(value, "김 민수");
});

test("휴대폰 번호는 raw 숫자를 유지한 채 표시용 하이픈만 적용한다", () => {
  assert.equal(formatKoreanPhone("010"), "010");
  assert.equal(formatKoreanPhone("0101234"), "010-1234");
  assert.equal(formatKoreanPhone("01012345678"), "010-1234-5678");
  assert.equal(formatKoreanPhone("010-1234-56789"), "010-1234-5678");
  assert.equal(formatKoreanPhone("010ABC12345678"), "010-1234-5678");
});
