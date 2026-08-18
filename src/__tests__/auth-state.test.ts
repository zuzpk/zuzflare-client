import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const httpMocks = vi.hoisted(() => ({
  getCookie: vi.fn(() => null),
  withGet: vi.fn(),
  withPost: vi.fn(),
  withPut: vi.fn(),
  withPatch: vi.fn(),
}));

vi.mock("@zuzjs/core", async () => {
  return {
    getCookie: httpMocks.getCookie,
    uuid2: vi.fn(() => "req-1"),
    withGet: httpMocks.withGet,
    withPost: httpMocks.withPost,
    withPut: httpMocks.withPut,
    withPatch: httpMocks.withPatch,
  };
});

describe("auth state bootstrap", () => {
  const originalWindow = (globalThis as any).window;
  const originalDocument = (globalThis as any).document;

  beforeEach(() => {
    (globalThis as any).window = {
      localStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
      },
    };
    (globalThis as any).document = { cookie: "" };
    httpMocks.getCookie.mockReset();
    httpMocks.getCookie.mockReturnValue(null);
    httpMocks.withGet.mockReset();
    httpMocks.withPost.mockReset();
    httpMocks.withPut.mockReset();
    httpMocks.withPatch.mockReset();
  });

  afterEach(() => {
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
    vi.restoreAllMocks();
  });

  it("bootstraps auth refresh from endpoint when httpBase is not set", async () => {
    httpMocks.withGet.mockImplementation(async (url: string) => {
      if (url.includes("/auth/config?")) {
        return {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-flare-csrf": "csrf-token-1",
          },
          data: {
            appId: "taskboard",
            cookie: {
              accessTokenName: "__flare_at_taskboard",
              refreshTokenName: "__flare_rt_taskboard",
              csrfTokenName: "__flare_csrf_taskboard",
            },
          },
        };
      }

      if (url.includes("/auth/me?")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          data: {
            kind: "auth/profile",
            id: "user-1",
            email: "user@example.com",
            email_verified: true,
          },
        };
      }

      throw new Error(`Unexpected GET: ${url}`);
    });

    httpMocks.withPost.mockImplementation(async (url: string) => {
      if (url.includes("/auth/refresh?")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          data: {
            kind: "auth/session",
            access_token: "access-1",
            refresh_token: "refresh-1",
            expires_in: 86400,
            token_type: "Bearer",
            expires_at: new Date(Date.now() + 86400000).toISOString(),
          },
        };
      }

      throw new Error(`Unexpected POST: ${url}`);
    });

    const { default: FlareClient } = await import("../Client");

    const client = new FlareClient({
      appId: "taskboard",
      apiKey: "key-1",
      endpoint: "https://flare.example.com",
    });

    const events: Array<any> = [];
    client.onAuthStateChanged((session) => {
      events.push(session);
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(httpMocks.withPost).toHaveBeenCalled();
    expect(httpMocks.withPost.mock.calls.some(([url]) => String(url).includes("/auth/refresh?"))).toBe(true);
    expect(events.some((event) => event?.uid === "user-1")).toBe(true);
  });

  it("surfaces upstream auth payload errors for email sign-in even on 200 responses", async () => {
    httpMocks.withPost.mockImplementation(async (url: string) => {
      if (url.includes("/auth/token?")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          data: {
            error: "auth/invalid-email",
            message: "No user found with that email address",
          },
        };
      }

      throw new Error(`Unexpected POST: ${url}`);
    });

    const { default: FlareClient } = await import("../Client");

    const client = new FlareClient({
      appId: "taskboard",
      apiKey: "key-1",
      endpoint: "https://flare.example.com",
      httpBase: "https://flare.example.com",
    });

    await expect(client.signInWithEmailAndPassword("missing@example.com", "pw-1"))
      .rejects
      .toMatchObject({
        name: "ZuzFlareError",
        code: "auth/invalid-email",
        message: "No user found with that email address",
      });
  });
});