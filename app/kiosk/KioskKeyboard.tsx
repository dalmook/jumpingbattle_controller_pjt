"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { applyHangulKey, backspaceHangul } from "./hangul-composer";
import { formatKoreanPhone } from "./kiosk-input-utils";

export { formatKoreanPhone };

export type KioskKeyboardKind = "korean" | "english" | "numeric";

type KeyboardConfig = {
  id: string;
  label: string;
  kind: KioskKeyboardKind;
  value: string;
  onValueChange: (value: string) => void;
  maxLength?: number;
  secure?: boolean;
  allowModeSwitch?: boolean;
  allowDigits?: boolean;
  allowSymbols?: boolean;
  enterKeyHint?: "next" | "done" | "search";
  formatter?: (value: string) => string;
};

type ActiveKeyboard = KeyboardConfig & {
  anchor: HTMLInputElement;
  mode: KioskKeyboardKind;
};

type KeyboardContextValue = {
  activeId: string;
  open: (anchor: HTMLInputElement, config: KeyboardConfig) => void;
  close: () => void;
  syncValue: (id: string, value: string, config: Omit<KeyboardConfig, "id" | "value">) => void;
};

const KeyboardContext = createContext<KeyboardContextValue | null>(null);

const NUMBER_ROW = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
const SHIFTED_NUMBERS = ["!", "@", "#", "$", "%", "^", "&", "*", "(", ")"];
const KOREAN_ROWS = [
  ["ㅂ", "ㅈ", "ㄷ", "ㄱ", "ㅅ", "ㅛ", "ㅕ", "ㅑ", "ㅐ", "ㅔ"],
  ["ㅁ", "ㄴ", "ㅇ", "ㄹ", "ㅎ", "ㅗ", "ㅓ", "ㅏ", "ㅣ"],
  ["ㅋ", "ㅌ", "ㅊ", "ㅍ", "ㅠ", "ㅜ", "ㅡ"],
];
const SHIFTED_KOREAN: Record<string, string> = {
  "ㅂ": "ㅃ",
  "ㅈ": "ㅉ",
  "ㄷ": "ㄸ",
  "ㄱ": "ㄲ",
  "ㅅ": "ㅆ",
  "ㅐ": "ㅒ",
  "ㅔ": "ㅖ",
};
const ENGLISH_ROWS = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"],
];

function limitText(value: string, maxLength?: number) {
  if (!maxLength) return value;
  return Array.from(value).slice(0, maxLength).join("");
}

function maskValue(value: string) {
  return "•".repeat(Array.from(value).length);
}

function isPrintableKey(event: ReactKeyboardEvent<HTMLInputElement>) {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

export function useKioskKeyboard() {
  const context = useContext(KeyboardContext);
  if (!context) throw new Error("useKioskKeyboard must be used inside KioskKeyboardProvider");
  return context;
}

export function KioskKeyboardProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveKeyboard | null>(null);
  const [draftValue, setDraftValue] = useState("");
  const [shifted, setShifted] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const keyboardRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<ActiveKeyboard | null>(null);
  const draftValueRef = useRef("");
  const frameRef = useRef<number | null>(null);

  const close = useCallback(() => {
    const session = activeRef.current;
    activeRef.current = null;
    draftValueRef.current = "";
    setActive(null);
    setDraftValue("");
    setShifted(false);
    setPosition({ visibility: "hidden" });
    if (session?.anchor.isConnected) session.anchor.blur();
  }, []);

  const updatePosition = useCallback(() => {
    const session = activeRef.current;
    const keyboard = keyboardRef.current;
    if (!session || !keyboard || !session.anchor.isConnected) {
      if (session && !session.anchor.isConnected) close();
      return;
    }
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const viewportRight = viewportLeft + viewportWidth;
    const viewportBottom = viewportTop + viewportHeight;
    const margin = Math.max(16, Math.min(24, viewportWidth * 0.02));
    const gap = 14;
    const anchor = session.anchor.getBoundingClientRect();
    const keyboardRect = keyboard.getBoundingClientRect();
    const width = Math.min(keyboardRect.width, viewportWidth - margin * 2);
    const height = Math.min(keyboardRect.height, viewportHeight - margin * 2);
    const below = anchor.bottom + gap;
    const above = anchor.top - gap - height;
    let top = below + height <= viewportBottom - margin ? below : above;
    if (top < viewportTop + margin) {
      top = Math.max(viewportTop + margin, Math.min(below, viewportBottom - margin - height));
    }
    const anchorCenter = anchor.left + anchor.width / 2;
    const left = Math.max(viewportLeft + margin, Math.min(anchorCenter - width / 2, viewportRight - margin - width));
    setPosition({
      visibility: "visible",
      left: `${Math.round(left)}px`,
      top: `${Math.round(top)}px`,
      width: `${Math.round(width)}px`,
      maxHeight: `${Math.max(320, Math.round(viewportHeight - margin * 2))}px`,
    });
  }, [close]);

  const schedulePosition = useCallback(() => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      updatePosition();
    });
  }, [updatePosition]);

  const open = useCallback((anchor: HTMLInputElement, config: KeyboardConfig) => {
    if (activeRef.current?.id === config.id && activeRef.current.anchor === anchor) {
      activeRef.current = { ...activeRef.current, ...config, value: draftValueRef.current };
      return;
    }
    const mode = config.kind;
    const next = { ...config, anchor, mode };
    activeRef.current = next;
    draftValueRef.current = config.value;
    setActive(next);
    setDraftValue(config.value);
    setShifted(false);
    setPosition({ visibility: "hidden" });
    anchor.focus({ preventScroll: true });
    anchor.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    window.requestAnimationFrame(() => window.requestAnimationFrame(schedulePosition));
  }, [schedulePosition]);

  const syncValue = useCallback((id: string, value: string, config: Omit<KeyboardConfig, "id" | "value">) => {
    const session = activeRef.current;
    if (!session || session.id !== id) return;
    const next = { ...session, ...config, value };
    activeRef.current = next;
    if (draftValueRef.current !== value) {
      draftValueRef.current = value;
      setDraftValue(value);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const recalculate = () => schedulePosition();
    const viewport = window.visualViewport;
    window.addEventListener("resize", recalculate);
    window.addEventListener("orientationchange", recalculate);
    window.addEventListener("scroll", recalculate, true);
    viewport?.addEventListener("resize", recalculate);
    viewport?.addEventListener("scroll", recalculate);
    return () => {
      window.removeEventListener("resize", recalculate);
      window.removeEventListener("orientationchange", recalculate);
      window.removeEventListener("scroll", recalculate, true);
      viewport?.removeEventListener("resize", recalculate);
      viewport?.removeEventListener("scroll", recalculate);
    };
  }, [active, schedulePosition]);

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
  }, []);

  const commit = useCallback((producer: (current: string, session: ActiveKeyboard) => string) => {
    const session = activeRef.current;
    if (!session) return;
    const next = limitText(producer(draftValueRef.current, session), session.maxLength);
    draftValueRef.current = next;
    setDraftValue(next);
    session.onValueChange(next);
  }, []);

  const insert = useCallback((key: string) => {
    commit((current, session) => session.mode === "korean" ? applyHangulKey(current, key) : `${current}${key}`);
    if (shifted) setShifted(false);
  }, [commit, shifted]);

  const erase = useCallback(() => {
    commit((current, session) => session.mode === "korean" ? backspaceHangul(current) : Array.from(current).slice(0, -1).join(""));
  }, [commit]);

  const clear = useCallback(() => commit(() => ""), [commit]);

  const switchMode = useCallback(() => {
    const session = activeRef.current;
    if (!session || session.kind === "numeric") return;
    const mode = session.mode === "korean" ? "english" : "korean";
    const next = { ...session, mode };
    activeRef.current = next;
    setActive(next);
    setShifted(false);
    window.requestAnimationFrame(schedulePosition);
  }, [schedulePosition]);

  const focusNext = useCallback(() => {
    const session = activeRef.current;
    if (!session) return;
    const fields = Array.from(document.querySelectorAll<HTMLInputElement>("input[data-kiosk-input='true']:not(:disabled)"));
    const current = fields.indexOf(session.anchor);
    const next = current >= 0 ? fields[current + 1] : undefined;
    if (next) {
      next.click();
      return;
    }
    close();
  }, [close]);

  const contextValue = useMemo<KeyboardContextValue>(() => ({
    activeId: active?.id ?? "",
    open,
    close,
    syncValue,
  }), [active?.id, close, open, syncValue]);

  const hasNext = active ? (() => {
    const fields = Array.from(document.querySelectorAll<HTMLInputElement>("input[data-kiosk-input='true']:not(:disabled)"));
    const current = fields.indexOf(active.anchor);
    return current >= 0 && current < fields.length - 1;
  })() : false;

  return <KeyboardContext.Provider value={contextValue}>
    {children}
    {active && typeof document !== "undefined" ? createPortal(<div className="kiosk-keyboard-layer" role="presentation">
      <button type="button" className="kiosk-keyboard-backdrop" aria-label="키보드 닫기" onPointerDown={close} />
      <div
        ref={keyboardRef}
        className={`kiosk-floating-keyboard is-${active.mode}`}
        style={position}
        role="dialog"
        aria-modal="true"
        aria-label={`${active.label} 입력 키보드`}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <div><span>{active.mode === "numeric" ? "숫자 입력" : active.mode === "korean" ? "한글 입력" : "영문 입력"}</span><b>{active.label}</b></div>
          <strong aria-live="polite">{active.secure ? maskValue(draftValue) : draftValue ? active.formatter?.(draftValue) ?? draftValue : "입력해주세요"}</strong>
          <button type="button" onClick={close} aria-label="키보드 닫기">×</button>
        </header>
        {active.mode === "numeric" ? <NumericKeys onInsert={insert} onErase={erase} onClear={clear} onDone={hasNext ? focusNext : close} doneLabel={hasNext ? "다음" : "완료"} /> : <TextKeys
          mode={active.mode}
          shifted={shifted}
          allowDigits={active.allowDigits !== false}
          allowSymbols={active.allowSymbols === true}
          allowModeSwitch={active.allowModeSwitch !== false}
          onInsert={insert}
          onErase={erase}
          onClear={clear}
          onSpace={() => insert(" ")}
          onShift={() => setShifted((value) => !value)}
          onSwitchMode={switchMode}
          onDone={hasNext ? focusNext : close}
          doneLabel={hasNext ? "다음" : active.enterKeyHint === "search" ? "입력 완료" : "완료"}
        />}
      </div>
    </div>, document.body) : null}
  </KeyboardContext.Provider>;
}

function TextKeys({ mode, shifted, allowDigits, allowSymbols, allowModeSwitch, onInsert, onErase, onClear, onSpace, onShift, onSwitchMode, onDone, doneLabel }: {
  mode: "korean" | "english";
  shifted: boolean;
  allowDigits: boolean;
  allowSymbols: boolean;
  allowModeSwitch: boolean;
  onInsert: (key: string) => void;
  onErase: () => void;
  onClear: () => void;
  onSpace: () => void;
  onShift: () => void;
  onSwitchMode: () => void;
  onDone: () => void;
  doneLabel: string;
}) {
  const rows = mode === "korean" ? KOREAN_ROWS : ENGLISH_ROWS;
  return <div className="kiosk-keyboard-body text-keyboard">
    {allowDigits ? <div className="keyboard-key-row number-row">{NUMBER_ROW.map((key, index) => { const label = shifted && mode === "english" && allowSymbols ? SHIFTED_NUMBERS[index] : key; return <KeyButton key={key} label={label} onPress={() => onInsert(label)} />; })}</div> : null}
    {rows.map((row, rowIndex) => <div className="keyboard-key-row" key={rowIndex}>
      {rowIndex === 2 ? <KeyButton wide label="⇧" active={shifted} ariaLabel="Shift" onPress={onShift} /> : null}
      {row.map((key) => {
        const label = mode === "korean" ? shifted ? SHIFTED_KOREAN[key] ?? key : key : shifted ? key.toUpperCase() : key;
        return <KeyButton key={key} label={label} onPress={() => onInsert(label)} />;
      })}
      {rowIndex === 2 ? <KeyButton wide label="⌫" ariaLabel="한 글자 지우기" onPress={onErase} /> : null}
    </div>)}
    <div className="keyboard-key-row keyboard-actions">
      {allowModeSwitch ? <KeyButton utility label={mode === "korean" ? "한/영" : "영/한"} onPress={onSwitchMode} /> : null}
      {allowSymbols ? <KeyButton utility label="." onPress={() => onInsert(".")} /> : null}
      {allowSymbols ? <KeyButton utility label={shifted ? "_" : "-"} onPress={() => onInsert(shifted ? "_" : "-")} /> : null}
      {allowSymbols ? <KeyButton utility label={shifted ? "?" : "/"} onPress={() => onInsert(shifted ? "?" : "/")} /> : null}
      {allowSymbols ? <KeyButton utility label={shifted ? "+" : "="} onPress={() => onInsert(shifted ? "+" : "=")} /> : null}
      <KeyButton utility label="전체 지우기" onPress={onClear} />
      <KeyButton space label="띄어쓰기" onPress={onSpace} />
      <KeyButton done label={doneLabel} onPress={onDone} />
    </div>
  </div>;
}

function NumericKeys({ onInsert, onErase, onClear, onDone, doneLabel }: {
  onInsert: (key: string) => void;
  onErase: () => void;
  onClear: () => void;
  onDone: () => void;
  doneLabel: string;
}) {
  return <div className="kiosk-keyboard-body numeric-keyboard">
    <div className="numeric-key-grid">
      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((key) => <KeyButton key={key} label={key} onPress={() => onInsert(key)} />)}
      <KeyButton utility label="전체 지우기" onPress={onClear} />
      <KeyButton label="0" onPress={() => onInsert("0")} />
      <KeyButton wide label="⌫" ariaLabel="한 자리 지우기" onPress={onErase} />
    </div>
    <KeyButton done label={doneLabel} onPress={onDone} />
  </div>;
}

function KeyButton({ label, ariaLabel, onPress, wide = false, utility = false, space = false, done = false, active = false }: {
  label: string;
  ariaLabel?: string;
  onPress: () => void;
  wide?: boolean;
  utility?: boolean;
  space?: boolean;
  done?: boolean;
  active?: boolean;
}) {
  const pointerLockRef = useRef(0);
  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (now - pointerLockRef.current < 28) return;
    pointerLockRef.current = now;
    onPress();
  };
  return <button
    type="button"
    aria-label={ariaLabel ?? label}
    aria-pressed={active || undefined}
    className={`${wide ? "wide" : ""} ${utility ? "utility" : ""} ${space ? "space" : ""} ${done ? "done" : ""} ${active ? "active" : ""}`.trim()}
    onPointerDown={handlePointerDown}
    onClick={(event) => { if (event.detail === 0) onPress(); }}
  >{label}</button>;
}

export function KioskInput({
  inputId,
  value,
  onValueChange,
  label,
  kind = "korean",
  secure = false,
  allowModeSwitch = kind !== "numeric",
  allowDigits = true,
  allowSymbols = secure,
  maxLength,
  formatter,
  enterKeyHint = "done",
  placeholder,
  disabled = false,
  className = "",
  ariaLabel,
}: {
  inputId?: string;
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  kind?: KioskKeyboardKind;
  secure?: boolean;
  allowModeSwitch?: boolean;
  allowDigits?: boolean;
  allowSymbols?: boolean;
  maxLength?: number;
  formatter?: (value: string) => string;
  enterKeyHint?: "next" | "done" | "search";
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const generatedId = useId();
  const id = inputId ?? `kiosk-input-${generatedId.replace(/:/g, "")}`;
  const { activeId, open, close, syncValue } = useKioskKeyboard();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const config = useMemo<Omit<KeyboardConfig, "id" | "value">>(() => ({
    label,
    kind,
    onValueChange,
    maxLength,
    secure,
    allowModeSwitch,
    allowDigits,
    allowSymbols,
    enterKeyHint,
    formatter,
  }), [allowDigits, allowModeSwitch, allowSymbols, enterKeyHint, formatter, kind, label, maxLength, onValueChange, secure]);

  useEffect(() => syncValue(id, value, config), [config, id, syncValue, value]);

  const activate = useCallback(() => {
    const input = inputRef.current;
    if (!input || disabled) return;
    open(input, { id, value, ...config });
  }, [config, disabled, id, open, value]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLInputElement>) => {
    event.preventDefault();
    event.stopPropagation();
    activate();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab" || event.key === "Enter") {
      event.preventDefault();
      const fields = Array.from(document.querySelectorAll<HTMLInputElement>("input[data-kiosk-input='true']:not(:disabled)"));
      const current = fields.indexOf(event.currentTarget);
      const direction = event.key === "Tab" && event.shiftKey ? -1 : 1;
      const next = fields[current + direction];
      if (next && (event.key === "Tab" || enterKeyHint === "next")) next.click();
      else close();
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      const next = kind === "korean" ? backspaceHangul(value) : Array.from(value).slice(0, -1).join("");
      onValueChange(next);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activate();
      return;
    }
    if (!isPrintableKey(event)) return;
    event.preventDefault();
    const key = kind === "numeric" ? event.key.replace(/\D/g, "") : event.key;
    if (!key) return;
    if (kind !== "numeric") {
      if (!allowDigits && /^\d$/u.test(key)) return;
      if (!allowSymbols && !/^[\p{L}\p{M}\d\s]$/u.test(key)) return;
    }
    const next = kind === "korean" ? applyHangulKey(value, key) : `${value}${key}`;
    onValueChange(limitText(next, maxLength));
  };

  const displayValue = secure ? maskValue(value) : formatter ? formatter(value) : value;
  return <input
    ref={inputRef}
    id={id}
    data-kiosk-input="true"
    data-kiosk-keyboard={kind}
    className={`${className} ${activeId === id ? "kiosk-input-active" : ""}`.trim()}
    type="text"
    inputMode="none"
    readOnly
    autoComplete="off"
    autoCorrect="off"
    spellCheck={false}
    aria-label={ariaLabel ?? label}
    aria-haspopup="dialog"
    aria-readonly="false"
    enterKeyHint={enterKeyHint}
    disabled={disabled}
    value={displayValue}
    placeholder={placeholder}
    onPointerDown={handlePointerDown}
    onClick={activate}
    onFocus={activate}
    onKeyDown={handleKeyDown}
  />;
}
