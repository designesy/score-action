# Designesy Score Action

Score your PR preview deployment against the **40-check Designesy design-contract engine** and post a sticky comment with the result.

[![Verify action](https://github.com/designesy/score-action/actions/workflows/test.yml/badge.svg)](https://github.com/designesy/score-action/actions/workflows/test.yml)

## How it works

1. Your CI builds a preview deployment (Vercel, Netlify, etc.) and produces a URL.
2. This action runs [`designesy-score`](https://www.npmjs.com/package/designesy-score) against that URL — 40 checks covering tokens, typography, motion, accessibility, color discipline, and anti-slop detection.
3. A sticky comment is posted (or updated) on the PR with the score, grade, and any failing checks.
4. Optional quality gates fail the build if the score drops below your threshold.

## Usage

### Basic — with a static URL

```yaml
name: Designesy Score
on:
  pull_request:
    types: [opened, synchronize, reopened]

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
| `format` | `designesy` | Output format: `designesy`, `canonical`, `review`, or `google`. |
| `fail-on-error` | `true` | Fail the step if the scoring engine itself errors (network failure, invalid URL). Set to `false` to pass even on errors. |
| `github-token` | `GITHUB_TOKEN` | GitHub token for posting PR comments. Defaults to the automatic token. |

## Outputs

| Output | Description |
|--------|-------------|
| `score` | Numeric score (0–100) |
| `grade` | Letter grade (A–F) |
| `pass` | Number of passing checks |
| `warn` | Number of warning checks |
| `fail` | Number of failing checks |
| `skip` | Number of skipped checks |
| `total` | Total checks run |

## The 40 checks

The engine evaluates design-contract compliance across 8 categories:

- **Tokens** (8) — design tokens present, structured, DTCG-compliant
- **Typography** (6) — fluid type, hierarchy, line-height discipline
- **Motion** (5) — duration tokens, easing, reduced-motion support
- **Accessibility** (5) — WCAG 2.2 contrast, focus states, alt text
- **Color** (5) — OKLCH usage, semantic families, dark-mode coherence
- **Composition** (4) — grid system, spacing scale, container queries
- **Anti-slop** (4) — AI-generated UI drift detection, lookalike test
- **Originality** (3) — convergence scoring, reference-tier distance

See the [full check documentation](https://www.designesy.org/score) on designesy.org.

## Quality gates

Combine `min-score` and `min-grade` to enforce a design quality floor:

```yaml
with:
  min-score: 70    # Fail if below 70
  min-grade: B     # AND fail if grade worse than B
```

Both gates are evaluated independently. If either fails, the step exits with code 1.

## Fork PR limitations

For pull requests from forks, `GITHUB_TOKEN` is read-only and cannot post comments. The action handles this gracefully — it logs a warning and still sets outputs and runs quality gates. To enable comments on fork PRs, use a Personal Access Token via a secret:

```yaml
with:
  github-token: ${{ secrets.DESIGNESY_COMMENT_TOKEN }}
```

## License

MIT © [Designesy](https://www.designesy.org)