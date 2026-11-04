import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Role, type User } from "../api";
import { useMe } from "../App";
import { formatWhen } from "../format";
import { Badge, Empty, ErrorBox, Modal, PageHeader, Spinner } from "../ui";

const ROLES: Role[] = ["AGENT", "MANAGER", "ADMIN"];
const roleLabel = (r: Role) => r.charAt(0) + r.slice(1).toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function UsersPage() {
  const me = useMe();
  const isAdmin = me.role === "ADMIN";
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<User[]>("/api/users") });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [filter, setFilter] = useState("");

  const list = (users.data ?? []).filter((u) => {
    const f = filter.trim().toLowerCase();
    return !f || u.email.includes(f) || (u.name ?? "").toLowerCase().includes(f) || (u.team ?? "").toLowerCase().includes(f);
  });

  return (
    <>
      <PageHeader
        title="Users"
        subtitle={isAdmin ? "Who can sign in, their role and team." : "Read-only. Only admins can change users."}
        actions={
          isAdmin && (
            <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
              Add user
            </button>
          )
        }
      />
      <div className="mb-4">
        <label htmlFor="user-filter" className="sr-only">
          Filter users
        </label>
        <input id="user-filter" type="search" className="input sm:max-w-xs" placeholder="Filter by name, email or team" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {users.isPending ? (
        <Spinner label="Loading users" />
      ) : users.isError ? (
        <ErrorBox error={users.error} onRetry={() => void users.refetch()} />
      ) : list.length === 0 ? (
        <Empty>{filter ? "No users match." : "No users yet."}</Empty>
      ) : (
        <ul className="card divide-y divide-slate-100 dark:divide-slate-800">
          {list.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{u.name || u.email}</span>
                  <Badge tone={u.role === "ADMIN" ? "blue" : u.role === "MANAGER" ? "amber" : "gray"}>{roleLabel(u.role)}</Badge>
                  {!u.active && <Badge tone="red">Deactivated</Badge>}
                </div>
                <div className="truncate text-sm text-slate-500">
                  {u.name ? `${u.email} · ` : ""}
                  {u.team ? `Team ${u.team}` : "No team"} · {u._count?.calls ?? 0} calls
                  {u.excludedNumbers.length ? ` · ${u.excludedNumbers.length} excluded numbers` : ""}
                </div>
                <div className="text-xs text-slate-400">Last sign-in: {u.lastLoginAt ? formatWhen(u.lastLoginAt) : "never"}</div>
              </div>
              {isAdmin && (
                <button type="button" className="btn-outline min-h-9" onClick={() => setEditing(u)} aria-label={`Edit ${u.name || u.email}`}>
                  Edit
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {isAdmin && <AddUserDialog open={adding} onClose={() => setAdding(false)} />}
      {isAdmin && editing && <EditUserDialog key={editing.id} user={editing} isSelf={editing.id === me.id} onClose={() => setEditing(null)} />}
    </>
  );
}

function AddUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [team, setTeam] = useState("");
  const [role, setRole] = useState<Role>("AGENT");
  const add = useMutation({
    mutationFn: () =>
      api<User>("/api/users", {
        method: "POST",
        body: { email: email.trim(), role, ...(name.trim() ? { name: name.trim() } : {}), ...(team.trim() ? { team: team.trim() } : {}) },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["users"] });
      close();
    },
  });
  const close = () => {
    setEmail("");
    setName("");
    setTeam("");
    setRole("AGENT");
    add.reset();
    onClose();
  };
  const valid = EMAIL_RE.test(email.trim());
  return (
    <Modal
      open={open}
      title="Add user"
      onClose={() => !add.isPending && close()}
      footer={
        <>
          <button type="button" className="btn-ghost" disabled={add.isPending} onClick={close}>
            Cancel
          </button>
          <button type="submit" form="add-user" className="btn-primary" disabled={!valid || add.isPending}>
            {add.isPending ? "Adding…" : "Add"}
          </button>
        </>
      }
    >
      <form
        id="add-user"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) add.mutate();
        }}
      >
        <div>
          <label className="label" htmlFor="nu-email">
            Google email
          </label>
          <input id="nu-email" type="email" required autoComplete="off" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="nu-name">
            Name (optional)
          </label>
          <input id="nu-name" className="input" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="nu-team">
            Team (optional)
          </label>
          <input id="nu-team" className="input" maxLength={100} value={team} onChange={(e) => setTeam(e.target.value)} />
        </div>
        <RolePicker value={role} onChange={setRole} />
        {add.error && (
          <p role="alert" className="text-red-600 dark:text-red-400">
            {add.error.message}
          </p>
        )}
      </form>
    </Modal>
  );
}

function RolePicker({ value, onChange, disabled }: { value: Role; onChange: (r: Role) => void; disabled?: boolean }) {
  return (
    <fieldset disabled={disabled}>
      <legend className="label">Role</legend>
      <div className="flex flex-wrap gap-2">
        {ROLES.map((r) => (
          <label key={r} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-slate-300 px-3 has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50 dark:border-slate-700 dark:has-[:checked]:bg-slate-800">
            <input type="radio" name="role" value={r} checked={value === r} onChange={() => onChange(r)} className="accent-brand-600" />
            {roleLabel(r)}
          </label>
        ))}
      </div>
      <p className="hint">Agents see their own calls. Managers see their team's calls. Admins see everything and manage settings.</p>
    </fieldset>
  );
}

function EditUserDialog({ user, isSelf, onClose }: { user: User; isSelf: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(user.name ?? "");
  const [team, setTeam] = useState(user.team ?? "");
  const [role, setRole] = useState<Role>(user.role);
  const [active, setActive] = useState(user.active);
  const [numbersText, setNumbersText] = useState(user.excludedNumbers.join("\n"));
  const numbers = numbersText
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const numbersOk = numbers.length <= 500 && numbers.every((n) => n.length <= 40);

  const save = useMutation({
    mutationFn: () =>
      api<User>(`/api/users/${user.id}`, {
        method: "PATCH",
        body: {
          ...(name.trim() ? { name: name.trim() } : {}),
          team: team.trim() || null,
          role,
          active,
          excludedNumbers: numbers,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
  });

  return (
    <Modal
      open
      title={`Edit ${user.email}`}
      onClose={() => !save.isPending && onClose()}
      footer={
        <>
          <button type="button" className="btn-ghost" disabled={save.isPending} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="edit-user" className="btn-primary" disabled={!numbersOk || save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <form
        id="edit-user"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (numbersOk) save.mutate();
        }}
      >
        <div>
          <label className="label" htmlFor="eu-name">
            Name
          </label>
          <input id="eu-name" className="input" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="eu-team">
            Team (blank = none)
          </label>
          <input id="eu-team" className="input" maxLength={100} value={team} onChange={(e) => setTeam(e.target.value)} />
        </div>
        <RolePicker value={role} onChange={setRole} disabled={isSelf} />
        <label className="flex items-center justify-between gap-3 py-1">
          <span className="text-sm font-medium">Active</span>
          <input type="checkbox" role="switch" className="size-5 accent-brand-600" checked={active} disabled={isSelf} onChange={(e) => setActive(e.target.checked)} />
        </label>
        {isSelf && <p className="hint">You can't change your own role or deactivate yourself.</p>}
        {!active && user.active && <p className="hint text-amber-700 dark:text-amber-300">Deactivating signs this user out on all phones right away.</p>}
        <div>
          <label className="label" htmlFor="eu-numbers">
            Excluded numbers, one per line
          </label>
          <textarea id="eu-numbers" rows={5} className="input py-2 font-mono" value={numbersText} onChange={(e) => setNumbersText(e.target.value)} aria-describedby="eu-numbers-hint" />
          <p id="eu-numbers-hint" className={`hint ${numbersOk ? "" : "text-red-600"}`}>
            Calls with these numbers are never uploaded. {numbers.length}/500
          </p>
        </div>
        {save.error && (
          <p role="alert" className="text-red-600 dark:text-red-400">
            {save.error.message}
          </p>
        )}
      </form>
    </Modal>
  );
}
