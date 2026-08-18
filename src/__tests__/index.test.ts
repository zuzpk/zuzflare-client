import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  instances: [] as Array<{
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    onAuthStateChanged: ReturnType<typeof vi.fn>;
    signOut: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../Client", () => {
  class MockFlareClient {
    connect = vi.fn();
    disconnect = vi.fn();
    onAuthStateChanged = vi.fn();
    signOut = vi.fn();

    constructor(_config: unknown) {
      mockState.instances.push(this as any);
    }
  }

  return { default: MockFlareClient };
});

describe("index singleton helpers", () => {
  beforeEach(async () => {
    mockState.instances.length = 0;
    vi.resetModules();
  });

  it("connectApp creates one singleton and aliases onAuthStateChange", async () => {
    const mod = await import("../index");

    const config = {
      endpoint: "https://flare.test",
      appId: "app-1",
      apiKey: "key-1",
    };

    const first = mod.connectApp(config as any);
    const second = mod.connectApp(config as any);

    expect(first).toBe(second);
    expect(mockState.instances).toHaveLength(1);
    expect(mockState.instances[0].connect).toHaveBeenCalledTimes(1);

    (first as any).onAuthStateChange("cb");
    expect(mockState.instances[0].onAuthStateChanged).toHaveBeenCalledWith("cb");
  });

  it("connectApp disconnects old instance when config changes", async () => {
    const mod = await import("../index");

    mod.connectApp({ endpoint: "https://flare.test", appId: "app-1", apiKey: "key-1" } as any);
    mod.connectApp({ endpoint: "https://flare.test", appId: "app-2", apiKey: "key-1" } as any);

    expect(mockState.instances).toHaveLength(2);
    expect(mockState.instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(mockState.instances[1].connect).toHaveBeenCalledTimes(1);
  });

  it("getFlare returns singleton and disconnectFlare resets it", async () => {
    const mod = await import("../index");

    const instance = mod.connectApp({ endpoint: "https://flare.test", appId: "app-1" } as any);
    expect(mod.getFlare()).toBe(instance);

    mod.disconnectFlare();

    expect(mockState.instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(mod.getFlare()).toBeNull();
  });
});
