import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

import { FlareConfig, StructuredQuery } from "../types";

const isNodeRuntime = (): boolean => {
    return typeof process !== "undefined" && !!process.versions?.node;
};

const shouldUseGrpc = (config: FlareConfig): boolean => {
    if (config.transport === "ws" || config.transport === "http") return false;
    if (!config.grpcUrl || config.grpcUrl.trim().length === 0) return false;
    if (!isNodeRuntime()) return false;
    return true;
};

async function createGrpcQueryClient(address: string): Promise<any> {
    const grpc = await import("@grpc/grpc-js");
    const protoLoader = await import("@grpc/proto-loader");

    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
        path.resolve(here, "../../proto"),
        path.resolve(here, "../proto"),
        path.resolve(process.cwd(), "proto"),
    ];
    const protoDir = candidates.find((dir) => fs.existsSync(path.join(dir, "flare.proto"))) ?? candidates[0];
    const protoFile = path.join(protoDir, "flare.proto");

    const packageDef = await protoLoader.load(protoFile, {
        keepCase: false,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
        includeDirs: [protoDir],
    });

    const loaded = grpc.loadPackageDefinition(packageDef) as any;
    const flarePkg = loaded.flare;
    return new flarePkg.QueryService(address, grpc.credentials.createInsecure());
}

async function createGrpcAuthClient(address: string): Promise<any> {
    const grpc = await import("@grpc/grpc-js");
    const protoLoader = await import("@grpc/proto-loader");

    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
        path.resolve(here, "../../proto"),
        path.resolve(here, "../proto"),
        path.resolve(process.cwd(), "proto"),
    ];
    const protoDir = candidates.find((dir) => fs.existsSync(path.join(dir, "flare.proto"))) ?? candidates[0];
    const protoFile = path.join(protoDir, "flare.proto");

    const packageDef = await protoLoader.load(protoFile, {
        keepCase: false,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
        includeDirs: [protoDir],
    });

    const loaded = grpc.loadPackageDefinition(packageDef) as any;
    const flarePkg = loaded.flare;
    return new flarePkg.AuthService(address, grpc.credentials.createInsecure());
}

function promisifyRunQuery(client: any, req: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
        client.RunQuery(req, (err: Error | null, response: any) => {
            if (err) return reject(err);
            resolve(response ?? {});
        });
    });
}

export async function runGrpcQuery<T = Record<string, unknown>>(
    config: FlareConfig,
    collection: string,
    query: StructuredQuery,
): Promise<T[] | null> {
    if (!shouldUseGrpc(config)) return null;

    const client = await createGrpcQueryClient(config.grpcUrl!);
    const response = await promisifyRunQuery(client, {
        app_id: config.appId,
        collection,
        query,
    });

    if (response?.error) {
        throw new Error(`[flare-client][grpc] run_query failed: ${response.error_description || response.error}`);
    }

    try {
        const parsed = JSON.parse(response?.data_json || "[]");
        return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
        return [];
    }
}

export async function runGrpcLogin(
    config: FlareConfig,
    email: string,
    password: string,
): Promise<{ token: string; refreshToken: string | null; role: string } | null> {
    if (!shouldUseGrpc(config)) return null;

    const client = await createGrpcAuthClient(config.grpcUrl!);
    const response = await new Promise<any>((resolve, reject) => {
        client.Login(
            {
                app_id: config.appId,
                client_id: config.apiKey ?? "",
                email,
                password,
            },
            (err: Error | null, res: any) => {
                if (err) return reject(err);
                resolve(res ?? {});
            },
        );
    });

    if (response?.error) {
        throw new Error(`[flare-client][grpc] login failed: ${response.error_description || response.error}`);
    }

    return {
        token: String(response?.token ?? ""),
        refreshToken: response?.refresh_token ? String(response.refresh_token) : null,
        role: String(response?.role ?? "user"),
    };
}

export async function runGrpcRegister(
    config: FlareConfig,
    email: string,
    password: string,
): Promise<{ token: string; role: string; userId: string } | null> {
    if (!shouldUseGrpc(config)) return null;

    const client = await createGrpcAuthClient(config.grpcUrl!);
    const response = await new Promise<any>((resolve, reject) => {
        client.Register(
            {
                app_id: config.appId,
                client_id: config.apiKey ?? "",
                email,
                password,
            },
            (err: Error | null, res: any) => {
                if (err) return reject(err);
                resolve(res ?? {});
            },
        );
    });

    if (response?.error) {
        throw new Error(`[flare-client][grpc] register failed: ${response.error_description || response.error}`);
    }

    return {
        token: String(response?.token ?? ""),
        role: String(response?.role ?? "user"),
        userId: String(response?.user_id ?? ""),
    };
}
