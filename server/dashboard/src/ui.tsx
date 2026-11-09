import { useEffect, useRef, type ReactNode } from "react";
import type { CallStatus, ContactStatus, Direction } from "./api";
import { CONTACT_STATUS_LABEL, DIRECTION_LABEL, STATUS_LABEL } from "./format";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 py-10 text-sm text-slate-500">
      <span className="size-5 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" aria-hidden />
      {label}…
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : "Something went wrong";
  return (
    <div role="alert" className="card flex flex-wrap items-center justify-between gap-3 border-red-200 p-4 text-sm text-red-700 dark:border-red-900 dark:text-red-300">
      <span>{msg}</span>
      {onRetry && (
        <button type="button" className="btn-outline" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="card p-8 text-center text-sm text-slate-500 dark:text-slate-400">{children}</p>;
}

type Tone = "gray" | "green" | "amber" | "red" | "blue";
const TONES: Record<Tone, string> = {
  gray: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  red: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  blue: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
};
export function Badge({ tone = "gray", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}

const STATUS_TONE: Record<CallStatus, Tone> = {
  PENDING_UPLOAD: "gray",
  UPLOADED: "blue",
  TRANSCRIBING: "amber",
  TRANSCRIBED: "green",
  FAILED: "red",
};
export const StatusBadge = ({ status }: { status: CallStatus }) => <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;

const DIR_ICON: Record<Direction, string> = { INCOMING: "↙", OUTGOING: "↗", MISSED: "✕", UNKNOWN: "•" };
export function DirectionTag({ direction }: { direction: Direction }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap text-sm ${direction === "MISSED" ? "text-red-600 dark:text-red-400" : ""}`}>
      <span aria-hidden className="font-mono">
        {DIR_ICON[direction]}
      </span>
      {DIRECTION_LABEL[direction]}
    </span>
  );
}

/** Modal built on <dialog>: focus trap, Esc to close and backdrop come from the browser. */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-labelledby="modal-title"
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-black/50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      {open && (
        <div className="flex max-h-[85dvh] flex-col">
          <h2 id="modal-title" className="px-5 pt-5 text-lg font-semibold">
            {title}
          </h2>
          <div className="overflow-y-auto px-5 py-4 text-sm">{children}</div>
          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800">{footer}</div>
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-danger" disabled={busy} onClick={onConfirm}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      <div>{body}</div>
      {error != null && (
        <p role="alert" className="mt-3 text-red-600 dark:text-red-400">
          {error instanceof Error ? error.message : "Failed"}
        </p>
      )}
    </Modal>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="hint block">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" className="mt-1 size-5 shrink-0 accent-brand-600" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

const CONTACT_TONE: Record<ContactStatus, Tone> = {
  NEW: "gray",
  INTERESTED: "green",
  CALL_BACK: "blue",
  NOT_INTERESTED: "red",
  NO_ANSWER: "amber",
};
export const ContactStatusBadge = ({ status }: { status: ContactStatus }) => <Badge tone={CONTACT_TONE[status]}>{CONTACT_STATUS_LABEL[status]}</Badge>;
