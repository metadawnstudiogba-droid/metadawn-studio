"use client";

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import {
  atomicPromptRange, promptEditorNeedsRender, promptEditorParts, promptNodeText,
  readPromptSelection, renderPromptEditor, setPromptSelection, type PromptEditorReference,
} from "@/lib/prompt-editor-dom";

export type PromptEditorSelection = { value: string; selectionStart: number; selectionEnd: number };
export type PromptEditorHandle = {
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  getCaretRect(): { left: number; top: number; bottom: number } | null;
};

type PromptEditorProps = {
  value: string;
  references: PromptEditorReference[];
  onChange(selection: PromptEditorSelection): void;
  onSelectionChange(selection: PromptEditorSelection): void;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  onCompositionStart(): void;
  onCompositionEnd(selection: PromptEditorSelection): void;
  activeDescendant?: string;
  controls?: string;
  placeholder?: string;
};

export const PromptEditor = forwardRef<PromptEditorHandle, PromptEditorProps>(function PromptEditor(props, forwardedRef) {
  const rootRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const composingRef = useRef(false);
  const lastSelectionRef = useRef<PromptEditorSelection>({ value: props.value, selectionStart: 0, selectionEnd: 0 });
  const lastNotificationRef = useRef("");
  const initializedRef = useRef(false);
  const previousReferencesRef = useRef(props.references);
  const historyRef = useRef({ entries: [lastSelectionRef.current], index: 0 });

  function snapshot() {
    const root = rootRef.current;
    if (!root) return lastSelectionRef.current;
    const current = readPromptSelection(root) ?? { ...lastSelectionRef.current, value: promptNodeText(root) };
    lastSelectionRef.current = current;
    return current;
  }

  function notifySelection() {
    const root = rootRef.current;
    if (!root || composingRef.current || root.ownerDocument.activeElement !== root) return;
    const current = snapshot();
    const key = `${current.selectionStart}:${current.selectionEnd}:${current.value}`;
    if (lastNotificationRef.current === key) return;
    lastNotificationRef.current = key;
    propsRef.current.onSelectionChange(current);
  }

  function publishInput() {
    const current = snapshot();
    if (!composingRef.current) remember(current);
    propsRef.current.onChange(current);
    if (!composingRef.current) notifySelection();
  }

  function remember(current: PromptEditorSelection) {
    const history = historyRef.current;
    if (history.entries[history.index].value === current.value) {
      history.entries[history.index] = current;
      return;
    }
    history.entries = history.entries.slice(0, history.index + 1);
    history.entries.push(current);
    if (history.entries.length > 100) history.entries.shift();
    history.index = history.entries.length - 1;
  }

  function moveHistory(direction: -1 | 1) {
    const root = rootRef.current;
    const history = historyRef.current;
    const nextIndex = history.index + direction;
    if (!root || nextIndex < 0 || nextIndex >= history.entries.length) return;
    history.entries[history.index] = snapshot();
    history.index = nextIndex;
    const current = history.entries[nextIndex];
    renderPromptEditor(root, current.value, propsRef.current.references);
    setPromptSelection(root, current.selectionStart, current.selectionEnd);
    lastSelectionRef.current = current;
    propsRef.current.onChange(current);
    notifySelection();
  }

  // Only rebuild when chips or externally controlled text have changed. Ordinary
  // typing keeps its native DOM and IME/undo state.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || composingRef.current) return;
    const focused = root.ownerDocument.activeElement === root;
    const current = focused ? snapshot() : lastSelectionRef.current;
    const next = { value: props.value, selectionStart: Math.min(current.selectionStart, props.value.length), selectionEnd: Math.min(current.selectionEnd, props.value.length) };
    const referenceMap = new Map(props.references.map((reference) => [reference.label, reference.asset.id]));
    const remapped = previousReferencesRef.current.some((reference) => referenceMap.get(reference.label) !== reference.asset.id);
    previousReferencesRef.current = props.references;
    if (promptEditorNeedsRender(root, props.value, props.references)) {
      if (initializedRef.current) remember(current);
      renderPromptEditor(root, props.value, props.references);
      if (focused) setPromptSelection(root, next.selectionStart, next.selectionEnd);
    }
    lastSelectionRef.current = next;
    if (!initializedRef.current || remapped) {
      // A removed/renumbered reference must not be resurrected by text undo as a
      // token pointing at a different asset.
      historyRef.current = { entries: [next], index: 0 };
      initializedRef.current = true;
    } else remember(next);
  }, [props.value, props.references]);

  useEffect(() => {
    const root = rootRef.current;
    const document = root?.ownerDocument;
    function beforeInput(event: InputEvent) {
      if (composingRef.current || event.isComposing) return;
      remember(snapshot());
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
        event.preventDefault();
        moveHistory(event.inputType === "historyUndo" ? -1 : 1);
      } else if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
        event.preventDefault();
        replaceSelection("\n");
      } else if (event.inputType === "deleteContentBackward" || event.inputType === "deleteContentForward") {
        deleteChip(event, event.inputType === "deleteContentBackward");
      }
    }
    document?.addEventListener("selectionchange", notifySelection);
    root?.addEventListener("beforeinput", beforeInput);
    return () => {
      document?.removeEventListener("selectionchange", notifySelection);
      root?.removeEventListener("beforeinput", beforeInput);
    };
  }, []);

  useImperativeHandle(forwardedRef, () => ({
    focus() { rootRef.current?.focus({ preventScroll: true }); },
    getCaretRect() {
      const root = rootRef.current;
      const selection = root?.ownerDocument.getSelection();
      if (!root || !selection?.rangeCount) return null;
      const range = selection.getRangeAt(0).cloneRange();
      if (!root.contains(range.endContainer)) return null;
      range.collapse(false);
      const rect = range.getClientRects()[0];
      if (rect?.height) return { left: rect.left, top: rect.top, bottom: rect.bottom };
      const fallback = root.getBoundingClientRect();
      return { left: fallback.left, top: fallback.top, bottom: fallback.top + 24 };
    },
    setSelectionRange(start, end) {
      const root = rootRef.current;
      if (!root) return;
      lastSelectionRef.current = { value: promptNodeText(root), selectionStart: start, selectionEnd: end };
      if (root.ownerDocument.activeElement === root) setPromptSelection(root, start, end);
      remember(lastSelectionRef.current);
    },
  }), []);

  function replaceSelection(text: string, range = snapshot()) {
    const root = rootRef.current;
    if (!root) return;
    remember(range);
    const atomic = atomicPromptRange(promptEditorParts(range.value, propsRef.current.references), range.selectionStart, range.selectionEnd);
    const value = range.value.slice(0, atomic.selectionStart) + text + range.value.slice(atomic.selectionEnd);
    const caret = atomic.selectionStart + text.length;
    renderPromptEditor(root, value, propsRef.current.references);
    setPromptSelection(root, caret, caret);
    publishInput();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    propsRef.current.onKeyDown(event);
    if (event.defaultPrevented || composingRef.current || event.nativeEvent.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      moveHistory(event.shiftKey ? 1 : -1);
      return;
    }
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "y") {
      event.preventDefault();
      moveHistory(1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      replaceSelection("\n");
      return;
    }
    if ((event.key !== "Backspace" && event.key !== "Delete") || event.altKey || event.metaKey || event.ctrlKey) return;
    deleteChip(event, event.key === "Backspace");
  }

  function deleteChip(event: { preventDefault(): void }, backward: boolean) {
    const current = snapshot();
    const parts = promptEditorParts(current.value, propsRef.current.references);
    if (current.selectionStart !== current.selectionEnd) {
      if (parts.some((part) => part.type === "reference" && part.start < current.selectionEnd && part.end > current.selectionStart)) {
        event.preventDefault();
        replaceSelection("", current);
      }
      return;
    }
    const chip = parts.find((part) => part.type === "reference" &&
      (backward ? part.end === current.selectionStart : part.start === current.selectionStart));
    if (chip) {
      event.preventDefault();
      replaceSelection("", { ...current, selectionStart: chip.start, selectionEnd: chip.end });
    }
  }

  function copyPlainText(event: ClipboardEvent<HTMLDivElement>, cut = false) {
    const current = snapshot();
    if (current.selectionStart === current.selectionEnd) return;
    const range = atomicPromptRange(promptEditorParts(current.value, propsRef.current.references), current.selectionStart, current.selectionEnd);
    event.preventDefault();
    event.clipboardData.setData("text/plain", current.value.slice(range.selectionStart, range.selectionEnd));
    if (cut) replaceSelection("", { ...current, ...range });
  }

  return <div
    ref={rootRef}
    className="prompt-editor"
    contentEditable
    suppressContentEditableWarning
    role="textbox"
    aria-label="创作提示词"
    aria-multiline="true"
    aria-required="true"
    aria-autocomplete="list"
    aria-controls={props.controls}
    aria-activedescendant={props.activeDescendant}
    data-placeholder={props.placeholder ?? "输入画面描述；输入 @ 选择参考素材"}
    data-empty={!props.value ? "true" : undefined}
    spellCheck={false}
    onInput={publishInput}
    onFocus={notifySelection}
    onClick={notifySelection}
    onKeyUp={notifySelection}
    onKeyDown={handleKeyDown}
    onPaste={(event) => {
      event.preventDefault();
      replaceSelection(event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n"));
    }}
    onCopy={(event) => copyPlainText(event)}
    onCut={(event) => copyPlainText(event, true)}
    onDragStart={(event) => event.preventDefault()}
    onDrop={(event) => event.preventDefault()}
    onCompositionStart={() => {
      remember(snapshot());
      composingRef.current = true;
      propsRef.current.onCompositionStart();
    }}
    onCompositionEnd={() => {
      composingRef.current = false;
      const current = snapshot();
      remember(current);
      propsRef.current.onChange(current);
      propsRef.current.onCompositionEnd(current);
      if (rootRef.current && promptEditorNeedsRender(rootRef.current, current.value, propsRef.current.references)) {
        renderPromptEditor(rootRef.current, current.value, propsRef.current.references);
        setPromptSelection(rootRef.current, current.selectionStart, current.selectionEnd);
      }
      notifySelection();
    }}
  />;
});
