import type { NextRequest } from "next/server";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { handleBackendRequest } from "@/server/backend/app";
import { appRouter } from "@/server/rpc/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
    params: Promise<{ path?: string[] }> | { path?: string[] };
};

const rpcHandler = new RPCHandler(appRouter, {
    interceptors: [
        onError((error) => {
            console.error("[orpc]", error);
        }),
    ],
});

async function handler(request: NextRequest, context: RouteContext) {
    const params = await context.params;
    const path = `/${params.path?.join("/") ?? ""}`;

    const { response } = await rpcHandler.handle(request.clone(), {
        prefix: "/api/v1",
        context: { request },
    });

    if (response && response.status !== 404 && response.status !== 405) {
        return response;
    }

    return handleBackendRequest(request, path);
}

export {
    handler as DELETE,
    handler as GET,
    handler as HEAD,
    handler as PATCH,
    handler as POST,
    handler as PUT,
};
