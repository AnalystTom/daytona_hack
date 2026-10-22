import { describe, expect, it } from "vitest";
import type { EvidenceRecord } from "../../shared/evidence";
import { D1RunStore } from "../store/d1";
import { testStorage } from "../test/storage";
import { cloudflareEvidenceStore } from "./store";
const env = testStorage();
const store = () => cloudflareEvidenceStore(new D1RunStore(env.DB,env.BLOBS));
const record: EvidenceRecord = {
  id:"ev_00000000-0000-4000-8000-000000000000",runId:"run_1",kind:"dom",label:"observed",pageOrState:"/",url:"https://example.com/",tool:"anchor",capturedAt:"2026-10-16T10:00:00.000Z",contentHash:"sha256:00",limitations:[],contentType:"text/html",byteLength:3,
};
describe("D1 evidence records and R2 content",()=>{
 it.each([0,3,3*1024*1024])("round-trips %i bytes outside D1 row limits",async size=>{
  const bytes = Uint8Array.from({length:size},(_,i)=>i%251);
  const current = {...record,byteLength:size};
  await store().putEvidence(current,bytes);
  expect(await store().getEvidence(record.id)).toEqual(current);
  expect(await store().getContent(record.id)).toEqual(bytes);
 });
 it("returns null for missing evidence and takes sign-in sessions once under concurrency",async()=>{
  expect(await store().getEvidence(record.id)).toBeNull();
  expect(await store().getContent(record.id)).toBeNull();
  const signIn={sessionId:"s1",origin:"https://example.com"};
  await store().saveSignIn("run_1",signIn);
  const taken=await Promise.all([store().takeSignIn("run_1"),store().takeSignIn("run_1")]);
  expect(taken.filter(Boolean)).toEqual([signIn]);
 });
 it("does not publish cancelled uploads or replace an existing record on duplicate writes",async()=>{
  const controller=new AbortController();controller.abort();
  await expect(store().putEvidence(record,new Uint8Array([1]),controller.signal)).rejects.toMatchObject({name:"AbortError"});
  expect(await store().getEvidence(record.id)).toBeNull();
  await store().putEvidence(record,new Uint8Array([1]));
  await expect(store().putEvidence(record,new Uint8Array([2]))).rejects.toThrow();
  expect(await store().getContent(record.id)).toEqual(new Uint8Array([1]));
  expect((await env.BLOBS.list()).objects).toHaveLength(1);
 });
 it("removes an upload if cancellation occurs during R2 upload",async()=>{
  const controller=new AbortController();
  const original=env.BLOBS.put.bind(env.BLOBS);
  const blobs={put:async(...args:Parameters<R2Bucket["put"]>)=>{const result=await original(...args);controller.abort();return result;},delete:env.BLOBS.delete.bind(env.BLOBS)} as R2Bucket;
  const db=new D1RunStore(env.DB,blobs);
  await expect(cloudflareEvidenceStore(db).putEvidence(record,new Uint8Array([1]),controller.signal)).rejects.toMatchObject({name:"AbortError"});
  expect(await store().getEvidence(record.id)).toBeNull();expect((await env.BLOBS.list()).objects).toHaveLength(0);
 });
 it("refuses malformed identifiers",async()=>{
  await expect(store().getEvidence("ev_x'; DROP TABLE evidence; --")).rejects.toThrow("Invalid evidence id");
 });
});
