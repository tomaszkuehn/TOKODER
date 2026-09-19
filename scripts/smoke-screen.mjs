import { screenCommand } from "../dist/tools/bash.js";
const cases = [
  ["ls -la", "ALLOW"],
  ["git status", "ALLOW"],
  ["type ..\\..\\..\\evil.txt", "DENIED (traversal)"],
  ["del C:\\Users\\x\\file", "ACL"],
  ["cat /mnt/c/Users/x/secret", "ACL"],
  ["echo %USERPROFILE%", "ACL"],
  ["rm -rf /tmp/x", "ACL"],
  ["copy file C:\\Windows\\system32\\evil", "DENIED (system)"],
  ["cd C:\\Users\\pantomas && ls", "ACL"],
];
let bad = 0;
for (const [cmd, expect] of cases) {
  const r = screenCommand(cmd);
  const verdict = r === null ? "ALLOW" : r.startsWith("Error:") ? "DENIED" : "ACL-REQ";
  const tag = r === null ? "ALLOW" : r.startsWith("Error:") ? "DENIED" : "ACL";
  const ok = tag === expect || (expect === "ACL" && tag === "ACL-REQ") || (expect.startsWith("DENIED") && tag === "DENIED");
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${verdict.padEnd(8)} (want ${expect}) | ${cmd}`);
}
console.log(bad === 0 ? "ALL PASS" : `${bad} FAILURES`);