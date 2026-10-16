import { describe, expect, it } from "vitest";
import { Failure } from "../runs/api";
import { accessConfig, verifyAccessJwt } from "./access";
import { AUD, accessJwt, certs, TEAM } from "./access-fixtures";

const config = { team: TEAM, aud: AUD };

const refusal = async (token: string) => {
  const error = await verifyAccessJwt(token, config, certs).catch((e) => e);
  expect(error).toBeInstanceOf(Failure);
  expect(error.status).toBe(401);
  return error.message as string;
};

describe("Cloudflare Access JWT", () => {
  it("returns the email of a valid sign-in, lowercased", async () => {
    const token = await accessJwt({ email: "Ada@Example.com" });
    expect(await verifyAccessJwt(token, config, certs)).toBe("ada@example.com");
  });

  it("accepts a single-string audience", async () => {
    const token = await accessJwt({ aud: AUD });
    expect(await verifyAccessJwt(token, config, certs)).toBe("ada@example.com");
  });

  it("refuses an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(await refusal(await accessJwt({ exp: past }))).toMatch(/expired/);
  });

  it("refuses a token for another Access application", async () => {
    expect(await refusal(await accessJwt({ aud: ["other-app"] }))).toMatch(
      /another app/,
    );
  });

  it("refuses a token from another team", async () => {
    const token = await accessJwt({ iss: "https://evil.cloudflareaccess.com" });
    expect(await refusal(token)).toMatch(/another team/);
  });

  it("refuses a tampered token and one signed by an unknown key", async () => {
    const [head, , signature] = (await accessJwt()).split(".");
    const forged = btoa(
      JSON.stringify({
        aud: [AUD],
        iss: `https://${TEAM}`,
        email: "mallory@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).replace(/=+$/, "");
    expect(await refusal(`${head}.${forged}.${signature}`)).toMatch(
      /signature/,
    );
    expect(await refusal(await accessJwt({}, "unknown-kid"))).toMatch(
      /signature/,
    );
  });

  it("refuses garbage and an unsigned token", async () => {
    expect(await refusal("not-a-jwt")).toMatch(/could not be read/);
    const none = btoa(JSON.stringify({ alg: "none" }));
    expect(await refusal(`${none}.e30.`)).toMatch(/could not be read/);
  });

  it("is off without bindings and names a half-set one", () => {
    expect(accessConfig({})).toBeNull();
    expect(
      accessConfig({
        ACCESS_TEAM_DOMAIN: `https://${TEAM}/`,
        ACCESS_AUD: AUD,
      }),
    ).toEqual(config);
    expect(() => accessConfig({ ACCESS_TEAM_DOMAIN: TEAM })).toThrow(
      /ACCESS_AUD/,
    );
  });
});
