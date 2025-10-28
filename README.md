# atom-fe-pr-reviewer

Utility script to list the open pull requests for a GitHub repository.

## Prerequisites

- Node.js 18+ (Node 20 is available in this environment).
- GitHub CLI (`gh`) installed locally with an authenticated session (`gh auth status`).
- [Ollama](https://ollama.com/) CLI installed and running with the desired model available locally. Set `OLLAMA_MODEL` (for example `OLLAMA_MODEL=llama3`) to choose the model; the script defaults to `deepseek-coder-v2:lite`.

## Usage

```bash
# Default repository: atom-insurance/atom-webclient-react-apps
node review.mjs

# Specify a different repository
node review.mjs some-org/some-repo

# Or rely on an environment variable
GITHUB_REPO=some-org/some-repo node review.mjs
```

The script prints each pull request number, title, source branch, author, and last update timestamp. Afterward it offers an interactive prompt to select a pull request, streams the `gh pr diff` output directly in the terminal, invokes the local Ollama model to produce structured review suggestions, and (after a final confirmation prompt) can submit those inline comments back to GitHub via the CLI.

## Troubleshooting

- `gh: authentication failed`: Run `gh auth login` (or `gh auth status`) to configure the CLI for your account.
- `Repository not found`: Check the owner/name spelling and your access rights.
