import {createHash} from "node:crypto";
import {expect,it} from "vitest";
import {FileEvidence} from "../src/file-evidence.js";
it("requires both digest and text, even when UTF-8 text crosses chunk boundaries",()=>{
 const bytes=Buffer.from("header 정상 확인 tail");
 const hash=createHash("sha256").update(bytes).digest("hex");
 const good=new FileEvidence(hash,"정상 확인");
 for (const byte of bytes) good.update(Buffer.from([byte]));
 expect(good.matches()).toBe(true);
 const wrong=new FileEvidence("0".repeat(64),"정상 확인");
 wrong.update(bytes); expect(wrong.matches()).toBe(false);
});
it("rejects unbounded streams and mismatched text",()=>{
 const large=new FileEvidence(undefined,"needle");
 large.update(Buffer.alloc(32*1024*1024));
 expect(()=>large.update(Buffer.from("x"))).toThrow(/exceeds/);
 const mismatch=new FileEvidence(undefined,"needle");
 mismatch.update(Buffer.from("different"));expect(mismatch.matches()).toBe(false);
});
