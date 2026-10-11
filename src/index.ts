/**
 * Designesy Score Action — scores a PR preview deployment and posts a
 * sticky comment with the result.
 *
 * Inputs (from action.yml):
 *   url           — direct URL to score
 *   url-command   — shell command whose stdout is the URL
 *   scope         — contract | universal (default: universal)
 *   min-score     — fail if score < N (default: 0 = disabled)
 *   min-grade     — fail if grade worse than letter (default: disabled)
 *   format        — designesy | canonical | review | google (default: designesy)
 *                   Only designesy and canonical carry per-status counts;
 *                   for the other formats the action reads the engine's
 *                   designesy JSON to set outputs and the comment.
 *   fail-on-error — fail step if engine errors (default: true)
 *   github-token  — GitHub token for PR comments (default: GITHUB_TOKEN)
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import { execFileSync } from 'node:child_process';

const GRADE_RANK: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, F: 1 };

/** The scoring engine package run through npx. */
const ENGINE_PACKAGE = '@designesy/score@latest';

/** Emission formats whose JSON carries structured per-check results. */
const STRUCTURED_FORMATS = new Set(['designesy', 'canonical']);

interface ScoreResult {
  score: number;
  grade: string;
  pass: number;
  warn: number;
  fail: number;
  skip: number;
  manual: number;
  total: number;
  contractVersion?: string;
  error?: string;
  checks?: Array<{
    id: string;
    item: string;
    category: string;
    status: 'PASS' | 'FAIL' | 'WARN' | 'SKIP' | 'MANUAL';
    detail: string;
    remediation?: string;
  }>;
  a11yFloorApplied?: boolean;
  hardFailCeilingApplied?: boolean;
  hardFailCeilingReason?: string;
  slop?: { total: number; convergences?: string };
  originality?: { points: number; summary?: string };
}

/**
 * Resolve the URL to score — either from the `url` input or by running
 * `url-command` and capturing stdout.
 */
function resolveUrl(): string {
  const directUrl = core.getInput('url');
  const urlCommand = core.getInput('url-command');

  if (directUrl) return directUrl;
  if (urlCommand) {
    try {
      const output = execFileSync(urlCommand, {
        encoding: 'utf8',
        shell: true,
        timeout: 10000,
      }).trim();
      if (output) return output;
    } catch (err) {
      core.setFailed(
        `url-command failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }

  core.setFailed(
    'Either `url` or `url-command` input is required. Provide the preview deployment URL.',
  );
  process.exit(1);
}

/**
 * The engine's own reason for a failed run: the first non-empty stderr line,
 * without terminal colour codes.
 */
function engineErrorLine(err: unknown): string {
  const stderr = (err as { stderr?: unknown })?.stderr;
  if (typeof stderr !== 'string') return '';
  return (
    stderr
      .replace(/\u001b\[[0-9;]*m/g, '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('npm warn')) ?? ''
  );
}

/**
 * Run the @designesy/score engine via npx and parse the JSON output.
 *
 * The check total, per-status counts and contract version all come from the
 * engine's own output; nothing about the engine's size is hard-coded here.
 */
function runScore(url: string, scope: string, format: string): ScoreResult {
  // The other formats emit prose / annotation shapes with no per-status
  // counts, so the action reads the designesy shape for those.
  const engineFormat = STRUCTURED_FORMATS.has(format) ? format : 'designesy';
  if (engineFormat !== format) {
    core.info(
      `format=${format} has no per-check counts; reading the designesy JSON for outputs and the comment.`,
    );
  }

  const npxArgs = [
    '--yes',
    ENGINE_PACKAGE,
    url,
    '--scope',
    scope,
    '--format',
    engineFormat,
    '--json',
    '--quiet',
  ];

  core.info(
    `Scoring ${url} with ${ENGINE_PACKAGE} (scope=${scope}, format=${engineFormat})…`,
  );

  try {
    const stdout = execFileSync('npx', npxArgs, {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const parsed = JSON.parse(stdout);

    // Canonical format nests the score under summary and the checks under
    // findings; the contract version is the tool version.
    if (engineFormat === 'canonical') {
      const counts = parsed.summary?.countsByStatus ?? {};
      return {
        score: parsed.summary?.score ?? 0,
        grade: parsed.summary?.grade ?? 'F',
        pass: counts.pass ?? 0,
        warn: counts.warn ?? 0,
        fail: counts.fail ?? 0,
        skip: counts.skip ?? 0,
        manual: counts.manual ?? 0,
        total: parsed.summary?.total ?? parsed.findings?.length ?? 0,
        contractVersion: parsed.tool?.version,
        a11yFloorApplied: parsed.summary?.a11yFloorApplied,
        checks: parsed.findings?.map(
          (f: {
            id: string;
            item: string;
            category: string;
            status: string;
            detail: string;
            remediation?: string;
          }) => ({
            id: f.id,
            item: f.item,
            category: f.category,
            status: f.status as 'PASS' | 'FAIL' | 'WARN' | 'SKIP' | 'MANUAL',
            detail: f.detail,
            remediation: f.remediation,
          }),
        ),
      };
    }

    // designesy format (default)
    return {
      score: parsed.score ?? 0,
      grade: parsed.grade ?? 'F',
      pass: parsed.pass ?? 0,
      warn: parsed.warn ?? 0,
      fail: parsed.fail ?? 0,
      skip: parsed.skip ?? 0,
      manual: parsed.manual ?? 0,
      total: parsed.total ?? parsed.checks?.length ?? 0,
      contractVersion: parsed.contractVersion,
      checks: parsed.checks,
      a11yFloorApplied: parsed.a11yFloorApplied,
      hardFailCeilingApplied: parsed.hardFailCeilingApplied,
      hardFailCeilingReason: parsed.hardFailCeilingReason,
      slop: parsed.slop,
      originality: parsed.originality,
    };
  } catch (err) {
    const failOnError = core.getInput('fail-on-error') !== 'false';
    const msg = err instanceof Error ? err.message : String(err);
    if (failOnError) {
      core.setFailed(`Scoring failed: ${msg}`);
      process.exit(1);
    }
    core.warning(`Scoring failed (fail-on-error=false): ${msg}`);
    // No engine output, so no check total to report: every count is 0.
    return {
      score: 0,
      grade: 'F',
      pass: 0,
      warn: 0,
      fail: 0,
      skip: 0,
      manual: 0,
      total: 0,
      error: engineErrorLine(err) || msg.split('\n')[0],
      checks: [],
    };
  }
}

/**
 * Build the markdown comment body from the score result.
 */
function buildComment(url: string, result: ScoreResult): string {
  const lines: string[] = [];
  const gradeEmoji: Record<string, string> = {
    A: '🟢',
    B: '🔵',
    C: '🟡',
    D: '🟠',
    F: '🔴',
  };
  const statusIcon: Record<string, string> = {
    PASS: '✅',
    FAIL: '❌',
    WARN: '⚠️',
    SKIP: '⚪',
    MANUAL: '❓',
  };

  lines.push(
    `## ${gradeEmoji[result.grade] || '⚪'} Designesy Score: ${result.score} (${result.grade})`,
  );
  lines.push('');
  lines.push(`**URL:** ${url}`);
  if (result.error) {
    lines.push('');
    lines.push(`> **Scoring engine error:** ${result.error}`);
  } else {
    lines.push(
      `**Checks:** ${result.pass} pass · ${result.warn} warn · ${result.fail} fail · ${result.skip} skip · ${result.manual} manual _(of ${result.total})_`,
    );
  }

  if (result.a11yFloorApplied) {
    lines.push('');
    lines.push(
      '> ⚡️ **a11y floor applied** — score capped at C due to accessibility failures',
    );
  }
  if (result.hardFailCeilingApplied && result.hardFailCeilingReason) {
    lines.push('');
    lines.push(`> 🚫 **hard-fail ceiling:** ${result.hardFailCeilingReason}`);
  }
  if (result.slop && result.slop.total > 0) {
    lines.push('');
    lines.push(
      `> 🎨 **anti-slop:** -${result.slop.total}pts (${result.slop.convergences || 'patterns detected'})`,
    );
  }
  if (result.originality && result.originality.points > 0) {
    lines.push('');
    lines.push(
      `> ✨ **originality:** +${result.originality.points}pts (${result.originality.summary || ''})`,
    );
  }

  // Show failing and warning checks
  const issues = (result.checks || []).filter(
    (c) => c.status === 'FAIL' || c.status === 'WARN',
  );
  if (issues.length > 0) {
    lines.push('');
    lines.push('### Findings');
    for (const c of issues) {
      lines.push(
        `- ${statusIcon[c.status] || '❓'} **${c.id}** — ${c.item} _[${c.category}]_`,
      );
      if (c.detail) lines.push(`  > ${c.detail}`);
      if (c.remediation) lines.push(`  > → ${c.remediation}`);
    }
  }

  lines.push('');
  lines.push('---');
  const engineFacts = [
    result.total > 0 ? `${result.total}-check` : '',
    'design-contract verification',
    result.contractVersion ? `· contract ${result.contractVersion}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  lines.push(
    `_Powered by [Designesy](https://www.designesy.org) · ${engineFacts}_`,
  );

  return lines.join('\n');
}

/**
 * Post or update a sticky PR comment using the GitHub API.
 * Uses a hidden comment-tag header to find and update the same comment.
 */
async function postComment(body: string): Promise<void> {
  const ctx = github.context;
  if (!ctx.payload.pull_request) {
    core.info('Not a pull request — skipping comment.');
    return;
  }

  const token = core.getInput('github-token') || process.env.GITHUB_TOKEN;
  if (!token) {
    core.warning('No GITHUB_TOKEN available — skipping comment.');
    return;
  }

  const prNumber = ctx.payload.pull_request.number;
  const repo = ctx.repo;
  const octokit = github.getOctokit(token);

  const COMMENT_TAG = '<!-- designesy-score-action -->';
  const commentBody = `${COMMENT_TAG}\n${body}`;

  try {
    const { data: comments } = await octokit.rest.issues.listComments({
      ...repo,
      issue_number: prNumber,
    });

    const existing = comments.find((c) => c.body?.includes(COMMENT_TAG));

    if (existing) {
      await octokit.rest.issues.updateComment({
        ...repo,
        comment_id: existing.id,
        body: commentBody,
      });
      core.info(`Updated comment #${existing.id}`);
    } else {
      const { data: newComment } = await octokit.rest.issues.createComment({
        ...repo,
        issue_number: prNumber,
        body: commentBody,
      });
      core.info(`Posted comment #${newComment.id}`);
    }
  } catch (err) {
    core.warning(
      `Failed to post comment: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const url = resolveUrl();
  const scope = core.getInput('scope') || 'universal';
  const format = core.getInput('format') || 'designesy';
  const minScore = parseFloat(core.getInput('min-score') || '0') || 0;
  const minGrade = (core.getInput('min-grade') || '')
    .toUpperCase()
    .charAt(0);

  const result = runScore(url, scope, format);

  // Set outputs for downstream steps
  core.setOutput('score', result.score.toString());
  core.setOutput('grade', result.grade);
  core.setOutput('pass', result.pass.toString());
  core.setOutput('warn', result.warn.toString());
  core.setOutput('fail', result.fail.toString());
  core.setOutput('skip', result.skip.toString());
  core.setOutput('manual', result.manual.toString());
  core.setOutput('total', result.total.toString());
  core.setOutput('contract-version', result.contractVersion ?? '');

  // Log summary
  core.info(
    `Score: ${result.score} (${result.grade}) — ${result.pass} pass, ${result.warn} warn, ${result.fail} fail, ${result.skip} skip, ${result.manual} manual of ${result.total} checks` +
      (result.contractVersion ? ` (contract ${result.contractVersion})` : ''),
  );

  // Post PR comment
  await postComment(buildComment(url, result));

  // Quality gate check
  if (minScore > 0 && result.score < minScore) {
    core.setFailed(
      `Quality gate failed: score ${result.score} is below the ${minScore} floor.`,
    );
    return;
  }
  if (minGrade && minGrade in GRADE_RANK) {
    if (GRADE_RANK[result.grade] < GRADE_RANK[minGrade]) {
      core.setFailed(
        `Quality gate failed: grade ${result.grade} is worse than the ${minGrade} minimum.`,
      );
      return;
    }
  }
}

main().catch((err) => {
  core.setFailed(
    `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
  );
});