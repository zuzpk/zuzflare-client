import { describe, expect, it } from "vitest";
import { connectApp } from "../index";

const runReal = process.env.RUN_REAL_FLARE_TESTS === "1";
const describeReal = runReal ? describe : describe.skip;

const app = connectApp({
  appId: "zuzflare2",
  apiKey: "FA_Pvq5_komInF7hBoW8MQ3l_0_kv_HGGMdQgKrz5",
  endpoint: "https://flare.zuzcdn.net",
});

const randomEmail = () => `flare.integration.${Date.now()}.${Math.floor(Math.random() * 100000)}@example.com`;
const strongPassword = () => `Zuz!${Date.now()}_${Math.floor(Math.random() * 10000)}`;

describeReal("FlareClient real auth integration", () => {
  it("can sign in or sign up with email/password using real endpoint", async () => {
    const email = randomEmail();
    const password = strongPassword();

    const result = await app.signInOrCreateWithEmailAndPassword(email, password);

    expect(result).toBeDefined();
    expect(typeof result.created).toBe("boolean");
  }, 30000);

  it("can trigger verification and recovery emails using real endpoint", async () => {
    const email = randomEmail();

    const verification = await app.sendEmailVerification(email);
    const recovery = await app.sendAccountRecovery(email);

    expect(typeof verification.sent).toBe("boolean");
    if (verification.emailSent !== undefined) {
      expect(typeof verification.emailSent).toBe("boolean");
    }
    expect(typeof recovery.sent).toBe("boolean");
  }, 30000);
});
