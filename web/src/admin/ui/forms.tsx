import { overlayContainer } from "./overlays";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { App } from "antd";
import { useBeforeUnload, useBlocker } from "react-router-dom";
import { useAdminText } from "./text";
type DirtyContextValue = {
  register: (
    id: string,
    dirty: boolean,
    beforeDiscard?: () => Promise<void>,
  ) => void;
  confirmDiscard: (dirty?: boolean) => Promise<boolean>;
};
const DirtyContext = createContext<DirtyContextValue | null>(null);
export function DirtyForms({ children }: { children: ReactNode }): JSX.Element {
  const { modal } = App.useApp();
  const text = useAdminText();
  const forms = useRef(new Map<string, (() => Promise<void>) | undefined>());
  const [dirty, setDirty] = useState(false);
  const register = useCallback(
    (id: string, value: boolean, beforeDiscard?: () => Promise<void>) => {
      if (value) forms.current.set(id, beforeDiscard);
      else forms.current.delete(id);
      setDirty(forms.current.size > 0);
    },
    [],
  );
  const confirmDiscard = useCallback(
    async (value?: boolean): Promise<boolean> => {
      if (!(value ?? forms.current.size > 0)) return true;
      const confirmed = Boolean(
        await modal.confirm({
          getContainer: overlayContainer,
          title: text("unsavedTitle"),
          content: text("unsavedBody"),
          okText: text("discard"),
          cancelText: text("keepEditing"),
        }),
      );
      if (confirmed && value === undefined) {
        try {
          for (const cleanup of [...forms.current.values()]) await cleanup?.();
        } catch {
          return false;
        } // The owning form displays cleanup errors and stays mounted.
      }
      return confirmed;
    },
    [modal, text],
  );
  const blocker = useBlocker(dirty);
  const asking = useRef(false);
  useEffect(() => {
    if (blocker.state !== "blocked" || asking.current) return;
    asking.current = true;
    void confirmDiscard()
      .then((ok) => {
        if (ok) {
          forms.current.clear();
          setDirty(false);
          blocker.proceed();
        } else blocker.reset();
      })
      .finally(() => {
        asking.current = false;
      });
  }, [blocker, confirmDiscard]);
  useBeforeUnload(
    useCallback((event) => {
      if (forms.current.size) {
        event.preventDefault();
        event.returnValue = "";
      }
    }, []),
  );
  return (
    <DirtyContext.Provider value={{ register, confirmDiscard }}>
      {children}
    </DirtyContext.Provider>
  );
}
export function useDirtyForm(
  dirty: boolean,
  beforeDiscard?: () => Promise<void>,
): void {
  const context = useContext(DirtyContext);
  const id = useId();
  const register = context?.register;
  const cleanupRef = useRef(beforeDiscard);
  cleanupRef.current = beforeDiscard;
  useEffect(() => {
    register?.(id, dirty, async () => {
      await cleanupRef.current?.();
    });
    return () => register?.(id, false);
  }, [id, dirty, register]);
}
export function useConfirmDiscard(): DirtyContextValue["confirmDiscard"] {
  const value = useContext(DirtyContext);
  if (!value) throw new Error("DirtyForms is required");
  return value.confirmDiscard;
}
