import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest, isAuthorizedAdmin } from "@/lib/adminAuth";
import { performProxyAction } from "@/lib/proxyActions";
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
  // This body can hold a password, so an exception's own text is not repeated here: only the
  // route's wording reaches the panel, and only the error's name reaches the log.
  console.error("PATCH/DELETE /api/admin/premium/providers/[id] error:", error?.name || fallback);
  return NextResponse.json({ success: false, error: fallback }, { status });
}

/**
 * PATCH /api/admin/premium/providers/[id]
 *
 * Edit one provider account on the box.
 *
 * The body names only what changes: a new name, a new address, a new username, or a new
 * password. A password that is left out is not sent, and the box keeps the credential it
 * already holds — so renaming an account does not require the admin to type the password
 * again, and the panel never has to hold one it did not just receive.
 *
 * An `active` flag is a change of its own: it takes the account out of service, or puts it
 * back, without deleting it and without touching the credential it holds.
 *
 * The handle is not editable. The box files the account under it, and every channel that
 * points at this account points at that handle; a second name would be a second account.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const auth = await authorizeAdminRequest(req);
    if (!auth.ok) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
    }

    const { value, errors } = validateProviderInput(auth.body, false);
    if (errors.length > 0) {
      return NextResponse.json({ success: false, error: errors.join("; ") }, { status: 400 });
    }

    const patch: Record<string, unknown> = {};
    if (value.label) patch.label = value.label;
    if (value.serverUrl) patch.serverUrl = value.serverUrl;
    if (value.username) patch.username = value.username;
    if (value.password) patch.password = value.password;

    // Taking an account out of service is a change of its own, and the box keeps it under a
    // different action from the one that edits its fields: an account that is off must stay
    // off even while its name is being corrected.
    const wantsActive = typeof auth.body.active === "boolean";
    const active = wantsActive ? (auth.body.active as boolean) : null;

    if (Object.keys(patch).length === 0 && active === null) {
      return NextResponse.json(
        { success: false, error: "Nothing to update — send at least one field to change" },
        { status: 400 }
      );
    }

    // The field changes go first, so a wrong address is reported before a switch that would
    // have been made on an account that is still broken.
    if (Object.keys(patch).length > 0) {
      const answer = await performProxyAction({
        action: "update_provider",
        target: params.id,
        ...patch,
      });
      if (answer.status !== 200) {
        return NextResponse.json(
          {
            success: false,
            error: answer.body.error || "the stream box refused the change",
            code: answer.body.code,
            result: answer.body.result,
          },
          { status: answer.status }
        );
      }
    }

    if (active !== null) {
      const answer = await performProxyAction({
        action: "set_provider_active",
        target: params.id,
        active,
      });
      if (answer.status !== 200) {
        return NextResponse.json(
          {
            success: false,
            error: answer.body.error || "the stream box refused the change",
            code: answer.body.code,
            result: answer.body.result,
          },
          { status: answer.status }
        );
      }
    }

    return NextResponse.json({ success: true, providerId: params.id });
  } catch (error: any) {
    return fail(error, "Failed to change the provider");
  }
}

/**
 * DELETE /api/admin/premium/providers/[id]
 *
 * Take one provider account off the box.
 *
 * The box refuses while a channel still points at the account, and says so: a provider with a
 * channel on it is a lane somebody is watching, and taking it away would break that stream
 * rather than tidy the list. The channels are moved or deleted first.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    if (!isAuthorizedAdmin(req)) return unauthorized();

    const answer = await performProxyAction({
      action: "delete_provider",
      target: params.id,
    });

    if (answer.status !== 200) {
      return NextResponse.json(
        {
          success: false,
          error: answer.body.error || "the stream box refused the removal",
          code: answer.body.code,
          result: answer.body.result,
        },
        { status: answer.status }
      );
    }

    return NextResponse.json({ success: true, providerId: params.id });
  } catch (error: any) {
    return fail(error, "Failed to remove the provider");
  }
}
