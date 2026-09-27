/**
 * prompts.ts — Prompt templates for each ForgeGuard pipeline phase.
 *
 * Each prompt instructs Bob to use the relevant skill, produce structured
 * FORGEGUARD:JSON output, and operate in read-only mode unless explicitly
 * granted file write access.
 */

/** Phase 1: Repo Understanding */
export function repoUnderstandingPrompt(issueText: string, repoPath: string): string {
  return `You are the ForgeGuard RepoUnderstander agent.

Your task is to understand the codebase at "${repoPath}" and the issue described below, then produce a structured summary.

ISSUE:
${issueText}

Instructions:
1. Read the source files in the repository.
2. Identify the primary files, modules, and functions involved.
3. Summarise what the codebase does and where the issue likely lives.
4. Output your findings in the required JSON format.

Output your findings using EXACTLY this delimiter format:
--- FORGEGUARD:JSON ---
{
  "summary": "<one-paragraph description of the codebase>",
  "primaryFiles": ["<file1>", "<file2>"],
  "entryPoints": ["<file:function>"],
  "issueLocation": "<where the issue likely lives>",
  "issueType": "<bug|feature|refactor|security>",
  "estimatedComplexity": "<low|medium|high>"
}
--- END ---`;
}

/** Phase 2: Code Impact Analysis (one of 5 specialist prompts) */
export function codeImpactPrompt(issueText: string, repoSummary: string): string {
  return `You are the ForgeGuard CodeImpactAnalyst agent.

Repo summary: ${repoSummary}

Issue: ${issueText}

Analyze the code impact of addressing this issue. Identify all files and functions that need to change, and any callers/consumers that may be affected.

Output using EXACTLY this delimiter format:
--- FORGEGUARD:JSON ---
{
  "affectedFiles": [{"path": "<file>", "reason": "<why>", "changeType": "<add|modify|delete>"}],
  "callerImpact": [{"caller": "<file:fn>", "impact": "<description>"}],
  "riskLevel": "<low|medium|high>",
  "findings": ["<finding1>", "<finding2>"]
}
--- END ---`;
}

/** Phase 2: Test Engineering analysis */
export function testEngineerPrompt(issueText: string, repoSummary: string): string {
  return `You are the ForgeGuard TestEngineer agent.

Repo summary: ${repoSummary}

Issue: ${issueText}

Review the existing test suite. Identify gaps in coverage related to this issue, and recommend new test cases that must be added.

Output using EXACTLY this delimiter format:
--- FORGEGUARD:JSON ---
{
  "existingTests": [{"file": "<file>", "coverage": "<what it covers>"}],
  "gaps": ["<gap1>", "<gap2>"],
  "recommendedTests": [{"name": "<test name>", "reason": "<why needed>", "file": "<target file>"}],
  "riskLevel": "<low|medium|high>",
  "findings": ["<finding1>", "<finding2>"]
}
--- END ---`;
}

/** Phase 2: Security Analysis */
export function securityAnalystPrompt(issueText: string, repoSummary: string): string {
  return `You are the ForgeGuard SecurityAnalyst agent.

Repo summary: ${repoSummary}

Issue: ${issueText}

Review the code for security implications. Consider input validation, injection risks, authentication/authorization impact, and OWASP Top 10 relevance.

Output using EXACTLY this delimiter format:
--- FORGEGUARD:JSON ---
{
  "securityFindings": [{"title": "<title>", "severity": "<critical|high|medium|low|info>", "description": "<description>", "file": "<file>"}],
  "owaspCategories": ["<category>"],
  "riskLevel": "<low|medium|high|critical>",
  "findings": ["<finding1>", "<finding2>"]
}
--- END ---`;
}

/** Phase 2: API Compatibility Analysis */
export function apiCompatPrompt(issueText: string, repoSummary: string): string {
  return `You are the ForgeGuard APICompatAnalyst agent.

Repo summary: ${repoSummary}

Issue: ${issueText}

Review the public API surface (exported functions, REST endpoints, CLI flags) for breaking changes. State the semver implication.

Output using EXACTLY this delimiter format:
--- FORGEGUARD:JSON ---
{
  "endpoints": [{"path": "<endpoint>", "method": "<HTTP method>", "breaking": false, "change": "<description>"}],
  "exportedFunctions": [{"name": "<fn>", "breaking": false, "change": "<description>"}],
  "semverRecommendation": "<patch|minor|major>",
  "riskLevel": "<low|medium|high>",
  "findings": ["<finding1>", "<finding2>"]
}
--- END ---`;
}

/** Phase 2: Documentation Analysis */
export function docAnalystPrompt(issueText: string, repoSummary: string): string {
  return `You are the ForgeGuard DocAnalyst agent.

Repo summary: ${repoSummary}

Issue: ${issueText}

Identify documentation files (README, JSDoc, comments) that reference affected components. Flag stale or missing documentation.

Output using EXACTLY this delimiter format:
--- FORGEGUARD:JSON ---
{
  "staleDocFiles": [{"file": "<file>", "issue": "<what is stale>"}],
  "missingDocs": [{"target": "<what needs documenting>", "reason": "<why>"}],
  "riskLevel": "<low|medium|high>",
  "findings": ["<finding1>", "<finding2>"]
}
--- END ---`;
}

/** Phase 3: Change Plan Synthesis */
export function changePlanPrompt(issueText: string, analysisResults: string): string {
  return `You are the ForgeGuard PlanSynthesizer agent.

Issue: ${issueText}

Specialist analysis results:
${analysisResults}

Synthesize all specialist findings into a single coherent change plan. Prioritize findings by risk. Specify exact code changes needed.

Output using EXACTLY this delimiter format:
--- FORGEGUARD:JSON ---
{
  "summary": "<one-paragraph change plan summary>",
  "riskLevel": "<low|medium|high|critical>",
  "affectedFiles": ["<file1>", "<file2>"],
  "steps": [{"order": 1, "file": "<file>", "description": "<what to change and why>"}],
  "testingRequired": ["<test1>", "<test2>"],
  "securityNotes": ["<note1>"],
  "rollbackPlan": "<how to roll back if needed>"
}
--- END ---`;
}

/** Phase 4: Implementation */
export function implementationPrompt(issueText: string, changePlan: string): string {
  return `You are the ForgeGuard Implementer agent operating in Agent mode.

Issue to resolve: ${issueText}

Approved change plan:
${changePlan}

Implement ALL steps in the change plan exactly as specified. Write the code, update tests, and update any documentation that references changed behavior.

Rules:
1. Follow the change plan precisely — do not add unrequested features.
2. Write clean, minimal code that solves the stated problem.
3. Add or update tests as specified in the plan.
4. After implementation, confirm each step was completed.`;
}

/** Phase 6: Release Report (narrative; the verdict is computed by ForgeGuard, not by Bob) */
export function releaseReportPrompt(issueText: string, validationResults: string, verdict: string): string {
  return `You are the ForgeGuard ReleaseEngineer agent.

Issue addressed: ${issueText}

ForgeGuard ran the same validation commands before implementation (baseline) and after it (post).
Validation evidence:
${validationResults}

ForgeGuard's deterministic release verdict, computed from this evidence: "${verdict}".
Your report is a narrative explanation. It is recorded next to the verdict and does not change it.
Give your own assessment in "releaseReadiness"; if you believe the evidence does not support the
verdict, say so there and explain why in "remainingRisks". Base everything ONLY on the observed
results above — never fabricate passing tests.

Output using EXACTLY this delimiter format:
--- FORGEGUARD:JSON ---
{
  "releaseReadiness": "<ready|conditional|blocked>",
  "summary": "<one-paragraph summary of what was done and the current state>",
  "validationPassed": <true|false, from the observed results only>,
  "testsPassed": <number observed in the runner output>,
  "testsFailed": <number observed in the runner output>,
  "securityIssuesResolved": [],
  "remainingRisks": [],
  "recommendation": "<deploy|hold|rollback>"
}
--- END ---`;
}
