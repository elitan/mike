import { ORPCError, os, type as orpcType } from "@orpc/server";
import { auth } from "@/server/backend/lib/auth";
import { createServerDb } from "@/server/backend/lib/db";
import { DEFAULT_TABULAR_MODEL, resolveModel } from "@/server/backend/lib/llm";
import {
    getUserApiKeyStatus,
    type ApiKeyStatus,
} from "@/server/backend/lib/userApiKeys";

const MONTHLY_CREDIT_LIMIT = 999999;

type RpcContext = {
    request: Request;
};

type AuthedUser = {
    id: string;
    email: string;
};

type UserProfileRow = {
    display_name: string | null;
    organisation: string | null;
    message_credits_used: number;
    credits_reset_date: string;
    tier: string;
    tabular_model: string;
};

type UpdateUserProfileInput = {
    displayName?: string | null;
    organisation?: string | null;
    tabularModel?: string;
};

async function requireRpcUser(request: Request): Promise<AuthedUser> {
    const session = await auth.api.getSession({
        headers: request.headers,
    });
    if (!session?.user) {
        throw new ORPCError("UNAUTHORIZED", {
            message: "Invalid or expired token",
        });
    }

    return {
        id: session.user.id,
        email: session.user.email?.toLowerCase() ?? "",
    };
}

function serializeProfile(row: UserProfileRow, apiKeyStatus: ApiKeyStatus) {
    const creditsUsed = row.message_credits_used ?? 0;
    return {
        displayName: row.display_name,
        organisation: row.organisation,
        messageCreditsUsed: creditsUsed,
        creditsResetDate: row.credits_reset_date,
        creditsRemaining: Math.max(MONTHLY_CREDIT_LIMIT - creditsUsed, 0),
        tier: row.tier || "Free",
        tabularModel: resolveModel(row.tabular_model, DEFAULT_TABULAR_MODEL),
        apiKeyStatus,
    };
}

function parseProfileUpdate(input: UpdateUserProfileInput) {
    const update: {
        display_name?: string | null;
        organisation?: string | null;
        tabular_model?: string;
        updated_at: string;
    } = { updated_at: new Date().toISOString() };

    if ("displayName" in input) {
        if (input.displayName !== null && typeof input.displayName !== "string") {
            throw new ORPCError("BAD_REQUEST", {
                message: "displayName must be a string or null",
            });
        }
        update.display_name = input.displayName?.trim() || null;
    }

    if ("organisation" in input) {
        if (
            input.organisation !== null &&
            typeof input.organisation !== "string"
        ) {
            throw new ORPCError("BAD_REQUEST", {
                message: "organisation must be a string or null",
            });
        }
        update.organisation = input.organisation?.trim() || null;
    }

    if ("tabularModel" in input) {
        if (typeof input.tabularModel !== "string") {
            throw new ORPCError("BAD_REQUEST", {
                message: "tabularModel must be a string",
            });
        }
        const resolved = resolveModel(input.tabularModel, "");
        if (!resolved) {
            throw new ORPCError("BAD_REQUEST", {
                message: "Unsupported tabularModel",
            });
        }
        update.tabular_model = resolved;
    }

    return update;
}

async function ensureProfileRow(
    db: ReturnType<typeof createServerDb>,
    userId: string,
) {
    const { error } = await db
        .insertInto("userProfiles")
        .upsert(
            { user_id: userId },
            { onConflict: "user_id", ignoreDuplicates: true },
        );
    if (error) throw error;
}

async function loadProfile(userId: string) {
    const db = createServerDb();
    await ensureProfileRow(db, userId);

    const { data, error } = await db
        .selectFrom("userProfiles")
        .select(
            "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model",
        )
        .where("userId", "=", userId)
        .single();
    if (error) throw error;

    let row = data as UserProfileRow;
    if (row.credits_reset_date && new Date() > new Date(row.credits_reset_date)) {
        const creditsResetDate = new Date();
        creditsResetDate.setDate(creditsResetDate.getDate() + 30);
        const reset = await db
            .updateTable("userProfiles")
            .set({
                message_credits_used: 0,
                credits_reset_date: creditsResetDate.toISOString(),
                updated_at: new Date().toISOString(),
            })
            .where("userId", "=", userId)
            .select(
                "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model",
            )
            .single();
        if (reset.error) throw reset.error;
        row = reset.data as UserProfileRow;
    }

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    return serializeProfile(row, apiKeyStatus);
}

export const appRouter = {
    user: {
        profile: os.handler(async ({ context }) => {
            const user = await requireRpcUser((context as RpcContext).request);
            return loadProfile(user.id);
        }),
        updateProfile: os
            .input(orpcType<UpdateUserProfileInput>())
            .handler(async ({ input, context }) => {
                const user = await requireRpcUser(
                    (context as RpcContext).request,
                );
                const db = createServerDb();
                await ensureProfileRow(db, user.id);
                const { error } = await db
                    .updateTable("userProfiles")
                    .set(parseProfileUpdate(input))
                    .where("userId", "=", user.id);
                if (error) throw error;
                return loadProfile(user.id);
            }),
        apiKeys: os.handler(async ({ context }) => {
            const user = await requireRpcUser((context as RpcContext).request);
            return getUserApiKeyStatus(user.id, createServerDb());
        }),
    },
};
