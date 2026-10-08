# Clip Tidy

**English** | [简体中文](README.zh-CN.md)

Organize clipped Markdown notes into existing folders with AI summaries, related-note links, review queues, and undo. Bring your own OpenAI-compatible model endpoint, including a local model.

Clip Tidy is an independent community plugin, not affiliated with Obsidian. This repository contains the **Obsidian organizer only**. It does not require a companion browser extension: save notes with Obsidian Web Clipper or any other tool, then organize them here.

**Desktop only · Obsidian 1.8.7+ · Chinese interface and AI summaries**

## What it does

- Detect existing destination folders, or edit the allowed list yourself.
- Organize on startup, when new notes arrive, or on demand.
- Preserve the original text and append a summary, tags, classification reason, and links to related notes.
- Automatically move high-confidence results; leave uncertain results for your confirmation.
- Browse separate **Organized / Pending / Needs review / Failed** history tabs, search notes, and open source or destination folders.
- Keep original-text backups and undo completed moves when the note has not changed.
- Resolve filename collisions using `Note (2).md`, `Note (3).md`, and so on.

## Installation

The plugin has been submitted to the community directory and is awaiting automated review. Until it is available for installation in Obsidian, use manual installation:

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/heiyuai/obsidian-clip-tidy/releases/latest).
2. Create `.obsidian/plugins/clip-tidy/` inside your vault and place those three files in it.
3. Reload Obsidian, open **Settings → Community plugins**, and enable **Clip Tidy**.

Do not copy another person's `data.json`: it contains their settings, API key, and note backups.

## Setup

The plugin currently has a Chinese interface. The steps below describe the controls in English; this document does not add an English interface to the plugin.

1. Create an inbox folder such as `Clippings` and at least one destination folder inside your vault.
2. Open **Settings → Clip Tidy** and set the first field, the inbox path, to your clipping folder. Replace the default Chinese folder name with your actual path.
3. Destination folders are detected automatically. Edit the list with one folder per line, or use the refresh button to return to automatic detection.
4. Enter your model endpoint, model name, and API key. OpenAI Chat Completions-compatible endpoints are supported, such as `https://api.openai.com/v1` or local `http://localhost:11434/v1`. Leave the key empty if your local service does not require authentication.
5. Use the connection-test button below the API key field. It sends only a short test message, never a note.
6. Read the data disclosure, enable AI organization, then use the organize-now button at the bottom. Optionally enable startup organization and watching for new clippings.

The organizer is **disabled by default**. You must configure it and explicitly enable AI organization before notes are sent to your selected service. The plugin is free; a cloud model provider may require an account and charge for API usage. A local compatible model can be used without a cloud account.

The automatic folder list excludes the inbox, its parents and descendants, hidden folders, and common attachment folders (such as `assets`, `attachments`, `images`, and their supported Chinese equivalents). Manual destinations must already exist and cannot overlap the inbox.

## Review and undo

Click the archive icon in the left ribbon to open the history view. Its four tabs, from left to right, are:

- **Organized**: inspect the original and destination folders, open the note, view its original-text backup, or undo organization.
- **Pending**: inspect inbox notes and organize them individually. Notes restored by undo stay paused until retried or changed.
- **Needs review**: expand the summary and classification reason, then confirm the suggested move. Interrupted writes that need attention also appear here.
- **Failed**: fix the connection or configuration, then request a new analysis.

Undo refuses to overwrite a note edited since organization or a newly occupied original path. If moving a note causes Obsidian to rewrite relative links, the operation may need manual review; use the original-text backup to recover safely. History backups supplement, but do not replace, your vault backup.

## Network and privacy

The only network requests made by this plugin are to the **model endpoint you configure**, using Obsidian's `requestUrl`. The default endpoint is `https://api.openai.com/v1`; no request is made until you test the connection or enable organization. HTTPS is required, except HTTP on `localhost`, `127.0.0.1`, or `[::1]`. Requests use `/chat/completions`.

Each organization request sends:

- The current note's path and full Markdown content (maximum 50,000 characters).
- The allowed destination folder names and your organization preferences.
- Up to six locally matched related-note paths, titles, tags, and excerpts of up to 1,200 characters each.

Candidate matching happens locally using titles, paths, and tags. The plugin does not upload the entire vault, download images, crawl websites, access files outside the vault, collect telemetry, or run an author-operated backend. Your chosen model provider receives the payload and handles it under its own terms and privacy policy. Network-connected providers may charge even if a request times out or you stop the task.

Settings, the **unencrypted API key**, classification results, and complete before/after note backups are stored in `.obsidian/plugins/clip-tidy/data.json`. Vault syncing or backups may include this file. Never publish it or attach it to an issue. Disable the plugin before removing this file; removal resets settings and loses undo history. History is retained locally without automatic pruning and can grow over time.

## Limits

- The current interface, summaries, and classification explanations are in Chinese.
- Desktop only; mobile use has not been validated.
- Only existing Markdown notes are organized. Browser likes/bookmarks, thread expansion, image downloads, and semantic duplicate detection are outside this plugin's scope.
- Classification confidence is the model's estimate, not a calibrated accuracy guarantee. Default threshold: 0.8.
- Up to 10 notes per run by default (configurable to 5, 10, or 20). Remaining notes wait for another run; new arrivals during a run can schedule a subsequent batch.
- Notes longer than 50,000 characters remain in the inbox. Requests time out after 60 seconds; stopping prevents pending responses from modifying notes, but cannot retract a request already sent.
- Failed or reviewed content is not automatically retried unchanged. Use the history action to retry.
- Related-note search uses keywords, not embeddings. Classification depends on your model and folder structure.

## Development

Requires Node.js 22+ and npm.

```sh
npm ci
npm test
npm run build
```

The build type-checks TypeScript and produces readable `main.js`. Obsidian provides the runtime `obsidian` dependency. Tests cover folder boundaries, model-response validation, safe summary formatting, history state grouping, file collisions, concurrent edits, interrupted writes, and undo. Automated tests do not guarantee model quality or compatibility with every theme and provider.

To release, update `manifest.json`, `package.json`, `versions.json`, and the build banner, then create a GitHub release whose tag exactly matches the manifest version (no `v` prefix). Attach `main.js`, `manifest.json`, and `styles.css` as individual files.

## Feedback and license

Report reproducible problems in [GitHub Issues](https://github.com/heiyuai/obsidian-clip-tidy/issues). Include your Obsidian version and reproduction steps; exclude private notes and credentials.

[MIT License](LICENSE). Copyright 2026 Heiyu. Obsidian is a trademark of its respective owner; this public release does not include modified Obsidian brand artwork.
