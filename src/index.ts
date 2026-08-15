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
 *   fail-on-error — fail step if engine errors (default: true)
 *   github-token  — GitHub token for PR comments (default: GITHUB_TOKEN)
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import { execFileSync } from 'node:child_process';

const GRADE_RANK: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, F: 1 };

interface ScoreResult {
  score: number;
  grade: string;
  pass: number;
  warn: number;
  fail: number;
  skip: number;
  total: number;
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
 * Run the designesy-score engine via npx and parse the JSON output.
 */
function runScore(url: string, scope: string, format: string): ScoreResult {
  const npxArgs = [
    '--yes',
    'designesy-score@latest',
    url,
    '--scope',
    scope,
    '--format',
    format,
    '--json',
    '--quiet',
  ];

  core.info(`Scoring ${url} (scope=${scope}, format=${format})…`);

  try {
    const stdout = execFileSync('npx', npxArgs, {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const parsed = JSON.parse(stdout);

    // Canonical format nests score under summary
    if (format === 'canonical') {
      return {
        score: parsed.summary?.score ?? 0,
        grade: parsed.summary?.grade ?? 'F',
        pass: parsed.summary?.countsByStatus?.pass ?? 0,
        warn: parsed.summary?.countsByStatus?.warn ?? 0,
        fail: parsed.summary?.countsByStatus?.fail ?? 0,
        skip: parsed.summary?.countsByStatus?.skip ?? 0,
        total: parsed.summary?.total ?? 40,
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
      total: parsed.total ?? 40,
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
    return {
      score: 0,
      grade: 'F',
      pass: 0,
      warn: 0,
      fail: 0,
      skip: 40,
      total: 40,
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
  lines.push(
    `**Checks:** ${result.pass} pass · ${result.warn} warn · ${result.fail} fail · ${result.skip} skip _(of ${result.total})_`,
  );

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
  lines.push(
    '_Powered by [Designesy](https://www.designesy.org) · 40-check design-contract verification_',
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
  core.setOutput('total', result.total.toString());

  // Log summary
  core.info(
    `Score: ${result.score} (${result.grade}) — ${result.pass} pass, ${result.warn} warn, ${result.fail} fail`,
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