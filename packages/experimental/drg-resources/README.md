---
description: "Archive national DRG publications as immutable versioned files and share verified source metadata with private user runtimes."
kind: "package-library"
---

# @deepseek-ai/dsh-experimental-drg-resources

English | [中文](README.zh.md)

## Summary

Retain national DRG source PDFs with explicit editions, revisions, and SHA-256 digests. Publish each revision once, verify its original bytes and SQLite metadata, and select or withdraw a reference default without replacing older archives. Private user runtimes can read the same published collection through a read-only Docker mount. These source-only archives contain no extracted grouping rules, dictionaries, engine, or patient data; every manifest records `groupingReady: false`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Operator publication

Use the repository's offline resource utility from a checkout with dependencies installed. The utility creates and validates files; it launches no DSH application or model request. Show its exact command and option list with:

```sh
pnpm exec tsx scripts/drg-resources.ts --help
```

Initialize an empty collection in an operator-selected persistent local directory, then inspect it. This disposable example uses an isolated temporary directory:

```sh
drg_resource_root=$(mktemp -d)
pnpm exec tsx scripts/drg-resources.ts initialize --root "$drg_resource_root"
pnpm exec tsx scripts/drg-resources.ts list --root "$drg_resource_root"
```

`publish` requires a new `--id`, `--edition`, `--revision`, local `--source-file`, exact `--source-url`, and independently verified `--sha256`. Success prints a source-only manifest; it does not select a default. `default --id` selects a reference revision, `withdraw --id` clears its default if necessary, and `restore --id` restores availability without selecting it. `verify` checks the complete collection; `verify --id` checks one registered revision against its catalog digest. Published IDs cannot be overwritten, including after withdrawal.

### Shared reads and permissions

The operator owns `<root>/staging` and the mutable publication catalog. Mount only `<root>/published` into each private runtime, with Docker read-only access. Keep staging, publishing credentials, private homes, and the Docker socket outside that mount. Initial directory modes are `0700` for root/staging, `0755` for published, `0555` for completed pack directories, `0444` for immutable files, and `0644` for the replaceable catalog; Docker read-only enforcement remains required.

Readers import [the library entry](src/index.ts), call `readPublishedCollection(publishedRoot)` or `validatePack(publishedRoot, packId)`, and receive bounded metadata. SQLite connections use `readOnly: true`; readers accept no arbitrary SQL or resource paths. `DrgResourceStore.read()` resolves the reference default when no ID is supplied and rejects missing or withdrawn revisions. This package does not bind a resource to a Session or expose a model tool.

### Failures and recovery

One exclusive `.writer-lock` covers each publication or catalog update. Another writer receives `busy` immediately. A process crash can retain the lock; only an operator who has established that no writer remains may remove a stale lock. Failed candidates and status receipts stay in staging for inspection. Unknown files, symlinks, hard-linked artifacts, malformed metadata, changed digests, and SQLite WAL/SHM dependencies fail validation.

A complete directory can survive a failed catalog update. That state reports `publication-incomplete`; `recover --id` verifies an unregistered complete directory and registers it without making it the default. Inspect the catalog first because an error after catalog commit can also report incomplete receipt/durability work. Collection-wide validation can reject while a publication is between directory and catalog commit; retry only after the writer completes and its outcome is inspected. Default rollback selects an older available revision; withdrawal retains every pack byte. Back up all retained packs and catalog metadata outside the server, and validate the restored collection before use.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Staging and published directories share one filesystem. The publisher validates operator input and expected PDF bytes, creates a standalone DELETE-journal SQLite database containing only source/version metadata, closes its writer, and validates the complete candidate. It flushes the files and directories, renames the candidate into a uniquely named published directory, and atomically replaces the catalog. Publication grants reference availability only; strict schemas reject executable grouping readiness.

| File | Role |
|---|---|
| [store.ts](src/store.ts) | Exclusive operator publication, catalog selection, withdrawal, and orphan recovery |
| [reader.ts](src/reader.ts) | Read-only integrity admission for registered packs and collections |
| [database.ts](src/database.ts) | Standalone source/version metadata and read-only SQLite verification |
| [format.ts](src/format.ts) | Strict persisted formats and structured operator failures |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DRG requirements](../../../docs/requirements/drg-review-assistant-v1.md) — private review workflow and complete-engine acceptance.
- [DRG implementation proposal](../../../docs/requirements/drg-review-assistant-v1-implementation.md#resources) — resource ownership and version lifecycle.
- [Hosted workspaces](../hosted-workspaces/README.md) — private Docker runtimes and company login.

-----

<a id="model-experience"></a>
## Model Experience

None, as this library registers no model-visible tools or prompts and changes no Session content.

#### KV Cache effect

No direct effect; reading files through an existing user tool follows that tool's logging and output limits.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Reliable local filesystem rename and directory `fsync` semantics are required; network filesystems, object-store mounts, and Windows publication are not supported deployment targets.
- The trusted operator exclusively controls the root and its parent directories. File hashes detect changed bytes; they do not establish source authenticity or replace controlled publication and backups.
- Source-only archives cannot group a case or establish clinical validity. Extracted rules, compatible dictionaries, professional review, engine acceptance, and Session version binding require separate implementation.
- There is no automatic stale-lock deletion, pack deletion, remote download, MinIO distribution, or server deployment.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
