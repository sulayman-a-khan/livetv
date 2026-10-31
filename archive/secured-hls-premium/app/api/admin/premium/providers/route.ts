import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest, isAuthorizedAdmin } from "@/lib/adminAuth";
import { performProxyAction, type ProxyActionResponse } from "@/lib/proxyActions";
import { readProxyInspection } from "@/lib/proxyControl";
import { validateProviderInput } from "@/lib/premiumFixtures";

export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json(
    { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
    { status: 401 }
  );
}

function fail(error: any, fallback: string) {
  const status = typeof error?.status === "number" ? error.status : 500;
  // The provider's own credential is never in this message. An exception's text can quote the
  // body it was raised from, and this body holds a password, so only the route's own wording
  // reaches the panel and the log.
  console.error("GET/POST /api/admin/premium/providers error:", error?.name || fallback);
  return NextResponse.json({ success: false, error: fallback }, { status });
}

/**
 * The box's own refusal code, as the site reads it out of an action answer.
 *
 * The code is what decides whether a refusal is worth trying again under another name, so
 * it is read here rather than anywhere in the panel.
 */
function boxCodeOf(body: Record<string, unknown>): string | null {
  const result = body.result as Record<string, unknown> | undefined;
  return typeof result?.code === "string" ? result.code : null;
}

/**
 * GET /api/admin/premium/providers
 *
 * The provider list, read from the box's read-only surface.
 *
 * The list is not kept in this site's database on purpose: the box's vault is the source of
 * truth, and a copy here would be a second place for a provider credential to live in. What
 * comes back is a projection — a name, a masked address, a username hint and how many
 * channels use it — and never the credential itself.
 *
 * The read-only surface is the one that is read from, and not the admin surface: it exists
 * exactly so that a panel which shows the vault never holds a credential that could change
 * it. It is also the only one of the two that says *why* an account cannot be used, in a code
 * rather than in a sentence.
 *
 * `reachable` and `authorized` are separate answers on purpose. A box that is up but
 * refuses this server's credential is not a box that is down, and an empty list would read
 * like "you have no providers" when the truth is "nobody was allowed to look".
 */
export async function GET(req: NextRequest) {
  try {
    if (!isAuthorizedAdmin(req)) return unauthorized();
    const rows = await readProxyInspection();
    return NextResponse.json({
      success: true,
      reachable: rows.reachable,
      authorized: rows.authorized,
      count: rows.providers.length,
      providers: rows.providers,
    });
  } catch (error: any) {
    return fail(error, "Failed to load the provider list");
  }
}

/**
 * How many handles one name may be tried under.
 *
 * The handle a name implies can already be taken — two accounts called the same thing, or a
 * second account at an address that is already registered. The next handle is tried then,
 * because the admin's answer is "add a provider", not "invent an id".
 */
const HANDLE_ATTEMPTS = 8;

/**
 * POST /api/admin/premium/providers
 *
 * Register one Xtream Codes account on the box.
 *
 * The body is the address, the username, the password and a name for the account. The
 * credential travels in this one request and is forgotten: the box seals it, this site keeps
 * no copy, and nothing in the answer echoes it back. A password that was typed is never
 * logged and never stored.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await authorizeAdminRequest(req);
    if (!auth.ok) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
    }

    const { value, errors } = validateProviderInput(auth.body, true);
    if (errors.length > 0) {
      return NextResponse.json({ success: false, error: errors.join("; ") }, { status: 400 });
    }

    const base = value.providerId || "";
    if (!base) {
      return NextResponse.json(
        { success: false, error: "Provider ID is required" },
        { status: 400 }
      );
    }

    let answer: ProxyActionResponse = {
      status: 400,
      body: { success: false, error: "the provider was not registered" },
    };
    let used = base;

    for (let attempt = 0; attempt < HANDLE_ATTEMPTS; attempt += 1) {
      used = attempt === 0 ? base : `${base.slice(0, 60)}-${attempt + 1}`;
      answer = await performProxyAction({
        action: "create_provider",
        target: used,
        label: value.label,
        serverUrl: value.serverUrl,
        username: value.username,
        password: value.password,
      });
      if (answer.status === 200) break;
      // Only a handle that is taken is worth another name. A duplicate credential is refused
      // for the credential's sake, and a second name would not change that.
      if (boxCodeOf(answer.body) !== "provider_exists") break;
    }

    if (answer.status !== 200) {
      return NextResponse.json(
        {
          success: false,
          error: answer.body.error || "the stream box refused the provider",
          code: answer.body.code,
          result: answer.body.result,
        },
        { status: answer.status }
      );
    }

    return NextResponse.json({
      success: true,
      providerId: used,
      label: value.label,
    });
  } catch (error: any) {
    return fail(error, "Failed to add the provider");
  }
}
