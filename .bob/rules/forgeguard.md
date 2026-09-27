# ForgeGuard Project Rules

These rules apply to all Bob sessions in this project.
They enforce the ForgeGuard principle of evidence-based, auditable, minimal engineering.

---

## 1. EVIDENCE OVER CLAIMS

Never say a test passed unless the test was actually executed and the runner output is included.
Never fabricate execution output, analysis results, file contents, or test names.
Every claim must trace to an observed fact in the repository or a real command output.

---

## 2. SEPARATE FACTS FROM RECOMMENDATIONS

Use **OBSERVED:** for things directly seen in the code, files, or command output.
Use **RECOMMENDATION:** for AI suggestions and proposed changes.
Never blend observations and recommendations in the same sentence.

---

## 3. STRUCTURED OUTPUT

When asked to produce JSON for ForgeGuard, wrap it in exactly these delimiters:

```
--- FORGEGUARD:JSON ---
{ ... }
--- END ---
```

Do not add prose inside the JSON block. Do not omit the delimiters.

---

## 4. MINIMAL CHANGES

Make the smallest change that solves the stated problem.
Do not refactor unrelated code.
Do not add unrequested features, abstractions, or design patterns.
Every changed line must trace directly to the stated requirement.

---

## 5. NEVER EXPOSE SECRETS

Never include API keys, passwords, tokens, or credentials in any output.
Never read or log the contents of .env files.
Never commit secrets to version control.

---

## 6. NEVER MODIFY UNRELATED FILES

Only modify files that are directly required by the current task.
If a file appears unrelated but might be affected, note it under RECOMMENDATION: and ask before modifying.

---

## 7. VALIDATE WITH TESTS

Any change to application logic must be accompanied by:
- Running the existing test suite and including the verbatim output.
- Identifying whether new tests are needed for the changed code.
Do not claim "tests pass" without showing the runner output.

---

## 8. SECURITY-SENSITIVE CHANGES REQUIRE EXPLICIT VALIDATION

If a change touches: authentication, authorization, input handling, secret management,
external API calls, or file system access — flag it with:
SECURITY NOTE: <description of the security-relevant aspect>

---

## 9. API CHANGES REQUIRE CONSUMER CHECK

If a public API surface (exported function, REST endpoint, CLI flag) is changed,
identify all callers/consumers and assess whether the change is breaking.
State the semver implication (patch / minor / major).

---

## 10. UPDATE DOCUMENTATION WHEN BEHAVIOUR CHANGES

If a function, endpoint, or module has its behaviour changed, check whether:
- The README references it
- The JSDoc/comments are accurate
- The API documentation is current
Flag any stale documentation under OBSERVED: stale docs.

---

## 11. PRESERVE ROLLBACK CAPABILITY

Before modifying any file in a ForgeGuard implementation task:
Confirm that a git stash or branch has been created as a rollback anchor.
If not, create it before proceeding: `git stash push -m "forgeguard-rollback-<missionId>"`

---

## 12. AUDIT TRAIL

Begin every substantive response with a one-line summary of what was done.
Follow with the evidence (command output, file diffs, observations).
Session IDs and task IDs must be preserved in the evidence record.
