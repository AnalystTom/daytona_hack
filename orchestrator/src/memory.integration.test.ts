import { describe, expect, it } from "vitest";
import { testStorage } from "../../src/worker/test/storage";
import { recall, remember } from "./services";
import type { Env } from "./types";
const storage=testStorage();
const env=storage as Env;
describe("Agent Memory in D1",()=>{
 it("persists facts and recalls only the requested run scope",async()=>{
  await remember(env,"org/reversy/run/a","Hero: 64px heading","2026-10-22T09:00:00Z");
  await remember(env,"org/reversy/run/a/page","Pricing has three plans","2026-10-22T09:00:01Z");
  await remember(env,"org/reversy/run/ab","Other user's private fact");
  expect(await recall(env,"org/reversy/run/a","heading")).toBe("Hero: 64px heading\nPricing has three plans");
  expect(await recall(env,"org/reversy/run/missing","heading")).toBe("");
 });
 it("does not write when cancellation occurs at the work guard",async()=>{
  const controller=new AbortController();
  await expect(remember(env,"org/reversy/run/a","cancelled",undefined,async()=>{controller.abort();},controller.signal)).rejects.toMatchObject({name:"AbortError"});
  expect(await recall(env,"org/reversy/run/a","cancelled")).toBe("");
 });
});
