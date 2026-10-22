import { readFile } from "node:fs/promises";
import { URL as NodeURL } from "node:url";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach } from "vitest";
import type { StoreEnv } from "../store";

// Each test file owns one isolated workerd/D1/R2 runtime and disposes it on all outcomes.
export function testStorage() {
  let mf: Miniflare;
  let actual: Required<StoreEnv>;
  const proxy = <K extends keyof StoreEnv>(name: K) => new Proxy({}, {
    get(_target,key) {
      const binding = actual[name];
      const value = Reflect.get(binding,key);
      return typeof value === "function" ? value.bind(binding) : value;
    },
  }) as NonNullable<StoreEnv[K]>;
  const env = {DB: proxy("DB"), BLOBS: proxy("BLOBS")};
  beforeAll(async () => {
    mf = new Miniflare({workers:[{name:"storage-test",modules:true, script:"export default {fetch(){return new Response('ok')}}", compatibilityDate:"2026-10-01", d1Databases:{DB:"storage-test-db"},r2Buckets:{BLOBS:"storage-test-blobs"}}]});
    actual = {DB: await mf.getD1Database("DB") as unknown as D1Database, BLOBS: await mf.getR2Bucket("BLOBS") as unknown as R2Bucket};
    await actual.DB.exec(await readFile(new NodeURL("../../../migrations/0001_cloudflare_storage.sql",import.meta.url),"utf8"));
  },30_000);
  beforeEach(async () => {
    await actual.DB.batch(["event","task","steering","approval","memory","run","run_owner","run_quota","admission","evidence","sign_in","example","report_run","report_figure","report_source","report_edit","agent_memory"].map(table => actual.DB.prepare(`DELETE FROM ${table}`)));
    const objects = await actual.BLOBS.list();
    if (objects.objects.length) await actual.BLOBS.delete(objects.objects.map(o=>o.key));
  });
  afterAll(async () => {await mf?.dispose();},30_000);
  return env;
}
