# TabNeed — GitHub JSON shared storage

This version stores agents and deposits in `data/tabneed.json` in your **private GitHub repository**. The Netlify serverless function reads and updates that file through the GitHub Contents API. The GitHub token is used only by the server function and is never sent to the browser. The board polls the API about every 3 seconds, so a computer and TV using the same deployed site should see shared changes shortly after they are saved.

## Important limitations

- Keep the GitHub repository **private**. The JSON file contains your agents and deposit records.
- The public board endpoint returns the board data to any visitor who can access the website. This is necessary for a TV to show the board without an admin login. Do not store personal identity, banking, or other sensitive information in this file.
- Every edit creates a Git commit. GitHub is a source-control service, not a database; this is suitable for a small desk board, but not for high-frequency or high-concurrency writes. The function retries some simultaneous-write conflicts, but no file-based approach can guarantee database-level transactions.
- Do not put the GitHub token in `public/index.html`, any `VITE_*` variable, or any other browser-visible code.

## Deploy to Netlify

1. Create a **private** GitHub repository and upload the contents of this project to the repository root. The root should contain `netlify.toml`, `package.json`, `netlify/`, `public/`, and `data/`.
2. In GitHub, create a **fine-grained personal access token** at Settings → Developer settings → Personal access tokens → Fine-grained tokens. Restrict it to this one repository and grant **Contents: Read and write**. Metadata read access is normally included automatically. Do not grant unrelated permissions.
3. In Netlify, import the repository and deploy it. `netlify.toml` publishes `public/` and discovers functions in `netlify/functions/`.
4. In Netlify site configuration, add these environment variables. Set them for the deployed runtime (and redeploy after changing them):

   | Variable | Value |
   | --- | --- |
   | `GITHUB_TOKEN` | The fine-grained token from step 2 |
   | `GITHUB_OWNER` | Your GitHub account or organization name |
   | `GITHUB_REPO` | The private repository name, without the owner prefix |
   | `GITHUB_BRANCH` | The repository's default branch, commonly `main` |
   | `GITHUB_DATA_PATH` | `data/tabneed.json` |
   | `ADMIN_USERNAME` | `admin` |
   | `ADMIN_PASSWORD` | `admin2025` (change this to a strong password for production) |
   | `ADMIN_SESSION_SECRET` | A long, unique random secret (at least 32 random characters) |

5. Redeploy the site. Open the deployed URL on both the computer and TV. Log in to Admin on the computer, add a test agent, and check the TV. Changes should appear within about 3 seconds.

## Verify configuration

- If the board says it is reconnecting, check Netlify → Functions → logs. Common causes are a wrong repository owner/name/branch, an expired token, or missing `Contents: Read and write` permission.
- The first successful write updates `data/tabneed.json` and creates a commit. Check the private repository's commit history to confirm writes are being saved.
- `ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET` are server-side environment variables. They are not credentials for GitHub; `GITHUB_TOKEN` is a separate token used only to update the file.

## Local development

Install dependencies with `npm install`, then run with Netlify CLI (`npx netlify dev`) after setting the same environment variables in a local `.env` file. Never commit `.env` or a real token. Netlify Functions are required; opening `public/index.html` directly as a `file://` URL will not work with the GitHub-backed API.
