# Designesy Score Action

Score your PR preview deployment against the **44-check Designesy design-contract engine** and post a sticky comment with the result.

[![Verify action](https://github.com/designesy/score-action/actions/workflows/test.yml/badge.svg)](https://github.com/designesy/score-action/actions/workflows/test.yml)

## How it works

1. Your CI builds a preview deployment (Vercel, Netlify, etc.) and produces a URL.
2. This action runs [`@designesy/score`](https://www.npmjs.com/package/@designesy/score) against that URL — 44 checks across 14 categories, from tokens, typography cadence, and motion to accessibility, semantics, and copywriting, plus anti-slop deductions and originality lifts.
3. A sticky comment is posted (or updated) on the PR with the score, grade, and any failing checks.
4. Optional quality gates fail the build if the score drops below your threshold.

## Usage

### Basic — with a static URL

```yaml
name: Designesy Score
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  pull-requests: write   # lets the workflow token post the score comment

jobs:
  score:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Score preview deployment
        uses: designesy/score-action@v1
        with:
          url: https://my-app.vercel.app
          min-grade: B
```

### Vercel preview deployments

```yaml
name: Designesy Score
on:
  deployment_status:

jobs:
  score:
    runs-on: ubuntu-latest
    if: github.event.deployment_status.state == 'success'
    steps:
      - name: Score Vercel preview
        uses: designesy/score-action@v1
        with:
          url: ${{ github.event.deployment_status.target_url }}
          min-grade: B
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Netlify deploy previews

```yaml
name: Designesy Score
on:
  deployment_status:

jobs:
  score:
    runs-on: ubuntu-latest
    if: github.event.deployment_status.state == 'success'
    steps:
      - name: Score Netlify preview
        uses: designesy/score-action@v1
        with:
          url: ${{ github.event.deployment_status.target_url }}
          min-score: 70
```

### Runtime URL via command

Use `url-command` when the preview URL is only available at runtime (e.g. from a preceding build step's output):

```yaml
steps:
  - name: Build preview
    id: build
    run: |
      echo "https://preview-$RANDOM.vercel.app" > preview-url.txt
  - name: Score preview
    uses: designesy/score-action@v1
    with:
      url-command: cat preview-url.txt
      min-grade: C
```

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `url` | `''` | The URL to score. Either this or `url-command` is required. |
| `url-command` | `''` | Shell command whose stdout is the URL to score. |
| `scope` | `universal` | Scoring scope: `contract` (strict, for Designesy-owned sites) or `universal` (fair, for any site). |
| `min-score` | `0` | Fail the step if score is below this number (0–100). `0` = disabled. |
| `min-grade` | `''` | Fail the step if grade is worse than this letter (A/B/C/D/F). Empty = disabled. |
| `format` | `designesy` | Engine output format: `designesy`, `canonical`, `review`, or `google`. Only `designesy` and `canonical` carry per-check counts; for the other formats the action reads the `designesy` result for its outputs and comment. |
| `fail-on-error` | `true` | Fail the step if the scoring engine itself errors (network failure, invalid URL). Set to `false` to pass even on errors. |
| `github-token` | `${{ github.token }}` | GitHub token for posting PR comments. Defaults to the workflow's automatic token, which needs `permissions: pull-requests: write`. A failed comment post is logged as a warning and never fails the step. |
| `engine-version` | `latest` | Version of `@designesy/score` to run: `latest` or an exact version such as `0.7.2`. Pin to keep a CI gate stable across engine releases. Any other value fails the step before anything runs. See [Pinning the engine](#pinning-the-engine). |

## Outputs

| Output | Description |
|--------|-------------|
| `score` | Numeric score (0–100) |
| `grade` | Letter grade (A–F) |
| `pass` | Number of passing checks |
| `warn` | Number of warning checks |
| `fail` | Number of failing checks |
| `skip` | Number of skipped checks |
| `manual` | Number of checks that need a manual or browser-trace review |
| `total` | Total checks the engine ran, as the engine reports it |
| `contract-version` | Design-contract version the engine scored against, as the engine reports it |
| `engine-version` | Version of `@designesy/score` that ran. With `engine-version: latest` this is the exact version the registry resolved (`latest` only if that lookup failed) |

`pass + warn + fail + skip + manual = total`. By default the action runs the latest published engine, so `total` and `contract-version` follow the engine rather than a number fixed in this action.

## The 44 checks

The engine evaluates design-contract compliance across 14 categories (counts as of `@designesy/score` 0.7.1):

| Category | Checks |
|----------|--------|
| Tokens | 2 |
| Responsive | 1 |
| Interaction | 1 |
| Poise | 3 |
| Motion | 5 |
| Accessibility | 7 |
| Identity | 2 |
| Takt | 2 |
| Cadence (typography) | 12 |
| Performance | 1 |
| Semantic | 2 |
| Security | 1 |
| Copywriting | 4 |
| Spec | 1 |

On top of the weighted checks, the score carries anti-slop deductions and originality lifts, and an accessibility floor and hard-fail ceiling can cap the grade.

See the [full check documentation](https://www.designesy.org/score) on designesy.org.

## Quality gates

Combine `min-score` and `min-grade` to enforce a design quality floor:

```yaml
with:
  min-score: 70    # Fail if below 70
  min-grade: B     # AND fail if grade worse than B
```

Both gates are evaluated independently. If either fails, the step exits with code 1.

## Pinning the engine

By default the action runs the latest published `@designesy/score`, so a new engine release can change a score without any change on your side. To keep a gate stable, pin an exact engine version (requires `designesy/score-action` v1.2.0 or later; `@v1` includes it):

```yaml
- name: Score preview deployment
  uses: designesy/score-action@v1
  with:
    url: https://my-app.vercel.app
    min-grade: A
    engine-version: 0.7.2
```

Package 0.8.0 (engine 1.3.0) caps the score at 89.9, a B, while any check FAILs, so a `min-grade: A` or `min-score: 90` gate that passes on 0.7.2 can fail on 0.8.0 until those checks are fixed. The `engine-version` output and the comment footer name the version that ran. Remove the pin, or set it to `latest`, to follow new releases again.

## Fork PR limitations

For pull requests from forks, the workflow token is read-only and cannot post comments. The action handles this gracefully: it logs a warning with the reason and still sets outputs and runs quality gates, so the step's result depends only on `min-score`, `min-grade`, and `fail-on-error`. To enable comments on fork PRs, use a Personal Access Token via a secret:

```yaml
with:
  github-token: ${{ secrets.DESIGNESY_COMMENT_TOKEN }}
```

## License

MIT © [Designesy](https://www.designesy.org)