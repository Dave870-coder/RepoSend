# RepoSend

RepoSend is a responsive, browser-based tool for publishing selected files or a folder as one commit to GitHub, GitLab.com, or a GitLab self-managed instance. Files go from your browser directly to the selected provider; RepoSend has no upload server and does not persist your token.

## Run locally

Requirements: Node.js 20.19+ or 22.12+.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. Run `npm test` for CLI tests. To create a production build, run `npm run build`; `npm run preview` serves that build locally.

## Host on GitHub Pages

The included Actions workflow builds and deploys the app when changes reach `main`. In the repository's **Settings → Pages**, choose **GitHub Actions** as the source. The Vite build uses relative asset URLs so it works both at a project URL (`owner.github.io/repository/`) and a user site/custom domain.

## Publish

1. Select **GitHub**, **GitLab.com**, or **GitLab self-managed**. For self-managed GitLab, enter the HTTPS instance origin. A GitHub fine-grained token must include the destination repository and grant **Contents: read and write** and **Metadata: read-only**; a classic token needs the `repo` scope. GitLab personal access tokens need the `api` scope.
2. Enter `owner/repository` for GitHub or `namespace/project` for GitLab (subgroups are supported), or paste a provider HTTPS/SSH clone URL. For GitLab self-managed, the pasted URL must belong to the configured instance. Use **Verify token and repository access** to confirm access. A token can only access repositories its owner is authorized for and, for fine-grained tokens, repositories selected when the token was created; organization policies still apply. The token is sent directly to the selected provider and remains in browser memory only.
3. Select files or a folder and enter a branch. A missing branch starts from the repository's default branch when it exists. Optionally create a missing private repository, or publish to a non-default branch and open a pull request/merge request. Creating a review request requires the provider's corresponding permissions.
4. Publish one job immediately or add up to five independent jobs to the in-tab queue. The queue runs sequentially to avoid overlapping writes from this page; completed jobs retain their result links until the page is closed. Check live file/byte status and the commit/review link for each job. Selected files are added or updated; other repository files are not deleted.

The optional **local recovery copy** is off by default and stores selected file contents in this browser's IndexedDB only after you opt in. If the page is interrupted, the selection is restored so you can re-enter credentials and retry. Tokens are never included in the recovery copy. Completed GitHub blob uploads and Git LFS objects can be reused; an interrupted individual file restarts from that file's beginning (GitLab commits are submitted as one atomic API operation). Clear the selection or uncheck recovery to remove the saved copy; successful publishes remove it automatically. Browser storage quotas and eviction policies still apply.

The token remains in browser memory and is cleared after a successful job, when switching providers, or when leaving the page; queued jobs hold their tokens in memory until processed or removed. RepoSend does not persist tokens. Regular Git API requests send them directly to the selected provider. GitHub LFS requests send them to the Worker URL you configure, which forwards them to GitHub. Use a Worker you control and review selected files for secrets before publishing.

## Scale and data handling

GitHub Pages serves only the static HTML, CSS, and JavaScript. Each browser sends its GitHub API requests directly to GitHub with that user's token; RepoSend has no shared upload API, queue, account database, or server-side file store. This avoids a central RepoSend upload bottleneck, but it does not guarantee 7,500 concurrent users or successful publishes: GitHub rate/abuse limits apply per account/token, and GitHub Pages, the user's network, and any configured LFS Worker have their own service and plan limits. Do not share one personal token among users.

No RepoSend-owned backend stores publish data. The optional recovery checkbox stores file copies only in that user's browser; leave it unchecked for no local recovery copy. GitHub stores files after a successful publish, and Cloudflare processes LFS traffic when the Worker is used.

The browser UI supports files over 70 MiB through GitHub LFS and the configured Worker, whose default per-file limit is 90 MiB. Above the Worker's advertised limit, use the local CLI with Git LFS. Browser LFS transfers are not byte-range resumable; if a file transfer is interrupted, that file starts again from the beginning.

## Publish from a local Git checkout

The optional CLI uses your installed Git client and configured credential helper, so it can push to GitHub, GitLab, Bitbucket, Azure DevOps, or another Git-compatible remote without putting a provider token in RepoSend:

```sh
node ./bin/reposend.mjs --remote origin --new-branch feature/update -- "src/file with spaces.ts"
```

Run it from an existing clone. It stages only the paths you specify, refuses to include changes that were already staged, creates a local commit, and pushes the selected branch. For an existing branch, omit `--new-branch`; `--branch` can assert that the current branch is the intended target. Authentication must already be configured with Git Credential Manager, SSH, or another Git credential helper. Never embed a token in the remote URL.

Large-file behavior follows the remote's Git LFS support and your local Git LFS configuration. Install Git LFS and track the relevant paths in `.gitattributes` before publishing those files. The CLI does not create remote repositories or pull requests.

## VS Code and MCP

The VS Code extension provides **RepoSend: Publish Selected Files**. Open `integrations/vscode` as an extension project and run it in an Extension Development Host (F5). Select files, choose a new branch and commit message, then confirm the publish. Configure `reposend.cliPath` to the absolute path of this checkout's `bin/reposend.mjs` when the extension cannot find it in the current workspace. The extension relies on the CLI and the local Git credential helper; it does not ask for provider tokens.

The MCP server exposes `reposend_status` and `reposend_publish` over stdio. The publish tool requires `confirmed: true`; configure it only for a trusted MCP client and an intended Git checkout:

```json
{
  "servers": {
    "reposend": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/RepoSend/integrations/mcp/server.mjs"],
      "cwd": "/absolute/path/to/your/git/checkout"
    }
  }
}
```

The MCP tool invokes the same CLI and uses Git's configured credentials. It does not accept or store access tokens.

## Security boundaries

RepoSend is a static web app, so its client code is public and can be inspected or modified. Obfuscation cannot protect secrets in a browser; the app contains no provider credentials or Worker signing secret. The page applies a restrictive Content Security Policy, does not write tokens to browser storage, and clears the token when publishing succeeds, when switching providers, or when the page is left. A browser, extension, or device that is already compromised can still read data entered into the page.

Use a least-privilege token and a Worker account you control. The Worker restricts browser origins and uses signed, short-lived LFS upload tickets, but CORS is not authentication—clients outside a browser can forge an `Origin` header. GitHub Pages does not let this project set response security headers; use a host that supports custom headers if you need additional controls such as `frame-ancestors`.

The Pages workflow pins GitHub Actions to immutable commit SHAs and gives deploy permissions only to the deploy job. Dependabot checks npm packages and GitHub Actions weekly.

## Enable Git LFS uploads

GitHub's LFS endpoint blocks browser CORS requests, so files over 70 MiB go through the included Cloudflare Worker. The Pages app remains static; the Worker streams LFS objects to GitHub and does not intentionally store or log tokens or file contents. Cloudflare still processes the traffic, so deploy the Worker in an account you control.

1. `wrangler.toml` allows this project's Pages origin (`https://dave870-coder.github.io`) and `http://localhost:5173` for local testing. If you host a fork or custom domain, change `ALLOWED_ORIGINS` to the exact browser origin (no repository path).
2. Set `PROXY_SIGNING_SECRET` as a Worker secret with `npx wrangler secret put PROXY_SIGNING_SECRET`. For local development, copy `.dev.vars.example` to `.dev.vars` and replace its placeholder with a random secret of at least 32 characters.
3. Run `npm run worker:dev` to test locally, or `npm run worker:deploy` to deploy. Enter the resulting Worker URL in the app's **Git LFS Worker URL** field.

The Worker defaults to 90 MiB per file, below Cloudflare's 100 MB Free/Pro request-body limit. Business and Enterprise accounts can raise `MAX_UPLOAD_BYTES` within their plan's request-size limit. GitHub LFS has separate plan-specific quotas and file-size limits; the Worker rejects Pages-enabled destination repositories because Git LFS is not supported by GitHub Pages.

## Current limits

- The browser app supports GitHub, GitLab.com, and GitLab self-managed instances. Bitbucket and Azure DevOps are not yet supported in the browser; the optional CLI uses native Git remotes and supports Git-compatible hosts.
- Missing repositories can be created as private repositories when the corresponding option is selected; branches are created when needed.
- Any file type can be selected; provider-specific repository limits still apply. Browser publishing through GitLab.com or self-managed GitLab is capped at 100 MiB total per commit and does not use Git LFS.
- GitHub: up to 5,000 files and 250 MiB total per publish. Regular Git API uploads are used through 70 MiB; larger files use Git LFS through the configured Worker.
- GitLab.com and self-managed GitLab: up to 5,000 files and 100 MiB total per publish. Use the CLI with Git LFS configured for larger files.
- Git LFS file size is limited by the Worker configuration, Cloudflare plan, and GitHub LFS quota. Install Git LFS in local clones to check out uploaded LFS objects.
- The folder picker depends on browser support; individual-file selection is available as a fallback.
