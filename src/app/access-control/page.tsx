import Link from "next/link";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/authOptions";
import {
  loadAccessControlPolicy,
  removeAccessEmail,
  setEmailAdmin,
  upsertAccessEmail,
} from "@/lib/accessControlStore";

const REQUIRED_ADMINS = new Set<string>(["hany.safwat@botpress.com"]);

async function requireAdminUser() {
  const session = await getServerSession(authOptions);
  const email = String(session?.user?.email || "")
    .trim()
    .toLowerCase();
  if (!email) {
    redirect("/login?callbackUrl=/access-control");
  }
  const { policy } = await loadAccessControlPolicy({ bypassCache: true });
  const isAdmin = policy.adminEmails.includes(email);
  return { email, isAdmin, policy };
}

async function addAccessEmailAction(formData: FormData) {
  "use server";
  const { isAdmin } = await requireAdminUser();
  if (!isAdmin) redirect("/access-control?error=admin_required");
  const email = String(formData.get("email") || "")
    .trim()
    .toLowerCase();
  const makeAdmin = String(formData.get("make_admin") || "") === "1";
  await upsertAccessEmail(email, makeAdmin);
  redirect("/access-control?updated=1");
}

async function setEmailAdminAction(formData: FormData) {
  "use server";
  const { isAdmin } = await requireAdminUser();
  if (!isAdmin) redirect("/access-control?error=admin_required");
  const email = String(formData.get("email") || "")
    .trim()
    .toLowerCase();
  const makeAdmin = String(formData.get("make_admin") || "") === "1";
  await setEmailAdmin(email, makeAdmin);
  redirect("/access-control?updated=1");
}

async function removeAccessEmailAction(formData: FormData) {
  "use server";
  const { isAdmin } = await requireAdminUser();
  if (!isAdmin) redirect("/access-control?error=admin_required");
  const email = String(formData.get("email") || "")
    .trim()
    .toLowerCase();
  await removeAccessEmail(email);
  redirect("/access-control?updated=1");
}

type AccessControlSearchParams = Promise<{
  updated?: string;
  error?: string;
}>;

function errorMessage(raw: string) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value === "admin_required") return "Only admins can manage access.";
  return value.replaceAll("_", " ");
}

export default async function AccessControlPage(props: { searchParams: AccessControlSearchParams }) {
  const searchParams = await props.searchParams;
  const { email: currentEmail, isAdmin, policy } = await requireAdminUser();
  const updated = String(searchParams.updated || "") === "1";
  const error = errorMessage(String(searchParams.error || ""));
  const adminSet = new Set(policy.adminEmails);

  if (!isAdmin) {
    return (
      <div className="stripe-ui">
        <section className="stripe-ui__hero ui-reveal">
          <div className="stripe-ui__eyebrow">Security</div>
          <div className="stripe-ui__hero-row">
            <div>
              <h1 className="stripe-ui__title">Access Control</h1>
              <p className="stripe-ui__subtitle">You do not have admin access to this page.</p>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
              <Link href="/combined-all-subs" className="stripe-ui__hero-link">
                Back to Combined All Subs
              </Link>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="stripe-ui">
      <section className="stripe-ui__hero ui-reveal">
        <div className="stripe-ui__eyebrow">Security</div>
        <div className="stripe-ui__hero-row">
          <div>
            <h1 className="stripe-ui__title">Access Control</h1>
            <p className="stripe-ui__subtitle">
              Manage who can sign in. Current admin: <strong>{currentEmail}</strong>.
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Link href="/combined-all-subs" className="stripe-ui__hero-link">
              Back to Combined All Subs
            </Link>
          </div>
        </div>
      </section>

      <section className="stripe-ui__panel ui-reveal ui-reveal-1">
        <h2 className="stripe-ui__panel-title">Add Access Email</h2>
        <p className="stripe-ui__panel-subtitle">
          Add an email to the allowlist. Turn on admin only if the user should manage access for others.
        </p>
        {updated ? (
          <p style={{ color: "#166534", background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8, padding: "10px 12px" }}>
            Access control updated.
          </p>
        ) : null}
        {error ? (
          <p style={{ color: "#b91c1c", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 12px" }}>
            {error}
          </p>
        ) : null}
        <form action={addAccessEmailAction} style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <input
            className="stripe-ui__control"
            type="email"
            name="email"
            placeholder="name@company.com"
            required
            style={{ maxWidth: 360 }}
          />
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center", color: "#374151" }}>
            <input type="checkbox" name="make_admin" value="1" />
            Admin
          </label>
          <button type="submit" className="stripe-ui__btn stripe-ui__btn--primary">
            Add email
          </button>
        </form>
      </section>

      <section className="stripe-ui__panel ui-reveal ui-reveal-2">
        <h2 className="stripe-ui__panel-title">Allowed Emails</h2>
        <p className="stripe-ui__panel-subtitle">
          Admin emails can edit access. Required admin(s) cannot be removed.
        </p>
        <div className="stripe-ui__table-wrap">
          <table className="stripe-ui__table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {policy.allowedEmails.map((email) => {
                const isRowAdmin = adminSet.has(email);
                const isRequired = REQUIRED_ADMINS.has(email);
                return (
                  <tr key={email}>
                    <td>{email}</td>
                    <td>{isRowAdmin ? "Admin" : "Viewer"}</td>
                    <td>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <form action={setEmailAdminAction}>
                          <input type="hidden" name="email" value={email} />
                          <input type="hidden" name="make_admin" value={isRowAdmin ? "0" : "1"} />
                          <button type="submit" className="stripe-ui__btn" disabled={isRequired}>
                            {isRowAdmin ? "Set viewer" : "Set admin"}
                          </button>
                        </form>
                        <form action={removeAccessEmailAction}>
                          <input type="hidden" name="email" value={email} />
                          <button type="submit" className="stripe-ui__btn" disabled={isRequired}>
                            Remove
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
