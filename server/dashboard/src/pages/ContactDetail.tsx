import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { api, isManager, type Activity, type ContactDetail, type ContactPatch, type ContactStatus, type TimelineItem, type User } from "../api";
import { useMe } from "../App";
import { CONTACT_STATUS_LABEL, OUTCOME_LABEL, formatDuration, formatWhen, fromLocalInput, isOverdue, personName, toLocalInput } from "../format";
import { Badge, ContactStatusBadge, DirectionTag, ErrorBox, PageHeader, Spinner, StatusBadge } from "../ui";

export function ContactDetailPage() {
  const { id = "" } = useParams();
  const detail = useQuery({ queryKey: ["contact", id], queryFn: () => api<ContactDetail>(`/api/contacts/${id}`) });

  if (detail.isPending) return <Spinner label="Loading contact" />;
  if (detail.isError) return <ErrorBox error={detail.error} onRetry={() => void detail.refetch()} />;
  const { contact, timeline } = detail.data;

  return (
    <>
      <Link to="/activity" className="mb-3 inline-block text-sm text-brand-700 hover:underline dark:text-brand-100">
        ← Activity Tracker
      </Link>
      <PageHeader
        title={contact.name || contact.phoneE164}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {contact.name && <span>{contact.phoneE164}</span>}
            {contact.company && <span>· {contact.company}</span>}
            <ContactStatusBadge status={contact.status} />
          </span>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-4">
          <EditCard key={JSON.stringify(contact)} detail={detail.data} />
          <NoteCard contactId={contact.id} />
        </div>
        <Timeline items={timeline} />
      </div>
    </>
  );
}

function EditCard({ detail }: { detail: ContactDetail }) {
  const me = useMe();
  const manager = isManager(me.role);
  const qc = useQueryClient();
  const c = detail.contact;
  const [name, setName] = useState(c.name ?? "");
  const [company, setCompany] = useState(c.company ?? "");
  const [status, setStatus] = useState<ContactStatus>(c.status);
  const [followUp, setFollowUp] = useState(toLocalInput(c.nextFollowUpAt));
  const [ownerId, setOwnerId] = useState(c.owner?.id ?? "");
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<User[]>("/api/users"), enabled: manager });
  // Managers may only assign to themselves or their own team (the server enforces the same rule).
  const owners = users.data?.filter((u) => me.role === "ADMIN" || u.id === me.id || (!!me.team && u.team === me.team));

  const save = useMutation({
    mutationFn: (body: ContactPatch) => api(`/api/contacts/${c.id}`, { method: "PATCH", body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["contact", c.id] });
      void qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: ContactPatch = {};
    if (name.trim() !== (c.name ?? "")) body.name = name.trim() || null;
    if (company.trim() !== (c.company ?? "")) body.company = company.trim() || null;
    if (status !== c.status) body.status = status;
    const fu = fromLocalInput(followUp);
    if (followUp !== toLocalInput(c.nextFollowUpAt)) body.nextFollowUpAt = fu;
    if (manager && ownerId && ownerId !== (c.owner?.id ?? "")) body.ownerId = ownerId;
    if (Object.keys(body).length) save.mutate(body);
  };

  return (
    <form onSubmit={submit} className="card space-y-3 p-4" aria-labelledby="edit-h">
      <h2 id="edit-h" className="font-semibold">
        Details
      </h2>
      <div>
        <label className="label" htmlFor="ct-name">
          Name
        </label>
        <input id="ct-name" className="input" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="ct-company">
          Company
        </label>
        <input id="ct-company" className="input" maxLength={200} value={company} onChange={(e) => setCompany(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="ct-status">
          Status
        </label>
        <select id="ct-status" className="input" value={status} onChange={(e) => setStatus(e.target.value as ContactStatus)}>
          {(Object.keys(CONTACT_STATUS_LABEL) as ContactStatus[]).map((s) => (
            <option key={s} value={s}>
              {CONTACT_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="ct-fu">
          Next follow-up
        </label>
        <input id="ct-fu" type="datetime-local" className="input" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
        {isOverdue(c.nextFollowUpAt) && <p className="hint font-medium text-red-600 dark:text-red-400">Overdue since {formatWhen(c.nextFollowUpAt)}</p>}
        {followUp && (
          <button type="button" className="hint underline" onClick={() => setFollowUp("")}>
            Clear follow-up
          </button>
        )}
      </div>
      {manager ? (
        <div>
          <label className="label" htmlFor="ct-owner">
            Owner
          </label>
          <select id="ct-owner" className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            {!ownerId && <option value="">No owner</option>}
            {c.owner && !owners?.some((u) => u.id === c.owner?.id) && <option value={c.owner.id}>{personName(c.owner)}</option>}
            {owners?.map((u) => (
              <option key={u.id} value={u.id}>
                {personName(u)}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="text-sm text-slate-500">Owner: {c.owner ? personName(c.owner) : "—"}</p>
      )}
      {save.isError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {save.error.message}
        </p>
      )}
      <button type="submit" className="btn-primary w-full" disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

function NoteCard({ contactId }: { contactId: string }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [followUp, setFollowUp] = useState("");
  const followUpAt = fromLocalInput(followUp);
  const add = useMutation({
    mutationFn: () =>
      api<Activity>(`/api/contacts/${contactId}/notes`, {
        method: "POST",
        body: { note: note.trim(), ...(followUpAt ? { followUpAt } : {}) },
      }),
    onSuccess: () => {
      setNote("");
      setFollowUp("");
      void qc.invalidateQueries({ queryKey: ["contact", contactId] });
      void qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
  return (
    <form
      className="card space-y-3 p-4"
      aria-labelledby="note-h"
      onSubmit={(e) => {
        e.preventDefault();
        if (note.trim()) add.mutate();
      }}
    >
      <h2 id="note-h" className="font-semibold">
        Add a note
      </h2>
      <div>
        <label className="sr-only" htmlFor="nt-text">
          Note
        </label>
        <textarea id="nt-text" className="input min-h-24 py-2" maxLength={2000} required value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="nt-fu">
          Follow up on (optional)
        </label>
        <input id="nt-fu" type="datetime-local" className="input" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
        <p className="hint">Setting a date marks the contact as Call back.</p>
      </div>
      {add.isError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {add.error.message}
        </p>
      )}
      <button type="submit" className="btn-outline w-full" disabled={add.isPending || !note.trim()}>
        {add.isPending ? "Adding…" : "Add note"}
      </button>
    </form>
  );
}

const TYPE_LABEL = { CALL: "Call logged", WHATSAPP: "WhatsApp chat opened", NOTE: "Note" } as const;

function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <section aria-labelledby="tl-h" className="card p-4">
      <h2 id="tl-h" className="mb-3 font-semibold">
        Timeline
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing yet.</p>
      ) : (
        <ol className="space-y-3">
          {items.map((t) => (
            <li key={`${t.kind}-${t.id}`} className="border-l-2 border-slate-200 pl-3 dark:border-slate-700">
              {t.kind === "call" ? <CallEntry item={t} /> : <ActivityEntry item={t} />}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Meta({ when, user }: { when: string; user: { name: string | null; email: string } }) {
  return (
    <div className="text-xs text-slate-500">
      {formatWhen(when)} · {personName(user)}
    </div>
  );
}

function Summary({ text }: { text: string | null }) {
  return text ? <p className="mt-1 whitespace-pre-line text-sm text-slate-700 dark:text-slate-300">{text}</p> : null;
}

function CallEntry({ item }: { item: Extract<TimelineItem, { kind: "call" }> }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/calls/${item.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-100">
          Recorded call
        </Link>
        <DirectionTag direction={item.direction} />
        <span className="text-sm tabular-nums">{formatDuration(item.durationS)}</span>
        <StatusBadge status={item.status} />
        {!item.hasAudio && <Badge>No audio</Badge>}
      </div>
      <Meta when={item.startedAt} user={item.user} />
      <Summary text={item.summary} />
    </div>
  );
}

function ActivityEntry({ item }: { item: Extract<TimelineItem, { kind: "activity" }> }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{TYPE_LABEL[item.type]}</span>
        {item.outcome && <Badge tone={item.outcome === "INTERESTED" ? "green" : item.outcome === "NOT_INTERESTED" ? "red" : item.outcome === "NO_ANSWER" ? "amber" : "blue"}>{OUTCOME_LABEL[item.outcome]}</Badge>}
        {item.type === "CALL" && item.durationS != null && <span className="text-sm tabular-nums">{formatDuration(item.durationS)}</span>}
        {item.call && (
          <>
            <Link to={`/calls/${item.call.id}`} className="text-sm text-brand-700 hover:underline dark:text-brand-100">
              Open recording
            </Link>
            <StatusBadge status={item.call.status} />
            {!item.call.hasAudio && <Badge>No audio</Badge>}
          </>
        )}
        {!item.call && item.callId && (
          <Link to={`/calls/${item.callId}`} className="text-sm text-brand-700 hover:underline dark:text-brand-100">
            Open recording
          </Link>
        )}
      </div>
      <Meta when={item.occurredAt} user={item.user} />
      {item.note && <p className="mt-1 whitespace-pre-line text-sm">{item.note}</p>}
      {item.followUpAt && <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Follow up: {formatWhen(item.followUpAt)}</p>}
      {item.call && <Summary text={item.call.summary} />}
    </div>
  );
}
